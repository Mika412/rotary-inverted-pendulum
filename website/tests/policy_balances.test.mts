/**
 * Guard the landing page's central claim: the network flashed on the Nano,
 * running the firmware's control law, balances the pendulum.
 *
 * This runs the SAME modules the browser demo imports — only the MuJoCo handle
 * and the asset loading differ — so if a refactor breaks the control loop, or a
 * newly-exported policy_weights.h does not actually balance, CI fails instead
 * of the front page quietly showing a spinning pendulum.
 *
 *   node --experimental-strip-types tests/policy_balances.test.mts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import loadMujoco from '@mujoco/mujoco';

import { Policy, type PolicyWeights } from '../src/demo/policy.ts';
import { PendulumController, type Constants } from '../src/demo/control.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, '..');

const DURATION_S = 30;

// Thresholds are deliberately below the measured on-rig numbers (0.997
// balanced on the 50 Hz h16-float champion). They exist to catch a BROKEN
// port, not to police policy quality — a real regression in the flashed
// weights should be caught by analyze_onboard.py on the rig.
const MIN_BALANCED_FRACTION = 0.9;
const MAX_SWING_UP_S = 5;

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}\n       ${(err as Error).message}`);
  }
}

const constants = JSON.parse(
  await fs.readFile(path.join(SITE, 'src/generated/constants.json'), 'utf8')
) as Constants;
const weights = JSON.parse(
  await fs.readFile(path.join(SITE, 'public/sim/policy.json'), 'utf8')
) as PolicyWeights;
const xml = await fs.readFile(path.join(SITE, 'public/sim/model.xml'), 'utf8');

const mujoco = await loadMujoco();
const model = mujoco.MjModel.from_xml_string(xml);
const data = new mujoco.MjData(model);

const policy = new Policy(weights);
const controller = new PendulumController({
  mujoco: mujoco as never,
  model,
  data: data as never,
  policy,
  constants,
});

console.log(
  `policy: ${policy.obsDim}→${policy.hidden}→${policy.hidden}→1, ` +
    `${policy.paramCount} params, from ${policy.source?.file ?? 'unknown'}`
);
console.log(`control: ${constants.control.frequencyHz} Hz for ${DURATION_S} s\n`);

controller.reset();
const t0 = process.hrtime.bigint();
const ticks = Math.round(DURATION_S * constants.control.frequencyHz);
let last;
for (let i = 0; i < ticks; i++) last = controller.step();
const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;

const m = controller.metrics;
console.log(
  `simulated ${DURATION_S}s in ${wallMs.toFixed(0)} ms ` +
    `(${((DURATION_S * 1000) / wallMs).toFixed(0)}x realtime)`
);
console.log(
  `balanced=${m.balancedFraction.toFixed(3)} ` +
    `longest=${m.longestStreakS.toFixed(1)}s ` +
    `swingUp=${m.swingUpS === null ? 'never' : m.swingUpS.toFixed(2) + 's'} ` +
    `final|θ|=${Math.abs(last!.thetaRad).toFixed(3)}rad\n`
);

check('the policy swings up', () => {
  assert.notEqual(m.swingUpS, null, 'never reached upright');
  assert.ok(
    m.swingUpS! <= MAX_SWING_UP_S,
    `swing-up took ${m.swingUpS!.toFixed(2)}s, expected <= ${MAX_SWING_UP_S}s`
  );
});

check(`balanced fraction >= ${MIN_BALANCED_FRACTION}`, () => {
  assert.ok(
    m.balancedFraction >= MIN_BALANCED_FRACTION,
    `got ${m.balancedFraction.toFixed(3)}`
  );
});

check('it is still upright at the end', () => {
  assert.ok(
    Math.abs(last!.thetaRad) < 0.35,
    `final |θ| = ${Math.abs(last!.thetaRad).toFixed(3)} rad`
  );
});

check('it stays inside the motor safety rails', () => {
  assert.ok(
    Math.abs(last!.motorPosRad) <= constants.motor.hardLimitRad,
    `motor at ${last!.motorPosRad.toFixed(3)} rad`
  );
});

check('it runs fast enough for a 60 fps browser tab', () => {
  const realtimeFactor = (DURATION_S * 1000) / wallMs;
  assert.ok(realtimeFactor > 5, `only ${realtimeFactor.toFixed(1)}x realtime`);
});

check('it recovers from a hard nudge', () => {
  // A disturbance the policy never chose. This is the interaction the landing
  // page offers, so it is worth asserting rather than hoping.
  controller.nudge(6.0);
  let recovered = false;
  for (let i = 0; i < 8 * constants.control.frequencyHz; i++) {
    const s = controller.step();
    if (i > constants.control.frequencyHz && Math.abs(s.thetaRad) < 0.1) {
      recovered = true;
      break;
    }
  }
  assert.ok(recovered, 'did not return to upright within 8 s of a 6 rad/s nudge');
});

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
