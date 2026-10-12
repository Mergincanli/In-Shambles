import { CvarFlag, type CvarRegistry } from "@game/shared";
import type { Binds } from "../console/binds";

/**
 * Saved settings (docs/06 §6, M2 design §1 app/settings.ts): the ARCHIVE cvars that differ from
 * their defaults, and the binds when they differ from the defaults, as JSON in localStorage.
 * Replicated cvars are the server's and never saved. Storage can be missing or throw (private
 * windows, blocked site data): every access is caught, and the game then runs on the defaults.
 *
 * CHEAT cvars (third person, the debug views; D-042) are saved too, but only the server's
 * `sv_cheats` lets them be on: while cheats are off a stored value is **held** (kept in storage as
 * it was, not applied, no warning) and the reset that turning cheats off makes is never written,
 * so playing on a dedicated server does not lose what the player chose offline. When cheats come
 * on, `SettingsSaver.restoreCheats` applies the held values.
 */

/** Stored values of CHEAT cvars, by registered name, kept while cheats are off. */
export type HeldCheats = Record<string, string>;

export const SETTINGS_KEY = "inshambles.settings";
export const SETTINGS_VERSION = 1;

export interface StoredSettings {
  readonly version: number;
  /** ARCHIVE cvars by name, as the text `set` takes. */
  readonly cvars: Record<string, string>;
  /** Every bind, [code, command]; absent when the binds are the defaults. */
  readonly binds?: [string, string][];
}

/** The subset of Storage these settings use. */
export interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isArchive(flags: number | undefined): boolean {
  return ((flags ?? 0) & CvarFlag.ARCHIVE) !== 0 && ((flags ?? 0) & CvarFlag.REPLICATED) === 0;
}

function isCheat(flags: number | undefined): boolean {
  return ((flags ?? 0) & CvarFlag.CHEAT) !== 0;
}

/**
 * The settings to store now. While cheats are off a CHEAT cvar is stored as `held` has it (its
 * current value is the forced default, not the player's choice).
 */
export function captureSettings(
  reg: CvarRegistry,
  binds: Binds,
  held: Readonly<HeldCheats> = {},
): StoredSettings {
  const cvars: Record<string, string> = {};
  const cheats = reg.cheatsAllowed();
  for (const info of reg.list()) {
    const flags = info.def.flags;
    if (!isArchive(flags)) continue;
    if (isCheat(flags) && !cheats) {
      const v = held[info.def.name];
      if (v !== undefined) cvars[info.def.name] = v;
    } else if (info.value !== info.def.default) {
      cvars[info.def.name] = String(info.value);
    }
  }
  return binds.isDefault()
    ? { version: SETTINGS_VERSION, cvars }
    : { version: SETTINGS_VERSION, cvars, binds: binds.list() };
}

/**
 * Applies stored settings (already parsed JSON, untrusted: an old version, a hand edit) and
 * returns a warning per part it skipped. A CHEAT cvar's value goes into `held` while cheats are
 * off.
 */
export function applySettings(
  data: unknown,
  reg: CvarRegistry,
  binds: Binds,
  held: HeldCheats = {},
): string[] {
  const warnings: string[] = [];
  if (typeof data !== "object" || data === null) return ["settings: not an object, ignored"];
  const s = data as Partial<Record<keyof StoredSettings, unknown>>;
  if (s.version !== SETTINGS_VERSION) return [`settings: version ${String(s.version)}, ignored`];
  if (typeof s.cvars === "object" && s.cvars !== null) {
    for (const [name, value] of Object.entries(s.cvars)) {
      const info = reg.info(name);
      if (info === undefined || !isArchive(info.def.flags) || typeof value !== "string") {
        warnings.push(`settings: skipped ${name}`);
        continue;
      }
      if (isCheat(info.def.flags) && !reg.cheatsAllowed()) {
        held[info.def.name] = value;
        continue;
      }
      const r = reg.setFromString(info.def.name, value);
      if (!r.ok) warnings.push(`settings: skipped ${name} = ${value}`);
    }
  }
  if (Array.isArray(s.binds)) {
    const entries = s.binds.filter(
      (e): e is [string, string] =>
        Array.isArray(e) && e.length === 2 && typeof e[0] === "string" && typeof e[1] === "string",
    );
    // All or nothing: a partial set could have lost the console key.
    if (entries.length !== s.binds.length) {
      warnings.push("settings: malformed binds, using the default binds");
    } else {
      const why = binds.replaceAll(entries);
      if (why !== null) warnings.push(`settings: binds ignored (${why}), using the default binds`);
    }
  }
  return warnings;
}

/** Loads saved settings into `reg` and `binds`; returns the warnings (none when nothing saved). */
export function loadSettings(
  storage: SettingsStorage | null,
  reg: CvarRegistry,
  binds: Binds,
  held: HeldCheats = {},
): string[] {
  if (storage === null) return [];
  let text: string | null;
  try {
    text = storage.getItem(SETTINGS_KEY);
  } catch {
    return ["settings: storage unavailable, using defaults"];
  }
  if (text === null) return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return ["settings: stored settings are not JSON, ignored"];
  }
  return applySettings(data, reg, binds, held);
}

/**
 * Saves the settings whenever the registry's or the binds' version moved since the last save
 * (the console calls `maybeSave` after each command). `held` is what `loadSettings` held back
 * (D-042); while cheats are on each save refreshes it, so turning them off keeps the last choice.
 */
export class SettingsSaver {
  private regVersion: number;
  private bindsVersion: number;

  constructor(
    private readonly storage: SettingsStorage | null,
    private readonly reg: CvarRegistry,
    private readonly binds: Binds,
    readonly held: HeldCheats = {},
  ) {
    this.regVersion = reg.version;
    this.bindsVersion = binds.version;
  }

  /** Whether it wrote (false when nothing changed or storage refused; a refusal retries). */
  maybeSave(): boolean {
    if (this.reg.version === this.regVersion && this.binds.version === this.bindsVersion) {
      return false;
    }
    if (this.storage === null) {
      this.regVersion = this.reg.version;
      this.bindsVersion = this.binds.version;
      return false;
    }
    const settings = captureSettings(this.reg, this.binds, this.held);
    try {
      this.storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // Quota or storage blocked: the versions stay behind, so the next call retries.
      return false;
    }
    if (this.reg.cheatsAllowed()) this.holdCheats(settings);
    this.regVersion = this.reg.version;
    this.bindsVersion = this.binds.version;
    return true;
  }

  /**
   * Cheats came on (the server's `sv_cheats`, D-042): applies the held CHEAT values; one that no
   * longer parses is dropped. Nothing happens while cheats are off.
   */
  restoreCheats(): void {
    if (!this.reg.cheatsAllowed()) return;
    for (const [name, value] of Object.entries(this.held)) {
      if (!this.reg.setFromString(name, value).ok) delete this.held[name];
    }
  }

  /** The CHEAT values just stored, as the ones to keep once cheats go off. */
  private holdCheats(settings: StoredSettings): void {
    for (const info of this.reg.list()) {
      if (!isArchive(info.def.flags) || !isCheat(info.def.flags)) continue;
      const v = settings.cvars[info.def.name];
      if (v === undefined) delete this.held[info.def.name];
      else this.held[info.def.name] = v;
    }
  }
}

/** The page's localStorage, or null where it is unavailable. */
export function browserStorage(): SettingsStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
