import { parseArgs } from "node:util";
import { fromRoot } from "../paths";
import { type BotRunOptions, BotsRefused, runBots } from "./runner";
import { summaryMarkdown } from "./summary";

/**
 * The `pnpm bots` command (M3 design §2.15, D-036; its entry is cli.ts): headless bots against a
 * server, then a JSON + markdown summary in `reports/bots/` with PASS/FAIL against docs/10 §4 and
 * the prediction's health.
 *
 *   pnpm bots --count N --profile P --minutes M --map X [--server ws://host:port] [--seed S]
 *             [--strict] [--out dir]
 *
 * Without `--server` it starts the server itself. Exit codes: 0 done (FAILs only reported), 1 a
 * FAIL under `--strict`, 2 a refused run (bad flag, a count the match can't hold) or an error.
 * Ctrl+C ends the measured window early and still writes the summary.
 */

export const BOTS_USAGE =
  "usage: pnpm bots --count N --profile P --minutes M --map X [--server ws://host:port] " +
  "[--seed S] [--strict] [--out dir]";

/** The options a command line asks for (defaults: 16 bots, wan-100-loss1, 2 min, arena_greybox). */
export function parseBotArgs(
  args: readonly string[],
): BotRunOptions & { readonly strict: boolean } {
  let v: ReturnType<typeof parse>["values"];
  try {
    v = parse(args).values;
  } catch (e) {
    throw new BotsRefused(`${e instanceof Error ? e.message : String(e)}\n${BOTS_USAGE}`);
  }
  const num = (flag: string, text: string | undefined, def: number): number => {
    if (text === undefined) return def;
    const n = Number(text);
    if (text.trim() === "" || !Number.isFinite(n))
      throw new BotsRefused(`--${flag} ${text}: not a number`);
    return n;
  };
  return {
    count: num("count", v.count, 16),
    profile: v.profile ?? "wan-100-loss1",
    minutes: num("minutes", v.minutes, 2),
    map: v.map ?? "arena_greybox",
    server: v.server ?? null,
    seed: num("seed", v.seed, 1),
    human: v.human ?? false,
    strict: v.strict ?? false,
    outDir: v.out ?? fromRoot("reports", "bots"),
  };
}

function parse(args: readonly string[]) {
  return parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: false,
    options: {
      count: { type: "string" },
      profile: { type: "string" },
      minutes: { type: "string" },
      map: { type: "string" },
      server: { type: "string" },
      seed: { type: "string" },
      human: { type: "boolean" },
      strict: { type: "boolean" },
      out: { type: "string" },
    },
  });
}

/** A finished run's exit code: 0, or 1 for a FAIL under `--strict`. */
export function exitCode(pass: boolean, strict: boolean): number {
  return pass || !strict ? 0 : 1;
}

/** Runs the command line; resolves to the exit code. */
export async function botsMain(
  args: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const abort = new AbortController();
  const onSigint = () => {
    err("bots: interrupted; ending the window and writing the summary");
    abort.abort();
  };
  process.on("SIGINT", onSigint);
  try {
    const options = parseBotArgs(args);
    const { summary, files } = await runBots({ ...options, log: out, abort: abort.signal });
    out(summaryMarkdown(summary));
    if (files !== null) out(`bots: wrote ${files.json} and ${files.md}`);
    out(`bots: ${summary.pass ? "PASS" : "FAIL"}`);
    return exitCode(summary.pass, options.strict);
  } catch (e) {
    err(
      e instanceof BotsRefused
        ? `bots: ${e.message}`
        : `bots: ${e instanceof Error ? (e.stack ?? e.message) : e}`,
    );
    return 2;
  } finally {
    process.off("SIGINT", onSigint);
  }
}
