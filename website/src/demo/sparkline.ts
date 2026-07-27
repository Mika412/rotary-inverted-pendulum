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

/** Samples retained. At 50 Hz this is a ~6 s window. */
const WINDOW = 300;

export interface SparklineOptions {
  /** Fixed y-range. Omit either bound to autoscale it from the window. */
  min?: number;
  max?: number;
  /** Autoscaling never shrinks tighter than this, so a flat trace stays flat
   *  instead of amplifying noise to full height. */
  minSpan?: number;
  /** Draw a baseline at this value when it is inside the range. */
  zero?: number;
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
