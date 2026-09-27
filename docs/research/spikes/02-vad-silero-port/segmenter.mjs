export class Segmenter { // shared post-processing: hysteresis handled by caller (active/inactive), hangover, min speech, max len
  constructor(frameMs, o = {}) { this.fm = frameMs; this.o = Object.assign({ hangoverMs: 500, minSpeechMs: 150, maxMs: 10000, minVoicedMs: 0 }, o);
    this.speaking = false; this.segs = []; this.misfires = 0; }
  push(t, active, inactive, voiced = true) { const o = this.o;
    if (!this.speaking) { if (active) { this.speaking = true; this.start = t; this.sp = 1; this.vo = voiced ? 1 : 0; this.sil = 0; this.confirm = null; if (this.sp*this.fm >= o.minSpeechMs && this.vo*this.fm >= o.minVoicedMs) this.confirm = t; } return; }
    if (active) { this.sp++; if (voiced) this.vo++; this.sil = 0; if (this.confirm === null && this.sp*this.fm >= o.minSpeechMs && this.vo*this.fm >= o.minVoicedMs) this.confirm = t; }
    else if (inactive) this.sil++;
    const end = this.sil*this.fm >= o.hangoverMs || (t - this.start) >= o.maxMs;
    if (end) { this.speaking = false; if (this.confirm !== null) this.segs.push({ start: this.start, confirm: this.confirm, end: t + this.fm, forced: this.sil*this.fm < o.hangoverMs }); else this.misfires++; }
  }
  finish(t) { if (this.speaking && this.confirm !== null) this.segs.push({ start: this.start, confirm: this.confirm, end: t, open: true }); }
}
