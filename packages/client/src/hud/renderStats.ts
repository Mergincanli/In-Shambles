/**
 * The renderer panel (`r_stats`): the last frame's draw calls and triangles and the live
 * geometries and textures, from three's `renderer.info`, so the draw-call and texture budgets
 * (docs/08 §16, docs/10 §4.3) can be checked in the page. Text is built at the HUD's ≤ 15 Hz.
 */

/** What the panel reads (GameRenderer implements it). */
export interface RenderStats {
  readonly drawCalls: number;
  readonly frameTriangles: number;
  readonly geometries: number;
  readonly textures: number;
}

/** "render calls 12  tris 3400  geo 9  tex 4". */
export function renderStatsText(s: Readonly<RenderStats>): string {
  return `render calls ${s.drawCalls}  tris ${s.frameTriangles}  geo ${s.geometries}  tex ${s.textures}`;
}

export class RenderStatsPanel {
  constructor(readonly el: HTMLElement) {}

  update(s: Readonly<RenderStats>): void {
    const text = renderStatsText(s);
    if (this.el.textContent !== text) this.el.textContent = text;
  }
}
