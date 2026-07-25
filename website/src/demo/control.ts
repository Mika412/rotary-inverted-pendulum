/**
 * The deployed control loop, ported verbatim.
 *
 * Everything in this file mirrors a specific piece of shipped code, because the
 * demo's claim is that you are watching the real controller, not an
 * illustration of one:
 *
 *   - the observation frame and K=4 stack     → fill_frame/push_frame, RLControl.ino
 *   - the boxcar action smoothing             → RLControl.ino step 4b
 *   - the velocity-mode P-law and rail clamps → RLControl.ino step 5
 *   - the quantised measurement model         → _capture_measured_state, pendulum_env.py
 *   - substep-interpolated position commands  → step(), pendulum_env.py
 *
 * The numeric constants are NOT written here: they are extracted from
 * RLControl.ino and pendulum_env.py at build time (scripts/extract_constants.mjs)
 * so this loop cannot drift from the firmware the way the docs did.
 */

import type { Policy } from './policy.ts';

export interface Constants {
  control: {
    frequencyHz: number;
    maxVelocityRadS: number;
    maxAccelRadS2: number;
    vCmdLambda: number;
    actionSmoothWindow: number;
    obsFrames: number;
    frameDim: number;
  };
  motor: {
    safeLimitRad: number;
    hardLimitRad: number;
    stepLsbRad: number;
  };
  encoder: { lsbRad: number; velWindowS: number };
  physics: { timestepS: number };
}

/** Anything within this of vertical counts as balanced (~20°). */
export const BALANCED_THRESHOLD_RAD = 0.35;

export interface SimState {
  /** True joint angles from the physics, for rendering. */
  motorPosRad: number;
  pendulumPosRad: number;
  /** Angle from upright, signed and wrapped — the honest error metric. */
  thetaRad: number;
  /** Raw policy output this tick, in [-1, 1]. */
  action: number;
  /** Commanded-velocity integrator state (rad/s). */
  vCmdRadS: number;
  balanced: boolean;
  tickCount: number;
  elapsedS: number;
}

export interface Metrics {
  balancedFraction: number;
  longestStreakS: number;
  currentStreakS: number;
  swingUpS: number | null;
}

function wrapPi(a: number): number {
  let x = (a + Math.PI) % (2 * Math.PI);
  if (x < 0) x += 2 * Math.PI;
  return x - Math.PI;
}

/** Minimal structural type for the bits of the MuJoCo binding we use. */
export interface MujocoLike {
  mj_step(model: unknown, data: unknown): void;
  mj_forward(model: unknown, data: unknown): void;
  mj_resetData(model: unknown, data: unknown): void;
}

export interface MjDataLike {
  qpos: { [i: number]: number };
  qvel: { [i: number]: number };
  ctrl: { [i: number]: number };
}

export class PendulumController {
  readonly c: Constants;
  readonly policy: Policy;
  private readonly mujoco: MujocoLike;
  private readonly model: unknown;
  private readonly data: MjDataLike;

  private readonly nSubsteps: number;
  private readonly velWindowSubsteps: number;
  private readonly dt: number;

  // --- control state (mirrors the firmware's statics) ---
  private vCmd = 0;
  private motorTarget = 0;
  private prevCmdPos = 0;
  private lastAction = 0;
  private frames: Float32Array;
  private obs: Float32Array;
  private smoothRing: Float32Array;
  private smoothIdx = 0;

  // --- firmware measurement model ---
  private measCmd: number[] = [];
  private measPen: number[] = [];
  private meas = { motorPos: 0, penPhi: 0, motorVel: 0, penVel: 0 };

  // --- honest metrics, computed on TRUE qpos, never on the observation ---
  private nTicks = 0;
  private nBalanced = 0;
  private streak = 0;
  private longestStreak = 0;
  private swingUpTick: number | null = null;

  constructor(opts: {
    mujoco: MujocoLike;
    model: unknown;
    data: MjDataLike;
    policy: Policy;
    constants: Constants;
  }) {
    this.mujoco = opts.mujoco;
    this.model = opts.model;
    this.data = opts.data;
    this.policy = opts.policy;
    this.c = opts.constants;

    const { control, physics, encoder } = this.c;
    this.dt = 1 / control.frequencyHz;
    this.nSubsteps = Math.round(this.dt / physics.timestepS);
    this.velWindowSubsteps = Math.round(encoder.velWindowS / physics.timestepS);

    const obsDim = control.obsFrames * control.frameDim;
    if (obsDim !== this.policy.obsDim) {
      throw new Error(
        `PendulumController: firmware observation is ${obsDim}-dim but the network ` +
          `expects ${this.policy.obsDim}. The weights and constants are out of sync.`
      );
    }
    this.frames = new Float32Array(obsDim);
    this.obs = this.frames;
    this.smoothRing = new Float32Array(Math.max(1, control.actionSmoothWindow));
  }

  /**
   * Reset to a hanging-at-rest pose, matching the boot sequence: the sketch
   * takes the pendulum's resting position as the encoder zero, then swings up.
   */
  reset(opts: { pendulumAngleRad?: number; motorAngleRad?: number } = {}): void {
    this.mujoco.mj_resetData(this.model, this.data);
    this.data.qpos[0] = opts.motorAngleRad ?? 0;
    // A hair off dead-hanging: exactly 0 is an equilibrium with zero gradient,
    // and the real rig never starts perfectly still either.
    this.data.qpos[1] = opts.pendulumAngleRad ?? 0.02;
    this.data.qvel[0] = 0;
    this.data.qvel[1] = 0;
    this.mujoco.mj_forward(this.model, this.data);

    this.vCmd = 0;
    this.motorTarget = this.data.qpos[0];
    this.prevCmdPos = this.motorTarget;
    this.lastAction = 0;
    this.smoothRing.fill(0);
    this.smoothIdx = 0;

    this.measCmd = [this.motorTarget];
    this.measPen = [this.data.qpos[1]];
    this.captureMeasured();

    this.frames.fill(0);
    this.seedFrames();

    this.nTicks = 0;
    this.nBalanced = 0;
    this.streak = 0;
    this.longestStreak = 0;
    this.swingUpTick = null;
  }

  /**
   * Perturb the pendulum, as a fingertip flick would. Applied as a velocity
   * impulse on the pendulum joint so the policy has to recover from a state it
   * never chose — the most convincing demonstration that it is a controller
   * and not a replayed trajectory.
   */
  nudge(deltaVelRadS: number): void {
    this.data.qvel[1] += deltaVelRadS;
  }

  /** Quantised, windowed finite differences — what the firmware actually reads. */
  private captureMeasured(): void {
    const { motor, encoder } = this.c;
    const iNew = this.measCmd.length - 1;
    const iOld = Math.max(0, iNew - this.velWindowSubsteps);

    const q = (v: number, lsb: number) => Math.round(v / lsb) * lsb;
    const mNew = q(this.measCmd[iNew], motor.stepLsbRad);
    const mOld = q(this.measCmd[iOld], motor.stepLsbRad);
    const pNew = q(this.measPen[iNew], encoder.lsbRad);
    const pOld = q(this.measPen[iOld], encoder.lsbRad);
    const span = Math.max(1, iNew - iOld) * this.c.physics.timestepS;

    this.meas.motorPos = mNew;
    this.meas.penPhi = pNew;
    this.meas.motorVel = (mNew - mOld) / span;
    this.meas.penVel = (pNew - pOld) / span;
  }

  private writeFrame(offset: number, prevAction: number): void {
    const { frameDim } = this.c.control;
    const theta = wrapPi(this.meas.penPhi - Math.PI);
    const f = this.frames;
    f[offset + 0] = this.meas.motorPos;
    f[offset + 1] = Math.sin(theta);
    f[offset + 2] = Math.cos(theta);
    f[offset + 3] = this.meas.motorVel;
    f[offset + 4] = this.meas.penVel;
    if (frameDim > 5) f[offset + 5] = prevAction;
  }

  /** On reset the history is seeded with K copies of the initial frame. */
  private seedFrames(): void {
    const { obsFrames, frameDim } = this.c.control;
    for (let k = 0; k < obsFrames; k++) this.writeFrame(k * frameDim, 0);
  }

  private pushFrame(prevAction: number): void {
    const { obsFrames, frameDim } = this.c.control;
    // Shift left, drop oldest — memmove in the firmware.
    this.frames.copyWithin(0, frameDim, obsFrames * frameDim);
    this.writeFrame((obsFrames - 1) * frameDim, prevAction);
  }

  /** Advance exactly one control tick. */
  step(): SimState {
    const { control, motor } = this.c;

    this.pushFrame(this.lastAction);

    let action = this.policy.forward(this.obs);
    action = action > 1 ? 1 : action < -1 ? -1 : action;
    this.lastAction = action;

    // 4b. Actuator-side boxcar smoothing. The observation carries the RAW
    // action; only the velocity law downstream sees the smoothed one.
    let actionCmd = action;
    if (control.actionSmoothWindow > 1) {
      this.smoothRing[this.smoothIdx] = action;
      this.smoothIdx = (this.smoothIdx + 1) % control.actionSmoothWindow;
      let acc = 0;
      for (let k = 0; k < control.actionSmoothWindow; k++) acc += this.smoothRing[k];
      actionCmd = acc / control.actionSmoothWindow;
    }

    // 5. Velocity-mode P-law on the commanded-velocity integrator. The
    // feedback term is v_cmd, NOT the measured velocity: feeding the
    // quantised measurement back at gain f injects a ±17 rad/s² dither that
    // destroys calm balance on the rig and in sim alike.
    const vDes = actionCmd * control.maxVelocityRadS;
    let accel = (vDes - this.vCmd) * control.frequencyHz;
    accel = Math.max(-control.maxAccelRadS2, Math.min(control.maxAccelRadS2, accel));
    if (this.meas.motorPos >= motor.safeLimitRad && accel > 0) accel = 0;
    else if (this.meas.motorPos <= -motor.safeLimitRad && accel < 0) accel = 0;

    this.vCmd += accel * this.dt;
    this.vCmd = Math.max(
      -control.maxVelocityRadS,
      Math.min(control.maxVelocityRadS, this.vCmd)
    );
    // Slow complementary correction so rail clamps and skipped steps cannot
    // accumulate open-loop error in the integrator.
    this.vCmd += control.vCmdLambda * (this.meas.motorVel - this.vCmd);

    if (this.motorTarget >= motor.safeLimitRad && this.vCmd > 0) this.vCmd = 0;
    else if (this.motorTarget <= -motor.safeLimitRad && this.vCmd < 0) this.vCmd = 0;
    this.motorTarget = Math.max(
      -motor.safeLimitRad,
      Math.min(motor.safeLimitRad, this.motorTarget + this.vCmd * this.dt)
    );

    // The stepper glides continuously through the control period, so the stiff
    // position servo is fed an interpolated ramp. Handing it the tick's final
    // target as a staircase hammers it with one impulse per tick, which is
    // where the historical "kp >= 200 is unstable" ceiling actually came from.
    const cmdStart = this.prevCmdPos;
    const cmdEnd = this.motorTarget;
    for (let k = 0; k < this.nSubsteps; k++) {
      const cmdK = cmdStart + ((cmdEnd - cmdStart) * (k + 1)) / this.nSubsteps;
      this.data.ctrl[0] = cmdK;
      this.mujoco.mj_step(this.model, this.data);
      this.measCmd.push(cmdK);
      this.measPen.push(this.data.qpos[1]);
    }
    const keep = this.velWindowSubsteps + 4;
    if (this.measCmd.length > keep) {
      this.measCmd = this.measCmd.slice(-keep);
      this.measPen = this.measPen.slice(-keep);
    }
    this.prevCmdPos = cmdEnd;
    this.captureMeasured();

    // Metrics on the TRUE joint angle. The observation's upright proxy is
    // spoofable by spinning, which is exactly how earlier evaluations were
    // fooled — so scoring never looks at what the policy sees.
    const theta = wrapPi(this.data.qpos[1] - Math.PI);
    const balanced = Math.abs(theta) < BALANCED_THRESHOLD_RAD;
    this.nTicks++;
    if (balanced) {
      this.nBalanced++;
      this.streak++;
      if (this.streak > this.longestStreak) this.longestStreak = this.streak;
      if (this.swingUpTick === null) this.swingUpTick = this.nTicks;
    } else {
      this.streak = 0;
    }

    return {
      motorPosRad: this.data.qpos[0],
      pendulumPosRad: this.data.qpos[1],
      thetaRad: theta,
      action,
      vCmdRadS: this.vCmd,
      balanced,
      tickCount: this.nTicks,
      elapsedS: this.nTicks * this.dt,
    };
  }

  get metrics(): Metrics {
    const hz = this.c.control.frequencyHz;
    return {
      balancedFraction: this.nTicks === 0 ? 0 : this.nBalanced / this.nTicks,
      longestStreakS: this.longestStreak / hz,
      currentStreakS: this.streak / hz,
      swingUpS: this.swingUpTick === null ? null : this.swingUpTick / hz,
    };
  }

  get controlPeriodS(): number {
    return this.dt;
  }
}

export { wrapPi };
