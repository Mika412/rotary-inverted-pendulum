---
title: "The assembly viewer"
description: "How the 3D build guide is put together: declarative steps, a diffed scene state, and one timeline."
---

The [interactive build guide](/rotary-inverted-pendulum/build/assembly/) steps
through the whole assembly in 3D. This page is for changing it.

**Everything in it is config.** `src/assembly/config/` holds where each part
sits (`placement.ts`), the bought parts and the pads a wire can land on
(`vendor.ts`), the printed meshes (`printed.ts`) and what connects to what
(`netlist.ts`). Move a part by editing a number; nothing generates these.

## The shape of it

```
config/       placements, bought parts, printed meshes, the netlist
steps.ts      the build script — the only file most edits touch
rig.ts        the assemblies: what goes together, and the cables among it
state.ts      SceneState, stateAt(steps, i), and the verbs a step can use
animate.ts    the clock, and what a transition looks like on it
wires.ts      how a cable is declared, and what each cable looks like
harness.ts    resolves those declarations and builds the tubes
parts.ts      manifests → part handles, the frame graph, the materials
scene.ts      renderer, lights, camera rig, contact shadow
viewer.ts     binds the DOM to the state and the timeline
```

The single idea: **a step declares the state of the scene at its end, and the
transition is the difference between two states.** Nothing describes an
animation directly. That is why stepping backwards takes the rig apart rather
than deleting from it, and why jumping eleven steps still plays every part in
order — both are the same diff over a different pair of states.

## Adding a step

Add an object to `ASSEMBLY_STEPS` in `src/assembly/steps.ts`:

```ts
{
  id: 'bearing',
  title: 'Bearing into the arm tip',
  body: 'A single 608 skate bearing presses into the pocket…',
  cite: 'Pocket measured 22.1 mm at 14 mm above the arm’s underside.',
  camera: { focus: 'bearing', yaw: 0.5, pitch: 0.24, fill: 0.26 },
  actions: [armUnit.bench('bearing'), ghost('arm')],
}
```

`id` is the URL hash, so every step is linkable. `cite` renders as the
provenance line — the measured millimetres behind the claim.

**Adding a part** means adding it to an assembly, not to a step. An assembly
owns its parts, its child assemblies and the cables that run among them, and its
methods are what a step calls:

```ts
actions: [board.install(), ghost('base')]
actions: [motorUnit.fit('plug-motor'), motorUnit.wire('coils')]
```

`bench`, `fit`, `install`, `wire` and `ghost`, and nothing else. `fit('nano')` on
an assembly that does not own the Nano throws rather than quietly fitting it.

**`wire()` takes a stage, not a net**, because one net can be drawn by more than
one cable: ground runs across the board, out to the jack, *and* out to the
encoder, at three different points in the build.

### Framing

State `focus` (a part id) rather than a coordinate; the camera looks at that
part's measured bounding-box centre, so a mesh revision moves the framing with
it. `wide: true` fits everything currently on the rig. Distance is computed:
`fill` is the fraction of the frame the subject should occupy. Framing is not
inherited — each step states its own.

## Adding an animation

Each verb in `state.ts` is a one-line function that mutates `SceneState`:

| Verb | What it does |
| --- | --- |
| `fit(...ids)` | Travel in along the measured approach vector and press into the seat |
| `bench(...ids)` | Build the part as a sub-assembly, off the rig, beside the enclosure |
| `install(...ids)` | Bring a benched sub-assembly into the rig as one piece |
| `remove(...ids)` | Send a part back out |
| `ghost(...ids)` | Cutaway — see through it for this step |
| `highlight(...ids)` | Lift the part with an emissive glow |
| `callout(id, text)` | A label anchored to the part in 3D |
| `spin(id, turns)` | Rotate in place |
| `wires(...routeIds)` | Draw those cables |

To add one, write the function. If it introduces a new field on `SceneState`,
add a matching rule to `partTracks` in `animate.ts` — the only other place
that needs to know.

`visible`, `benched`, `spins` and `wires` **persist** once set; `ghosted`,
`highlighted`, `callouts` and `offsets` **reset every step**, because they
describe what this step is drawing attention to.

## Wiring

**Cables are declared, not routed.** A route is a chain of sections — `sharp()`
for cut-and-bent hookup wire, `curve()` for anything that hangs — through
waypoints that name measured things:

```ts
wire({
  net: 'v12', between: ['jack', 'switch'], cable: 'power', group: 'power',
  route: [
    curve(
      lead(pad('jack', '+')),
      shift(face('switch', '-y'), '-y', CLEAR.behindPanel),
      lead(pad('switch', 'in')),
    ),
  ],
})
```

There is no constructor in `wires.ts` that takes three numbers. A waypoint
names a `pad`, `hole`, `centre`, `face`, `feature` or `trace`, and
the resolver in `harness.ts` looks it up — so moving a module moves its wires. The only
scalars are `CLEAR`, each a clearance applied along a measured direction from a
measured point, each carrying the reason it is the size it is.

Four questions, kept apart: **what connects to what** is
`src/generated/netlist.json`, extracted from the firmware's pin defines; **where
a wire lands** is measured and published per part in the vendor manifest;
**which way it leaves a pad** is that pad's own `leads` vector; **what the cable
looks like** is the cable list in `wires.ts`.

A loom's route runs **breakout to breakout** — its first and last resolved
points are where the conductors fan out. A twisted pair unwinds into the
breakout over one twist pitch, the cable's own measurement, so it arrives
together and the tails leave from one place. A ribbon does not unwind: its
conductors are moulded side by side and stay that way into the connector.

Bundles are swept on **parallel-transport frames**, not three.js's Frenet ones.
Frenet frames are built from curvature, so they whip through an inflection and
flip outright on a straight run, and a helix swept on them comes out kinked.

## Things that look wrong until you know why

**The camera never teleports.** Every move starts from wherever the camera
actually is, including wherever the reader last dragged it. Camera tracks carry
`hold: true`, so interrupting a transition leaves the camera where the current
frame put it.

**A part being removed stays opaque until it has finished travelling.** Fading it
while it is still moving reads as a dissolve, not as disassembly.

**Fits ease out, not in and out**, and overshoot by a hair before settling —
capped at 2 mm, because the whole rig is only 87 mm across.

**A part comes in the way it is really offered up.** Most drop in from above; the
pendulum does not — its 8.1 mm boss slides along the hinge, through the bearing's
bore, from outboard. Which way each part travels is published as `nodeApproachM`.

**A sub-assembly is carried over the wall, never through it** — up to `CARRY_Z`,
across, and down, as one eased motion. A straight interpolation drags the board
sideways through the enclosure wall.

**The room environment is what makes a ghost visible.** A ghosted part is a thin
shell at ~20 % opacity; what makes it read as a shell rather than vanish is being
lit from every direction. Tone mapping stays off, so a colour the reader picks
comes back as that colour.

**Flipping `material.transparent` requires `needsUpdate`.** three bakes
`#define OPAQUE` into any material compiled while `transparent === false`, so
without the flag a part that starts solid can never become see-through.

**Framing is measured from seated geometry, never live positions.** Fitting the
camera to where parts currently are measures them mid-flight, out on their
runways, and leaves the finished rig tiny in the frame.

**The arm's height comes from the URDF and is cross-checked against the meshes.**
`model/model.urdf`'s `base_to_arm` joint is the CAD authority; `export_assets.py`
reads it rather than hard-coding a height. The cross-check is the lid's wire
boss, which rides up inside the arm's wire channel — which is what makes it the
±135° hard stop — so boss top minus channel depth lands on the same seat, to
0.2 mm.

Under `prefers-reduced-motion` the timeline seeks straight to the end state and
never schedules a frame.

## Frames

Everything inside the enclosure is parented to one `enclosure` frame, declared in
`config/placement.ts`, which carries the quarter turn the box's meshes are drawn
at. So a part's position is written in the **base's own coordinates**, and reads
the same way round as the box itself rather than in world axes.

`placement.ts` declares one more frame per printed part, `<name>-mesh`, which is
its joint frame plus the turn its own mesh is drawn at. One rule with no
exceptions: **a feature of part P is written in P's mesh frame.**
