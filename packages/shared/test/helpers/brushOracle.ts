/**
 * Independent check of the polygonizer (M1 design F.7): intersect every triple of planes, keep
 * the points inside all planes, dedupe. Brute force and fine for the ≤ 20 planes tests use.
 */

/** Brush vertices from planes that are already f32-rounded (as polygonize uses them). */
export function tripleIntersectionVertices(planes: Float64Array, inside = 1e-6): number[][] {
  const n = planes.length / 4;
  const p = (i: number, k: number): number => planes[4 * i + k] as number;
  const out: number[][] = [];
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      for (let c = b + 1; c < n; c++) {
        // Cramer's rule: x = (d_a (n_b × n_c) + d_b (n_c × n_a) + d_c (n_a × n_b)) / det.
        const bc = cross(p(b, 0), p(b, 1), p(b, 2), p(c, 0), p(c, 1), p(c, 2));
        const ca = cross(p(c, 0), p(c, 1), p(c, 2), p(a, 0), p(a, 1), p(a, 2));
        const ab = cross(p(a, 0), p(a, 1), p(a, 2), p(b, 0), p(b, 1), p(b, 2));
        const det = p(a, 0) * bc[0] + p(a, 1) * bc[1] + p(a, 2) * bc[2];
        if (Math.abs(det) < 1e-9) continue;
        const x: number[] = [0, 1, 2].map(
          (k) => (p(a, 3) * (bc[k] ?? 0) + p(b, 3) * (ca[k] ?? 0) + p(c, 3) * (ab[k] ?? 0)) / det,
        );
        let ok = true;
        for (let i = 0; i < n && ok; i++) {
          ok =
            p(i, 0) * (x[0] ?? 0) + p(i, 1) * (x[1] ?? 0) + p(i, 2) * (x[2] ?? 0) - p(i, 3) <=
            inside;
        }
        if (ok && !out.some((v) => maxDiff(v, x) <= 1 / 64)) out.push(x);
      }
    }
  }
  return out;
}

function cross(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): [number, number, number] {
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

export function maxDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return Math.max(
    Math.abs((a[0] ?? 0) - (b[0] ?? 0)),
    Math.abs((a[1] ?? 0) - (b[1] ?? 0)),
    Math.abs((a[2] ?? 0) - (b[2] ?? 0)),
  );
}

export function vertexList(flat: Float64Array): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < flat.length; i += 3) out.push([...flat.subarray(i, i + 3)]);
  return out;
}

/**
 * Null when `actual` and `expected` are the same set within `tol` per component (a one-to-one
 * match), else a description of the first mismatch.
 */
export function vertexSetMismatch(
  actual: number[][],
  expected: number[][],
  tol: number,
): string | null {
  if (actual.length !== expected.length) {
    return `expected ${expected.length} vertices, got ${actual.length}: ${JSON.stringify(actual)}`;
  }
  const used = new Set<number>();
  for (const e of expected) {
    const i = actual.findIndex((a, k) => !used.has(k) && maxDiff(a, e) <= tol);
    if (i < 0)
      return `no vertex within ${tol} of ${JSON.stringify(e)} in ${JSON.stringify(actual)}`;
    used.add(i);
  }
  return null;
}
