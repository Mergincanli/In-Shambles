import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { describe, expect, it } from "vitest";

const clientDir = fileURLToPath(new URL("..", import.meta.url));
const mapFile = fileURLToPath(new URL("../../../content/maps/movement_lab.cmap", import.meta.url));

describe("client production build", () => {
  it("builds the page, the app with the build hash, the server Worker and the map", async () => {
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

      // The map ships as a file (never inlined), byte for byte, and the app fetches it by name.
      const map = assets.find((f) => /^movement_lab-[\w-]+\.cmap$/.test(f));
      expect(map, assets.join(", ")).toBeDefined();
      expect(readFileSync(join(outDir, "assets", map ?? ""))).toEqual(readFileSync(mapFile));
      expect(js).toContain(`assets/${map}`);
      expect(js).not.toContain("data:application/octet-stream");
    } finally {
      delete process.env.BUILD_HASH;
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 30_000);
});
