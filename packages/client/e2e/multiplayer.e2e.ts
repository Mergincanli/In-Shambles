import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCollisionWorld, decodeCmap } from "@game/shared";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildClient,
  launchChromium,
  readStatus,
  type Served,
  servePreview,
  waitForRunning,
  watchErrors,
} from "../scripts/browser";
import {
  ClientSim,
  JM_CHECKED,
  JM_VIOLATIONS,
  RandomWalk,
  RC_DT_MS,
  RemoteJumpMeter,
  RouteInput,
  type SocketLike,
  TICK_MS,
  WebSocketTransport,
} from "../src/net";
import { expectHealthy, grew, sample, VIEW, waitForMoving } from "./health";
import { buildServerBundle, type ServerChild, startServer } from "./serverBundle";

// The multiplayer e2e (M3 design §5 "e2e", §6 increment 7, D-037): the production server bundle
// and client as in the connect case, plus 4 bots in this process (the client's own net code over
// Node's WebSocket, 3 strafe-jumping the bots' yard ring and 1 random-walking, framed at 60 Hz).
// The page plays the circle bot at `?connect=`: it draws the 4 others as capsule instances,
// interpolated (no NET-05 violation on its frames that were not long, most of them judged, a
// delay of 2–6 ticks), its netgraph shows the interpolation, and its own prediction stays healthy
// by the e2e rule. Each bot draws the other 4 with no NET-05 violation either.

const RUN_MS = 4000;
const BOTS = 4;
/** The bots' yard ring on arena_greybox (packages/tools/src/bots/routes.ts, ARENA_RING). */
const RING = [
  900, -300, 900, 300, 650, 560, -650, 560, -900, 300, -900, -300, -650, -560, 650, -560,
];
const mapFile = fileURLToPath(new URL("../../../content/maps/arena_greybox.cmap", import.meta.url));

/** Headless players on Node's WebSocket, framed together at 60 Hz. */
class Bots {
  readonly clients: ClientSim[] = [];
  /** NET-05's criterion on what each bot draws, judged on its frames that were not long. */
  readonly meters: RemoteJumpMeter[] = [];
  private readonly timer: NodeJS.Timeout;

  constructor(url: string, buildHash: string) {
    const cmap = decodeCmap(new Uint8Array(readFileSync(mapFile)));
    const world = buildCollisionWorld(cmap);
    for (let i = 0; i < BOTS; i++) {
      const socket = new WebSocket(url) as unknown as SocketLike;
      const c: ClientSim = new ClientSim({
        transport: new WebSocketTransport(socket),
        buildHash,
        clock: () => performance.now(),
        input: i < 3 ? new RouteInput(RING, 7 + i) : new RandomWalk(11),
        onMapRequest: () => {
          c.provideMap(cmap, world);
        },
      });
      c.connect();
      this.clients.push(c);
      this.meters.push(new RemoteJumpMeter());
    }
    this.timer = setInterval(() => {
      for (let i = 0; i < this.clients.length; i++) {
        const c = this.clients[i] as ClientSim;
        c.frame();
        c.updateRemotes();
        if (!c.active) continue;
        const long = (c.remotes.clock.t[RC_DT_MS] as number) > c.settings.inputBuffer * TICK_MS;
        this.meters[i]?.measure(c.remotes, !long);
      }
    }, 1000 / 60);
  }

  stop(): void {
    clearInterval(this.timer);
    for (const c of this.clients) c.disconnect("e2e over");
  }
}

describe("client e2e: other players on a Node server (D-037)", () => {
  let dir = "";
  let served: Served | null = null;
  let browser: Browser | null = null;
  let server: ServerChild | null = null;
  let bots: Bots | null = null;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "client-multiplayer-e2e-"));
    server = await startServer(buildServerBundle(dir));
    await buildClient(join(dir, "dist"));
    served = await servePreview(join(dir, "dist"));
    browser = await launchChromium();
  }, 120_000);

  afterAll(async () => {
    bots?.stop();
    await browser?.close();
    await served?.close();
    server?.child.kill("SIGTERM");
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  });

  it("draws 4 bots as interpolated capsules, smoothly, and shows the interpolation in the netgraph", async () => {
    const s0 = server as ServerChild;
    const url = `ws://127.0.0.1:${s0.port}`;
    bots = new Bots(url, s0.buildHash);
    const b = bots;
    await expect.poll(() => b.clients.every((c) => c.active), { timeout: 15_000 }).toBe(true);
    const page = await (browser as Browser).newPage({ viewport: VIEW });
    const errors = watchErrors(page);
    await page.goto(`${served?.url}?autotest=1&bot=circle&connect=${url}`);
    await waitForRunning(page);
    await waitForMoving(page);
    await expect.poll(async () => (await readStatus(page)).remotes, { timeout: 10_000 }).toBe("4");
    const moving = await sample(page);
    await page.keyboard.press("Backquote");
    const input = page.locator("#console-input");
    await input.fill("set cl_netgraph 1");
    await input.press("Enter");
    await page.keyboard.press("Backquote");
    const net = page.locator("#hud-net");
    await expect
      .poll(() => net.textContent(), { timeout: 5000 })
      .toMatch(/remote interp [2-6] ticks \(\d+ ms\) {2}extrap \d+\.\d% {2}held \d+\.\d%/);
    await page.waitForTimeout(RUN_MS);
    const end = await sample(page);
    const status = (await (await fetch(`http://127.0.0.1:${s0.port}/status`)).json()) as {
      matches: { players: number }[];
    };
    await page.close();

    expect(errors).toEqual([]);
    const s = end.s;
    expect(status.matches[0]?.players).toBe(BOTS + 1);
    expect(s.remotes).toBe("4");
    expect(Number(s.remoteFrames) - Number(moving.s.remoteFrames)).toBeGreaterThan(100);
    expect(s.remoteJumps, JSON.stringify(s)).toBe("0");
    // …of frames NET-05 judged: most of them (expectHealthy holds the long ones to under half).
    expect(grew(moving, end, "remoteJudged")).toBeGreaterThan(
      grew(moving, end, "remoteFrames") * 0.25,
    );
    expect(s.renderSnaps, JSON.stringify(s)).toBe("0");
    expect(Number(s.interpDelay)).toBeGreaterThanOrEqual(2);
    expect(Number(s.interpDelay)).toBeLessThanOrEqual(6);
    expectHealthy(moving, end, { webSocket: true });
    // The bots see each other and the page's player too, smoothly by the same criterion.
    for (let i = 0; i < BOTS; i++) {
      const c = b.clients[i] as ClientSim;
      const m = b.meters[i] as RemoteJumpMeter;
      expect(c.remotes.view.count).toBe(BOTS);
      expect(m.t[JM_CHECKED], `bot ${i}`).toBeGreaterThan(100);
      expect(m.t[JM_VIOLATIONS], `bot ${i}`).toBe(0);
    }
    // The renderer drew the 4 as capsule instances (2 draw calls on top of the world's).
    if (s.webgl === "1") expect(s.capsules).toBe("4");
  }, 60_000);
});
