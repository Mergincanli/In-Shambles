import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fromRoot } from "../../src/paths";

// Runtime dependencies of the packages that ship (the client bundle and the server bundle). The
// workspace's own packages are original work and are not listed.
const SHIPPED = ["packages/client/package.json", "packages/server/package.json"];

function runtimeDeps(): string[] {
  const deps: string[] = [];
  for (const path of SHIPPED) {
    const pkg = JSON.parse(readFileSync(fromRoot(path), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      if (!name.startsWith("@game/")) deps.push(name);
    }
  }
  return deps;
}

describe("third-party licenses (docs/08 ART-08)", () => {
  const licenses = readFileSync(fromRoot("content/LICENSES.md"), "utf8");
  const rows = licenses.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Asset"));

  it("every shipped runtime dependency has a content/LICENSES.md row", () => {
    const missing = runtimeDeps().filter(
      (name) => !rows.some((row) => row.includes(`npm \`${name}\``)),
    );
    expect(missing).toEqual([]);
  });

  it("the client build ships the bundled libraries' notices", () => {
    const config = readFileSync(fromRoot("packages/client/vite.config.ts"), "utf8");
    expect(config).toMatch(/license:\s*\{\s*fileName:\s*"third-party-licenses\.md"\s*\}/);
  });
});
