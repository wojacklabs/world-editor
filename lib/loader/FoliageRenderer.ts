/**
 * FoliageRenderer - Independent foliage rendering for Babylon.js
 *
 * Features:
 * - No editor logic dependency (Heightmap, SplatMap, dirty flags)
 * - Accepts pre-computed foliage data from WorldLoader
 * - Chunk-based ThinInstance management
 * - Simple built-in meshes (can be customized)
 *
 * Usage:
 * ```typescript
 * import { WorldLoader, FoliageRenderer } from "@world-editor/loader";
 *
 * const result = WorldLoader.loadWorld(json);
 * const tile = result.data!.mainTile!;
 *
 * const renderer = new FoliageRenderer(scene);
 * renderer.loadTile(tile.foliage);
 * ```
 */

import {
  Scene,
  Mesh,
  MeshBuilder,
  Vector3,
  VertexData,
  VertexBuffer,
  StandardMaterial,
  Color3,
} from "@babylonjs/core";
import type { FoliageRendererOptions } from "./types";

// ============================================
// Noise Functions (from editor/FoliageSystem)
// ============================================

function hash3D(x: number, y: number, z: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

function noise3D(x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;

  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);

  const n000 = hash3D(ix, iy, iz);
  const n100 = hash3D(ix + 1, iy, iz);
  const n010 = hash3D(ix, iy + 1, iz);
  const n110 = hash3D(ix + 1, iy + 1, iz);
  const n001 = hash3D(ix, iy, iz + 1);
  const n101 = hash3D(ix + 1, iy, iz + 1);
  const n011 = hash3D(ix, iy + 1, iz + 1);
  const n111 = hash3D(ix + 1, iy + 1, iz + 1);

  const n00 = n000 * (1 - ux) + n100 * ux;
  const n01 = n001 * (1 - ux) + n101 * ux;
  const n10 = n010 * (1 - ux) + n110 * ux;
  const n11 = n011 * (1 - ux) + n111 * ux;

  const n0 = n00 * (1 - uy) + n10 * uy;
  const n1 = n01 * (1 - uy) + n11 * uy;

  return (n0 * (1 - uz) + n1 * uz) * 2 - 1;
}

function fbm3D(x: number, y: number, z: number, octaves: number = 4): number {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1;

  for (let i = 0; i < octaves; i++) {
    value += amplitude * noise3D(x * frequency, y * frequency, z * frequency);
    frequency *= 2;
    amplitude *= 0.5;
  }

  return value;
}

function setMeshVertexColor(mesh: Mesh, r: number, g: number, b: number): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) return;

  const vertexCount = positions.length / 3;
  const colors = new Float32Array(vertexCount * 4);
  for (let i = 0; i < vertexCount; i++) {
    colors[i * 4] = r;
    colors[i * 4 + 1] = g;
    colors[i * 4 + 2] = b;
    colors[i * 4 + 3] = 1;
  }
  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
}

// ============================================
// Types
// ============================================

interface FoliageChunk {
  x: number;
  z: number;
  meshes: Map<string, Mesh>;
  instanceCounts: Map<string, number>;
}

// ============================================
// FoliageRenderer Class
// ============================================

export class FoliageRenderer {
  private scene: Scene;
  private options: Required<FoliageRendererOptions>;

  // Chunk management
  private chunks: Map<string, FoliageChunk> = new Map();

  // Base meshes for each foliage type
  private baseMeshes: Map<string, Mesh> = new Map();

  // Materials
  private grassMaterial: StandardMaterial | null = null;
  private rockMaterial: StandardMaterial | null = null;
  private treeMaterial: StandardMaterial | null = null;
  private flowerMaterial: StandardMaterial | null = null;
  private bushMaterial: StandardMaterial | null = null;

  // Statistics
  private totalInstances: number = 0;

  constructor(scene: Scene, options: FoliageRendererOptions = {}) {
    this.scene = scene;
    this.options = {
      chunkSize: options.chunkSize ?? 16,
      maxInstancesPerChunk: options.maxInstancesPerChunk ?? 5000,
      lodEnabled: options.lodEnabled ?? true,
      lodDistances: options.lodDistances ?? { near: 100, mid: 200, far: 450 },
    };

    this.createMaterials();
    this.createBaseMeshes();
  }

  // ============================================
  // Public API
  // ============================================

  /**
   * Load foliage data from DecodedTileData.foliage
   * @param foliageData Map of type name to matrix buffer (from WorldLoader)
   * @param offsetX World X offset (for multi-tile)
   * @param offsetZ World Z offset (for multi-tile)
   */
  loadTile(
    foliageData: Map<string, Float32Array>,
    offsetX: number = 0,
    offsetZ: number = 0
  ): void {
    for (const [typeName, matrices] of foliageData) {
      if (matrices.length === 0) continue;

      // Apply offset if needed
      const offsetMatrices =
        offsetX !== 0 || offsetZ !== 0
          ? this.applyOffset(matrices, offsetX, offsetZ)
          : matrices;

      // Group by chunk and create meshes
      this.loadTypeInstances(typeName, offsetMatrices);
    }

    console.log(
      `[FoliageRenderer] Loaded ${this.totalInstances} instances in ${this.chunks.size} chunks`
    );
  }

  /**
   * Load foliage from serialized format (Record<string, string>)
   * Convenience method that decodes Base64 internally
   */
  loadTileFromSerialized(
    foliageData: Record<string, string>,
    offsetX: number = 0,
    offsetZ: number = 0
  ): void {
    const decoded = new Map<string, Float32Array>();
    for (const [typeName, base64] of Object.entries(foliageData)) {
      decoded.set(typeName, this.decodeFloat32Array(base64));
    }
    this.loadTile(decoded, offsetX, offsetZ);
  }

  /**
   * Unload a specific chunk
   */
  unloadChunk(chunkX: number, chunkZ: number): void {
    const key = `${chunkX}_${chunkZ}`;
    const chunk = this.chunks.get(key);
    if (!chunk) return;

    for (const mesh of chunk.meshes.values()) {
      this.totalInstances -= mesh.thinInstanceCount;
      mesh.dispose();
    }
    this.chunks.delete(key);
  }

  /**
   * Update visibility based on camera position (LOD culling)
   */
  updateVisibility(cameraPosition: Vector3): void {
    if (!this.options.lodEnabled) return;

    const { far } = this.options.lodDistances;
    const chunkSize = this.options.chunkSize;

    for (const [key, chunk] of this.chunks) {
      const chunkCenterX = (chunk.x + 0.5) * chunkSize;
      const chunkCenterZ = (chunk.z + 0.5) * chunkSize;

      const dist = Math.sqrt(
        Math.pow(cameraPosition.x - chunkCenterX, 2) +
          Math.pow(cameraPosition.z - chunkCenterZ, 2)
      );

      const visible = dist < far;

      for (const mesh of chunk.meshes.values()) {
        mesh.setEnabled(visible);
      }
    }
  }

  /**
   * Get total instance count
   */
  getTotalInstances(): number {
    return this.totalInstances;
  }

  /**
   * Get chunk count
   */
  getChunkCount(): number {
    return this.chunks.size;
  }

  /**
   * Get statistics
   */
  getStats(): { chunks: number; instances: number; types: string[] } {
    const types = new Set<string>();
    for (const chunk of this.chunks.values()) {
      for (const typeName of chunk.meshes.keys()) {
        types.add(typeName);
      }
    }
    return {
      chunks: this.chunks.size,
      instances: this.totalInstances,
      types: Array.from(types),
    };
  }

  /**
   * Set custom base mesh for a foliage type
   */
  setBaseMesh(typeName: string, mesh: Mesh): void {
    this.baseMeshes.set(typeName, mesh);
  }

  /**
   * Dispose all resources
   */
  dispose(): void {
    // Dispose all chunk meshes
    for (const chunk of this.chunks.values()) {
      for (const mesh of chunk.meshes.values()) {
        mesh.dispose();
      }
    }
    this.chunks.clear();
    this.totalInstances = 0;

    // Dispose base meshes
    for (const mesh of this.baseMeshes.values()) {
      mesh.dispose();
    }
    this.baseMeshes.clear();

    // Dispose materials
    this.grassMaterial?.dispose();
    this.rockMaterial?.dispose();
    this.treeMaterial?.dispose();
    this.flowerMaterial?.dispose();
    this.bushMaterial?.dispose();
    this.grassMaterial = null;
    this.rockMaterial = null;
    this.treeMaterial = null;
    this.flowerMaterial = null;
    this.bushMaterial = null;
  }

  // ============================================
  // Private Methods
  // ============================================

  private createMaterials(): void {
    // Grass material (green)
    this.grassMaterial = new StandardMaterial("foliageGrass", this.scene);
    this.grassMaterial.diffuseColor = new Color3(0.2, 0.5, 0.15);
    this.grassMaterial.backFaceCulling = false;

    // Rock material (gray)
    this.rockMaterial = new StandardMaterial("foliageRock", this.scene);
    this.rockMaterial.diffuseColor = new Color3(0.5, 0.5, 0.5);
    this.rockMaterial.backFaceCulling = false;

    // Tree material (brown trunk, green leaves)
    this.treeMaterial = new StandardMaterial("foliageTree", this.scene);
    this.treeMaterial.diffuseColor = new Color3(0.15, 0.4, 0.1);
    this.treeMaterial.backFaceCulling = false;

    // Flower material (colorful)
    this.flowerMaterial = new StandardMaterial("foliageFlower", this.scene);
    this.flowerMaterial.diffuseColor = new Color3(0.9, 0.3, 0.4);
    this.flowerMaterial.backFaceCulling = false;

    // Bush material (darker green)
    this.bushMaterial = new StandardMaterial("foliageBush", this.scene);
    this.bushMaterial.diffuseColor = new Color3(0.15, 0.35, 0.1);
    this.bushMaterial.backFaceCulling = false;
  }

  private createBaseMeshes(): void {
    // Procedural grass mesh (editor-quality multi-blade clump)
    const grassMesh = this.generateProceduralGrassClump(2000);
    grassMesh.material = this.grassMaterial;
    grassMesh.isVisible = false;
    this.baseMeshes.set("grass", grassMesh);

    // Procedural rock mesh (editor-quality with shape variations)
    const rockMesh = this.generateProceduralRock(1000);
    rockMesh.material = this.rockMaterial;
    rockMesh.isVisible = false;
    this.baseMeshes.set("rock", rockMesh);

    // Procedural tree mesh (trunk + foliage layers)
    const treeMesh = this.generateProceduralTree(3000);
    treeMesh.material = this.treeMaterial;
    treeMesh.isVisible = false;
    this.baseMeshes.set("tree", treeMesh);

    // Procedural flower mesh (stem + petals)
    const flowerMesh = this.generateProceduralFlower(4000);
    flowerMesh.material = this.flowerMaterial;
    flowerMesh.isVisible = false;
    this.baseMeshes.set("flower", flowerMesh);

    // Procedural bush mesh (dense foliage sphere)
    const bushMesh = this.generateProceduralBush(5000);
    bushMesh.material = this.bushMaterial;
    bushMesh.isVisible = false;
    this.baseMeshes.set("bush", bushMesh);

    // Pebble mesh (small rock for dirt areas)
    const pebbleMesh = MeshBuilder.CreateIcoSphere("pebble_base", {
      radius: 0.15,
      subdivisions: 1,
    }, this.scene);
    pebbleMesh.material = this.rockMaterial;
    pebbleMesh.isVisible = false;
    this.baseMeshes.set("pebble", pebbleMesh);
  }

  /**
   * Generate procedural grass clump (from editor/FoliageSystem)
   */
  private generateProceduralGrassClump(seed: number): Mesh {
    const blades: Mesh[] = [];

    // Clump parameters
    const clumpDensity = 0.3 + Math.abs(noise3D(seed * 0.5, 0, 0)) * 0.7;
    const clumpSpread = 0.04 + Math.abs(noise3D(0, seed * 0.5, 0)) * 0.16;
    const avgHeight = 0.2 + Math.abs(noise3D(0, 0, seed * 0.5)) * 0.5;
    const avgWidth = 0.012 + Math.abs(noise3D(seed * 0.6, seed * 0.3, 0)) * 0.028;

    const bladeCount = Math.floor(4 + clumpDensity * 12);

    for (let i = 0; i < bladeCount; i++) {
      const iSeed = seed + i * 73.7;

      const heightVar = 0.6 + Math.abs(noise3D(iSeed, 0, 0)) * 0.8;
      const widthVar = 0.7 + Math.abs(noise3D(0, iSeed, 0)) * 0.6;
      const bladeHeight = avgHeight * heightVar;
      const bladeWidth = avgWidth * widthVar;

      const curveBase = 0.02 + Math.abs(noise3D(0, 0, iSeed)) * 0.12;
      const bladeCurve = curveBase * (bladeHeight / 0.4);

      const h1 = bladeHeight * 0.35;
      const h2 = bladeHeight * 0.65;
      const h3 = bladeHeight * 0.9;
      const h4 = bladeHeight;

      const c1 = bladeCurve * 0.25;
      const c2 = bladeCurve * 0.6;
      const c3 = bladeCurve * 0.9;
      const c4 = bladeCurve;

      const taperRate = 0.6 + Math.abs(noise3D(iSeed * 1.5, 0, 0)) * 0.35;

      const positions = [
        -bladeWidth, 0, 0,
        bladeWidth, 0, 0,
        -bladeWidth * taperRate, h1, c1,
        bladeWidth * taperRate, h1, c1,
        -bladeWidth * taperRate * 0.7, h2, c2,
        bladeWidth * taperRate * 0.7, h2, c2,
        -bladeWidth * taperRate * 0.35, h3, c3,
        bladeWidth * taperRate * 0.35, h3, c3,
        0, h4, c4,
      ];

      const indices = [
        0, 1, 2, 1, 3, 2,
        2, 3, 4, 3, 5, 4,
        4, 5, 6, 5, 7, 6,
        6, 7, 8,
      ];

      const normals: number[] = [];
      for (let j = 0; j < positions.length; j += 3) {
        const y = positions[j + 1];
        const progress = y / h4;
        const nz = 0.4 + progress * 0.4;
        const ny = 0.3 * (1 - progress);
        const len = Math.sqrt(nz * nz + ny * ny);
        normals.push(0, ny / len, nz / len);
      }

      const uvs = [0, 0, 1, 0, 0.1, 0.35, 0.9, 0.35, 0.2, 0.65, 0.8, 0.65, 0.35, 0.9, 0.65, 0.9, 0.5, 1];

      const blade = new Mesh("blade_" + i, this.scene);
      const vertexData = new VertexData();
      vertexData.positions = positions;
      vertexData.indices = indices;
      vertexData.normals = normals;
      vertexData.uvs = uvs;
      vertexData.applyToMesh(blade);

      const angle = (noise3D(iSeed * 2, 0, 0) + 0.5) * Math.PI * 2;
      const distFactor = Math.pow(Math.abs(noise3D(0, iSeed * 2, 0)), 1.0 / clumpDensity);
      const dist = distFactor * clumpSpread;

      blade.position.x = Math.cos(angle) * dist;
      blade.position.z = Math.sin(angle) * dist;
      blade.rotation.y = (noise3D(iSeed, iSeed, 0) + 0.5) * Math.PI * 2;
      blade.rotation.x = noise3D(iSeed * 3, 0, 0) * 0.12;
      blade.rotation.z = noise3D(0, iSeed * 3, 0) * 0.1;

      blades.push(blade);
    }

    // Set grass vertex color
    for (const blade of blades) {
      setMeshVertexColor(blade, 0.45, 0.75, 0.3);
    }

    const merged = Mesh.MergeMeshes(blades, true, true, undefined, false, true);
    if (merged) {
      merged.name = "grass_" + seed;
      return merged;
    }

    return new Mesh("grass_" + seed, this.scene);
  }

  /**
   * Generate procedural rock (from editor/FoliageSystem)
   */
  private generateProceduralRock(seed: number): Mesh {
    const rock = MeshBuilder.CreateIcoSphere(
      "rock_" + seed,
      { radius: 0.5, subdivisions: 4, flat: false, updatable: true },
      this.scene
    );

    // Shape parameters from seed
    const scaleX = 0.5 + Math.abs(noise3D(seed * 1.0, 0, 0)) * 1.2;
    const scaleY = 0.4 + Math.abs(noise3D(0, seed * 1.1, 0)) * 1.6;
    const scaleZ = 0.5 + Math.abs(noise3D(0, 0, seed * 1.2)) * 1.2;

    const taperY = noise3D(seed * 2.0, seed * 0.5, 0) * 0.7;
    const taperX = noise3D(seed * 2.1, 0, seed * 0.5) * 0.4;
    const taperZ = noise3D(0, seed * 2.2, seed * 0.6) * 0.4;

    const asymOffsetX = noise3D(seed * 3.0, seed * 0.3, 0) * 0.35;
    const asymOffsetY = noise3D(seed * 0.3, seed * 3.1, 0) * 0.25;
    const asymOffsetZ = noise3D(0, seed * 0.3, seed * 3.2) * 0.35;

    const twistAmount = noise3D(seed * 4.0, seed * 0.7, seed * 0.3) * 0.6;
    const bendX = noise3D(seed * 5.0, 0, 0) * 0.4;
    const bendZ = noise3D(0, 0, seed * 5.1) * 0.4;

    const positions = rock.getVerticesData(VertexBuffer.PositionKind);
    if (positions) {
      const newPositions = new Float32Array(positions.length);

      for (let i = 0; i < positions.length; i += 3) {
        let x = positions[i];
        let y = positions[i + 1];
        let z = positions[i + 2];

        const len = Math.sqrt(x * x + y * y + z * z);
        const nx = x / len;
        const ny = y / len;
        const nz = z / len;

        // Apply scale
        x *= scaleX;
        y *= scaleY;
        z *= scaleZ;

        // Apply taper
        const taperFactorY = 1.0 - taperY * ny;
        const taperFactorX = 1.0 - taperX * nx;
        const taperFactorZ = 1.0 - taperZ * nz;
        x *= taperFactorY * taperFactorX;
        z *= taperFactorY * taperFactorZ;

        // Apply twist
        const twistAngle = twistAmount * ny;
        const cosT = Math.cos(twistAngle);
        const sinT = Math.sin(twistAngle);
        const rx = x * cosT - z * sinT;
        const rz = x * sinT + z * cosT;
        x = rx;
        z = rz;

        // Apply bend
        x += bendX * y * y;
        z += bendZ * y * y;

        // Apply asymmetry
        x += asymOffsetX * (1.0 - Math.abs(ny));
        y += asymOffsetY;
        z += asymOffsetZ * (1.0 - Math.abs(ny));

        // Surface displacement (noise-based)
        const surfaceNoise = fbm3D(nx * 3 + seed, ny * 3, nz * 3, 3);
        const surfaceDisp = surfaceNoise * 0.15;
        x += nx * surfaceDisp;
        y += ny * surfaceDisp;
        z += nz * surfaceDisp;

        newPositions[i] = x;
        newPositions[i + 1] = y;
        newPositions[i + 2] = z;
      }

      rock.updateVerticesData(VertexBuffer.PositionKind, newPositions);

      const indices = rock.getIndices();
      const normals = rock.getVerticesData(VertexBuffer.NormalKind);
      if (indices && normals) {
        VertexData.ComputeNormals(newPositions, indices, normals);
        rock.updateVerticesData(VertexBuffer.NormalKind, normals);
      }
    }

    // Set rock vertex color
    setMeshVertexColor(rock, 0.5, 0.5, 0.52);

    return rock;
  }

  /**
   * Generate procedural tree (trunk + layered foliage)
   */
  private generateProceduralTree(seed: number): Mesh {
    const parts: Mesh[] = [];

    // Trunk parameters
    const trunkHeight = 1.0 + Math.abs(noise3D(seed, 0, 0)) * 0.5;
    const trunkRadius = 0.08 + Math.abs(noise3D(0, seed, 0)) * 0.04;

    // Trunk
    const trunk = MeshBuilder.CreateCylinder("trunk_" + seed, {
      height: trunkHeight,
      diameterTop: trunkRadius * 1.5,
      diameterBottom: trunkRadius * 2.5,
      tessellation: 8,
    }, this.scene);
    trunk.position.y = trunkHeight / 2;
    setMeshVertexColor(trunk, 0.35, 0.22, 0.1); // Brown
    parts.push(trunk);

    // Foliage layers (3 cones)
    const foliageBaseY = trunkHeight * 0.7;
    const foliageLayers = 3;

    for (let i = 0; i < foliageLayers; i++) {
      const layerSeed = seed + i * 111;
      const layerHeight = 0.6 + Math.abs(noise3D(layerSeed, 0, 0)) * 0.3;
      const layerRadius = 0.5 - i * 0.12 + Math.abs(noise3D(0, layerSeed, 0)) * 0.15;
      const layerY = foliageBaseY + i * 0.35;

      const foliage = MeshBuilder.CreateCylinder("foliage_" + i + "_" + seed, {
        height: layerHeight,
        diameterTop: 0,
        diameterBottom: layerRadius * 2,
        tessellation: 8,
      }, this.scene);
      foliage.position.y = layerY + layerHeight / 2;
      setMeshVertexColor(foliage, 0.15 + i * 0.05, 0.4 + i * 0.05, 0.1);
      parts.push(foliage);
    }

    const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, true);
    if (merged) {
      merged.name = "tree_" + seed;
      return merged;
    }

    return trunk;
  }

  /**
   * Generate procedural flower (stem + petals)
   */
  private generateProceduralFlower(seed: number): Mesh {
    const parts: Mesh[] = [];

    // Stem
    const stemHeight = 0.25 + Math.abs(noise3D(seed, 0, 0)) * 0.2;
    const stem = MeshBuilder.CreateCylinder("stem_" + seed, {
      height: stemHeight,
      diameter: 0.02,
      tessellation: 6,
    }, this.scene);
    stem.position.y = stemHeight / 2;
    setMeshVertexColor(stem, 0.2, 0.5, 0.15);
    parts.push(stem);

    // Center
    const center = MeshBuilder.CreateSphere("center_" + seed, {
      diameter: 0.06,
      segments: 6,
    }, this.scene);
    center.position.y = stemHeight + 0.03;
    setMeshVertexColor(center, 0.9, 0.8, 0.2); // Yellow center
    parts.push(center);

    // Petals (5-7 petals around)
    const petalCount = 5 + Math.floor(Math.abs(noise3D(0, seed, 0)) * 3);
    for (let i = 0; i < petalCount; i++) {
      const angle = (i / petalCount) * Math.PI * 2;
      const petal = MeshBuilder.CreateDisc("petal_" + i + "_" + seed, {
        radius: 0.05,
        tessellation: 6,
      }, this.scene);
      petal.position.x = Math.cos(angle) * 0.04;
      petal.position.z = Math.sin(angle) * 0.04;
      petal.position.y = stemHeight + 0.02;
      petal.rotation.x = -Math.PI / 3;
      petal.rotation.y = angle;

      // Random petal color
      const r = 0.8 + Math.abs(noise3D(seed + i, 0, 0)) * 0.2;
      const g = 0.2 + Math.abs(noise3D(0, seed + i, 0)) * 0.3;
      const b = 0.3 + Math.abs(noise3D(0, 0, seed + i)) * 0.4;
      setMeshVertexColor(petal, r, g, b);
      parts.push(petal);
    }

    const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, true);
    if (merged) {
      merged.name = "flower_" + seed;
      return merged;
    }

    return stem;
  }

  /**
   * Generate procedural bush (dense foliage sphere)
   */
  private generateProceduralBush(seed: number): Mesh {
    const parts: Mesh[] = [];

    // Main body (deformed sphere)
    const main = MeshBuilder.CreateIcoSphere("bush_main_" + seed, {
      radius: 0.4,
      subdivisions: 2,
      updatable: true,
    }, this.scene);

    // Deform the sphere
    const positions = main.getVerticesData(VertexBuffer.PositionKind);
    if (positions) {
      const newPositions = new Float32Array(positions.length);
      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i];
        const y = positions[i + 1];
        const z = positions[i + 2];

        const noise = fbm3D(x * 3 + seed, y * 3, z * 3, 2) * 0.15;
        const len = Math.sqrt(x * x + y * y + z * z);

        newPositions[i] = x + (x / len) * noise;
        newPositions[i + 1] = y * 0.7 + (y / len) * noise; // Flatten
        newPositions[i + 2] = z + (z / len) * noise;
      }
      main.updateVerticesData(VertexBuffer.PositionKind, newPositions);

      const indices = main.getIndices();
      const normals = main.getVerticesData(VertexBuffer.NormalKind);
      if (indices && normals) {
        VertexData.ComputeNormals(newPositions, indices, normals);
        main.updateVerticesData(VertexBuffer.NormalKind, normals);
      }
    }

    main.position.y = 0.25;
    setMeshVertexColor(main, 0.15, 0.35, 0.1);
    parts.push(main);

    // Add small bumps
    for (let i = 0; i < 5; i++) {
      const bumpSeed = seed + i * 77;
      const angle = (i / 5) * Math.PI * 2;
      const bump = MeshBuilder.CreateSphere("bump_" + i + "_" + seed, {
        diameter: 0.2 + Math.abs(noise3D(bumpSeed, 0, 0)) * 0.1,
        segments: 4,
      }, this.scene);
      bump.position.x = Math.cos(angle) * 0.25;
      bump.position.z = Math.sin(angle) * 0.25;
      bump.position.y = 0.2 + Math.abs(noise3D(0, bumpSeed, 0)) * 0.1;
      setMeshVertexColor(bump, 0.12 + i * 0.02, 0.32 + i * 0.02, 0.08);
      parts.push(bump);
    }

    const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, true);
    if (merged) {
      merged.name = "bush_" + seed;
      return merged;
    }

    return main;
  }

  private loadTypeInstances(typeName: string, matrices: Float32Array): void {
    const instanceCount = Math.floor(matrices.length / 16);
    if (instanceCount === 0) return;

    // Group instances by chunk
    const chunkInstances = new Map<string, number[]>();
    const chunkSize = this.options.chunkSize;

    for (let i = 0; i < instanceCount; i++) {
      const baseIdx = i * 16;
      const worldX = matrices[baseIdx + 12];
      const worldZ = matrices[baseIdx + 14];

      const chunkX = Math.floor(worldX / chunkSize);
      const chunkZ = Math.floor(worldZ / chunkSize);
      const key = `${chunkX}_${chunkZ}`;

      if (!chunkInstances.has(key)) {
        chunkInstances.set(key, []);
      }

      // Copy 16 floats for this instance
      for (let j = 0; j < 16; j++) {
        chunkInstances.get(key)!.push(matrices[baseIdx + j]);
      }
    }

    // Create meshes for each chunk
    for (const [key, values] of chunkInstances) {
      const [cx, cz] = key.split("_").map(Number);
      const chunkMatrices = new Float32Array(values);

      this.createChunkMesh(cx, cz, typeName, chunkMatrices);
    }
  }

  private createChunkMesh(
    chunkX: number,
    chunkZ: number,
    typeName: string,
    matrices: Float32Array
  ): void {
    const key = `${chunkX}_${chunkZ}`;
    const instanceCount = Math.floor(matrices.length / 16);

    if (instanceCount === 0) return;

    // Get or create chunk
    let chunk = this.chunks.get(key);
    if (!chunk) {
      chunk = {
        x: chunkX,
        z: chunkZ,
        meshes: new Map(),
        instanceCounts: new Map(),
      };
      this.chunks.set(key, chunk);
    }

    // Find base mesh for this type
    const baseMesh = this.getBaseMeshForType(typeName);
    if (!baseMesh) {
      console.warn(`[FoliageRenderer] No base mesh for type: ${typeName}`);
      return;
    }

    // Create new mesh with independent vertex data (WebGPU compatibility)
    const meshName = `foliage_${chunkX}_${chunkZ}_${typeName}`;
    const mesh = new Mesh(meshName, this.scene);

    // Copy vertex data from base mesh
    const vertexData = new VertexData();
    const positions = baseMesh.getVerticesData(VertexBuffer.PositionKind);
    const normals = baseMesh.getVerticesData(VertexBuffer.NormalKind);
    const uvs = baseMesh.getVerticesData(VertexBuffer.UVKind);
    const indices = baseMesh.getIndices();

    if (positions) vertexData.positions = new Float32Array(positions);
    if (normals) vertexData.normals = new Float32Array(normals);
    if (uvs) vertexData.uvs = new Float32Array(uvs);
    if (indices) vertexData.indices = new Uint32Array(indices);

    vertexData.applyToMesh(mesh);

    // Share material
    mesh.material = baseMesh.material;

    // Setup thin instances
    mesh.thinInstanceSetBuffer("matrix", matrices, 16, false);
    mesh.thinInstanceCount = instanceCount;
    mesh.thinInstanceRefreshBoundingInfo(); // Required after setting buffer

    // Store in chunk
    chunk.meshes.set(typeName, mesh);
    chunk.instanceCounts.set(typeName, instanceCount);

    this.totalInstances += instanceCount;
  }

  private getBaseMeshForType(typeName: string): Mesh | undefined {
    // Check for exact match first
    if (this.baseMeshes.has(typeName)) {
      return this.baseMeshes.get(typeName);
    }

    // Handle variation suffix (e.g., "grass_v0", "rock_v2")
    const varMatch = typeName.match(/^(.+?)(_v\d+)?$/);
    if (varMatch) {
      const baseType = varMatch[1];
      if (this.baseMeshes.has(baseType)) {
        return this.baseMeshes.get(baseType);
      }
    }

    // Fallback: check if type starts with known prefix
    if (typeName.startsWith("grass")) {
      return this.baseMeshes.get("grass");
    }
    if (typeName.startsWith("rock")) {
      return this.baseMeshes.get("rock");
    }
    if (typeName.startsWith("tree")) {
      return this.baseMeshes.get("tree");
    }
    if (typeName.startsWith("flower")) {
      return this.baseMeshes.get("flower");
    }
    if (typeName.startsWith("bush")) {
      return this.baseMeshes.get("bush");
    }

    return undefined;
  }

  private applyOffset(
    matrices: Float32Array,
    offsetX: number,
    offsetZ: number
  ): Float32Array {
    const result = new Float32Array(matrices);
    const instanceCount = Math.floor(matrices.length / 16);

    for (let i = 0; i < instanceCount; i++) {
      const baseIdx = i * 16;
      result[baseIdx + 12] += offsetX; // X translation
      result[baseIdx + 14] += offsetZ; // Z translation
    }

    return result;
  }

  private decodeFloat32Array(base64: string): Float32Array {
    const binary =
      typeof atob !== "undefined"
        ? atob(base64)
        : Buffer.from(base64, "base64").toString("binary");

    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Float32Array(bytes.buffer);
  }
}
