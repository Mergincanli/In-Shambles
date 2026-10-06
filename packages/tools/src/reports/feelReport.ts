import {
  BUTTON_CROUCH,
  BUTTON_JUMP,
  BUTTON_WALK,
  degreesToU16,
  HULL_STANDING_MAXS,
  PlayerState,
  PmoveParams,
  TICK_DT,
  TRACE_EPSILON,
} from "@game/shared";
import { HoldInput, HopForward, idle, PhasedInput, StrafeHop } from "../scenarios/bots";
import {
  anchorYawU16,
  type CourseAnchor,
  courseAnchor,
  type LoadedCourse,
  loadCourse,
} from "../scenarios/course";
import {
  airtime,
  apex,
  horizontalSpeed,
  jumps,
  landingSpeeds,
  lands,
  maxHorizontalSpeed,
  settledIndex,
} from "../scenarios/metrics";
import {
  type CmdSource,
  placeAtAnchor,
  placePlayer,
  type ScenarioRecord,
  ScenarioRunner,
} from "../scenarios/runner";

/**
 * The feel report (docs/03 §1 and §8, M2 design §5, D-024): the base movement metrics measured
 * on the committed movement_lab with the default parameters, next to their targets, for
 * `pnpm feel-report` and the /feel-check workflow. Every number comes from scripted scenario
 * runs (D-025), so the report is the same on every machine and every run: no clock, no dates.
 * The MV tests assert the targets; the report shows where each one sits.
 */

export interface FeelRow {
  readonly section: string;
  readonly metric: string;
  readonly measured: string;
  readonly target: string;
  /** Whether the measurement meets the target; null for report-only rows. */
  readonly ok: boolean | null;
}

export interface FeelReport {
  readonly course: string;
  readonly contentHash: string;
  readonly rows: readonly FeelRow[];
}

/** Every metric the report prints, in order (the report test checks each is present). */
export const FEEL_METRICS = [
  "Run cap",
  "Time to run cap",
  "Walk cap",
  "Crouch cap",
  "Stop time from 320",
  "Stop distance from 320",
  "Jump apex at 60 Hz",
  "Jump apex at 120 Hz",
  "Jump airtime",
  "Step limit",
  "Stairs time",
  "Slope 0.69",
  "Slope 0.71",
  "Slope 0.80",
  "Straight-hop max",
  "Strafe curve",
  "Swim speed",
  "Sink speed",
  "Ladder speed",
  "Runway 2048 u time",
] as const;

export type FeelMetric = (typeof FEEL_METRICS)[number];

/** Default parameters: the targets below are the docs/03 values for them. */
const P = new PmoveParams();
const RUN_CAP = P.runSpeed; // FACT-Q3 (docs/03 §2.1)
const APEX = (P.jumpVelocity * P.jumpVelocity) / (2 * P.gravity); // docs/03 §4.6
const AIRTIME = (2 * P.jumpVelocity) / P.gravity;
const NORTH = degreesToU16(90);
/** The timed runway's trigger faces (movement_lab.ts): entering both times 2048 u. */
const RUNWAY_START_X = -1024;
const RUNWAY_STOP_X = 1024;

function f(x: number, digits = 2): string {
  return x.toFixed(digits);
}

function within(x: number, target: number, tolerance: number): boolean {
  return Math.abs(x - target) <= tolerance;
}

function vz(r: ScenarioRecord, i: number): number {
  return r.velocity[3 * i + 2] as number;
}

class Measure {
  readonly rows: FeelRow[] = [];
  private readonly runner: ScenarioRunner;

  constructor(
    readonly course: LoadedCourse,
    /** What the runs simulate with; the targets stay the defaults' (P). */
    readonly params: PmoveParams,
  ) {
    this.runner = new ScenarioRunner(course.world, params);
  }

  anchor(name: string): CourseAnchor {
    return courseAnchor(this.course, name);
  }

  row(section: string, metric: FeelMetric, measured: string, target: string, ok: boolean | null) {
    this.rows.push({ section, metric, measured, target, ok });
  }

  runFrom(anchor: CourseAnchor, bot: CmdSource, ticks: number, runner = this.runner) {
    return runner.run(placeAtAnchor(new PlayerState(), anchor), bot, ticks);
  }

  speeds(): void {
    const start = this.anchor("runway_start");
    const yaw = anchorYawU16(start);
    const run = this.runFrom(start, new HoldInput(yaw), 120);
    const settled = settledIndex(run, RUN_CAP, 0.5);
    const cap = horizontalSpeed(run, run.ticksRun);
    this.row(
      "Speeds",
      "Run cap",
      `${f(cap)} u/s`,
      `${RUN_CAP} ± 0.5 u/s`,
      within(cap, RUN_CAP, 0.5),
    );
    const t = settled * run.dt;
    this.row(
      "Speeds",
      "Time to run cap",
      settled < 0 ? "never" : `${f(t, 3)} s`,
      "≤ 0.6 s",
      settled >= 0 && t <= 0.6,
    );
    const walkCap = RUN_CAP * P.walkScale;
    const walk = this.runFrom(start, new HoldInput(yaw, { buttons: BUTTON_WALK }), 120);
    const w = horizontalSpeed(walk, walk.ticksRun);
    this.row("Speeds", "Walk cap", `${f(w)} u/s`, `${walkCap} ± 1 u/s`, within(w, walkCap, 1));
    const crouchCap = RUN_CAP * P.duckScale;
    const crouch = this.runFrom(start, new HoldInput(yaw, { buttons: BUTTON_CROUCH }), 120);
    const c = horizontalSpeed(crouch, crouch.ticksRun);
    this.row(
      "Speeds",
      "Crouch cap",
      `${f(c)} u/s`,
      `${crouchCap} ± 1 u/s`,
      within(c, crouchCap, 1),
    );

    // Run for 1 s to the cap, then let go.
    const RUN_UP = 60;
    const stop = this.runFrom(
      start,
      new PhasedInput([{ ticks: RUN_UP, forward: 127, yaw }, { ticks: 1 }]),
      RUN_UP + 120,
    );
    let stopped = -1;
    for (let i = RUN_UP; i < stop.count && stopped < 0; i++) {
      if (horizontalSpeed(stop, i) === 0) stopped = i;
    }
    const stopTicks = stopped - RUN_UP;
    this.row(
      "Speeds",
      "Stop time from 320",
      stopped < 0 ? "never" : `${f(stopTicks * stop.dt, 3)} s (${stopTicks} ticks)`,
      "report only",
      null,
    );
    this.row(
      "Speeds",
      "Stop distance from 320",
      stopped < 0 ? "never" : `${f(stop.x(stopped) - stop.x(RUN_UP))} u`,
      "report only",
      null,
    );
  }

  jump(): void {
    const start = this.anchor("runway_start");
    const yaw = anchorYawU16(start);
    const arc = (dt: number) => {
      const runner = new ScenarioRunner(this.course.world, this.params, dt);
      const bot = new PhasedInput([{ ticks: 1, buttons: BUTTON_JUMP, yaw }, { ticks: 1 }]);
      const r = this.runFrom(start, bot, Math.round(1 / dt), runner);
      const j = jumps(r)[0];
      const l = lands(r)[0];
      return { height: apex(r).height, air: j && l ? airtime(r, j, l) : Number.NaN };
    };
    const a60 = arc(TICK_DT);
    const a120 = arc(1 / 120);
    this.row(
      "Jump",
      "Jump apex at 60 Hz",
      `${f(a60.height, 3)} u`,
      `${f(APEX)} ± 0.5 u`,
      within(a60.height, APEX, 0.5),
    );
    this.row(
      "Jump",
      "Jump apex at 120 Hz",
      `${f(a120.height, 3)} u (${f(a120.height - a60.height, 3)} from 60 Hz)`,
      `${f(APEX)} ± 0.5 u, within 0.5 u of 60 Hz`,
      within(a120.height, APEX, 0.5) && within(a120.height, a60.height, 0.5),
    );
    this.row(
      "Jump",
      "Jump airtime",
      `${f(a60.air, 3)} s`,
      `${f(AIRTIME, 3)} s ± 1 tick`,
      within(a60.air, AIRTIME, TICK_DT + 1e-9),
    );
  }

  geometry(): void {
    // Steps: forward from each base, letting go on the top (as MV-05).
    const climbed: string[] = [];
    let limit = 0;
    let ok = true;
    for (const h of [16, 18, 19]) {
      const base = this.anchor(`step_${h}_base`);
      const top = this.anchor(`step_${h}_top`);
      const bot = new HoldInput(anchorYawU16(base), { release: { axis: 1, at: top.origin[1] } });
      const r = this.runFrom(base, bot, 90);
      const up = r.z(r.ticksRun) >= top.origin[2];
      climbed.push(`${h} u ${up ? "climbs" : "blocks"}`);
      if (up) limit = Math.max(limit, h);
      ok &&= up === h <= P.stepSize;
    }
    this.row(
      "Geometry",
      "Step limit",
      `${limit} u (${climbed.join(", ")})`,
      `${P.stepSize} u: 16 and 18 climb, 19 blocks`,
      ok,
    );

    const stairsBase = this.anchor("stairs_base");
    const stairsTop = this.anchor("stairs_top");
    const stairs = this.runFrom(
      stairsBase,
      new HoldInput(anchorYawU16(stairsBase), { release: { axis: 1, at: stairsTop.origin[1] } }),
      180,
    );
    let topTick = -1;
    for (let i = 1; i < stairs.count && topTick < 0; i++) {
      if (stairs.grounded(i) && stairs.z(i) >= stairsTop.origin[2]) topTick = i;
    }
    this.row(
      "Geometry",
      "Stairs time",
      topTick < 0 ? "never reached the top" : `${f(topTick * stairs.dt, 3)} s to the 128 u landing`,
      "report only (8 × 16 u)",
      null,
    );

    for (const [tag, metric, walkable] of [
      ["069", "Slope 0.69", false],
      ["071", "Slope 0.71", true],
      ["080", "Slope 0.80", true],
    ] as const) {
      const base = this.anchor(`slope_${tag}_base`);
      const top = this.anchor(`slope_${tag}_top`);
      // Landed (feet one ε up, as after any fall; MV-06): a spawn with the feet exactly on the
      // floor stops dead at a steep toe's bevel without touching the slope (D-023), which says
      // nothing about how the slope feels.
      const ps = placeAtAnchor(new PlayerState(), base);
      ps.origin[2] += TRACE_EPSILON;
      const r = this.runner.run(
        ps,
        new HoldInput(anchorYawU16(base), { release: { axis: 1, at: top.origin[1] } }),
        240,
      );
      let maxZ = r.z(0);
      for (let i = 1; i < r.count; i++) maxZ = Math.max(maxZ, r.z(i));
      const end = r.ticksRun;
      const reached = r.grounded(end) && r.z(end) >= top.origin[2];
      const rise = top.origin[2] - base.origin[2];
      this.row(
        "Geometry",
        metric,
        reached
          ? `reaches the crest platform (${f(rise)} u up)`
          : `stays below the top: at most ${f(maxZ - base.origin[2])} of ${f(rise)} u, ${lands(r).length} landings at the toe in 4 s`,
        walkable ? "walkable" : "not walkable: slides back, never reaches the top",
        reached === walkable,
      );
    }
  }

  hops(): void {
    const start = this.anchor("open_sw");
    const yaw = anchorYawU16(start);
    const straight = this.runFrom(start, new HopForward(yaw, { runUpTicks: 60, hops: 20 }), 960);
    const max = maxHorizontalSpeed(straight);
    const cap = RUN_CAP * 1.02;
    this.row(
      "Hops",
      "Straight-hop max",
      `${f(max)} u/s over ${jumps(straight).length} hops`,
      `≤ ${f(cap, 1)} u/s (cap + 2%)`,
      max <= cap,
    );
    const strafeBot = new StrafeHop(yaw, this.params, TICK_DT, { runUpTicks: 60, hops: 10 });
    const strafe = this.runFrom(start, strafeBot, 60 + 10 * 45);
    const curve = landingSpeeds(strafe);
    let gains = curve.length === 10;
    for (let i = 1; i < curve.length; i++)
      gains &&= (curve[i] as number) > (curve[i - 1] as number);
    this.row(
      "Hops",
      "Strafe curve",
      `${curve.map((s) => f(s, 0)).join(" → ")} u/s at each landing`,
      "gains on every one of 10 hops",
      gains,
    );
  }

  waterAndLadder(): void {
    const deep = this.anchor("water_deep");
    const mid = (yaw: number) =>
      placePlayer(
        new PlayerState(),
        [deep.origin[0], deep.origin[1], deep.origin[2] + 64],
        yaw,
        false,
      );
    const swimCap = RUN_CAP * P.swimScale;
    const swim = this.runner.run(mid(NORTH), new HoldInput(NORTH), 75);
    const s = horizontalSpeed(swim, swim.ticksRun);
    this.row(
      "Water and ladder",
      "Swim speed",
      `${f(s)} u/s`,
      `${swimCap} ± 1 u/s`,
      within(s, swimCap, 1),
    );
    const sink = this.runner.run(mid(0), idle(), 60);
    const sv = 0 - vz(sink, sink.ticksRun);
    this.row(
      "Water and ladder",
      "Sink speed",
      `${f(sv)} u/s`,
      `${P.waterSinkSpeed} ± 1 u/s`,
      within(sv, P.waterSinkSpeed, 1),
    );
    const ladderCap = RUN_CAP * P.ladderScale;
    const climb = this.runFrom(this.anchor("ladder_base"), new HoldInput(NORTH), 60);
    const lv = vz(climb, climb.ticksRun);
    this.row(
      "Water and ladder",
      "Ladder speed",
      `${f(lv)} u/s`,
      `${ladderCap} ± 1 u/s`,
      within(lv, ladderCap, 1),
    );
  }

  runway(): void {
    const start = this.anchor("runway_start");
    const r = this.runFrom(start, new HoldInput(anchorYawU16(start)), 600);
    const front = HULL_STANDING_MAXS[0] as number;
    // When the hull's front crosses x, in ticks, interpolated within the tick that crossed it.
    const crossing = (x: number): number => {
      for (let i = 1; i < r.count; i++) {
        const a = r.x(i - 1) + front;
        const b = r.x(i) + front;
        if (a < x && b >= x) return i - 1 + (x - a) / (b - a);
      }
      return Number.NaN;
    };
    const enter = crossing(RUNWAY_START_X);
    const ticks = crossing(RUNWAY_STOP_X) - enter;
    const length = RUNWAY_STOP_X - RUNWAY_START_X;
    const ideal = length / RUN_CAP;
    // The end-of-tick snap to the 1/32 u grid (D-017) moves the origin up to 1/64 u per tick off
    // the velocity's step, so the time may drift by that much per tick from the ideal.
    const snapDrift = (1 / 64 / r.dt) * (ideal / RUN_CAP);
    // Displacement and velocity over one second inside the runway, at the cap.
    const a = Math.ceil(enter) + 60;
    const b = a + 60;
    const moved = (r.x(b) - r.x(a)) / ((b - a) * r.dt);
    const t = ticks * r.dt;
    this.row(
      "Runway",
      "Runway 2048 u time",
      Number.isNaN(ticks)
        ? "did not finish"
        : `${f(t, 3)} s (${f(length / t)} u/s average); at the cap the origin moves ${f(moved, 3)} u/s at a velocity of ${f(horizontalSpeed(r, b), 3)} (1/32 u snap, D-017)`,
      `${f(ideal, 3)} ± ${f(snapDrift, 3)} s at the run cap, start trigger to stop trigger`,
      !Number.isNaN(ticks) && within(t, ideal, snapDrift),
    );
  }
}

/**
 * Measures every FEEL_METRICS row on the committed movement_lab. `params` (default: the defaults)
 * is what the runs simulate with, for trying a tuning against the docs/03 targets.
 */
export function measureFeel(params: PmoveParams = P): FeelReport {
  const course = loadCourse("movement_lab");
  const m = new Measure(course, params);
  m.speeds();
  m.jump();
  m.geometry();
  m.hops();
  m.waterAndLadder();
  m.runway();
  return { course: course.name, contentHash: course.cmap.contentHash, rows: m.rows };
}

function cell(s: string): string {
  return s.replaceAll("|", "\\|");
}

/** The report as Markdown: a header naming the course and the table. No timestamps. */
export function formatFeelReport(report: FeelReport): string {
  const lines = [
    "# Feel report",
    "",
    `Base movement metrics on \`${report.course}\` (content hash \`${report.contentHash}\`) with the default \`pm_*\` cvars, measured by scripted runs at 60 Hz (\`docs/03\` §8, D-024, D-025). Written by \`pnpm feel-report\`; the MV tests assert the targets.`,
    "",
    "| Section | Metric | Measured | Target | OK |",
    "|---|---|---|---|---|",
  ];
  for (const r of report.rows) {
    const ok = r.ok === null ? "–" : r.ok ? "yes" : "NO";
    lines.push(
      `| ${cell(r.section)} | ${cell(r.metric)} | ${cell(r.measured)} | ${cell(r.target)} | ${ok} |`,
    );
  }
  const failed = report.rows.filter((r) => r.ok === false).length;
  const checked = report.rows.filter((r) => r.ok !== null).length;
  lines.push("", `${checked - failed} of ${checked} checked metrics meet their target.`, "");
  return lines.join("\n");
}
