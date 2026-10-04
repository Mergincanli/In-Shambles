# In Shambles

A browser-native multiplayer first-person shooter with fast, tactical movement and realistic gunplay. *In Shambles* is a working title (D-014).

It runs on our own Quake-3-style engine, written from scratch in TypeScript: a server-authoritative simulation that runs identically on the server and in the browser.

## Requirements

- Node.js 24 LTS (22.12 or newer works)
- pnpm 10: run `corepack enable` once, and pnpm picks up the version pinned in `package.json`

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
| `pnpm dev` | Client dev server on http://localhost:5173 |
| `pnpm dev:server` | Dedicated server from source (stop with Ctrl+C) |
| `pnpm build` | Production client build and server bundle (`packages/server/dist/main.js`) |
| `pnpm test` | All tests |
| `pnpm test:balance` | Balance tests (BAL-xx) |
| `pnpm typecheck` | Type-check all packages |
| `pnpm lint` | Biome lint and format check |
| `pnpm format` | Apply Biome formatting and safe fixes |

Commands for later milestones (`test:movement`, `test:net`, `bench`, `bots`, `feel-report`, `balance-report`, `mapc`) already exist and print the milestone that adds them. `CLAUDE.md` has the full list.

## Layout

| Path | Contents |
|---|---|
| `packages/shared` | Pure simulation code shared by server and client |
| `packages/server` | Dedicated Node server |
| `packages/client` | Browser client (Vite, Three.js) |
| `packages/tools` | Map compiler, bots, reports, content checks |
| `content/` | Weapon data, names, maps, licenses |
| `docs/` | Specs, roadmap, decision log, session handoffs |
| `prompts/` | Milestone prompts for Claude Code |
| `.claude/` | Claude Code rules, skills and agents |

New here? Read `START_HERE.md`. Milestone status lives in `docs/09-roadmap.md`.

## License

All rights reserved: a placeholder until the license decision (O-5). See `LICENSE`.
