/**
 * Verify the visual transform chain puts the parts where the physics says they are.
 *
 * The 3D scene is posed from joint angles through a parent/child chain described
 * by public/sim/scene.json. Getting a sign or an axis wrong produces a rig that
 * looks plausible in a still frame but is subtly wrong in motion — a pendulum
 * pivoting about the wrong axis, or hanging up instead of down. These assertions
 * pin the chain to world coordinates that can be checked by hand.
 *
 *   node --experimental-strip-types tests/scene_geometry.test.mts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Group, Vector3 } from 'three';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, '..');

const scene = JSON.parse(
  await fs.readFile(path.join(SITE, 'public/sim/scene.json'), 'utf8')
);

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

/** Rebuild the same graph the renderer builds, without WebGL.
 *
 * `meshes` are the mesh children *inside* each joint group, carrying the same
 * offset and rotation the renderer applies to the loaded glb. Points quoted in
 * a part's own authored (mesh) frame must be transformed through these, not
 * through the joint group — that distinction is the whole point of this file. */
function buildGraph() {
  const root = new Group();
  const groups = new Map<string, Group>();
  const meshes = new Map<string, Group>();
  for (const name of Object.keys(scene.nodes)) groups.set(name, new Group());

  for (const [name, node] of Object.entries(scene.nodes) as [string, any][]) {
    const g = groups.get(name)!;
    (node.parent ? groups.get(node.parent)! : root).add(g);
    g.position.set(...(node.position as [number, number, number]));

    const mesh = new Group();
    if (node.meshOffset) mesh.position.set(...(node.meshOffset as [number, number, number]));
    if (node.meshRotationRad) {
      mesh.rotation.set(...(node.meshRotationRad as [number, number, number]));
    }
    g.add(mesh);
    meshes.set(name, mesh);
  }
  return { root, groups, meshes };
}

function pose(motorRad: number, pendulumRad: number) {
  const { root, groups, meshes } = buildGraph();
  for (const [name, node] of Object.entries(scene.nodes) as [string, any][]) {
    if (!node.joint) continue;
    const angle = (node.joint === 'motor' ? motorRad : pendulumRad) + (node.angleOffsetRad ?? 0);
    const g = groups.get(name)!;
    g.rotation.set(0, 0, 0);
    g.rotation[node.rotationAxis as 'x' | 'y' | 'z'] = angle;
  }
  root.updateMatrixWorld(true);
  return { groups, meshes };
}

// Pivot radius and height are measured bore centres, not ARM_LENGTH_M — see
// build_scene in scripts/export_assets.py.
const L = scene.armPivotXM as number;
const pivotZ = scene.armPivotZM as number;
const baseTop = scene.baseTopZ as number;

// Landmarks in the pendulum's own authored frame, read off its mesh bounds:
// the rod runs to +z, the flat plate spans +-x, and the pivot boss (which is
// what the hinge must actually turn about) protrudes to +y.
const [pendMin, pendMax] = scene.meshes.pendulum.boundsM as [number[], number[]];
const rodLength = pendMax[2];
const plateHalfWidth = pendMax[0];
const bossTip = pendMax[1];

const tipMesh = new Vector3(0, 0, rodLength);
const plateEdgeMesh = new Vector3(plateHalfWidth, 0, 0);
const bossTipMesh = new Vector3(0, bossTip, 0);

/** A point quoted in the pendulum's authored frame, in world coordinates. */
function pendulumPoint(p: Vector3, motorRad: number, pendulumRad: number): Vector3 {
  const { meshes } = pose(motorRad, pendulumRad);
  return meshes.get('pendulum')!.localToWorld(p.clone());
}

const tipWorld = (m: number, p: number) => pendulumPoint(tipMesh, m, p);

function pivotWorld(motorRad: number, pendulumRad: number): Vector3 {
  const { groups } = pose(motorRad, pendulumRad);
  return groups.get('pendulum')!.localToWorld(new Vector3(0, 0, 0));
}

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

console.log(
  `pivot radius ${(L * 1000).toFixed(1)} mm, pivot height ${(pivotZ * 1000).toFixed(1)} mm, ` +
    `rod ${(rodLength * 1000).toFixed(1)} mm, plate half-width ` +
    `${(plateHalfWidth * 1000).toFixed(1)} mm, boss ${(bossTip * 1000).toFixed(1)} mm\n`
);

check('the pivot sits at the arm tip when the motor is centred', () => {
  const p = pivotWorld(0, 0);
  assert.ok(near(p.x, L), `pivot x = ${p.x}, expected ${L}`);
  assert.ok(near(p.y, 0), `pivot y = ${p.y}, expected 0`);
  assert.ok(near(p.z, baseTop + pivotZ), `pivot z = ${p.z}, expected ${baseTop + pivotZ}`);
});

check('rotating the motor sweeps the pivot around the z axis', () => {
  const p = pivotWorld(Math.PI / 2, 0);
  assert.ok(near(p.x, 0, 1e-9), `pivot x = ${p.x}, expected ~0`);
  assert.ok(near(p.y, L), `pivot y = ${p.y}, expected ${L}`);
  assert.ok(
    near(p.z, baseTop + pivotZ),
    `pivot z = ${p.z} should not change with motor angle`
  );
  // The pivot must stay on a circle of radius L about the origin.
  assert.ok(near(Math.hypot(p.x, p.y), L), 'pivot left the arm-length circle');
});

check('pendulum angle 0 hangs the rod straight DOWN', () => {
  // MuJoCo qpos=0 is the resting pose. If this comes out above the arm plane,
  // the mesh offset is wrong and the demo would show it balanced at rest.
  const tip = tipWorld(0, 0);
  assert.ok(
    tip.z < baseTop,
    `tip z = ${tip.z} is not below the arm plane at ${baseTop} — the rod points up`
  );
  assert.ok(near(tip.z, baseTop + pivotZ - rodLength, 1e-6), `tip z = ${tip.z}`);
  assert.ok(near(tip.x, L), `tip x = ${tip.x} should stay at the pivot's x`);
});

check('pendulum angle pi stands the rod UP', () => {
  const tip = tipWorld(0, Math.PI);
  assert.ok(
    tip.z > baseTop,
    `tip z = ${tip.z} is not above the arm plane — upright is not upright`
  );
  assert.ok(near(tip.z, baseTop + pivotZ + rodLength, 1e-6), `tip z = ${tip.z}`);
});

check('the pendulum swings about the arm-local x axis', () => {
  // At a quarter turn the rod should lie horizontally, displaced in y, with the
  // pivot's x unchanged — that is what "hinge about x" means.
  const tip = tipWorld(0, Math.PI / 2);
  assert.ok(near(tip.z, baseTop + pivotZ, 1e-6), `tip z = ${tip.z}`);
  assert.ok(near(Math.abs(tip.y), rodLength, 1e-6), `|tip y| = ${Math.abs(tip.y)}`);
  assert.ok(near(tip.x, L), `tip x = ${tip.x} moved off the pivot`);
});

check('the swing plane rotates with the arm', () => {
  // With the arm at 90 degrees, the horizontal rod must now be displaced in x,
  // because the hinge axis rotated with its parent.
  const tip = tipWorld(Math.PI / 2, Math.PI / 2);
  assert.ok(near(tip.z, baseTop + pivotZ, 1e-6), `tip z = ${tip.z}`);
  assert.ok(
    near(Math.abs(tip.x), rodLength, 1e-6),
    `|tip x| = ${Math.abs(tip.x)}, expected the rod length — the hinge did not follow the arm`
  );
});

// The checks above all pass with the pendulum mesh turned a quarter turn about
// the vertical, because a rod is symmetric about its own length. The part is
// not a rod: it is a flat plate with a 2p coin in it, and it has to swing in
// its own plane. These two pin the mesh's own axes to the joint's.
check('the plate swings in its own plane, not edge-on along the arm', () => {
  for (const [m, p] of [
    [0, 0],
    [0.4, 1.1],
    [-1.9, 2.7],
  ]) {
    // The hinge axis is the arm's direction, which follows the motor.
    const hinge = new Vector3(Math.cos(m), Math.sin(m), 0);
    const edge = pendulumPoint(plateEdgeMesh, m, p).sub(pivotWorld(m, p));
    assert.ok(
      near(edge.dot(hinge), 0, 1e-9),
      `the plate's width has a ${edge.dot(hinge)} m component along the hinge ` +
        `at (${m}, ${p}) — it should be entirely across it. The plate is edge-on: ` +
        `the mesh is being posed about the wrong axis.`
    );
    assert.ok(near(edge.length(), plateHalfWidth, 1e-9), `plate edge moved: ${edge.length()}`);
  }
});

check('the pivot boss points inboard, toward the motor', () => {
  // The boss is only 14 mm long and has to reach the arm's bearing pocket,
  // which is inboard of the pivot. Pointing it outboard mirrors the part.
  for (const [m, p] of [
    [0, 0],
    [0.4, 1.1],
    [2.1, -0.6],
  ]) {
    const boss = pendulumPoint(bossTipMesh, m, p);
    const radius = Math.hypot(boss.x, boss.y);
    assert.ok(
      near(radius, L - bossTip, 1e-9),
      `the boss tip sits at radius ${radius} at (${m}, ${p}), expected ${L - bossTip} ` +
        `— it is pointing outboard, away from the arm's bearing`
    );
  }
});

check('the rod stays a constant distance from its pivot', () => {
  for (const [m, p] of [
    [0, 0],
    [0.4, 1.1],
    [-1.9, 2.7],
    [2.1, -0.6],
  ]) {
    const d = tipWorld(m, p).distanceTo(pivotWorld(m, p));
    assert.ok(near(d, tipMesh.length(), 1e-9), `pivot-to-tip became ${d} at (${m}, ${p})`);
  }
});

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
