import { readFileSync } from "node:fs";
import { type DemoCheck, type DemoVisitor, validateDemo } from "@game/shared";

/**
 * Demo validation (D-044, M3 design §1 "src/replay/validateDemo.ts"): the checker itself lives in
 * `@game/shared` (net/demo.ts), because playback in the client runs it too and the client cannot
 * depend on the tools; this module is the tools' entry to it, plus reading a file from disk.
 */
export { type DemoCheck, type DemoVisitor, validateDemo };

/** A demo file read and checked: its bytes and the check, or why it could not be read. */
export type DemoFile =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly check: DemoCheck }
  | { readonly ok: false; readonly error: string };

/** Reads the file at `path` (not yet checked), or why it can't; never throws. */
export function readDemoFile(
  path: string,
):
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly error: string } {
  try {
    return { ok: true, bytes: new Uint8Array(readFileSync(path)) };
  } catch (e) {
    return { ok: false, error: `cannot read ${path}: ${e instanceof Error ? e.message : e}` };
  }
}

/** Reads `path` and runs `validateDemo` on it (with `visitor`); never throws. */
export function validateDemoFile(path: string, visitor: DemoVisitor | null = null): DemoFile {
  const read = readDemoFile(path);
  if (!read.ok) return read;
  return {
    ok: true,
    bytes: read.bytes,
    check: validateDemo(read.bytes, read.bytes.length, visitor),
  };
}
