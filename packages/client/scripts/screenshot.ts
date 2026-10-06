import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  buildClient,
  launchChromium,
  readStatus,
  type Served,
  serveDev,
  servePreview,
  waitForRunning,
  watchErrors,
} from "./browser";

/**
 * Saves PNG screenshots of the client (M2 design §5): a few viewpoints in movement_lab, each a
 * page with `?autotest=1` and a fixed `?cam=` (sim u and degrees). The production build is
 * served by `vite preview` unless `--dev` asks for the dev server. A relative `<dir>` is taken
 * from where the command was typed (pnpm runs the script in packages/client).
 *
 *   pnpm --filter @game/client screenshot <dir> [--dev] [--width 1280] [--height 720]
 *
 * SwiftShader (the software WebGL these runs use) draws the floor tile right in front of an eye
 * at exactly pitch 0 over an axis-aligned tile seam as a flat band (vertices in the camera plane);
 * the spawn view therefore looks 3° down. Check such artefacts on a real GPU before chasing them.
 */

interface Viewpoint {
  readonly name: string;
  /** Query string after `?autotest=1`. */
  readonly query: string;
}

const VIEWPOINTS: readonly Viewpoint[] = [
  // The player's eye at the spawn, facing +X (see the header about pitch 0).
  { name: "spawn", query: "cam=-1152,-1536,50,0,3" },
  // The course row from the south: steps, stairs, slopes and the ladder wall.
  { name: "courses", query: "cam=-1500,2700,260,75,14" },
  // The ladder and the three water pools from the south-west.
  { name: "ladder_water", query: "cam=1300,3000,180,40,8" },
  // The lab's north half from above: the course row, the ladder and the pools.
  { name: "overview", query: "cam=-700,1500,1100,90,32" },
];

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dev: { type: "boolean", default: false },
    width: { type: "string", default: "1280" },
    height: { type: "string", default: "720" },
  },
});
const outDir = positionals[0];
if (outDir === undefined) {
  console.error("usage: screenshot <dir> [--dev] [--width 1280] [--height 720]");
  process.exit(2);
}
const width = Number(values.width);
const height = Number(values.height);
const shotsDir = resolve(process.env.INIT_CWD ?? process.cwd(), outDir);
mkdirSync(shotsDir, { recursive: true });

let buildDir = "";
let served: Served | null = null;
const browser = await launchChromium();
try {
  if (values.dev) {
    served = await serveDev();
  } else {
    buildDir = mkdtempSync(join(tmpdir(), "client-shots-"));
    await buildClient(buildDir);
    served = await servePreview(buildDir);
  }
  for (const v of VIEWPOINTS) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = watchErrors(page);
    await page.goto(`${served.url}?autotest=1&${v.query}`);
    await waitForRunning(page);
    await page.waitForTimeout(500);
    const status = await readStatus(page);
    const file = resolve(shotsDir, `${v.name}.png`);
    writeFileSync(file, await page.screenshot());
    await page.close();
    console.log(`${file}  (webgl ${status.webgl}, draw calls ${status.drawCalls})`);
    for (const e of errors) console.error(`  ${e}`);
  }
} finally {
  await browser.close();
  await served?.close();
  if (buildDir !== "") rmSync(buildDir, { recursive: true, force: true });
}
