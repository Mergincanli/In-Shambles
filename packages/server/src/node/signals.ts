/**
 * The signals that stop the server process gracefully (D-029, D-051): SIGINT (Ctrl+C) and SIGTERM
 * everywhere; on Windows also SIGBREAK (Ctrl+Break) and SIGHUP (its console window closing, after
 * which Windows ends the process within about 10 s, time enough for the shutdown). Elsewhere SIGHUP
 * keeps its default. Windows delivers no SIGTERM a handler sees (`kill` there ends the process at
 * once): a parent stops the server with the stdin `quit` instead.
 */
export function stopSignals(platform: NodeJS.Platform): NodeJS.Signals[] {
  return platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"] : ["SIGINT", "SIGTERM"];
}
