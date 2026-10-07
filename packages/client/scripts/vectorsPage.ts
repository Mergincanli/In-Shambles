import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildSingleFilePage } from "./singleFile";

/**
 * Builds the phone vectors page (vectors.html, src/dev/vectorsPage.ts; D-022) as one
 * self-contained HTML file: open it on a phone, from a web host or a file, and it replays every
 * committed vector table in that browser. A relative path is taken from where the command was
 * typed (pnpm runs the script in packages/client).
 *
 *   pnpm --filter @game/client vectors-page <out.html>
 */
const out = process.argv[2];
if (out === undefined || out.startsWith("-")) {
  console.error("usage: vectors-page <out.html>");
  process.exit(2);
}
const file = resolve(process.env.INIT_CWD ?? process.cwd(), out);
const html = await buildSingleFilePage("vectors.html");
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, html);
console.log(`${file}  (${Math.round(html.length / 1024)} KiB, no external requests)`);
