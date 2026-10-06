import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VECTOR_TABLES } from "../../shared/test/helpers/vectorReplay";
import { launchChromium, readStatus, watchErrors } from "../scripts/browser";
import { buildSingleFilePage } from "../scripts/singleFile";

// The phone vectors page (D-022, M2 plan increment 12) as the one-file build a phone opens: in
// headless Chromium from a file URL, it must make no request besides itself and report every
// table passing.
describe("phone vectors page", () => {
  let dir = "";
  let browser: Browser | null = null;
  let file = "";

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "vectors-page-"));
    file = join(dir, "vectors.html");
    writeFileSync(file, await buildSingleFilePage("vectors.html"));
    browser = await launchChromium();
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  });

  it("replays every vector table from one self-contained file, all passing", async () => {
    const page = await (browser as Browser).newPage();
    const errors = watchErrors(page);
    const url = pathToFileURL(file).href;
    const requests: string[] = [];
    page.on("request", (r) => {
      if (r.url() !== url) requests.push(r.url());
    });
    await page.goto(url);
    await page.waitForFunction(() => document.documentElement.dataset.state === "done", undefined, {
      timeout: 60_000,
      polling: 200,
    });
    const s = await readStatus(page);
    const rows = await page.locator("#tables tr").count();
    const verdict = await page.locator("#verdict").textContent();
    await page.close();

    expect(errors).toEqual([]);
    expect(requests).toEqual([]);
    expect(Number(s.tables)).toBe(VECTOR_TABLES.length);
    expect(rows).toBe(VECTOR_TABLES.length);
    const total = VECTOR_TABLES.reduce((n, t) => n + t.rows.length, 0);
    expect([Number(s.passed), Number(s.failed)]).toEqual([total, 0]);
    expect(verdict).toMatch(/^PASS: all \d+ rows of \d+ tables/);
  }, 60_000);
});
