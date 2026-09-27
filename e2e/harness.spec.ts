import * as fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { expectNoEnforcedViolations, installCspRecorder } from './helpers/csp';

// server/headers.json is the single source of the response headers vite preview serves (plan §4.8.3).
function expectedCsp(): string {
  const parsed: unknown = JSON.parse(
    fs.readFileSync(new URL('../server/headers.json', import.meta.url), 'utf8'),
  );
  const common = typeof parsed === 'object' && parsed !== null && 'common' in parsed ? parsed.common : null;
  const csp =
    typeof common === 'object' && common !== null && 'Content-Security-Policy' in common
      ? common['Content-Security-Policy']
      : null;
  if (typeof csp !== 'string') {
    throw new Error('server/headers.json: common["Content-Security-Policy"] must be a string');
  }
  return csp;
}

test('vite preview serves the production CSP and the page loads without enforced violations', async ({
  page,
}) => {
  const csp = expectedCsp();
  await installCspRecorder(page);
  const res = await page.goto('/');
  if (res === null) throw new Error("page.goto('/') returned no response");
  expect(res.headers()['content-security-policy']).toBe(csp);
  await expect(page).toHaveTitle('Talking Bear');
  await expectNoEnforcedViolations(page);
});
