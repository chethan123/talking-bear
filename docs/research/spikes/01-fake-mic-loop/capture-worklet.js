// Collects 128-frame quanta into fixed chunks and transfers them to the main thread.
class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; this.calls = 0; }
  process(inputs) {
    this.calls++;
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) {
          this.port.postMessage({ chunk: this.buf, calls: this.calls }, [this.buf.buffer]);
          this.buf = new Float32Array(2048); this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('capture', Capture);
