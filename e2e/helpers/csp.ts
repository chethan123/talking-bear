import { expect, type Page } from '@playwright/test';

/** One `securitypolicyviolation` event, as recorded by `installCspRecorder`. */
export interface CspViolation {
  disposition: 'enforce' | 'report';
  effectiveDirective: string;
  blockedURI: string;
  sourceFile: string;
  lineNumber: number;
}

declare global {
  interface Window {
    /** Set by `installCspRecorder`'s init script on every document it runs in. */
    __cspViolations?: CspViolation[];
  }
}

/**
 * Records every CSP violation of every document the page loads from now on. Call it before
 * `page.goto()`. Init scripts are injected over CDP, so the page's own CSP doesn't block them.
 */
export async function installCspRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const violations: CspViolation[] = [];
    window.__cspViolations = violations;
    // The event bubbles from the element or document to the window; capture sees all of them.
    window.addEventListener(
      'securitypolicyviolation',
      (e) => {
        violations.push({
          disposition: e.disposition,
          effectiveDirective: e.effectiveDirective,
          blockedURI: e.blockedURI,
          sourceFile: e.sourceFile,
          lineNumber: e.lineNumber,
        });
      },
      true,
    );
  });
}

async function recordedViolations(page: Page): Promise<CspViolation[]> {
  const recorded = await page.evaluate(() => window.__cspViolations ?? null);
  if (recorded === null) {
    // Without the recorder there is nothing to assert on: fail loudly instead of passing vacuously.
    throw new Error('CSP recorder not installed: call installCspRecorder(page) before page.goto()');
  }
  return recorded;
}

/**
 * Asserts that the current document recorded no `enforce`-mode CSP violation; prints them if it did.
 * Throws unless `installCspRecorder(page)` ran before the navigation.
 */
export async function expectNoEnforcedViolations(page: Page): Promise<void> {
  const enforced = (await recordedViolations(page)).filter((v) => v.disposition === 'enforce');
  expect(enforced, `enforced CSP violations:\n${JSON.stringify(enforced, null, 2)}`).toEqual([]);
}

/**
 * The current document's `report`-mode (Report-Only) CSP violations (used from M7).
 * Throws unless `installCspRecorder(page)` ran before the navigation.
 */
export async function getReportOnlyViolations(page: Page): Promise<CspViolation[]> {
  return (await recordedViolations(page)).filter((v) => v.disposition === 'report');
}
