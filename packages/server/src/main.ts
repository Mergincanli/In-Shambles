import { performance } from "node:perf_hooks";
import { setDevAsserts } from "@game/shared";
import { startupLine } from "./startup";

setDevAsserts(process.env.NODE_ENV !== "production");

// Placeholder until the match loop arrives (M3): stay alive like a real server.
const keepAlive = setInterval(() => {}, 2 ** 30);

function shutdown(signal: NodeJS.Signals): void {
  clearInterval(keepAlive);
  console.log(`server stopped (${signal})`);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Log readiness last, once shutdown handling is in place.
console.log(startupLine(performance.now()));
