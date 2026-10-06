/**
 * What the page and the server Worker say to each other outside the game protocol (M2 design §1
 * src/worker): one start message down, logs and errors up. The game itself travels over the two
 * MessageChannel ports in `start`, through PortTransport, exactly as it would over a network.
 */

/** Page → Worker, once: the map and the ports of the client's two channels. */
export interface WorkerStartMsg {
  readonly type: "start";
  /** A copy of the .cmap file's bytes (transferred). */
  readonly cmap: ArrayBuffer;
  /** The page's build; HELLO must carry the same one. */
  readonly buildHash: string;
  /** DEV_ASSERTs on (dev builds). */
  readonly devAsserts: boolean;
  /** The server's ends of the unreliable and reliable channels (transferred). */
  readonly unreliable: MessagePort;
  readonly reliable: MessagePort;
}

/** Worker → page: a server log line. */
export interface WorkerLogMsg {
  readonly type: "log";
  readonly level: "info" | "warn" | "error";
  readonly msg: string;
}

/** Worker → page: the server failed (start or tick threw); it has stopped. */
export interface WorkerErrorMsg {
  readonly type: "error";
  readonly message: string;
}

export type WorkerOutMsg = WorkerLogMsg | WorkerErrorMsg;
