import * as THREE from "three";
import { DEFAULT_FOLIAGE_QUALITY_PROFILE } from "./FoliageQualityProfile";

export interface LeafCardOptions {
  width: number;
  height: number;
  seed: number;
  curve?: number;
  atlasColumns?: number;
  atlasRows?: number;
}

interface AtlasRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

function seeded01(seed: number): number {
  const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return value - Math.floor(value);
}

function getAtlasRect(
  seed: number,
  columns: number,
  rows: number
): AtlasRect {
  const frameCount = Math.max(1, columns * rows);
  const frameIndex =
    Math.floor(seeded01(seed * 1.91) * frameCount) % frameCount;
  const col = frameIndex % columns;
  const row = Math.floor(frameIndex / columns);

  const cellU = 1 / Math.max(1, columns);
  const cellV = 1 / Math.max(1, rows);
  const padU = cellU * 0.08;
  const padV = cellV * 0.08;

  // Three.js UV origin is bottom-left (same as OpenGL), so row order is natural.
  // Babylon.js had top-to-bottom V axis, so we keep the same flip for atlas consistency.
  const vRow = rows - 1 - row;

  return {
    u0: col * cellU + padU,
    u1: (col + 1) * cellU - padU,
    v0: vRow * cellV + padV,
    v1: (vRow + 1) * cellV - padV,
  };
}

/**
 * Compute normals from positions and indices (equivalent to VertexData.ComputeNormals).
 */
function computeNormals(
  positions: number[],
  indices: number[],
  normals: number[]
): void {
  for (let i = 0; i < normals.length; i++) normals[i] = 0;

  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const v3 = new THREE.Vector3();
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();
  const faceNormal = new THREE.Vector3();

  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i];
    const i1 = indices[i + 1];
    const i2 = indices[i + 2];

    v1.set(positions[i0 * 3], positions[i0 * 3 + 1], positions[i0 * 3 + 2]);
    v2.set(positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]);
    v3.set(positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]);

    edge1.subVectors(v2, v1);
    edge2.subVectors(v3, v1);
    faceNormal.crossVectors(edge1, edge2);

    for (const idx of [i0, i1, i2]) {
      normals[idx * 3] += faceNormal.x;
      normals[idx * 3 + 1] += faceNormal.y;
      normals[idx * 3 + 2] += faceNormal.z;
    }
  }

  // Normalize
  const n = new THREE.Vector3();
  for (let i = 0; i < normals.length; i += 3) {
    n.set(normals[i], normals[i + 1], normals[i + 2]).normalize();
    normals[i] = n.x;
    normals[i + 1] = n.y;
    normals[i + 2] = n.z;
  }
}

export function createLeafCardGeometry(
  options: LeafCardOptions
): THREE.BufferGeometry {
  const width = Math.max(0.02, options.width);
  const height = Math.max(0.03, options.height);
  const curve =
    options.curve ?? 0.04 + seeded01(options.seed * 3.17) * 0.12;
  const columns =
    options.atlasColumns ??
    DEFAULT_FOLIAGE_QUALITY_PROFILE.leafAtlas.frameColumns;
  const rows =
    options.atlasRows ?? DEFAULT_FOLIAGE_QUALITY_PROFILE.leafAtlas.frameRows;

  const halfW = width * 0.5;
  const midY = height * (0.48 + seeded01(options.seed * 2.13) * 0.18);
  const midW = halfW * (0.45 + seeded01(options.seed * 5.23) * 0.35);
  const tipForward = curve * (0.9 + seeded01(options.seed * 7.71) * 0.35);

  const positions = [
    -halfW, 0, 0,
    halfW, 0, 0,
    -midW, midY, curve * 0.45,
    midW, midY, curve * 0.45,
    0, height, tipForward,
  ];

  const indices = [0, 1, 2, 1, 3, 2, 2, 3, 4];

  const normals = new Array(positions.length).fill(0);
  computeNormals(positions, indices, normals);

  const rect = getAtlasRect(options.seed, columns, rows);
  const vMid = rect.v0 + (rect.v1 - rect.v0) * 0.48;
  const uCenter = (rect.u0 + rect.u1) * 0.5;

  const uvs = [
    rect.u0, rect.v1,
    rect.u1, rect.v1,
    rect.u0, vMid,
    rect.u1, vMid,
    uCenter, rect.v0,
  ];

  const vertexCount = positions.length / 3;
  const colors = new Float32Array(vertexCount * 4);
  for (let i = 0; i < vertexCount; i++) {
    colors[i * 4] = 0.224;
    colors[i * 4 + 1] = 0.424;
    colors[i * 4 + 2] = 0.094;
    colors[i * 4 + 3] = 1.0;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(positions), 3)
  );
  geometry.setAttribute(
    "normal",
    new THREE.BufferAttribute(new Float32Array(normals), 3)
  );
  geometry.setAttribute(
    "uv",
    new THREE.BufferAttribute(new Float32Array(uvs), 2)
  );
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 4));
  geometry.setIndex(indices);

  return geometry;
}
