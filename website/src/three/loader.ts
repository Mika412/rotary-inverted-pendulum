/**
 * A GLTF loader wired to the self-hosted Draco decoder.
 *
 * Every mesh this site ships is Draco-compressed, and GLTFLoader would
 * otherwise fetch its decoder from a CDN — which fails on a locked-down static
 * host and adds a third-party request to a page that has none. `prepare.mjs`
 * copies the decoder into `public/draco/`; this points the loader at it.
 */

import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

export interface MeshLoader {
  load(url: string): Promise<import('three').Group>;
  dispose(): void;
}

/**
 * @param baseUrl site base, trailing slash included
 * @param workerLimit Draco decode workers. These scenes are a handful of small
 *   meshes, so one is plenty — and DRACOLoader has no main-thread mode, since a
 *   limit of 0 makes it dereference a worker it never created.
 */
export function createMeshLoader(baseUrl: string, workerLimit = 1): MeshLoader {
  const draco = new DRACOLoader();
  draco.setDecoderPath(`${baseUrl}draco/`);
  draco.setWorkerLimit(workerLimit);

  const gltf = new GLTFLoader();
  gltf.setDRACOLoader(draco);

  return {
    async load(url: string) {
      const asset = await gltf.loadAsync(url);
      return asset.scene;
    },
    dispose() {
      draco.dispose();
    },
  };
}
