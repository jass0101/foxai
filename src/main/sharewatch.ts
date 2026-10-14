import { execFile } from 'child_process'

const POLL_MS = 2000

// Screen-cast nodes on PipeWire: Mutter's "meta-screen-cast-src", KWin's and
// OBS's portal nodes. Webcam/audio nodes never match this.
const SCREEN_CAST = /screen[-_ ]?cast/i
// Recorders that only exist while they are recording (X11 has no PipeWire signal,
// so this is the fallback for x11grab-style capture). Anchored to the executed
// command so a shell merely *containing* these words (a grep, an editor) can't
// match. Apps that merely run while a meeting is open (Zoom, OBS, Teams) are
// deliberately NOT matched — hiding the window for a meeting nobody is sharing
// would defeat the feature.
const RECORDERS =
  /^(?:\S*\/)?(?:wf-recorder|byzanz-record)\b|^(?:\S*\/)?ffmpeg\b[^\n]*\bx11grab\b/m

interface PwObject {
  id?: number
  type?: string
  info?: { props?: Record<string, unknown> }
}

// Our own getDisplayMedia/system-audio fallback goes through the portal on Wayland
// and creates a screencast node too — without this filter the app would hide itself
// for the whole meeting. selfPids covers us plus our child processes (GPU/renderer).
function screenCastInPw(pwDump: string, selfPids: number[]): boolean {
  let doc: unknown
  try {
    doc = JSON.parse(pwDump)
  } catch {
    return SCREEN_CAST.test(pwDump)
  }
  if (!Array.isArray(doc)) return SCREEN_CAST.test(pwDump)
  const objects = doc as PwObject[]
  const selfClients = new Set<number>()
  for (const o of objects) {
    if (o.type !== 'PipeWire:Interface:Client' || typeof o.id !== 'number') continue
    const props = o.info?.props
    const pid = Number(props?.['application.process.id'] ?? props?.['pipewire.pid'])
    if (selfPids.includes(pid)) selfClients.add(o.id)
  }
  for (const o of objects) {
    if (o.type !== 'PipeWire:Interface:Node') continue
    if (selfClients.has(Number(o.info?.props?.['client.id']))) continue
    if (SCREEN_CAST.test(JSON.stringify(o.info?.props ?? {}))) return true
  }
  return false
}

// Pure so it can be tested without a PipeWire session. psOut may be raw ps
// output (pid ppid args…) or bare command lines — strip the pid columns either way.
export function shareActive(pwDump: string, psOut: string, selfPids: number[] = []): boolean {
  return screenCastInPw(pwDump, selfPids) || RECORDERS.test(psOut.replace(/^\s*\d+\s+\d+\s+/gm, ''))
}

// ps output line: "<pid> <ppid> <full command …>"
function parsePs(psOut: string): { selfPids: number[]; args: string } {
  const selfPids = [process.pid]
  const args: string[] = []
  for (const line of psOut.split('\n')) {
    const m = line.match(/^(\d+)\s+(\d+)\s+([\s\S]*)$/)
    if (!m) continue
    if (Number(m[2]) === process.pid) selfPids.push(Number(m[1]))
    args.push(m[3])
  }
  return { selfPids, args: args.join('\n') }
}

const run = (cmd: string, args: string[], cb: (err: Error | null, out: string) => void): void => {
  execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024 }, (err, out) => cb(err as Error | null, out))
}

// Polls for an active screen share. Calls onChange(false) once at start if idle,
// then only on transitions. Returns a stop function.
export function startShareWatch(onChange: (sharing: boolean) => void): () => void {
  let stopped = false
  let busy = false
  let pwMissing = false // only after ENOENT: pw-dump not installed
  let last: boolean | null = null

  const check = (): void => {
    if (stopped || busy) return
    busy = true
    let pending = 2
    let psOut: string | null = null
    let pwOut: string | null = null
    let pwErr: NodeJS.ErrnoException | null = null
    const finish = (): void => {
      if (--pending > 0) return
      busy = false
      if (stopped) return
      if (pwErr?.code === 'ENOENT') pwMissing = true
      const { selfPids, args } = psOut !== null ? parsePs(psOut) : { selfPids: [process.pid], args: '' }
      const active = RECORDERS.test(args) || (pwOut !== null && screenCastInPw(pwOut, selfPids))
      if (active === last) return
      last = active
      onChange(active)
    }
    run('ps', ['-ww', '-eo', 'pid,ppid,args'], (err, out) => {
      if (!err) psOut = out
      finish()
    })
    if (pwMissing) {
      pending--
      finish()
      return
    }
    run('pw-dump', [], (err, out) => {
      if (err) pwErr = err as NodeJS.ErrnoException
      else pwOut = out
      finish()
    })
  }

  check()
  const timer = setInterval(check, POLL_MS)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
