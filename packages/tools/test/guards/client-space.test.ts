import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { scanSource } from "../../src/code/scan";
import { fromRoot } from "../../src/paths";

// One coordinate conversion (CLAUDE.md, .claude/rules/client-render.md): Z-up inches become
// Three.js Y-up metres in packages/client/src/render/space.ts only. Anywhere else in the client,
// the inch-to-metre factor or a hand-set camera rotation or orientation is an ad-hoc conversion.
const srcDir = fromRoot("packages", "client", "src");
const SPACE = join("render", "space.ts");
const FORBIDDEN: (readonly [string, RegExp])[] = [
  ["inch-to-metre factor", /\b0\.0254\b|(^|[^\w.])\.0254\b|\b39\.37/],
  ["camera rotation", /\.rotation\s*\.\s*(set|x|y|z|order)\b|\.rotation\s*=/],
  [
    "camera orientation",
    /\.up\s*\.\s*set\b|\.lookAt\s*\(|\.quaternion\s*\.\s*setFrom|\.setRotationFrom/,
  ],
];

function violations(source: string): string[] {
  const { code } = scanSource(source);
  return FORBIDDEN.filter(([, pattern]) => pattern.test(code)).map(([label]) => label);
}

const files = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".ts"))
  .map((file) => [file, join(srcDir, file)] as const);

describe("client space guard", () => {
  it.each([
    ["const m = u * 0.0254;", "inch-to-metre factor"],
    ["cam.rotation.set(0, 1, 0);", "camera rotation"],
    ["obj.rotation.y = yaw;", "camera rotation"],
    ["const m = u * .0254;", "inch-to-metre factor"],
    ["const u = m * 39.37;", "inch-to-metre factor"],
    ["camera.up.set(0, 0, 1);", "camera orientation"],
    ["camera.lookAt(target);", "camera orientation"],
    ["cam.quaternion.setFromEuler(e);", "camera orientation"],
    ["cam.setRotationFromEuler(e);", "camera orientation"],
  ])("flags %j", (source, label) => {
    expect(violations(source)).toContain(label);
  });

  it("leaves comments and strings alone", () => {
    expect(violations('// 1 u = 0.0254 m\nconst s = "rotation.set";')).toEqual([]);
    expect(violations("const a = 10.0254; const b = x.lookAtMe;")).toEqual([]);
  });

  it("finds space.ts and the render modules", () => {
    expect(files.map(([file]) => file)).toContain(SPACE);
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files.filter(([file]) => file !== SPACE).map(([file, path]) => [file, path]))(
    "%s converts only through render/space.ts",
    (_file, path) => {
      expect(violations(readFileSync(path, "utf8")), relative(srcDir, path)).toEqual([]);
    },
  );
});
