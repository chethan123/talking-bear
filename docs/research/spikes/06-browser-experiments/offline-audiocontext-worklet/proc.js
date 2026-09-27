class Probe extends AudioWorkletProcessor {
  constructor() { super(); this.q = 0; this.port.onmessage = e => { this.port.postMessage({t:'cmdSeen', q:this.q, data:e.data}); }; }
  process(inputs, outputs) {
    const inp = inputs[0][0];
    let rms = 0; if (inp) { for (let i=0;i<inp.length;i++) rms += inp[i]*inp[i]; rms = Math.sqrt(rms/inp.length); }
    if (this.q % 100 === 0) {
      const buf = inp ? new Float32Array(inp) : new Float32Array(128);
      this.port.postMessage({t:'q', q:this.q, frame: currentFrame, time: currentTime, sr: sampleRate, rms, buf}, [buf.buffer]);
    }
    this.q++;
    return true;
  }
}
registerProcessor('probe', Probe);
