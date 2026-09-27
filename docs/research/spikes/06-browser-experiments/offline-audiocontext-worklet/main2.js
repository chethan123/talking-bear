(async () => {
  const out = { errors: [] };
  try {
    const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 44100, sampleRate: 44100 });
    await ctx.audioWorklet.addModule('/proc2.js');
    const node = new AudioWorkletNode(ctx, 'probe2');
    const msgs = []; node.port.onmessage = e => msgs.push(e.data);
    const buf = ctx.createBuffer(1, 44100, 44100); buf.getChannelData(0).fill(0.5);
    const src = new AudioBufferSourceNode(ctx, { buffer: buf }); src.connect(node).connect(ctx.destination); src.start();
    await ctx.startRendering(); await new Promise(r => setTimeout(r, 200));
    out.msg = msgs[0];
  } catch (e) { out.errors.push(String(e)); }
  window.__result = out;
})();
