class Pcm extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0][0]
    if (ch) {
      const out = new Int16Array(ch.length)
      for (let i = 0; i < ch.length; i++) out[i] = Math.max(-1, Math.min(1, ch[i])) * 0x7fff
      this.port.postMessage(out.buffer, [out.buffer])
    }
    return true
  }
}
registerProcessor('pcm', Pcm)
