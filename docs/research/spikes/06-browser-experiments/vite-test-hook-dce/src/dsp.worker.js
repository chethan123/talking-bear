import { hpf } from './shared.js';
if (import.meta.env.VITE_BEAR_TEST_HOOKS === '1') { self.__bearTest = { marker: 'WORKER_HOOK_MARKER' }; }
self.onmessage = (e) => { self.postMessage(hpf(e.data)); };
