---
title: The URDF and meshes
description: Where the rig's geometry is authored, how the visual meshes are shared, and the two dimensions still open.
---

[`model/`](https://github.com/ferrolho/rotary-inverted-pendulum/tree/main/model)
holds `model.urdf` and the printable STLs it references. It is the single source
of truth for the *pendulum link's* mass, COM and inertia tensor: authored in
Onshape, exported here, and parsed at import time by
[`policy/pendulum_geometry.py`](https://github.com/ferrolho/rotary-inverted-pendulum/blob/main/policy/pendulum_geometry.py).
The MuJoCo training environment and the sysid friction derivation both build on
those constants, so to change pendulum geometry you edit Onshape and re-export —
nowhere else.

## The visual meshes

`model.urdf` takes its visual geometry from the printable STLs, one file per
part, scaled from millimetres. That is deliberate: the `.dae` exports it used to
reference were a different CAD revision from the STLs beside them, and
`pendulum.dae` was missing outright, so the pendulum could not be resolved at
all. Sharing one file per part between the URDF, the printed part and the
documentation site's glTF export removes the whole class of problem. Link
colours come from `<material>` elements in the URDF, since STL carries none.

Each mesh is authored with its bearing axis through the mesh origin, so no
`<visual>` translation is needed — but the parts do not agree on *which* axis
that is. The arm pivots about its mesh +z (the motor bore); the pendulum pivots
about its mesh +y (an 8.1 mm boss matching the 608 bearing's bore), because it
is a flat plate that swings in its own plane. The pendulum therefore carries a
`<visual>` rotation to bring its axis onto the joint's.

Both the URDF and the 3D demo previously treated the pendulum's mesh **x** as
the hinge and papered over the result with a 6 mm translation, which rendered
the plate edge-on — spanning ±16 mm *along* the arm with the 2p coin facing down
it. A rod is symmetric about its own length, so nothing caught it; the fix is
pinned now by two assertions in `tests/scene_geometry.test.mts` that fail on the
old treatment.

## Where the arm's reach lives

The URDF's `arm_to_pendulum` origin carries the arm's reach (`x = 0.062`), and
the pendulum link's inertial origin is the 51 mm drop below that pivot. This
matters if you read the file: it used to be the other way round — the joint sat
on the motor axis and the whole 62 mm was folded into the pendulum's COM offset.
Since the swing axis *is* x, only `sqrt(y² + z²)` of that offset reaches the
dynamics, so the mistake was invisible to `pendulum_geometry.PENDULUM_COM_M` —
but it put the pendulum's *visual* geometry on the motor axis, and gave any
model-based controller a pivot with no reach.

Two numbers here are still open, pending a CAD check:

- **The reach itself.** The URDF says 62 mm, `pendulum_env.ARM_LENGTH_M` says
  65 mm, and the arm mesh ends at 60 mm with the pendulum's hub cantilevered
  outboard. This is the one geometric number that materially affects control
  authority.
- **`base_to_arm`'s `z = 0.075`**, against the 70 mm top face of `base.stl` that
  the 3D demo uses for the same plane.

## The arm link is not the training plant

The `arm` link's `<inertial>` is CAD-derived too, but nothing reads it:
`pendulum_env.py` keeps its own hard-coded `ARM_*` constants, which disagree
with the URDF on mass, COM and reach alike (~6.1e-5 vs ~4.7e-5 kg·m² about the
motor axis; 62 mm vs 65 mm reach). Switching the environment over to the URDF
would change the plant the policy trains against, so treat it as a plant change
— not a refactor — and re-validate the champion afterwards.
