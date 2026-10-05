import { setDevAsserts } from "@game/shared";
import { bootLabel } from "./bootLabel";

setDevAsserts(import.meta.env.DEV);

const app = document.getElementById("app");
if (app) app.textContent = bootLabel(__BUILD_HASH__);
