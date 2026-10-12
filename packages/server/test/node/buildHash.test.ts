import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { computeBuildHash } from "../../../../scripts/build-hash.mjs";
import { serverBuildHash } from "../../src/node/buildHash";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const saved = process.env.BUILD_HASH;

afterEach(() => {
  if (saved === undefined) delete process.env.BUILD_HASH;
  else process.env.BUILD_HASH = saved;
});

function git(args: string): string | null {
  try {
    return execSync(`git ${args}`, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

describe("build hash (scripts/build-hash.mjs, D-029)", () => {
  it("takes BUILD_HASH from the environment first, from source as well", () => {
    process.env.BUILD_HASH = "probe-1234";
    expect(computeBuildHash()).toBe("probe-1234");
    expect(serverBuildHash()).toBe("probe-1234");
  });

  it("is HEAD's short hash, with -dirty exactly when the checkout has changes", () => {
    delete process.env.BUILD_HASH;
    const head = git("rev-parse --short HEAD");
    if (head === null) {
      expect(computeBuildHash()).toBe("dev");
      return;
    }
    const dirty = git("status --porcelain") !== "";
    expect(computeBuildHash()).toBe(dirty ? `${head}-dirty` : head);
    expect(serverBuildHash()).toBe(computeBuildHash());
  });
});
