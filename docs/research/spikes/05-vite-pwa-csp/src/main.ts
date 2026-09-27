import './styles.css';
import workletUrl from './capture.worklet.ts?worker&url';
import { registerSW } from 'virtual:pwa-register';
const updateSW = registerSW({ onNeedRefresh() { console.log('need refresh'); }, onOfflineReady() { console.log('offline ready'); }, onRegisteredSW(u, r) { console.log('sw registered', u, !!r); }, onRegisterError(e) { console.log('sw register error', String(e)); } });
(window as any).updateSW = updateSW;
const worker = new Worker(new URL('./dsp.worker.ts', import.meta.url), { type: 'module' });
worker.onmessage = (e) => console.log('worker bytes', e.data);
worker.onerror = (e) => console.log('worker error', e.message);
worker.postMessage('go');
const lazy = () => import('./lazy.ts');
document.getElementById('c')!.addEventListener('click', async () => {
  try {
    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule(workletUrl);
    const n = new AudioWorkletNode(ctx, 'capture'); n.connect(ctx.destination);
    console.log('worklet ok', ctx.state);
    (await lazy()).hi();
    const el = document.getElementById('c')!; el.style.background = '#123'; el.style.setProperty('width', '10px');
    console.log('cssom ok', getComputedStyle(el).width);
    try { el.setAttribute('style', 'height:5px'); console.log('setAttribute(style) computed height', getComputedStyle(el).height); } catch (e) { console.log('setAttribute err', String(e)); }
    console.log('vibrate', navigator.vibrate?.(10));
    const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    console.log('gum ok', s.getAudioTracks()[0].getSettings().sampleRate);
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['x'])); a.download = 't.bin'; document.body.appendChild(a);
    console.log('done');
  } catch (e) { console.log('click flow error', String(e)); }
});
