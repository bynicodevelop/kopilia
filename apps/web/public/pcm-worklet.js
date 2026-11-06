// AudioWorklet : sous-échantillonne l'audio du micro vers 16 kHz mono et le
// convertit en PCM 16 bits little-endian (format attendu par whisper.cpp).
// Le downsampling est une décimation simple ; suffisant pour la parole.
class PcmDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.ratio = sampleRate / this.targetRate; // `sampleRate` = fréquence du contexte
    this.acc = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    const picked = [];
    for (let i = 0; i < channel.length; i++) {
      this.acc += 1;
      if (this.acc >= this.ratio) {
        this.acc -= this.ratio;
        picked.push(channel[i]);
      }
    }
    if (picked.length) {
      const pcm = new Int16Array(picked.length);
      for (let i = 0; i < picked.length; i++) {
        let s = Math.max(-1, Math.min(1, picked[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}
registerProcessor("pcm-downsampler", PcmDownsampler);
