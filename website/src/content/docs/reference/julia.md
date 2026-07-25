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

## Known issue: the URDF's visual meshes

`urdf/model.urdf` references `.dae` files for all three links, but
`meshes/pendulum.dae` does not exist in the repository — only `pendulum.stl`
does. Anything that loads the URDF's *visual* geometry (MeshCat) will fail to
resolve it. The dynamics do not care, since they use the inertial properties, so
this went unnoticed.

There is a second inconsistency in the same file worth knowing about if you ever
render from the URDF: the `arm_to_pendulum` joint origin has no x-offset, while
the pendulum's inertial origin sits at `x = 0.062`. Because the swing axis *is*
x, the offset has no dynamic effect — but it means the URDF places the pendulum's
visual geometry 62 mm from where the arm tip actually is. The documentation
site's 3D demo derives its transforms from the MuJoCo model for this reason.
