(async () => {
  const out = { errors: [] };
  try {
    const sr = 44100, len = sr * 5;
    const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: len, sampleRate: sr });
    out.hasAudioWorklet = 'audioWorklet' in ctx;
    await ctx.audioWorklet.addModule('/proc.js');
    const node = new AudioWorkletNode(ctx, 'probe', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    const msgs = []; let renderDone = false;
    node.port.onmessage = e => msgs.push({ ...e.data, duringRender: !renderDone, tMain: performance.now() });
    const buf = ctx.createBuffer(1, len, sr); const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / sr);
    const src = new AudioBufferSourceNode(ctx, { buffer: buf });
    src.connect(node).connect(ctx.destination); src.start();
    node.port.postMessage({ t: 'arm' });
    const t0 = performance.now();
    const rendered = await ctx.startRendering();
    const t1 = performance.now(); renderDone = true;
    await new Promise(r => setTimeout(r, 300));
    const qs = msgs.filter(m => m.t === 'q');
    out.renderMs = +(t1 - t0).toFixed(1);
    out.audioSeconds = len / sr;
    out.renderedLength = rendered.length;
    out.quantaExpected = Math.ceil(len / 128);
    out.qMsgs = qs.length; out.qMsgsDuringRender = qs.filter(m => m.duringRender).length;
    out.firstQ = qs[0] && { q: qs[0].q, frame: qs[0].frame, sr: qs[0].sr, rms: +qs[0].rms.toFixed(3), bufLen: qs[0].buf.length };
    out.lastQ = qs.at(-1) && { q: qs.at(-1).q, frame: qs.at(-1).frame, rms: +qs.at(-1).rms.toFixed(3) };
    const cmd = msgs.find(m => m.t === 'cmdSeen'); out.cmdSeenAtQuantum = cmd ? cmd.q : null;
    out.transferWorked = qs[0] ? qs[0].buf instanceof Float32Array : null;
  } catch (e) { out.errors.push(String(e && e.stack || e)); }
  window.__result = out;
})();
