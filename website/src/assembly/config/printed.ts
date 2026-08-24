/**
 * The printed parts, and the glTF each is drawn from.
 *
 * The same five meshes the front-page demo shows. Declared here so the build
 * guide does not have to read the demo's `scene.json` to find out where a
 * printed part goes — and so moving one is an edit in this directory like every
 * other placement.
 */
import type { SceneManifest } from '../manifests.ts';

export const PRINTED: SceneManifest = {
  baseTopZ: 0.07,
  nodes: {
    base: {
      mesh: "base",
      parent: null,
      position: [0, 0, 0],
      meshRotationRad: [0, 0, 1.570796],
    },
    lid: {
      mesh: "lid",
      parent: null,
      position: [0, 0, 0.07],
      meshRotationRad: [0, 0, 1.570796],
    },
    arm: {
      mesh: "arm",
      parent: null,
      position: [0, 0, 0.07],
      rotationAxis: "z",
      joint: "motor",
    },
    pendulum: {
      mesh: "pendulum",
      parent: "arm",
      position: [0.065, 0, 0.014],
      physicsOffsetM: [0, 0, 0.084],
      meshRotationRad: [0, 0, 1.570796],
      rotationAxis: "x",
      joint: "pendulum",
      angleOffsetRad: 3.141593,
    },
  },
  meshes: {
    base: {
      file: "models/base.glb",
      sourceTriangles: 82142,
      bytes: 16820,
      boundsM: [
        [-0.043598, -0.043598, 0],
        [0.043598, 0.043598, 0.07],
      ],
    },
    lid: {
      file: "models/lid.glb",
      sourceTriangles: 76598,
      bytes: 12708,
      boundsM: [
        [-0.043598, -0.043598, -0.004],
        [0.043598, 0.043598, 0.01],
      ],
    },
    arm: {
      file: "models/arm.glb",
      sourceTriangles: 124280,
      bytes: 19980,
      boundsM: [
        [-0.014, -0.014, 0],
        [0.06, 0.014, 0.028],
      ],
    },
    pendulum: {
      file: "models/pendulum.glb",
      sourceTriangles: 52754,
      bytes: 9800,
      boundsM: [
        [-0.016, -0.003, -0.008998],
        [0.016, 0.014, 0.08],
      ],
    },
    "motor plate": {
      file: "models/motor plate.glb",
      sourceTriangles: 97516,
      bytes: 16820,
      boundsM: [
        [-0.0415, -0.0415, 0],
        [0.0415, 0.0415, 0.012],
      ],
    },
  },
};
