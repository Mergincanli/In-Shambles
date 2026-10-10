import { CvarFlag, type CvarRegistry, MATCH_MAX_CLIENTS } from "@game/shared";
import { MATCH_DEFAULT_MAX_CLIENTS } from "../match/match";

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
    name: "sv_maxClients",
    type: "int",
    // design (D-034, Mustafa's decision: "Cap 64, default 32"); above 37 the byte-budget
    // scheduler keeps every snapshot within 1100 B (D-046).
    default: MATCH_DEFAULT_MAX_CLIENTS,
    min: 1,
    max: MATCH_MAX_CLIENTS,
    description: "Players the match admits (client ids are the lowest free below it)",
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
    name: "sv_metricsInterval",
    type: "int",
    default: 10, // design (D-029)
    min: 0,
    max: 3600,
    description: "Seconds between the metrics log lines (0 = none)",
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
  // Session security (D-041, M3 design §2.13): timeouts in ticks, strike levels, rate limits and
  // the listener's admission limits. Read when the server starts; every match shares them.
  reg.register({
    name: "sv_timeout",
    type: "int",
    default: 300, // design (docs/05 §2: 5 s without a packet)
    min: 60,
    max: 36000,
    description: "Ticks without a packet after which a welcomed or playing client is KICKed",
    flags: CvarFlag.SERVER,
  });
  reg.register({
    name: "sv_helloTimeout",
    type: "int",
    default: 120, // ESTIMATE (D-041: 2 s to say HELLO)
    min: 10,
    max: 3600,
    description: "Ticks a new connection has to send HELLO before it is KICKed",
    flags: CvarFlag.SERVER,
  });
  reg.register({
    name: "sv_handshakeTimeout",
    type: "int",
    default: 600, // ESTIMATE (D-041: 10 s from connect to READY)
    min: 60,
    max: 36000,
    description: "Ticks a connection has from opening to READY before it is KICKed",
    flags: CvarFlag.SERVER,
  });
  reg.register({
    name: "sv_starveNeutralTicks",
    type: "int",
    default: 30, // ESTIMATE (D-041: a silent player stands still after 0.5 s)
    min: 1,
    max: 600,
    description: "Starved ticks in a row that repeat the last cmd before a neutral one",
    flags: CvarFlag.SERVER,
  });
  reg.register({
    name: "sv_strikeWarn",
    type: "int",
    default: 15, // ESTIMATE (D-041)
    min: 1,
    max: 10000,
    description: "Strike score at which a client is warned once (PRINT)",
    flags: CvarFlag.SERVER,
  });
  reg.register({
    name: "sv_strikeKick",
    type: "int",
    default: 30, // ESTIMATE (D-041)
    min: 2,
    max: 10000,
    description: "Strike score at which a client is KICKed for too many bad packets",
    flags: CvarFlag.SERVER,
  });
  reg.register({
    name: "sv_inputBurst",
    type: "int",
    // ESTIMATE (D-041): the 64-packet anchor fill plus a 2 s TCP stall. The floor (docs/05 §12) is
    // the fill alone: near it an honest client on a jittery link can be struck after a stall.
    default: 240,
    min: 64,
    max: 4096,
    description: "Unreliable packets a client may send in one burst (refill 2 a tick)",
    flags: CvarFlag.SERVER,
  });
  reg.register({
    name: "sv_reliableBurst",
    type: "int",
    default: 20, // ESTIMATE (D-041)
    min: 8,
    max: 1024,
    description: "Reliable messages a client may send in one burst (refill 0.25 a tick)",
    flags: CvarFlag.SERVER,
  });
  reg.register({
    name: "sv_maxPerIp",
    type: "int",
    default: 8, // ESTIMATE (D-041)
    min: 1,
    max: 1024,
    description: "Connections (open or upgrading) one address may hold; loopback is exempt",
    flags: CvarFlag.SERVER,
  });
  reg.register({
    name: "sv_allowedOrigins",
    type: "string",
    default: "", // design (D-041: any)
    description:
      "Comma-separated browser origins allowed to connect, compared lowercase and without a " +
      "trailing slash (empty = any; no Origin header passes)",
    flags: CvarFlag.SERVER,
  });
}
