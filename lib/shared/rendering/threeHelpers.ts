import * as THREE from "three";

/**
 * Dispose a mesh and optionally its geometry/material, then remove from scene.
 */
export function disposeMesh(
  scene: THREE.Scene,
  mesh: THREE.Object3D | null | undefined
): void {
  if (!mesh) return;
  scene.remove(mesh);

  if (mesh instanceof THREE.Mesh || mesh instanceof THREE.InstancedMesh) {
    mesh.geometry?.dispose();
    if (mesh.material) {
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((m) => disposeMaterial(m));
      } else {
        disposeMaterial(mesh.material);
      }
    }
  }

  // Recurse into children
  while (mesh.children.length > 0) {
    disposeMesh(scene, mesh.children[0]);
  }
}

function disposeMaterial(mat: THREE.Material): void {
  // Dispose textures on shader/standard materials
  if (mat instanceof THREE.ShaderMaterial) {
    for (const key of Object.keys(mat.uniforms)) {
      const val = mat.uniforms[key].value;
      if (val instanceof THREE.Texture) {
        val.dispose();
      }
    }
  }
  mat.dispose();
}

/**
 * Create a DataTexture from raw RGBA Uint8Array data.
 */
export function createDataTexture(
  data: Uint8Array,
  width: number,
  height: number
): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  tex.needsUpdate = true;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  return tex;
}

/**
 * Create a DataTexture from Float32Array (single channel / float format).
 */
export function createFloatDataTexture(
  data: Float32Array,
  width: number,
  height: number
): THREE.DataTexture {
  const tex = new THREE.DataTexture(
    data,
    width,
    height,
    THREE.RedFormat,
    THREE.FloatType
  );
  tex.needsUpdate = true;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  return tex;
}
