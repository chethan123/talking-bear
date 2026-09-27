// Lab page: plays every sound effect in SYNTHS for listening (plan §4.6.4). Dev-only (`pnpm dev`, then
// /lab/sfx.html); no audio is captured, stored or downloaded.
import { createMasterBus } from '../src/audio/bus.ts';
import { createSfx } from '../src/audio/sfx.ts';
import type { SfxId } from '../src/audio/sfx-ids.ts';
import { SYNTHS } from '../src/audio/sfx-synths.ts';

const RENDER_SEC = 3;

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`lab/sfx: missing #${id}`);
  return el;
}

const rows = element('sfx-rows', HTMLTableSectionElement);
const status = element('sfx-status', HTMLParagraphElement);

// As in the app: sfx → the sfx scheduler → the master bus (0.7) → destination. The context starts suspended
// and is resumed by the first tap.
const ctx = new AudioContext({ latencyHint: 'interactive' });
const sfx = createSfx(ctx, createMasterBus(ctx).input, SYNTHS);

function isSfxId(key: string): key is SfxId {
  return key in SYNTHS;
}

async function play(id: SfxId): Promise<void> {
  if (ctx.state !== 'running') await ctx.resume();
  sfx.play(id);
  status.textContent = `${id}: playing`;
  await sfx.allEnded();
  status.textContent = `${id}: left the speaker`;
}

/** The duration `id` returns and its sample peak (dBFS), rendered offline alone at the page's sample rate. */
async function measure(id: SfxId): Promise<{ dur: number; peakDb: number }> {
  const off = new OfflineAudioContext(1, RENDER_SEC * ctx.sampleRate, ctx.sampleRate);
  const dur = SYNTHS[id](off, off.destination, 0);
  let peak = 0;
  for (const x of (await off.startRendering()).getChannelData(0)) peak = Math.max(peak, Math.abs(x));
  return { dur, peakDb: 20 * Math.log10(peak) };
}

async function main(): Promise<void> {
  for (const id of Object.keys(SYNTHS).filter(isSfxId)) {
    const row = rows.insertRow();
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = id;
    button.addEventListener('click', () => {
      play(id).catch((err: unknown) => {
        status.textContent = `${id}: ${String(err)}`;
      });
    });
    row.insertCell().append(button);
    const durCell = row.insertCell();
    const peakCell = row.insertCell();
    const { dur, peakDb } = await measure(id);
    durCell.textContent = `${Math.round(dur * 1000)} ms`;
    peakCell.textContent = `${peakDb.toFixed(1)} dBFS`;
  }
}

main().catch((err: unknown) => {
  status.textContent = `lab/sfx: ${String(err)}`;
});
