import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseJsonc } from "../../src/jsonc";
import { fromRoot } from "../../src/paths";

interface TsConfig {
  extends?: string;
  compilerOptions?: Record<string, unknown>;
}

const STRICT_FAMILY = [
  "strict",
  "noImplicitAny",
  "strictNullChecks",
  "strictFunctionTypes",
  "strictBindCallApply",
  "strictPropertyInitialization",
  "strictBuiltinIteratorReturn",
  "noImplicitThis",
  "useUnknownInCatchVariables",
  "alwaysStrict",
];

const read = (file: string) => parseJsonc(readFileSync(file, "utf8")) as TsConfig;
const base = fromRoot("tsconfig.base.json");

/** Every tsconfig*.json at the root and in each package. */
const configs = [
  fromRoot("tsconfig.json"),
  ...readdirSync(fromRoot("packages")).flatMap((dir) => {
    const pkg = fromRoot("packages", dir);
    if (!existsSync(join(pkg, "package.json"))) return [];
    return readdirSync(pkg)
      .filter((file) => /^tsconfig.*\.json$/.test(file))
      .map((file) => join(pkg, file));
  }),
];

// The compiler is the first line of defence for golden rule 4 and docs/06 §2.
describe("tsconfig guard", () => {
  it("keeps the base strict and free of DOM and Node types", () => {
    const options = read(base).compilerOptions;
    expect(options?.strict).toBe(true);
    expect(options?.lib).toEqual(["ES2023"]);
    expect(options?.types).toEqual([]);
  });

  it.each(configs.map((file) => [file.slice(fromRoot().length + 1), file]))(
    "%s extends the base and keeps strict on",
    (_name, file) => {
      const config = read(file);
      expect(resolve(dirname(file), config.extends ?? "")).toBe(base);
      // `strict` and every flag it turns on must stay on (none may be set to false).
      for (const flag of STRICT_FAMILY) {
        expect(config.compilerOptions?.[flag] ?? true, flag).toBe(true);
      }
    },
  );

  it("keeps DOM and Node types out of packages/shared and checks indexed access", () => {
    const options = read(fromRoot("packages", "shared", "tsconfig.json")).compilerOptions;
    expect(options?.lib).toEqual(["ES2023"]);
    expect(options?.types).toEqual([]);
    expect(options?.noUncheckedIndexedAccess).toBe(true);
  });

  it("keeps DOM and Node types out of the client's net code (M2 design §1)", () => {
    const options = read(fromRoot("packages", "client", "tsconfig.net.json")).compilerOptions;
    expect(options?.lib).toEqual(["ES2023"]);
    expect(options?.types).toEqual([]);
    expect(options?.noUncheckedIndexedAccess).toBe(true);
  });

  it("gives the server Worker the WebWorker globals only (M2 design §1)", () => {
    const worker = read(fromRoot("packages", "client", "tsconfig.worker.json"));
    expect(worker.compilerOptions?.lib).toEqual(["ES2023", "WebWorker"]);
    expect(worker.compilerOptions?.types).toEqual([]);
    expect(worker.compilerOptions?.noUncheckedIndexedAccess).toBe(true);
    // The page's config (DOM) leaves the Worker to it.
    const page = read(fromRoot("packages", "client", "tsconfig.json")) as TsConfig & {
      exclude?: string[];
    };
    expect(page.exclude).toEqual(["src/worker"]);
    const scripts = readFileSync(fromRoot("packages", "client", "package.json"), "utf8");
    expect(scripts).toContain("tsc --noEmit -p tsconfig.worker.json");
  });

  it("keeps DOM and Node types out of the server's match code (D-027)", () => {
    const options = read(fromRoot("packages", "server", "tsconfig.match.json")).compilerOptions;
    expect(options?.lib).toEqual(["ES2023"]);
    expect(options?.types).toEqual([]);
    expect(options?.noUncheckedIndexedAccess).toBe(true);
  });
});
