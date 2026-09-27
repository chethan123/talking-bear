import weightsUrl from './weights.bin?url';
self.onmessage = async (e) => { const r = await fetch(weightsUrl); const b = await r.arrayBuffer(); (self as any).postMessage(b.byteLength); };
export {};
