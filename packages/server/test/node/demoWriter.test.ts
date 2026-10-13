import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  write,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCollisionWorld,
  DEMO_NAME,
  PRINT_ERROR,
  PRINT_INFO,
  validateDemo,
} from "@game/shared";
import { afterEach, describe, expect, it } from "vitest";
import { Match } from "../../src/match/match";
import { runConsoleLine } from "../../src/node/console";
import {
  DEMO_MAX_QUEUED_CHUNKS,
  DEMO_WRITE_BUFFER,
  type DemoWriteFn,
  DemoWriter,
  defaultDemoName,
  type FileDemoSink,
  utcStamp,
} from "../../src/node/demoWriter";
import type { JsonLog } from "../../src/node/log";
import { loadMap, TEST_BUILD } from "../match/fixtures";

// D-044 (M3 design §2.12, file names): the Node demo writer. A name must match
// ^[a-z0-9_-]{1,64}$ (the match refuses others with a PRINT), the path is confined to the demos
// folder, an existing file is never overwritten (a -2, -3 suffix), and the bytes reach the file
// whole and in order through the 64 KiB buffer. sv_autoRecord through the Node server is in
// server.test.ts.

const cmap = loadMap("movement_lab");
const world = buildCollisionWorld(cmap);
const dirs: string[] = [];

/**
 * Whether this account may make a file symlink (D-051): Windows needs a privilege or Developer
 * Mode for one, which an elevated shell (and CI's runner) has and a normal account does not; a
 * directory junction needs neither. POSIX always may.
 */
const canSymlink = (() => {
  const d = mkdtempSync(join(tmpdir(), "demo-writer-probe-"));
  try {
    writeFileSync(join(d, "target"), "");
    symlinkSync(join(d, "target"), join(d, "link"));
    return true;
  } catch (e) {
    if (process.platform === "win32" && (e as NodeJS.ErrnoException).code === "EPERM") return false;
    throw e;
  } finally {
    // Retried: a scanner holding the fresh file must not fail every test of this file (EBUSY).
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})();

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "demo-writer-"));
  dirs.push(d);
  return d;
}

const lines: { ev: string; [k: string]: unknown }[] = [];
const log: JsonLog = (_lvl, ev, fields) => lines.push({ ev, ...fields });

function matchWith(writer: DemoWriter): Match {
  return new Match({ cmap, world, buildHash: TEST_BUILD, primer: false, demos: writer });
}

describe("demo writer (D-044)", () => {
  it("refuses unsafe names with a PRINT and writes a valid one inside demos/", async () => {
    const root = tempDir();
    const demos = join(root, "demos");
    const writer = new DemoWriter(demos, log, "main");
    const match = matchWith(writer);
    for (const name of ["../x", "/abs", "a/b", '""', "x".repeat(65)]) {
      const r = match.runAdminCommand(`record ${name}`);
      expect(r.level, name).toBe(PRINT_ERROR);
      expect(r.text, name).toMatch(/is not a demo name/);
    }
    // The writer checks again, whoever calls it.
    for (const name of ["../x", "/abs", "a/b", "", ".", "x".repeat(65)]) {
      expect(writer.open(name, "movement_lab"), name).toMatch(/is not a demo name/);
    }
    expect(existsSync(demos)).toBe(false);
    expect(match.runAdminCommand("record run_1").text).toBe("recording demos/run_1.demo");
    for (let i = 0; i < 30; i++) match.tick();
    expect(match.runAdminCommand("stoprecord")).toMatchObject({ level: PRINT_INFO });
    await (writer.last as FileDemoSink).done;
    expect(readdirSync(demos)).toEqual(["run_1.demo"]);
    expect(readdirSync(root)).toEqual(["demos"]);
    const bytes = new Uint8Array(readFileSync(join(demos, "run_1.demo")));
    const check = validateDemo(bytes);
    expect(check.ok && check.summary.snapshots).toBe(30);
  });

  it("refuses a Windows device name on every platform, and only those (D-051)", () => {
    const root = tempDir();
    const demos = join(root, "demos");
    const writer = new DemoWriter(demos, log, "main");
    const match = matchWith(writer);
    for (const name of ["con", "prn", "aux", "nul", "com0", "com9", "lpt0", "lpt9"]) {
      expect(writer.open(name, "movement_lab"), name).toBe(
        `"${name}" is a reserved file name (a device on Windows)`,
      );
    }
    expect(match.runAdminCommand("record nul")).toMatchObject({
      level: PRINT_ERROR,
      text: 'record: "nul" is a reserved file name (a device on Windows)',
    });
    expect(existsSync(demos)).toBe(false);
    // A longer or suffixed name is a plain file, and so is a default name.
    const names = ["con_1", "nul-2", "com10", "lpt", "auxx"];
    for (const name of names) {
      const opened = writer.open(name, "movement_lab");
      if (typeof opened === "string") throw new Error(opened);
      opened.sink.close();
    }
    expect(readdirSync(demos).sort()).toEqual(names.map((n) => `${n}.demo`).sort());
  });

  it("records from the stdin console too (as admin of the match)", async () => {
    const root = tempDir();
    const writer = new DemoWriter(join(root, "demos"), log, "main");
    const match = matchWith(writer);
    const replies: string[] = [];
    const consoleLog: JsonLog = (_lvl, ev, fields) => {
      if (ev === "console") replies.push(String(fields?.text));
    };
    const host = { match: () => ({ name: "main", match }) };
    runConsoleLine("record con_1", host, consoleLog);
    for (let i = 0; i < 5; i++) match.tick();
    runConsoleLine("stoprecord", host, consoleLog);
    expect(replies[0]).toBe("recording demos/con_1.demo");
    expect(replies[1]).toMatch(/^stopped recording demos\/con_1\.demo \(5 ticks, \d+ B\)$/);
    await (writer.last as FileDemoSink).done;
    const check = validateDemo(new Uint8Array(readFileSync(join(root, "demos", "con_1.demo"))));
    expect(check.ok && check.summary.snapshots).toBe(5);
  });

  it("never overwrites: an existing name (or a symlink in its place) gets a suffix", () => {
    const root = tempDir();
    const demos = join(root, "demos");
    mkdirSync(demos);
    writeFileSync(join(demos, "keep.demo"), "old");
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "outside");
    // Where this account may not make a file symlink (Windows, unelevated), a plain file stands
    // in for it: the suffix must skip it all the same.
    if (canSymlink) symlinkSync(outside, join(demos, "keep-2.demo"));
    else writeFileSync(join(demos, "keep-2.demo"), "planted");
    const writer = new DemoWriter(demos, log, "main");
    const opened = writer.open("keep", "movement_lab");
    if (typeof opened === "string") throw new Error(opened);
    expect(opened.file).toBe("demos/keep-3.demo");
    opened.sink.close();
    expect(readFileSync(join(demos, "keep.demo"), "utf8")).toBe("old");
    expect(readFileSync(outside, "utf8")).toBe("outside");
    expect(readFileSync(join(demos, "keep-2.demo"), "utf8")).toBe(
      canSymlink ? "outside" : "planted",
    );
  });

  it("confines to the folder's real path and names a default demo <match>-<map>-<utc> (D-047)", () => {
    const root = tempDir();
    const real = join(root, "real");
    mkdirSync(real);
    // A junction on Windows (no privilege needed, and a symlink to Node); POSIX ignores the type.
    symlinkSync(real, join(root, "demos"), "junction");
    const at = new Date(Date.UTC(2026, 9, 11, 7, 5, 9));
    expect(utcStamp(at)).toBe("20261011-070509");
    const writer = new DemoWriter(join(root, "demos"), log, "main", () => at);
    const opened = writer.open(null, "arena_greybox");
    if (typeof opened === "string") throw new Error(opened);
    expect(opened.file).toBe("demos/main-arena_greybox-20261011-070509.demo");
    opened.sink.close();
    expect(readdirSync(real)).toEqual(["main-arena_greybox-20261011-070509.demo"]);
    // Two matches recording in the same second get names of their own.
    const lab = new DemoWriter(join(root, "demos"), log, "lab", () => at).open(
      null,
      "arena_greybox",
    );
    if (typeof lab === "string") throw new Error(lab);
    expect(lab.file).toBe("demos/lab-arena_greybox-20261011-070509.demo");
    lab.sink.close();
  });

  it("cuts the <match>-<map> part of a default name to fit DEMO_NAME, keeping the stamp", () => {
    const stamp = "20261011-070509";
    expect(defaultDemoName("a", "b", stamp)).toBe(`a-b-${stamp}`);
    const long = defaultDemoName("m".repeat(32), "x".repeat(63), stamp);
    expect(long).toHaveLength(64);
    expect(long.endsWith(`-${stamp}`)).toBe(true);
    expect(DEMO_NAME.test(long)).toBe(true);
  });

  it("writes across buffer boundaries in order", async () => {
    const root = tempDir();
    const writer = new DemoWriter(root, log, "main");
    const opened = writer.open("big", "movement_lab");
    if (typeof opened === "string") throw new Error(opened);
    const sink = opened.sink as FileDemoSink;
    const chunk = new Uint8Array(5000);
    const total = DEMO_WRITE_BUFFER * 3 + 123;
    let n = 0;
    while (n < total) {
      const len = Math.min(chunk.length, total - n);
      for (let i = 0; i < len; i++) chunk[i] = (n + i) & 0xff;
      sink.write(chunk, len);
      n += len;
    }
    sink.close();
    await sink.done;
    const back = readFileSync(join(root, "big.demo"));
    expect(back.length).toBe(total);
    let wrong = 0;
    for (let i = 0; i < total; i++) if (back[i] !== (i & 0xff)) wrong++;
    expect(wrong).toBe(0);
    expect(sink.flushed).toBe(total);
    expect(lines.some((l) => l.ev === "demo_stop" && l.bytes === total)).toBe(true);
    // A closed file leaves the writer: a long run keeps no sink (and no buffer) per demo.
    expect(writer.pending.size).toBe(0);
  });

  it("continues short writes until each chunk is on disk", async () => {
    const root = tempDir();
    let calls = 0;
    // A disk that takes at most 777 B a write (fs.write may write less than it was given).
    const short: DemoWriteFn = (fd, buf, off, len, pos, cb) => {
      calls++;
      write(fd, buf, off, Math.min(len, 777), pos, (e, n) => cb(e, n));
    };
    const writer = new DemoWriter(root, log, "main", undefined, short);
    const opened = writer.open("short", "movement_lab");
    if (typeof opened === "string") throw new Error(opened);
    const sink = opened.sink as FileDemoSink;
    const total = DEMO_WRITE_BUFFER + 4321;
    const chunk = new Uint8Array(total);
    for (let i = 0; i < total; i++) chunk[i] = (i * 7) & 0xff;
    sink.write(chunk, total);
    sink.close();
    await sink.done;
    expect(calls).toBe(Math.ceil(DEMO_WRITE_BUFFER / 777) + Math.ceil(4321 / 777));
    expect(sink.error).toBeNull();
    expect(sink.flushed).toBe(total);
    const back = readFileSync(join(root, "short.demo"));
    expect(back.equals(Buffer.from(chunk))).toBe(true);
  });

  it("drops the demo once more than 32 buffers wait for a disk that never answers", async () => {
    const root = tempDir();
    // A hung volume: the write is taken and its callback never runs (an NFS hang, a frozen disk).
    let calls = 0;
    const hung: DemoWriteFn = () => {
      calls++;
    };
    const before = lines.length;
    const writer = new DemoWriter(root, log, "main", undefined, hung);
    const opened = writer.open("hung", "movement_lab");
    if (typeof opened === "string") throw new Error(opened);
    const sink = opened.sink as FileDemoSink;
    const record = new Uint8Array(1000);
    // The first full buffer goes to the disk (on a microtask) and its write never returns.
    for (let i = 0; i < 100; i++) sink.write(record, record.length);
    await new Promise((r) => setImmediate(r));
    expect(calls).toBe(1);
    expect(sink.error).toBeNull();
    // 36 MB in all: about ten minutes of a busy match's demo, far past the cap.
    for (let i = 100; i < 36_000; i++) sink.write(record, record.length);
    expect(sink.error?.message).toMatch(/too slow/);
    expect(sink.queued).toBe(DEMO_MAX_QUEUED_CHUNKS);
    await new Promise((r) => setImmediate(r));
    expect(calls).toBe(1);
    expect(sink.flushed).toBe(0);
    const errors = lines.slice(before).filter((l) => l.ev === "demo_error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ match: "main", msg: expect.stringMatching(/too slow/) });
    // The hung chain never reaches the file's close: the test closes it.
    closeSync((sink as unknown as { fd: number }).fd);
  });

  it("logs a write error once and drops the rest", async () => {
    const root = tempDir();
    // A disk that fails every write (the file itself stays open, so its close still works).
    const failing: DemoWriteFn = (_fd, _buf, _off, _len, _pos, cb) =>
      setImmediate(() => cb(Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" }), 0));
    const before = lines.length;
    const writer = new DemoWriter(root, log, "main", undefined, failing);
    const opened = writer.open("broken", "movement_lab");
    if (typeof opened === "string") throw new Error(opened);
    const sink = opened.sink as FileDemoSink;
    sink.write(new Uint8Array(10), 10);
    sink.close();
    await sink.done;
    expect(sink.error).not.toBeNull();
    expect(sink.flushed).toBe(0);
    expect(lines.slice(before).filter((l) => l.ev === "demo_error")).toHaveLength(1);
  });
});
