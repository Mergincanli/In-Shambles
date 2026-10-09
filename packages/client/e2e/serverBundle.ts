import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The production server bundle for the e2e cases that play against a Node server (D-031): built
// into a temporary directory outside the workspace (as the server's smoke test does), so it can't
// lean on node_modules, and run from packages/server so it finds content/maps.

const serverDir = fileURLToPath(new URL("../../server", import.meta.url));

export interface ServerChild {
  readonly child: ChildProcess;
  readonly port: number;
  readonly buildHash: string;
  output(): string;
}

/** Builds the bundle into `dir/server/main.js` and returns its path. */
export function buildServerBundle(dir: string): string {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  const bundle = join(dir, "server", "main.js");
  const build = spawnSync(process.execPath, ["build.mjs", bundle], {
    cwd: serverDir,
    encoding: "utf8",
  });
  if (build.status !== 0) throw new Error(`server build failed:\n${build.stderr}`);
  writeFileSync(join(dir, "server", "package.json"), JSON.stringify({ type: "module" }));
  return bundle;
}

/** Starts the bundle on a free port and resolves with the port its `listening` line names. */
export function startServer(bundle: string): Promise<ServerChild> {
  const child = spawn(process.execPath, [bundle, "--port", "0"], { cwd: serverDir });
  let output = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no listening line:\n${output}`)), 15_000);
    child.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
      const line = output.split("\n").find((l) => l.includes('"ev":"listening"'));
      if (line === undefined) return;
      clearTimeout(timer);
      const l = JSON.parse(line) as { port: number; buildHash: string };
      resolve({ child, port: l.port, buildHash: l.buildHash, output: () => output });
    });
    child.once("exit", (code) => reject(new Error(`server exited (${code}):\n${output}`)));
  });
}
