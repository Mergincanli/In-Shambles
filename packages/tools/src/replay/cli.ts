import { runDemoInfo } from "./demoInfo";

// `pnpm demo-info <file> [--json]` (D-044): pnpm runs the tools package's script from
// packages/tools, so a relative path resolves against the directory the command was typed in
// (INIT_CWD, which pnpm sets).
process.exitCode = runDemoInfo(process.argv.slice(2), {
  out: (text) => console.log(text),
  err: (text) => console.error(text),
  cwd: process.env.INIT_CWD ?? process.cwd(),
});
