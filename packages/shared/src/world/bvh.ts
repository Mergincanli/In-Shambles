/**
 * Static bounding volume hierarchy over brush bounds (M1 design C), built when a world loads and
 * never stored in map files. Traces walk it in trace.ts; it only decides which brushes get
 * clipped, so it changes speed and never results (ties go to the lower brush index).
 */

/** Deepest node level below the root (0); nodes there become leaves whatever their size. */
export const BVH_MAX_DEPTH = 48;

/** Traversal stack entries: one per level on the current path, so 48 levels always fit. */
export const BVH_STACK_SIZE = 64;

/** SAH bins along the split axis. */
export const BVH_BINS = 16;

/** Nodes with this many brushes or fewer become leaves without trying a split. */
export const BVH_LEAF_SIZE = 2;

/**
 * Depth-first node arrays: node i's left child is i + 1 and its right child nodeFirst[i]. An empty
 * world has no nodes. Fields are assigned in declaration order so every BVH has one shape.
 */
export class Bvh {
  /** 6 per node: minx, miny, minz, maxx, maxy, maxz of the brushes below it. */
  readonly nodeBounds: Float64Array;
  /** Right child index (internal node) or index of the first leafRefs entry (leaf). */
  readonly nodeFirst: Int32Array;
  /** 0 for internal nodes, else the leaf's brush count. */
  readonly nodeCount: Int32Array;
  /** Split axis (0 = x, 1 = y, 2 = z) of internal nodes, so traversal can visit the near child first. */
  readonly nodeAxis: Uint8Array;
  /** Brush indices, ascending within each leaf; every brush appears in exactly one leaf. */
  readonly leafRefs: Uint32Array;
  /**
   * The traversal stack. One per world keeps traces allocation-free, which makes every query on a
   * world synchronous and non-reentrant: nothing may start a query while another one runs.
   */
  readonly stack: Int32Array;

  constructor(nodes: number, refs: number) {
    this.nodeBounds = new Float64Array(6 * nodes);
    this.nodeFirst = new Int32Array(nodes);
    this.nodeCount = new Int32Array(nodes);
    this.nodeAxis = new Uint8Array(nodes);
    this.leafRefs = new Uint32Array(refs);
    this.stack = new Int32Array(BVH_STACK_SIZE);
  }
}

/** Build state. Load time only: allocations are fine here, nondeterminism is not. */
class BvhBuilder {
  readonly bounds: Float64Array;
  /** 3 per brush: bounds centers. */
  readonly centroid: Float64Array;
  /** Brush indices, partitioned in place so every node owns one contiguous range. */
  readonly refs: Uint32Array;
  readonly scratch: Uint32Array;
  /** SAH bin of each brush in the node being split. */
  readonly binOf: Uint8Array;
  readonly nodeBounds: Float64Array;
  readonly nodeFirst: Int32Array;
  readonly nodeCount: Int32Array;
  readonly nodeAxis: Uint8Array;
  nodes = 0;
  readonly binCount = new Int32Array(BVH_BINS);
  readonly binBounds = new Float64Array(6 * BVH_BINS);
  /** Area and brush count of bins i … BVH_BINS − 1 together. */
  readonly rightArea = new Float64Array(BVH_BINS);
  readonly rightCount = new Int32Array(BVH_BINS);
  readonly box = new Float64Array(6);

  constructor(bounds: Float64Array, brushCount: number) {
    const maxNodes = brushCount > 0 ? 2 * brushCount - 1 : 0;
    this.bounds = bounds;
    this.centroid = new Float64Array(3 * brushCount);
    this.refs = new Uint32Array(brushCount);
    this.scratch = new Uint32Array(brushCount);
    this.binOf = new Uint8Array(brushCount);
    this.nodeBounds = new Float64Array(6 * maxNodes);
    this.nodeFirst = new Int32Array(maxNodes);
    this.nodeCount = new Int32Array(maxNodes);
    this.nodeAxis = new Uint8Array(maxNodes);
    for (let b = 0; b < brushCount; b++) {
      this.refs[b] = b;
      for (let k = 0; k < 3; k++) {
        const lo = bounds[6 * b + k] as number;
        const hi = bounds[6 * b + k + 3] as number;
        this.centroid[3 * b + k] = (lo + hi) * 0.5;
      }
    }
  }
}

function setEmpty(box: Float64Array, o: number): void {
  for (let k = 0; k < 3; k++) {
    box[o + k] = Number.POSITIVE_INFINITY;
    box[o + k + 3] = Number.NEGATIVE_INFINITY;
  }
}

/** Grows box[o…o+5] to cover src[s…s+5]. */
function grow(box: Float64Array, o: number, src: Float64Array, s: number): void {
  for (let k = 0; k < 3; k++) {
    const lo = src[s + k] as number;
    const hi = src[s + k + 3] as number;
    if (lo < (box[o + k] as number)) box[o + k] = lo;
    if (hi > (box[o + k + 3] as number)) box[o + k + 3] = hi;
  }
}

/** Surface area, 0 for an empty box (the SAH cost weight). */
function area(box: Float64Array, o: number): number {
  const dx = (box[o + 3] as number) - (box[o] as number);
  const dy = (box[o + 4] as number) - (box[o + 1] as number);
  const dz = (box[o + 5] as number) - (box[o + 2] as number);
  if (!(dx >= 0 && dy >= 0 && dz >= 0)) return 0;
  return 2 * (dx * dy + dy * dz + dz * dx);
}

/**
 * Binned SAH split of refs[start, end) along `axis` (cmin, extent: the centroid range there).
 * Returns the index where the right child starts, `start` to make a leaf because no split beats
 * it, or −1 when every brush landed in one bin.
 */
function sahSplit(
  bld: BvhBuilder,
  start: number,
  end: number,
  axis: number,
  cmin: number,
  extent: number,
  nodeArea: number,
): number {
  const { refs, centroid, bounds, binOf, binCount, binBounds, rightArea, rightCount, box } = bld;
  binCount.fill(0);
  for (let i = 0; i < BVH_BINS; i++) setEmpty(binBounds, 6 * i);
  for (let i = start; i < end; i++) {
    const b = refs[i] as number;
    const bin = Math.min(
      BVH_BINS - 1,
      Math.floor((((centroid[3 * b + axis] as number) - cmin) / extent) * BVH_BINS),
    );
    binOf[b] = bin;
    binCount[bin] = (binCount[bin] as number) + 1;
    grow(binBounds, 6 * bin, bounds, 6 * b);
  }
  setEmpty(box, 0);
  let count = 0;
  for (let i = BVH_BINS - 1; i > 0; i--) {
    grow(box, 0, binBounds, 6 * i);
    count += binCount[i] as number;
    rightArea[i] = area(box, 0);
    rightCount[i] = count;
  }
  setEmpty(box, 0);
  count = 0;
  let best = -1;
  let bestCost = 0;
  for (let i = 0; i < BVH_BINS - 1; i++) {
    grow(box, 0, binBounds, 6 * i);
    count += binCount[i] as number;
    const right = rightCount[i + 1] as number;
    if (count === 0 || right === 0) continue;
    const cost = area(box, 0) * count + (rightArea[i + 1] as number) * right;
    // Strict <: on equal costs the lowest split wins.
    if (best < 0 || cost < bestCost) {
      best = i;
      bestCost = cost;
    }
  }
  if (best < 0) return -1;
  // Leaf cost is n per unit of the node's area; a split must be strictly cheaper.
  if (!(bestCost < (end - start) * nodeArea)) return start;
  // Stable partition: both children keep the brushes' current relative order.
  const scratch = bld.scratch;
  let n = start;
  for (let i = start; i < end; i++) {
    const b = refs[i] as number;
    if ((binOf[b] as number) <= best) scratch[n++] = b;
  }
  const split = n;
  for (let i = start; i < end; i++) {
    const b = refs[i] as number;
    if ((binOf[b] as number) > best) scratch[n++] = b;
  }
  refs.set(scratch.subarray(start, end), start);
  return split;
}

/** Sorts refs[start, end) by (centroid on `axis`, brush index), a total order, and halves it. */
function medianSplit(bld: BvhBuilder, start: number, end: number, axis: number): number {
  const { refs, centroid } = bld;
  const sorted = Array.from(refs.subarray(start, end)).sort((a, b) => {
    const ca = centroid[3 * a + axis] as number;
    const cb = centroid[3 * b + axis] as number;
    return ca < cb ? -1 : ca > cb ? 1 : a - b;
  });
  refs.set(sorted, start);
  return start + ((end - start) >> 1);
}

function buildNode(bld: BvhBuilder, start: number, end: number, depth: number): void {
  const node = bld.nodes++;
  const nb = bld.nodeBounds;
  const o = 6 * node;
  const box = bld.box;
  setEmpty(nb, o);
  setEmpty(box, 0);
  for (let i = start; i < end; i++) {
    const b = bld.refs[i] as number;
    grow(nb, o, bld.bounds, 6 * b);
    for (let k = 0; k < 3; k++) {
      const c = bld.centroid[3 * b + k] as number;
      if (c < (box[k] as number)) box[k] = c;
      if (c > (box[k + 3] as number)) box[k + 3] = c;
    }
  }
  const n = end - start;
  let split = start;
  let axis = 0;
  if (n > BVH_LEAF_SIZE && depth < BVH_MAX_DEPTH) {
    // Longest centroid axis; strict > breaks ties toward x, then y.
    let extent = (box[3] as number) - (box[0] as number);
    for (let k = 1; k < 3; k++) {
      const e = (box[k + 3] as number) - (box[k] as number);
      if (e > extent) {
        extent = e;
        axis = k;
      }
    }
    split =
      extent > 0 ? sahSplit(bld, start, end, axis, box[axis] as number, extent, area(nb, o)) : -1;
    // Coincident centroids, or all in one bin: halve by a total order instead.
    if (split < 0) split = medianSplit(bld, start, end, axis);
  }
  if (split === start) {
    bld.refs.subarray(start, end).sort();
    bld.nodeFirst[node] = start;
    bld.nodeCount[node] = n;
    bld.nodeAxis[node] = 0;
    return;
  }
  bld.nodeCount[node] = 0;
  bld.nodeAxis[node] = axis;
  buildNode(bld, start, split, depth + 1);
  bld.nodeFirst[node] = bld.nodes;
  buildNode(bld, split, end, depth + 1);
}

/**
 * Builds the BVH over `brushCount` brush bounds (6 per brush). Deterministic: binned SAH along the
 * longest centroid axis, leaves of at most BVH_LEAF_SIZE brushes unless no split is cheaper, a
 * median fallback and a depth cap, with every choice made by exact compares and total orders.
 * Traversal culls brushes by these bounds, so each brush's bounds must be its axial planes (as
 * buildBrush emits them and createCollisionWorld checks); otherwise a brush could report hits
 * outside them that the BVH skips.
 */
export function buildBvh(bounds: Float64Array, brushCount: number): Bvh {
  const bld = new BvhBuilder(bounds, brushCount);
  if (brushCount > 0) buildNode(bld, 0, brushCount, 0);
  const bvh = new Bvh(bld.nodes, brushCount);
  bvh.nodeBounds.set(bld.nodeBounds.subarray(0, 6 * bld.nodes));
  bvh.nodeFirst.set(bld.nodeFirst.subarray(0, bld.nodes));
  bvh.nodeCount.set(bld.nodeCount.subarray(0, bld.nodes));
  bvh.nodeAxis.set(bld.nodeAxis.subarray(0, bld.nodes));
  bvh.leafRefs.set(bld.refs);
  return bvh;
}
