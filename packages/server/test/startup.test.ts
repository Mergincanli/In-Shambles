import { describe, expect, it } from "vitest";
import { type ServerHost, type StopSignal, startServer, startupLine } from "../src/startup";

describe("startupLine", () => {
  it("logs server ok with the monotonic timestamp", () => {
    expect(startupLine(12.3456)).toBe("server ok t=12.346ms");
  });
});

describe("startServer", () => {
  function fakeHost() {
    const events: string[] = [];
    const handlers = new Map<StopSignal, () => void>();
    const host: ServerHost = {
      onSignal: (signal, handler) => {
        events.push(`on ${signal}`);
        handlers.set(signal, handler);
      },
      log: (line) => events.push(`log ${line}`),
      now: () => 42,
      exit: (code) => events.push(`exit ${code}`),
    };
    return { host, events, handlers };
  }

  it("installs both stop handlers before it logs readiness", () => {
    const { host, events } = fakeHost();
    startServer(host)();
    expect(events).toEqual(["on SIGINT", "on SIGTERM", "log server ok t=42.000ms"]);
  });

  it.each(["SIGINT", "SIGTERM"] as const)("logs and exits 0 on %s", (signal) => {
    const { host, events, handlers } = fakeHost();
    startServer(host);
    handlers.get(signal)?.();
    expect(events.slice(-2)).toEqual([`log server stopped (${signal})`, "exit 0"]);
  });
});
