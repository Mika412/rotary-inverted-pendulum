/**
 * A rolling strip chart, sized for a stat tile.
 *
 * The demo's numbers change 50 times a second, which is unreadable as text —
 * you see flicker, not behaviour. A trace shows the thing that actually
 * matters: whether the pendulum is holding steady, hunting, or falling.
 *
 * Canvas 2D rather than SVG: these redraw every animation frame, and four of
 * them mutating DOM at 60 Hz is the kind of thing that shows up in a scroll
 * jank profile.
 */

/**
 * Samples retained; one sample per control tick, so at 50 Hz this is a 1.5 s
 * window — a little longer than one swing-up.
 *
 * Tied to the tile width on purpose. All six tiles sit in one row, which makes
 * each about 160 px of canvas, and holding roughly two pixels per sample is
 * what keeps the K-frame highlight a visible sliver rather than a hairline.
 * Widening the row (fewer tiles per row) wants this raised in proportion.
 */
export const WINDOW = 75;

export interface SparklineOptions {
  /** Fixed y-range. Omit either bound to autoscale it from the window. */
  min?: number;
  max?: number;
  /** Autoscaling never shrinks tighter than this, so a flat trace stays flat
   *  instead of amplifying noise to full height. */
  minSpan?: number;
  /** Draw a baseline at this value when it is inside the range. */
  zero?: number;
  /**
   * Shade the most recent N samples. Used to show the K stacked frames the
   * network is actually reading: everything left of the band is history the
   * policy has already forgotten. Drawn at its true width — 4 of 150 samples
   * is a narrow band, and widening it for visibility would be a lie — with a
   * rule on its leading edge so it stays findable.
   */
  highlightLast?: number;
}

export class Sparkline {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly values = new Float32Array(WINDOW);
  private head = 0;
  private filled = 0;
  private cssW = 0;
  private cssH = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly opts: SparklineOptions = {}
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('sparkline: no 2d context');
    this.ctx = ctx;
  }

  push(v: number): void {
    this.values[this.head] = Number.isFinite(v) ? v : 0;
    this.head = (this.head + 1) % WINDOW;
    if (this.filled < WINDOW) this.filled++;
  }

  clear(): void {
    this.head = 0;
    this.filled = 0;
  }

  /** Oldest-to-newest ordering of the ring. */
  private ordered(): number[] {
    const out: number[] = [];
    const start = this.filled < WINDOW ? 0 : this.head;
    for (let i = 0; i < this.filled; i++) out.push(this.values[(start + i) % WINDOW]);
    return out;
  }

  private resize(): boolean {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return false;
    if (w !== this.cssW || h !== this.cssH) {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.cssW = w;
      this.cssH = h;
    }
    return true;
  }

  draw(): void {
    if (!this.resize()) return;
    const { ctx } = this;
    const w = this.cssW;
    const h = this.cssH;
    ctx.clearRect(0, 0, w, h);
    if (this.filled < 2) return;

    const vals = this.ordered();
    let min = this.opts.min ?? Math.min(...vals);
    let max = this.opts.max ?? Math.max(...vals);
    const span = this.opts.minSpan ?? 0;
    if (max - min < span) {
      const mid = (max + min) / 2;
      min = mid - span / 2;
      max = mid + span / 2;
    }
    if (max === min) max = min + 1;

    // Colours come from CSS so the tiles follow the site's light/dark theme
    // without this module knowing anything about it.
    const style = getComputedStyle(this.canvas);
    const line = style.color;
    const grid = style.getPropertyValue('--spark-grid').trim() || 'transparent';

    const y = (v: number) => h - ((v - min) / (max - min)) * h;

    if (this.opts.zero !== undefined && this.opts.zero > min && this.opts.zero < max) {
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y(this.opts.zero));
      ctx.lineTo(w, y(this.opts.zero));
      ctx.stroke();
    }

    // The trace is drawn right-aligned so the newest sample is pinned to the
    // right edge while the window fills, instead of the whole plot stretching.
    const step = w / (WINDOW - 1);
    const x0 = w - (vals.length - 1) * step;

    // The stacked-frame window, behind the trace so it never hides data.
    const k = this.opts.highlightLast ?? 0;
    if (k > 0 && vals.length >= 2) {
      const bandW = Math.min(w, (k - 1) * step);
      const bandX = w - bandW;
      const fill = style.getPropertyValue('--spark-window').trim();
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fillRect(bandX, 0, bandW, h);
      }
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(bandX, 0);
      ctx.lineTo(bandX, h);
      ctx.stroke();
    }
    ctx.strokeStyle = line;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < vals.length; i++) {
      const px = x0 + i * step;
      const py = y(vals[i]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
}
