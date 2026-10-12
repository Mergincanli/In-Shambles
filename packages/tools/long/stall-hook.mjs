// Test-only preload for server-stall.long.ts (`node --import <this>`): on SIGUSR2 the server's
// event loop blocks for STALL_MS inside the signal's callback, a JS-side stall like a GC or a long
// I/O callback. Socket data that arrives meanwhile waits for the next poll, while the match loop's
// timer is overdue by then (D-027).
const stallMs = Number(process.env.STALL_MS ?? "90");

process.on("SIGUSR2", () => {
  const end = performance.now() + stallMs;
  let spins = 0;
  while (performance.now() < end) spins++;
  return spins;
});
