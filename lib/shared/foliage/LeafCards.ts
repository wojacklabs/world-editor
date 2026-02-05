import { Mesh, Scene, VertexData, VertexBuffer } from "@babylonjs/core";
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
  const frameIndex = Math.floor(seeded01(seed * 1.91) * frameCount) % frameCount;
  const col = frameIndex % columns;
  const row = Math.floor(frameIndex / columns);

  const cellU = 1 / Math.max(1, columns);
  const cellV = 1 / Math.max(1, rows);
  const padU = cellU * 0.08;
  const padV = cellV * 0.08;

  // Babylon's texture V axis is top-to-bottom, so rows are flipped here.
  const vRow = rows - 1 - row;

  return {
    u0: col * cellU + padU,
    u1: (col + 1) * cellU - padU,
    v0: vRow * cellV + padV,
    v1: (vRow + 1) * cellV - padV,
  };
}

export function createLeafCardMesh(
  name: string,
  scene: Scene,
  options: LeafCardOptions
): Mesh {
  const width = Math.max(0.02, options.width);
  const height = Math.max(0.03, options.height);
  const curve = options.curve ?? (0.04 + seeded01(options.seed * 3.17) * 0.12);
  const columns =
    options.atlasColumns ?? DEFAULT_FOLIAGE_QUALITY_PROFILE.leafAtlas.frameColumns;
  const rows =
    options.atlasRows ?? DEFAULT_FOLIAGE_QUALITY_PROFILE.leafAtlas.frameRows;

  const halfW = width * 0.5;
  const midY = height * (0.48 + seeded01(options.seed * 2.13) * 0.18);
  const midW = halfW * (0.45 + seeded01(options.seed * 5.23) * 0.35);
  const tipForward = curve * (0.9 + seeded01(options.seed * 7.71) * 0.35);

  const positions = [
    -halfW,
    0,
    0,
    halfW,
    0,
    0,
    -midW,
    midY,
    curve * 0.45,
    midW,
    midY,
    curve * 0.45,
    0,
    height,
    tipForward,
  ];

  const indices = [0, 1, 2, 1, 3, 2, 2, 3, 4];

  const normals = new Array(positions.length).fill(0);
  VertexData.ComputeNormals(positions, indices, normals);

  const rect = getAtlasRect(options.seed, columns, rows);
  const vMid = rect.v0 + (rect.v1 - rect.v0) * 0.48;
  const uCenter = (rect.u0 + rect.u1) * 0.5;

  const uvs = [
    rect.u0,
    rect.v1,
    rect.u1,
    rect.v1,
    rect.u0,
    vMid,
    rect.u1,
    vMid,
    uCenter,
    rect.v0,
  ];

  const mesh = new Mesh(name, scene);
  const vertexData = new VertexData();
  vertexData.positions = positions;
  vertexData.indices = indices;
  vertexData.normals = normals;
  vertexData.uvs = uvs;
  vertexData.applyToMesh(mesh);

  // Ensure cards always have explicit color data for shader code paths.
  // Default color = grass base rgb(57,108,24)/255 (overwritten by setLeafVertexColors)
  const vertexCount = positions.length / 3;
  const colors = new Float32Array(vertexCount * 4);
  for (let i = 0; i < vertexCount; i++) {
    colors[i * 4] = 0.224;
    colors[i * 4 + 1] = 0.424;
    colors[i * 4 + 2] = 0.094;
    colors[i * 4 + 3] = 1.0;
  }
  mesh.setVerticesData(VertexBuffer.ColorKind, colors);

  return mesh;
}
