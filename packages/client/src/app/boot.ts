import { buildCollisionWorld, CvarRegistry, decodeCmap, registerPmoveCvars } from "@game/shared";
import mapUrl from "../../../../content/maps/movement_lab.cmap?url";
import {
  ClientSim,
  type CmdSampler,
  createScriptedInput,
  NeutralInput,
  PortTransport,
  registerClientNetCvars,
} from "../net";
import { GameRenderer } from "../render/renderer";
import { registerViewCvars } from "../render/viewCvars";
import type { WorkerOutMsg, WorkerStartMsg } from "../worker/messages";
import { Game, type StatusSink } from "./game";
import type { BootParams } from "./params";

export interface Booted {
  readonly game: Game;
  readonly client: ClientSim;
  readonly renderer: GameRenderer | null;
  readonly worker: Worker;
}

/**
 * Starts the game on `canvas` (M2 design §1 app/boot.ts): fetches movement_lab (a `?url` asset,
 * so the build ships the file), decodes it, starts the server Worker with a copy of the bytes and
 * the server ends of two MessageChannels, connects the client over the page's ends, builds the
 * scene and starts the frame loop.
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
  registerClientNetCvars(cvars);
  registerViewCvars(cvars);
  let input: CmdSampler = new NeutralInput();
  if (params.bot !== null) {
    const bot = createScriptedInput(params.bot);
    if (bot === null) console.warn(`unknown bot "${params.bot}"; standing still`);
    else input = bot;
  }
  const client = new ClientSim({
    transport: new PortTransport(unreliable.port1, reliable.port1),
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
  });

  const renderer = GameRenderer.create(canvas);
  if (renderer === null) console.warn("WebGL 2 is unavailable: the game runs without a picture");
  else renderer.loadMap(cmap);
  if (status !== null) status.webgl = renderer === null ? "0" : "1";

  const game = new Game({ client, renderer, status, camera: params.camera });
  client.connect();
  game.start();
  return { game, client, renderer, worker };
}
