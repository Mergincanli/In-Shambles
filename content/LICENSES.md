# Third-party content and licenses

Every third-party asset, font or library that ships with the game is listed here, with a license that allows web distribution (`.claude/rules/content-and-ip.md`, `docs/08` ART-08). Original work by the team is not listed. The client build also writes the bundled libraries' full notices to `third-party-licenses.md` next to the page (`packages/client/vite.config.ts`); `packages/tools/test/guards/licenses.test.ts` checks that every shipped runtime dependency has a row.

| Asset | Source | License | Author | Used in |
|---|---|---|---|---|
| three (library) | https://threejs.org (npm `three`) | MIT | three.js authors | `packages/client` renderer; the build ships the notice in `third-party-licenses.md` |
