import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, screen, session, Tray } from 'electron'
import { execFile, spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { extname, join } from 'path'

// Neutral display name: shown as the window title (Task Manager "Processes" tab,
// window pickers, Alt+Tab) instead of the real product name.
const APP_TITLE = 'Fox AI'
const APP_TOOLTIP = 'Fox AI'

import { getKey, getSettings, keyStatus, saveSettings, setKey, type KeyId, type Settings } from './config'
import { isQuestion } from './detect'
import { streamAnswer, streamTask, systemPrompt, VISION_MODEL } from './llm'
import { deleteSession, getSession, listSessions, saveSession, summarize, toAnki, toMarkdown } from './session'
import { DeepgramStream, type Channel } from './stt'
import { startShareWatch } from './sharewatch'

// The userData folder is named after productName (package.json), and productName has
// moved twice ("parakeet-ai" → "Notes Viewer" → "Fox AI"). Pull existing data across
// atomically and drop the old folders so nothing stale is left in %APPDATA%. A rename
// cannot half-succeed, and an old folder is only removed once the data is verifiably
// in place under the new name. Newest first: if two old folders exist, the most recent
// one must win the rename so the newest keys/settings are the ones kept.
{
  const appData = app.getPath('appData')
  const newDir = join(appData, app.getName())
  const hasData = (): boolean => existsSync(join(newDir, 'settings.json')) || existsSync(join(newDir, 'keys.json'))
  for (const name of ['Notes Viewer', 'parakeet-ai']) {
    const oldDir = join(appData, name)
    if (!existsSync(oldDir)) continue
    try {
      if (existsSync(newDir)) {
        // Both exist: only drop the duplicate once the new folder verifiably holds data.
        if (hasData()) rmSync(oldDir, { recursive: true, force: true })
        continue
      }
      renameSync(oldDir, newDir)
    } catch {
      // never destroy data: worst case the old folder simply stays put
    }
  }
}

let win: BrowserWindow | null = null
const streams: Partial<Record<Channel, DeepgramStream>> = {}
const transcript: { channel: Channel; text: string; ts: number }[] = []
let answered = 0 // index into transcript: everything before this has been answered
let answerAbort: AbortController | null = null
let answerSeq = 0
let sessionId = String(Date.now())
let mockMode = false // mock interview tab open: never auto-answer
const mockAsked: string[] = []
let stopShareWatch: (() => void) | null = null
let autoHidden = false // we hid the window because a share was detected
let tray: Tray | null = null
let quitting = false

// One instance only. With no taskbar button and no Start-menu entry, re-launching
// the exe is the natural way back in, so a second launch shows this window instead
// of starting a duplicate.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      win.show()
      win.focus()
    }
  })
}

// Hide the window from Alt+Tab and the task switcher by forcing WS_EX_TOOLWINDOW
// (0x80) and clearing WS_EX_APPWINDOW (0x40000) on its HWND. setSkipTaskbar() covers
// the taskbar; this covers Alt+Tab. Runs once per window, asynchronously so it never
// blocks startup. The script goes through -EncodedCommand because passing it via
// -Command mangles the quotes inside the C# literals.
function hideFromSwitchers(w: BrowserWindow): void {
  const hwnd = w.getNativeWindowHandle().readBigInt64LE().toString()
  const script =
    "Add-Type -Name W -Namespace X -MemberDefinition '[DllImport(\"user32.dll\")] public static extern IntPtr GetWindowLongPtr(IntPtr h,int i);[DllImport(\"user32.dll\")] public static extern IntPtr SetWindowLongPtr(IntPtr h,int i,IntPtr v);'; " +
    `$h=[IntPtr]${hwnd}; ` +
    '$ex=[X.W]::GetWindowLongPtr($h,-20).ToInt64(); ' +
    '$ex=($ex -bor 0x80) -band (-bnot 0x40000); ' +
    '[X.W]::SetWindowLongPtr($h,-20,[IntPtr]$ex) | Out-Null'
  const b64 = Buffer.from(script, 'utf16le').toString('base64')
  execFile(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64],
    { windowsHide: true, timeout: 25000 },
    (err, _out, stderr) => {
      if (err) console.warn('[switcher-hide] failed:', String(stderr).slice(0, 300))
    }
  )
}

// Windows/macOS exclude the window from capture via setContentProtection. Linux has
// no such API (X11 grabs the whole screen; the Wayland portal has no per-window
// flag), so there we detect an active share through PipeWire's screen-cast node
// (plus X11 recorder processes) and hide the window only while it lasts.
function syncShareWatch(): void {
  stopShareWatch?.()
  stopShareWatch = null
  if (process.platform !== 'linux' || !getSettings().contentProtect) return
  stopShareWatch = startShareWatch((sharing) => {
    if (!win) return
    if (sharing && win.isVisible()) {
      autoHidden = true
      win.hide()
      console.log('[sharewatch] screen share detected: hiding window')
      if (Notification.isSupported())
        new Notification({
          title: 'Screen share detected',
          body: 'Window hidden from the share. Press Ctrl+Shift+H to show it anyway.'
        }).show()
    } else if (!sharing && autoHidden) {
      autoHidden = false
      if (!win.isVisible()) win.show()
      console.log('[sharewatch] screen share ended: showing window')
    }
  })
}

function endSession(): void {
  saveSession(sessionId, transcript)
  transcript.length = 0
  answered = 0
  sessionId = String(Date.now())
}

const send = (event: string, payload?: unknown): void => win?.webContents.send(event, payload)

function createWindow(): void {
  const s = getSettings()
  win = new BrowserWindow({
    width: 480,
    height: 760,
    minWidth: 360,
    minHeight: 480,
    title: APP_TITLE,
    alwaysOnTop: s.alwaysOnTop,
    opacity: s.opacity,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  // No taskbar button, and Alt+Tab / the task switcher never lists the window.
  win.setSkipTaskbar(true)
  const w = win
  setImmediate(() => hideFromSwitchers(w))
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))
  // Keep the window visible to us but out of Zoom/Meet/Teams captures (Windows/macOS).
  // On Linux this is a no-op; syncShareWatch() below auto-hides on a detected share instead.
  win.setContentProtection(s.contentProtect)
  syncShareWatch()
  // Closing the window hides it to the tray instead of quitting, so transcription
  // keeps running. Quitting is only possible from the tray menu (or the OS).
  win.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    win?.hide()
  })
  win.on('closed', () => (win = null))
}

function recentTranscript(): string {
  return transcript
    .filter((t) => t.ts > Date.now() - 3 * 60_000)
    .map((t) => `${t.channel === 'me' ? 'ME' : 'OTHER'}: ${t.text}`)
    .join('\n')
}

// Streams one LLM job to the renderer's answer panel; returns the full text.
async function task(
  label: string,
  run: (signal: AbortSignal, onDelta: (t: string) => void) => Promise<void>
): Promise<string> {
  answerAbort?.abort()
  const ctl = (answerAbort = new AbortController())
  const id = ++answerSeq
  let full = ''
  send('answer:start', { id, question: label })
  try {
    await run(ctl.signal, (text) => {
      full += text
      send('answer:delta', { id, text })
    })
  } catch (e) {
    if (!ctl.signal.aborted) send('answer:error', { id, message: (e as Error).message })
  }
  if (id === answerSeq) send('answer:done', { id })
  return full
}

async function answer(question: string): Promise<void> {
  answered = transcript.length
  await task(question, (sig, d) => streamAnswer(getSettings(), recentTranscript(), question, sig, d))
}

async function screenshot(): Promise<void> {
  const s = getSettings()
  const { width, height } = screen.getPrimaryDisplay().size
  const wasVisible = win?.isVisible()
  win?.hide() // keep our own window out of the screenshot
  await new Promise((r) => setTimeout(r, 250))
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } })
  if (wasVisible) win?.show()
  const png = sources[0]?.thumbnail.toPNG()
  if (!png) return send('answer:error', { id: 0, message: 'Could not capture the screen.' })
  await task('📷 Screenshot', (sig, d) =>
    streamTask(
      s,
      systemPrompt(s) + '\nThe user shares a screenshot of a problem (coding task, question, diagram). First give a short HINT, then a line "---", then the full solution with explanation (and code if relevant).',
      [{ role: 'user', content: [{ type: 'text', text: 'Help me with what is on my screen.' }, { type: 'image', image: png }] }],
      sig,
      d,
      VISION_MODEL[s.provider]
    )
  )
}

function mockSystem(): string {
  const s = getSettings()
  return [
    'You are a professional interviewer running a mock interview. Ask exactly ONE question per turn, no preamble, no answer, no numbering.',
    s.jobDescription.trim() && `Role / topic:\n${s.jobDescription.trim()}`,
    s.resume.trim() && `Candidate background:\n${s.resume.trim()}`,
    mockAsked.length && `Already asked (do not repeat):\n- ${mockAsked.join('\n- ')}`
  ].filter(Boolean).join('\n\n')
}

// "Answer now": use everything said by OTHER since the last answer (fall back to the last line).
function askNow(): void {
  const fromOther = streams.other ? 'other' : 'me'
  const pending = transcript.slice(answered).filter((t) => t.channel === fromOther)
  const q = pending.length ? pending.map((t) => t.text).join(' ') : transcript.at(-1)?.text
  if (q) void answer(q)
  else send('answer:error', { id: 0, message: 'Nothing transcribed yet.' })
}

let pwRecord: ChildProcess | null = null

// Linux has no Electron loopback, so capture the default speaker output's monitor with
// PipeWire's pw-record and feed raw 16 kHz mono PCM straight to the "other" stream.
function startNativeSystemAudio(): boolean {
  if (process.platform !== 'linux' || spawnSync('pw-record', ['--version']).status !== 0) return false
  pwRecord?.kill()
  pwRecord = spawn('pw-record', ['-P', '{ stream.capture.sink=true }', '--rate', '16000', '--channels', '1', '--format', 's16', '-'])
  pwRecord.stdout?.on('data', (b: Buffer) => streams.other?.send(b))
  pwRecord.on('error', (e) => send('status', { error: `System audio capture failed: ${e.message}` }))
  return true
}

function startStream(channel: Channel): 'native' | undefined {
  const key = getKey('deepgram')
  if (!key) return void send('status', { error: 'No Deepgram key saved. Add it in Settings.' })
  streams[channel]?.close()
  streams[channel] = new DeepgramStream(key, getSettings().language, {
    onInterim: (text) => send('transcript:interim', { channel, text }),
    onUtterance: (text) => {
      transcript.push({ channel, text, ts: Date.now() })
      send('transcript:final', { channel, text })
      if (!mockMode && (channel === 'other' || !streams.other) && getSettings().autoAnswer && isQuestion(text)) void answer(text)
    },
    onError: (message) => send('status', { error: message })
  })
  if (channel === 'other' && getSettings().otherSource === 'system' && startNativeSystemAudio()) return 'native'
}

function stopAll(): void {
  pwRecord?.kill()
  pwRecord = null
  for (const c of ['me', 'other'] as Channel[]) {
    streams[c]?.close()
    delete streams[c]
  }
  saveSession(sessionId, transcript)
}

async function readResume(): Promise<string | null> {
  const r = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Resume', extensions: ['pdf', 'txt', 'md'] }]
  })
  if (r.canceled || !r.filePaths[0]) return null
  const path = r.filePaths[0]
  if (extname(path).toLowerCase() === '.pdf') {
    const pdf = (await import('pdf-parse')).default
    return (await pdf(readFileSync(path))).text.trim()
  }
  return readFileSync(path, 'utf8').trim()
}

function registerIpc(): void {
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:save', (_e, patch: Partial<Settings>) => {
    const next = saveSettings(patch)
    win?.setAlwaysOnTop(next.alwaysOnTop)
    win?.setOpacity(next.opacity)
    win?.setContentProtection(next.contentProtect)
    syncShareWatch()
    return next
  })
  ipcMain.handle('keys:status', () => keyStatus())
  ipcMain.handle('keys:set', (_e, id: KeyId, key: string) => {
    setKey(id, key.trim())
    return keyStatus()
  })
  ipcMain.handle('resume:pick', () => readResume())
  ipcMain.handle('stream:start', (_e, channel: Channel) => startStream(channel))
  ipcMain.handle('stream:stop', () => stopAll())
  ipcMain.on('audio', (_e, channel: Channel, pcm: ArrayBuffer) => streams[channel]?.send(Buffer.from(pcm)))
  ipcMain.handle('answer:ask', () => askNow())
  ipcMain.handle('answer:question', (_e, q: string) => answer(q))
  ipcMain.handle('session:clear', () => {
    answerAbort?.abort()
    endSession()
  })
  ipcMain.handle('screenshot', screenshot)
  ipcMain.handle('window:compact', (_e, on: boolean) => {
    win?.setMinimumSize(on ? 300 : 360, on ? 200 : 480)
    win?.setSize(on ? 440 : 480, on ? 340 : 760)
  })
  ipcMain.handle('mock:mode', (_e, on: boolean) => {
    mockMode = on
    if (on) mockAsked.length = 0
  })
  ipcMain.handle('mock:next', async () => {
    const q = await task('🎤 Interviewer', (sig, d) =>
      streamTask(getSettings(), mockSystem(), [{ role: 'user', content: 'Ask me the next interview question.' }], sig, d)
    )
    if (q.trim()) mockAsked.push(q.trim())
  })
  ipcMain.handle('mock:score', async (_e, question: string, reply: string) => {
    await task('📝 Feedback', (sig, d) =>
      streamTask(
        getSettings(),
        'You are an interview coach. Given the question and the candidate\'s spoken answer, reply in markdown: **Score: X/10**, then "What worked", "What to improve", and "A stronger answer" (a model answer in first person, spoken style). Be honest and specific.',
        [{ role: 'user', content: `Question: ${question}\n\nCandidate answer: ${reply || '(no answer given)'}` }],
        sig,
        d
      )
    )
  })
  ipcMain.handle('models:list', async () => {
    const st = getSettings()
    const key = getKey(st.provider)
    const base: Record<string, string> = {
      groq: 'https://api.groq.com/openai/v1',
      openai: 'https://api.openai.com/v1',
      openrouter: 'https://openrouter.ai/api/v1',
      ollama: st.ollamaUrl
    }
    let url = `${base[st.provider]}/models`
    let headers: Record<string, string> = { Authorization: `Bearer ${key}` }
    if (st.provider === 'anthropic') {
      url = 'https://api.anthropic.com/v1/models?limit=100'
      headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    } else if (st.provider === 'google') {
      url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${key}`
      headers = {}
    }
    const r = await fetch(url, { headers })
    if (!r.ok) throw new Error(`${st.provider} said HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
    const j = await r.json()
    const ids: string[] = (j.data ?? j.models ?? []).map((m: { id?: string; name?: string }) => (m.id ?? m.name ?? '').replace('models/', ''))
    return ids.filter(Boolean).sort()
  })
  ipcMain.handle('history:list', () => listSessions())
  ipcMain.handle('history:get', (_e, id: string) => getSession(id))
  ipcMain.handle('history:delete', (_e, id: string) => deleteSession(id))
  ipcMain.handle('history:summarize', (_e, id: string) => summarize(id))
  ipcMain.handle('history:export', async (_e, id: string, kind: 'md' | 'anki') => {
    const sess = getSession(id)
    if (!sess) return false
    const r = await dialog.showSaveDialog({ defaultPath: kind === 'md' ? `session-${id}.md` : `flashcards-${id}.txt` })
    if (r.canceled || !r.filePath) return false
    writeFileSync(r.filePath, kind === 'md' ? toMarkdown(sess) : toAnki(sess))
    return true
  })
}

function createTray(): void {
  const icon = nativeImage.createFromBuffer(readFileSync(join(app.getAppPath(), 'build', 'tray.png')))
  tray = new Tray(icon)
  tray.setToolTip(APP_TOOLTIP)
  // Single click does nothing on purpose: a stray click must never reveal the
  // window mid-call. Double-click (or the menu) brings it back.
  tray.on('double-click', () => {
    win?.show()
    win?.focus()
  })
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show window', click: () => { win?.show(); win?.focus() } },
      { label: 'Hide window', click: () => win?.hide() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ])
  )
}

app.whenReady().then(() => {
  // System-audio capture: the renderer calls getDisplayMedia({audio:true}); we grant
  // the primary screen with loopback audio (video track is dropped by the renderer).
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_req, callback) => {
      const sources = await desktopCapturer.getSources({ types: ['screen'] })
      callback({ video: sources[0], audio: 'loopback' })
    },
    { useSystemPicker: false }
  )
  registerIpc()
  createWindow()
  createTray()
  globalShortcut.register('CommandOrControl+Shift+A', askNow)
  globalShortcut.register('CommandOrControl+Shift+C', () => {
    answerAbort?.abort()
    endSession()
    send('session:cleared')
  })
  globalShortcut.register('CommandOrControl+Shift+S', () => void screenshot())
  globalShortcut.register('CommandOrControl+Shift+H', () =>
    win?.isVisible() ? win.hide() : win?.show()
  )
  // Live toggle for capture exclusion. VNC and RDP are screen-capture based, so a
  // protected window is invisible in them too — this brings it back into your own
  // remote view without leaving it exposed during the actual share.
  globalShortcut.register('CommandOrControl+Shift+P', () => {
    const next = !getSettings().contentProtect
    saveSettings({ contentProtect: next })
    win?.setContentProtection(next)
    syncShareWatch()
    console.log('[protect] capture exclusion now', next ? 'ON' : 'OFF')
  })
})

// Only set when the user picked Quit (tray menu / OS): the 'close' handler above
// turns every other close into a hide-to-tray.
app.on('before-quit', () => {
  quitting = true
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  stopAll()
})
app.on('window-all-closed', () => app.quit())
