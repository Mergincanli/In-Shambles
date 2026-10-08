import { CvarFlag, type CvarRegistry } from "@game/shared";

/** The dedicated server's default port (D-029; design value). */
export const DEFAULT_PORT = 28700;

/**
 * The Node server's own settings (docs/06 §8; SERVER, never replicated): read when the server
 * starts, from `server.cfg` and the command line. Labels as in the M3 design §4.
 */
export function registerServerCvars(reg: CvarRegistry): void {
  reg.register({
    name: "sv_port",
    type: "int",
    default: DEFAULT_PORT, // design (D-029)
    min: 0,
    max: 65535,
    description: "TCP port of the WebSocket listener and the /status and /metrics pages (0 = any)",
    flags: CvarFlag.SERVER,
  });
  reg.register({
    name: "sv_host",
    type: "string",
    default: "0.0.0.0", // design
    description: "Address the listener binds",
    flags: CvarFlag.SERVER,
  });
  reg.register({
    name: "sv_map",
    type: "string",
    default: "arena_greybox", // design
    description: "Map of the server's match (content/maps/<name>.cmap)",
    flags: CvarFlag.SERVER,
  });
  reg.register({
    name: "sv_strictBuild",
    type: "int",
    // design (D-031): a mismatched build is KICKed. From source (tsx) startServer starts it at 0
    // (a PRINT warning instead), since a dev page and a dev server rebuild at different times.
    default: 1,
    min: 0,
    max: 1,
    description:
      "1: KICK a client whose build hash differs from the server's; 0: warn and let it in",
    flags: CvarFlag.SERVER,
  });
  reg.register({
    name: "sv_sendBufferDrop",
    type: "int",
    default: 32768, // ESTIMATE (D-030)
    min: 1024,
    max: 16777216,
    description: "Bytes waiting in a client's socket past which unreliable sends are dropped",
    flags: CvarFlag.SERVER,
  });
  reg.register({
    name: "sv_sendBufferClose",
    type: "int",
    default: 1048576, // ESTIMATE (D-030)
    min: 1024,
    max: 268435456,
    description: "Bytes waiting in a client's socket past which it is closed as too slow",
    flags: CvarFlag.SERVER,
  });
}
