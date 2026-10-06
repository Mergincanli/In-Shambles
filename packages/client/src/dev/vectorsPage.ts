import {
  replayTable,
  VECTOR_TABLES,
  type VectorTable,
} from "../../../shared/test/helpers/vectorReplay";

/**
 * The phone vectors page (D-022, M2 plan increment 12): replays every committed determinism,
 * trace and pmove vector table with the real shared code in whatever browser opens it, and shows
 * PASS/FAIL counts per table, so real Safari on an iPhone (which no CI job runs) can be checked
 * by hand. `pnpm --filter @game/client vectors-page <out.html>` builds it as one self-contained
 * HTML file; `pnpm dev` serves it at /vectors.html. Status for automation goes to
 * `document.documentElement.dataset` (state, tables, passed, failed).
 */

/** Mismatching rows shown per failing table. */
const SHOW_MISMATCHES = 3;

const status = document.documentElement.dataset;
const body = document.getElementById("tables");
const verdict = document.getElementById("verdict");
const details = document.getElementById("details");
const engine = document.getElementById("engine");
if (engine) engine.textContent = `${navigator.userAgent} · build ${__BUILD_HASH__}`;

function cell(row: HTMLTableRowElement, text: string, cls = ""): void {
  const td = document.createElement("td");
  td.textContent = text;
  if (cls !== "") td.className = cls;
  row.append(td);
}

/** Lets the page paint between tables (a phone shows progress instead of a frozen tab). */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function run(tables: readonly VectorTable[]): Promise<void> {
  status.state = "running";
  let passed = 0;
  let failed = 0;
  let failedTables = 0;
  const started = performance.now();
  for (const table of tables) {
    await nextFrame();
    let result: { passed: number; failed: number; mismatches: string[] };
    try {
      result = replayTable(table);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      result = { passed: 0, failed: table.rows.length, mismatches: [`threw: ${message}`] };
    }
    passed += result.passed;
    failed += result.failed;
    const row = document.createElement("tr");
    cell(row, table.name);
    cell(row, String(table.rows.length));
    cell(row, String(result.passed), result.failed === 0 ? "pass" : "");
    cell(row, String(result.failed), result.failed === 0 ? "" : "fail");
    body?.append(row);
    if (result.failed > 0) {
      failedTables++;
      const pre = document.createElement("pre");
      pre.className = "fail";
      pre.textContent = `${table.name}:\n${result.mismatches.slice(0, SHOW_MISMATCHES).join("\n")}`;
      details?.append(pre);
    }
  }
  const ms = Math.round(performance.now() - started);
  if (verdict) {
    verdict.className = failed === 0 ? "pass" : "fail";
    verdict.textContent =
      failed === 0
        ? `PASS: all ${passed} rows of ${tables.length} tables (${ms} ms)`
        : `FAIL: ${failed} rows in ${failedTables} of ${tables.length} tables (${passed} passed)`;
  }
  status.tables = String(tables.length);
  status.passed = String(passed);
  status.failed = String(failed);
  status.state = "done";
}

run(VECTOR_TABLES).catch((e: unknown) => {
  status.state = "error";
  if (verdict) verdict.textContent = `error: ${e instanceof Error ? e.message : String(e)}`;
});
