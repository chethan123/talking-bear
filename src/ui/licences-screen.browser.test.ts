// Browser Mode tests for the licences screen (licences-screen.ts, issue #114). styles.css is imported, so the
// full-screen layout and the text wrapping are the real ones. The shipped public/licenses.txt is read through
// Vitest's server command and served by a mocked fetch; one test uses the real global fetch instead, which the
// Vitest server answers with the same file.

import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { commands, page, userEvent } from 'vitest/browser';
import { LICENCES_TEXT, LICENCES_URL, mountLicencesScreen } from './licences-screen.ts';
import './styles.css';

/** The shipped file (public/licenses.txt; the path is relative to the project root). */
let FILE = '';

beforeAll(async () => {
  FILE = await commands.readFile('public/licenses.txt');
});

let root: HTMLDivElement;

beforeEach(() => {
  root = document.createElement('div');
  document.body.append(root);
});

afterEach(async () => {
  root.remove();
  vi.restoreAllMocks();
  await page.viewport(414, 896); // the default tester viewport
});

type FetchFn = (url: string) => Promise<Response>;

/** A fetch mock that answers every call with `body` and HTTP status `code`. */
function fetchOf(body: string, code = 200) {
  return vi.fn<FetchFn>(async () => new Response(body, { status: code }));
}

function screen(): HTMLDialogElement {
  const d = root.querySelector<HTMLDialogElement>('dialog.licences-screen');
  if (d === null) throw new Error('no licences screen');
  return d;
}

function pre(): HTMLPreElement {
  const p = screen().querySelector('pre');
  if (p === null) throw new Error('no pre');
  return p;
}

function status(): HTMLParagraphElement {
  const p = screen().querySelector<HTMLParagraphElement>('p.licences-status');
  if (p === null) throw new Error('no status line');
  return p;
}

function closeButton(): HTMLButtonElement {
  const b = Array.from(screen().querySelectorAll('button')).find(
    (x) => x.textContent === LICENCES_TEXT.close,
  );
  if (b === undefined) throw new Error('no Close button');
  return b;
}

/** A promise whose resolution the test controls. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('licences screen (#114)', () => {
  test('open() fetches /licenses.txt once and shows the shipped file in a <pre> as text: it names the Silero Team', async () => {
    const fetchMock = fetchOf(FILE);
    const licences = mountLicencesScreen(root, { fetch: fetchMock });
    expect(screen().open).toBe(false);
    await licences.open();
    expect(LICENCES_URL).toBe('/licenses.txt');
    expect(fetchMock.mock.calls).toEqual([['/licenses.txt']]);
    expect(pre().textContent).toBe(FILE);
    expect(pre().textContent).toContain('Silero Team');
    expect(pre().children).toHaveLength(0);
    expect(pre().checkVisibility()).toBe(true);
    expect(status().hidden).toBe(true);
    expect(screen().querySelector('h2')?.textContent).toBe('Open-source licences');
  });

  test('markup in the file stays text: nothing in it is parsed into elements', async () => {
    const body = '<a href="https://example.com/">x</a><img src="x"><b>bold</b>';
    const licences = mountLicencesScreen(root, { fetch: fetchOf(body) });
    await licences.open();
    expect(pre().textContent).toBe(body);
    expect(pre().querySelector('*')).toBeNull();
    expect(root.querySelector('a, img, b')).toBeNull();
  });

  test('the default fetch is the real global fetch: it loads the shipped file from /licenses.txt', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const licences = mountLicencesScreen(root);
    await licences.open();
    expect(spy).toHaveBeenCalledWith('/licenses.txt');
    expect(pre().textContent).toBe(FILE);
    expect(status().hidden).toBe(true);
  });

  test('a full-screen modal: it covers the viewport, focus starts on Close, and Close returns focus to the opener', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'open';
    root.append(opener);
    const licences = mountLicencesScreen(root, { fetch: fetchOf(FILE) });
    opener.focus();
    await licences.open();
    const d = screen();
    expect(d.open).toBe(true);
    expect(d.matches(':modal')).toBe(true);
    expect(d.getAttribute('role')).toBe('dialog');
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(d.getAttribute('aria-labelledby') ?? '')?.textContent).toBe(
      LICENCES_TEXT.title,
    );
    const r = d.getBoundingClientRect();
    expect([r.left, r.top, r.width, r.height]).toEqual([0, 0, window.innerWidth, window.innerHeight]);
    expect(document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)?.closest('dialog')).toBe(
      d,
    );
    expect(document.activeElement).toBe(closeButton());
    expect(closeButton().getBoundingClientRect().height).toBeGreaterThanOrEqual(48);
    closeButton().click();
    expect(d.open).toBe(false);
    expect(d.getBoundingClientRect().height).toBe(0); // closed: the UA's display: none still applies
    expect(document.activeElement).toBe(opener);
  });

  test('Escape closes it', async () => {
    const licences = mountLicencesScreen(root, { fetch: fetchOf(FILE) });
    await licences.open();
    expect(screen().open).toBe(true);
    await userEvent.keyboard('{Escape}');
    expect(screen().open).toBe(false);
  });

  test('while the file loads, the status line says Loading… and the <pre> is hidden', async () => {
    const response = deferred<Response>();
    const licences = mountLicencesScreen(root, { fetch: vi.fn<FetchFn>(() => response.promise) });
    const opened = licences.open();
    expect(screen().open).toBe(true);
    expect(status().hidden).toBe(false);
    expect(status().textContent).toBe('Loading…');
    expect(status().getAttribute('role')).toBe('status');
    expect(pre().hidden).toBe(true);
    response.resolve(new Response(FILE));
    await opened;
    expect(status().hidden).toBe(true);
    expect(pre().hidden).toBe(false);
  });

  test('a rejected fetch or an HTTP error shows the failure line; the next open tries again, and a loaded file is kept', async () => {
    const fetchMock = vi
      .fn<FetchFn>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response('missing', { status: 404 }))
      .mockResolvedValue(new Response(FILE));
    const licences = mountLicencesScreen(root, { fetch: fetchMock });
    await licences.open();
    expect(status().textContent).toBe('The licences could not be loaded.');
    expect(status().hidden).toBe(false);
    expect(pre().hidden).toBe(true);
    licences.close();
    await licences.open();
    expect(status().textContent).toBe(LICENCES_TEXT.failed);
    expect(pre().hidden).toBe(true);
    licences.close();
    await licences.open();
    expect(pre().textContent).toBe(FILE);
    expect(pre().hidden).toBe(false);
    expect(status().hidden).toBe(true);
    licences.close();
    await licences.open();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(pre().textContent).toBe(FILE);
  });

  test('opens while the file is loading share one fetch', async () => {
    const response = deferred<Response>();
    const fetchMock = vi.fn<FetchFn>(() => response.promise);
    const licences = mountLicencesScreen(root, { fetch: fetchMock });
    const first = licences.open();
    const second = licences.open();
    response.resolve(new Response(FILE));
    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pre().textContent).toBe(FILE);
  });

  test('at a 320 × 568 phone viewport the text wraps and scrolls inside the <pre>; Close stays in view', async () => {
    await page.viewport(320, 568);
    const licences = mountLicencesScreen(root, { fetch: fetchOf(FILE) });
    await licences.open();
    const d = screen();
    const p = pre();
    expect(d.getBoundingClientRect().width).toBe(320);
    expect(p.scrollWidth).toBeLessThanOrEqual(p.clientWidth); // no sideways scrolling
    expect(d.scrollHeight).toBeLessThanOrEqual(d.clientHeight); // the dialog itself does not scroll
    expect(p.scrollHeight).toBeGreaterThan(p.clientHeight); // the text scrolls inside the pre
    p.scrollTop = p.scrollHeight;
    const r = closeButton().getBoundingClientRect();
    expect(r.top).toBeGreaterThanOrEqual(0);
    expect(r.bottom).toBeLessThanOrEqual(window.innerHeight);
  });

  test('no element under the mount root has a style attribute (CSP style-src self)', async () => {
    const licences = mountLicencesScreen(root, { fetch: fetchOf(FILE) });
    await licences.open();
    expect(root.querySelectorAll('[style]').length).toBe(0);
  });
});
