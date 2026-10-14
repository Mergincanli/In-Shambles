import { type Cmap, decodeCmap } from "@game/shared";

/**
 * Every compiled map, bundled as a file (D-031): the build ships each `content/maps/*.cmap` under
 * a hashed name, and the page fetches the one a server's WELCOME names. Keyed by map name.
 */
const MAP_URLS: ReadonlyMap<string, string> = (() => {
  const urls = import.meta.glob<string>("../../../../content/maps/*.cmap", {
    query: "?url",
    import: "default",
    eager: true,
  });
  const byName = new Map<string, string>();
  for (const [path, url] of Object.entries(urls)) {
    const name = /([^/]+)\.cmap$/.exec(path)?.[1];
    if (name !== undefined) byName.set(name, url);
  }
  return byName;
})();

/** The names of the maps this build ships, sorted. */
export function bundledMaps(): string[] {
  return [...MAP_URLS.keys()].sort();
}

/** The URL of a bundled map, or undefined when this build has no map of that name. */
export function mapUrl(name: string): string | undefined {
  return MAP_URLS.get(name);
}

/** The local server's map when the page names none (M2): the movement course. */
export const DEFAULT_WORKER_MAP = "movement_lab";

/** The map the local server runs, and why it is not the one asked for (null when it is). */
export interface WorkerMapChoice {
  readonly name: string;
  readonly warning: string | null;
}

/**
 * The map the local server (Worker) runs for `?map=<course>` (D-063): one of the maps this build
 * ships, looked up by name, so the parameter can name a course but never a path or a URL. Absent
 * (null), it is the movement course; a name this build lacks falls back to it with a warning, as
 * an unknown `?net_profile=` falls back to `lan`. A dedicated server picks its own map
 * (`pnpm dev:server --map`), so with `?connect=` the parameter is ignored with a warning.
 */
export function chooseWorkerMap(requested: string | null, connect: string | null): WorkerMapChoice {
  if (requested === null) return { name: DEFAULT_WORKER_MAP, warning: null };
  const bundled = mapUrl(requested) !== undefined;
  if (connect !== null) {
    // Only a bundled name goes into the suggested command: the URL is anyone's to write.
    const hint = bundled ? ` (pnpm dev:server --map ${requested})` : "";
    return {
      name: DEFAULT_WORKER_MAP,
      warning: `?map=${JSON.stringify(requested)} is ignored: it picks the local server's map, and a dedicated server runs its own${hint}`,
    };
  }
  if (bundled) return { name: requested, warning: null };
  return {
    name: DEFAULT_WORKER_MAP,
    warning: `unknown map ${JSON.stringify(requested)} (this client has ${bundledMaps().join(", ")}); playing ${DEFAULT_WORKER_MAP}`,
  };
}

/** A downloaded map: decoded, and its file's bytes (the Worker gets a copy). */
export interface MapFile {
  readonly cmap: Cmap;
  readonly bytes: Uint8Array;
}

/**
 * Downloads and decodes the bundled map `name`. With `contentHash` (WELCOME's, D-031) the file
 * must have that hash: another one means this build ships a different version of the map than
 * the server runs. Throws an Error that says which.
 */
export async function fetchMap(name: string, contentHash?: string): Promise<MapFile> {
  const url = mapUrl(name);
  if (url === undefined) {
    throw new Error(`this client has no map ${name} (it has ${bundledMaps().join(", ")})`);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`map ${name}: download failed: ${res.status} ${res.statusText}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const cmap = decodeCmap(bytes);
  if (cmap.name !== name) throw new Error(`map file ${name} holds map ${cmap.name}`);
  if (contentHash !== undefined && cmap.contentHash !== contentHash) {
    throw new Error(
      `map ${name}: the server runs version ${contentHash}, this client has ${cmap.contentHash}`,
    );
  }
  return { cmap, bytes };
}

/** What `loadServerMap` hands the map to: the client (`ClientSim`). */
export interface MapTaker {
  provideMap(cmap: Cmap): string | null;
  disconnect(reason: string): void;
}

/**
 * Fetches the map a server's WELCOME named and hands it to `client` (D-031). Resolves with the
 * map once the client took it, or null when the session ended instead: a map this build lacks,
 * another version, a failed download (the session ends with that reason), or the client's own
 * refusal (which ends it itself).
 */
export async function loadServerMap(
  client: MapTaker,
  name: string,
  contentHash: string,
  load: (name: string, contentHash: string) => Promise<MapFile> = fetchMap,
): Promise<Cmap | null> {
  let file: MapFile;
  try {
    file = await load(name, contentHash);
  } catch (e) {
    client.disconnect(e instanceof Error ? e.message : String(e));
    return null;
  }
  return client.provideMap(file.cmap) === null ? file.cmap : null;
}
