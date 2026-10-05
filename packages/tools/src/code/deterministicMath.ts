/**
 * D-016: ECMA-262 lets engines approximate these Math functions, so browsers can return
 * different bits for the same input. Simulation code and compiler output code must not use
 * them, or `**` (which is pow). Exact operations stay allowed: + − * / %, sqrt, fround, round,
 * floor, ceil, trunc, abs, sign, min, max, imul, clz32, bitwise ops.
 */
export const APPROXIMATE_MATH = [
  "acos",
  "acosh",
  "asin",
  "asinh",
  "atan",
  "atanh",
  "atan2",
  "cbrt",
  "cos",
  "cosh",
  "exp",
  "expm1",
  "hypot",
  "log",
  "log1p",
  "log10",
  "log2",
  "pow",
  "sin",
  "sinh",
  "tan",
  "tanh",
] as const;

/** Math members that are exact (or exact constants), so they stay allowed under D-016. */
export const EXACT_MATH = [
  "abs",
  "ceil",
  "clz32",
  "floor",
  "fround",
  "imul",
  "max",
  "min",
  "round",
  "sign",
  "sqrt",
  "trunc",
  "E",
  "LN10",
  "LN2",
  "LOG10E",
  "LOG2E",
  "PI",
  "SQRT1_2",
  "SQRT2",
] as const;

/**
 * [label, pattern] rules for the D-016 ban, to run on `scanSource(...).code` (strings, comments
 * and regex bodies blanked). The per-name rules give clear labels; the allowlist rule is the
 * real fence: any use of `Math` other than `Math.<exact member>` is flagged, which covers
 * `Math["sin"]`, `Math?.sin`, `(Math).sin`, aliasing (`const M = Math`), `Reflect.get(Math, …)`,
 * any destructuring of Math, Math.random, and functions added to Math in the future.
 */
export const DETERMINISTIC_MATH_RULES: readonly (readonly [string, RegExp])[] = [
  ...APPROXIMATE_MATH.map(
    (name) => [`Math.${name}`, new RegExp(`\\bMath\\s*\\.\\s*${name}\\b`)] as const,
  ),
  ...APPROXIMATE_MATH.map(
    (name) =>
      [
        `destructured Math.${name}`,
        new RegExp(`\\{[^}]*\\b${name}\\b[^}]*\\}\\s*=\\s*Math\\b`),
      ] as const,
  ),
  [
    "Math outside the exact-op allowlist",
    new RegExp(`(?<![.$]\\s*)\\bMath\\b(?!\\s*\\.\\s*(?:${EXACT_MATH.join("|")})\\b)`),
  ],
  ["exponent operator **", /\*\*/],
];
