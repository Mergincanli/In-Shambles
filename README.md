# In Shambles

A browser-native multiplayer first-person shooter with fast, tactical movement and realistic gunplay. *In Shambles* is a working title (D-014).

It runs on our own Quake-3-style engine, written from scratch in TypeScript: a server-authoritative simulation that runs identically on the server and in the browser.

## Requirements

- Node.js 24 LTS (22.12+ and 26+ also work; these are the versions the toolchain supports)
- pnpm 10: run `corepack enable` once, and pnpm picks up the version pinned in `package.json`. Node 25+ no longer ships corepack: run `npm install -g corepack` first, or install pnpm 10 directly.

## Setup

```sh
git clone https://github.com/Mergincanli/In-Shambles.git
cd In-Shambles
corepack enable
pnpm install
pnpm typecheck && pnpm lint && pnpm test
```

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | The game on http://localhost:5173: the client with the server in a Web Worker (offline loopback) |
| `pnpm dev:server` | Dedicated server from source on port 28700 (stop with Ctrl+C); JSON log lines on stdout |
| `pnpm build` | Production client build and server bundle (`packages/server/dist/main.js`) |
| `pnpm test` | The fast tests (about 40 s); the last line gives the run's wall and CPU time against its budget |
| `pnpm test:long` | The long tier: long deterministic runs and the native-ESM allocation guards (CI runs both) |
| `pnpm test:movement` | Movement tests (MV-xx) on the greybox courses, each printing measured vs. target |
| `pnpm test:net` | Netcode tests (NET-xx): codec checks, and the real match and client net code under the network profiles; NET-04 prints a summary line per profile |
| `pnpm test:balance` | Balance tests (BAL-xx) |
| `pnpm test:browser` | Determinism, trace and pmove vectors in headless browsers (`BROWSERS=chromium,firefox,webkit`, default `chromium`), plus the client e2e smoke test in headless Chromium |
| `pnpm typecheck` | Type-check all packages |
| `pnpm lint` | Biome lint and format check |
| `pnpm format` | Apply Biome formatting and safe fixes |
| `pnpm greybox` | Recompile the greybox courses into `content/maps/` (commit the result) |
| `pnpm bench` | Sim microbenchmarks against the `docs/10` §4.4 budgets (`--strict` exits 1 on a miss) |
| `pnpm feel-report` | Base movement metrics vs. their targets on `movement_lab`; also writes `reports/feel.md` (git-ignored) |
| `pnpm bots --count 16 --profile wan-100-loss1 --minutes 2` | Headless bots over real WebSockets on a server it starts (or `--server ws://host:port`), then a JSON + markdown summary in `reports/bots/` (git-ignored) with PASS/FAIL against the `docs/10` §4 budgets and the prediction's health (`--strict` exits 1 on a FAIL) |

`pnpm dev:server` reads `packages/server/server.cfg` and takes flags such as `--port 0` (any free port), `--map movement_lab` and `--set <cvar>=<value>` (`docs/06` §8). It answers `GET /status` and `GET /metrics` with JSON on its port, logs a `metrics` line every 10 s (`sv_metricsInterval`), writes its metrics to a file at shutdown with `--metrics-out <file>` (`--metrics-discard <s>` leaves the first seconds out), and runs console commands typed on stdin (`set pm_gravity 400`, `metrics reset`). It runs under pnpm, which doesn't forward signals to the server. To stop it from a script or process manager, signal its process group (Ctrl+C does this), or run the bundle directly with `node packages/server/dist/main.js`.

`pnpm test:browser` uses the Playwright browsers already on the machine. `pnpm exec playwright install chromium firefox webkit` downloads them (CI does this), and `CHROMIUM_PATH` points the Chromium run at another build.

`pnpm dev` opens `movement_lab` on the in-browser server. With `pnpm dev:server` running, `?connect=ws://localhost:28700` plays on the dedicated server instead (its map, `arena_greybox` by default), and `?net_profile=wan-100-loss1` starts on a simulated link; the console's `connect <address>` and `disconnect` do the same from inside the game. Add `?bot=circle` to the URL to watch the scripted strafe-jump circuit, `?autotest=1` to have the page report its status in `<html data-*>`, and `?cam=x,y,z,yaw,pitch` for a fixed camera (map units and degrees). `pnpm --filter @game/client screenshot <dir>` saves PNG screenshots of a few viewpoints from the production build (`--dev` uses the dev server); the bot's shots run at 640x360 (`--bot-width`, `--bot-height`), since software WebGL is too slow at full size for the bot to move.

`pnpm --filter @game/client vectors-page <out.html>` builds the determinism vectors page as one self-contained HTML file: open it in any browser (a phone's Safari, say) and it replays every vector table there, showing PASS/FAIL per table. `pnpm dev` also serves it at http://localhost:5173/vectors.html.

Commands for later milestones (`balance-report`, `mapc`) already exist and print the milestone that adds them. `CLAUDE.md` has the full list.

## Try it

1. `pnpm dev`, open http://localhost:5173 and click the view to take the mouse (Escape gives it back).
2. Move with W A S D, jump with Space, crouch with C, walk with X. Mouse sensitivity uses Quake units: `sensitivity` × `m_yaw` (0.022) degrees per count, so a sensitivity from Quake-style games carries over.
3. Backquote opens the console (Backquote or Escape closes it). `help` lists the commands. Some to try:
   - `set cl_speedometer 1` and `set cl_netgraph 1`: speed and movement state, and the link, corrections, input buffer and traffic.
   - `net_profile wan-150-loss2`: play over a simulated 150 ms link with 2% loss (`net_profile` lists the profiles; `lan` is the default). Movement should stay smooth and the netgraph's corrections rare and small.
   - `set pm_gravity 400`: a server cvar; the change goes to the in-browser server and comes back to your prediction without a correction.
   - `set cl_thirdPerson 1` with `set r_debugHull 1`, `set r_debugTraces 1` and `set r_debugGround 1`: the hull, pmove's traces and the ground normal.
   - `bind KeyQ +jump`, `unbind KeyQ`, `cvarlist cl_`.
4. Settings (sensitivity, field of view, HUD toggles, binds) are saved in the browser.
5. On a dedicated server: `pnpm dev:server` in one terminal, `pnpm dev` in another, then open http://localhost:5173/?connect=ws://localhost:28700 to play alone on `arena_greybox` over a real WebSocket.

## Layout

| Path | Contents |
|---|---|
| `packages/shared` | Pure simulation code shared by server and client |
| `packages/server` | Match code (runs in Node and in the browser Worker) and the dedicated Node server |
| `packages/client` | Browser client (Vite, Three.js) |
| `packages/tools` | Map compiler, bots, reports, content checks |
| `content/` | Weapon data, names, maps, licenses |
| `docs/` | Specs, roadmap, decision log, session handoffs |
| `prompts/` | Milestone prompts for Claude Code |
| `.claude/` | Claude Code rules, skills and agents |

New here? Read `START_HERE.md`. Milestone status lives in `docs/09-roadmap.md`.

## License

All rights reserved: a placeholder until the license decision (O-5). See `LICENSE`.
