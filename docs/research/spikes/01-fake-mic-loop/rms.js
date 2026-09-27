window.__rms = [];
document.getElementById('start').addEventListener('click', async () => {
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule('/capture-worklet.js');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  const node = new AudioWorkletNode(ctx, 'capture', { numberOfInputs: 1, numberOfOutputs: 0 });
  ctx.createMediaStreamSource(stream).connect(node);
  const t0 = performance.now();
  node.port.onmessage = ({ data }) => {
    let s = 0; for (const v of data.chunk) s += v * v;
    window.__rms.push([Math.round(performance.now() - t0), +(10 * Math.log10(s / data.chunk.length + 1e-12)).toFixed(1)]);
  };
});
