// Downloads the pinned upstream Silero VAD v6 16 kHz ONNX file (plan §4.2.3) into .cache/silero/ if it
// is missing, and verifies its size and SHA-256. On a mismatch the file is deleted and the script exits 1,
// so the next run downloads it again. On success it prints the file's absolute path.
// The ONNX file is never committed (.cache/ is git-ignored).
//
// Usage: pnpm silero:fetch (node scripts/fetch-silero-onnx.ts)

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The pinned upstream file (plan §4.2.3). */
export const SILERO_ONNX = {
  repo: 'snakers4/silero-vad',
  commit: '5cd7945676eb32225748052e2e6a0580e4686a08',
  tag: 'v6.2.3',
  path: 'src/silero_vad/data/silero_vad_16k_op15.onnx',
  bytes: 1_289_603,
  sha256: '7ed98ddbad84ccac4cd0aeb3099049280713df825c610a8ed34543318f1b2c49',
} as const;

export const SILERO_ONNX_URL = `https://raw.githubusercontent.com/${SILERO_ONNX.repo}/${SILERO_ONNX.commit}/${SILERO_ONNX.path}`;

/** The repository root: the parent of scripts/. */
export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Where the verified ONNX file is cached. */
export const SILERO_ONNX_CACHE = join(REPO_ROOT, '.cache', 'silero', 'silero_vad_16k_op15.onnx');

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Returns why `bytes` isn't the pinned file (every mismatch: size and SHA-256), or null if both match.
 */
export function checkSileroOnnx(bytes: Uint8Array): string | null {
  const problems: string[] = [];
  if (bytes.byteLength !== SILERO_ONNX.bytes) {
    problems.push(`size ${bytes.byteLength} bytes, expected ${SILERO_ONNX.bytes}`);
  }
  const hash = sha256Hex(bytes);
  if (hash !== SILERO_ONNX.sha256) problems.push(`SHA-256 ${hash}, expected ${SILERO_ONNX.sha256}`);
  return problems.length === 0 ? null : problems.join('; ');
}

/**
 * Makes sure SILERO_ONNX_CACHE holds the pinned file: downloads it if it's missing, then verifies it.
 * Returns the verified bytes. On a mismatch it deletes the cached file and throws.
 */
export async function ensureSileroOnnx(): Promise<Uint8Array> {
  if (!existsSync(SILERO_ONNX_CACHE)) {
    const res = await fetch(SILERO_ONNX_URL);
    if (!res.ok) throw new Error(`GET ${SILERO_ONNX_URL}: HTTP ${res.status} ${res.statusText}`);
    const body = new Uint8Array(await res.arrayBuffer());
    mkdirSync(dirname(SILERO_ONNX_CACHE), { recursive: true });
    // Write to a temporary name first, so an interrupted run never leaves a partial file at the cache path.
    const tmp = `${SILERO_ONNX_CACHE}.${process.pid}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, SILERO_ONNX_CACHE);
  }
  const bytes = new Uint8Array(readFileSync(SILERO_ONNX_CACHE));
  const problem = checkSileroOnnx(bytes);
  if (problem !== null) {
    rmSync(SILERO_ONNX_CACHE, { force: true });
    throw new Error(
      `${SILERO_ONNX_CACHE}: ${problem}; deleted it, run pnpm silero:fetch again to re-download`,
    );
  }
  return bytes;
}

/** An error's message, plus its cause's (fetch() reports network failures as "fetch failed" with a cause). */
export function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return err.cause instanceof Error ? `${err.message} (${err.cause.message})` : err.message;
}

async function main(): Promise<number> {
  try {
    await ensureSileroOnnx();
  } catch (err) {
    console.error(`silero:fetch: ${errorMessage(err)}`);
    return 1;
  }
  console.log(SILERO_ONNX_CACHE);
  return 0;
}

if (import.meta.main) process.exitCode = await main();
