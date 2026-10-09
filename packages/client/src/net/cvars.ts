import { CvarFlag, type CvarRegistry } from "@game/shared";

/**
 * The client-side net settings (docs/06 §7, M2 design §4): ARCHIVE cvars, saved per player and
 * never replicated, so they shape only this client's clock and smoothing, never the simulation.
 * The remote players' interpolation reads the last three (D-037). The rest of the client cvars
 * (sensitivity, field of view, view smoothing, HUD toggles) register with the console.
 */
export const CLIENT_NET_CVARS = Object.freeze([
  Object.freeze({
    name: "cl_inputBuffer",
    type: "int" as const,
    default: 2, // ESTIMATE (docs/05 §8.2: target 1–2 ticks)
    min: 0,
    max: 30,
    description: "Input buffer the clock keeps at the health's low point, in ticks",
  }),
  Object.freeze({
    name: "cl_correctionSmoothMs",
    type: "float" as const,
    default: 100, // ESTIMATE (docs/05 §5: "~100 ms")
    min: 0,
    max: 1000,
    description: "Time a correction's render offset takes to decay, ms",
  }),
  Object.freeze({
    name: "cl_teleportDist",
    type: "float" as const,
    default: 64, // design value (docs/05 §5)
    min: 0,
    max: 16384,
    description: "A correction farther than this snaps instead of smoothing, u",
  }),
  Object.freeze({
    name: "cl_interpDelay",
    type: "int" as const,
    default: 0, // design value (D-037: 0 sizes it from the snapshot stream)
    min: 0,
    max: 6,
    description: "Remote players' interpolation delay, ticks: 0 auto, else 2–6 (1 counts as 2)",
  }),
  Object.freeze({
    name: "cl_remoteSmoothMs",
    type: "float" as const,
    default: 100, // ESTIMATE (M3 design §2.8)
    min: 0,
    max: 1000,
    description: "Time a remote player's rejoin offset takes to decay after extrapolating, ms",
  }),
  Object.freeze({
    name: "cl_remoteCrouchBlendMs",
    type: "float" as const,
    default: 100, // ESTIMATE (M3 design §2.8)
    min: 0,
    max: 1000,
    description: "Time a remote player's capsule takes to crouch or stand up, ms",
  }),
]);

/** Registers CLIENT_NET_CVARS as ARCHIVE cvars. */
export function registerClientNetCvars(reg: CvarRegistry): void {
  for (const c of CLIENT_NET_CVARS) {
    reg.register({
      name: c.name,
      type: c.type,
      default: c.default,
      min: c.min,
      max: c.max,
      description: c.description,
      flags: CvarFlag.ARCHIVE,
    });
  }
}

/** CLIENT_NET_CVARS as plain fields, refreshed when the registry's version moves. */
export class ClientNetSettings {
  inputBuffer = 2;
  correctionSmoothMs = 100;
  teleportDist = 64;
  /** 0 = auto (InterpDelay), else the fixed delay in ticks. */
  interpDelay = 0;
  remoteSmoothMs = 100;
  remoteCrouchBlendMs = 100;
  version = -1;
  registry: CvarRegistry | null = null;
}

/** Copies the registry into `out` when it or its version changed; returns whether it did. */
export function refreshClientNetSettings(reg: CvarRegistry, out: ClientNetSettings): boolean {
  if (reg === out.registry && reg.version === out.version) return false;
  out.inputBuffer = reg.getNumber("cl_inputBuffer", 2);
  out.correctionSmoothMs = reg.getNumber("cl_correctionSmoothMs", 100);
  out.teleportDist = reg.getNumber("cl_teleportDist", 64);
  out.interpDelay = reg.getNumber("cl_interpDelay", 0);
  out.remoteSmoothMs = reg.getNumber("cl_remoteSmoothMs", 100);
  out.remoteCrouchBlendMs = reg.getNumber("cl_remoteCrouchBlendMs", 100);
  out.version = reg.version;
  out.registry = reg;
  return true;
}
