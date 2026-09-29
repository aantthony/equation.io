/**
 * @equation/og-renderer: draws an Equation.io graph to a PNG on the CPU, for
 * link previews (og:image) and anywhere else there is no WebGL.
 *
 * A pure function of the graph's rows: no request, routing or caching logic
 * lives here. The Worker's /api/og/ route decodes the URL, asks canRenderOg,
 * calls renderOgPng and caches the bytes (worker/og-route.ts).
 */
import { encodePng } from './png.ts';
import { OG_HEIGHT, OG_WIDTH, renderRaster } from './render.ts';

export { encodePng } from './png.ts';
export {
  MAX_PLOTS,
  OG_COVERAGE,
  OG_HEIGHT,
  OG_WIDTH,
  type Raster,
  canRenderOg,
  previewGap,
  renderRaster,
} from './render.ts';

export interface OgOptions {
  /** Image width in pixels; default OG_WIDTH. */
  width?: number;
  /** Image height in pixels; default OG_HEIGHT. */
  height?: number;
}

/**
 * The graph's rows (one equation per entry, as in a share link) as PNG bytes.
 * Draws whatever it can; check canRenderOg first to avoid a preview of an
 * empty grid.
 */
export async function renderOgPng(graph: string[], options: OgOptions = {}): Promise<Uint8Array> {
  return encodePng(renderRaster(graph, options.width ?? OG_WIDTH, options.height ?? OG_HEIGHT));
}
