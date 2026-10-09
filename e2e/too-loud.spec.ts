import { expect, test } from '@playwright/test';
import { expectLoop, expectSileroTake, noCspViolationsAfterEach, steps } from './helpers/app';
import { micFlags } from './helpers/flags';

// Issue #117 (T106), plan §4.4 "Clipping (shouting)", §7 M8: after the replay of a clipped take the bear plays the
// playful "too loud!" reaction. The fake mic is e2e/fixtures/vowel_clipped.wav (scripts/gen-fixtures.ts): the 1.5 s
// vowel of vowel_f0-140 at full scale, ×4 and hard-clipped to ±1.0 (ORCH-NOTE 6074844540 on #117), so the worker's
// clipDetect flags the take. The default VAD backend (Silero) keeps this vowel whole, so nothing is pinned.
//
// - One loop only: the fake mic plays the file once (`%noloop`) and it ends in digital silence.
// - `__bearTest.log` carries each step's anim events (ORCH-NOTE 6074844540): the Playing → Cooldown step on
//   `playbackAtSpeakerEnded` has `talkEnd` then `reaction{tooLoud, 2}`, and no other step after wake has a reaction.
// - The `processed` event of the Processing → Playing step before it has `clipped: true`; no sfx is scheduled.
// - An in-page sampler (every 10 ms, installed before the app loads) records each change of the director's clip
//   (`__bearTest.pose().clip`, #118) and of the live region's text: BearView turns the reaction into the `tooLoud`
//   clip (not the gentle one), and nothing is announced after waking.
test.use({ launchOptions: { args: micFlags('e2e/fixtures/vowel_clipped.wav') } });
test.setTimeout(45_000);
noCspViolationsAfterEach();

declare global {
  interface Window {
    /** This spec's clip sampler: every change of `__bearTest.pose().clip`, with its performance.now() time. */
    tooLoudClips?: { t: number; clip: string | null }[];
    /** This spec's live-region sampler: every change of the live region's text, with its performance.now() time. */
    tooLoudLive?: { t: number; text: string }[];
  }
}

const LOUD = { e: 'reaction', name: 'tooLoud', priority: 2 } as const;

test('too-loud: a clipped take is replayed, then the bear plays tooLoud: no sfx, no announcement', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const clips: { t: number; clip: string | null }[] = [];
    const live: { t: number; text: string }[] = [];
    window.tooLoudClips = clips;
    window.tooLoudLive = live;
    setInterval(() => {
      const now = performance.now();
      const text = document.querySelector('[data-a11y-live]')?.textContent ?? '';
      if (live.at(-1)?.text !== text) live.push({ t: now, text });
      const hooks: unknown = window.__bearTest;
      const fn: unknown = typeof hooks === 'object' && hooks !== null ? Reflect.get(hooks, 'pose') : null;
      if (typeof fn !== 'function') return;
      let clip: unknown;
      try {
        const pose: unknown = Reflect.apply(fn, hooks, []);
        clip = typeof pose === 'object' && pose !== null ? Reflect.get(pose, 'clip') : undefined;
      } catch {
        return; // the bear is not mounted yet
      }
      if (clip !== null && typeof clip !== 'string') return;
      if (clips.at(-1)?.clip !== clip) clips.push({ t: now, clip });
    }, 10);
  });

  await expectLoop(page, 'vowel_clipped', 140);
  await expectSileroTake(page);

  const all = await steps(page);
  const wake = all.findIndex((s) => s.to === 'Listening' && s.from !== 'Listening');
  expect(wake, 'a transition into Listening').toBeGreaterThanOrEqual(0);
  const end = all.findIndex(
    (s, i) => i > wake && s.from === 'Playing' && s.to === 'Cooldown' && s.event === 'playbackAtSpeakerEnded',
  );
  expect(end, 'the replay ended at the speaker (row 28)').toBeGreaterThan(wake);
  const play = all.findLastIndex((s, i) => i < end && s.from === 'Processing' && s.to === 'Playing');
  const processed = all[play]?.e;
  expect(processed?.t === 'processed' && processed.clipped, 'the replayed take was clipped').toBe(true);

  // Validation 2: the log shows the tooLoud anim effect, after talkEnd, on row 28 only.
  const ended = all[end]!;
  expect(ended.anims).toStrictEqual([{ e: 'talkEnd' }, LOUD]);
  const reactions = all.flatMap((s, i) =>
    i > wake && i !== end ? s.anims.filter((a) => a.e === 'reaction').map((a) => ({ i, a })) : [],
  );
  expect(reactions, 'no other step after wake has a reaction anim').toEqual([]);
  expect(
    all.filter((s, i) => i > wake && s.effects.includes('sfx')).map((s) => `${s.from}>${s.to} ${s.event}`),
    'no sfx after wake',
  ).toEqual([]);

  // BearView → director: the clip plays within 1 s of the step (the gentle one only with reduced motion).
  await expect
    .poll(() => page.evaluate(() => (window.tooLoudClips ?? []).map((c) => c.clip)), {
      message: 'the tooLoud clip',
      timeout: 3_000,
    })
    .toContain('tooLoud');
  const { clips, live } = await page.evaluate(() => ({
    clips: window.tooLoudClips ?? [],
    live: window.tooLoudLive ?? [],
  }));
  const first = clips.find((c) => c.clip === 'tooLoud')!;
  expect(first.t, 'tooLoud starts after the step').toBeGreaterThanOrEqual(ended.t);
  expect(first.t, 'tooLoud starts within 1 s of the step').toBeLessThanOrEqual(ended.t + 1000);
  expect(clips.map((c) => c.clip)).not.toContain('tooLoudGentle');

  // a11y: tooLoud changes no state and shows no overlay, so the live region says nothing after waking.
  const woke = all[wake]!.t;
  expect(live.filter((l) => l.t >= woke && l.text !== '').map((l) => l.text)).toEqual([]);

  const back = all.findIndex((s, i) => i > end && s.from === 'Cooldown' && s.to === 'Listening');
  console.log(
    [
      `vowel_clipped: processed.clipped ${String(processed?.t === 'processed' && processed.clipped)}`,
      `row 28 anims ${JSON.stringify(ended.anims)}`,
      `tooLoud clip ${(first.t - ended.t).toFixed(1)} ms after the step`,
      `cooldown ${back > end ? (all[back]!.t - ended.t).toFixed(1) : '?'} ms`,
    ].join('; '),
  );
});
