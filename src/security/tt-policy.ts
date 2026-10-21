// Must be the first module imported by main.ts: ES imports are hoisted and the policy must exist before any sink call (plan §4.8.3).
// Trusted Types (plan §4.8.3, §7 M7): the `default` policy. Under `require-trusted-types-for 'script'` (HTML only,
// Report-Only in M7, enforced from M8) the browser passes every string that reaches a script-URL sink through it. The
// app hits exactly two such sinks, `new Worker(…)` and `serviceWorker.register(…)`; both take same-origin URLs, which
// pass unchanged. Any other origin throws. There are no HTML sinks: UI code builds DOM with createElement/textContent.
type TT = { createPolicy(name: string, rules: { createScriptURL(u: string): string }): unknown };
function isTT(v: unknown): v is TT {
  return typeof v === 'object' && v !== null && typeof Reflect.get(v, 'createPolicy') === 'function';
}
const tt: unknown = Reflect.get(globalThis, 'trustedTypes');
if (isTT(tt))
  tt.createPolicy('default', {
    createScriptURL(u) {
      const x = new URL(u, location.href);
      if (x.origin !== location.origin) throw new TypeError(`blocked script URL: ${u}`);
      return u;
    },
  });
