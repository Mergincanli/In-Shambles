import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { describe, expect, it } from "vitest";

const clientDir = fileURLToPath(new URL("..", import.meta.url));

describe("client production build", () => {
  it("builds a page that loads the app script with the build hash baked in", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "client-build-"));
    process.env.BUILD_HASH = "test1234";
    try {
      await build({ root: clientDir, logLevel: "silent", build: { outDir, emptyOutDir: true } });
      const html = readFileSync(join(outDir, "index.html"), "utf8");
      expect(html).toContain('<main id="app">');
      const script =
        /<script type="module" crossorigin src="\/assets\/([^"]+\.js)"><\/script>/.exec(html)?.[1];
      expect(script, html).toBeDefined();
      const js = readFileSync(join(outDir, "assets", script ?? ""), "utf8");
      expect(js).toContain("client ok · build ");
      expect(js).toContain("test1234");
      expect(js).not.toContain("__BUILD_HASH__");
    } finally {
      delete process.env.BUILD_HASH;
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 30_000);
});
