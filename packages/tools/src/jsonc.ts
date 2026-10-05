/** Parses JSON with comments and trailing commas (tsconfig, biome.json), string-aware. */
export function parseJsonc(text: string): unknown {
  const source = text.replace(/^\uFEFF/, "");
  let out = "";
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') j += source[j] === "\\" ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j;
    } else if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 1;
    } else if (c === "," && nextSignificant(source, i + 1).match(/^[}\]]/)) {
      // Trailing comma: skip it.
    } else {
      out += c;
    }
  }
  return JSON.parse(out);
}

/** The text from `start` on, after whitespace and comments. */
function nextSignificant(source: string, start: number): string {
  let i = start;
  for (;;) {
    while (i < source.length && /\s/.test(source[i] ?? "")) i++;
    if (source.startsWith("//", i)) {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
    } else if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
    } else {
      return source.slice(i, i + 1);
    }
  }
}
