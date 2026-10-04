import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const serverDir = fileURLToPath(new URL("..", import.meta.url));

describe("server smoke test", () => {
  it("starts, logs server ok, and stops cleanly on SIGTERM", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], { cwd: serverDir });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no "server ok" within 10 s:\n${output}`)),
        10_000,
      );
      child.stdout.on("data", () => {
        if (/server ok t=\d+\.\d{3}ms/.test(output)) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    const exitCode = new Promise<number | null>((resolve) => child.on("exit", resolve));
    child.kill("SIGTERM");
    // Windows can't deliver SIGTERM to a handler; there the process is just terminated.
    if (process.platform !== "win32") {
      expect(await exitCode).toBe(0);
      expect(output).toContain("server stopped (SIGTERM)");
    } else {
      await exitCode;
    }
  }, 15_000);
});
