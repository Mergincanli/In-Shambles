import {
  FRAME_SLOTS,
  HULL_CROUCHED_MAXS,
  HULL_MINS,
  HULL_STANDING_MAXS,
  TEAM_1,
  TEAM_2,
  TEAM_NONE,
  VIEW_HEIGHT_STANDING,
} from "@game/shared";
import {
  BoxGeometry,
  CapsuleGeometry,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshLambertMaterial,
} from "three";
import type { RemoteView } from "../net/remotes";
import {
  UPRIGHT_HEIGHT,
  UPRIGHT_SLOTS,
  UPRIGHT_X,
  UPRIGHT_Y,
  UPRIGHT_YAW,
  UPRIGHT_Z,
  unitsToMeters,
  uprightToThree,
} from "./space";
import { teamColor } from "./teamColors";

/** The capsule's radius, u: the hull's half width (`sim/hull.ts`). */
export const CAPSULE_RADIUS = -(HULL_MINS[0] as number);
/** Standing and crouched heights, u: the hull's (56 and 40). */
export const CAPSULE_STANDING_HEIGHT = (HULL_STANDING_MAXS[2] as number) - (HULL_MINS[2] as number);
export const CAPSULE_CROUCHED_HEIGHT = (HULL_CROUCHED_MAXS[2] as number) - (HULL_MINS[2] as number);
/** A crouch squashes the capsule to the crouched hull's height. */
export const CROUCH_SCALE = CAPSULE_CROUCHED_HEIGHT / CAPSULE_STANDING_HEIGHT;
/** How much a crouch takes off the height scale. */
const CROUCH_DROP = 1 - CROUCH_SCALE;
/** The facing nub: a small dark block at eye height on the capsule's front, u. */
const NUB_SIZE: readonly [number, number, number] = [8, 6, 6];
/** The nub's centre above the feet: the standing eye (origin − mins + view height). */
const NUB_HEIGHT = VIEW_HEIGHT_STANDING - (HULL_MINS[2] as number);
const NUB_COLOR = 0x202020;
/** Max instances: one per player slot. */
export const PLAYER_INSTANCES = FRAME_SLOTS;

/** `PlayerCapsules.update`'s crouch blend: this frame's time and the blend's length, ms. */
export const BLEND_DT_MS = 0;
export const BLEND_MS = 1;

/** Team ids with a colour row in `rgb` (anything else draws neutral). */
const TEAMS = [TEAM_NONE, TEAM_1, TEAM_2] as const;

/**
 * The other players as capsules in team colours (M3 design §1, docs/09 M3 "simple capsule player
 * models"): one `InstancedMesh` of capsules with a colour per instance and one of facing nubs
 * sharing its matrices, so all of them cost 2 draw calls. A capsule has the player hull's radius
 * and height (crouched: squashed to the crouched hull along the up axis), stands on the hull's
 * feet and turns with the view yaw, the nub showing where it faces. Placement goes through
 * `space.ts`. `update` packs the visible slots into the first instances and allocates nothing.
 *
 * The view is the interpolated one (D-037); a crouch or a stand-up blends the height over
 * `cl_remoteCrouchBlendMs` (the M3 design §2.8 "renderer blends crouch height"), at once on a
 * slot's appearance or teleport.
 */
export class PlayerCapsules {
  /** Add this to the scene. */
  readonly object = new Group();
  readonly capsules: InstancedMesh;
  readonly nubs: InstancedMesh;
  /** Instances drawn after the last `update`. */
  count = 0;
  private readonly capsuleGeometry: CapsuleGeometry;
  private readonly nubGeometry: BoxGeometry;
  private readonly capsuleMaterial = new MeshLambertMaterial({ color: 0xffffff });
  private readonly nubMaterial = new MeshLambertMaterial({ color: NUB_COLOR });
  private readonly matrices: InstancedBufferAttribute;
  private readonly colors: InstancedBufferAttribute;
  /** Linear RGB per TEAMS row, then the neutral row for unknown teams. */
  private readonly rgb = new Float32Array((TEAMS.length + 1) * 3);
  /** The team each instance's colour holds (−1: none written). */
  private readonly instanceTeam = new Int16Array(PLAYER_INSTANCES).fill(-1);
  private readonly pose = new Float64Array(UPRIGHT_SLOTS);
  /** Each slot's drawn height scale (1 standing, CROUCH_SCALE crouched, between while blending). */
  readonly height = new Float64Array(PLAYER_INSTANCES).fill(1);
  private readonly blendStep = new Float64Array(1);

  constructor() {
    const r = unitsToMeters(CAPSULE_RADIUS);
    const h = unitsToMeters(CAPSULE_STANDING_HEIGHT);
    const capsule = new CapsuleGeometry(r, h - 2 * r, 6, 12);
    // Modelled around its feet, so the instance matrix places the hull's bottom.
    capsule.translate(0, h / 2, 0);
    this.capsuleGeometry = capsule;
    const nub = new BoxGeometry(
      unitsToMeters(NUB_SIZE[0]),
      unitsToMeters(NUB_SIZE[1]),
      unitsToMeters(NUB_SIZE[2]),
    );
    // Local +X is the facing (space.ts `uprightToThree`).
    nub.translate(r, unitsToMeters(NUB_HEIGHT), 0);
    this.nubGeometry = nub;
    this.capsules = new InstancedMesh(capsule, this.capsuleMaterial, PLAYER_INSTANCES);
    this.nubs = new InstancedMesh(nub, this.nubMaterial, PLAYER_INSTANCES);
    this.matrices = this.capsules.instanceMatrix;
    this.matrices.setUsage(DynamicDrawUsage);
    // One matrix buffer for both meshes: uploaded once per frame.
    this.nubs.instanceMatrix = this.matrices;
    this.colors = new InstancedBufferAttribute(new Float32Array(PLAYER_INSTANCES * 3), 3);
    this.colors.setUsage(DynamicDrawUsage);
    this.capsules.instanceColor = this.colors;
    const c = new Color();
    for (let i = 0; i <= TEAMS.length; i++) {
      c.setHex(teamColor(i < TEAMS.length ? (TEAMS[i] as number) : -1));
      this.rgb[i * 3] = c.r;
      this.rgb[i * 3 + 1] = c.g;
      this.rgb[i * 3 + 2] = c.b;
    }
    for (const m of [this.capsules, this.nubs]) {
      m.count = 0;
      m.visible = false;
      // Instances move every frame; a bounding sphere computed once would cull them wrongly.
      m.frustumCulled = false;
      this.object.add(m);
    }
  }

  /**
   * Draws every visible slot of `view`. `blend` ([BLEND_DT_MS], [BLEND_MS]) times the crouch
   * blend; without it (or with a 0 length) a crouch squashes the capsule at once.
   */
  update(view: RemoteView, blend: Float64Array | null = null): void {
    const pose = this.pose;
    const out = this.matrices.array as Float32Array;
    const colors = this.colors.array as Float32Array;
    const rgb = this.rgb;
    const feet = HULL_MINS[2] as number;
    const heights = this.height;
    // The blend's step per frame in height scale, in a slot: a ternary joining a module constant
    // double would box it per frame under native ES modules.
    const b = this.blendStep;
    b[0] = 1;
    if (blend !== null && (blend[BLEND_MS] as number) > 0) {
      b[0] = ((blend[BLEND_DT_MS] as number) / (blend[BLEND_MS] as number)) * CROUCH_DROP;
    }
    const step = b[0] as number;
    let n = 0;
    let recolored = false;
    for (let s = 0; s < FRAME_SLOTS; s++) {
      if (view.visible[s] !== 1) continue;
      const want = 1 - (view.crouched[s] as number) * CROUCH_DROP;
      let h = heights[s] as number;
      if (view.teleported[s] === 1 || step >= CROUCH_DROP) h = want;
      else if (h < want) h = Math.min(want, h + step);
      else if (h > want) h = Math.max(want, h - step);
      heights[s] = h;
      pose[UPRIGHT_X] = view.x[s] as number;
      pose[UPRIGHT_Y] = view.y[s] as number;
      pose[UPRIGHT_Z] = (view.z[s] as number) + feet;
      pose[UPRIGHT_YAW] = view.yaw[s] as number;
      pose[UPRIGHT_HEIGHT] = h;
      uprightToThree(pose, out, n * 16);
      const team = view.team[s] as number;
      if (this.instanceTeam[n] !== team) {
        this.instanceTeam[n] = team;
        const row = team <= TEAM_2 ? team : TEAMS.length;
        colors[n * 3] = rgb[row * 3] as number;
        colors[n * 3 + 1] = rgb[row * 3 + 1] as number;
        colors[n * 3 + 2] = rgb[row * 3 + 2] as number;
        recolored = true;
      }
      n++;
    }
    this.count = n;
    const any = n > 0;
    this.capsules.count = n;
    this.nubs.count = n;
    this.capsules.visible = any;
    this.nubs.visible = any;
    if (any) this.matrices.needsUpdate = true;
    if (recolored) this.colors.needsUpdate = true;
  }

  dispose(): void {
    this.object.removeFromParent();
    this.capsules.dispose();
    this.nubs.dispose();
    this.capsuleGeometry.dispose();
    this.nubGeometry.dispose();
    this.capsuleMaterial.dispose();
    this.nubMaterial.dispose();
  }
}
