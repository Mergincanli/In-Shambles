import { dirname } from "node:path";
import type { Browser, Page } from "playwright";
import { launchChromium, type Served, servePreview } from "../../../client/scripts/launch";
import { CLIENT_BUILD } from "./builds";

/**
 * The human stand-in of a bots run (`--human`, M3 design §2.15, D-045; Mustafa's answer 3): the
 * production client build served by `vite preview`, played in headless Chromium by the page's
 * own scripted input at `?autotest=1&bot=mixed&connect=…&net_profile=…`, with the same client
 * code, socket path and simulated link a player has. What it reports is the page's autotest
 * status (`<html data-*>`, `app/game.ts`), read as the e2e reads it. Both the preview and the
 * browser start from this process, so they run at its priority (host.ts lowers it first).
 */

/**
 * The page's viewport: the e2e's (`packages/client/e2e/health.ts` VIEW), where SwiftShader keeps
 * about 57 fps on a 4-core host; a larger one starves the page's own prediction.
 */
export const HUMAN_VIEW = { width: 320, height: 180 } as const;
/** The page's scripted input (`createScriptedInput`): idle, run, strafe-jump, crouch, look. */
export const HUMAN_BOT = "mixed";
/** How long the page may take to load and report its build. */
const LOAD_TIMEOUT_MS = 30_000;
const POLL_MS = 100;

export type PageStatus = Readonly<Record<string, string>>;

/** The page query that plays the stand-in on `server` over the simulated `profile`. */
export function humanQuery(server: string, profile: string): string {
  return (
    `?autotest=1&bot=${HUMAN_BOT}&connect=${encodeURIComponent(server)}` +
    `&net_profile=${encodeURIComponent(profile)}`
  );
}

/** A copy of the page's status. A string, so this Node code needs no DOM types. */
const READ_STATUS = "Object.assign({}, document.documentElement.dataset)";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HumanPlayer {
  /** Console errors and uncaught page errors since the page opened. */
  readonly errors: string[] = [];

  private constructor(
    private readonly served: Served,
    private readonly browser: Browser,
    private readonly page: Page,
  ) {
    page.on("console", (m) => {
      if (m.type() === "error") this.errors.push(`console: ${m.text()}`);
    });
    page.on("pageerror", (e) => this.errors.push(`page: ${e.message}`));
  }

  /**
   * Serves the client build, launches Chromium and opens the stand-in's page on `server` (a
   * `ws://` URL). It connects as it loads; `buildHash()` says which build it is.
   */
  static async start(server: string, profile: string): Promise<HumanPlayer> {
    const served = await servePreview(dirname(CLIENT_BUILD.output));
    let browser: Browser | null = null;
    try {
      browser = await launchChromium();
      const page = await browser.newPage({ viewport: HUMAN_VIEW });
      const human = new HumanPlayer(served, browser, page);
      await page.goto(`${served.url}${humanQuery(server, profile)}`);
      return human;
    } catch (e) {
      await browser?.close();
      await served.close();
      throw e;
    }
  }

  async status(): Promise<PageStatus> {
    return (await this.page.evaluate(READ_STATUS)) as PageStatus;
  }

  /**
   * Polls the status until `done` holds and returns it, or null after `timeoutMs` or once the
   * page reports an error (the status then says why).
   */
  async waitFor(done: (s: PageStatus) => boolean, timeoutMs: number): Promise<PageStatus | null> {
    const until = performance.now() + timeoutMs;
    for (;;) {
      const s = await this.status();
      if (done(s)) return s;
      if (s.state === "error" || performance.now() >= until) return null;
      await sleep(POLL_MS);
    }
  }

  /** The page's build hash (`__BUILD_HASH__`), as soon as it reports one. */
  async buildHash(): Promise<string> {
    const s = await this.waitFor((x) => x.buildHash !== undefined, LOAD_TIMEOUT_MS);
    if (s === null) throw new Error("the human's page reported no build hash");
    return s.buildHash as string;
  }

  /** Closes the browser (the page's session ends with it) and the preview. Idempotent. */
  async close(): Promise<void> {
    await this.browser.close().catch(() => {});
    await this.served.close().catch(() => {});
  }
}
