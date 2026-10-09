import { TEAM_1, TEAM_2, TEAM_NONE } from "@game/shared";

/**
 * Placeholder team hues (sRGB), ESTIMATE (M3 design §4, D-034): orange and blue read apart for the
 * common colour-vision deficiencies, and a neutral grey for a player without a team. `docs/08` §5
 * picks the real hues and the team shape cue in M8.
 */
export const TEAM_COLORS: Readonly<Record<number, number>> = {
  [TEAM_NONE]: 0x9a9a9a,
  [TEAM_1]: 0xd9652b,
  [TEAM_2]: 0x2b8fd9,
};

/** A team's hue (sRGB hex); an unknown team gets the neutral one. */
export function teamColor(team: number): number {
  return TEAM_COLORS[team] ?? (TEAM_COLORS[TEAM_NONE] as number);
}
