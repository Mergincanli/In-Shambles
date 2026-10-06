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
  /** `prefix_camelCase`, as in the specs (`pm_airAccelerate`). Lookups ignore case. */
  name: string;
  type: T;
  default: CvarValueOf[T];
  /** int/float only; finite, and an integer for int cvars. */
  min?: number;
  /** int/float only; finite, and an integer for int cvars. */
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

const NAME = /^[a-z][A-Za-z0-9_]*$/;
const INT_TEXT = /^[+-]?\d+$/;
const FLOAT_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
// i32 range as literals: shared bans `**` (D-016).
const INT_MIN = -2147483648;
const INT_MAX = 2147483647;

/**
 * Q3-style cvar registry (docs/06 §6). Names are matched case-insensitively. Registration is
 * setup-time and throws on bad definitions; `set`/`setFromString`/`reset` come from consoles
 * and the network, so they return a result instead of throwing.
 */
export class CvarRegistry {
  /** Keyed by lowercased name, for case-insensitive lookups. */
  private readonly entries = new Map<string, CvarEntry>();
  /** Keyed by the registered spelling: code reads cvars without allocating a lowercased key. */
  private readonly exact = new Map<string, CvarEntry>();
  private allowCheats = false;

  register<T extends CvarType>(def: CvarDef<T>): void {
    if (!NAME.test(def.name)) throw new Error(`invalid cvar name "${def.name}"`);
    const key = def.name.toLowerCase();
    const existing = this.entries.get(key);
    if (existing) {
      throw new Error(`cvar "${def.name}" already registered as "${existing.def.name}"`);
    }
    const isNumber = def.type === "int" || def.type === "float";
    if (!isNumber && (def.min !== undefined || def.max !== undefined)) {
      throw new Error(`cvar "${def.name}": min/max only apply to int and float`);
    }
    for (const [label, bound] of [
      ["min", def.min],
      ["max", def.max],
    ] as const) {
      if (bound !== undefined && !matchesType(def.type, bound)) {
        throw new Error(`cvar "${def.name}": ${label} ${bound} is not a valid ${def.type}`);
      }
    }
    if (def.min !== undefined && def.max !== undefined && def.min > def.max) {
      throw new Error(`cvar "${def.name}": min ${def.min} > max ${def.max}`);
    }
    const value: CvarValue = def.default;
    if (!matchesType(def.type, value) || clampToRange(def, value) !== value) {
      throw new Error(`cvar "${def.name}": default ${String(value)} is not a valid ${def.type}`);
    }
    const entry: CvarEntry = { def: { ...def }, value: normalize(value), latched: undefined };
    this.entries.set(key, entry);
    this.exact.set(def.name, entry);
  }

  /** Exact spelling first (no allocation); other spellings from consoles fall back to lowercase. */
  private lookup(name: string): CvarEntry | undefined {
    return this.exact.get(name) ?? this.entries.get(name.toLowerCase());
  }

  has(name: string): boolean {
    return this.lookup(name) !== undefined;
  }

  get(name: string): CvarValue | undefined {
    return this.lookup(name)?.value;
  }

  info(name: string): CvarInfo | undefined {
    return this.lookup(name);
  }

  cheatsAllowed(): boolean {
    return this.allowCheats;
  }

  /** Turning cheats off resets every CHEAT cvar to its default and drops its pending value. */
  setAllowCheats(on: boolean): void {
    this.allowCheats = on;
    if (on) return;
    for (const entry of this.entries.values()) {
      if (!isCheat(entry)) continue;
      entry.value = normalize(entry.def.default);
      entry.latched = undefined;
    }
  }

  set(name: string, value: CvarValue): SetResult {
    const entry = this.lookup(name);
    if (!entry) return { ok: false, error: "unknown" };
    if (isCheat(entry) && !this.allowCheats) return { ok: false, error: "cheat" };
    return assign(entry, value);
  }

  setFromString(name: string, text: string): SetResult {
    const entry = this.lookup(name);
    if (!entry) return { ok: false, error: "unknown" };
    const value = parseValue(entry.def.type, text);
    if (value === undefined) return { ok: false, error: "type" };
    return this.set(name, value);
  }

  /** Back to the default. Allowed for CHEAT cvars too; LATCH cvars still wait for `applyLatched()`. */
  reset(name: string): SetResult {
    const entry = this.lookup(name);
    if (!entry) return { ok: false, error: "unknown" };
    return assign(entry, entry.def.default);
  }

  /** Apply pending LATCH values (on map restart). Returns the names that changed, sorted. */
  applyLatched(): string[] {
    const applied: string[] = [];
    for (const entry of this.entries.values()) {
      if (entry.latched === undefined) continue;
      if (entry.latched !== entry.value) applied.push(entry.def.name);
      entry.value = entry.latched;
      entry.latched = undefined;
    }
    return applied.sort(byName);
  }

  /** All cvars whose name starts with `prefix` (ignoring case), sorted by name. */
  list(prefix = ""): CvarInfo[] {
    const lower = prefix.toLowerCase();
    return [...this.entries.entries()]
      .filter(([key]) => key.startsWith(lower))
      .map(([, entry]) => entry)
      .sort((a, b) => byName(a.def.name, b.def.name));
  }

  /** REPLICATED cvars sorted by name: the block the server sends to clients. */
  replicated(): CvarInfo[] {
    return this.list().filter((entry) => (entry.def.flags ?? 0) & CvarFlag.REPLICATED);
  }
}

function isCheat(entry: CvarEntry): boolean {
  return ((entry.def.flags ?? 0) & CvarFlag.CHEAT) !== 0;
}

function byName(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

function assign(entry: CvarEntry, value: CvarValue): SetResult {
  if (!matchesType(entry.def.type, value)) return { ok: false, error: "type" };
  const next = normalize(clampToRange(entry.def, value));
  const clamped = next !== value;
  if ((entry.def.flags ?? 0) & CvarFlag.LATCH) {
    // Setting a LATCH cvar back to its current value cancels any pending change.
    entry.latched = next === entry.value ? undefined : next;
    return { ok: true, value: next, clamped, latched: entry.latched !== undefined };
  }
  entry.value = next;
  return { ok: true, value: next, clamped, latched: false };
}

function matchesType(type: CvarType, value: CvarValue): boolean {
  switch (type) {
    case "int":
      return (
        Number.isInteger(value) && (value as number) >= INT_MIN && (value as number) <= INT_MAX
      );
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

/** -0 becomes 0, so values compare, hash and serialize the same everywhere. */
function normalize(value: CvarValue): CvarValue {
  return value === 0 ? 0 : value;
}

function parseValue(type: CvarType, text: string): CvarValue | undefined {
  const trimmed = text.trim();
  switch (type) {
    case "int":
      return INT_TEXT.test(trimmed) ? Number(trimmed) : undefined;
    case "float":
      return FLOAT_TEXT.test(trimmed) ? Number(trimmed) : undefined;
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
