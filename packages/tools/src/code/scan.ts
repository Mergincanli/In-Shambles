/**
 * A small JS/TS source scanner for guard tests. It separates code from string text:
 * `code` keeps the code with comments removed and every string, template text and regex body
 * blanked (template `${...}` expressions stay as code); `strings` lists the literal texts.
 * It is not a parser, but it gets strings, templates, regexes and comments right, which is what
 * the guards need to avoid false matches.
 */
export interface ScannedSource {
  code: string;
  strings: string[];
}

const REGEX_AFTER = new Set([
  "",
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "+",
  "-",
  "*",
  "%",
  "<",
  ">",
  "~",
  "^",
]);

export function scanSource(source: string): ScannedSource {
  const strings: string[] = [];
  let code = "";
  let i = 0;
  // Brace depth of each open template expression, so `}` can end it.
  const templateDepths: number[] = [];
  let depth = 0;

  const lastSignificant = () => code.trimEnd().at(-1) ?? "";
  const readTemplateText = () => {
    // From just after ` or }, up to the closing ` or the next ${.
    let text = "";
    while (i < source.length && source[i] !== "`") {
      if (source[i] === "\\") {
        text += source.slice(i, i + 2);
        i += 2;
      } else if (source[i] === "$" && source[i + 1] === "{") {
        strings.push(text);
        code += "${";
        i += 2;
        templateDepths.push(depth);
        depth++;
        return;
      } else {
        text += source[i];
        i++;
      }
    }
    strings.push(text);
    code += "`";
    i++;
  };

  while (i < source.length) {
    const c = source[i] ?? "";
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      code += " ";
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== c && source[j] !== "\n") {
        j += source[j] === "\\" ? 2 : 1;
      }
      strings.push(source.slice(i + 1, j));
      code += c + c;
      i = j + 1;
    } else if (c === "`") {
      code += "`";
      i++;
      readTemplateText();
    } else if (c === "}" && templateDepths.length && templateDepths.at(-1) === depth - 1) {
      templateDepths.pop();
      depth--;
      code += "}";
      i++;
      readTemplateText();
    } else if (c === "/" && REGEX_AFTER.has(lastSignificant())) {
      // A regex literal: skip to the closing / (outside a [...] class), then its flags.
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== "\n") {
        if (source[j] === "\\") j++;
        else if (source[j] === "[") inClass = true;
        else if (source[j] === "]") inClass = false;
        else if (source[j] === "/" && !inClass) break;
        j++;
      }
      j++;
      while (j < source.length && /[a-z]/i.test(source[j] ?? "")) j++;
      code += "/ /";
      i = j;
    } else {
      if (c === "{") depth++;
      else if (c === "}") depth--;
      code += c;
      i++;
    }
  }
  return { code, strings };
}
