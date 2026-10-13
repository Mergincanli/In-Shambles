import { describe, expect, it } from "vitest";
import { stopSignals } from "../../src/node/signals";

// The signals main.ts stops the process on (D-029, D-051). The stop itself, on SIGINT, SIGTERM
// and the stdin `quit`, is the smoke test's (smoke.test.ts, server-smoke.long.ts).

describe("the server's stop signals", () => {
  it("are SIGINT and SIGTERM, and on Windows Ctrl+Break and the console window closing too", () => {
    expect(stopSignals("linux")).toEqual(["SIGINT", "SIGTERM"]);
    expect(stopSignals("darwin")).toEqual(["SIGINT", "SIGTERM"]);
    // SIGHUP keeps its default off Windows: a closed terminal still ends a POSIX server at once.
    expect(stopSignals("win32")).toEqual(["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]);
  });
});
