import { closeSync, existsSync, mkdirSync, openSync, realpathSync, write } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_NAME } from "@game/shared";
import type { DemoHost, DemoOpened, DemoSink } from "../match/demo";
import type { JsonLog } from "./log";

/** The writer's buffer (design): one file write per 64 KiB of demo. */
export const DEMO_WRITE_BUFFER = 64 * 1024;
/**
 * Most full buffers that may wait for the disk at once (design value, 2 MiB): past it the disk is
 * slower than the recording (or hung, a write that never calls back), and the demo is dropped as
 * on a write error, so a stalled volume can't grow the server's memory without bound.
 */
export const DEMO_MAX_QUEUED_CHUNKS = 32;
/** `-2` … `-999`: suffixes tried for a name whose file exists (never overwritten). */
const MAX_SUFFIX = 999;

/**
 * The repository's `demos/` (git-ignored; D-044): beside the `content/` folder found above this
 * module (the repository root from source and from the bundle), else under `cwd`.
 */
export function defaultDemosDir(cwd: string): string {
  let at = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(at, "content", "maps"))) return join(at, "demos");
    const parent = dirname(at);
    if (parent === at) return resolve(cwd, "demos");
    at = parent;
  }
}

/** `YYYYMMDD-HHMMSS` in UTC: the default demo name's time (it matches DEMO_NAME). */
export function utcStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

/** `fs.write`'s shape: the sink's file writes (a test passes one that writes short). */
export type DemoWriteFn = (
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: null,
  callback: (err: NodeJS.ErrnoException | null, written: number) => void,
) => void;

const EMPTY = Buffer.alloc(0);

/**
 * A demo file being written (D-044): bytes are copied into a 64 KiB buffer, and each full buffer
 * is written to the file asynchronously, in order (a fresh buffer takes its place, so a tick never
 * waits on the disk; a short write is continued until the chunk is on disk). `close` writes the
 * rest and closes the file, keeping no buffer; `done` settles then. A write error is logged once
 * and the rest of the demo is dropped, and so is a buffer that would make more than
 * DEMO_MAX_QUEUED_CHUNKS wait for the disk ("too slow").
 */
export class FileDemoSink implements DemoSink {
  /** Bytes handed to the sink, and those on disk. */
  written = 0;
  flushed = 0;
  /** The first write error, or null. */
  error: Error | null = null;
  /** Full buffers handed to the disk and not yet written (at most DEMO_MAX_QUEUED_CHUNKS). */
  queued = 0;
  /** Settles when the file is closed (after `close`). */
  readonly done: Promise<void>;
  private buf: Buffer = Buffer.allocUnsafe(DEMO_WRITE_BUFFER);
  private used = 0;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private resolveDone: () => void = () => {};

  constructor(
    private readonly fd: number,
    readonly path: string,
    private readonly log: JsonLog,
    private readonly match: string,
    private readonly writeFn: DemoWriteFn = write,
  ) {
    this.done = new Promise((ok) => {
      this.resolveDone = ok;
    });
  }

  write(bytes: Uint8Array, length: number): void {
    if (this.closed || this.error !== null) return;
    let from = 0;
    while (from < length) {
      const n = Math.min(length - from, DEMO_WRITE_BUFFER - this.used);
      const buf = this.buf;
      const at = this.used;
      // A plain copy: a subarray view per record would be garbage every tick.
      for (let i = 0; i < n; i++) buf[at + i] = bytes[from + i] as number;
      this.used = at + n;
      from += n;
      if (this.used === DEMO_WRITE_BUFFER) this.flush();
    }
    this.written += length;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.used > 0) this.flush();
    this.buf = EMPTY;
    this.chain = this.chain.then(() => {
      try {
        closeSync(this.fd);
      } catch (e) {
        this.fail(e);
      }
      this.log("info", "demo_stop", { match: this.match, file: this.path, bytes: this.flushed });
      this.resolveDone();
    });
  }

  private flush(): void {
    const chunk = this.buf;
    const n = this.used;
    // The last flush (from close) needs no buffer after it.
    this.buf = this.closed ? EMPTY : Buffer.allocUnsafe(DEMO_WRITE_BUFFER);
    this.used = 0;
    if (this.queued >= DEMO_MAX_QUEUED_CHUNKS) {
      this.fail(new Error(`the demo disk is too slow: ${this.queued} buffers wait for it`));
      return;
    }
    this.queued++;
    this.chain = this.chain.then(
      () =>
        new Promise<void>((ok) => {
          const from = (at: number): void => {
            if (this.error !== null || at >= n) {
              this.queued--;
              ok();
              return;
            }
            this.writeFn(this.fd, chunk, at, n - at, null, (e, written) => {
              if (e !== null) this.fail(e);
              else if (!(written > 0)) this.fail(new Error("the demo file write wrote nothing"));
              else this.flushed += written;
              from(at + written);
            });
          };
          from(0);
        }),
    );
  }

  private fail(e: unknown): void {
    if (this.error !== null) return;
    this.error = e instanceof Error ? e : new Error(String(e));
    this.log("error", "demo_error", {
      match: this.match,
      file: this.path,
      msg: this.error.message,
    });
  }
}

/** The `-<utc>` part of a default name: `-YYYYMMDD-HHMMSS`. */
const STAMP_PART = 16;
/** The longest DEMO_NAME (`^[a-z0-9_-]{1,64}$`). */
const DEMO_NAME_MAX = 64;

/**
 * A demo's default name (D-044, D-047): `<match>-<map>-<utc>`, so two matches recording in the
 * same second never share a name; the `<match>-<map>` part is cut to fit DEMO_NAME's 64 chars
 * (both are short ids: only an unusually long pair is cut, and the stamp always stays).
 */
export function defaultDemoName(match: string, mapName: string, stamp: string): string {
  return `${`${match}-${mapName}`.slice(0, DEMO_NAME_MAX - STAMP_PART)}-${stamp}`;
}

/**
 * The Node server's demo files (D-044, M3 design §2.12): `record [name]` of one match opens
 * `<demosDir>/<name>.demo`, `<match>-<map>-<utc>.demo` without a name (`defaultDemoName`). A
 * name must be a DEMO_NAME; the path is built with `path.join` and refused unless it resolves
 * inside the demos folder (its real path, so a symlinked folder still confines), and the file is
 * created exclusively (`wx`): an existing file, or a symlink in its place, is never written
 * through; the name then gets a `-2`, `-3`, … suffix. The folder comes from the server's options,
 * never from a command.
 */
export class DemoWriter implements DemoHost {
  /**
   * The files not yet closed on disk (shutdown waits on their `done`); each leaves once its `done`
   * settles, so a long run that records many demos keeps none of them.
   */
  readonly pending = new Set<FileDemoSink>();
  /** The file opened last, or null (tests read it back). */
  last: FileDemoSink | null = null;

  constructor(
    readonly dir: string,
    private readonly log: JsonLog,
    private readonly match: string,
    private readonly clock: () => Date = () => new Date(),
    private readonly writeFn: DemoWriteFn = write,
  ) {}

  open(name: string | null, mapName: string): DemoOpened | string {
    const base = name ?? defaultDemoName(this.match, mapName, utcStamp(this.clock()));
    if (!DEMO_NAME.test(base)) return `"${base}" is not a demo name`;
    let real: string;
    try {
      mkdirSync(this.dir, { recursive: true });
      real = realpathSync(this.dir);
    } catch (e) {
      return `cannot create the demos folder: ${e instanceof Error ? e.message : e}`;
    }
    for (let k = 1; k <= MAX_SUFFIX; k++) {
      const file = k === 1 ? `${base}.demo` : `${base}-${k}.demo`;
      const path = join(real, file);
      if (!resolve(path).startsWith(real + sep)) return `"${base}" leaves the demos folder`;
      let fd: number;
      try {
        fd = openSync(path, "wx");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
        return `cannot create ${file}: ${e instanceof Error ? e.message : e}`;
      }
      const sink = new FileDemoSink(fd, path, this.log, this.match, this.writeFn);
      this.pending.add(sink);
      this.last = sink;
      sink.done.then(() => this.pending.delete(sink));
      this.log("info", "demo_start", { match: this.match, file: path });
      // Replies name the folder, not the server's absolute path.
      return { sink, file: `${basename(this.dir)}/${file}` };
    }
    return `"${base}" and its suffixes up to -${MAX_SUFFIX} exist`;
  }
}
