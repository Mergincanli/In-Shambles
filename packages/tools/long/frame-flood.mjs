// Test-only worker for NET-10 (b)'s frame flood (net-10-floods.long.ts, D-048): one WebSocket
// client on a raw TCP socket, upgraded to `path` on `port`, that then writes tiny masked binary
// frames (1-byte payloads, 7 B each on the wire) as fast as the socket takes them for `ms`, and
// ignores everything the server sends (its KICK and its close included). A worker thread, so the
// flood runs beside the server's event loop instead of on it. Posts {kind: "flooding"} once the
// upgrade is answered 101 and {kind: "done", upgraded, bytes} at the end.
import { connect } from "node:net";
import { parentPort, workerData } from "node:worker_threads";

const { port, path, ms } = workerData;
const FRAME = [0x82, 0x81, 0, 0, 0, 0, 0];
const FRAMES = 9362;
const chunk = Buffer.alloc(FRAME.length * FRAMES);
for (let i = 0; i < FRAMES; i++) chunk.set(FRAME, i * FRAME.length);

const socket = connect({ port, host: "127.0.0.1" });
socket.on("error", () => {});
let head = "";
let upgraded = false;
let bytes = 0;
let end = 0;
let finished = false;

function done() {
  if (finished) return;
  finished = true;
  socket.destroy();
  parentPort?.postMessage({ kind: "done", upgraded, bytes });
}

function pump() {
  while (performance.now() < end) {
    bytes += chunk.length;
    if (!socket.write(chunk)) {
      socket.once("drain", pump);
      return;
    }
  }
  done();
}

socket.on("data", (d) => {
  if (upgraded) return;
  head += d.toString("latin1");
  if (!head.includes("\r\n\r\n")) return;
  upgraded = head.startsWith("HTTP/1.1 101 ");
  if (!upgraded) return done();
  parentPort?.postMessage({ kind: "flooding" });
  end = performance.now() + ms;
  // A server that stops reading leaves the writer waiting for a drain: end it on time anyway.
  setTimeout(done, ms + 50);
  pump();
});
socket.write(
  `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
    "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
);
