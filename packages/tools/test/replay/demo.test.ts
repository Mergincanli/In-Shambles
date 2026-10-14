import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemoRecorder, MemoryDemoSink, WorldHistory } from "@game/server";
import { CvarBlock, FRAME_SLOTS, frameDigest, MAX_SPECTATOR_SNAPSHOT_BYTES } from "@game/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDemoInfo } from "../../src/replay/demoInfo";
import { setHarnessPrimerDefault } from "../net/multiHarness";
import { expectExactReplay, recordBotMatch, replay } from "./demoReplay";
import { demoInfoFixture, worstRng, worstSlot } from "./fixture";

// D-044 (M3 design §5 "Demo"): a recording replays exactly. A 4-bot harness match on
// arena_greybox is recorded into a memory sink while a fifth player joins; DemoPlayer then plays
// the file and every frame's spectator digest equals the server's world frame of that tick, and
// the joiner's JOIN sits in the EVENTS of its join tick (2 s here; the 60 s leg is in the long
// tier, D-032). A 64-player recording with every field changing every tick keeps every record
// within 2048 B and replays exactly too.

setHarnessPrimerDefault(false);

describe("demo record and replay (D-044)", () => {
  it("replays 2 s of a 4-bot match exactly, with a joiner's JOIN on its join tick", () => {
    // The fast smoke of the 60 s leg in packages/tools/long/demo-replay.long.ts.
    expectExactReplay(recordBotMatch(1000, 2000));
  });

  it("keeps a 64-player worst-motion recording within 2048 B a record and replays it exactly", () => {
    const history = new WorldHistory();
    const rec = new DemoRecorder();
    const sink = new MemoryDemoSink();
    rec.start(sink, "64", { name: "arena_greybox", hashLo: 0, hashHi: 0 }, "x");
    const rng = worstRng(64);
    const digests = new Map<number, number>();
    for (let t = 1; t <= 130; t++) {
      const f = history.frameFor(t);
      f.clear();
      for (let s = 0; s < FRAME_SLOTS; s++) worstSlot(f, s, t, rng);
      history.stored(t);
      digests.set(t, frameDigest(f, -1));
      rec.beginTick(t, new CvarBlock(), 0);
      rec.writeSnapshot(t, history, 0);
    }
    rec.stop();
    expect(rec.failed).toBe(0);
    expect(rec.snapshotBytesMax).toBeLessThanOrEqual(MAX_SPECTATOR_SNAPSHOT_BYTES);
    // Worst motion, so far past a live snapshot's 1100 B: only demo files carry these.
    expect(rec.snapshotBytesMax).toBeGreaterThan(1800);
    expect(replay(sink.bytes())).toEqual(digests);
  });
});

// `pnpm demo-info <file> [--json]` (D-044, M3 design §2.12) on a recorded fixture: the text and
// JSON goldens, and the reason with exit 1 for a corrupt or missing file. The fixture is recorded
// by the server's recorder from a scripted world (fixture.ts), so only the format moves it.

let dir = "";
let file = "";
let corrupt = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "demo-info-"));
  const bytes = demoInfoFixture().bytes;
  file = join(dir, "fixture.demo");
  writeFileSync(file, bytes);
  const bad = bytes.slice(0, bytes.length - 100);
  corrupt = join(dir, "cut.demo");
  writeFileSync(corrupt, bad);
});

afterAll(() => {
  // Retried: on Windows a virus scanner may still hold a file just written (EBUSY, EPERM).
  if (dir !== "") rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function run(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runDemoInfo(argv, { out: (t) => out.push(t), err: (t) => err.push(t), cwd: dir });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("pnpm demo-info (D-044)", () => {
  it("prints the header, duration, records, keyframes, sizes, players and cvar changes", () => {
    const r = run("fixture.demo");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      [
        "demo fixture.demo",
        "format: demo version 1, protocol 4, 60 Hz",
        "map: arena_greybox (990efb80e478cd6c)",
        "build: fixture-build",
        "start tick: 61",
        "duration: 1300 ticks (21.67 s)",
        "records: 1300 SNAPSHOT, 24 EVENTS, 2 CVARS, 1 END",
        "keyframes: 3",
        "snapshot bytes: mean 30.7, max 90",
        "players seen: 4",
        "  #0 team 1, ticks 61-1360",
        "  #1 team 2, ticks 61-1360",
        "  #2 team 1, ticks 200-899",
        "  #2 team 2, ticks 1001-1199",
        "cvar changes: 2",
        "  tick 650 (effective 650): pm_gravity 800 -> 700",
        "  tick 1100 (effective 1100): sv_cheats 0 -> null",
        "size: 49552 B",
      ].join("\n"),
    );
  });

  it("prints the same as one JSON object with --json", () => {
    const r = run(file, "--json");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      header: {
        demoVersion: 1,
        protocol: 4,
        tickRate: 60,
        map: "arena_greybox",
        mapHash: "990efb80e478cd6c",
        buildHash: "fixture-build",
        startTick: 61,
      },
      duration: { ticks: 1300, seconds: 21.667 },
      records: { snapshot: 1300, events: 24, cvars: 2, end: 1 },
      keyframes: 3,
      snapshotBytes: { mean: 30.7, max: 90 },
      players: [
        { id: 0, team: 1, firstTick: 61, lastTick: 1360 },
        { id: 1, team: 2, firstTick: 61, lastTick: 1360 },
        { id: 2, team: 1, firstTick: 200, lastTick: 899 },
        { id: 2, team: 2, firstTick: 1001, lastTick: 1199 },
      ],
      cvarChanges: [
        { tick: 650, effectiveTick: 650, changes: [{ name: "pm_gravity", from: 800, to: 700 }] },
        { tick: 1100, effectiveTick: 1100, changes: [{ name: "sv_cheats", from: 0, to: null }] },
      ],
      bytes: 49552,
    });
    expect(r.out.includes("\n")).toBe(false);
  });

  it("exits 1 with the reason for a corrupt or missing file, or bad arguments", () => {
    const cut = run("cut.demo");
    expect(cut.code).toBe(1);
    expect(cut.out).toBe("");
    expect(cut.err).toMatch(/^demo-info: cut\.demo is not a valid demo: .*cut short/);
    const missing = run("nope.demo");
    expect(missing.code).toBe(1);
    expect(missing.err).toMatch(/^demo-info: cannot read .*nope\.demo/);
    expect(run().code).toBe(1);
    expect(run("a", "b").err).toBe("usage: pnpm demo-info <file.demo> [--json]");
    expect(run("--frobnicate", "x").code).toBe(1);
    expect(run("--help")).toMatchObject({
      code: 0,
      out: "usage: pnpm demo-info <file.demo> [--json]",
    });
  });
});
