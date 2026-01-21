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
  VertexBuffer,
  Geometry,
} from "@babylonjs/core";
import { Heightmap } from "../terrain/Heightmap";
import { SplatMap } from "../terrain/SplatMap";

// ============================================
// Noise functions for procedural rock generation (copied from ProceduralAsset)
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

// Helper to set vertex colors on a mesh
function setMeshVertexColor(mesh: Mesh, r: number, g: number, b: number): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) return;

  const vertexCount = positions.length / 3;
  const colors = new Float32Array(vertexCount * 4);

  for (let i = 0; i < vertexCount; i++) {
    colors[i * 4] = r;
    colors[i * 4 + 1] = g;
    colors[i * 4 + 2] = b;
    colors[i * 4 + 3] = 1.0;
  }

  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
}

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

// Register grass blade shader with fog and LOD fade support
Effect.ShadersStore["grassVertexShader"] = `
precision highp float;

attribute vec3 position;
attribute vec3 normal;
attribute vec4 color;

uniform mat4 viewProjection;
uniform float uTime;
uniform float uWindStrength;
uniform vec3 uCameraPosition;

varying vec3 vNormal;
varying vec4 vColor;
varying float vHeight;
varying float vCameraDistance;

void main() {
    // Get instance matrix
    mat4 worldMatrix = world;

    vec4 worldPos = worldMatrix * vec4(position, 1.0);
    vHeight = position.y;

    // Calculate camera distance for fog and LOD fade
    vCameraDistance = length(worldPos.xyz - uCameraPosition);

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
varying float vCameraDistance;

uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uAmbient;

// Fog uniforms
uniform vec3 uFogColor;
uniform float uFogDensity;

// LOD fade uniforms
uniform float uLodFar;

void main() {
    vec3 normal = normalize(vNormal);
    float NdotL = max(dot(normal, uSunDirection), 0.0);
    float diffuse = NdotL * 0.6 + 0.4;

    // Darken base, lighten tips
    float heightGradient = mix(0.7, 1.1, vHeight);

    vec3 color = vColor.rgb * heightGradient * (uAmbient + diffuse * uSunColor);

    // Apply exponential squared fog (same as scene fog)
    float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * vCameraDistance * vCameraDistance);
    fogFactor = clamp(fogFactor, 0.0, 1.0);
    color = mix(color, uFogColor, fogFactor);

    // Distance-based alpha fade for smooth LOD transition
    // Fade starts at 70% of far distance, fully faded at far
    float fadeStart = uLodFar * 0.7;
    float alpha = 1.0 - smoothstep(fadeStart, uLodFar, vCameraDistance);

    // Simple alpha test for grass edges
    if (vColor.a < 0.1) discard;

    // Discard fully faded fragments
    if (alpha < 0.01) discard;

    gl_FragColor = vec4(color, alpha);
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

  // Rock mesh variations (using ProceduralAsset for quality)
  private rockVariations: Mesh[] = [];
  private readonly ROCK_VARIATION_COUNT = 4;

  // Grass mesh variations (using ProceduralAsset-style generation)
  private grassVariations: Mesh[] = [];
  private readonly GRASS_VARIATION_COUNT = 4;

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
    // Grass mesh variations using ProceduralAsset-style generation
    this.createGrassVariations();

    // Use first variation as default base mesh
    if (this.grassVariations.length > 0) {
      this.baseMeshes.set("grass", this.grassVariations[0]);
    } else {
      // Fallback to simple grass blade mesh
      const grassMesh = this.createGrassBladeMesh();
      grassMesh.isVisible = false;
      this.baseMeshes.set("grass", grassMesh);
    }

    // Pebble mesh (small icosphere)
    const pebbleMesh = MeshBuilder.CreateIcoSphere("pebble_base", {
      radius: 0.5,
      subdivisions: 1,
    }, this.scene);
    pebbleMesh.isVisible = false;
    this.baseMeshes.set("pebble", pebbleMesh);

    // Rock mesh variations using ProceduralAsset for quality
    this.createRockVariations();

    // Use first variation as default base mesh
    if (this.rockVariations.length > 0) {
      this.baseMeshes.set("rock", this.rockVariations[0]);
      this.baseMeshes.set("sandRock", this.rockVariations[0]);
    }
  }

  /**
   * Create multiple rock mesh variations using ProceduralAsset-style generation
   * (without creating ShaderMaterial to avoid WebGPU shader compilation issues)
   */
  private createRockVariations(): void {
    console.log("[FoliageSystem] Creating rock variations...");

    for (let i = 0; i < this.ROCK_VARIATION_COUNT; i++) {
      const seed = 1000 + i * 777;  // Different seed for each variation
      const mesh = this.generateProceduralRock(seed);

      if (mesh) {
        mesh.name = `rock_variation_${i}`;
        mesh.isVisible = false;
        this.rockVariations.push(mesh);
      }
    }

    console.log(`[FoliageSystem] Created ${this.rockVariations.length} rock variations`);
  }

  /**
   * Generate a procedural rock mesh (same algorithm as ProceduralAsset.generateRock)
   */
  private generateProceduralRock(seed: number): Mesh {
    const rock = MeshBuilder.CreateIcoSphere(
      "rock_" + seed,
      { radius: 0.5, subdivisions: 4, flat: false, updatable: true },
      this.scene
    );

    // === Shape parameters (extracted from seed) ===
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

    const peakDirX = noise3D(seed * 6.0, seed * 0.2, 0);
    const peakDirY = noise3D(seed * 0.2, seed * 6.1, 0);
    const peakDirZ = noise3D(0, seed * 0.2, seed * 6.2);
    const peakLen = Math.sqrt(peakDirX * peakDirX + peakDirY * peakDirY + peakDirZ * peakDirZ);
    const peakStrength = 0.1 + Math.abs(noise3D(seed * 6.5, seed * 6.6, seed * 6.7)) * 0.4;

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

        // Apply peak
        if (peakLen > 0.1) {
          const pdx = peakDirX / peakLen;
          const pdy = peakDirY / peakLen;
          const pdz = peakDirZ / peakLen;
          const dot = nx * pdx + ny * pdy + nz * pdz;
          if (dot > 0) {
            const peakFactor = Math.pow(dot, 3) * peakStrength;
            x += pdx * peakFactor;
            y += pdy * peakFactor;
            z += pdz * peakFactor;
          }
        }

        // Surface detail
        const largeDetail = fbm3D(nx * 3 + seed, ny * 3 + seed * 0.7, nz * 3 + seed * 0.3, 2) * 0.12;
        const mediumDetail = fbm3D(nx * 6 + seed * 2, ny * 6 + seed * 1.5, nz * 6 + seed, 2) * 0.06;
        const smallDetail = noise3D(nx * 12 + seed * 3, ny * 12 + seed * 2.5, nz * 12) * 0.03;
        const surfaceDisp = largeDetail + mediumDetail + smallDetail;
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

    return rock;
  }

  /**
   * Create multiple grass mesh variations using ProceduralAsset-style generation
   */
  private createGrassVariations(): void {
    console.log("[FoliageSystem] Creating grass variations...");

    for (let i = 0; i < this.GRASS_VARIATION_COUNT; i++) {
      const seed = 2000 + i * 333;  // Different seed for each variation
      const mesh = this.generateProceduralGrassClump(seed);

      if (mesh) {
        mesh.name = `grass_variation_${i}`;
        mesh.isVisible = false;
        this.grassVariations.push(mesh);
      }
    }

    console.log(`[FoliageSystem] Created ${this.grassVariations.length} grass variations`);
  }

  /**
   * Generate a procedural grass clump mesh (same algorithm as ProceduralAsset.generateGrassClump)
   */
  private generateProceduralGrassClump(seed: number): Mesh {
    const blades: Mesh[] = [];

    // === Clump parameters ===
    const clumpDensity = 0.3 + Math.abs(noise3D(seed * 0.5, 0, 0)) * 0.7;           // 0.3 ~ 1.0 density
    const clumpSpread = 0.04 + Math.abs(noise3D(0, seed * 0.5, 0)) * 0.16;          // 0.04 ~ 0.2 spread radius
    const avgHeight = 0.2 + Math.abs(noise3D(0, 0, seed * 0.5)) * 0.5;              // 0.2 ~ 0.7 average height
    const avgWidth = 0.012 + Math.abs(noise3D(seed * 0.6, seed * 0.3, 0)) * 0.028;  // 0.012 ~ 0.04 average width

    // Blade count (density based)
    const bladeCount = Math.floor(4 + clumpDensity * 12);                            // 4 ~ 16 blades

    for (let i = 0; i < bladeCount; i++) {
      const iSeed = seed + i * 73.7;

      // === Individual blade parameters (varying around clump average) ===
      const heightVar = 0.6 + Math.abs(noise3D(iSeed, 0, 0)) * 0.8;                 // 0.6 ~ 1.4 multiplier
      const widthVar = 0.7 + Math.abs(noise3D(0, iSeed, 0)) * 0.6;                  // 0.7 ~ 1.3 multiplier
      const bladeHeight = avgHeight * heightVar;
      const bladeWidth = avgWidth * widthVar;

      // Curve (proportional to height + random)
      const curveBase = 0.02 + Math.abs(noise3D(0, 0, iSeed)) * 0.12;               // 0.02 ~ 0.14
      const bladeCurve = curveBase * (bladeHeight / 0.4);

      // Curved blade with 4 height levels
      const h1 = bladeHeight * 0.35;
      const h2 = bladeHeight * 0.65;
      const h3 = bladeHeight * 0.9;
      const h4 = bladeHeight;

      const c1 = bladeCurve * 0.25;
      const c2 = bladeCurve * 0.6;
      const c3 = bladeCurve * 0.9;
      const c4 = bladeCurve;

      // Width taper (thinner toward top)
      const taperRate = 0.6 + Math.abs(noise3D(iSeed * 1.5, 0, 0)) * 0.35;          // 0.6 ~ 0.95

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

      // Normal calculation
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

      // Position (distribution based on density)
      const angle = (noise3D(iSeed * 2, 0, 0) + 0.5) * Math.PI * 2;
      const distFactor = Math.pow(Math.abs(noise3D(0, iSeed * 2, 0)), 1.0 / clumpDensity);
      const dist = distFactor * clumpSpread;

      blade.position.x = Math.cos(angle) * dist;
      blade.position.z = Math.sin(angle) * dist;

      // Rotation and tilt (slight tilt only)
      blade.rotation.y = (noise3D(iSeed, iSeed, 0) + 0.5) * Math.PI * 2;
      blade.rotation.x = noise3D(iSeed * 3, 0, 0) * 0.12;
      blade.rotation.z = noise3D(0, iSeed * 3, 0) * 0.1;

      blades.push(blade);
    }

    // Set bright green vertex color for each blade before merging
    for (const blade of blades) {
      setMeshVertexColor(blade, 0.45, 0.75, 0.3);  // Bright grass green
    }

    const merged = Mesh.MergeMeshes(blades, true, true, undefined, false, true);
    if (merged) {
      merged.name = "grass_" + seed;
      return merged;
    }

    const fallback = new Mesh("grass_" + seed, this.scene);
    return fallback;
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
   * Create materials for foliage
   */
  private createMaterials(): void {
    // Standard material for rocks (uses scene fog automatically)
    this.rockMaterial = new StandardMaterial("foliage_rock_mat", this.scene);
    this.rockMaterial.diffuseColor = new Color3(0.5, 0.48, 0.45);
    this.rockMaterial.specularColor = new Color3(0.1, 0.1, 0.1);
    this.rockMaterial.backFaceCulling = false;

    // Apply to rock meshes
    const rockBase = this.baseMeshes.get("rock");
    if (rockBase) rockBase.material = this.rockMaterial;

    const pebbleBase = this.baseMeshes.get("pebble");
    if (pebbleBase) pebbleBase.material = this.rockMaterial;

    // Shader material for grass with fog and LOD fade support
    this.grassMaterial = new ShaderMaterial(
      "foliage_grass_mat",
      this.scene,
      {
        vertex: "grass",
        fragment: "grass",
      },
      {
        attributes: ["position", "normal", "color"],
        uniforms: [
          "world",
          "viewProjection",
          "uTime",
          "uWindStrength",
          "uCameraPosition",
          "uSunDirection",
          "uSunColor",
          "uAmbient",
          "uFogColor",
          "uFogDensity",
          "uLodFar",
        ],
        needAlphaBlending: true,
      }
    );

    // Set default uniform values
    this.grassMaterial.setFloat("uTime", 0);
    this.grassMaterial.setFloat("uWindStrength", 0.15);
    this.grassMaterial.setVector3("uCameraPosition", new Vector3(0, 0, 0));
    this.grassMaterial.setVector3("uSunDirection", new Vector3(0.5, 1, 0.5).normalize());
    this.grassMaterial.setColor3("uSunColor", new Color3(1, 0.95, 0.8));
    this.grassMaterial.setFloat("uAmbient", 0.4);

    // Default fog values (will be synced with scene fog when game mode is enabled)
    this.grassMaterial.setColor3("uFogColor", new Color3(0.55, 0.7, 0.9));
    this.grassMaterial.setFloat("uFogDensity", 0.015);

    // LOD far distance
    this.grassMaterial.setFloat("uLodFar", this.lodDistances.far);

    // Enable transparency for alpha fade
    this.grassMaterial.backFaceCulling = false;
    this.grassMaterial.alphaMode = 2; // ALPHA_COMBINE

    const grassBase = this.baseMeshes.get("grass");
    if (grassBase) grassBase.material = this.grassMaterial;

    // Also apply to grass variations
    for (const mesh of this.grassVariations) {
      mesh.material = this.grassMaterial;
    }
  }

  /**
   * Sync fog settings with scene fog for consistent appearance
   * Call this when entering game mode or when scene fog changes
   */
  syncFogSettings(fogColor: Color3, fogDensity: number): void {
    if (this.grassMaterial) {
      this.grassMaterial.setColor3("uFogColor", fogColor);
      this.grassMaterial.setFloat("uFogDensity", fogDensity);
    }

    // StandardMaterial uses scene fog automatically, no need to set manually
  }

  /**
   * Update camera position for fog calculation in shaders
   * Call this every frame when in game mode
   */
  updateCameraPosition(cameraPosition: Vector3): void {
    if (this.grassMaterial) {
      this.grassMaterial.setVector3("uCameraPosition", cameraPosition);
    }
  }

  /**
   * Update time uniform for wind animation
   */
  updateTime(time: number): void {
    if (this.grassMaterial) {
      this.grassMaterial.setFloat("uTime", time);
    }
  }

  /**
   * Update LOD far distance in shader for alpha fade
   */
  private updateShaderLodDistance(): void {
    if (this.grassMaterial) {
      this.grassMaterial.setFloat("uLodFar", this.lodDistances.far);
    }
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
      // For rock types, use multiple variations
      const isRockType = typeName === "rock" || typeName === "sandRock";
      const isGrassType = typeName === "grass";

      if (isGrassType && this.grassVariations.length > 0) {
        // Generate instances distributed across grass variations
        const variationMatrices = this.generateGrassInstancesWithVariations(
          config,
          worldStartX,
          worldStartZ,
          worldEndX,
          worldEndZ
        );

        // Create thin instance mesh for each variation
        for (let v = 0; v < this.grassVariations.length; v++) {
          const matrices = variationMatrices[v];
          if (matrices && matrices.length > 0) {
            const variationKey = `${typeName}_v${v}`;
            chunk.instances.set(variationKey, matrices);

            // Create a completely independent mesh with copied vertex data
            const baseMesh = this.grassVariations[v];
            const chunkMesh = new Mesh(`${variationKey}_${chunkKey}`, this.scene);

            // Copy vertex data to create independent geometry (avoid WebGPU buffer sharing issues)
            const positions = baseMesh.getVerticesData(VertexBuffer.PositionKind);
            const normals = baseMesh.getVerticesData(VertexBuffer.NormalKind);
            const colors = baseMesh.getVerticesData(VertexBuffer.ColorKind);
            const uvs = baseMesh.getVerticesData(VertexBuffer.UVKind);
            const indices = baseMesh.getIndices();

            if (positions && indices) {
              const vertexData = new VertexData();
              vertexData.positions = new Float32Array(positions);
              if (normals) vertexData.normals = new Float32Array(normals);
              if (colors) vertexData.colors = new Float32Array(colors);
              if (uvs) vertexData.uvs = new Float32Array(uvs);
              vertexData.indices = new Uint32Array(indices);
              vertexData.applyToMesh(chunkMesh);
            }

            chunkMesh.material = baseMesh.material;

            // Set thin instances
            const instanceCount = matrices.length / 16;
            chunkMesh.thinInstanceSetBuffer("matrix", matrices, 16, false);
            chunkMesh.thinInstanceCount = instanceCount;
            chunkMesh.thinInstanceRefreshBoundingInfo();

            chunk.mesh.set(variationKey, chunkMesh);
          }
        }
      } else if (isRockType && this.rockVariations.length > 0) {
        // Generate instances distributed across rock variations
        const variationMatrices = this.generateRockInstancesWithVariations(
          config,
          worldStartX,
          worldStartZ,
          worldEndX,
          worldEndZ
        );

        // Create thin instance mesh for each variation
        for (let v = 0; v < this.rockVariations.length; v++) {
          const matrices = variationMatrices[v];
          if (matrices && matrices.length > 0) {
            const variationKey = `${typeName}_v${v}`;
            chunk.instances.set(variationKey, matrices);

            // Create a completely independent mesh with copied vertex data
            const baseMesh = this.rockVariations[v];
            const chunkMesh = new Mesh(`${variationKey}_${chunkKey}`, this.scene);

            // Copy vertex data to create independent geometry (avoid WebGPU buffer sharing issues)
            const positions = baseMesh.getVerticesData(VertexBuffer.PositionKind);
            const normals = baseMesh.getVerticesData(VertexBuffer.NormalKind);
            const indices = baseMesh.getIndices();

            if (positions && normals && indices) {
              const vertexData = new VertexData();
              vertexData.positions = new Float32Array(positions);
              vertexData.normals = new Float32Array(normals);
              vertexData.indices = new Uint32Array(indices);
              vertexData.applyToMesh(chunkMesh);
            }

            chunkMesh.material = this.rockMaterial;

            // Set thin instances
            const instanceCount = matrices.length / 16;
            chunkMesh.thinInstanceSetBuffer("matrix", matrices, 16, false);
            chunkMesh.thinInstanceCount = instanceCount;
            chunkMesh.thinInstanceRefreshBoundingInfo();

            chunk.mesh.set(variationKey, chunkMesh);
          }
        }
      } else {
        // Standard generation for non-rock types
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
            // Create a completely independent mesh with copied vertex data
            const chunkMesh = new Mesh(`${typeName}_${chunkKey}`, this.scene);

            // Copy vertex data to create independent geometry (avoid WebGPU buffer sharing issues)
            const positions = baseMesh.getVerticesData(VertexBuffer.PositionKind);
            const normals = baseMesh.getVerticesData(VertexBuffer.NormalKind);
            const colors = baseMesh.getVerticesData(VertexBuffer.ColorKind);
            const indices = baseMesh.getIndices();

            if (positions && indices) {
              const vertexData = new VertexData();
              vertexData.positions = new Float32Array(positions);
              if (normals) vertexData.normals = new Float32Array(normals);
              if (colors) vertexData.colors = new Float32Array(colors);
              vertexData.indices = new Uint32Array(indices);
              vertexData.applyToMesh(chunkMesh);
            }

            chunkMesh.material = baseMesh.material;

            // Set thin instances
            const instanceCount = matrices.length / 16;
            chunkMesh.thinInstanceSetBuffer("matrix", matrices, 16, false);
            chunkMesh.thinInstanceCount = instanceCount;
            chunkMesh.thinInstanceRefreshBoundingInfo();

            chunk.mesh.set(typeName, chunkMesh);
          }
        }
      }
    }

    this.chunks.set(chunkKey, chunk);
  }

  /**
   * Generate rock instances distributed across variations
   */
  private generateRockInstancesWithVariations(
    config: FoliageTypeConfig,
    startX: number,
    startZ: number,
    endX: number,
    endZ: number
  ): Float32Array[] {
    const variationMatrices: number[][] = [];
    for (let i = 0; i < this.rockVariations.length; i++) {
      variationMatrices.push([]);
    }

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

      // Skip if in water area
      const waterWeight = this.splatMap.getWaterWeight(
        Math.max(0, Math.min(resolution - 1, splatX)),
        Math.max(0, Math.min(resolution - 1, splatZ))
      );
      if (waterWeight > 0.1) continue;

      // Probability based on biome weight
      if (this.seededRandom() > biomeWeight) continue;

      // Get terrain height and slope
      const y = this.heightmap.getInterpolatedHeight(x, z);
      const slope = this.calculateSlope(x, z);

      // Skip if slope is too steep
      if (slope > config.slopeMax) continue;

      // Calculate scale with variation
      // Use power distribution to bias toward smaller rocks (power > 1 = more small rocks)
      const sizeRandom = Math.pow(this.seededRandom(), 2.5);  // Bias heavily toward small values
      const scaleBase = config.minScale + sizeRandom * (config.maxScale - config.minScale);
      const scale = scaleBase * (0.8 + this.seededRandom() * 0.4);

      // Random rotation
      const rotationY = this.seededRandom() * Math.PI * 2;
      const rotationX = (this.seededRandom() - 0.5) * 0.2;  // Slight tilt
      const rotationZ = (this.seededRandom() - 0.5) * 0.2;

      // Create transformation matrix
      const matrix = Matrix.Compose(
        new Vector3(scale, scale, scale),
        Vector3.Zero().toQuaternion(),
        new Vector3(x, y + config.yOffset, z)
      );

      // Apply rotations
      const rotMatrixY = Matrix.RotationY(rotationY);
      const rotMatrixX = Matrix.RotationX(rotationX);
      const rotMatrixZ = Matrix.RotationZ(rotationZ);
      const rotMatrix = rotMatrixZ.multiply(rotMatrixX).multiply(rotMatrixY);
      const finalMatrix = rotMatrix.multiply(matrix);

      // Select variation based on seeded random
      const variationIndex = Math.floor(this.seededRandom() * this.rockVariations.length);

      // Add matrix values to the appropriate variation array
      const matrixArray = finalMatrix.toArray();
      variationMatrices[variationIndex].push(...matrixArray);
    }

    return variationMatrices.map((arr) => new Float32Array(arr));
  }

  /**
   * Generate grass instances distributed across variations
   */
  private generateGrassInstancesWithVariations(
    config: FoliageTypeConfig,
    startX: number,
    startZ: number,
    endX: number,
    endZ: number
  ): Float32Array[] {
    const variationMatrices: number[][] = [];
    for (let i = 0; i < this.grassVariations.length; i++) {
      variationMatrices.push([]);
    }

    const resolution = this.splatMap.getResolution();

    // Seed based on chunk position for consistency
    this.resetSeed(Math.floor(startX * 1000 + startZ + 500));  // Different offset from rock

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

      // Skip if in water area
      const waterWeight = this.splatMap.getWaterWeight(
        Math.max(0, Math.min(resolution - 1, splatX)),
        Math.max(0, Math.min(resolution - 1, splatZ))
      );
      if (waterWeight > 0.1) continue;

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

      // Random rotation (Y axis only for grass)
      const rotationY = this.seededRandom() * Math.PI * 2;

      // Create transformation matrix
      const matrix = Matrix.Compose(
        new Vector3(scale, scale, scale),
        Vector3.Zero().toQuaternion(),
        new Vector3(x, y + config.yOffset, z)
      );

      // Apply Y rotation
      const rotMatrixY = Matrix.RotationY(rotationY);
      const finalMatrix = rotMatrixY.multiply(matrix);

      // Select variation based on seeded random
      const variationIndex = Math.floor(this.seededRandom() * this.grassVariations.length);

      // Add matrix values to the appropriate variation array
      const matrixArray = finalMatrix.toArray();
      variationMatrices[variationIndex].push(...matrixArray);
    }

    return variationMatrices.map((arr) => new Float32Array(arr));
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

      // Skip if in water area
      const waterWeight = this.splatMap.getWaterWeight(
        Math.max(0, Math.min(resolution - 1, splatX)),
        Math.max(0, Math.min(resolution - 1, splatZ))
      );
      if (waterWeight > 0.1) continue;

      // Probability based on biome weight
      if (this.seededRandom() > biomeWeight) continue;

      // Get terrain height and slope
      const y = this.heightmap.getInterpolatedHeight(x, z);
      const slope = this.calculateSlope(x, z);

      // Skip if slope is too steep
      if (slope > config.slopeMax) continue;

      // Calculate scale with variation
      // Use power distribution to bias toward smaller rocks (power > 1 = more small rocks)
      const sizeRandom = Math.pow(this.seededRandom(), 2.5);  // Bias heavily toward small values
      const scaleBase = config.minScale + sizeRandom * (config.maxScale - config.minScale);
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
   * Supports infinite terrain by wrapping camera position to terrain bounds
   */
  updateVisibility(cameraPosition: Vector3): void {
    // Wrap camera position to terrain bounds for infinite terrain support
    let camX = cameraPosition.x % this.terrainScale;
    let camZ = cameraPosition.z % this.terrainScale;
    if (camX < 0) camX += this.terrainScale;
    if (camZ < 0) camZ += this.terrainScale;

    for (const [key, chunk] of this.chunks) {
      const chunkCenterX = (chunk.x + 0.5) * this.chunkSize;
      const chunkCenterZ = (chunk.z + 0.5) * this.chunkSize;

      const distance = Math.sqrt(
        Math.pow(camX - chunkCenterX, 2) +
        Math.pow(camZ - chunkCenterZ, 2)
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

    // Update shader uniform for alpha fade
    this.updateShaderLodDistance();
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
   * Set visibility of all foliage meshes (for debugging)
   */
  setVisible(visible: boolean): void {
    // Hide/show base meshes
    for (const mesh of this.baseMeshes.values()) {
      mesh.isVisible = visible;
    }
    // Hide/show rock variations
    for (const mesh of this.rockVariations) {
      mesh.isVisible = visible;
    }
    // Hide/show grass variations
    for (const mesh of this.grassVariations) {
      mesh.isVisible = visible;
    }
    // Hide/show chunk meshes
    for (const chunk of this.chunks.values()) {
      for (const mesh of chunk.mesh.values()) {
        mesh.isVisible = visible;
      }
    }
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

    // Dispose rock variations
    for (const mesh of this.rockVariations) {
      mesh.dispose();
    }
    this.rockVariations = [];

    // Dispose grass variations
    for (const mesh of this.grassVariations) {
      mesh.dispose();
    }
    this.grassVariations = [];

    if (this.grassMaterial) {
      this.grassMaterial.dispose();
    }
    if (this.rockMaterial) {
      this.rockMaterial.dispose();
    }
  }
}
