// Captures a MediaStream, downsamples to 16 kHz mono linear16 and hands chunks to `onPcm`.
export interface Capture {
  stop: () => void
}

export async function capture(stream: MediaStream, onPcm: (b: ArrayBuffer) => void, onLevel?: (peak: number) => void): Promise<Capture> {
  const ctx = new AudioContext({ sampleRate: 16000 })
  await ctx.audioWorklet.addModule('./pcm-worklet.js')
  const node = new AudioWorkletNode(ctx, 'pcm')
  node.port.onmessage = (e) => {
    onPcm(e.data)
    if (onLevel) {
      const s = new Int16Array(e.data)
      let peak = 0
      for (let i = 0; i < s.length; i++) peak = Math.max(peak, Math.abs(s[i]))
      onLevel(peak / 32768)
    }
  }
  ctx.createMediaStreamSource(stream).connect(node)
  return {
    stop: () => {
      stream.getTracks().forEach((t) => t.stop())
      void ctx.close()
    }
  }
}

// `id` is "" (default), a raw deviceId, or "label:<device name>" (stable across runs).
export async function micStream(id: string): Promise<MediaStream> {
  let deviceId = id
  if (id.startsWith('label:')) {
    const want = id.slice(6)
    const list = await navigator.mediaDevices.enumerateDevices()
    deviceId = list.find((d) => d.kind === 'audioinput' && d.label === want)?.deviceId ?? ''
  }
  return navigator.mediaDevices.getUserMedia({
    audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: true, noiseSuppression: true }
  })
}

export async function systemStream(): Promise<MediaStream> {
  const s = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
  s.getVideoTracks().forEach((t) => t.stop())
  return new MediaStream(s.getAudioTracks())
}
