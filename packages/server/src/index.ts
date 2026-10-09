/**
 * @game/server's package entry: the environment-agnostic match code only (D-027), which the
 * client's Worker runs and the tools' integration tests drive. The Node process entry (main.ts)
 * stays out of it, so importing this never pulls in Node APIs.
 */
export * from "./match/commands";
export * from "./match/history";
export * from "./match/host";
export * from "./match/inputQueue";
export * from "./match/loop";
export * from "./match/match";
export * from "./match/mirror";
export * from "./match/scheduler";
export * from "./match/session";
export * from "./match/spawns";
export * from "./match/tickStats";
