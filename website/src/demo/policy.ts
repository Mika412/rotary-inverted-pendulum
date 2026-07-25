/**
 * The deployed policy's forward pass.
 *
 * A faithful port of `policy_forward()` in RLControl.ino: two ReLU hidden
 * layers and a tanh output, with the weights read from the same PROGMEM header
 * the Nano is flashed with. The network is 689 parameters, so a plain nested
 * loop is far cheaper than any tensor library — a full forward pass is a few
 * microseconds, versus the ~8 ms it takes the ATmega328.
 */

export interface PolicyWeights {
  obsDim: number;
  hidden: number;
  outDim: number;
  paramCount: number;
  w1: number[][];
  b1: number[];
  w2: number[][];
  b2: number[];
  w3: number[][];
  b3: number[];
  _source?: { file?: string; generated?: string | null };
}

export class Policy {
  readonly obsDim: number;
  readonly hidden: number;
  readonly paramCount: number;
  readonly source?: PolicyWeights['_source'];

  // Flattened weights in Float32Array: same precision as the AVR's float, and
  // contiguous so the hot loop stays cache-friendly.
  private readonly w1: Float32Array;
  private readonly b1: Float32Array;
  private readonly w2: Float32Array;
  private readonly b2: Float32Array;
  private readonly w3: Float32Array;
  private readonly b3: number;

  private readonly h1: Float32Array;
  private readonly h2: Float32Array;

  constructor(weights: PolicyWeights) {
    this.obsDim = weights.obsDim;
    this.hidden = weights.hidden;
    this.paramCount = weights.paramCount;
    this.source = weights._source;

    if (weights.outDim !== 1) {
      throw new Error(`Policy: expected a scalar action, got outDim=${weights.outDim}`);
    }

    this.w1 = new Float32Array(weights.w1.flat());
    this.b1 = new Float32Array(weights.b1);
    this.w2 = new Float32Array(weights.w2.flat());
    this.b2 = new Float32Array(weights.b2);
    this.w3 = new Float32Array(weights.w3[0]);
    this.b3 = weights.b3[0];

    this.h1 = new Float32Array(this.hidden);
    this.h2 = new Float32Array(this.hidden);
  }

  /** obs (length obsDim, oldest frame first) → action in [-1, 1]. */
  forward(obs: Float32Array | number[]): number {
    const { obsDim, hidden, w1, b1, w2, b2, w3, h1, h2 } = this;

    for (let i = 0; i < hidden; i++) {
      let sum = b1[i];
      const row = i * obsDim;
      for (let j = 0; j < obsDim; j++) sum += w1[row + j] * obs[j];
      h1[i] = sum > 0 ? sum : 0;
    }

    for (let i = 0; i < hidden; i++) {
      let sum = b2[i];
      const row = i * hidden;
      for (let j = 0; j < hidden; j++) sum += w2[row + j] * h1[j];
      h2[i] = sum > 0 ? sum : 0;
    }

    let out = this.b3;
    for (let j = 0; j < hidden; j++) out += w3[j] * h2[j];
    return Math.tanh(out);
  }
}

export async function loadPolicy(url: string): Promise<Policy> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`loadPolicy: ${url} → HTTP ${res.status}`);
  return new Policy((await res.json()) as PolicyWeights);
}
