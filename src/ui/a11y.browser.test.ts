/// <reference types="@vitest/browser-playwright" />
// Browser Mode tests for accessibility (a11y.ts, overlay.ts; plan §7 M8, issue #118): the accessible names, and the
// one aria-live region that speaks only on entering Asleep, MicDenied and Error, the states whose mic is closed.
// The session side is the real reducer: every `ui` effect of `reduce` goes to the overlay's `show`, as main.ts's
// `onUi` does, so "entering a state" here is the app's own transition. Paused is not announced (ORCH-NOTE on #118).
// styles.css is imported: the region's visually-hidden rule comes from it.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cdp } from 'vitest/browser';
import type { Overlay, Permission, SessionEvent, SessionState, StateName } from '../app/events.ts';
import { initialSessionState, overlayFor, reduce, TABLE } from '../app/machine.ts';
import { createSettingsStore } from '../app/settings.ts';
import { A11Y_TEXT, ANNOUNCEMENTS, announcementFor, LIVE_REGION_CLASS } from './a11y.ts';
import { mountOverlay } from './overlay.ts';
import { mountSettingsSheet, SETTINGS_TEXT, type SheetPwa } from './settings-sheet.ts';
import './styles.css';

const roots: HTMLElement[] = [];

function newRoot(): HTMLElement {
  const root = document.createElement('div');
  document.body.append(root);
  roots.push(root);
  return root;
}

beforeEach(() => {
  for (const el of document.querySelectorAll('[data-a11y-live]')) el.remove();
});

afterEach(() => {
  for (const r of roots.splice(0)) r.remove();
  for (const el of document.querySelectorAll('[data-a11y-live]')) el.remove();
});

/** The document's one live region. */
function region(): HTMLElement {
  const all = document.querySelectorAll<HTMLElement>('[data-a11y-live]');
  expect(all).toHaveLength(1);
  return all[0]!;
}

/**
 * Every element that is a live region: an `aria-live` other than `off`, or a role whose implicit `aria-live` is not
 * `off` without an explicit `aria-live="off"`. Hidden elements included: a hidden region shown later is the risk.
 */
function liveRegions(): Element[] {
  return Array.from(
    document.querySelectorAll(
      '[aria-live]:not([aria-live="off"]), :is([role="status"], [role="alert"], [role="log"], [role="marquee"], [role="timer"]):not([aria-live]), output:not([aria-live])',
    ),
  );
}

/** The icon-only variants and their names (issue #118 "Icon-only overlays get role=status with a hidden label"). */
const ICON_VIEWS: readonly [Exclude<Overlay, null | 'parentPermission' | 'holdToTalk'>, string][] = [
  ['tapToWake', A11Y_TEXT.tapToWake],
  ['micHelp', A11Y_TEXT.micHelp],
  ['micMuted', A11Y_TEXT.micMuted],
  ['tooNoisy', A11Y_TEXT.tooNoisy],
  ['error', A11Y_TEXT.error],
];

const PWA: SheetPwa = {
  installAvailable: () => true,
  promptInstall: async () => {},
  updateReady: () => true,
  applyUpdate: () => {},
};

/** Mounts the settings sheet into `root`, opens it and its licences view, and waits for the licences text. */
async function openSheetAndLicences(root: HTMLElement, pwa: SheetPwa = PWA): Promise<void> {
  const sheet = mountSettingsSheet(root, {
    store: createSettingsStore(null),
    bus: { setQuiet: vi.fn() },
    state: () => 'MicDenied',
    dispatch: vi.fn(),
    pwa,
    fetch: async () => new Response('Licences.'),
  });
  expect(sheet.open()).toBe(true);
  sheet.refreshPwa();
  const licences = Array.from(root.querySelectorAll('button')).find(
    (b) => b.textContent === SETTINGS_TEXT.licences,
  );
  if (licences === undefined) throw new Error('no licences button');
  licences.click();
  await vi.waitFor(() => {
    expect(root.querySelector('dialog.licences-screen pre')?.textContent).toBe('Licences.');
  });
}

/** The parts of a CDP `Accessibility.AXNode` these tests read. */
interface AxNode {
  nodeId: string;
  role?: { value?: unknown };
  name?: { value?: unknown };
  properties?: { name: string; value: { value?: unknown } }[];
  childIds?: string[];
}

/** The issue's accessible-name formula. */
const nameOf = (b: HTMLButtonElement): string => (b.getAttribute('aria-label') || b.textContent || '').trim();

describe('a11y.ts: the live region follows the overlay (#118)', () => {
  test('the announcing overlays are exactly those of Asleep, MicDenied and Error, over every state', () => {
    const STATES = Object.keys(TABLE).filter((k): k is StateName => Object.hasOwn(TABLE, k));
    expect(STATES).toHaveLength(12);
    const announcements: Partial<Record<StateName, string>> = ANNOUNCEMENTS;
    for (const name of STATES) {
      for (const micMuted of [false, true]) {
        for (const tooNoisy of [false, true]) {
          for (const holdToTalk of [false, true]) {
            const o = overlayFor({ name, micMuted, tooNoisy, holdToTalk });
            expect(announcementFor(o), `${name} ${micMuted} ${tooNoisy} ${holdToTalk}`).toBe(
              announcements[name] ?? '',
            );
          }
        }
      }
    }
    expect(ANNOUNCEMENTS).toEqual({
      Asleep: 'Juni is asleep. Tap to wake.',
      MicDenied: 'Microphone blocked. A parent can fix this in settings.',
      Error: 'Something went wrong. Tap to try again.',
    });
  });

  test('one live region in the document, outside the overlay roots, visually hidden but rendered', async () => {
    const a = newRoot();
    const b = newRoot();
    mountOverlay(a, vi.fn());
    mountOverlay(b, vi.fn());
    const r = region();
    expect(r.parentElement).toBe(document.body);
    expect(a.contains(r) || b.contains(r)).toBe(false);
    expect(r.classList.contains(LIVE_REGION_CLASS)).toBe(true);
    expect(r.getAttribute('aria-live')).toBe('polite');
    expect(r.getAttribute('aria-atomic')).toBe('true');
    // The settings sheet and its licences view (whose status line must not be a second live region) are up.
    await openSheetAndLicences(a);
    expect(liveRegions()).toEqual([r]);
    // Visually hidden, never hidden from assistive tech.
    const box = r.getBoundingClientRect();
    expect(box.width).toBeLessThanOrEqual(1);
    expect(box.height).toBeLessThanOrEqual(1);
    expect(r.checkVisibility()).toBe(true);
    const cs = getComputedStyle(r);
    expect(cs.display).not.toBe('none');
    expect(cs.visibility).toBe('visible');
    expect(cs.pointerEvents).toBe('none');
    expect(r.hidden).toBe(false);
    expect(document.elementFromPoint(0, 0)).not.toBe(r);
    expect(r.hasAttribute('style')).toBe(false);
  });

  test.each(ICON_VIEWS)('%s is role=status named "%s", never live, with no text', (variant, label) => {
    const root = newRoot();
    const show = mountOverlay(root, vi.fn());
    show(variant);
    const view = Array.from(root.querySelectorAll<HTMLElement>('.overlay > *')).find((v) => !v.hidden);
    if (view === undefined) throw new Error('no visible view');
    expect(view.getAttribute('role')).toBe('status');
    expect(view.getAttribute('aria-label')).toBe(label);
    expect(view.getAttribute('aria-live')).toBe('off');
    expect(view.textContent).toBe('');
  });

  test('the hold-to-talk button is named "Hold to talk"', () => {
    const root = newRoot();
    mountOverlay(root, vi.fn());
    const hold = root.querySelector('button.overlay-hold');
    expect(hold?.getAttribute('aria-label')).toBe('Hold to talk');
    expect(hold?.textContent).toBe('');
  });

  test("Chromium's accessibility tree: the icon views are not live; the region is polite", async () => {
    const root = newRoot();
    const show = mountOverlay(root, vi.fn());
    const client = cdp();
    await client.send('Accessibility.enable');
    try {
      // The test runs in an iframe: read the frame whose tree holds this test's nodes.
      const { frameTree } = await client.send('Page.getFrameTree');
      const frames: string[] = [];
      const walk = (t: typeof frameTree): void => {
        frames.push(t.frame.id);
        for (const c of t.childFrames ?? []) walk(c);
      };
      walk(frameTree);
      const treeWith = async (name: string): Promise<AxNode[]> => {
        for (const frameId of frames) {
          const { nodes } = await client.send('Accessibility.getFullAXTree', { frameId });
          if (nodes.some((n) => n.name?.value === name)) return nodes;
        }
        throw new Error(`no frame has an AX node named ${name}`);
      };
      const live = (n: AxNode): unknown => n.properties?.find((p) => p.name === 'live')?.value.value;
      for (const [variant, label] of ICON_VIEWS) {
        show(variant);
        const nodes = await treeWith(label);
        const node = nodes.find((n) => n.role?.value === 'status' && n.name?.value === label);
        expect(node, `${variant}: a status node named ${label}`).toBeDefined();
        expect(live(node!), `${variant}: live`).toBeUndefined();
        // The region is the one polite live root: it is not named; it is the node whose child is its text.
        const text = announcementFor(variant);
        if (text !== '') {
          const polite = nodes.filter((n) => live(n) === 'polite' && n.role?.value === 'generic');
          expect(polite, `${variant}: polite generic nodes`).toHaveLength(1);
          const kids = new Set(polite[0]!.childIds ?? []);
          const texts = nodes.filter((n) => kids.has(n.nodeId)).map((n) => n.name?.value);
          expect(texts).toEqual([text]);
        }
      }
    } finally {
      await client.send('Accessibility.disable');
    }
  });
});

/** The real reducer driving `show`, as main.ts's `onUi` does; `send` returns the new state's name. */
function session(show: (o: Overlay) => void, permission: Permission) {
  let s: SessionState = initialSessionState(permission);
  show(overlayFor(s)); // boot's initial overlay
  return {
    get s(): SessionState {
      return s;
    },
    send(e: SessionEvent): StateName {
      const out = reduce(s, e);
      s = out.state;
      for (const fx of out.effects) if (fx.k === 'ui') show(fx.show);
      return s.name;
    },
  };
}

/** Watches every mutation of `el` (text, children, attributes) from now on; the returned function lists them. */
function watch(el: HTMLElement): () => MutationRecord[] {
  const seen: MutationRecord[] = [];
  const obs = new MutationObserver((records) => seen.push(...records));
  obs.observe(el, { childList: true, characterData: true, subtree: true, attributes: true });
  return () => [...seen, ...obs.takeRecords()];
}

/** Asleep (granted) → tap → Waking → Listening, returning the session. */
function wakeToListening(m: ReturnType<typeof session>): void {
  expect(m.send({ t: 'tapBear' })).toBe('Waking');
  expect(m.send({ t: 'micGranted', req: m.s.micReq })).toBe('Waking');
  expect(m.send({ t: 'ctxRunning', sampleRate: 48_000 })).toBe('Listening');
}

describe('the live region across real transitions (#118)', () => {
  test('a transition into Listening never changes it: not on a wake, a loop, a reaction, a badge or a pause', () => {
    const root = newRoot();
    const show = mountOverlay(root, vi.fn());
    const m = session(show, 'granted');
    expect(m.s.name).toBe('Asleep');
    expect(region().textContent).toBe(ANNOUNCEMENTS.Asleep);
    expect(m.send({ t: 'tapBear' })).toBe('Waking');
    expect(region().textContent).toBe(''); // cleared on leaving Asleep
    const records = watch(region());
    // Into Listening from Waking.
    expect(m.send({ t: 'micGranted', req: m.s.micReq })).toBe('Waking');
    expect(m.send({ t: 'ctxRunning', sampleRate: 48_000 })).toBe('Listening');
    // A full loop, back into Listening from Cooldown.
    m.send({ t: 'armed', epoch: m.s.epoch, armFrame: 1_000 });
    expect(m.send({ t: 'seg', epoch: m.s.epoch, ev: { kind: 'start', frame: 20_000 } })).toBe('Recording');
    expect(
      m.send({
        t: 'seg',
        epoch: m.s.epoch,
        ev: { kind: 'end', frame: 80_000, lastSpeechFrame: 60_000, reason: 'silence' },
      }),
    ).toBe('Processing');
    expect(m.send({ t: 'clipReady', epoch: m.s.epoch, id: m.s.takeId })).toBe('Processing');
    expect(m.send({ t: 'processed', id: m.s.takeId, durationSec: 1 })).toBe('Playing');
    expect(m.send({ t: 'playbackAtSpeakerEnded', id: m.s.takeId })).toBe('Cooldown');
    expect(m.send({ t: 'timer', name: 'cooldown' })).toBe('Listening');
    // A reaction with a sound: SfxGated, Cooldown, Listening.
    expect(m.send({ t: 'reaction', name: 'sneeze', priority: 2, sfx: 'sneeze' })).toBe('SfxGated');
    expect(m.send({ t: 'sfxAtSpeakerEnded', seq: m.s.sfxSeq })).toBe('Cooldown');
    expect(m.send({ t: 'timer', name: 'cooldown' })).toBe('Listening');
    // A reaction without a sound stays in Listening.
    expect(m.send({ t: 'reaction', name: 'earFlick', priority: 1, sfx: null })).toBe('Listening');
    // The Listening badges: muted (and the unmute re-enters Listening), too noisy.
    expect(m.send({ t: 'trackMuted' })).toBe('Listening');
    expect(m.s.micMuted).toBe(true);
    expect(m.send({ t: 'trackUnmuted' })).toBe('Listening');
    expect(m.send({ t: 'noiseFloor', floorDb: -20 })).toBe('Listening');
    expect(m.s.tooNoisy).toBe(true);
    // Hidden → Paused (not announced) → visible → Waking → Listening.
    expect(m.send({ t: 'hidden' })).toBe('Paused');
    expect(m.send({ t: 'visible' })).toBe('Waking');
    expect(m.send({ t: 'micGranted', req: m.s.micReq })).toBe('Waking');
    expect(m.send({ t: 'ctxRunning', sampleRate: 48_000 })).toBe('Listening');
    expect(records()).toHaveLength(0);
    expect(region().textContent).toBe('');
  });

  test('the Listening overlays never write it: null, micMuted, holdToTalk and tooNoisy after a clear', () => {
    const root = newRoot();
    const show = mountOverlay(root, vi.fn());
    show('tapToWake');
    expect(region().textContent).toBe(ANNOUNCEMENTS.Asleep);
    show(null); // Waking
    const records = watch(region());
    for (const o of [null, 'micMuted', 'holdToTalk', 'tooNoisy', null, 'holdToTalk'] as const) show(o);
    expect(records()).toHaveLength(0);
    expect(region().textContent).toBe('');
  });

  test.each(['tapToWake', 'micHelp', 'error'] as const)(
    'showing %s again writes nothing: the same announcement is never re-set',
    (o) => {
      const root = newRoot();
      const show = mountOverlay(root, vi.fn());
      show(o);
      const text = announcementFor(o);
      expect(region().textContent).toBe(text);
      const records = watch(region());
      show(o);
      expect(records()).toHaveLength(0);
      expect(region().textContent).toBe(text);
    },
  );

  test('entering Asleep, MicDenied and Error sets the specified text; leaving clears it', () => {
    const root = newRoot();
    const show = mountOverlay(root, vi.fn());
    // Listening → sleep timer → Asleep.
    const g = session(show, 'granted');
    wakeToListening(g);
    expect(region().textContent).toBe('');
    expect(g.send({ t: 'timer', name: 'sleep' })).toBe('Asleep');
    expect(region().textContent).toBe('Juni is asleep. Tap to wake.');
    // Asleep (denied) → tap → MicDenied; a hide pauses (cleared), the return re-announces.
    const d = session(show, 'denied');
    expect(d.send({ t: 'tapBear' })).toBe('MicDenied');
    expect(region().textContent).toBe('Microphone blocked. A parent can fix this in settings.');
    expect(d.send({ t: 'hidden' })).toBe('Paused');
    expect(region().textContent).toBe('');
    expect(d.send({ t: 'visible' })).toBe('MicDenied');
    expect(region().textContent).toBe(ANNOUNCEMENTS.MicDenied);
    // Waking → waking timer → Error; a hide in Error → Asleep.
    const e = session(show, 'granted');
    expect(e.send({ t: 'tapBear' })).toBe('Waking');
    expect(e.send({ t: 'timer', name: 'waking' })).toBe('Error');
    expect(region().textContent).toBe('Something went wrong. Tap to try again.');
    expect(e.send({ t: 'hidden' })).toBe('Asleep');
    expect(region().textContent).toBe(ANNOUNCEMENTS.Asleep);
    // Error → tap → Waking clears it.
    const e2 = session(show, 'granted');
    e2.send({ t: 'tapBear' });
    expect(e2.send({ t: 'timer', name: 'waking' })).toBe('Error');
    expect(region().textContent).toBe(ANNOUNCEMENTS.Error);
    expect(e2.send({ t: 'tapBear' })).toBe('Waking');
    expect(region().textContent).toBe('');
  });

  test('every exit from an announcing state into Waking clears it, touch or not', () => {
    const root = newRoot();
    const show = mountOverlay(root, vi.fn());
    // MicDenied + permissionChanged{granted} (row 10, no touch on the page).
    const a = session(show, 'denied');
    expect(a.send({ t: 'tapBear' })).toBe('MicDenied');
    expect(region().textContent).toBe(ANNOUNCEMENTS.MicDenied);
    expect(a.send({ t: 'permissionChanged', state: 'granted' })).toBe('Waking');
    expect(region().textContent).toBe('');
    // MicDenied + settingsRetry.
    const b = session(show, 'denied');
    expect(b.send({ t: 'tapBear' })).toBe('MicDenied');
    expect(region().textContent).toBe(ANNOUNCEMENTS.MicDenied);
    expect(b.send({ t: 'settingsRetry' })).toBe('Waking');
    expect(region().textContent).toBe('');
    // Asleep (granted) + settingsRetry.
    const c = session(show, 'granted');
    expect(region().textContent).toBe(ANNOUNCEMENTS.Asleep);
    expect(c.send({ t: 'settingsRetry' })).toBe('Waking');
    expect(region().textContent).toBe('');
  });
});

describe('every button has a non-empty accessible name (#118)', () => {
  test('the overlay, the gear, the open settings sheet and the licences view: exactly these 9 names', async () => {
    const root = newRoot();
    mountOverlay(root, vi.fn());
    await openSheetAndLicences(root);
    const names = Array.from(document.querySelectorAll('button'), nameOf);
    expect(names.every((n) => n !== '')).toBe(true);
    expect(names.toSorted()).toEqual([
      'Close',
      'Close',
      'Continue',
      'Hold to talk',
      'Install',
      'New version – restart',
      'Open-source licences',
      'Settings',
      'Try the microphone again',
    ]);
  });

  test('a disabled restart still has its name', async () => {
    const root = newRoot();
    mountOverlay(root, vi.fn());
    await openSheetAndLicences(root, { ...PWA, updateReady: () => false });
    const restart = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === SETTINGS_TEXT.restart,
    );
    expect(restart?.disabled).toBe(true);
    expect(nameOf(restart!)).toBe('New version – restart');
  });
});
