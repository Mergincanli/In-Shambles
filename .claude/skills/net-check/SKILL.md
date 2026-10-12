---
name: net-check
description: Verify netcode quality and online performance. Use when the user types /net-check, asks to "test the netcode", "check lag/rubber-banding/bandwidth", or after changes to protocol, snapshots, prediction, interpolation, lag compensation, server loop or transports. Runs NET tests across network profiles plus a bot session and compares against budgets.
argument-hint: "[optional: profile name or 'all']"
---

# Net check

1. **Run the tests.** Run `pnpm test:net`: the fast NET smokes, then the long NET legs (the same as `pnpm test:long -t "^NET-"`). On a quiet host, also run `pnpm build && pnpm test:load` for NET-09 and the 16 bots + 1 human check (its host gate fails a busy host; D-045).
2. **Run bot sessions**, one per profile. Use the profile named in `$ARGUMENTS`; otherwise use `wan-100-loss1` and `wan-150-loss2`:
   `pnpm bots --count 16 --profile <p> --minutes 2 --map arena_greybox`
3. **Collect** from each bot summary:
   - tick time p50/p99 and maximum GC pause
   - bytes up/down per client and snapshot size p95
   - corrections per second and mean correction distance
   - starved commands and input buffer health
4. **Compare** against `docs/10-testing-and-performance.md` §4 and `docs/05-netcode.md` §14.
5. **Report** a table: metric | budget | measured | status. List regressions against the previous handoff if it recorded these metrics.
6. **Diagnose failures.** Name the likely subsystem and propose next diagnostic steps (e.g. capture with `record`, inspect delta sizes per entity kind). If code changed, delegate a review to `netcode-reviewer`.
