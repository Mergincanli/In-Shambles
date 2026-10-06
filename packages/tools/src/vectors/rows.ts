import type { CollisionBrushSource } from "@game/shared";

/**
 * Row encoding shared by the vectors generators (D-016): f64 as the 16 hex digits of its IEEE-754
 * bits, u32 as 8 hex digits, small integers in decimal, fields separated by one space.
 */

const view = new DataView(new ArrayBuffer(8));

export function f64Hex(x: number): string {
  view.setFloat64(0, x);
  return view.getBigUint64(0).toString(16).padStart(16, "0");
}

export function u32Hex(x: number): string {
  return (x >>> 0).toString(16).padStart(8, "0");
}

/**
 * One brush as contents, faceCount, planeCount (decimal), bounds (6 f64), planes (nx ny nz d per
 * plane, f64), surface flags per plane (u32): the TRACE_WORLD / PMOVE_WORLD row.
 */
export function brushRow(b: CollisionBrushSource): string {
  const planeCount = b.planes.length / 4;
  const surf = b.surfaceFlags ?? [];
  return [
    u32Hex(b.contents),
    b.faceCount,
    planeCount,
    ...Array.from(b.bounds, f64Hex),
    ...Array.from(b.planes, f64Hex),
    ...Array.from({ length: planeCount }, (_, p) => u32Hex(surf[p] ?? 0)),
  ].join(" ");
}

/** `export const name = [rows];` with a doc comment, as plain JavaScript. */
export function section(name: string, doc: string, rows: string[]): string {
  return [
    `/** ${doc} */`,
    `export const ${name} = [`,
    ...rows.map((r) => `  "${r}",`),
    "];",
    "",
  ].join("\n");
}
