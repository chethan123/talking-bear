const out = document.getElementById('out');
const R = (window.__result = { log: [] });
const log = (...a) => { R.log.push(a.join(' ')); out.textContent += a.join(' ') + '\n'; };

function dbfs(x, a, b) { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return 10 * Math.log10(s / (b - a) + 1e-12); }
function f0(x, sr) {
  const n = 4096, mid = Math.floor(x.length / 2) - n / 2; let best = 0, lag = 0;
  for (let L = Math.floor(sr / 1000); L < sr / 60; L++) {
    let s = 0; for (let i = 0; i < n; i++) s += x[mid + i] * x[mid + i + L];
    if (s > best) { best = s; lag = L; }
  }
  return sr / lag;
}

document.getElementById('start').addEventListener('click', async () => {
  const ctx = new AudioContext();
  R.ctx = { sampleRate: ctx.sampleRate, state: ctx.state, baseLatency: ctx.baseLatency, outputLatency: ctx.outputLatency };
  try { await ctx.audioWorklet.addModule('/capture-worklet.js'); R.sameOriginWorklet = 'ok'; } catch (e) { R.sameOriginWorklet = String(e); }
  try {
    const blob = new Blob(["registerProcessor('b', class extends AudioWorkletProcessor { process(){return true} })"], { type: 'text/javascript' });
    await ctx.audioWorklet.addModule(URL.createObjectURL(blob)); R.blobWorklet = 'ok';
  } catch (e) { R.blobWorklet = String(e); }
  try { await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])); R.wasm = 'ok'; } catch (e) { R.wasm = String(e); }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  const track = stream.getAudioTracks()[0];
  R.track = { label: track.label, settings: track.getSettings() };
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'capture', { numberOfInputs: 1, numberOfOutputs: 0 });
  src.connect(node);
  const sr = ctx.sampleRate, F = Math.round(sr / 100); // 10 ms frames
  const t0 = performance.now();
  let pending = new Float32Array(0), frames = [], floor = -60, inSpeech = false, above = 0, below = 0;
  let clip = null, startFrame = -1, gated = false;
  const PRE = 30, ON = 3, HANG = 40;
  node.port.onmessage = ({ data }) => {
    if (gated) return;
    const merged = new Float32Array(pending.length + data.chunk.length); merged.set(pending); merged.set(data.chunk, pending.length);
    let i = 0;
    for (; i + F <= merged.length; i += F) {
      const fr = merged.slice(i, i + F); frames.push(fr);
      const d = dbfs(fr, 0, F);
      if (!inSpeech) {
        if (d > -100) floor = d < floor ? 0.8 * floor + 0.2 * d : 0.995 * floor + 0.005 * d;
        above = d > Math.max(floor + 15, -50) ? above + 1 : 0;
        if (above >= ON) { inSpeech = true; startFrame = Math.max(0, frames.length - ON - PRE); log('onset at', ((frames.length - ON) * 10) + 'ms stream time,', 'floor', floor.toFixed(1)); }
      } else {
        below = d < Math.max(floor + 9, -56) ? below + 1 : 0;
        if (below >= HANG) {
          gated = true; inSpeech = false;
          const fs = frames.slice(startFrame, frames.length - HANG + 10);
          clip = new Float32Array(fs.length * F); fs.forEach((f, k) => clip.set(f, k * F));
          log('end at', frames.length * 10 + 'ms; clip', (clip.length / sr).toFixed(3) + 's');
          play(clip);
          return;
        }
      }
    }
    pending = merged.slice(i);
  };
  async function play(clip) {
    const rate = 1.6;
    const buf = ctx.createBuffer(1, clip.length, sr); buf.copyToChannel(clip, 0);
    const s = ctx.createBufferSource(); s.buffer = buf; s.playbackRate.value = rate;
    await ctx.audioWorklet.addModule('/capture-worklet.js');
    const tap = new AudioWorkletNode(ctx, 'capture', { numberOfInputs: 1, numberOfOutputs: 0 });
    const tapped = [];
    tap.port.onmessage = ({ data }) => tapped.push(data.chunk);
    s.connect(ctx.destination); s.connect(tap);
    const tStart = ctx.currentTime, wStart = performance.now();
    s.onended = () => {
      const all = new Float32Array(tapped.length * 2048); tapped.forEach((c, k) => all.set(c, k * 2048));
      R.playback = {
        rate, clipSec: clip.length / sr, expectedSec: clip.length / sr / rate,
        ctxElapsed: ctx.currentTime - tStart, wallElapsed: (performance.now() - wStart) / 1000,
        inputF0: f0(clip, sr), outputF0: f0(all, sr), tappedSec: all.length / sr,
      };
      R.done = true; log(JSON.stringify(R.playback));
    };
    s.start();
  }
});
