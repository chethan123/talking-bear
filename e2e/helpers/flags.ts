import * as fs from 'node:fs';
import * as path from 'node:path';

// Chromium fake-media flags (plan §4.9.3). `launchOptions` is worker-scoped, so each WAV needs its own
// spec file with a file-level `test.use({ launchOptions: { args: micFlags(...) } })`.
// Never add `--auto-accept-camera-and-microphone-capture`: combined with `--use-fake-ui-for-media-stream`
// it crashes the browser.
function fakeMicFlags(wavRelPath: string, fakeUiFlag: string): string[] {
  const wav = path.resolve(wavRelPath);
  // A missing or unreadable WAV gives silent input with no error, so a typo must fail here, loudly.
  if (!fs.existsSync(wav)) {
    throw new Error(`fake mic WAV not found: ${wavRelPath} (resolved to ${wav})`);
  }
  // `%noloop`: play the file once. After EOF the fake device repeats its last buffer, hence the
  // fixtures' zero tails.
  return [
    '--use-fake-device-for-media-stream',
    fakeUiFlag,
    `--use-file-for-fake-audio-capture=${wav}%noloop`,
  ];
}

/** Fake mic playing `wavRelPath` (relative to the working directory) once; the mic prompt is auto-accepted. */
export function micFlags(wavRelPath: string): string[] {
  return fakeMicFlags(wavRelPath, '--use-fake-ui-for-media-stream');
}

/** Same fake mic, but the mic prompt is auto-denied (the MicDenied path). */
export function denyFlags(wavRelPath: string): string[] {
  return fakeMicFlags(wavRelPath, '--use-fake-ui-for-media-stream=deny');
}
