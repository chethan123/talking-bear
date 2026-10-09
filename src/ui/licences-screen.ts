// The in-app licences screen (plan §7 M8, §11; issue #114): a full-screen view, opened from the settings sheet's
// "For parents" section, that shows `licenses.txt` (public/licenses.txt, shipped since M2 and precached by the
// service worker: vite.config.ts `globPatterns` includes txt) as plain text. Nothing in it links anywhere: the
// URLs in the file stay text in a `<pre>`, set through `textContent` and never parsed as HTML.
//
// The view is a modal `<dialog>` that covers the viewport (styles.css), stacked in the top layer over the settings
// sheet. Close is focused on open; Close or Escape closes it, and focus returns to the element that opened it. The
// file is fetched on the first open and kept; a failed fetch shows a short line, and the next open tries again.
//
// CSP `style-src 'self'` and Trusted Types (plan §4.8.3): the DOM is built with createElement/textContent only,
// never HTML strings, and nothing sets a `style` attribute.

/** The licences file, same-origin (CSP `connect-src 'self'`) and precached. */
export const LICENCES_URL = '/licenses.txt';

export const LICENCES_TEXT = {
  title: 'Open-source licences',
  loading: 'Loading…',
  failed: 'The licences could not be loaded.',
  close: 'Close',
} as const;

export interface LicencesScreenDeps {
  /** Fetches the file; defaults to the global `fetch`, looked up at call time. */
  fetch?: (url: string) => Promise<Response>;
}

export interface LicencesScreen {
  /** Shows the view (if it is not open) and resolves once the text, or the failure line, is shown. */
  open(): Promise<void>;
  close(): void;
}

/** Each mount labels its dialog uniquely. */
let mounts = 0;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string | null,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className !== null) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** Mounts the (closed) licences view into `root`. */
export function mountLicencesScreen(root: HTMLElement, deps: LicencesScreenDeps = {}): LicencesScreen {
  const fetchText = deps.fetch ?? ((url: string): Promise<Response> => fetch(url));

  const dialog = element('dialog', 'licences-screen');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  const title = element('h2', null, LICENCES_TEXT.title);
  title.id = `bear-licences-${++mounts}-title`;
  dialog.setAttribute('aria-labelledby', title.id);

  const close = element('button', 'sheet-button licences-close', LICENCES_TEXT.close);
  close.type = 'button';
  close.addEventListener('click', () => {
    dialog.close();
  });
  const header = element('div', 'licences-header');
  header.append(title, close);

  const status = element('p', 'licences-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'off');
  status.hidden = true;
  const text = element('pre', 'licences-text');
  text.hidden = true;

  dialog.append(header, status, text);

  /** The element focused when the view opened: focus goes back to it on close. */
  let opener: Element | null = null;
  dialog.addEventListener('close', () => {
    const back = opener;
    opener = null;
    if (back instanceof HTMLElement && back.isConnected) back.focus();
  });

  /** True once the file is shown; it is never fetched again. */
  let loaded = false;
  /** The load in progress, shared by every `open()` while it runs. */
  let loading: Promise<void> | null = null;

  async function load(): Promise<void> {
    status.textContent = LICENCES_TEXT.loading;
    status.hidden = false;
    text.hidden = true;
    try {
      const response = await fetchText(LICENCES_URL);
      if (!response.ok) throw new Error(`${LICENCES_URL}: HTTP ${response.status}`);
      text.textContent = await response.text(); // text only: markup in the file is never parsed
      text.hidden = false;
      status.hidden = true;
      loaded = true;
    } catch {
      status.textContent = LICENCES_TEXT.failed; // the next open() tries again
    }
  }

  function open(): Promise<void> {
    if (!dialog.open) {
      opener = document.activeElement;
      dialog.showModal();
      close.focus();
    }
    if (loaded) return Promise.resolve();
    loading ??= load().finally(() => {
      loading = null;
    });
    return loading;
  }

  root.append(dialog);
  return {
    open,
    close: () => {
      dialog.close();
    },
  };
}
