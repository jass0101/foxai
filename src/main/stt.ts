import WebSocket from 'ws'

export type Channel = 'me' | 'other'

interface Handlers {
  onInterim: (text: string) => void
  onUtterance: (text: string) => void
  onError: (msg: string) => void
}

// One Deepgram streaming connection per audio channel. Audio arrives as
// 16 kHz mono linear16 PCM chunks from the renderer.
export class DeepgramStream {
  private ws: WebSocket
  private finals: string[] = []
  private keepAlive: NodeJS.Timeout
  private closed = false

  constructor(apiKey: string, language: string, private h: Handlers) {
    const params = new URLSearchParams({
      model: 'nova-3',
      language,
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      interim_results: 'true',
      smart_format: 'true',
      punctuate: 'true',
      endpointing: '300',
      utterance_end_ms: '1000',
      vad_events: 'true'
    })
    this.ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
      headers: { Authorization: `Token ${apiKey}` }
    })
    this.ws.on('message', (data) => this.onMessage(JSON.parse(data.toString())))
    this.ws.on('error', (e) => !this.closed && h.onError(`Deepgram: ${e.message}`))
    this.ws.on('unexpected-response', (_req, res) =>
      !this.closed && h.onError(`Deepgram rejected the connection (HTTP ${res.statusCode}). Check your key.`)
    )
    this.keepAlive = setInterval(() => this.sendJson({ type: 'KeepAlive' }), 8000)
  }

  send(pcm: Buffer): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(pcm)
  }

  close(): void {
    this.closed = true
    clearInterval(this.keepAlive)
    if (this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.once('open', () => this.ws.close())
      return
    }
    this.sendJson({ type: 'CloseStream' })
    setTimeout(() => this.ws.terminate(), 500)
  }

  private sendJson(msg: object): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  private flush(): void {
    const text = this.finals.join(' ').trim()
    this.finals = []
    if (text) this.h.onUtterance(text)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private onMessage(msg: any): void {
    if (msg.type === 'UtteranceEnd') return this.flush()
    if (msg.type !== 'Results') return
    const text: string = msg.channel?.alternatives?.[0]?.transcript ?? ''
    if (msg.is_final) {
      if (text) this.finals.push(text)
      if (msg.speech_final) this.flush()
      else this.h.onInterim(this.finals.join(' '))
    } else if (text) {
      this.h.onInterim([...this.finals, text].join(' '))
    }
  }
}
