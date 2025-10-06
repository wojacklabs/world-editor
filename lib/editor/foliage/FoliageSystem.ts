import {
  Scene,
  Mesh,
  MeshBuilder,
  Vector3,
  Matrix,
  Color3,
  Color4,
  VertexData,
  StandardMaterial,
  ShaderMaterial,
  Effect,
} from "@babylonjs/core";
import { Heightmap } from "../terrain/Heightmap";
import { SplatMap } from "../terrain/SplatMap";

// Foliage type configuration
interface FoliageTypeConfig {
  name: string;
  baseDensity: number;      // instances per unit area
  minScale: number;
  maxScale: number;
  biomeChannel: number;     // 0=grass, 1=dirt, 2=rock, 3=sand
  biomeThreshold: number;   // minimum weight to spawn
  slopeMax: number;         // maximum slope (0-1) to spawn
  yOffset: number;          // vertical offset from terrain
  color: Color3;
  colorVariation: number;
}

// Chunk for spatial organization
interface FoliageChunk {
  x: number;
  z: number;
  instances: Map<string, Float32Array>;  // type -> matrix buffer
  mesh: Map<string, Mesh>;               // type -> thin instance mesh
  visible: boolean;
}

// Register grass blade shader
Effect.ShadersStore["grassVertexShader"] = `
precision highp float;

attribute vec3 position;
attribute vec3 normal;
attribute vec4 color;

uniform mat4 viewProjection;
uniform float uTime;
uniform float uWindStrength;

varying vec3 vNormal;
varying vec4 vColor;
varying float vHeight;

void main() {
    // Get instance matrix
    mat4 worldMatrix = world;
    
    vec4 worldPos = worldMatrix * vec4(position, 1.0);
    vHeight = position.y;
    
    // Wind animation - affects top of grass more
    float windFactor = position.y * uWindStrength;
    float windX = sin(uTime * 2.0 + worldPos.x * 0.5 + worldPos.z * 0.3) * windFactor;
    float windZ = cos(uTime * 1.5 + worldPos.x * 0.3 + worldPos.z * 0.5) * windFactor * 0.5;
    
    worldPos.x += windX;
    worldPos.z += windZ;
    
    gl_Position = viewProjection * worldPos;
    vNormal = normalize(mat3(worldMatrix) * normal);
    vColor = color;
}
`;

Effect.ShadersStore["grassFragmentShader"] = `
precision highp float;

varying vec3 vNormal;
varying vec4 vColor;
varying float vHeight;

uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uAmbient;

void main() {
    vec3 normal = normalize(vNormal);
    float NdotL = max(dot(normal, uSunDirection), 0.0);
    float diffuse = NdotL * 0.6 + 0.4;
    
    // Darken base, lighten tips
    float heightGradient = mix(0.7, 1.1, vHeight);
    
    vec3 color = vColor.rgb * heightGradient * (uAmbient + diffuse * uSunColor);
    
    // Simple alpha test for grass edges
    if (vColor.a < 0.1) discard;
    
    gl_FragColor = vec4(color, 1.0);
}
`;

export class FoliageSystem {
  private scene: Scene;
  private heightmap: Heightmap;
  private splatMap: SplatMap;
  private terrainScale: number;
  
  // Chunk management
  private chunkSize = 16;  // 16x16 world units per chunk
  private chunks: Map<string, FoliageChunk> = new Map();
  
  // Base meshes for thin instances
  private baseMeshes: Map<string, Mesh> = new Map();
  
  // Foliage type configurations
  private foliageTypes: Map<string, FoliageTypeConfig> = new Map();
  
  // Materials
  private grassMaterial: ShaderMaterial | null = null;
  private rockMaterial: StandardMaterial | null = null;
  
  // Performance settings
  private maxInstancesPerChunk = 5000;
  private lodDistances = {
    near: 30,    // full density
    mid: 60,     // 50% density
    far: 100,    // 25% density
  };
  
  // Random seed for consistent generation
  private seed: number;

  constructor(
    scene: Scene, 
    heightmap: Heightmap, 
    splatMap: SplatMap,
    terrainScale: number
  ) {
    this.scene = scene;
    this.heightmap = heightmap;
    this.splatMap = splatMap;
    this.terrainScale = terrainScale;
    this.seed = 12345;
    
    this.initializeFoliageTypes();
    this.createBaseMeshes();
    this.createMaterials();
  }

  /**
   * Initialize foliage type configurations
   */
  private initializeFoliageTypes(): void {
    // Grass blades
    this.foliageTypes.set("grass", {
      name: "grass",
      baseDensity: 8.0,        // 8 per unit area = dense grass
      minScale: 0.4,
      maxScale: 0.8,
      biomeChannel: 0,         // grass channel (R)
      biomeThreshold: 0.3,
      slopeMax: 0.6,
      yOffset: 0,
      color: new Color3(0.3, 0.5, 0.2),
      colorVariation: 0.15,
    });

    // Small rocks/pebbles for dirt
    this.foliageTypes.set("pebble", {
      name: "pebble",
      baseDensity: 0.5,
      minScale: 0.1,
      maxScale: 0.25,
      biomeChannel: 1,         // dirt channel (G)
      biomeThreshold: 0.4,
      slopeMax: 0.8,
      yOffset: -0.02,
      color: new Color3(0.4, 0.35, 0.3),
      colorVariation: 0.1,
    });

    // Larger rocks for rocky areas
    this.foliageTypes.set("rock", {
      name: "rock",
      baseDensity: 0.15,
      minScale: 0.2,
      maxScale: 0.6,
      biomeChannel: 2,         // rock channel (B)
      biomeThreshold: 0.3,
      slopeMax: 0.9,
      yOffset: -0.05,
      color: new Color3(0.5, 0.5, 0.52),
      colorVariation: 0.08,
    });

    // Sparse rocks on sand
    this.foliageTypes.set("sandRock", {
      name: "sandRock",
      baseDensity: 0.05,
      minScale: 0.15,
      maxScale: 0.4,
      biomeChannel: 3,         // sand channel (A)
      biomeThreshold: 0.5,
      slopeMax: 0.7,
      yOffset: -0.03,
      color: new Color3(0.6, 0.55, 0.45),
      colorVariation: 0.1,
    });
  }

  /**
   * Create base meshes for thin instancing
   */
  private createBaseMeshes(): void {
    // Grass blade mesh (simple quad or low-poly blade)
    const grassMesh = this.createGrassBladeMesh();
    grassMesh.isVisible = false;
    this.baseMeshes.set("grass", grassMesh);

    // Pebble mesh (small icosphere)
    const pebbleMesh = MeshBuilder.CreateIcoSphere("pebble_base", {
      radius: 0.5,
      subdivisions: 1,
    }, this.scene);
    pebbleMesh.isVisible = false;
    this.baseMeshes.set("pebble", pebbleMesh);

    // Rock mesh (irregular icosphere)
    const rockMesh = this.createRockMesh();
    rockMesh.isVisible = false;
    this.baseMeshes.set("rock", rockMesh);
    this.baseMeshes.set("sandRock", rockMesh);  // reuse rock mesh
  }

  /**
   * Create a simple grass blade mesh
   */
  private createGrassBladeMesh(): Mesh {
    const positions: number[] = [];
    const indices: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];

    // Create 3 crossing quads for a grass clump
    const bladeCount = 3;
    const bladeWidth = 0.08;
    const bladeHeight = 0.5;

    for (let i = 0; i < bladeCount; i++) {
      const angle = (i / bladeCount) * Math.PI;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      
      const baseIdx = positions.length / 3;
      
      // Four vertices per blade (2 triangles)
      // Bottom left
      positions.push(-bladeWidth * cos, 0, -bladeWidth * sin);
      normals.push(sin, 0, -cos);
      colors.push(0.25, 0.4, 0.15, 1.0);  // darker at base
      
      // Bottom right
      positions.push(bladeWidth * cos, 0, bladeWidth * sin);
      normals.push(sin, 0, -cos);
      colors.push(0.25, 0.4, 0.15, 1.0);
      
      // Top right
      positions.push(bladeWidth * cos * 0.3, bladeHeight, bladeWidth * sin * 0.3);
      normals.push(sin, 0.2, -cos);
      colors.push(0.4, 0.6, 0.25, 1.0);  // lighter at tip
      
      // Top left
      positions.push(-bladeWidth * cos * 0.3, bladeHeight, -bladeWidth * sin * 0.3);
      normals.push(sin, 0.2, -cos);
      colors.push(0.4, 0.6, 0.25, 1.0);
      
      // Two triangles
      indices.push(baseIdx, baseIdx + 1, baseIdx + 2);
      indices.push(baseIdx, baseIdx + 2, baseIdx + 3);
      
      // Back faces
      indices.push(baseIdx + 2, baseIdx + 1, baseIdx);
      indices.push(baseIdx + 3, baseIdx + 2, baseIdx);
    }

    const mesh = new Mesh("grass_base", this.scene);
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.normals = normals;
    vertexData.colors = colors;
    vertexData.applyToMesh(mesh);

    return mesh;
  }

  /**
   * Create irregular rock mesh
   */
  private createRockMesh(): Mesh {
    const mesh = MeshBuilder.CreateIcoSphere("rock_base", {
      radius: 0.5,
      subdivisions: 2,
    }, this.scene);

    // Deform vertices for irregular shape
    const positions = mesh.getVerticesData("position");
    if (positions) {
      for (let i = 0; i < positions.length; i += 3) {
        const noise = this.seededRandom() * 0.3 + 0.85;
        positions[i] *= noise;
        positions[i + 1] *= noise * 0.7;  // flatten slightly
        positions[i + 2] *= noise;
      }
      mesh.setVerticesData("position", positions);
      mesh.createNormals(true);
    }

    return mesh;
  }

  /**
   * Create materials for foliage
   */
  private createMaterials(): void {
    // Standard material for rocks
    this.rockMaterial = new StandardMaterial("foliage_rock_mat", this.scene);
    this.rockMaterial.diffuseColor = new Color3(0.5, 0.48, 0.45);
    this.rockMaterial.specularColor = new Color3(0.1, 0.1, 0.1);
    this.rockMaterial.backFaceCulling = false;
    
    // Apply to rock meshes
    const rockBase = this.baseMeshes.get("rock");
    if (rockBase) rockBase.material = this.rockMaterial;
    
    const pebbleBase = this.baseMeshes.get("pebble");
    if (pebbleBase) pebbleBase.material = this.rockMaterial;

    // Standard material for grass (shader can be added later for wind)
    const grassMaterial = new StandardMaterial("foliage_grass_mat", this.scene);
    grassMaterial.diffuseColor = new Color3(0.35, 0.55, 0.2);
    grassMaterial.specularColor = new Color3(0.05, 0.05, 0.05);
    grassMaterial.backFaceCulling = false;
    
    const grassBase = this.baseMeshes.get("grass");
    if (grassBase) grassBase.material = grassMaterial;
  }

  /**
   * Seeded random for consistent results
   */
  private seededRandom(): number {
    this.seed = (this.seed * 9301 + 49297) % 233280;
    return this.seed / 233280;
  }

  /**
   * Reset seed for reproducible generation
   */
  private resetSeed(baseSeed: number): void {
    this.seed = baseSeed;
  }

  /**
   * Generate all foliage for the terrain
   */
  generateAll(): void {
    console.log("[FoliageSystem] Generating all foliage...");
    this.disposeAll();
    
    const numChunksX = Math.ceil(this.terrainScale / this.chunkSize);
    const numChunksZ = Math.ceil(this.terrainScale / this.chunkSize);
    
    for (let cx = 0; cx < numChunksX; cx++) {
      for (let cz = 0; cz < numChunksZ; cz++) {
        this.generateChunk(cx, cz);
      }
    }
    
    console.log(`[FoliageSystem] Generated ${this.chunks.size} chunks`);
  }

  /**
   * Generate foliage for a specific chunk
   */
  private generateChunk(chunkX: number, chunkZ: number): void {
    const chunkKey = `${chunkX}_${chunkZ}`;
    const worldStartX = chunkX * this.chunkSize;
    const worldStartZ = chunkZ * this.chunkSize;
    const worldEndX = Math.min(worldStartX + this.chunkSize, this.terrainScale);
    const worldEndZ = Math.min(worldStartZ + this.chunkSize, this.terrainScale);
    
    const chunk: FoliageChunk = {
      x: chunkX,
      z: chunkZ,
      instances: new Map(),
      mesh: new Map(),
      visible: true,
    };
    
    // Generate instances for each foliage type
    for (const [typeName, config] of this.foliageTypes) {
      const matrices = this.generateInstancesForType(
        typeName,
        config,
        worldStartX,
        worldStartZ,
        worldEndX,
        worldEndZ
      );
      
      if (matrices.length > 0) {
        chunk.instances.set(typeName, matrices);
        
        // Create thin instance mesh for this chunk
        const baseMesh = this.baseMeshes.get(typeName);
        if (baseMesh) {
          const chunkMesh = baseMesh.clone(`${typeName}_${chunkKey}`);
          chunkMesh.isVisible = true;
          chunkMesh.thinInstanceSetBuffer("matrix", matrices, 16);
          chunk.mesh.set(typeName, chunkMesh);
        }
      }
    }
    
    this.chunks.set(chunkKey, chunk);
  }

  /**
   * Generate instance matrices for a specific foliage type in a region
   */
  private generateInstancesForType(
    typeName: string,
    config: FoliageTypeConfig,
    startX: number,
    startZ: number,
    endX: number,
    endZ: number
  ): Float32Array {
    const matrices: number[] = [];
    const resolution = this.splatMap.getResolution();
    
    // Seed based on chunk position for consistency
    this.resetSeed(Math.floor(startX * 1000 + startZ));
    
    // Calculate step based on density
    const area = (endX - startX) * (endZ - startZ);
    const targetInstances = Math.floor(area * config.baseDensity);
    const instanceCount = Math.min(targetInstances, this.maxInstancesPerChunk);
    
    for (let i = 0; i < instanceCount; i++) {
      // Random position within region
      const x = startX + this.seededRandom() * (endX - startX);
      const z = startZ + this.seededRandom() * (endZ - startZ);
      
      // Get splat weight at this position
      const splatX = Math.floor((x / this.terrainScale) * (resolution - 1));
      const splatZ = Math.floor((z / this.terrainScale) * (resolution - 1));
      const weights = this.splatMap.getWeights(
        Math.max(0, Math.min(resolution - 1, splatX)),
        Math.max(0, Math.min(resolution - 1, splatZ))
      );
      
      const biomeWeight = weights[config.biomeChannel];
      
      // Skip if biome weight is below threshold
      if (biomeWeight < config.biomeThreshold) continue;
      
      // Probability based on biome weight
      if (this.seededRandom() > biomeWeight) continue;
      
      // Get terrain height and slope
      const y = this.heightmap.getInterpolatedHeight(x, z);
      const slope = this.calculateSlope(x, z);
      
      // Skip if slope is too steep
      if (slope > config.slopeMax) continue;
      
      // Calculate scale with variation
      const scaleBase = config.minScale + this.seededRandom() * (config.maxScale - config.minScale);
      const scale = scaleBase * (0.8 + this.seededRandom() * 0.4);
      
      // Random rotation
      const rotationY = this.seededRandom() * Math.PI * 2;
      
      // Create transformation matrix
      const matrix = Matrix.Compose(
        new Vector3(scale, scale, scale),
        Vector3.Zero().toQuaternion(),  // will apply rotation separately
        new Vector3(x, y + config.yOffset, z)
      );
      
      // Apply Y rotation
      const rotMatrix = Matrix.RotationY(rotationY);
      const finalMatrix = rotMatrix.multiply(matrix);
      
      // Add matrix values to array
      const matrixArray = finalMatrix.toArray();
      matrices.push(...matrixArray);
    }
    
    return new Float32Array(matrices);
  }

  /**
   * Calculate slope at a position (0 = flat, 1 = vertical)
   */
  private calculateSlope(x: number, z: number): number {
    const delta = 0.5;
    const hL = this.heightmap.getInterpolatedHeight(Math.max(0, x - delta), z);
    const hR = this.heightmap.getInterpolatedHeight(Math.min(this.terrainScale, x + delta), z);
    const hD = this.heightmap.getInterpolatedHeight(x, Math.max(0, z - delta));
    const hU = this.heightmap.getInterpolatedHeight(x, Math.min(this.terrainScale, z + delta));
    
    const dx = (hR - hL) / (2 * delta);
    const dz = (hU - hD) / (2 * delta);
    
    // Normal vector
    const nx = -dx;
    const ny = 1;
    const nz = -dz;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    
    // Slope = 1 - dot(normal, up)
    return 1 - (ny / len);
  }

  /**
   * Update foliage visibility based on camera position
   */
  updateVisibility(cameraPosition: Vector3): void {
    for (const [key, chunk] of this.chunks) {
      const chunkCenterX = (chunk.x + 0.5) * this.chunkSize;
      const chunkCenterZ = (chunk.z + 0.5) * this.chunkSize;
      
      const distance = Math.sqrt(
        Math.pow(cameraPosition.x - chunkCenterX, 2) +
        Math.pow(cameraPosition.z - chunkCenterZ, 2)
      );
      
      // Simple distance-based visibility
      const visible = distance < this.lodDistances.far;
      
      if (chunk.visible !== visible) {
        chunk.visible = visible;
        for (const mesh of chunk.mesh.values()) {
          mesh.setEnabled(visible);
        }
      }
    }
  }

  /**
   * Regenerate foliage for changed area
   */
  regenerateArea(centerX: number, centerZ: number, radius: number): void {
    const minChunkX = Math.floor((centerX - radius) / this.chunkSize);
    const maxChunkX = Math.ceil((centerX + radius) / this.chunkSize);
    const minChunkZ = Math.floor((centerZ - radius) / this.chunkSize);
    const maxChunkZ = Math.ceil((centerZ + radius) / this.chunkSize);
    
    for (let cx = minChunkX; cx <= maxChunkX; cx++) {
      for (let cz = minChunkZ; cz <= maxChunkZ; cz++) {
        if (cx >= 0 && cz >= 0) {
          const key = `${cx}_${cz}`;
          const existing = this.chunks.get(key);
          if (existing) {
            // Dispose existing chunk
            for (const mesh of existing.mesh.values()) {
              mesh.dispose();
            }
            this.chunks.delete(key);
          }
          
          // Regenerate
          this.generateChunk(cx, cz);
        }
      }
    }
  }

  /**
   * Set LOD distances
   */
  setLODDistances(near: number, mid: number, far: number): void {
    this.lodDistances.near = near;
    this.lodDistances.mid = mid;
    this.lodDistances.far = far;
  }

  /**
   * Get statistics
   */
  getStats(): { chunks: number; totalInstances: number } {
    let totalInstances = 0;
    for (const chunk of this.chunks.values()) {
      for (const matrices of chunk.instances.values()) {
        totalInstances += matrices.length / 16;
      }
    }
    return {
      chunks: this.chunks.size,
      totalInstances,
    };
  }

  /**
   * Dispose all foliage
   */
  disposeAll(): void {
    for (const chunk of this.chunks.values()) {
      for (const mesh of chunk.mesh.values()) {
        mesh.dispose();
      }
    }
    this.chunks.clear();
  }

  /**
   * Full cleanup
   */
  dispose(): void {
    this.disposeAll();
    
    for (const mesh of this.baseMeshes.values()) {
      mesh.dispose();
    }
    this.baseMeshes.clear();
    
    if (this.grassMaterial) {
      this.grassMaterial.dispose();
    }
    if (this.rockMaterial) {
      this.rockMaterial.dispose();
    }
  }
}
