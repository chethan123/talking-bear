// Shared helpers for the dev-only lab pages (plan §5, §6). Pages build their DOM with `el` (never from HTML
// strings) and append every action and value to the `logPanel` log. The log holds text only: no lab page
// stores or exports captured audio (plan Q2).

/** Attributes for `el`: each entry becomes `setAttribute(name, value)`. */
export type Attrs = Readonly<Record<string, string>>;

/** `document.createElement(tag)` with attributes and children; string children become text, never HTML. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: readonly (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

/** `n` with `digits` decimals (`toFixed`); NaN and ±Infinity print as `NaN`, `Infinity` and `-Infinity`. */
export function fmt(n: number, digits: number): string {
  return Number.isFinite(n) ? n.toFixed(digits) : String(n);
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/** Local wall-clock time `HH:MM:SS.mmm`, to line log entries up with `adb logcat` and `dumpsys` output. */
function timestamp(d: Date): string {
  return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * Appends a "Copy log" button and an append-only `<pre>` log to `root`. Returns `log(line)`, which appends
 * `HH:MM:SS.mmm line` to the log via `textContent` (never parsed as HTML) and scrolls it to the end.
 */
export function logPanel(root: HTMLElement): (line: string) => void {
  const pre = el('pre', { class: 'lab-log' });
  const copy = el('button', { type: 'button' }, 'Copy log');

  function log(line: string): void {
    pre.textContent += `${timestamp(new Date())} ${line}\n`;
    pre.scrollTop = pre.scrollHeight;
  }

  copy.addEventListener('click', () => {
    const text = pre.textContent;
    navigator.clipboard.writeText(text).then(
      () => log(`log copied (${text.length} characters)`),
      (err: unknown) => log(`copy failed: ${String(err)}`),
    );
  });
  root.append(el('h2', {}, 'Log'), copy, pre);
  return log;
}
