import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { build } from "vite";
import { CLIENT_DIR } from "./browser";

/**
 * One self-contained HTML file from a Vite page (the phone vectors page, D-022): the page is
 * built on its own, then its module script is inlined so the file loads with no other request
 * and can be published as a single web page.
 */

/** A `<script type="module" src="/assets/…">` tag Vite emits for an entry. */
const MODULE_SCRIPT = /<script type="module"[^>]*\ssrc="([^"]+)"[^>]*><\/script>/g;
/** Anything that would still load: src= or href= on any tag, url() or @import. */
const EXTERNAL = /\s(?:src|href)\s*=|url\(|@import/i;

/**
 * `html` with each module script tag replaced by an inline module holding `scripts[src]`. Throws
 * when a script is missing or something else would still load.
 */
export function inlineModuleScripts(
  html: string,
  scripts: Readonly<Record<string, string>>,
): string {
  const out = html.replace(MODULE_SCRIPT, (_tag, src: string) => {
    const code = scripts[src];
    if (code === undefined) throw new Error(`no built script for ${src}`);
    // Inside a <script> element only "</script" ends it early (any case); "<!--" can switch the
    // parser into its escaped states, which the bundle never needs.
    if (/<!--/.test(code)) throw new Error(`${src} holds "<!--"; it cannot be inlined as is`);
    // `<\/` reads back as `</` in any JS string or template; the case is kept.
    return `<script type="module">${code.replace(/<\/(script)/gi, "<\\/$1")}</script>`;
  });
  const rest = out.replace(/<script type="module">[\s\S]*?<\/script>/g, "");
  if (EXTERNAL.test(rest)) throw new Error("the page still references another file");
  return out;
}

/**
 * Builds `page` (an HTML file in packages/client, e.g. "vectors.html") as one HTML string with
 * its scripts inlined.
 */
export async function buildSingleFilePage(page: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "client-single-"));
  try {
    await build({
      root: CLIENT_DIR,
      logLevel: "warn",
      build: {
        outDir: dir,
        emptyOutDir: true,
        modulePreload: false,
        assetsInlineLimit: () => true,
        rolldownOptions: { input: join(CLIENT_DIR, page) },
      },
    });
    const scripts: Record<string, string> = {};
    const assets = join(dir, "assets");
    const files = readdirSync(assets);
    for (const file of files) {
      if (!file.endsWith(".js")) throw new Error(`unexpected build output assets/${file}`);
      scripts[posix.join("/assets", file)] = readFileSync(join(assets, file), "utf8");
    }
    if (files.length !== 1) throw new Error(`expected one script, got ${files.join(", ")}`);
    return inlineModuleScripts(readFileSync(join(dir, page), "utf8"), scripts);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
