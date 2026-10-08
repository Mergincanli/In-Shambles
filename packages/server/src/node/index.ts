/**
 * `@game/server/node`: the Node host of the dedicated server (D-029), for the process entry
 * (main.ts) and for tools tests that start a real server in-process. The match code stays behind
 * `@game/server`, free of Node APIs (D-027).
 */

export {
  type ListenerTarget,
  type ListenOptions,
  listen,
  WsListener,
} from "../transport/wsListener";
export { attachWs, WsLimits, type WsSocket, WsTransport } from "../transport/wsTransport";
export { isBundledServer, serverBuildHash } from "./buildHash";
export { type CommandLine, ConfigError, parseCommandLine, parseServerCfg } from "./config";
export { createNodeHost, type PassClock, type ServerMatch, TimedPass } from "./host";
export { createJsonLog, type JsonLog } from "./log";
export { DEFAULT_MATCH, type RunningServer, type StartOptions, startServer } from "./server";
export { DEFAULT_PORT, registerServerCvars } from "./serverCvars";
