import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fromRoot } from "../paths";
import { encodeCmap } from "./cmapEncode";
import { COURSE_MAP_DIR, COURSES, courseFileName } from "./courses";

// `pnpm greybox`: compiles every course and writes content/maps/<name>.cmap, the exact bytes the
// course tests compare against. `--out <dir>` writes elsewhere (the CLI smoke test).
const { values } = parseArgs({ options: { out: { type: "string" } } });
const dir = values.out === undefined ? fromRoot(...COURSE_MAP_DIR) : resolve(values.out);
mkdirSync(dir, { recursive: true });
for (const course of COURSES) {
  const cmap = course.build();
  const bytes = encodeCmap(cmap);
  const file = courseFileName(course.name);
  writeFileSync(join(dir, file), bytes);
  console.log(`${file}  ${bytes.length} bytes  ${cmap.contentHash}`);
}
