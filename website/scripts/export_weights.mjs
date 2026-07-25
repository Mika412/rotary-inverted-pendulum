/**
 * Export the on-device policy weights from the committed PROGMEM header into
 * JSON the browser demo can load.
 *
 * The demo's whole claim is "this is the network that is flashed on the Nano",
 * so the weights are read from RLControl/policy_weights.h — the exact file
 * arduino-cli compiles — rather than from a separately-exported copy that
 * could drift from it.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, '..');
const REPO = path.resolve(SITE, '..');
const WEIGHTS = 'RotaryInvertedPendulum-arduino/RLControl/policy_weights.h';

const FLOAT = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?f?/g;

/**
 * Read one PROGMEM array. Matrices are brace-per-row (`{ {...}, {...} }`);
 * bias vectors are a flat brace-less list. Returns number[][] either way,
 * with a bias vector shaped as a single row.
 */
function readArray(src, name) {
  const re = new RegExp(
    `POLICY_${name}\\s*(?:\\[[^\\]]*\\])+\\s*PROGMEM\\s*=\\s*\\{([\\s\\S]*?)\\n\\s*\\};`
  );
  const m = src.match(re);
  if (!m) throw new Error(`export_weights: POLICY_${name} not found in ${WEIGHTS}`);

  const body = m[1];
  const rows = [...body.matchAll(/\{([^}]*)\}/g)].map((r) =>
    [...r[1].matchAll(FLOAT)].map((x) => parseFloat(x[0]))
  );
  if (rows.length > 0) return rows;
  return [[...body.matchAll(FLOAT)].map((x) => parseFloat(x[0]))];
}

function expectShape(arr, rows, cols, name) {
  if (arr.length !== rows || arr.some((r) => r.length !== cols)) {
    const got = `${arr.length}x${arr[0]?.length ?? 0}`;
    throw new Error(`export_weights: POLICY_${name} is ${got}, expected ${rows}x${cols}`);
  }
}

export async function exportWeights() {
  const src = await fs.readFile(path.join(REPO, WEIGHTS), 'utf8');

  const obsDim = Number(src.match(/#define\s+POLICY_OBS_DIM\s+(\d+)/)?.[1]);
  const hidden = Number(src.match(/#define\s+POLICY_HIDDEN_DIM\s+(\d+)/)?.[1]);
  const outDim = Number(src.match(/#define\s+POLICY_OUT_DIM\s+(\d+)/)?.[1]);
  if (!obsDim || !hidden || !outDim) {
    throw new Error(`export_weights: could not read POLICY_*_DIM from ${WEIGHTS}`);
  }

  const w1 = readArray(src, 'W1');
  const b1 = readArray(src, 'B1')[0];
  const w2 = readArray(src, 'W2');
  const b2 = readArray(src, 'B2')[0];
  const w3 = readArray(src, 'W3');
  const b3 = readArray(src, 'B3')[0];

  expectShape(w1, hidden, obsDim, 'W1');
  expectShape(w2, hidden, hidden, 'W2');
  expectShape(w3, outDim, hidden, 'W3');
  for (const [vec, n, name] of [
    [b1, hidden, 'B1'],
    [b2, hidden, 'B2'],
    [b3, outDim, 'B3'],
  ]) {
    if (vec.length !== n) {
      throw new Error(`export_weights: POLICY_${name} has ${vec.length} entries, expected ${n}`);
    }
  }

  const count =
    hidden * obsDim + hidden + hidden * hidden + hidden + outDim * hidden + outDim;
  const claimed = Number(src.match(/\/\/\s*params:\s*(\d+)/)?.[1]);
  if (claimed && claimed !== count) {
    throw new Error(
      `export_weights: parsed ${count} parameters but the header claims ${claimed}. ` +
        `Parsing is incomplete — the demo would run a different network than the Nano.`
    );
  }

  // Guard against a silently-truncated parse producing an all-zero layer.
  for (const [mat, name] of [
    [w1, 'W1'],
    [w2, 'W2'],
    [w3, 'W3'],
  ]) {
    if (mat.every((row) => row.every((v) => v === 0))) {
      throw new Error(`export_weights: POLICY_${name} parsed as all zeros`);
    }
    if (mat.some((row) => row.some((v) => !Number.isFinite(v)))) {
      throw new Error(`export_weights: POLICY_${name} contains a non-finite value`);
    }
  }

  return {
    _source: {
      note: 'Auto-extracted. Regenerate with website/scripts/export_weights.mjs.',
      file: WEIGHTS,
      generated: src.match(/\/\/\s*generated:\s*(\S+)/)?.[1] ?? null,
      distilledFrom: src.match(/\/\/\s*source:\s*(.+)/)?.[1]?.trim() ?? null,
    },
    obsDim,
    hidden,
    outDim,
    paramCount: count,
    // ReLU, ReLU, tanh — matching policy_forward() in RLControl.ino.
    w1,
    b1,
    w2,
    b2,
    w3,
    b3,
  };
}

export async function writeWeights() {
  const weights = await exportWeights();
  const outDir = path.join(SITE, 'public/sim');
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'policy.json'), JSON.stringify(weights), 'utf8');
  console.log(
    `export_weights: ${weights.obsDim}→${weights.hidden}→${weights.hidden}→${weights.outDim}, ` +
      `${weights.paramCount} params`
  );
  return weights;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await writeWeights();
}
