// Production bundle of the dedicated server (docs/06 §2: esbuild for prod).
import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/main.js",
  sourcemap: true,
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
});
