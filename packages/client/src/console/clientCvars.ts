import { CvarFlag, type CvarRegistry } from "@game/shared";
import { registerClientNetCvars } from "../net/cvars";
import { registerViewCvars } from "../render/viewCvars";

/**
 * The console's and HUD's client cvars (docs/06 §7, M2 design §4): ARCHIVE settings, saved per
 * player (app/settings.ts) and never replicated, so they shape only this client's input and
 * picture, never the simulation. The net code's and the view's own client cvars register beside
 * them (`registerClientCvars`).
 */
export const CLIENT_CVARS = Object.freeze([
  Object.freeze({
    name: "sensitivity",
    type: "float" as const,
    default: 5, // Q3 default
    min: 0,
    max: 100,
    description: "Mouse sensitivity: turn per count = sensitivity × m_yaw (or m_pitch) degrees",
  }),
  Object.freeze({
    name: "m_yaw",
    type: "float" as const,
    default: 0.022, // Q3 convention: degrees per count
    min: -1,
    max: 1,
    description: "Degrees of yaw per mouse count at sensitivity 1",
  }),
  Object.freeze({
    name: "m_pitch",
    type: "float" as const,
    default: 0.022, // Q3 convention: degrees per count; negative inverts
    min: -1,
    max: 1,
    description: "Degrees of pitch per mouse count at sensitivity 1 (negative inverts)",
  }),
  Object.freeze({
    name: "cl_speedometer",
    type: "bool" as const,
    default: false,
    description: "Show horizontal and vertical speed and the movement state",
  }),
  Object.freeze({
    name: "cl_netgraph",
    type: "bool" as const,
    default: false,
    description: "Show the link, correction, input-buffer and traffic figures",
  }),
  Object.freeze({
    name: "cl_thirdPerson",
    type: "bool" as const,
    default: false,
    description: "Pull the camera 120 u behind the eye, so the hull and traces are visible",
  }),
  Object.freeze({
    name: "r_debugHull",
    type: "bool" as const,
    default: false,
    description: "Draw the player's collision hull",
  }),
  Object.freeze({
    name: "r_debugTraces",
    type: "bool" as const,
    default: false,
    description: "Draw pmove's traces (green: clear, red: hit, with the hit normal)",
  }),
  Object.freeze({
    name: "r_debugGround",
    type: "bool" as const,
    default: false,
    description: "Draw the ground normal under the player",
  }),
  Object.freeze({
    name: "r_stats",
    type: "bool" as const,
    default: false,
    description: "Show the renderer's draw calls, triangles, geometries and textures",
  }),
]);

/** Registers every client cvar: the net code's, the view's and CLIENT_CVARS, all ARCHIVE. */
export function registerClientCvars(reg: CvarRegistry): void {
  registerClientNetCvars(reg);
  registerViewCvars(reg);
  for (const c of CLIENT_CVARS) {
    reg.register({
      name: c.name,
      type: c.type,
      default: c.default,
      ...("min" in c ? { min: c.min, max: c.max } : {}),
      description: c.description,
      flags: CvarFlag.ARCHIVE,
    });
  }
}

/** CLIENT_CVARS as plain fields, refreshed when the registry's version moves. */
export class ClientSettings {
  sensitivity = 5;
  mYaw = 0.022;
  mPitch = 0.022;
  speedometer = false;
  netgraph = false;
  thirdPerson = false;
  debugHull = false;
  debugTraces = false;
  debugGround = false;
  renderStats = false;
  version = -1;
  registry: CvarRegistry | null = null;
}

/** Copies the registry into `out` when it or its version changed; returns whether it did. */
export function refreshClientSettings(reg: CvarRegistry, out: ClientSettings): boolean {
  if (reg === out.registry && reg.version === out.version) return false;
  out.sensitivity = reg.getNumber("sensitivity", 5);
  out.mYaw = reg.getNumber("m_yaw", 0.022);
  out.mPitch = reg.getNumber("m_pitch", 0.022);
  out.speedometer = reg.get("cl_speedometer") === true;
  out.netgraph = reg.get("cl_netgraph") === true;
  out.thirdPerson = reg.get("cl_thirdPerson") === true;
  out.debugHull = reg.get("r_debugHull") === true;
  out.debugTraces = reg.get("r_debugTraces") === true;
  out.debugGround = reg.get("r_debugGround") === true;
  out.renderStats = reg.get("r_stats") === true;
  out.version = reg.version;
  out.registry = reg;
  return true;
}
