import { CvarFlag, type CvarRegistry } from "@game/shared";

/**
 * The view's client cvars (docs/06 §7): ARCHIVE settings, saved per player and never
 * replicated, so they shape only this client's picture, never the simulation.
 */
export const VIEW_CVARS = Object.freeze([
  Object.freeze({
    name: "cl_fov",
    type: "float" as const,
    default: 90, // ESTIMATE (horizontal at 4:3, Hor+)
    min: 10,
    max: 160,
    description: "Horizontal field of view at 4:3, degrees; wider screens see more (Hor+)",
  }),
  Object.freeze({
    name: "cl_stepSmoothMs",
    type: "float" as const,
    default: 150, // ESTIMATE
    min: 0,
    max: 1000,
    description: "Time the view takes to catch up with a step, ms",
  }),
  Object.freeze({
    name: "cl_viewHeightSmoothMs",
    type: "float" as const,
    default: 100, // ESTIMATE
    min: 0,
    max: 1000,
    description: "Time the eye takes to move between standing and crouched height, ms",
  }),
]);

/** Registers VIEW_CVARS as ARCHIVE cvars. */
export function registerViewCvars(reg: CvarRegistry): void {
  for (const c of VIEW_CVARS) {
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

/** VIEW_CVARS as plain fields, refreshed when the registry's version moves. */
export class ViewSettings {
  fov = 90;
  stepSmoothMs = 150;
  viewHeightSmoothMs = 100;
  version = -1;
  registry: CvarRegistry | null = null;
}

/** Copies the registry into `out` when it or its version changed; returns whether it did. */
export function refreshViewSettings(reg: CvarRegistry, out: ViewSettings): boolean {
  if (reg === out.registry && reg.version === out.version) return false;
  out.fov = reg.getNumber("cl_fov", 90);
  out.stepSmoothMs = reg.getNumber("cl_stepSmoothMs", 150);
  out.viewHeightSmoothMs = reg.getNumber("cl_viewHeightSmoothMs", 100);
  out.version = reg.version;
  out.registry = reg;
  return true;
}
