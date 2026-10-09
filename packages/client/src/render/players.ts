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
/** The facing nub: a small dark block at eye height on the capsule's front, u. */
const NUB_SIZE: readonly [number, number, number] = [8, 6, 6];
/** The nub's centre above the feet: the standing eye (origin − mins + view height). */
const NUB_HEIGHT = VIEW_HEIGHT_STANDING - (HULL_MINS[2] as number);
const NUB_COLOR = 0x202020;
/** Max instances: one per player slot. */
export const PLAYER_INSTANCES = FRAME_SLOTS;

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
 * Remote interpolation (increment 7) blends the crouch and feeds a smooth `RemoteView`; until then
 * the view is the newest snapshot as it stands.
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

  /** Draws every visible slot of `view`. */
  update(view: RemoteView): void {
    const pose = this.pose;
    const out = this.matrices.array as Float32Array;
    const colors = this.colors.array as Float32Array;
    const rgb = this.rgb;
    const feet = HULL_MINS[2] as number;
    let n = 0;
    let recolored = false;
    for (let s = 0; s < FRAME_SLOTS; s++) {
      if (view.visible[s] !== 1) continue;
      pose[UPRIGHT_X] = view.x[s] as number;
      pose[UPRIGHT_Y] = view.y[s] as number;
      pose[UPRIGHT_Z] = (view.z[s] as number) + feet;
      pose[UPRIGHT_YAW] = view.yaw[s] as number;
      pose[UPRIGHT_HEIGHT] = view.crouched[s] === 1 ? CROUCH_SCALE : 1;
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
