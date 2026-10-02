// The installer screenshots that the web app manifest lists (plan §4.7, issue #97):
// public/screenshots/phone-1.webp, phone-2.webp (form_factor narrow) and desktop-1.webp (wide). Each one is the
// app's own BearView drawing one pose through the e2e hook `__bearTest.showPose(name, { cssWidth, cssHeight })`
// (#81) at the screenshot's real size and DPR 1, encoded in the page with `canvas.toBlob(…, 'image/webp', 0.9)`.
// No image tooling runs in Node. The screenshots are not precached.
//
// The script builds the e2e bundle (`pnpm build:e2e`), serves it with `pnpm preview:e2e` on port 4173, which must
// be free, captures the three poses and stops the server. Then it checks every file: a RIFF/WEBP header, and the
// size Chromium decodes with createImageBitmap must be exactly the target size. `--check` runs only that check,
// on the files already in public/screenshots/. It needs a Playwright Chromium (PLAYWRIGHT_BROWSERS_PATH, or
// `pnpm exec playwright install --no-shell chromium`) and is never part of CI. See docs/icons.md.
//
// Usage: node scripts/gen-screenshots.ts [--check]

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromium, type Browser } from '@playwright/test';

import type { PoseName } from '../src/anim/poses.ts';

const ORIGIN = 'http://localhost:4173';
const REPO_ROOT = join(import.meta.dirname, '..');
export const OUT_DIR = join(REPO_ROOT, 'public/screenshots');
/** `canvas.toBlob` quality of the WebP encoder (issue #97). */
const WEBP_QUALITY = 0.9;
/** How long `pnpm preview:e2e` may take to answer. */
const SERVER_TIMEOUT_MS = 30_000;
/** How long the server may take to stop after SIGTERM, and after the SIGKILL fallback. */
const STOP_TIMEOUT_MS = 5_000;
const KILL_TIMEOUT_MS = 1_000;
const POLL_MS = 200;

export interface Shot {
  file: string;
  pose: PoseName;
  width: number;
  height: number;
}

/** The manifest's screenshots (plan §4.7), at their real size in CSS px at DPR 1. */
export const SHOTS: readonly Shot[] = [
  { file: 'phone-1.webp', pose: 'listening', width: 1080, height: 1920 },
  { file: 'phone-2.webp', pose: 'talkOpen', width: 1080, height: 1920 },
  { file: 'desktop-1.webp', pose: 'neutral', width: 1920, height: 1080 },
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pnpm(args: string[]): void {
  const res = spawnSync('pnpm', args, { cwd: REPO_ROOT, stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed`);
}

/** Whether anything answers HTTP on the preview port. */
async function answers(): Promise<boolean> {
  try {
    const res = await fetch(ORIGIN, { signal: AbortSignal.timeout(1000) });
    await res.arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

/** Polls until nothing answers on the preview port; false if it still answers after `ms`. */
async function portFreed(ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (await answers()) {
    if (Date.now() > deadline) return false;
    await sleep(POLL_MS);
  }
  return true;
}

/** Sends `signal` to the child's process group; a group that is already gone is fine. */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (e) {
    if (!(e instanceof Error && 'code' in e && e.code === 'ESRCH')) throw e;
  }
}

/** `pnpm preview:e2e` in a process group of its own (detached), so stopping it reaches everything it started. */
function startPreview(): ChildProcess {
  return spawn('pnpm', ['preview:e2e'], { cwd: REPO_ROOT, detached: true, stdio: 'inherit' });
}

async function waitForServer(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + SERVER_TIMEOUT_MS;
  while (!(await answers())) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('pnpm preview:e2e exited before it served anything');
    }
    if (Date.now() > deadline) throw new Error(`pnpm preview:e2e didn't answer on ${ORIGIN} in time`);
    await sleep(POLL_MS);
  }
}

async function stopPreview(child: ChildProcess): Promise<void> {
  // pnpm runs `vite preview` in yet another process group (see playwright.config.ts), so a SIGKILL of pnpm's group
  // would orphan vite. SIGTERM goes first: pnpm forwards it.
  killGroup(child, 'SIGTERM');
  if (await portFreed(STOP_TIMEOUT_MS)) return;
  killGroup(child, 'SIGKILL');
  if (!(await portFreed(KILL_TIMEOUT_MS))) throw new Error('preview server still answering on 4173');
}

/** One screenshot: the pose drawn once by the app's BearView at the shot's size, as WebP bytes. */
async function capture(browser: Browser, shot: Shot): Promise<Buffer> {
  const context = await browser.newContext({
    viewport: { width: shot.width, height: shot.height },
    deviceScaleFactor: 1,
  });
  try {
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);
    await page.waitForFunction(
      () =>
        typeof Reflect.get(Object(Reflect.get(window, '__bearTest')), 'showPose') === 'function' &&
        document.querySelector('canvas.stage') !== null,
    );
    // showPose stops the frame loop and draws the pose once; toBlob encodes the bitmap as it is when called. Both
    // run in this one task, so nothing can draw in between and no page clock is needed.
    const bytes = await page.evaluate(
      async ({ pose, width, height, quality }) => {
        const hooks: unknown = Reflect.get(window, '__bearTest');
        const showPose: unknown = Reflect.get(Object(hooks), 'showPose');
        if (typeof showPose !== 'function') throw new Error('window.__bearTest.showPose is missing');
        Reflect.apply(showPose, hooks, [pose, { cssWidth: width, cssHeight: height }]);
        const canvas = document.querySelector('canvas.stage');
        if (!(canvas instanceof HTMLCanvasElement)) throw new Error('canvas.stage is missing');
        if (canvas.width !== width || canvas.height !== height) {
          throw new Error(`canvas is ${canvas.width}×${canvas.height}, expected ${width}×${height}`);
        }
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/webp', quality),
        );
        // Chromium falls back to PNG for a type it can't encode.
        if (blob?.type !== 'image/webp')
          throw new Error(`toBlob gave ${blob?.type ?? 'no blob'}, not image/webp`);
        return Array.from(new Uint8Array(await blob.arrayBuffer()));
      },
      { pose: shot.pose, width: shot.width, height: shot.height, quality: WEBP_QUALITY },
    );
    return Buffer.from(bytes);
  } finally {
    await context.close();
  }
}

/**
 * Issue #97 Validation 2: every file in public/screenshots/ is a WebP that Chromium decodes to exactly its shot's
 * size. Returns the problems found.
 */
async function check(browser: Browser): Promise<string[]> {
  const errors: string[] = [];
  const page = await browser.newPage();
  try {
    for (const shot of SHOTS) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(join(OUT_DIR, shot.file));
      } catch {
        errors.push(`${shot.file}: missing`);
        continue;
      }
      if (bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WEBP') {
        errors.push(`${shot.file}: not a RIFF/WEBP file`);
        continue;
      }
      const size = await page.evaluate(async (data) => {
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(data)], { type: 'image/webp' }));
        const decoded = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
        return decoded;
      }, Array.from(bytes));
      if (size.width !== shot.width || size.height !== shot.height) {
        errors.push(`${shot.file}: ${size.width}×${size.height}, expected ${shot.width}×${shot.height}`);
        continue;
      }
      console.log(
        `public/screenshots/${shot.file}: ${size.width}×${size.height} WebP, ${bytes.length} bytes OK`,
      );
    }
  } finally {
    await page.close();
  }
  return errors;
}

async function generate(): Promise<void> {
  pnpm(['build:e2e']);
  const server = startPreview();
  const onSignal = (signal: NodeJS.Signals): void => {
    killGroup(server, 'SIGTERM');
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  let browser: Browser | undefined;
  try {
    await waitForServer(server);
    browser = await chromium.launch({ channel: 'chromium' });
    mkdirSync(OUT_DIR, { recursive: true });
    for (const shot of SHOTS) {
      writeFileSync(join(OUT_DIR, shot.file), await capture(browser, shot));
      console.log(`wrote public/screenshots/${shot.file} (${shot.pose}, ${shot.width}×${shot.height})`);
    }
  } finally {
    await browser?.close();
    await stopPreview(server);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

export async function main(args: string[]): Promise<number> {
  if (!args.includes('--check')) {
    if (await answers()) {
      console.error(
        `gen-screenshots: ${ORIGIN} already answers; stop that server first (this script serves its own build)`,
      );
      return 1;
    }
    await generate();
  }
  const browser = await chromium.launch({ channel: 'chromium' });
  let errors: string[];
  try {
    errors = await check(browser);
  } finally {
    await browser.close();
  }
  for (const e of errors) console.error(`gen-screenshots: ${e}`);
  return errors.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
