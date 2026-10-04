// Production bundle of the dedicated server (docs/06 §2: esbuild for prod).
// Usage: node build.mjs [outfile]   (default dist/main.js; tests pass a temp path)
import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: process.argv[2] ?? "dist/main.js",
  sourcemap: true,
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
});
