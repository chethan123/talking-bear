// Golden STOI values for test/stoi.ts (T115): sentence-00-r0 upsampled to 48 kHz, plain = sinc p 1.45.
import { readFileSync } from 'node:fs';
import { resampleOffline } from '../../../../src/dsp/resample.ts';
import { hpfTrim } from '../../../../src/dsp/voice.ts';
import { readWav } from '../../../../test/wav.ts';
import { ringMod, stoi } from './duck-lib.mjs';
import { stage } from './alias-onset.mjs';
const FS = 48000;
const w = readWav(readFileSync('test/corpus/speech/sentence-00-r0.wav'));
const x = resampleOffline(w.channels[0], FS / w.sampleRate);
const plain = resampleOffline(hpfTrim(x, FS, false), 1 / 1.45);
console.log('stoi(plain, plain)', stoi(plain, plain, FS).toFixed(6));
console.log('stoi(plain, ringMod 90 Hz mix 0.5)', stoi(plain, ringMod(plain, FS, { fc: 90, mix: 0.5 }), FS).toFixed(6));
console.log('stoi(plain, duck stage DUCK)', stoi(plain, stage(plain, FS, { lpHz: 5000, sections: 4 }), FS).toFixed(6));
