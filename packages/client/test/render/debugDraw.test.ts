import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildCollisionWorld,
  decodeCmap,
  HULL_MINS,
  HULL_STANDING_MAXS,
  MASK_PLAYERSOLID,
  PmoveParams,
  PmoveTraceLog,
  TraceResult,
  traceBox,
  vec3,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import { DebugDraw, DebugLines, SegmentBuffer } from "../../src/render/debug/debugDraw";
import { METERS_PER_UNIT } from "../../src/render/space";

describe("debug draw (M2 design §2)", () => {
  it("draws the hull's 12 edges, each along one axis", () => {
    const d = new DebugLines();
    d.beginShapes();
    d.hull(vec3(100, 0, 24), HULL_MINS, HULL_STANDING_MAXS);
    expect(d.shapes.count).toBe(12);
    const p = d.shapes.positions;
    const lengths: number[] = [];
    for (let i = 0; i < 12; i++) {
      const o = i * 6;
      const delta = [0, 1, 2].map((k) => Math.abs((p[o + 3 + k] as number) - (p[o + k] as number)));
      expect(delta.filter((x) => x > 0)).toHaveLength(1);
      lengths.push(Math.max(...delta));
    }
    expect(lengths.sort((a, b) => a - b)).toEqual([30, 30, 30, 30, 30, 30, 30, 30, 56, 56, 56, 56]);
    for (let i = 0; i < 72; i += 3) {
      expect(p[i]).toBeGreaterThanOrEqual(85);
      expect(p[i + 2]).toBeLessThanOrEqual(56);
    }
  });

  it("colours clear traces green and hits red with a normal tick, and keeps them on an empty log", () => {
    const log = new PmoveTraceLog();
    const tr = new TraceResult();
    tr.fraction = 1;
    tr.endpos.set([10, 0, 0]);
    log.record(vec3(), vec3(10, 0, 0), vec3(), vec3(), tr);
    tr.fraction = 0.5;
    tr.endpos.set([0, 5, 0]);
    tr.normal.set([0, -1, 0]);
    log.record(vec3(), vec3(0, 10, 0), vec3(), vec3(), tr);
    const d = new DebugLines();
    d.takeTraces(log);
    expect(d.traces.count).toBe(3);
    const c = d.traces.colors;
    expect((c[1] as number) > (c[0] as number)).toBe(true);
    expect((c[6] as number) > (c[7] as number)).toBe(true);
    expect(Array.from(d.traces.positions.subarray(12, 18))).toEqual([0, 5, 0, 0, -3, 0]);
    log.clear();
    d.takeTraces(log);
    expect(d.traces.count).toBe(3);
  });

  it("draws the ground normal: yellow when walkable, magenta when steeper than pm_minWalkNormal", () => {
    const mapUrl = new URL("../../../../content/maps/movement_lab.cmap", import.meta.url);
    const cmap = decodeCmap(new Uint8Array(readFileSync(fileURLToPath(mapUrl))));
    const world = buildCollisionWorld(cmap);
    const base = cmap.entities.find((e) => e.props.targetname === "stairs_base")?.origin;
    if (base === undefined) throw new Error("movement_lab has no stairs_base");
    // Stand the hull on the floor there.
    const tr = new TraceResult();
    const top = vec3(base[0] as number, base[1] as number, (base[2] as number) + 64);
    const down = vec3(base[0] as number, base[1] as number, (base[2] as number) - 64);
    traceBox(world, top, down, HULL_MINS, HULL_STANDING_MAXS, MASK_PLAYERSOLID, tr);
    expect([tr.fraction < 1, tr.normal[2]]).toEqual([true, 1]);
    const origin = vec3(tr.endpos[0] as number, tr.endpos[1] as number, tr.endpos[2] as number);
    const params = new PmoveParams();
    const d = new DebugLines();
    const colour = () => Array.from(d.shapes.colors.subarray(0, 3));
    d.beginShapes();
    params.minWalkNormal = 0.7;
    d.ground(world, origin, HULL_MINS, HULL_STANDING_MAXS, params);
    expect(d.shapes.count).toBe(1);
    const p = d.shapes.positions;
    // From the feet, 32 u up the flat floor's normal.
    expect((p[2] as number) - (origin[2] as number)).toBeCloseTo(HULL_MINS[2] as number, 6);
    expect((p[5] as number) - (p[2] as number)).toBeCloseTo(32, 6);
    expect(colour()[2]).toBeCloseTo(0.1, 6);
    // The same floor counts as steep for a walk limit above its normal.
    d.beginShapes();
    params.minWalkNormal = 1.01;
    d.ground(world, origin, HULL_MINS, HULL_STANDING_MAXS, params);
    expect(colour()).toEqual([1, Math.fround(0.2), 1]);
    // Drawn under another origin (the interpolated one), traced from this one.
    d.beginShapes();
    d.ground(world, origin, HULL_MINS, HULL_STANDING_MAXS, params, vec3(0, 0, 1000));
    expect(Array.from(p.subarray(0, 3))).toEqual([0, 0, 1000 + (HULL_MINS[2] as number)]);
    // In the air: nothing.
    d.beginShapes();
    d.ground(world, top, HULL_MINS, HULL_STANDING_MAXS, params);
    expect(d.shapes.count).toBe(0);
  });

  it("draws the shapes after the traces when both are on", () => {
    const log = new PmoveTraceLog();
    const tr = new TraceResult();
    tr.fraction = 1;
    tr.endpos.set([10, 0, 0]);
    log.record(vec3(), vec3(10, 0, 0), vec3(), vec3(), tr);
    const d = new DebugLines();
    d.takeTraces(log);
    d.beginShapes();
    d.hull(vec3(0, 100, 0), HULL_MINS, HULL_STANDING_MAXS);
    const draw = new DebugDraw();
    draw.update(d, true);
    expect(draw.object.geometry.drawRange.count).toBe((1 + 12) * 2);
    const pos = draw.object.geometry.getAttribute("position");
    // Vertex 0 is the trace's start; vertex 2 (index traces.count * 6 floats) the first edge's.
    expect(pos.getX(1)).toBeCloseTo(10 * METERS_PER_UNIT, 6);
    expect(pos.getZ(2)).toBeCloseTo(-(d.shapes.positions[1] as number) * METERS_PER_UNIT, 6);
    expect(pos.getX(2)).toBeCloseTo((d.shapes.positions[0] as number) * METERS_PER_UNIT, 6);
    const col = draw.object.geometry.getAttribute("color");
    expect(col.getX(2)).toBeCloseTo(0.95, 6);
    draw.update(d, false);
    expect(draw.object.geometry.drawRange.count).toBe(12 * 2);
    draw.dispose();
  });

  it("drops segments past capacity", () => {
    const b = new SegmentBuffer(1);
    b.push(vec3(), vec3(1, 0, 0), 1, 1, 1);
    b.push(vec3(), vec3(2, 0, 0), 1, 1, 1);
    expect(b.count).toBe(1);
  });

  it("converts the segments through space.ts into one draw range, hidden when empty", () => {
    const draw = new DebugDraw();
    const d = new DebugLines();
    draw.update(d, true);
    expect(draw.object.visible).toBe(false);
    d.beginShapes();
    d.hull(vec3(0, 100, 0), HULL_MINS, HULL_STANDING_MAXS);
    draw.update(d, false);
    expect(draw.object.visible).toBe(true);
    expect(draw.object.geometry.drawRange.count).toBe(24);
    const pos = draw.object.geometry.getAttribute("position");
    // sim (x, y, z) u → three (x, z, −y) m.
    expect(pos.getX(0)).toBeCloseTo((d.shapes.positions[0] as number) * METERS_PER_UNIT, 6);
    expect(pos.getZ(0)).toBeCloseTo(-(d.shapes.positions[1] as number) * METERS_PER_UNIT, 6);
    expect(pos.getY(0)).toBeCloseTo((d.shapes.positions[2] as number) * METERS_PER_UNIT, 6);
    draw.dispose();
  });
});
