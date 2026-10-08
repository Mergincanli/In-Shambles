import { readFileSync } from "node:fs";
import { serverBuildHash } from "@game/server/node";
import { describe, expect, it } from "vitest";
import { computeBuildHash } from "../../../../scripts/build-hash.mjs";
import viteConfig from "../../../client/vite.config";
import { fromRoot } from "../../src/paths";

// Build-hash agreement (D-031): the page, the server's bundle and the server run from source all
// take their hash from scripts/build-hash.mjs, so a client and a server built from one checkout
// always match (the bundle KICKs another build, sv_strictBuild 1). A copy of the logic elsewhere
// would drift (M2's vite.config.ts had one).

describe("build hash agreement (D-031)", () => {
  it("the page's __BUILD_HASH__, the server's and the script's are one", () => {
    const define = (viteConfig as { define?: Record<string, string> }).define ?? {};
    expect(define.__BUILD_HASH__).toBe(JSON.stringify(computeBuildHash()));
    expect(serverBuildHash()).toBe(computeBuildHash());
  });

  it.each([
    ["packages/client/vite.config.ts", "__BUILD_HASH__: JSON.stringify(computeBuildHash())"],
    ["packages/server/build.mjs", "__BUILD_HASH__: JSON.stringify(computeBuildHash())"],
  ])("%s defines it from the script and runs no git of its own", (file, line) => {
    const source = readFileSync(fromRoot(...file.split("/")), "utf8");
    expect(source).toMatch(
      /import \{ computeBuildHash \} from "(\.\.\/)+scripts\/build-hash\.mjs";/,
    );
    expect(source).toContain(line);
    expect(source).not.toMatch(/\bexecSync\b|\bgit\b/);
  });
});
