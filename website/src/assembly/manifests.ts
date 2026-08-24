/**
 * The shapes of the three JSON manifests the tutorial loads at runtime.
 *
 * They live here rather than beside the code that consumes them because all
 * three are produced by the build scripts and read by more than one layer: the
 * loader, the wiring resolver and the plain-Node tests each need the same
 * declarations. Keeping them in `parts.ts` also meant the tutorial imported
 * `SceneManifest` from the front-page demo, which is backwards — the demo is
 * not a dependency of the build guide.
 *
 * Produced by, respectively:
 *   AssemblyManifest  scripts/build_assembly.py   -> public/sim/assembly.json
 *   VendorManifest    scripts/build_vendor_parts.py -> public/models/vendor/manifest.json
 *   SceneManifest     scripts/export_assets.py    -> public/sim/scene.json
 */
import type { FrameSpec } from './parts.ts';

export interface AssemblyManifest {
  baseTopZ: number;
  /** Where a printed part seats, overriding `scene.json`. Hand-editable. */
  nodePositionM?: Record<string, [number, number, number]>;
  /** Which way each printed part is offered up, in its own parent's frame. */
  nodeApproachM?: Record<string, [number, number, number]>;
  frames: Record<string, FrameSpec>;
  features: Record<string, Record<string, { value: number | number[]; source: string }>>;
  parts: Record<
    string,
    {
      kind: 'printed' | 'vendor';
      mesh?: string;
      model?: string;
      parent: string | null;
      position: [number, number, number];
      meshRotationRad?: [number, number, number];
      approach: [number, number, number];
      note?: string;
      approximate?: boolean;
      source?: string;
    }
  >;
}

export interface VendorManifest {
  parts: Record<
    string,
    {
      file: string;
      label: string;
      colour?: string;
      finish?: { roughness: number; metalness: number };
      approximate?: string;
      /** How this part is joined, which is what decides where its wire lands. */
      mount?: string;
      /** False only for parts that do not fill their own bounding box. */
      solid?: boolean;
      anchors?: Record<string, [number, number, number]>;
      /** Which way a wire leaves each pad: along the tag, or out of the shell. */
      leads?: Record<string, [number, number, number]>;
      /** A carrier board's hole grid, so wiring can be declared as indices. */
      grid?: {
        pitchM: number;
        cols: number;
        rows: number;
        originM: [number, number, number];
      };
      boundsM?: [number, number, number][];
    }
  >;
}

/**
 * `scene.json` — the finished rig's mesh transforms. Shared with the front-page
 * demo, which poses the same four meshes from two joint angles.
 */
export interface SceneManifest {
  armLengthM: number;
  baseTopZ: number;
  nodes: Record<
    string,
    {
      mesh?: string;
      parent?: string | null;
      position: [number, number, number];
      meshOffset?: [number, number, number];
      meshRotationRad?: [number, number, number];
      physicsOffsetM?: [number, number, number];
      rotationAxis?: 'x' | 'y' | 'z';
      joint?: string;
      angleOffsetRad?: number;
    }
  >;
  meshes: Record<string, { file: string }>;
}

