import {
  buildCollisionWorld,
  type Cmap,
  CvarRegistry,
  findNetProfile,
  NET_PROFILE_LAN,
  NetSimTransport,
  registerPmoveCvars,
  type Transport,
} from "@game/shared";
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
  WebSocketTransport,
} from "../net";
import { GameRenderer } from "../render/renderer";
import type { WorkerOutMsg, WorkerStartMsg } from "../worker/messages";
import { Game, type StatusSink } from "./game";
import { fetchMap, loadServerMap } from "./maps";
import { type BootParams, connectSearch, parseServerUrl } from "./params";
import { browserStorage, loadSettings, SettingsSaver } from "./settings";

/** The net simulator's seed on the page: one fixed schedule per profile (D-028). */
const NETSIM_SEED = 0x5eed;

/** The local server's map (M2): the movement course. */
const WORKER_MAP = "movement_lab";

export interface Booted {
  readonly game: Game;
  readonly client: ClientSim;
  readonly renderer: GameRenderer | null;
  /** The local server, or null on a dedicated server (`?connect=`). */
  readonly worker: Worker | null;
  readonly console: GameConsole;
}

/**
 * Starts the game on `canvas` (M2 design §1 app/boot.ts, D-031). By default it fetches
 * movement_lab (every map is a bundled `?url` asset, app/maps.ts), starts the server Worker with a
 * copy of the bytes and the server ends of two MessageChannels, and connects over the page's
 * ends. With `?connect=ws://…` it opens a WebSocket to that dedicated server instead and loads the
 * map the server's WELCOME names (READY waits for it). Either link goes through the net
 * simulator, at `?net_profile=` (else `lan`) until the `net_profile` command picks another. Then
 * the scene, the HUD, the console and the input, and the frame loop. Autotest pages skip saved
 * settings and pointer lock.
 */
export async function boot(
  canvas: HTMLCanvasElement,
  params: BootParams,
  buildHash: string,
  status: StatusSink | null,
  onError: (message: string) => void,
): Promise<Booted> {
  if (status !== null) status.state = "loading";
  let profile = NET_PROFILE_LAN;
  const profileWarning =
    params.netProfile === null || findNetProfile(params.netProfile) !== undefined
      ? null
      : `unknown net_profile ${params.netProfile}; using lan`;
  if (params.netProfile !== null) profile = findNetProfile(params.netProfile) ?? NET_PROFILE_LAN;
  let base: Transport;
  let worker: Worker | null = null;
  let cmap: Cmap | null = null;
  let server: string;
  if (params.connect !== null) {
    const target = parseServerUrl(params.connect);
    if (!target.ok) throw new Error(`?connect=${params.connect}: ${target.error}`);
    server = target.url;
    base = new WebSocketTransport(new WebSocket(target.url));
  } else {
    server = "the local server (Worker)";
    const file = await fetchMap(WORKER_MAP);
    cmap = file.cmap;
    const started = startWorker(file.bytes, buildHash, onError);
    worker = started.worker;
    base = started.transport;
  }

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
  // One pump callback for every wake (one per scheduled packet under a non-lan profile).
  const pump = () => netsim.pump();
  const netsim: NetSimTransport = new NetSimTransport(
    base,
    profile,
    () => performance.now(),
    NETSIM_SEED,
    (at) => {
      setTimeout(pump, Math.max(0, at - performance.now()));
    },
  );
  const renderer = GameRenderer.create(canvas);
  if (renderer === null) console.warn("WebGL 2 is unavailable: the game runs without a picture");
  else if (cmap !== null) renderer.loadMap(cmap);
  if (status !== null) status.webgl = renderer === null ? "0" : "1";
  if (status !== null && cmap !== null) status.map = cmap.name;
  // The simulated link (`?net_profile=`, then the console's `net_profile`), kept current by `run`.
  if (status !== null) status.netProfile = profile.name;
  const client: ClientSim = new ClientSim({
    transport: netsim,
    ...(cmap === null
      ? { onMapRequest: (name, hash) => provideMap(name, hash) }
      : { cmap, world: buildCollisionWorld(cmap) }),
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
      // Nothing rejoins the local server short of a reload: stop its match ticking for nobody.
      worker?.terminate();
    },
  });
  /** WELCOME named the server's map: fetch the bundled file, check its hash, hand it over. */
  function provideMap(name: string, contentHash: string): void {
    void loadServerMap(client, name, contentHash).then((map) => {
      if (map === null) return;
      renderer?.loadMap(map);
      if (status !== null) status.map = map.name;
    });
  }

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
    server,
    connected: () => !client.closed,
    connect: (address) => {
      const next = connectSearch(address, location.search);
      if (!next.ok) return next.error;
      location.search = next.search;
      return null;
    },
    disconnect: () => {
      if (client.closed) return false;
      client.disconnect("left the server");
      return true;
    },
  };
  const run = (line: string) => {
    runConsoleCommand(line, host);
    saver.maybeSave();
    if (status !== null) status.netProfile = netsim.profile().name;
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
  gameConsole.print(`playing on ${server}`);
  if (profileWarning !== null) {
    console.warn(profileWarning);
    gameConsole.print(profileWarning);
  }
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

/**
 * The local server (M2): a module Worker running the match on the map in `bytes`, given a copy of
 * them and the server ends of two MessageChannels; the page talks over the other ends.
 */
function startWorker(
  bytes: Uint8Array,
  buildHash: string,
  onError: (message: string) => void,
): { worker: Worker; transport: PortTransport } {
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
  return { worker, transport: new PortTransport(unreliable.port1, reliable.port1) };
}
