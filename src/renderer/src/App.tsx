import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import { capture, micStream, systemStream, type Capture } from './audio'

type Channel = 'me' | 'other'
interface Line { channel: Channel; text: string }
interface Settings {
  provider: string
  models: Record<string, string>
  ollamaUrl: string
  language: string
  autoAnswer: boolean
  alwaysOnTop: boolean
  contentProtect: boolean
  opacity: number
  micDeviceId: string
  otherSource: string
  resume: string
  jobDescription: string
  instructions: string
}

const PROVIDERS = ['groq', 'openai', 'anthropic', 'google', 'openrouter', 'ollama']

export function App(): React.JSX.Element {
  const [tab, setTab] = useState<'live' | 'mock' | 'history' | 'settings'>('live')
  const [compact, setCompact] = useState(false)
  const [micLevel, setMicLevel] = useState(0)
  const [micName, setMicName] = useState('')
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [mockQ, setMockQ] = useState('')
  const [mockMark, setMockMark] = useState<number | null>(null)
  const [models, setModels] = useState<string[]>([])
  const speakOnDone = useRef(false)
  const answerRef = useRef('')
  const linesRef = useRef<Line[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [keys, setKeys] = useState<Record<string, boolean>>({})
  const [lines, setLines] = useState<Line[]>([])
  const [interim, setInterim] = useState<Partial<Record<Channel, string>>>({})
  const [question, setQuestion] = useState('')
  const [answerText, setAnswerText] = useState('')
  const [busy, setBusy] = useState(false)
  const [listening, setListening] = useState(false)
  const [error, setError] = useState('')
  const captures = useRef<Capture[]>([])
  const answerId = useRef(0)

  useEffect(() => {
    void window.api.getSettings().then(setSettings)
    void window.api.keyStatus().then(setKeys)
    const off = [
      window.api.on('transcript:interim', ({ channel, text }) => setInterim((i) => ({ ...i, [channel]: text }))),
      window.api.on('transcript:final', ({ channel, text }) => {
        setInterim((i) => ({ ...i, [channel]: '' }))
        setLines((l) => (linesRef.current = [...l, { channel, text }]))
      }),
      window.api.on('answer:start', ({ id, question }) => {
        answerId.current = id
        setQuestion(question)
        answerRef.current = ''
        setAnswerText('')
        setError('')
        setBusy(true)
      }),
      window.api.on('answer:delta', ({ id, text }) => {
        if (id !== answerId.current) return
        answerRef.current += text
        setAnswerText((a) => a + text)
      }),
      window.api.on('answer:done', ({ id }) => {
        if (id !== answerId.current) return
        setBusy(false)
        if (speakOnDone.current) {
          speakOnDone.current = false
          setMockQ(answerRef.current)
          speechSynthesis.cancel()
          speechSynthesis.speak(new SpeechSynthesisUtterance(answerRef.current))
        }
      }),
      window.api.on('answer:error', ({ message }) => {
        setError(message)
        setBusy(false)
      }),
      window.api.on('status', ({ error }) => error && setError(error)),
      window.api.on('session:cleared', () => reset())
    ]
    return () => off.forEach((f) => f())
  }, [])

  function reset(): void {
    linesRef.current = []
    setMockMark(null)
    setLines([])
    setInterim({})
    setQuestion('')
    setAnswerText('')
    setError('')
    setBusy(false)
  }

  async function start(): Promise<void> {
    if (!settings) return
    setError('')
    try {
      if (settings.micDeviceId !== 'off') {
        await window.api.startStream('me')
        const ms = await micStream(settings.micDeviceId)
        setMicName(ms.getAudioTracks()[0]?.label ?? '')
        captures.current.push(await capture(ms, (b) => window.api.sendAudio('me', b), (l) => setMicLevel((p) => Math.max(l, p * 0.8))))
      }
      if (settings.otherSource !== 'off') {
        try {
          const mode = await window.api.startStream('other')
          if (mode !== 'native') {
            const stream = settings.otherSource === 'system' ? await systemStream() : await micStream(settings.otherSource)
            captures.current.push(await capture(stream, (b) => window.api.sendAudio('other', b)))
          } else captures.current.push({ stop: () => undefined })
        } catch (e) {
          setError(`System audio unavailable (${(e as Error).message}). Continuing with microphone only.`)
        }
      }
      if (!captures.current.length) throw new Error('no audio source could be started')
      setListening(true)
    } catch (e) {
      const m = (e as Error).message
      setError(`Could not start audio: ${m}${/not found|denied|NotAllowed|NotFound/i.test(m) ? ' — pick a different microphone in Settings, and check it is not muted in your system sound settings.' : ''}`)
      await stop()
    }
  }

  async function stop(): Promise<void> {
    captures.current.forEach((c) => c.stop())
    captures.current = []
    await window.api.stopStreams()
    setListening(false)
    setMicLevel(0)
  }

  useEffect(() => {
    void window.api.mockMode(tab === 'mock')
  }, [tab])

  useEffect(() => {
    if (tab !== 'settings') return
    void (async () => {
      try {
        ;(await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop())
      } catch { /* labels stay hidden without permission */ }
      setDevices((await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput'))
    })()
  }, [tab])

  function toggleCompact(): void {
    void window.api.compact(!compact)
    setCompact(!compact)
  }

  function nextQuestion(): void {
    speakOnDone.current = true
    setMockMark(null)
    void window.api.mockNext()
  }

  function evaluate(): void {
    const mine = linesRef.current.slice(mockMark ?? 0).filter((l) => l.channel === 'me').map((l) => l.text)
    if (interim.me) mine.push(interim.me)
    void window.api.mockScore(mockQ, mine.join(' '))
    setMockMark(null)
  }

  async function patch(p: Partial<Settings>): Promise<void> {
    setSettings(await window.api.saveSettings(p))
  }

  if (!settings) return <div className="p">Loading…</div>

  const panel = (
    <section className="answer">
      {question && <div className="q">{question.startsWith('Q:') ? question : `Q: ${question}`}</div>}
      {answerText ? <Markdown>{answerText}</Markdown> : <span className="muted">{busy ? 'Thinking…' : 'Answers appear here.'}</span>}
    </section>
  )

  return (
    <div className="app">
      <header>
        <b>Fox AI</b>
        <nav>
          <button className={tab === 'live' ? 'on' : ''} onClick={() => setTab('live')}>Live</button>
          <button className={tab === 'mock' ? 'on' : ''} onClick={() => setTab('mock')}>Mock</button>
          <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>History</button>
          <button className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}>Settings</button>
          <button title="Compact overlay" onClick={toggleCompact}>{compact ? '⤢' : '⤡'}</button>
        </nav>
      </header>
      {error && <div className="error">{error}</div>}
      {tab === 'live' ? (
        <main className={compact ? 'compact' : ''}>
          <div className="row">
            <button className={listening ? 'danger' : 'primary'} onClick={() => (listening ? stop() : start())}>
              {listening ? 'Stop' : 'Start listening'}
            </button>
            <button onClick={() => window.api.ask()}>Answer now (Ctrl+Shift+A)</button>
            <button onClick={() => window.api.screenshot()}>📷 Screenshot (Ctrl+Shift+S)</button>
            <button onClick={() => { void window.api.clear(); reset() }}>Clear</button>
          </div>
          {listening && settings.micDeviceId !== 'off' && (
            <div className="meter" title={micName}>
              <span>🎤 {micName || 'microphone'}</span>
              <div><i style={{ width: `${Math.min(100, micLevel * 300)}%` }} /></div>
              <span className="muted" style={{ visibility: micLevel < 0.005 ? 'visible' : 'hidden' }}>no sound detected — speak, or check the mic in Settings</span>
            </div>
          )}
          {panel}
          <section className="transcript">
            {lines.map((l, i) => (
              <div key={i} className={l.channel}><em>{l.channel === 'me' ? 'You' : 'Other'}</em> {l.text}</div>
            ))}
            {(['me', 'other'] as Channel[]).map((c) => interim[c] && <div key={c} className={`${c} muted`}><em>{c === 'me' ? 'You' : 'Other'}</em> {interim[c]}</div>)}
          </section>
        </main>
      ) : tab === 'mock' ? (
        <main>
          <div className="muted">Start listening first. Click <b>Next question</b>, hear the interviewer, press <b>I'm answering</b>, speak, then <b>Evaluate</b>.</div>
          <div className="row">
            <button className="primary" onClick={nextQuestion}>Next question</button>
            <button disabled={!mockQ} onClick={() => speechSynthesis.speak(new SpeechSynthesisUtterance(mockQ))}>🔊 Repeat</button>
            <button disabled={!mockQ} onClick={() => setMockMark(linesRef.current.length)}>{mockMark === null ? "I'm answering" : '● recording…'}</button>
            <button disabled={!mockQ} onClick={evaluate}>Evaluate</button>
          </div>
          {!listening && <div className="muted">⚠ Not listening — answers can't be captured.</div>}
          {panel}
        </main>
      ) : tab === 'history' ? (
        <History />
      ) : (
        <main className="settings">
          <label>Provider
            <select value={settings.provider} onChange={(e) => patch({ provider: e.target.value })}>
              {PROVIDERS.map((p) => <option key={p}>{p}</option>)}
            </select>
          </label>
          <label>Model ({settings.provider})
            <div className="row">
              <input list="models" value={settings.models[settings.provider]} onChange={(e) => patch({ models: { ...settings.models, [settings.provider]: e.target.value } })} />
              <button onClick={async () => { try { setError(''); setModels(await window.api.listModels()) } catch (e) { setError((e as Error).message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '')) } }}>Fetch models</button>
            </div>
            <datalist id="models">{models.map((m) => <option key={m} value={m} />)}</datalist>
            {models.length > 0 && <span className="ok">{models.length} models available — pick one from the box.</span>}
          </label>
          {settings.provider === 'ollama' && (
            <label>Ollama URL<input value={settings.ollamaUrl} onChange={(e) => patch({ ollamaUrl: e.target.value })} /></label>
          )}
          <KeyField id={settings.provider} label={`${settings.provider} API key`} saved={keys[settings.provider]} onSaved={setKeys} hide={settings.provider === 'ollama'} />
          <KeyField id="deepgram" label="Deepgram API key (speech-to-text)" saved={keys.deepgram} onSaved={setKeys} />
          <label>Language (Deepgram code, or "multi")
            <input value={settings.language} onChange={(e) => patch({ language: e.target.value })} />
          </label>
          <label className="check"><input type="checkbox" checked={settings.autoAnswer} onChange={(e) => patch({ autoAnswer: e.target.checked })} /> Auto-answer detected questions</label>
          <label className="check"><input type="checkbox" checked={settings.alwaysOnTop} onChange={(e) => patch({ alwaysOnTop: e.target.checked })} /> Always on top</label>
          <label className="check"><input type="checkbox" checked={settings.contentProtect} onChange={(e) => patch({ contentProtect: e.target.checked })} /> Hidden from screen share (Win/mac: excluded from capture; Linux: auto-hides while sharing)</label>
          <label>Microphone (You)
            <select value={settings.micDeviceId} onChange={(e) => patch({ micDeviceId: e.target.value })}>
              <option value="">Default microphone</option>
              <option value="off">Off</option>
              {devices.map((d) => <option key={d.deviceId} value={d.label ? `label:${d.label}` : d.deviceId}>{d.label || d.deviceId.slice(0, 8)}</option>)}
            </select>
          </label>
          <label>Other speaker source
            <select value={settings.otherSource} onChange={(e) => patch({ otherSource: e.target.value })}>
              <option value="system">System audio (loopback)</option>
              <option value="off">Off</option>
              {devices.map((d) => <option key={d.deviceId} value={d.label ? `label:${d.label}` : d.deviceId}>{d.label || d.deviceId.slice(0, 8)}</option>)}
            </select>
            <span className="muted">Linux: if system audio captures nothing, pick the “Monitor of …” device here.</span>
          </label>
          <label>Window opacity ({Math.round(settings.opacity * 100)}%)
            <input type="range" min="0.3" max="1" step="0.05" value={settings.opacity} onChange={(e) => patch({ opacity: Number(e.target.value) })} />
          </label>
          <label>Resume / background
            <textarea rows={5} value={settings.resume} onChange={(e) => patch({ resume: e.target.value })} />
            <button onClick={async () => { const t = await window.api.pickResume(); if (t) patch({ resume: t }) }}>Load PDF / text…</button>
          </label>
          <label>Role / topic notes
            <textarea rows={4} value={settings.jobDescription} onChange={(e) => patch({ jobDescription: e.target.value })} />
          </label>
          <label>Extra instructions
            <textarea rows={3} value={settings.instructions} onChange={(e) => patch({ instructions: e.target.value })} />
          </label>
        </main>
      )}
    </div>
  )
}

function KeyField(p: { id: string; label: string; saved?: boolean; hide?: boolean; onSaved: (k: Record<string, boolean>) => void }): React.JSX.Element | null {
  const [v, setV] = useState('')
  if (p.hide) return null
  return (
    <label>{p.label} {p.saved && <span className="ok">✓ saved</span>}
      <div className="row">
        <input type="password" placeholder={p.saved ? '••••••••' : 'paste key'} value={v} onChange={(e) => setV(e.target.value)} />
        <button onClick={async () => { p.onSaved(await window.api.setKey(p.id, v)); setV('') }}>{v ? 'Save' : p.saved ? 'Remove' : 'Save'}</button>
      </div>
    </label>
  )
}

interface SessionRow { id: string; started: number; count: number; preview: string; summarized: boolean }
interface SessionFull {
  id: string
  started: number
  lines: Line[]
  summary?: string
  keyPoints?: string[]
  flashcards?: { q: string; a: string }[]
}

function History(): React.JSX.Element {
  const [rows, setRows] = useState<SessionRow[]>([])
  const [open, setOpen] = useState<SessionFull | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const refresh = (): void => void window.api.historyList().then(setRows)
  useEffect(refresh, [])

  async function summarize(): Promise<void> {
    if (!open) return
    setBusy(true)
    setErr('')
    try {
      setOpen(await window.api.historySummarize(open.id))
      refresh()
    } catch (e) {
      setErr((e as Error).message)
    }
    setBusy(false)
  }

  if (open)
    return (
      <main>
        <div className="row">
          <button onClick={() => setOpen(null)}>← Back</button>
          <button className="primary" disabled={busy} onClick={summarize}>{busy ? 'Summarizing…' : open.summary ? 'Re-summarize' : 'Summarize + flashcards'}</button>
          <button onClick={() => window.api.historyExport(open.id, 'md')}>Export .md</button>
          <button disabled={!open.flashcards?.length} onClick={() => window.api.historyExport(open.id, 'anki')}>Export Anki</button>
          <button className="danger" onClick={async () => { await window.api.historyDelete(open.id); setOpen(null); refresh() }}>Delete</button>
        </div>
        {err && <div className="error">{err}</div>}
        {open.summary && (
          <section className="answer">
            <b>Summary</b>
            <p>{open.summary}</p>
            <b>Key points</b>
            <ul>{open.keyPoints?.map((k, i) => <li key={i}>{k}</li>)}</ul>
            <b>Flashcards</b>
            {open.flashcards?.map((c, i) => <p key={i}><b>Q:</b> {c.q}<br /><b>A:</b> {c.a}</p>)}
          </section>
        )}
        <section className="transcript">
          {open.lines.map((l, i) => <div key={i} className={l.channel}><em>{l.channel === 'me' ? 'You' : 'Other'}</em> {l.text}</div>)}
        </section>
      </main>
    )

  return (
    <main>
      {!rows.length && <span className="muted">No saved sessions yet. A session is saved when you press Stop or Clear.</span>}
      {rows.map((r) => (
        <button key={r.id} className="session" onClick={async () => setOpen(await window.api.historyGet(r.id))}>
          <b>{new Date(r.started).toLocaleString()}</b> · {r.count} lines {r.summarized && '✓'}
          <br /><span className="muted">{r.preview}</span>
        </button>
      ))}
    </main>
  )
}
