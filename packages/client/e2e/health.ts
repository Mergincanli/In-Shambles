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
 * Which slack the rule allows besides long frames. `webSocket`: the page talks to a Node server
 * through the browser's network process, which a busy host can stall both ways at once (D-028),
 * so starves right after a link gap are excused. The Worker server's MessageChannel has no such
 * process: its cases stay strict.
 */
export interface Link {
  readonly webSocket: boolean;
}

/**
 * The prediction stayed healthy from `a` to `b` (NET-03 in a browser): no misprediction, ever,
 * i.e. no correction on a snapshot the server simulated with our own cmd. The rest is judged
 * against frame timing: the page counts the frames longer than the input buffer (`longFrames`,
 * 33 ms; the rest of the lead covers the round trip) and the hard resyncs in them (`lateResyncs`).
 * Such a gap sends cmds late, so the server repeats one (a starved cmd) and the client is either
 * corrected on that starved snapshot (`starvedCorrections`) or, past the lead, hard-resynced: by
 * design on `lan` until the clock has grown the lead for such gaps (D-028). So every resync must
 * be a late one (bar the one a slow start may need), and in a window with no long frame every
 * starved cmd and starved correction must be one the page counted right after a link gap
 * (`starvedAfterGap`, `starvedCorrectionsAfterGap`: a gap in the snapshot stream past the input
 * buffer that ended in a burst with none lost, i.e. a stalled link, and the gap's length plus the
 * round trip and twice the buffer after it), and only over a WebSocket. A stall of the server
 * alone does not starve (D-027; `pnpm test:long` holds the real Node server to that). A host too
 * slow to tell (more than MAX_LONG_SHARE of its frames long) is a failure that says so, not a
 * random pass or fail; the fps, the window's largest snapshot gap and the page's last starve
 * (`lastStarve`: the lead, the clock's low edge and mean, the frame and snapshot gaps) and the
 * last hard resyncs (`resyncLog`: frame and snapshot gaps, predicted and server ticks) go into
 * every message.
 */
export function expectHealthy(a: Sample, b: Sample, link: Link): void {
  const fps = fpsBetween(a, b);
  const frames = grew(a, b, "frames");
  const long = grew(a, b, "longFrames");
  const detail = JSON.stringify({
    fps: Math.round(fps),
    linkGaps: grew(a, b, "linkGaps"),
    // The per-report maxima of both ends, and the overall peak: the window's largest gap is one of
    // them unless it fell in a report between the two samples (then the peak shows it if it grew).
    snapGapMs: [
      a.s.maxSnapGapMs,
      b.s.maxSnapGapMs,
      `peak ${a.s.peakSnapGapMs}→${b.s.peakSnapGapMs}`,
    ],
    lastLinkGap: b.s.lastLinkGap,
    lastStarve: b.s.lastStarve,
    // The last hard resyncs with their frame and server-tick timing (the M2 loaded-run carry-over).
    resyncLog: b.s.resyncLog,
    from: a.s,
    to: b.s,
  });
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
  if (long > 0) return;
  const excused = (key: string) => (link.webSocket ? grew(a, b, key) : 0);
  const why = link.webSocket ? "no long frame or link gap" : "no long frame";
  expect(
    grew(a, b, "starved") - excused("starvedAfterGap"),
    `starved cmds, ${why}: ${detail}`,
  ).toBe(0);
  expect(
    grew(a, b, "starvedCorrections") - excused("starvedCorrectionsAfterGap"),
    `starved corrections, ${why}: ${detail}`,
  ).toBe(0);
}

/** Waits until the circle bot leaves its 1.5 s idle start (any starvation of the start is over). */
export async function waitForMoving(page: Page): Promise<void> {
  const moving = () => Number(document.documentElement.dataset.distance) > 0;
  await page.waitForFunction(moving, undefined, { timeout: 15_000, polling: 50 });
}
