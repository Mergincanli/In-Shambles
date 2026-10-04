import { performance } from "node:perf_hooks";
import { setDevAsserts } from "@game/shared";
import { startServer } from "./startup";

setDevAsserts(process.env.NODE_ENV !== "production");

startServer({
  onSignal: (signal, handler) => process.on(signal, handler),
  log: (line) => console.log(line),
  now: () => performance.now(),
  exit: (code) => process.exit(code),
});
