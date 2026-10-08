import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { describe, expect, it } from "vitest";

const clientDir = fileURLToPath(new URL("..", import.meta.url));
const mapsDir = fileURLToPath(new URL("../../../content/maps", import.meta.url));

describe("client production build", () => {
  it("builds the page, the app with the build hash, the server Worker and every map", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "client-build-"));
    process.env.BUILD_HASH = "test1234";
    try {
      await build({ root: clientDir, logLevel: "silent", build: { outDir, emptyOutDir: true } });
      const html = readFileSync(join(outDir, "index.html"), "utf8");
      expect(html).toContain('<main id="app">');
      expect(html).toContain('<canvas id="view">');
      const script =
        /<script type="module" crossorigin src="\/assets\/([^"]+\.js)"><\/script>/.exec(html)?.[1];
      expect(script, html).toBeDefined();
      const js = readFileSync(join(outDir, "assets", script ?? ""), "utf8");
      expect(js).toContain("client ok · build ");
      expect(js).toContain("test1234");
      expect(js).not.toContain("__BUILD_HASH__");

      // The server Worker is its own ES module chunk, and the app starts it by its built name.
      const assets = readdirSync(join(outDir, "assets"));
      const worker = assets.find((f) => /^serverWorker-[\w-]+\.js$/.test(f));
      expect(worker, assets.join(", ")).toBeDefined();
      expect(js).toContain(`assets/${worker}`);
      const workerJs = readFileSync(join(outDir, "assets", worker ?? ""), "utf8");
      expect(workerJs).not.toMatch(/^\s*\(function|^\s*!function/);
      expect(workerJs).toContain("server running ");
      expect(workerJs).not.toMatch(/\bdocument\b|\bwindow\b/);

      // Every map ships as a file (never inlined), byte for byte, and the app knows it by name:
      // a dedicated server's WELCOME may name any of them (D-031).
      const maps = readdirSync(mapsDir).filter((f) => f.endsWith(".cmap"));
      expect(maps).toContain("arena_greybox.cmap");
      for (const file of maps) {
        const name = file.slice(0, -".cmap".length);
        const built = assets.find((f) => new RegExp(`^${name}-[\\w-]+\\.cmap$`).test(f));
        expect(built, `${file} in ${assets.join(", ")}`).toBeDefined();
        expect(readFileSync(join(outDir, "assets", built ?? ""))).toEqual(
          readFileSync(join(mapsDir, file)),
        );
        expect(js).toContain(`assets/${built}`);
      }
      expect(js).not.toContain("data:application/octet-stream");
    } finally {
      delete process.env.BUILD_HASH;
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 30_000);
});
