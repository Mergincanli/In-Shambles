import { defineConfig } from "vite";
import { computeBuildHash } from "../../scripts/build-hash.mjs";

export default defineConfig({
  define: {
    // The one build hash every part agrees on (D-031): the server's bundle and its run from
    // source take it from the same script, so a page and a server of one checkout match.
    __BUILD_HASH__: JSON.stringify(computeBuildHash()),
  },
  server: {
    port: 5173,
  },
  build: {
    // Maps ship as files (app/maps.ts imports content/maps/*.cmap with ?url), never as data: URIs.
    assetsInlineLimit: (file) => (file.endsWith(".cmap") ? false : undefined),
    // three.js alone is about 600 kB minified; one chunk for now (code splitting is a later call).
    chunkSizeWarningLimit: 1024,
    // The minifier strips the libraries' @license headers; this file ships their notices instead
    // (MIT and the like require it; content/LICENSES.md lists the same libraries).
    license: { fileName: "third-party-licenses.md" },
  },
  // The server Worker is a module worker (boot.ts); its chunk keeps ES module format.
  worker: {
    format: "es",
  },
});
