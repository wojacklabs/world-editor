import * as THREE from "three";

export interface MeshData {
  name: string;
  vertices: number[];      // [x,y,z, x,y,z, ...]
  indices: number[];       // triangle indices
  normals: number[];       // [nx,ny,nz, ...]
  uvs?: number[];          // [u,v, u,v, ...]
  colors?: number[];       // [r,g,b,a, r,g,b,a, ...] vertex colors
}

/**
 * Builds a Three.js mesh from raw vertex data
 */
export function createMeshFromData(
  meshData: MeshData,
  scene: THREE.Scene
): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();

  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(meshData.vertices), 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(meshData.normals), 3));
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(meshData.indices), 1));

  if (meshData.uvs && meshData.uvs.length > 0) {
    geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(meshData.uvs), 2));
  }

  if (meshData.colors && meshData.colors.length > 0) {
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(meshData.colors), 4));
  }

  // Create default material with vertex colors if available
  const material = new THREE.MeshStandardMaterial({
    color: meshData.colors && meshData.colors.length > 0 ? 0xffffff : 0xb3b3b3,
    vertexColors: !!(meshData.colors && meshData.colors.length > 0),
    metalness: 0.1,
    roughness: 0.8,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = meshData.name;

  scene.add(mesh);

  return mesh;
}

/**
 * Serialize mesh to MeshData for storage
 */
export function meshToData(mesh: THREE.Mesh): MeshData | null {
  const geometry = mesh.geometry;
  const posAttr = geometry.getAttribute("position");
  const normalAttr = geometry.getAttribute("normal");
  const indexAttr = geometry.index;

  if (!posAttr || !indexAttr || !normalAttr) {
    return null;
  }

  const meshData: MeshData = {
    name: mesh.name,
    vertices: Array.from(posAttr.array as Float32Array),
    indices: Array.from(indexAttr.array as Uint32Array),
    normals: Array.from(normalAttr.array as Float32Array),
  };

  const uvAttr = geometry.getAttribute("uv");
  if (uvAttr) {
    meshData.uvs = Array.from(uvAttr.array as Float32Array);
  }

  const colorAttr = geometry.getAttribute("color");
  if (colorAttr) {
    meshData.colors = Array.from(colorAttr.array as Float32Array);
  }

  return meshData;
}

/**
 * Validate mesh data integrity
 */
export function validateMeshData(meshData: MeshData): { valid: boolean; error?: string } {
  if (!meshData.vertices || meshData.vertices.length === 0) {
    return { valid: false, error: "No vertices" };
  }

  if (meshData.vertices.length % 3 !== 0) {
    return { valid: false, error: "Vertices count must be multiple of 3" };
  }

  if (!meshData.indices || meshData.indices.length === 0) {
    return { valid: false, error: "No indices" };
  }

  if (meshData.indices.length % 3 !== 0) {
    return { valid: false, error: "Indices count must be multiple of 3 (triangles)" };
  }

  if (!meshData.normals || meshData.normals.length !== meshData.vertices.length) {
    return { valid: false, error: "Normals count must match vertices count" };
  }

  const vertexCount = meshData.vertices.length / 3;
  const maxIndex = Math.max(...meshData.indices);

  if (maxIndex >= vertexCount) {
    return { valid: false, error: `Index ${maxIndex} exceeds vertex count ${vertexCount}` };
  }

  if (meshData.uvs && meshData.uvs.length !== vertexCount * 2) {
    return { valid: false, error: "UVs count must be vertexCount * 2" };
  }

  if (meshData.colors && meshData.colors.length !== vertexCount * 4) {
    return { valid: false, error: "Colors count must be vertexCount * 4 (RGBA)" };
  }

  return { valid: true };
}
