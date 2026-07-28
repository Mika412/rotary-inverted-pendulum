---
title: Julia stack (MPC/LQR)
description: The model-based control exploration and MeshCat visualisation that predate the learned controller.
---

[`RotaryInvertedPendulum-julia/`](https://github.com/ferrolho/rotary-inverted-pendulum/tree/main/RotaryInvertedPendulum-julia)
holds the model-based side of the project: rigid-body dynamics, MPC
linearisation, and 3D visualisation. It is exploratory work that predates the
learned controller, and it is not part of the deployment pipeline — but it is the
best place to look if you want to compare a classical approach against the
policy.

## Setup

```bash
cd RotaryInvertedPendulum-julia
julia --project=.
```

```julia
using Pkg
Pkg.instantiate()
```

## Running

PID over serial from Julia:

```julia
using RotaryInvertedPendulum
pid_control()   # 2,000,000 baud, 200 Hz control
```

The low-level server client, with visualisation:

```bash
julia --project=. ../RotaryInvertedPendulum-arduino/LowLevelServer/client.jl --visualise
```

## Files

| File | Contents |
| --- | --- |
| `RotaryInvertedPendulum.jl` | Module entry point, serial commands, Arduino communication |
| `mpc.jl` | Model predictive control with automatic-differentiation linearisation |
| `control_pid.jl` | PID over the serial link |
| `control_gamepad.jl` | Manual gamepad control |
| `utils.jl`, `precompile.jl` | Helpers and precompilation |

## The MPC formulation

State is `[motor_angle, pendulum_angle, motor_velocity, pendulum_velocity]`, with
motor torque as the control input, converted to commands the stepper can take.

- Nonlinear dynamics come from `RigidBodyDynamics.jl` reading `urdf/model.urdf`.
- Linearisation uses `ForwardDiff.jl` at the upright equilibrium (pendulum at π,
  motor at origin).
- Discrete-time dynamics via RK4 integration.

## Dependencies

`LibSerialPort`, `RigidBodyDynamics`, `ForwardDiff`, `MeshCat` +
`MeshCatMechanisms`, `Joysticks`, `Plots`.

## The URDF's visual meshes

`urdf/model.urdf` takes its visual geometry from the printable STLs, one file
per part, scaled from millimetres. That is deliberate: the `.dae` exports it
used to reference were a different CAD revision from the STLs beside them, and
`meshes/pendulum.dae` was missing outright, so MeshCat could not resolve the
pendulum at all. Sharing one file per part with the printable geometry and the
documentation site's glTF export removes the whole class of problem. Link
colours come from `<material>` elements in the URDF, since STL carries none.

Each mesh is authored with its bearing axis through the mesh origin, so no
`<visual>` translation is needed — but the parts do not agree on *which* axis
that is. The arm pivots about its mesh +z (the motor bore); the pendulum pivots
about its mesh +y (an 8.1 mm boss matching the 608 bearing's bore), because it
is a flat plate that swings in its own plane. The pendulum therefore carries a
`<visual>` rotation to bring its axis onto the joint's. Both the URDF and the
3D demo previously treated the pendulum's mesh **x** as the hinge and papered
over the result with a 6 mm translation, which rendered the plate edge-on —
spanning ±16 mm *along* the arm with the 2p coin facing down it. A rod is
symmetric about its own length, so nothing caught it; the fix is pinned now by
two assertions in `tests/scene_geometry.test.mts` that fail on the old
treatment.

## Where the arm's reach lives

The URDF's `arm_to_pendulum` origin carries the arm's reach (`x = 0.062`), and
the pendulum link's inertial origin is the 51 mm drop below that pivot. This
matters if you read the file: it used to be the other way round — the joint sat
on the motor axis and the whole 62 mm was folded into the pendulum's COM offset.
Since the swing axis *is* x, only `sqrt(y² + z²)` of that offset reaches the
dynamics, so the mistake was invisible to `RigidBodyDynamics` and to
`pendulum_geometry.PENDULUM_COM_M` alike — but it put the pendulum's *visual*
geometry on the motor axis, and gave MPC a pivot with no reach.

Two numbers here are still open, pending a CAD check:

- The reach itself. The URDF says 62 mm, `pendulum_env.ARM_LENGTH_M` says 65 mm,
  and the arm mesh ends at 60 mm with the pendulum's hub cantilevered outboard.
  This is the one geometric number that materially affects control authority.
- `base_to_arm`'s `z = 0.075`, against the 70 mm top face of `base.stl` that the
  3D demo uses for the same plane.

The arm link's `<inertial>` is also CAD-derived but is not what the training
plant uses; `pendulum_env.py` keeps its own `ARM_*` constants. See the header
comment in the URDF.
