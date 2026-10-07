// Production bundle of the dedicated server (docs/06 §2: esbuild for prod).
// Usage: node build.mjs [outfile] [entry]   (defaults dist/main.js and src/node/main.ts; tests pass
// a temp path, and MV-19 bundles its determinism probe as the entry with these same settings)
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import { computeBuildHash } from "../../scripts/build-hash.mjs";

const outfile = process.argv[2] ?? "dist/main.js";

await build({
  entryPoints: [process.argv[3] ?? "src/node/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile,
  sourcemap: true,
  define: {
    "process.env.NODE_ENV": '"production"',
    // The bundle carries the hash of the checkout it was built from (D-029).
    __BUILD_HASH__: JSON.stringify(computeBuildHash()),
  },
  // `ws` is CommonJS: an ES-module bundle needs a real `require` for its Node built-ins. Its
  // optional native helpers stay out; ws falls back to JavaScript when they are missing.
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  external: ["bufferutil", "utf-8-validate"],
  logLevel: "info",
});

// The bundle contains ws, whose MIT license asks for its notice with every copy (content/LICENSES.md).
const wsLicense = readFileSync(
  join(dirname(createRequire(import.meta.url).resolve("ws/package.json")), "LICENSE"),
  "utf8",
);
writeFileSync(
  join(dirname(outfile), "third-party-licenses.md"),
  `# Third-party licenses in this bundle\n\n## ws (MIT)\n\n${wsLicense.trim()}\n`,
);
