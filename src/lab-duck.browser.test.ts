// lab/duck (duck plan §5 T117, X-F4) in a real Chromium: the page's own engine, the fake microphone
// (--use-fake-device-for-media-stream: a 400 Hz beep every 500 ms, vitest.config.ts) and its master bus. One test
// trial is driven as the experimenter would: Open mic, hold the test Record button, release, wait for the replay
// to end, tap ✓, answer "sounds like a duck?". The results must hold exactly the plan's per-trial keys, and the
// captured clip the engine handed over must be zero-filled afterwards (plan Q2).
import { expect, test } from 'vitest';
import { CONDITIONS, mountDuckLab } from '../lab/duck.ts';

const KEYS = ['ageGroup', 'condition', 'correct', 'duckLike', 'listener', 'route'];

function control(root: HTMLElement, role: string): HTMLButtonElement {
  const b = root.querySelector<HTMLButtonElement>(`button[data-role="${role}"]`);
  if (b === null) throw new Error(`test: no ${role} button`);
  return b;
}

/** Resolves once `cond()` holds, polling every 20 ms; rejects with `what` after `ms`. */
async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = performance.now() + ms;
  while (!cond()) {
    if (performance.now() > deadline) throw new Error(`test: ${what} within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('importing lab/duck.ts mounts nothing (no #duck-lab on this page)', () => {
  expect(document.getElementById('duck-lab')).toBeNull();
  expect(document.body.querySelector('button[data-role]')).toBeNull();
});

test('one X-F4 trial: results have exactly the per-trial keys, and the captured clip is all zeros', async () => {
  const root = document.createElement('main');
  document.body.append(root);
  const lab = mountDuckLab(root);
  try {
    expect(JSON.parse(lab.results())).toStrictEqual([]);
    expect(lab.lastClip()).toBeNull();

    const record = control(root, 'test-record');
    control(root, 'open').click();
    await until(() => !record.disabled, 15_000, 'the mic opened');

    record.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, button: 0, pointerId: 7 }),
    );
    await sleep(1200);
    window.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, isPrimary: true, button: 0, pointerId: 7 }),
    );

    const correct = control(root, 'correct');
    await until(() => !correct.disabled, 15_000, 'the trial played to its end');
    correct.click();
    const yes = control(root, 'duck-yes');
    expect(yes.disabled).toBe(false);
    yes.click();

    const parsed: unknown = JSON.parse(lab.results());
    if (!Array.isArray(parsed)) throw new Error('test: results() is not a JSON array');
    expect(parsed).toHaveLength(1);
    const [rec]: unknown[] = parsed;
    if (typeof rec !== 'object' || rec === null) throw new Error('test: the trial record is not an object');
    expect(Object.keys(rec).toSorted()).toStrictEqual(KEYS);
    expect(rec).toMatchObject({
      listener: 'L1',
      ageGroup: 'adult',
      route: 'speaker',
      correct: true,
      duckLike: true,
    });
    expect(CONDITIONS).toContain(Reflect.get(rec, 'condition'));

    const clip = lab.lastClip();
    if (clip === null) throw new Error('test: no captured clip');
    expect(clip.length).toBeGreaterThan(0);
    expect(clip.every((v) => v === 0)).toBe(true);
  } finally {
    lab.dispose();
    root.remove();
  }
}, 40_000);
