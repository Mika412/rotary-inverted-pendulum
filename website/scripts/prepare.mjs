/**
 * Everything that must happen before Astro builds.
 *
 * Runs on `npm run dev` and as the `prebuild` hook, so a plain `npm run build`
 * always regenerates from source. Deliberately dependency-free (no Python, no
 * network) so CI needs nothing but Node.
 *
 * Note what is NOT here: the documentation pages themselves. They live in
 * src/content/docs/ and are the source of truth — there is no sync step from
 * elsewhere in the repo. Only machine-readable facts are generated: the
 * firmware constants the docs render, the policy weights the demo runs, and
 * the Draco decoder.
 *
 * The heavy, rarely-changing assets — meshes, MJCF — are NOT
 * built here either; they are committed. See scripts/export_assets.py.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeConstants } from './extract_constants.mjs';
import { writeWeights } from './export_weights.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, '..');

/**
 * Self-host the Draco decoder. GLTFLoader defaults to fetching it from a CDN,
 * which fails on a locked-down static host and adds a third-party dependency
 * to a page that otherwise has none.
 */
async function copyDracoDecoder() {
  const from = path.join(SITE, 'node_modules/three/examples/jsm/libs/draco/gltf');
  const to = path.join(SITE, 'public/draco');
  await fs.mkdir(to, { recursive: true });

  const needed = ['draco_decoder.wasm', 'draco_wasm_wrapper.js'];
  for (const file of needed) {
    try {
      await fs.copyFile(path.join(from, file), path.join(to, file));
    } catch (err) {
      throw new Error(
        `prepare: could not copy ${file} from three's draco decoder (${err.code}). ` +
          `three may have moved examples/jsm/libs/draco/gltf.`
      );
    }
  }
  console.log(`prepare: draco decoder self-hosted (${needed.length} files)`);
}

/**
 * Publish the wiring diagrams. They are authored at the repository root
 * (alongside their .drawio source) and shared with the README, so the site
 * copies rather than duplicates them — one file, one CAD revision.
 */
async function copyDiagrams() {
  const from = path.resolve(SITE, '../diagrams');
  const to = path.join(SITE, 'public/diagrams');
  await fs.mkdir(to, { recursive: true });
  const wanted = (await fs.readdir(from)).filter((f) => /\.(jpe?g|png|svg)$/i.test(f));
  if (!wanted.length) {
    throw new Error(`prepare: no diagram images found in ${from}`);
  }
  for (const file of wanted) {
    await fs.copyFile(path.join(from, file), path.join(to, file));
  }
  console.log(`prepare: diagrams published (${wanted.length} images)`);
}

/** Fail early with a clear message if a committed demo asset is missing. */
async function checkCommittedAssets() {
  const required = [
    'public/sim/model.xml',
    'public/sim/scene.json',
    'public/models/base.glb',
    'public/models/arm.glb',
    'public/models/pendulum.glb',
  ];
  const missing = [];
  for (const rel of required) {
    try {
      await fs.access(path.join(SITE, rel));
    } catch {
      missing.push(rel);
    }
  }
  if (missing.length) {
    throw new Error(
      `prepare: missing committed demo assets:\n  ${missing.join('\n  ')}\n` +
        `Regenerate them with:\n  uv run --project ../RotaryInvertedPendulum-python ` +
        `python scripts/export_assets.py`
    );
  }
}

await checkCommittedAssets();

await writeConstants();
await writeWeights();
await copyDiagrams();
await copyDracoDecoder();
console.log('prepare: done');
