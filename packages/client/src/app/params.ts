import type { CameraOverride } from "./game";

/** What the page's URL asks for (M2 design §2 "Autotest hooks", D-031). */
export interface BootParams {
  /** `?autotest=1`: report status into `document.documentElement.dataset`. */
  readonly autotest: boolean;
  /** `?bot=<name>`: a scripted input (scriptedInput.ts) instead of the player's. */
  readonly bot: string | null;
  /** `?cam=x,y,z,yaw,pitch`: a fixed camera (sim u and degrees); ignored unless 5 numbers. */
  readonly camera: CameraOverride | null;
  /**
   * `?connect=ws://host:port`: play on that dedicated server instead of the local one in a Worker
   * (D-031). As written in the URL; `parseServerUrl` checks it.
   */
  readonly connect: string | null;
  /** `?net_profile=<name>`: the simulated link on the client's end from the start (`lan` else). */
  readonly netProfile: string | null;
}

export function parseBootParams(search: string): BootParams {
  const q = new URLSearchParams(search);
  let camera: CameraOverride | null = null;
  const cam = q.get("cam");
  if (cam !== null) {
    const n = cam.split(",").map((part) => (part.trim() === "" ? Number.NaN : Number(part)));
    if (n.length === 5 && n.every(Number.isFinite)) {
      camera = [n[0] as number, n[1] as number, n[2] as number, n[3] as number, n[4] as number];
    }
  }
  return {
    autotest: q.get("autotest") === "1",
    bot: q.get("bot"),
    camera,
    connect: q.get("connect"),
    netProfile: q.get("net_profile"),
  };
}

export type ServerUrl =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly error: string };

/** The dedicated server's default port (`sv_port`, D-029); `game.test.ts` pins it to the server's. */
export const DEFAULT_SERVER_PORT = 28700;

/**
 * A dedicated server's address as `?connect=` and the console's `connect` take it (D-031):
 * `ws://host[:port][/path]`, or `host[:port]` for short; without a port it is the server's
 * default, 28700. `wss://` comes with deployment (M9). A query string or fragment, even an empty
 * one, is refused here, as the server would refuse it (HTTP 404).
 */
export function parseServerUrl(text: string): ServerUrl {
  const raw = text.trim();
  if (raw === "") return { ok: false, error: "no server address" };
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `ws://${raw}`);
  } catch {
    return { ok: false, error: `${raw} is not a server address (ws://host:port)` };
  }
  if (url.protocol === "wss:") {
    return { ok: false, error: "wss:// comes with deployment (M9); use ws://host:port" };
  }
  if (url.protocol !== "ws:") {
    return { ok: false, error: `${raw}: a server address starts with ws://` };
  }
  // URL reports a bare `?` or `#` as empty, but keeps it in `href`.
  if (url.search !== "" || url.hash !== "" || raw.includes("?") || raw.includes("#")) {
    return { ok: false, error: `${raw}: a server address takes no query string or fragment` };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, error: `${raw}: a server address takes no user name or password` };
  }
  // URL drops a port that is the scheme's default (`ws://h:80`), so look at what was written.
  const rest = raw.slice(raw.includes("://") ? raw.indexOf("://") + 3 : 0);
  const slash = rest.indexOf("/");
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  if (!/:\d+$/.test(authority)) url.port = String(DEFAULT_SERVER_PORT);
  return { ok: true, url: url.href };
}

/**
 * The page query that plays on `address` (the console's `connect`, D-031): `search` with
 * `connect` set to the checked URL, everything else kept. A new session starts from a fresh page,
 * so the map, the scene and the prediction all follow the server.
 */
export function connectSearch(
  address: string,
  search: string,
): { readonly ok: true; readonly search: string } | { readonly ok: false; readonly error: string } {
  const target = parseServerUrl(address);
  if (!target.ok) return target;
  const q = new URLSearchParams(search);
  q.set("connect", target.url);
  return { ok: true, search: q.toString() };
}
