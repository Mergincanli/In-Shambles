// Production bundle of the dedicated server (docs/06 §2: esbuild for prod).
// Usage: node build.mjs [outfile] [entry]   (defaults dist/main.js and src/main.ts; tests pass a
// temp path, and MV-19 bundles its determinism probe as the entry with these same settings)
import { build } from "esbuild";

await build({
  entryPoints: [process.argv[3] ?? "src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: process.argv[2] ?? "dist/main.js",
  sourcemap: true,
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
});
