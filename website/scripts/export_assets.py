#!/usr/bin/env python3
"""Regenerate the pinned demo assets for the documentation site.

Run this when the meshes, the URDF, the sysid parameters, or the champion
capture change:

    cd website && uv run --project ../RotaryInvertedPendulum-python \
        python scripts/export_assets.py

Outputs (all committed to git — see website/.gitignore for why):

    public/models/*.glb    draco-compressed visual meshes, metres, ~58 KB total
    public/sim/model.xml    the generated MJCF, exactly as pendulum_env builds it
    public/sim/scene.json   mesh transforms + provenance for the 3D renderer

Requires `trimesh` (in the python project) and `npx @gltf-transform/cli`.
"""

from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import sys
from pathlib import Path

SITE = Path(__file__).resolve().parent.parent
REPO = SITE.parent
RL = REPO / "RotaryInvertedPendulum-python" / "src" / "rl"

sys.path.insert(0, str(RL))

# Meshes are authored in Onshape and exported in millimetres; the physics model
# and the renderer both work in metres.
MM_TO_M = 0.001

# Visual meshes to publish. `lid` is included so the rig looks like the real
# thing; `motor plate.stl` lives inside the enclosure and is never visible.
MESHES = ["base", "lid", "arm", "pendulum"]

# Decimation is aggressive on purpose: these are 50–120k-triangle printable
# solids being used as a 60 fps web prop. 8% keeps every visible feature.
SIMPLIFY_RATIO = "0.08"
SIMPLIFY_ERROR = "0.002"


def log(msg: str) -> None:
    print(f"export_assets: {msg}", flush=True)


def export_meshes(out_dir: Path) -> dict[str, dict]:
    import trimesh

    out_dir.mkdir(parents=True, exist_ok=True)
    gltf_transform = shutil.which("gltf-transform") or "npx"
    use_npx = gltf_transform == "npx"

    info: dict[str, dict] = {}
    tmp_dir = out_dir / "_raw"
    tmp_dir.mkdir(exist_ok=True)

    for name in MESHES:
        src = REPO / "meshes" / f"{name}.stl"
        mesh = trimesh.load(src)
        mesh.merge_vertices()
        raw_tris = len(mesh.faces)

        # Convert to metres in the mesh's own authored frame. The renderer
        # applies the joint transforms; baking scale here keeps scene.json
        # in SI units and the glb directly usable.
        mesh.apply_scale(MM_TO_M)
        bounds = mesh.bounds.tolist()

        raw = tmp_dir / f"{name}.glb"
        mesh.export(raw)

        final = out_dir / f"{name}.glb"
        cmd = (["npx", "--yes", "@gltf-transform/cli"] if use_npx else [gltf_transform]) + [
            "optimize",
            str(raw),
            str(final),
            "--compress",
            "draco",
            "--simplify",
            "true",
            "--simplify-ratio",
            SIMPLIFY_RATIO,
            "--simplify-error",
            SIMPLIFY_ERROR,
            "--no-prune-attributes",
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, cwd=SITE)
        if result.returncode != 0 or not final.exists():
            raise SystemExit(
                f"gltf-transform failed for {name}:\n{result.stdout}\n{result.stderr}"
            )

        info[name] = {
            "file": f"models/{name}.glb",
            "sourceTriangles": raw_tris,
            "bytes": final.stat().st_size,
            "boundsM": bounds,
        }
        log(
            f"{name}: {raw_tris} tris, {src.stat().st_size / 1048576:.2f} MB STL "
            f"-> {final.stat().st_size / 1024:.0f} KB glb"
        )

    shutil.rmtree(tmp_dir)
    return info


def export_mjcf(out_dir: Path) -> str:
    """Dump the MJCF exactly as the training environment builds it."""
    from pendulum_env import PendulumParams, build_mjcf

    params = PendulumParams.load()
    xml = build_mjcf(params)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "model.xml").write_text(xml)
    log(f"model.xml: {len(xml)} bytes")
    return xml


# --- Joint frames measured from the committed STLs --------------------------
# A mesh posed by a joint angle orbits about its own origin, so a mesh whose
# origin is off its bearing axis visibly detaches — and one whose *axes* are
# mapped wrongly stays attached while pointing the part in the wrong direction.
# Both were measured by ray-casting the committed STLs; they are properties of
# those files, so they only change if the parts are re-exported from CAD.
#
#   arm:      motor shaft bore centred on the mesh origin (5.2 mm dia, r=2.6,
#             with the shaft's D-flat chord at x=+2.1). Blind, open at the
#             bottom face, roof at z=16.0 mm. So the origin is already the
#             motor axis, and z=0 is the arm's underside.
#             Pendulum bearing pocket at (y=0, z=14.0) mm, r=9.5–11.05 (the
#             608's 22 mm OD), spanning x≈49–60 mm — the z=14 agrees exactly
#             with the z of urdf/model.urdf's arm_to_pendulum origin.
#   pendulum: the pivot is an 8.1 mm-diameter boss (the 608's 8 mm bore) whose
#             axis runs along the mesh's *y*, centred at mesh (x=0, z=0) and
#             protruding from the plate face at y=+3 to y≈+12.5. The mesh
#             origin already lies on that axis, at the plate mid-plane — the
#             part is a 6 mm-thick plate in the mesh x–z plane, with the rod
#             along +z and the 2p pocket at z≈50–76.
#
# So the pendulum needs no translation at all: it needs its mesh y mapped onto
# the hinge axis. Treating mesh x as the hinge (and patching the result with a
# 6 mm y shift) left the plate edge-on, spanning +-16 mm ALONG the arm with the
# coin facing down it. The boss points inboard, toward the motor: it has to, or
# its 9.5 mm could not reach the arm's bearing pocket at x≈49–60 mm from a
# pivot at 62–65 mm.
ARM_PIVOT_Z_M = 0.014
PENDULUM_MESH_RPY = (0.0, 0.0, math.pi / 2)


def build_scene(mesh_info: dict[str, dict]) -> dict:
    """Visual transform chain for the renderer.

    The pivot radius comes from the simulation (ARM_LENGTH_M = 0.065); the pivot
    *height* and the pendulum's bore offset are measured:

      - urdf/model.urdf agrees on the pivot height (z=0.014, confirmed by
        measurement) but puts the reach at x=0.062 rather than 0.065. Which is
        right is an open CAD question; the renderer follows the simulation so
        that what you see matches the plant the policy was trained against.
      - the meshes carry no joint frames, so the pendulum's own pivot axis has
        to be measured or the part is posed about the wrong axis.

    The arm mesh ends at x=60 mm while the pivot is at 65 mm; that is correct,
    not a discrepancy — the pendulum's 32 mm hub is cantilevered outboard of the
    arm's bearing pocket (measured at x≈49–60 mm), which puts its centre, and
    therefore the pendulum's mass, at ~65 mm.
    """
    import pendulum_env as pe

    # Mesh-frame facts measured from the STL bounds, in metres.
    base_top_z = mesh_info["base"]["boundsM"][1][2]

    return {
        "_note": (
            "Visual transforms for the 3D demo, from bore centres measured in "
            "the meshes. See build_scene in scripts/export_assets.py."
        ),
        "units": "metres",
        "armPivotXM": pe.ARM_LENGTH_M,
        "armPivotZM": ARM_PIVOT_Z_M,
        "baseTopZ": base_top_z,
        "nodes": {
            # The enclosure is static; the arm plane sits on top of it.
            "base": {"mesh": "base", "parent": None, "position": [0, 0, 0]},
            "lid": {"mesh": "lid", "parent": None, "position": [0, 0, base_top_z]},
            # Rotates about +z by the motor angle. The motor bore is already at
            # the mesh origin, so no mesh offset is needed.
            "arm": {
                "mesh": "arm",
                "parent": None,
                "position": [0, 0, base_top_z],
                "rotationAxis": "z",
                "joint": "motor",
            },
            # Sits on the arm's bearing bore and rotates about the arm's local
            # +x. meshRotationRad turns the mesh inside this group so its own
            # pivot axis (mesh y) lands on that hinge; the mesh origin is
            # already on the axis, so no translation is needed. The mesh is
            # authored with the rod pointing +z while qpos=0 hangs the pendulum
            # along -z, hence the pi angle offset.
            "pendulum": {
                "mesh": "pendulum",
                "parent": "arm",
                "position": [pe.ARM_LENGTH_M, 0.0, ARM_PIVOT_Z_M],
                "meshRotationRad": list(PENDULUM_MESH_RPY),
                "rotationAxis": "x",
                "joint": "pendulum",
                "angleOffsetRad": math.pi,
            },
        },
        "meshes": mesh_info,
    }


def main() -> None:
    import argparse

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--skip-meshes", action="store_true", help="only refresh sim/ assets")
    args = ap.parse_args()

    models = SITE / "public" / "models"
    sim = SITE / "public" / "sim"

    if args.skip_meshes:
        mesh_info = json.loads((sim / "scene.json").read_text())["meshes"]
        log("skipping mesh export, reusing transforms from scene.json")
    else:
        mesh_info = export_meshes(models)
    export_mjcf(sim)
    scene = build_scene(mesh_info)
    (sim / "scene.json").write_text(json.dumps(scene, indent=2) + "\n")
    log(f"scene.json: {len(scene['nodes'])} nodes")

    total = sum(m["bytes"] for m in mesh_info.values())
    log(f"done — {total / 1024:.0f} KB of meshes total")


if __name__ == "__main__":
    main()
