---
title: "Mirror symmetry"
description: "The rig is mirror-symmetric but the learned policies aren't — the evidence, what it costs, and the three ways to fix it."
---
The rig has exactly one non-trivial symmetry: reflect the whole machine
through the vertical plane containing the arm at `motor_pos = 0`. Nothing
distinguishes left from right — not the geometry, not the reward, not the
reset distribution. Yet every policy trained so far picks a **preferred
swing-up direction**, a different one on each run, and catches noticeably
worse on its unfavoured side.

That is textbook spontaneous symmetry breaking: the problem is symmetric, a
deterministic solution need not be, and SAC has no reason to prefer a
symmetric one. The same effect is documented for cart-pole swing-up in
Mittal et al., *Symmetry Considerations for Learning Task Symmetric Robot
Policies* (ICRA 2024) — an unaugmented policy spins the pole straight up
from one side but lets it swing through first from the other.

## The map

On one observation frame the reflection is a fixed diagonal of ±1. `cos θ`
is the only channel that does **not** flip, because reflecting θ flips
`sin θ` and leaves `cos θ` alone:

$$
\begin{array}{r|cccccc}
s & \text{motor\_pos} & \sin\theta & \cos\theta
  & \text{motor\_vel} & \text{pen\_vel} & \text{prev\_action} \\
\hline
M & -1 & -1 & +1 & -1 & -1 & -1
\end{array}
$$

tiled over the `K` stacked frames, with `action → -action`. An ideal policy
is **equivariant**, $\pi(Ms) = -\pi(s)$, with an **invariant** critic,
$Q(Ms, -a) = Q(s, a)$.

`symmetry.py` is the single source of truth for this map — build the sign
vector with `obs_signs_for_dim(obs_dim, obs_history_len=K)`, which infers
the frame layout from `obs_dim / K` and raises rather than guessing. Getting
`K` wrong would flip `cos θ` and leave `sin θ` alone, producing "mirrored"
states that aren't on the manifold at all.

## The symmetry is exact, and that is tested

For any transition, the mirrored transition (Ms, −a, r, Ms′) is a **genuine
transition of the same MDP** — not an approximation, not synthetic data.
`test_symmetry.py` verifies this numerically rather than by argument:

| checked | result |
|---|---|
| `r(Ms, −a) == r(s, a)`, all reward terms on, 20k random states | exact (0.0) |
| mirrored rollout matches step-for-step, all 3 action modes × both obs models | max obs error **exactly 0** |
| episode lengths agree | yes |

Every term in `reward.py` is even in these quantities and the alive gates use
`|θ|`/`|θ̇|`; the quantisers use `round` (symmetric about zero); the hard
stops are ±135°; reset samples `motor_pos` and the θ-bias symmetrically; the
base-tilt azimuth is uniform. Run `python test_symmetry.py` after touching
any of that — an asymmetric reward term or a one-sided clamp would make
mirror augmentation start teaching SAC physics the rig doesn't have.

## The evidence it's broken in practice

**In the weights.** `analyze_symmetry.py` scores any policy — a SAC `.zip`, a
distilled `student.pt`, or `policy_weights.h` itself:

```
$ python analyze_symmetry.py ../../RotaryInvertedPendulum-arduino/RLControl/policy_weights.h
  RMS |pi(s) + pi(Ms)|:    0.9959   (0 = equivariant)
  relative asymmetry:      1.157   (0 = equivariant, ~1.41 = unrelated)
  action at engage state:  -0.3637   (0 = no baked-in swing direction)
```

A relative asymmetry of 1.16 against an "unrelated" ceiling of 1.41 means the
policy carries essentially no mirror structure. The **engage-state action**
is the single most interpretable number: the rig tares the arm and the
encoder at engage, so the first observation is the mirror fixed point, and any
nonzero action there *is* the hard-coded swing-up direction. Two students
distilled from different fine-tunes of the same lineage give −0.36 and +0.92
— opposite directions, both near-committed.

**In the rig logs.** Direction preference over the deploy captures, counting
the sign of the pendulum's rotation on each arrival at upright:

| log | CCW / CW | p (two-sided) |
|---|---|---|
| `onboard_v8s16_ft` | 41 / 3 | 2×10⁻⁹ |
| `vel_v1_ft` | 29 / 1 | 6×10⁻⁸ |
| `onboard_stillA_ft_50hz` | 4 / 34 | 6×10⁻⁷ |
| `onboard_smooth50-h32_50hz` | 62 / 117 | 5×10⁻⁵ |

Pooled over all policies it's 676 / 791 — near 50/50. **Per policy it's
strongly lopsided and the favoured side differs between runs**, which is what
distinguishes a policy-side broken symmetry from a rig-side asymmetry.

**In the cost.** Per-direction catch rate, same captures:

```
onboard_stillA_ft_50hz     CCW 14% (n=14)   CW 89% (n=35)
onboard_fast128_ft_50hz    CCW 43% (n= 7)   CW 85% (n=13)
onboard_v8s16_async_real   CCW 71% (n=31)   CW 20% (n= 5)
POOLED                     CCW 14.3% (1283) CW 20.7% (1157)
```

`balance_metrics.py` computes this split for every trajectory, so
`analyze_onboard.py` (rig) and `analyze_sim.py` (sim) both report it, and it
warns outright when the two directions differ by more than 25 points.

**In sim, on a policy that looks perfect.** `eval_randomized.py
--mirror-pairs` runs each episode twice — once as sampled, once with the
initial state reflected and *identical* physics parameters. A symmetric
policy must score the same on both. The v11 stage-3 teacher scores 12/12
under the normal eval and still shows 1/12 pairs disagreeing with a mean
reward gap of 131 (~27% of the mean episode reward). The standard eval cannot
see this; the paired eval is the sharpest available test.

## What the rig itself breaks

Not everything asymmetric is the policy's fault. Across 11 well-performing
captures the **signed** arm position during balance averages −14°, negative
in 10 of 11 — and independently trained policies agreeing on a direction
points at the rig. The likely cause is base tilt: on a table that isn't
level, gravity acquires a swing-plane component that varies with arm angle,
so the arm settles where that component vanishes. `DR_BASE_TILT_MAX_RAD`
already models this at ±1°. (`arm_off_centre_deg` takes an absolute value and
so cannot see a consistent lean; `arm_off_centre_signed_deg` was added for
exactly this.)

Scale check: 1° of tilt is a 1.7% perturbation to gravity and shifts apparent
upright by ≤1°, against a θ-bias DR band of ±2.9° the policy is already
trained to ignore. The encoder cable running along the arm contributes a
twist-restoring torque that is *odd* in `motor_pos` about its neutral, so it
**preserves** the mirror symmetry rather than breaking it.

**This is why mirror augmentation on real data is defensible.** Mirroring a
transition from a tilted rig yields a valid transition of the *mirror-image*
rig — tilt azimuth reflected. Training on both asks the policy to handle two
azimuths, which is strictly less than the sim curriculum already demands
(uniform azimuth over the full circle, every episode). It gives up ≤1° of
per-rig specialisation. Nobody needs to level anything.

## The catch: the engage state is a mirror fixed point

States with `motor_pos = 0`, θ = ±π, zero velocities and zero `prev_action`
are their own mirror image, so an **exactly** equivariant policy must output
0 there. Both `RLControl.ino`'s `prime_initial_state()` and
`real_env.reset()` tare the arm and encoder to zero at engage, which lands
exactly on that state — every time, and for all 50 episodes of a fine-tune.

This is measured, not theoretical. The v11 teacher's exact odd projection
½(a(s) − a(Ms)) returns **exactly 0.0000** at engage and never moves:

```
=== teacher as-is ===              time to upright: 1.36 s (CW)
=== teacher odd projection ===     action at first tick: +0.0000
                                   *** never reached upright in 15 s ***
```

Note that the physical pendulum rests up to 1.9° off vertical-down — but the
tare removes that from the observation, so the physical bias cannot break the
tie. The escape routes are ±1 LSB of encoder jitter (|action| ≈ 0.002, which
stepper stiction up to 0.005 N·m may swallow) or nothing.

**Consequences for the three methods:**

- Soft symmetrisation (augmentation, mirror loss) leaves a small residual
  asymmetry that breaks the tie, and needs no firmware change — but *verify
  it*, don't assume it. `analyze_symmetry.py --engage-rollout` puts the sim
  in exactly the engage state, with no DR and no θ-bias, and reports whether
  the policy gets up and how hard it pushes. **Treat this as a gate before
  flashing.**
- An exactly equivariant architecture (the NET method) needs a deliberate
  tie-break. The right one is to engage from a non-centred arm: zero the step
  counter at centre, move the arm to ≈+0.35 rad, then hand over. That puts
  the policy in a state it trains on constantly (reset samples `motor_pos`
  uniformly over ±88°) and makes the swing direction a function of where the
  room is rather than an arbitrary weight.
- Input canonicalisation — the usual cheap route to exact equivariance — is a
  **bad** fit here. The flip boundary is `sin θ = 0`, which is exactly where
  the policy balances, so it would chatter in the balance regime.

## The four methods, and what's implemented

Following the taxonomy in Abdolhosseini et al., *On Learning Symmetric
Locomotion* (MIG 2019), which found LOSS the most consistent and DUP the
weakest at actually achieving symmetry, with no consistent effect on learning
*speed*. Their warning that NET is highly sensitive to observation
normalisation doesn't apply here — this stack has no `VecNormalize`.

| method | how | status |
|---|---|---|
| **DUP** | store (Ms, −a, r, Ms′) alongside every transition | `--mirror-augment` on `train_sac.py` and `finetune_async.py` |
| **LOSS** | add `w·mean((f(s) + f(Ms))²)` to the loss | `--mirror-loss-weight` on `distill.py` |
| **NET** | constrain the weights so oddness is structural | not implemented — see the tie-break above |
| **PHASE** | locomotion-specific | not applicable |

Plus one that isn't in the taxonomy because it's specific to having a teacher:
**symmetrised distillation** (`--symmetrize-teacher`) fits the student to the
teacher's *odd projection* ½(a(s) − a(Ms)), the closest exactly-equivariant
policy to the teacher. Pair it with `--mirror-augment`: symmetrising the
target changes what the student does, so it visits states the teacher never
did — and those states are exactly the mirror images the augmentation
supplies.

## Symmetrising a teacher after the fact does not work

This looked like the cheap win — symmetrise the existing champion, no
retraining — and it is worth knowing precisely how it fails, because the
failure is informative.

Full production recipe on the v11 teacher (h16, 800 epochs, 100k sim
augmentation, `--symmetrize-teacher --mirror-augment --mirror-loss-weight 1.0`):

| | production student | symmetrised student |
|---|---|---|
| `val_mse` | 0.0478 | **0.0400** |
| relative asymmetry | 0.978 | **0.122** |
| engage-state action | +0.918 | +0.0005 |
| balance from ±8.6°, 12 s | 1.000 both sides | **1.000 both sides** |
| swing-up from hanging | 1.4–2.2 s | **never**, at any arm offset |

Two things to take from this.

**Symmetry is free for balance and fatal for a retrofitted swing-up.** The
symmetrised student balances perfectly from both sides — better behaved than
the asymmetric one, and note it *fits its target better* (`val_mse` 0.040 vs
0.048 at identical size and epochs), because the odd projection is a smaller
function to represent: exact equivariance halves the effective state space,
which is free capacity on a 689-parameter Nano budget. But it never swings up,
from a centred arm or from ±20°, in 30 s. It pumps hard (peak |action| 1.0)
and never converges.

The reason is that the projection is not "the teacher, tidied up". Where the
teacher is nearly equivariant — around upright — the projection barely changes
it, which is why balance survives intact. Where the teacher is strongly
asymmetric — the whole swing-up — ½(a(s) − a(Ms)) averages its competent
one-sided pumping against the mirror of whatever it does on the side it never
learned. The average is not a pumping strategy at all. Measured mean |change|
to the targets: 0.297.

**So symmetry has to be learned during RL, not projected on afterwards.** A
symmetric swing-up certainly exists — pump toward whichever side the
pendulum's phase favours — but SAC has to find it while it can still explore.
That makes `--mirror-augment` during training the primary path and
`--symmetrize-teacher` a diagnostic rather than a shortcut.

## Learning it during RL does work

A controlled 2×2 — identical recipe and code, two seeds per arm, differing
only in `--mirror-augment`, full three-stage curriculum at 100k steps per
stage. Scored on DR-sim rollouts, 12 paired mirrored episodes, and 10 scored
episodes through the device transport:

| run | rel. asym | engage | self-start | solved | pairs≠ | balanced | CCW/CW | bias | arm lean |
|---|---|---|---|---|---|---|---|---|---|
| `base_s0` | 1.023 | +0.838 | 1.32 s | 11/12 | 1/12 | 0.783 | 16/3 | 0.68 | +19.5° |
| `base_s1` | 0.588 | +0.523 | 1.34 s | 9/12 | 3/12 | 0.792 | 6/12 | 0.33 | −3.1° |
| `sym_s0` | **0.301** | +0.073 | 1.78 s | **12/12** | 1/12 | **0.814** | 9/4 | 0.38 | +1.3° |
| `sym_s1` | **0.303** | −0.218 | 1.76 s | **12/12** | 1/12 | **0.819** | 7/6 | **0.08** | +2.2° |

Four things worth reading off this.

**The asymmetry roughly halves, and becomes reproducible.** 0.301 and 0.303
against baselines of 1.023 and 0.588. The consistency matters as much as the
level: the baseline's asymmetry is a coin flip that varies 2× between seeds,
while both augmented runs land in the same place. That is what "stop the
policy picking an arbitrary direction" looks like.

**They still self-start — no firmware nudge needed.** 1.76–1.78 s from the
exact engage state versus 1.32–1.34 s for the baselines. Roughly 0.45 s
slower, because the residual tie-break is smaller (engage action 0.07–0.22 vs
0.52–0.84), but the swing-up survives. This is the opposite of what post-hoc
symmetrisation did, and it is the central result: SAC can find a symmetric
pumping strategy when it learns one, and cannot have one imposed afterwards.

**Performance did not suffer — it improved slightly.** 12/12 solved on both
augmented seeds against 11/12 and 9/12, with balanced fraction 0.814/0.819
against 0.783/0.792. Only 12 episodes per run, so treat the solve rate as
suggestive rather than significant; the direction of the effect is at least
not adverse.

**The arm lean collapses.** `base_s0` balances 19.5° off centre; both
augmented runs sit within 2.2°. The DR eval randomises tilt azimuth per
episode, so a symmetric policy should average to zero — and does.

Honest limits: two seeds per arm; relative asymmetry 0.30 is *halved*, not
zero, so these policies still have a mild preference (and its sign still
differs between seeds); paired disagreement barely moved (1/12 vs 1/12 and
3/12) and the reward gap not at all, so at n=12 the asymmetry score is the
cleaner instrument. All of it is sim. Rig confirmation is still owed.

## On the rig

`sym_s1_stage3` → 50-episode `--mirror-augment` fine-tune → `distill_student.sh`
→ flashed. Both captures are 300 s standalone:

| | champion | symmetric student |
|---|---|---|
| balanced fraction | 1.000 | 0.988 |
| longest streak | 299.5 s | 265.9 s |
| **arm lean signed** | **−17.8°** | **−1.7°** |
| arm off-centre | 17.9° | 8.1° |
| arrivals CCW / CW | 0 / 0 | 4 / 5 (bias 0.11) |
| pendulum std | 2.47° | 2.90° |

**The arm settles on centre.** −17.8° → −1.7°. The lean was never a reward-tuning
problem — it was the broken symmetry, and it went away when the symmetry was
restored rather than when the centring penalty was raised.

The balanced fractions are not comparable: the symmetric capture was
deliberately perturbed by hand ~9 times and the champion capture was not,
which is also why it shows 42.9 pendulum revolutions against 29.2 and 5
catches against 1. The 1.2% is recovery time from knockdowns the champion
never faced.

Two things to note about where the asymmetry ends up. The fine-tune *raised*
the overall score (0.314 → 0.536 on the teacher, 0.531 on the student), but it
concentrated entirely in the swing-up: balance gains are symmetric to 0.003 at
±5.7° and ±11.5°, while the engage action grew from −0.218 to −0.702. That is
unavoidable — every fine-tune episode starts at the engage state, which is its
own mirror image, so augmentation contributes `(s, +a)` and `(s, −a)` with
identical reward and the policy must pick one. It is also what makes it
self-start in 1.62 s. And DAgger, which has no symmetry support, *preserved*
the teacher's symmetry rather than eroding it (0.531 vs 0.536).

### Expectations

The reliable wins are **behavioural consistency** and **coverage**, not a
wall-clock speed-up. Mirroring adds no new information about the plant — the
mirrored transition is fully determined by the original — so it's an
inductive bias, not extra measurement.

Where it should pay most is real-rig fine-tuning, because that data is
lopsided: `onboard_stillA_ft_50hz` visited one side 2.5× more than the other,
`vel_v1_ft` nearly 4×. Augmentation converts "50 episodes of left-side
behaviour" into "50 left + 50 right" at zero rig cost. That is a coverage
fix, not a licence to halve `--episodes` — if you want to test the halving,
run 25 augmented episodes against a 50-episode baseline and compare, don't
assume it.

## Runbook

Measure first — every number above is reproducible in minutes:

```bash
python test_symmetry.py                      # the symmetry really is exact
python analyze_symmetry.py <policy>          # asymmetry + engage action + self-start
python eval_randomized.py <policy.zip> --mirror-pairs   # paired sim episodes
```

Train with augmentation — the primary path, since post-hoc symmetrisation
loses the swing-up (above):

```bash
MIRROR_AUGMENT=1 DEVICE=cpu bash curriculum_train.sh sym_v1   # all three stages
python analyze_symmetry.py runs/sym_v1_stage3/best_model.zip  # MUST self-start
python eval_randomized.py runs/sym_v1_stage3/best_model.zip --mirror-pairs
```

Then on the rig, where the coverage imbalance is:

```bash
python finetune_async.py --policy runs/sym_v1_stage3/best_model.zip \
    --mirror-augment --episodes 50 ...        # 2 buffer slots per rig step
python analyze_onboard.py --port <port> --duration-s 300 --log recordings/<name>.npz
```

Per-direction catch rate and `direction_bias` from `analyze_onboard.py` are
the acceptance test; a baseline capture of the current champion gives the
before number. Mirror augmentation also works on the fine-tune alone, from an
asymmetric teacher — SAC is still learning there, so unlike distillation it
can trade the one-sided swing-up for a two-sided one instead of having a
broken average imposed on it.

Symmetrised distillation, as a diagnostic (does the odd projection of this
teacher still do the job?):

```bash
python distill.py --teacher runs/<run>/last.zip --buffer runs/<run>/replay_buffer.pkl \
    --out-dir runs/<run>/distill_h16_sym --hidden 16 --epochs 800 \
    --symmetrize-teacher --mirror-augment --mirror-loss-weight 1.0
python analyze_symmetry.py runs/<run>/distill_h16_sym/student.pt --engage-rollout 15
```

`mirror_augment` is recorded in `config.json` for provenance but is
deliberately **not** enforced by `check_config` (see
`run_config.PROVENANCE_ONLY_KEYS`) — it changes what the buffer holds, not
the observation layout or the objective, so switching it on for a later
curriculum stage is legal.

## Open questions

- Would the LOSS method inside SAC's actor update beat augmentation alone?
  Abdolhosseini et al. found DUP the weakest of the four at *enforcing*
  symmetry and LOSS the most consistent; only `distill.py` has a mirror-loss
  term today.
- Is the residual lean (−1.7°) base tilt or measurement? Levelling the table
  and re-measuring `arm_off_centre_signed_deg` would settle it.
- Does mirror augmentation compose with the widened observation-staleness DR
  (`DR_OBS_STALENESS_MAX`)? The symmetric teacher was trained before that
  landed, so the two have never been combined.
- Can a matched-protocol capture separate the two policies on balanced
  fraction? The pair above cannot — one was perturbed, one wasn't.
