/**
 * @game/client/net: the client's DOM-free net code (M2 design §1): connection, clock, prediction
 * and reconciliation, render offset, stats, the Worker port and WebSocket transports, and scripted
 * input. The browser app, the NET tests and the M3 bots all drive the same `ClientSim`.
 */
export * from "./clientSim";
export * from "./clock";
export * from "./connection";
export * from "./cvars";
export * from "./portTransport";
export * from "./predictor";
export * from "./remotes";
export * from "./scriptedInput";
export * from "./smoothing";
export * from "./snapshotStore";
export * from "./stats";
export * from "./webSocketTransport";
