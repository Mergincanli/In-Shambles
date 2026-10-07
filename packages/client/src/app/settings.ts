import { CvarFlag, type CvarRegistry } from "@game/shared";
import type { Binds } from "../console/binds";

/**
 * Saved settings (docs/06 §6, M2 design §1 app/settings.ts): the ARCHIVE cvars that differ from
 * their defaults, and the binds when they differ from the defaults, as JSON in localStorage.
 * Replicated cvars are the server's and never saved. Storage can be missing or throw (private
 * windows, blocked site data): every access is caught, and the game then runs on the defaults.
 */

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

/** The settings to store now. */
export function captureSettings(reg: CvarRegistry, binds: Binds): StoredSettings {
  const cvars: Record<string, string> = {};
  for (const info of reg.list()) {
    if (isArchive(info.def.flags) && info.value !== info.def.default) {
      cvars[info.def.name] = String(info.value);
    }
  }
  return binds.isDefault()
    ? { version: SETTINGS_VERSION, cvars }
    : { version: SETTINGS_VERSION, cvars, binds: binds.list() };
}

/**
 * Applies stored settings (already parsed JSON, untrusted: an old version, a hand edit) and
 * returns a warning per part it skipped.
 */
export function applySettings(data: unknown, reg: CvarRegistry, binds: Binds): string[] {
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
  return applySettings(data, reg, binds);
}

/**
 * Saves the settings whenever the registry's or the binds' version moved since the last save
 * (the console calls `maybeSave` after each command).
 */
export class SettingsSaver {
  private regVersion: number;
  private bindsVersion: number;

  constructor(
    private readonly storage: SettingsStorage | null,
    private readonly reg: CvarRegistry,
    private readonly binds: Binds,
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
    try {
      this.storage.setItem(SETTINGS_KEY, JSON.stringify(captureSettings(this.reg, this.binds)));
    } catch {
      // Quota or storage blocked: the versions stay behind, so the next call retries.
      return false;
    }
    this.regVersion = this.reg.version;
    this.bindsVersion = this.binds.version;
    return true;
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
