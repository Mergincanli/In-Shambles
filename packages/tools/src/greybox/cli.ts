import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fromRoot } from "../paths";
import { encodeCmap } from "./cmapEncode";
import { COURSE_MAP_DIR, COURSES, courseFileName } from "./courses";

// `pnpm greybox`: compiles every course and writes content/maps/<name>.cmap, the exact bytes the
// course tests compare against.
const dir = fromRoot(...COURSE_MAP_DIR);
mkdirSync(dir, { recursive: true });
for (const course of COURSES) {
  const cmap = course.build();
  const bytes = encodeCmap(cmap);
  const file = courseFileName(course.name);
  writeFileSync(join(dir, file), bytes);
  console.log(`${file}  ${bytes.length} bytes  ${cmap.contentHash}`);
}
