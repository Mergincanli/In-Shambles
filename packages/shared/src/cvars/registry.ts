import { CvarFlag } from "./flags";

export type CvarType = "int" | "float" | "bool" | "string";
export type CvarValue = number | boolean | string;

interface CvarValueOf {
  int: number;
  float: number;
  bool: boolean;
  string: string;
}

export interface CvarDef<T extends CvarType = CvarType> {
  name: string;
  type: T;
  default: CvarValueOf[T];
  /** int/float only. */
  min?: number;
  /** int/float only. */
  max?: number;
  description: string;
  /** `CvarFlag` bits. */
  flags?: number;
}

export interface CvarInfo {
  readonly def: Readonly<CvarDef>;
  readonly value: CvarValue;
  /** Pending value of a LATCH cvar, applied by `applyLatched()`. */
  readonly latched: CvarValue | undefined;
}

export type SetResult =
  | { ok: true; value: CvarValue; clamped: boolean; latched: boolean }
  | { ok: false; error: "unknown" | "type" | "cheat" };

interface CvarEntry {
  def: CvarDef;
  value: CvarValue;
  latched: CvarValue | undefined;
}

const NAME = /^[a-z][a-z0-9_]*$/;
const INT_TEXT = /^[+-]?\d+$/;

/**
 * Q3-style cvar registry (docs/06 §6). Registration is setup-time and throws on bad
 * definitions; `set`/`setFromString`/`reset` come from consoles and the network, so they
 * return a result instead of throwing.
 */
export class CvarRegistry {
  /** CHEAT cvars can only change while this is true. */
  allowCheats = false;

  private readonly entries = new Map<string, CvarEntry>();

  register<T extends CvarType>(def: CvarDef<T>): void {
    if (!NAME.test(def.name)) throw new Error(`invalid cvar name "${def.name}"`);
    if (this.entries.has(def.name)) throw new Error(`cvar "${def.name}" already registered`);
    const isNumber = def.type === "int" || def.type === "float";
    if (!isNumber && (def.min !== undefined || def.max !== undefined)) {
      throw new Error(`cvar "${def.name}": min/max only apply to int and float`);
    }
    if (def.min !== undefined && def.max !== undefined && def.min > def.max) {
      throw new Error(`cvar "${def.name}": min ${def.min} > max ${def.max}`);
    }
    const value: CvarValue = def.default;
    if (!matchesType(def.type, value) || clampToRange(def, value) !== value) {
      throw new Error(`cvar "${def.name}": default ${String(value)} is not a valid ${def.type}`);
    }
    this.entries.set(def.name, { def: { ...def }, value, latched: undefined });
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  get(name: string): CvarValue | undefined {
    return this.entries.get(name)?.value;
  }

  info(name: string): CvarInfo | undefined {
    return this.entries.get(name);
  }

  set(name: string, value: CvarValue): SetResult {
    const entry = this.entries.get(name);
    if (!entry) return { ok: false, error: "unknown" };
    if ((entry.def.flags ?? 0) & CvarFlag.CHEAT && !this.allowCheats) {
      return { ok: false, error: "cheat" };
    }
    return assign(entry, value);
  }

  setFromString(name: string, text: string): SetResult {
    const entry = this.entries.get(name);
    if (!entry) return { ok: false, error: "unknown" };
    const value = parseValue(entry.def.type, text);
    if (value === undefined) return { ok: false, error: "type" };
    return this.set(name, value);
  }

  /** Back to the default. Allowed for CHEAT cvars too; LATCH cvars still wait for `applyLatched()`. */
  reset(name: string): SetResult {
    const entry = this.entries.get(name);
    if (!entry) return { ok: false, error: "unknown" };
    return assign(entry, entry.def.default);
  }

  /** Apply pending LATCH values (on map restart). Returns the names that changed, sorted. */
  applyLatched(): string[] {
    const applied: string[] = [];
    for (const entry of this.entries.values()) {
      if (entry.latched === undefined) continue;
      entry.value = entry.latched;
      entry.latched = undefined;
      applied.push(entry.def.name);
    }
    return applied.sort();
  }

  /** All cvars whose name starts with `prefix`, sorted by name. */
  list(prefix = ""): CvarInfo[] {
    return [...this.entries.values()]
      .filter((entry) => entry.def.name.startsWith(prefix))
      .sort((a, b) => (a.def.name < b.def.name ? -1 : 1));
  }

  /** REPLICATED cvars sorted by name: the block the server sends to clients. */
  replicated(): CvarInfo[] {
    return this.list().filter((entry) => (entry.def.flags ?? 0) & CvarFlag.REPLICATED);
  }
}

function assign(entry: CvarEntry, value: CvarValue): SetResult {
  if (!matchesType(entry.def.type, value)) return { ok: false, error: "type" };
  const next = clampToRange(entry.def, value);
  const clamped = next !== value;
  if ((entry.def.flags ?? 0) & CvarFlag.LATCH) {
    entry.latched = next;
    return { ok: true, value: next, clamped, latched: true };
  }
  entry.value = next;
  return { ok: true, value: next, clamped, latched: false };
}

function matchesType(type: CvarType, value: CvarValue): boolean {
  switch (type) {
    case "int":
      return Number.isInteger(value);
    case "float":
      return typeof value === "number" && Number.isFinite(value);
    case "bool":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
  }
}

function clampToRange(def: CvarDef, value: CvarValue): CvarValue {
  if (typeof value !== "number") return value;
  if (def.min !== undefined && value < def.min) return def.min;
  if (def.max !== undefined && value > def.max) return def.max;
  return value;
}

function parseValue(type: CvarType, text: string): CvarValue | undefined {
  const trimmed = text.trim();
  switch (type) {
    case "int":
      return INT_TEXT.test(trimmed) ? Number(trimmed) : undefined;
    case "float": {
      const value = trimmed === "" ? Number.NaN : Number(trimmed);
      return Number.isFinite(value) ? value : undefined;
    }
    case "bool": {
      const lower = trimmed.toLowerCase();
      if (lower === "1" || lower === "true") return true;
      if (lower === "0" || lower === "false") return false;
      return undefined;
    }
    case "string":
      return text;
  }
}
