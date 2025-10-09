import * as BABYLON from "@babylonjs/core";

export interface MeshData {
  name: string;
  vertices: number[];      // [x,y,z, x,y,z, ...]
  indices: number[];       // triangle indices
  normals: number[];       // [nx,ny,nz, ...]
  uvs?: number[];          // [u,v, u,v, ...]
  colors?: number[];       // [r,g,b,a, r,g,b,a, ...] vertex colors
}

/**
 * Builds a Babylon.js mesh from raw vertex data
 */
export function createMeshFromData(
  meshData: MeshData,
  scene: BABYLON.Scene
): BABYLON.Mesh {
  const mesh = new BABYLON.Mesh(meshData.name, scene);

  const vertexData = new BABYLON.VertexData();

  vertexData.positions = meshData.vertices;
  vertexData.indices = meshData.indices;
  vertexData.normals = meshData.normals;

  if (meshData.uvs && meshData.uvs.length > 0) {
    vertexData.uvs = meshData.uvs;
  }

  if (meshData.colors && meshData.colors.length > 0) {
    vertexData.colors = meshData.colors;
  }

  vertexData.applyToMesh(mesh);

  // Create default material with vertex colors if available
  const material = new BABYLON.StandardMaterial(`${meshData.name}_mat`, scene);

  if (meshData.colors && meshData.colors.length > 0) {
    material.diffuseColor = new BABYLON.Color3(1, 1, 1);
    // Enable vertex colors by setting emissive to use vertex alpha
    mesh.useVertexColors = true;
  } else {
    material.diffuseColor = new BABYLON.Color3(0.7, 0.7, 0.7);
  }

  material.specularColor = new BABYLON.Color3(0.2, 0.2, 0.2);
  material.backFaceCulling = true;

  mesh.material = material;

  return mesh;
}

/**
 * Serialize mesh to MeshData for storage
 */
export function meshToData(mesh: BABYLON.Mesh): MeshData | null {
  const positions = mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
  const indices = mesh.getIndices();
  const normals = mesh.getVerticesData(BABYLON.VertexBuffer.NormalKind);

  if (!positions || !indices || !normals) {
    return null;
  }

  const meshData: MeshData = {
    name: mesh.name,
    vertices: Array.from(positions),
    indices: Array.from(indices),
    normals: Array.from(normals),
  };

  const uvs = mesh.getVerticesData(BABYLON.VertexBuffer.UVKind);
  if (uvs) {
    meshData.uvs = Array.from(uvs);
  }

  const colors = mesh.getVerticesData(BABYLON.VertexBuffer.ColorKind);
  if (colors) {
    meshData.colors = Array.from(colors);
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
