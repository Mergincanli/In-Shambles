import { botsMain } from "./command";

// `pnpm bots`: see command.ts.
const code = await botsMain(
  process.argv.slice(2),
  (t) => process.stdout.write(`${t}\n`),
  (t) => process.stderr.write(`${t}\n`),
);
process.exit(code);
