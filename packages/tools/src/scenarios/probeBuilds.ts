import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fromRoot } from "../paths";
import type { ProbeResult } from "./determinismProbe";

/**
 * MV-19's build legs (M2 design §5): the determinism probe bundled the way each host ships the
 * sim, then run in plain Node. The server leg is the server's own build script with the probe as
 * its entry; the client leg is Vite, resolved from the client package so it is the version the
 * client builds with, in library mode and minified. Neither bundler is a dependency of tools.
 */

export const PROBE_ENTRY = fromRoot("packages", "tools", "src", "scenarios", "determinismProbe.ts");

function check(what: string, result: ReturnType<typeof spawnSync>): void {
  if (result.status !== 0) {
    throw new Error(`${what} exited with ${result.status}: ${String(result.stderr)}`);
  }
}

/** `node packages/server/build.mjs <outfile> <entry>`: the production server bundle settings. */
export function bundleProbeWithServerBuild(outDir: string): string {
  const outfile = join(outDir, "probe-esbuild.mjs");
  const result = spawnSync(process.execPath, ["build.mjs", outfile, PROBE_ENTRY], {
    cwd: fromRoot("packages", "server"),
    encoding: "utf8",
  });
  check("the server build", result);
  return outfile;
}

/** The slice of Vite's API this uses: tools carries no Vite types. */
interface ViteApi {
  build(config: Record<string, unknown>): Promise<unknown>;
}

/**
 * Vite library mode (ES module, minified), as the client's Vite bundles shared code. For ES
 * output Vite's library minify mangles names and folds constants but keeps whitespace.
 */
export async function bundleProbeWithVite(outDir: string): Promise<string> {
  const require = createRequire(fromRoot("packages", "client", "package.json"));
  const vite = (await import(pathToFileURL(require.resolve("vite")).href)) as ViteApi;
  await vite.build({
    configFile: false,
    root: fromRoot("packages", "tools"),
    logLevel: "warn",
    build: {
      lib: { entry: PROBE_ENTRY, formats: ["es"], fileName: () => "probe-vite.mjs" },
      outDir,
      emptyOutDir: false,
      minify: true,
      reportCompressedSize: false,
    },
  });
  return join(outDir, "probe-vite.mjs");
}

/** Imports a bundle in a fresh `node` (no loaders, no Vitest) and runs the probe on `cmapPath`. */
const RUNNER = `
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const [bundle, cmap] = process.argv.slice(1);
const { runDeterminismProbe } = await import(pathToFileURL(bundle).href);
const result = runDeterminismProbe(new Uint8Array(readFileSync(cmap)));
process.stdout.write(JSON.stringify(result));
`;

export function runProbeBundle(bundle: string, cmapPath: string): ProbeResult {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", RUNNER, bundle, cmapPath],
    { encoding: "utf8" },
  );
  check(`node ${bundle}`, result);
  return JSON.parse(result.stdout) as ProbeResult;
}
