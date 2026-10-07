import {
  buildCollisionWorld,
  CvarRegistry,
  decodeCmap,
  NET_PROFILE_LAN,
  NetSimTransport,
  registerPmoveCvars,
} from "@game/shared";
import mapUrl from "../../../../content/maps/movement_lab.cmap?url";
import { Binds } from "../console/binds";
import { registerClientCvars } from "../console/clientCvars";
import { type ConsoleHost, runConsoleCommand } from "../console/commands";
import { GameConsole } from "../console/console";
import { Hud } from "../hud/overlay";
import { attachKeyboard, KeyRouter } from "../input/keyboard";
import { attachMouse, MouseLook } from "../input/mouse";
import { attachMouseButtons, PointerLock } from "../input/pointerLock";
import { ActionState, PlayerInput } from "../input/sampler";
import {
  ClientSim,
  type CmdSampler,
  createScriptedInput,
  NeutralInput,
  PortTransport,
} from "../net";
import { GameRenderer } from "../render/renderer";
import type { WorkerOutMsg, WorkerStartMsg } from "../worker/messages";
import { Game, type StatusSink } from "./game";
import type { BootParams } from "./params";
import { browserStorage, loadSettings, SettingsSaver } from "./settings";

/** The net simulator's seed on the page: one fixed schedule per profile (D-028). */
const NETSIM_SEED = 0x5eed;

export interface Booted {
  readonly game: Game;
  readonly client: ClientSim;
  readonly renderer: GameRenderer | null;
  readonly worker: Worker;
  readonly console: GameConsole;
}

/**
 * Starts the game on `canvas` (M2 design §1 app/boot.ts): fetches movement_lab (a `?url` asset,
 * so the build ships the file), decodes it, starts the server Worker with a copy of the bytes and
 * the server ends of two MessageChannels, connects the client over the page's ends (through the
 * net simulator, `lan` until `net_profile` picks another), builds the scene, the HUD, the console
 * and the input, and starts the frame loop. Autotest pages skip saved settings and pointer lock.
 */
export async function boot(
  canvas: HTMLCanvasElement,
  params: BootParams,
  buildHash: string,
  status: StatusSink | null,
  onError: (message: string) => void,
): Promise<Booted> {
  if (status !== null) status.state = "loading";
  const res = await fetch(mapUrl);
  if (!res.ok) throw new Error(`map download failed: ${res.status} ${res.statusText}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const cmap = decodeCmap(bytes);
  const world = buildCollisionWorld(cmap);

  const worker = new Worker(new URL("../worker/serverWorker.ts", import.meta.url), {
    type: "module",
    name: "server",
  });
  worker.addEventListener("message", (event: MessageEvent<WorkerOutMsg>) => {
    const m = event.data;
    if (m.type === "log") {
      const line = `[server] ${m.msg}`;
      if (m.level === "error") console.error(line);
      else if (m.level === "warn") console.warn(line);
      else console.info(line);
    } else if (m.type === "error") {
      onError(`server: ${m.message}`);
    }
  });
  // A module Worker that fails to load fires a plain Event, without a message.
  worker.addEventListener("error", (event) =>
    onError(
      `server worker: ${event instanceof ErrorEvent && event.message ? event.message : "failed to load or crashed"}`,
    ),
  );
  worker.addEventListener("messageerror", () =>
    onError("server worker: a message could not be deserialized"),
  );
  const unreliable = new MessageChannel();
  const reliable = new MessageChannel();
  const copy = bytes.slice().buffer;
  const start: WorkerStartMsg = {
    type: "start",
    cmap: copy,
    buildHash,
    devAsserts: import.meta.env.DEV,
    unreliable: unreliable.port2,
    reliable: reliable.port2,
  };
  worker.postMessage(start, [copy, unreliable.port2, reliable.port2]);

  const cvars = new CvarRegistry();
  registerPmoveCvars(cvars);
  registerClientCvars(cvars);
  const binds = new Binds();
  const storage = params.autotest ? null : browserStorage();
  const settingWarnings = loadSettings(storage, cvars, binds);
  const saver = new SettingsSaver(storage, cvars, binds);

  const actions = new ActionState();
  const look = new MouseLook();
  let input: CmdSampler = new PlayerInput(actions, look);
  let playerLook: MouseLook | null = look;
  if (params.bot !== null) {
    const bot = createScriptedInput(params.bot);
    if (bot === null) console.warn(`unknown bot "${params.bot}"; standing still`);
    input = bot ?? new NeutralInput();
    playerLook = null;
  }
  /** The session ended: the error box says why, and the prompt and crosshair stay hidden. */
  let closed = false;
  const port = new PortTransport(unreliable.port1, reliable.port1);
  // One pump callback for every wake (one per scheduled packet under a non-lan profile).
  const pump = () => netsim.pump();
  const netsim: NetSimTransport = new NetSimTransport(
    port,
    NET_PROFILE_LAN,
    () => performance.now(),
    NETSIM_SEED,
    (at) => {
      setTimeout(pump, Math.max(0, at - performance.now()));
    },
  );
  const client = new ClientSim({
    transport: netsim,
    cmap,
    world,
    buildHash,
    clock: () => performance.now(),
    cvars,
    input,
    log: (level, msg) => {
      if (level === "error") console.error(msg);
      else if (level === "warn") console.warn(msg);
      else console.info(msg);
    },
    // Fires from a frame's poll, after boot returned (connect() is its last step), so the HUD
    // and the prompt below exist by then.
    onClosed: (reason) => {
      closed = true;
      onError(`disconnected: ${reason}`);
      updatePrompt();
    },
  });

  const renderer = GameRenderer.create(canvas);
  if (renderer === null) console.warn("WebGL 2 is unavailable: the game runs without a picture");
  else renderer.loadMap(cmap);
  if (status !== null) status.webgl = renderer === null ? "0" : "1";

  const app = canvas.parentElement ?? document.body;
  const hud = new Hud(app, netsim, renderer);
  const lock = new PointerLock(canvas, (locked) => {
    if (!locked) router.releaseAll();
    updatePrompt();
  });
  const host: ConsoleHost = {
    cvars,
    binds,
    print: (text) => gameConsole.print(text),
    clear: () => gameConsole.clear(),
    toggleConsole: () => gameConsole.toggle(),
    sendServer: (text) => client.sendCommand(text),
    net: netsim,
    corrections: client.predictor.corrections,
  };
  const run = (line: string) => {
    runConsoleCommand(line, host);
    saver.maybeSave();
  };
  const router = new KeyRouter(binds, actions, run);
  const gameConsole = new GameConsole(app, {
    binds,
    run,
    onToggle: (open) => {
      router.releaseAll();
      if (open) lock.exit();
      else if (!params.autotest) lock.request();
      updatePrompt();
    },
  });
  function updatePrompt(): void {
    hud.setPrompt(!closed && !params.autotest && !lock.locked && !gameConsole.open);
    hud.setCrosshair(!closed && !gameConsole.open && (params.autotest || lock.locked));
  }
  updatePrompt();
  attachKeyboard(window, router, {
    consoleOpen: () => gameConsole.open,
    closeConsole: () => gameConsole.setOpen(false),
  });
  attachMouse(document, look, () => lock.locked);
  attachMouseButtons(canvas, lock, router, () => !params.autotest && !gameConsole.open);
  gameConsole.print("In Shambles console: help lists the commands; Backquote or Escape closes it.");
  for (const w of settingWarnings) gameConsole.print(w);

  const game = new Game({
    client,
    renderer,
    status,
    camera: params.camera,
    look: playerLook,
    hud,
    onFrame: () => {
      const prints = client.prints;
      if (prints.length === 0) return;
      for (const text of prints) gameConsole.print(text);
      prints.length = 0;
    },
  });
  client.connect();
  game.start();
  return { game, client, renderer, worker, console: gameConsole };
}
