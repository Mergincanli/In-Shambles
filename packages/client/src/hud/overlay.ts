import type { ClientSettings } from "../console/clientCvars";
import type { NetProfileControl } from "../console/commands";
import type { ClientSim } from "../net";
import { teamColor } from "../render/teamColors";
import { Netgraph } from "./netgraph";
import { type RenderStats, RenderStatsPanel } from "./renderStats";
import { Speedometer } from "./speedometer";

/** The panels (speedometer, netgraph) refresh at most this often, ms (≤ 15 Hz, client-render). */
export const HUD_PANEL_INTERVAL_MS = 1000 / 15;

/** What the frame loop hands the HUD (app/game.ts calls it once per frame). */
export interface GameHud {
  frame(client: ClientSim, settings: Readonly<ClientSettings>, underwater: boolean): void;
}

/** What demo playback hands the HUD (app/demoGame.ts, D-044). */
export interface DemoHud {
  /** The followed player's id (−1: nobody) and team; the line changes only when they do. */
  follow(id: number, team: number): void;
}

function div(parent: HTMLElement, id: string, text = ""): HTMLDivElement {
  const el = parent.ownerDocument.createElement("div");
  el.id = id;
  el.textContent = text;
  parent.append(el);
  return el;
}

/**
 * The DOM overlay over the canvas (docs/06 §7 "HUD", M2 design §2): crosshair, the underwater
 * tint, the click-to-play prompt, the speedometer, the netgraph and the renderer panel. Updated imperatively: the
 * tint and the toggles only when they change, the panels' text at ≤ 15 Hz. It reads the
 * prediction and the stats and never changes them.
 */
export class Hud implements GameHud, DemoHud {
  readonly root: HTMLDivElement;
  readonly speedometer: Speedometer;
  readonly netgraph: Netgraph;
  readonly renderPanel: RenderStatsPanel;
  private readonly crosshair: HTMLDivElement;
  private readonly tint: HTMLDivElement;
  private readonly prompt: HTMLDivElement;
  /** Demo playback's "following #id" line (D-044), hidden outside it. */
  private readonly followLine: HTMLDivElement;
  private followId = -1;
  private followTeam = -1;
  private lastPanels = Number.NEGATIVE_INFINITY;
  private underwater = false;
  private showSpeed = false;
  private showNet = false;
  private showRender = false;

  constructor(
    parent: HTMLElement,
    private readonly net: NetProfileControl | null,
    /** The renderer's figures for `r_stats`; null without a picture. */
    private readonly render: RenderStats | null = null,
  ) {
    this.root = div(parent, "hud");
    this.tint = div(this.root, "hud-water");
    this.crosshair = div(this.root, "hud-crosshair");
    this.speedometer = new Speedometer(div(this.root, "hud-speed"));
    this.netgraph = new Netgraph(div(this.root, "hud-net"));
    this.renderPanel = new RenderStatsPanel(div(this.root, "hud-render"));
    this.prompt = div(this.root, "hud-prompt", "Click to play");
    this.followLine = div(this.root, "hud-follow");
    this.followLine.hidden = true;
    this.tint.hidden = true;
    this.speedometer.el.hidden = true;
    this.netgraph.el.hidden = true;
    this.renderPanel.el.hidden = true;
    this.prompt.hidden = true;
  }

  /** Demo playback: "following #id" in the player's team colour, hidden while nobody is. */
  follow(id: number, team: number): void {
    if (id === this.followId && team === this.followTeam) return;
    this.followId = id;
    this.followTeam = team;
    const line = this.followLine;
    line.hidden = id < 0;
    if (id < 0) return;
    line.textContent = `following #${id}`;
    line.style.color = `#${teamColor(team).toString(16).padStart(6, "0")}`;
  }

  /** Shows or hides the click-to-play prompt (no pointer lock, console closed). */
  setPrompt(visible: boolean): void {
    if (this.prompt.hidden === visible) this.prompt.hidden = !visible;
  }

  /** Whether the crosshair shows (hidden while the prompt or console covers the view). */
  setCrosshair(visible: boolean): void {
    if (this.crosshair.hidden === visible) this.crosshair.hidden = !visible;
  }

  frame(client: ClientSim, settings: Readonly<ClientSettings>, underwater: boolean): void {
    if (underwater !== this.underwater) {
      this.underwater = underwater;
      this.tint.hidden = !underwater;
    }
    const speed = settings.speedometer && client.active;
    const net = settings.netgraph;
    if (speed !== this.showSpeed) {
      this.showSpeed = speed;
      this.speedometer.el.hidden = !speed;
    }
    if (net !== this.showNet) {
      this.showNet = net;
      this.netgraph.el.hidden = !net;
    }
    const render = this.render;
    const stats = settings.renderStats && render !== null;
    if (stats !== this.showRender) {
      this.showRender = stats;
      this.renderPanel.el.hidden = !stats;
    }
    if (!speed && !net && !stats) return;
    const now = client.now[0] as number;
    if (now - this.lastPanels < HUD_PANEL_INTERVAL_MS) return;
    this.lastPanels = now;
    if (speed) this.speedometer.update(client.predictor.state);
    if (net) this.netgraph.update(client, this.net === null ? null : this.net.profile().name);
    if (stats && render !== null) this.renderPanel.update(render);
  }
}
