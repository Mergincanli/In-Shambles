import type { Page } from "playwright";
import { expect } from "vitest";
import { readStatus } from "../scripts/browser";

// The e2e prediction-health rule (M2 design §5, D-028), shared by the Worker smoke test and the
// dedicated-server connect test (D-031): judged against the frame timing the page reports.

/**
 * The viewport of the cases that check the prediction. SwiftShader's frame rate falls with the
 * pixel count: about 57 fps here at 320x180, 30 at 640x360 and 18–20 at 960x540, where the clock
 * starves and hard-resyncs while it learns the frame rhythm (D-028's adaptive input buffer) and a
 * correction comes down to timing luck.
 */
export const VIEW = { width: 320, height: 180 } as const;
/**
 * Above this share of frames longer than the input buffer, the host cannot keep its frames
 * inside the prediction's slack and a resync says little either way: fail plainly. Half, the
 * share where the mean frame reaches the buffer (about 30 fps); mispredictions are told apart
 * from starved snapshots by the server's flag, so only the resync check leans on it. This is the
 * only host gate: each frame is judged by its own gap, so a slow host with most frames on time
 * (27 fps and 41 % long on a GitHub runner) still gives a meaningful check; a separate fps floor
 * failed that run with the prediction healthy.
 */
export const MAX_LONG_SHARE = 0.5;
/** The status as read (its `statusAt` says when the page wrote it). */
export interface Sample {
  readonly s: Record<string, string>;
}

export async function sample(page: Page): Promise<Sample> {
  return { s: await readStatus(page) };
}

/** How much a status counter grew from `a` to `b`. */
export function grew(a: Sample, b: Sample, key: string): number {
  return Number(b.s[key]) - Number(a.s[key]);
}

/**
 * Frames per second between two samples, by the page clock each report was written at
 * (`statusAt`): the reports come every 250 ms, so the test's own read times would be off by up to
 * that much.
 */
export function fpsBetween(a: Sample, b: Sample): number {
  return (grew(a, b, "frames") * 1000) / grew(a, b, "statusAt");
}

/**
 * The prediction stayed healthy from `a` to `b` (NET-03 in a browser): no misprediction, ever,
 * i.e. no correction on a snapshot the server simulated with our own cmd. The rest is judged
 * against frame timing: the page counts the frames longer than the input buffer (`longFrames`,
 * 33 ms; the rest of the lead covers the round trip) and the hard resyncs in them (`lateResyncs`).
 * Such a gap sends cmds late, so the server repeats one (a starved cmd) and the client is either
 * corrected on that starved snapshot (`starvedCorrections`) or, past the lead, hard-resynced: by
 * design on `lan` until the clock has grown the lead for such gaps (D-028). So every resync must
 * be a late one (bar the one a slow start may need), and starved cmds and their corrections need
 * a long frame in between. A host too slow to tell (more than MAX_LONG_SHARE of its frames long)
 * is a failure that says so, not a random pass or fail; the fps goes into every message.
 */
export function expectHealthy(a: Sample, b: Sample): void {
  const fps = fpsBetween(a, b);
  const frames = grew(a, b, "frames");
  const long = grew(a, b, "longFrames");
  const detail = JSON.stringify({ fps: Math.round(fps), from: a.s, to: b.s });
  expect(
    long,
    `host too slow for the e2e checks (${long} of ${frames} frames over the input buffer): ${detail}`,
  ).toBeLessThanOrEqual(frames * MAX_LONG_SHARE);
  const mispredicted = Number(b.s.corrections) - Number(b.s.starvedCorrections);
  expect(mispredicted, `corrections on on-time snapshots: ${detail}`).toBe(0);
  const onTime = (x: Sample) => Number(x.s.hardResyncs) - Number(x.s.lateResyncs);
  expect(onTime(a), `hard resyncs in on-time frames at the start: ${detail}`).toBeLessThanOrEqual(
    1,
  );
  expect(onTime(b) - onTime(a), `hard resyncs in on-time frames: ${detail}`).toBe(0);
  if (long === 0) {
    expect(grew(a, b, "starved"), `starved cmds, no long frame: ${detail}`).toBe(0);
    expect(grew(a, b, "starvedCorrections"), `starved corrections, no long frame: ${detail}`).toBe(
      0,
    );
  }
}

/** Waits until the circle bot leaves its 1.5 s idle start (any starvation of the start is over). */
export async function waitForMoving(page: Page): Promise<void> {
  const moving = () => Number(document.documentElement.dataset.distance) > 0;
  await page.waitForFunction(moving, undefined, { timeout: 15_000, polling: 50 });
}
