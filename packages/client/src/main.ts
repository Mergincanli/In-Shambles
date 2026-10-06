import { setDevAsserts } from "@game/shared";
import { boot } from "./app/boot";
import type { StatusSink } from "./app/game";
import { parseBootParams } from "./app/params";
import { bootLabel } from "./bootLabel";

setDevAsserts(import.meta.env.DEV);

const params = parseBootParams(location.search);
const status: StatusSink | null = params.autotest ? document.documentElement.dataset : null;
const label = document.getElementById("label");
const errorBox = document.getElementById("error");
const canvas = document.getElementById("view");
if (label) label.textContent = bootLabel(__BUILD_HASH__);

function showError(message: string): void {
  if (status !== null) {
    status.state = "error";
    status.error = message;
  }
  if (errorBox) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }
  console.error(message);
}

window.addEventListener("error", (e) => showError(e.message));
window.addEventListener("unhandledrejection", (e) => showError(String(e.reason)));

if (canvas instanceof HTMLCanvasElement) {
  boot(canvas, params, __BUILD_HASH__, status, showError).catch((e: unknown) =>
    showError(e instanceof Error ? e.message : String(e)),
  );
} else {
  showError("page has no #view canvas");
}
