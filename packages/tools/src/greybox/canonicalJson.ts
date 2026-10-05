/**
 * Canonical JSON for compiler output (cmap metadata): the same value always gives the same bytes,
 * in every engine and locale. JSON.stringify can't do this for objects, because it writes
 * integer-like keys ("10") before the others whatever order they were inserted in.
 * - object keys sorted by UTF-16 code unit; keys whose value is undefined are left out;
 * - numbers via String(n), finite only, so −0 is written as 0;
 * - strings via JSON.stringify, then every character above 0x7E escaped as \uXXXX, so the text is
 *   pure printable ASCII;
 * - arrays in order; no whitespace.
 */
export function canonicalJson(value: unknown): string {
  return write(value, "$");
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function asciiString(s: string): string {
  const quoted = JSON.stringify(s);
  let out = "";
  for (let i = 0; i < quoted.length; i++) {
    const c = quoted.charCodeAt(i);
    out += c > 0x7e ? `\\u${c.toString(16).padStart(4, "0")}` : quoted[i];
  }
  return out;
}

function write(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`${path}: ${value} is not finite`);
      return String(value);
    case "string":
      return asciiString(value);
    case "object":
      break;
    default:
      throw new TypeError(`${path}: a ${typeof value} has no JSON form`);
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let i = 0; i < value.length; i++) items.push(write(value[i], `${path}[${i}]`));
    return `[${items.join(",")}]`;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${path}: only plain objects and arrays are written`);
  }
  const record = value as Record<string, unknown>;
  const members: string[] = [];
  for (const key of Object.keys(record).sort(byCodeUnit)) {
    const v = record[key];
    if (v !== undefined) members.push(`${asciiString(key)}:${write(v, `${path}.${key}`)}`);
  }
  return `{${members.join(",")}}`;
}
