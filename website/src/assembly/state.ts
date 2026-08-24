/**
 * What the scene looks like at the end of a step, and the verbs that say so.
 *
 * A step never describes an animation. It states the state of the scene once it
 * is finished — which parts are present, which are benched, which are ghosted,
 * which cables are drawn — and `stateAt(steps, i)` folds the verbs of every step
 * up to `i` to get there. The motion between two steps is then the difference
 * between two of these, which is why stepping backwards takes the rig apart
 * rather than needing a second set of instructions.
 *
 * Some fields persist once set and some reset every step. `visible`, `benched`,
 * `spins` and `wires` persist: a fitted part stays fitted. `ghosted`,
 * `highlighted`, `callouts` and `offsets` reset, because they describe what one
 * step is drawing attention to rather than anything about the rig.
 */
export interface CameraPose {
  yaw: number;
  pitch: number;
  distance: number;
  target: { x: number; y: number; z: number };
}

export interface CameraSpec {
  yaw?: number;
  pitch?: number;
  fill?: number;
  focus?: string;
  target?: [number, number, number];
  offset?: [number, number, number];
  wide?: boolean;
}

export interface Callout {
  part: string;
  text: string;
}

export interface SceneState {
  visible: Set<string>;
  benched: Set<string>;
  removed: Set<string>;
  ghosted: Set<string>;
  highlighted: Set<string>;
  callouts: Callout[];
  offsets: Map<string, number>;
  spins: Map<string, number>;
  wires: Set<string>;
  camera: CameraSpec;
}

export type Action = (state: SceneState) => void;

export interface AssemblyStep {
  id: string;
  title: string;
  body: string;
  cite?: string;
  camera?: CameraSpec;
  /** Verbs, or the arrays an assembly's methods return — both, freely mixed. */
  actions?: (Action | Action[])[];
}

export const DEFAULT_CAMERA: CameraPose = {
  yaw: 0.9,
  pitch: 0.35,
  distance: 0.21,
  target: { x: 0, y: 0, z: 0.04 },
};

function createState(): SceneState {
  return {
    visible: new Set(),
    benched: new Set(),
    removed: new Set(),
    ghosted: new Set(),
    highlighted: new Set(),
    callouts: [],
    offsets: new Map(),
    spins: new Map(),
    wires: new Set(),
    camera: {},
  };
}

function resetPerStep(state: SceneState): void {
  state.removed.clear();
  state.ghosted.clear();
  state.highlighted.clear();
  state.callouts.length = 0;
  state.offsets.clear();
}

function runStep(state: SceneState, step: AssemblyStep): void {
  resetPerStep(state);
  state.camera = step.camera ?? {};
  for (const action of (step.actions ?? []).flat()) action(state);
}

const cache = new WeakMap<AssemblyStep[], SceneState[]>();

export function stateAt(steps: AssemblyStep[], index: number): SceneState {
  let states = cache.get(steps);
  if (!states) {
    states = [];
    const running = createState();
    for (const step of steps) {
      runStep(running, step);
      states.push(snapshot(running));
    }
    cache.set(steps, states);
  }
  const clamped = Math.max(0, Math.min(states.length - 1, index));
  return states[clamped];
}

export function snapshot(state: SceneState): SceneState {
  return {
    visible: new Set(state.visible),
    benched: new Set(state.benched),
    removed: new Set(state.removed),
    ghosted: new Set(state.ghosted),
    highlighted: new Set(state.highlighted),
    callouts: state.callouts.map((c) => ({ ...c })),
    offsets: new Map(state.offsets),
    spins: new Map(state.spins),
    wires: new Set(state.wires),
    camera: { ...state.camera },
  };
}

// --- the verbs a step can use -----------------------------------------------

/** One full turn, so a step can say `spin(id, 2)` and mean two of them. */
const TURN = Math.PI * 2;

export const fit =
  (...ids: string[]): Action =>
  (state) => {
    for (const id of ids) {
      state.visible.add(id);
      state.removed.delete(id);
    }
  };

export const bench =
  (...ids: string[]): Action =>
  (state) => {
    for (const id of ids) {
      state.visible.add(id);
      state.removed.delete(id);
      state.benched.add(id);
    }
  };

export const install =
  (...ids: string[]): Action =>
  (state) => {
    for (const id of ids) state.benched.delete(id);
  };

export const remove =
  (...ids: string[]): Action =>
  (state) => {
    for (const id of ids) {
      state.visible.delete(id);
      state.removed.add(id);
    }
  };

export const ghost =
  (...ids: string[]): Action =>
  (state) => {
    for (const id of ids) state.ghosted.add(id);
  };

export const highlight =
  (...ids: string[]): Action =>
  (state) => {
    for (const id of ids) state.highlighted.add(id);
  };

export const callout =
  (part: string, text: string): Action =>
  (state) => {
    state.callouts.push({ part, text });
  };

export const spin =
  (id: string, turns = 1): Action =>
  (state) => {
    state.spins.set(id, (state.spins.get(id) ?? 0) + turns * TURN);
  };

/**
 * Draw these cables. The ids are **routes**, not nets — see `routeId` in
 * `routeId` in `wires.ts` for why. Steps do not call this directly; they ask an assembly
 * for a wiring stage, which is what knows the routes it owns.
 */
export const wires =
  (...routeIds: string[]): Action =>
  (state) => {
    for (const id of routeIds) state.wires.add(id);
  };
