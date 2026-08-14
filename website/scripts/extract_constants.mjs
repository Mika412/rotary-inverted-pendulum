/**
 * Extract firmware and simulation constants from their source files.
 *
 * This exists because the docs drifted from the code: docs/end_to_end_runbook.md
 * asserted a 35 Hz control rate — including as a deployment acceptance gate —
 * for weeks after RLControl.ino moved to 50 Hz (commit a019a1b). Any number that
 * both the docs and the browser demo need is read from source here, so the two
 * cannot disagree again.
 *
 * If a constant's declaration is reworded or removed, extraction FAILS LOUDLY
 * rather than silently emitting a stale or undefined value.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// fileURLToPath, not `new URL(...).pathname` — this repo's path contains spaces,
// which the URL pathname percent-encodes into a path that does not exist.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, '..');
const REPO = path.resolve(SITE, '..');

const RLCONTROL = 'firmware/RLControl/RLControl.ino';
// Directory the weights headers live in. Which one is current is decided by the
// sketch, not here — see readWeightsSource().
const SKETCH_DIR = 'firmware/RLControl';
const ENV = 'policy/pendulum_env.py';

/** Pull a `const <type> NAME = <number>;` declaration out of C++ source. */
function cppConst(src, name, file) {
  const re = new RegExp(
    `\\b${name}\\s*=\\s*([-+]?[0-9]*\\.?[0-9]+(?:[eE][-+]?[0-9]+)?)\\s*[fLu]?\\s*;`
  );
  const m = src.match(re);
  if (!m) {
    throw new Error(
      `extract_constants: ${name} not found in ${file}. The declaration was ` +
        `reworded or removed — update scripts/extract_constants.mjs to match.`
    );
  }
  return Number(m[1]);
}

/** Pull a `NAME = <number>` or `NAME = math.radians(<number>)` from Python. */
function pyConst(src, name, file) {
  const rad = src.match(new RegExp(`^${name}\\s*=\\s*math\\.radians\\(([-+0-9.eE]+)\\)`, 'm'));
  if (rad) return (Number(rad[1]) * Math.PI) / 180;

  const plain = src.match(new RegExp(`^${name}\\s*=\\s*([-+]?[0-9]*\\.?[0-9]+(?:[eE][-+]?[0-9]+)?)\\s*$`, 'm'));
  if (plain) return Number(plain[1]);

  throw new Error(
    `extract_constants: ${name} not found in ${file}. Update scripts/extract_constants.mjs.`
  );
}

// The sketch selects its weights header via `#define POLICY_WEIGHTS_H "..."`
// (overridable at compile time with --build-property). The site reads the
// committed default — the reference rig's champion.
export async function readWeightsSource() {
  const ino = await fs.readFile(path.join(REPO, RLCONTROL), 'utf8');
  const m = ino.match(/#define\s+POLICY_WEIGHTS_H\s+"([^"]+)"/);
  if (!m) throw new Error('extract_constants: no POLICY_WEIGHTS_H default in RLControl.ino');
  // Report the file actually read: the header names change as champions are
  // promoted, and provenance that names a fixed path would be a lie.
  const rel = `${SKETCH_DIR}/${m[1]}`;
  return { path: rel, source: await fs.readFile(path.join(REPO, rel), 'utf8') };
}

export async function extractConstants() {
  const ino = await fs.readFile(path.join(REPO, RLCONTROL), 'utf8');
  const { path: WEIGHTS, source: weights } = await readWeightsSource();
  const env = await fs.readFile(path.join(REPO, ENV), 'utf8');

  const microsteps = cppConst(ino, 'MICROSTEPS', RLCONTROL);

  // Network shape: the #define values are authoritative; the header comment
  // carries provenance (which distillation run produced these weights).
  const obsDim = Number(weights.match(/#define\s+POLICY_OBS_DIM\s+(\d+)/)?.[1]);
  const hiddenDim = Number(weights.match(/#define\s+POLICY_HIDDEN_DIM\s+(\d+)/)?.[1]);
  const outDim = Number(weights.match(/#define\s+POLICY_OUT_DIM\s+(\d+)/)?.[1]);
  if (!obsDim || !hiddenDim || !outDim) {
    throw new Error(`extract_constants: could not read POLICY_*_DIM from ${WEIGHTS}`);
  }
  const paramCount = Number(weights.match(/\/\/\s*params:\s*(\d+)/)?.[1]) || null;
  const flashBytes = Number(weights.match(/flash bytes:\s*(\d+)/)?.[1]) || null;
  const valMse = Number(weights.match(/val_mse:\s*([0-9.]+)/)?.[1]) || null;
  const generated = weights.match(/\/\/\s*generated:\s*(\S+)/)?.[1] ?? null;

  const constants = {
    // Provenance — regenerate, do not edit.
    _source: {
      note: 'Auto-extracted from source. See website/scripts/extract_constants.mjs.',
      firmware: RLCONTROL,
      weights: WEIGHTS,
      env: ENV,
    },

    control: {
      // The rate the flashed policy actually runs at. Anything that quotes a
      // control rate in the docs must render this value.
      frequencyHz: cppConst(ino, 'CONTROL_FREQUENCY_HZ', RLCONTROL),
      maxVelocityRadS: cppConst(ino, 'MAX_VELOCITY_RAD_S', RLCONTROL),
      maxAccelRadS2: cppConst(ino, 'MAX_ACCEL_RAD_S2', RLCONTROL),
      vCmdLambda: cppConst(ino, 'V_CMD_LAMBDA', RLCONTROL),
      actionSmoothWindow: cppConst(ino, 'ACTION_SMOOTH_WINDOW', RLCONTROL),
      obsFrames: cppConst(ino, 'OBS_FRAMES', RLCONTROL),
      frameDim: cppConst(ino, 'FRAME_DIM', RLCONTROL),
      actionMode: 'velocity',
    },

    motor: {
      microsteps,
      stepsPerRevolution: 200 * microsteps,
      safeLimitRad: cppConst(ino, 'MOTOR_SAFE_LIMIT_RAD', RLCONTROL),
      hardLimitRad: pyConst(env, 'MOTOR_LIMIT_RAD', ENV),
      stepLsbRad: (2 * Math.PI) / (200 * microsteps),
    },

    encoder: {
      bits: 12,
      counts: 4096,
      lsbRad: (2 * Math.PI) / 4096,
      velWindowS: pyConst(env, 'FIRMWARE_VEL_WINDOW_S', ENV),
    },

    physics: {
      gravity: pyConst(env, 'GRAVITY', ENV),
      armLengthM: pyConst(env, 'ARM_LENGTH_M', ENV),
      armMassKg: pyConst(env, 'ARM_MASS_KG', ENV),
      armComM: pyConst(env, 'ARM_COM_M', ENV),
      timestepS: 0.001,
    },

    policy: {
      obsDim,
      hiddenDim,
      outDim,
      paramCount,
      flashBytes,
      distillValMse: valMse,
      generated,
      architecture: `${obsDim} → ${hiddenDim} → ${hiddenDim} → ${outDim}`,
    },
  };

  // Cross-check: the observation vector the network expects must equal the
  // frame stack the firmware assembles. A mismatch means the flashed weights
  // and the firmware disagree, which would make the demo lie.
  const expected = constants.control.obsFrames * constants.control.frameDim;
  if (expected !== obsDim) {
    throw new Error(
      `extract_constants: OBS_FRAMES × FRAME_DIM = ${expected} but POLICY_OBS_DIM = ${obsDim}. ` +
        `The flashed weights do not match the firmware's observation layout.`
    );
  }

  return constants;
}

export async function writeConstants() {
  const constants = await extractConstants();
  const outDir = path.join(SITE, 'src/generated');
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(
    path.join(outDir, 'constants.json'),
    JSON.stringify(constants, null, 2) + '\n',
    'utf8'
  );
  console.log(
    `extract_constants: ${constants.control.frequencyHz} Hz, ` +
      `${constants.policy.architecture} (${constants.policy.paramCount} params)`
  );
  return constants;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await writeConstants();
}
