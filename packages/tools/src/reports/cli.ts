import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fromRoot } from "../paths";
import { formatFeelReport, measureFeel } from "./feelReport";

// `pnpm feel-report`: measures the base movement metrics, prints them and writes reports/feel.md
// (git-ignored; byte-identical on every run). `--out <file>` writes elsewhere (the report test).
const { values } = parseArgs({ options: { out: { type: "string" } } });
const file = values.out === undefined ? fromRoot("reports", "feel.md") : resolve(values.out);
const text = formatFeelReport(measureFeel());
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, text);
console.log(text);
console.log(`wrote ${file}`);
