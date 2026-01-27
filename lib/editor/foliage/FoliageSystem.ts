import {
  Scene,
  Mesh,
  MeshBuilder,
  Vector3,
  Matrix,
  Quaternion,
  Color3,
  Color4,
  VertexData,
  ShaderMaterial,
  Effect,
  VertexBuffer,
  Geometry,
} from "@babylonjs/core";
import { Heightmap } from "../terrain/Heightmap";
import { SplatMap } from "../terrain/SplatMap";
import { MathPools } from "../utils/ObjectPool";
import { DataCodec } from "../../loader";

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

// LOD level for density control
export enum FoliageLOD {
  Near = 0,     // 100% density (3D meshes)
  Mid = 1,      // 50% density (3D meshes)
  Impostor = 2, // Billboard impostors (far distance)
  Far = 3,      // Unloaded
}

// Chunk for spatial organization
interface FoliageChunk {
  x: number;
  z: number;
  instances: Map<string, Float32Array>;  // type -> matrix buffer (full density)
  mesh: Map<string, Mesh>;               // type -> thin instance mesh
  impostorMesh: Mesh | null;             // Impostor billboard mesh for this chunk
  visible: boolean;
  currentLOD: FoliageLOD;                // Current LOD level for density
}

// Register grass blade shader with fog and distance-based LOD
Effect.ShadersStore["grassVertexShader"] = `
precision highp float;

attribute vec3 position;
attribute vec3 normal;
attribute vec4 color;

attribute vec4 world0;
attribute vec4 world1;
attribute vec4 world2;
attribute vec4 world3;

uniform mat4 viewProjection;
uniform float uTime;
uniform float uWindStrength;
uniform vec3 uCameraPosition;
uniform float uLodFar;

varying vec3 vNormal;
varying vec4 vColor;
varying float vHeight;
varying vec3 vWorldPosition;

void main() {
    mat4 worldMatrix = mat4(world0, world1, world2, world3);
    vec4 worldPos = worldMatrix * vec4(position, 1.0);

    // Camera height extends LOD distance (higher view = see further)
    float cameraHeight = max(0.0, uCameraPosition.y - 10.0);
    float heightBonus = cameraHeight * 1.5;
    float effectiveLodFar = uLodFar + heightBonus;

    // Distance-based LOD scale (shrinks grass at distance)
    float distanceToCamera = length(worldPos.xz - uCameraPosition.xz);
    float distanceRatio = distanceToCamera / effectiveLodFar;
    float lodScale = 1.0 - smoothstep(0.7, 1.0, distanceRatio);

    // Grass base position (y=0 point)
    vec3 grassBase = vec3(worldPos.x, worldPos.y - position.y, worldPos.z);

    // Wind attenuation: separate from lodScale, starts much earlier
    // Wind 100%: 0~20% of effectiveLodFar, fade: 20%~50%, 0%: beyond 50%
    float windScale = 1.0 - smoothstep(0.2, 0.5, distanceRatio);
    float heightWindAtten = 1.0 / (1.0 + cameraHeight * 0.03);
    float windFactor = position.y * uWindStrength * windScale * heightWindAtten;
    float windX = sin(uTime * 2.0 + worldPos.x * 0.5 + worldPos.z * 0.3) * windFactor;
    float windZ = cos(uTime * 1.5 + worldPos.x * 0.3 + worldPos.z * 0.5) * windFactor * 0.5;

    // Apply scale: shrink toward base
    vec3 finalPos = mix(grassBase, worldPos.xyz, lodScale);
    finalPos.x += windX;
    finalPos.z += windZ;

    vWorldPosition = finalPos;
    vHeight = position.y * lodScale;

    gl_Position = viewProjection * vec4(finalPos, 1.0);
    vNormal = normalize(mat3(worldMatrix) * normal);
    vColor = color;
}
`;

// Register rock shader with fog matching terrain/grass
Effect.ShadersStore["rockVertexShader"] = `
precision highp float;

attribute vec3 position;
attribute vec3 normal;

// Thin instance world matrix (4 columns as vec4 attributes)
attribute vec4 world0;
attribute vec4 world1;
attribute vec4 world2;
attribute vec4 world3;

uniform mat4 viewProjection;
uniform vec3 uCameraPosition;

varying vec3 vNormal;
varying vec3 vWorldPosition;

void main() {
    // Reconstruct world matrix from thin instance attributes
    mat4 worldMatrix = mat4(world0, world1, world2, world3);
    vec4 worldPos = worldMatrix * vec4(position, 1.0);

    vWorldPosition = worldPos.xyz;
    vNormal = normalize(mat3(worldMatrix) * normal);

    gl_Position = viewProjection * worldPos;
}
`;

Effect.ShadersStore["rockFragmentShader"] = `
precision highp float;

varying vec3 vNormal;
varying vec3 vWorldPosition;

uniform vec3 uCameraPosition;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uAmbient;
uniform vec3 uDiffuseColor;
uniform vec3 uSpecularColor;

// Fog uniforms (matching terrain/grass)
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogHeightFalloff;
uniform float uFogHeightDensity;

void main() {
    vec3 normal = normalize(vNormal);

    // Diffuse lighting
    float NdotL = max(dot(normal, uSunDirection), 0.0);
    float diffuse = NdotL * 0.6 + 0.4;

    // Specular (subtle)
    vec3 viewDir = normalize(uCameraPosition - vWorldPosition);
    vec3 halfVec = normalize(uSunDirection + viewDir);
    float specular = pow(max(dot(normal, halfVec), 0.0), 32.0) * 0.15;

    vec3 color = uDiffuseColor * (uAmbient + diffuse * uSunColor);
    color += uSpecularColor * specular * uSunColor;

    // ========== Fog System (matching terrain/grass) ==========
    float distanceToCamera = length(vWorldPosition - uCameraPosition);

    // Distance fog (exponential squared)
    float distanceFog = 1.0 - exp(-uFogDensity * uFogDensity * distanceToCamera * distanceToCamera);

    // Height fog (concentrate fog at lower altitudes)
    float heightFactor = exp(-max(0.0, vWorldPosition.y - uFogHeightFalloff) * uFogHeightDensity);
    float heightFog = heightFactor * 0.3;

    // Final fog factor
    float fogFactor = clamp(distanceFog + heightFog, 0.0, 1.0);

    // Apply fog
    color = mix(color, uFogColor, fogFactor);

    // Tone mapping and gamma (matching terrain shader)
    color = color / (color + vec3(1.0)) * 1.1;
    color = pow(color, vec3(0.95));

    gl_FragColor = vec4(color, 1.0);
}
`;

// Impostor billboard shader (camera-facing quads)
Effect.ShadersStore["impostorVertexShader"] = `
precision highp float;

attribute vec3 position;
attribute vec2 uv;

// Thin instance world matrix
attribute vec4 world0;
attribute vec4 world1;
attribute vec4 world2;
attribute vec4 world3;

uniform mat4 view;
uniform mat4 viewProjection;
uniform vec3 uCameraPosition;

varying vec2 vUV;
varying vec3 vWorldPosition;
varying float vScale;

void main() {
    // Extract position and scale from instance matrix
    vec3 instancePos = vec3(world0.w, world1.w, world2.w);
    float scaleX = length(vec3(world0.x, world1.x, world2.x));
    float scaleY = length(vec3(world0.y, world1.y, world2.y));
    vScale = max(scaleX, scaleY);

    // Billboard: rotate to face camera (Y-axis only for stability)
    vec3 toCamera = uCameraPosition - instancePos;
    toCamera.y = 0.0;
    float len = length(toCamera);
    if (len > 0.01) {
        toCamera /= len;
    } else {
        toCamera = vec3(0.0, 0.0, 1.0);
    }
    vec3 right = vec3(toCamera.z, 0.0, -toCamera.x);
    vec3 up = vec3(0.0, 1.0, 0.0);

    // Apply billboard transform (scale position by instance scale)
    vec3 billboardPos = instancePos
        + right * position.x * scaleX
        + up * position.y * scaleY;

    vWorldPosition = billboardPos;
    vUV = uv;

    gl_Position = viewProjection * vec4(billboardPos, 1.0);
}
`;

Effect.ShadersStore["impostorFragmentShader"] = `
precision highp float;

uniform vec3 uBaseColor;
uniform vec3 uCameraPosition;
uniform vec3 uFogColor;
uniform float uFogDensity;

varying vec2 vUV;
varying vec3 vWorldPosition;
varying float vScale;

void main() {
    // Circular billboard with soft edges
    vec2 centered = vUV - 0.5;
    float dist = length(centered);
    float alpha = 1.0 - smoothstep(0.3, 0.5, dist);
    if (alpha < 0.01) discard;

    // Simple shading (lighter at top)
    float heightGradient = vUV.y * 0.2 + 0.9;
    vec3 color = uBaseColor * heightGradient;

    // Fog
    float distanceToCamera = length(vWorldPosition - uCameraPosition);
    float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * distanceToCamera * distanceToCamera);
    color = mix(color, uFogColor, clamp(fogFactor, 0.0, 1.0));

    gl_FragColor = vec4(color, alpha * 0.8);
}
`;

Effect.ShadersStore["grassFragmentShader"] = `
precision highp float;

varying vec3 vNormal;
varying vec4 vColor;
varying float vHeight;
varying vec3 vWorldPosition;

uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uAmbient;
uniform vec3 uCameraPosition;

// Fog uniforms
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogHeightFalloff;
uniform float uFogHeightDensity;

void main() {
    vec3 normal = normalize(vNormal);
    float NdotL = max(dot(normal, uSunDirection), 0.0);
    float diffuse = NdotL * 0.6 + 0.4;

    // Darken base, lighten tips
    float heightGradient = mix(0.7, 1.1, vHeight);

    vec3 color = vColor.rgb * heightGradient * (uAmbient + diffuse * uSunColor);

    // ========== Fog System (matching TerrainShader) ==========
    float distanceToCamera = length(vWorldPosition - uCameraPosition);

    // Distance fog (exponential squared)
    float distanceFog = 1.0 - exp(-uFogDensity * uFogDensity * distanceToCamera * distanceToCamera);

    // Height fog (concentrate fog at lower altitudes)
    float heightFactor = exp(-max(0.0, vWorldPosition.y - uFogHeightFalloff) * uFogHeightDensity);
    float heightFog = heightFactor * 0.3;

    // Final fog factor
    float fogFactor = clamp(distanceFog + heightFog, 0.0, 1.0);

    // Apply fog
    color = mix(color, uFogColor, fogFactor);

    // Tone mapping and gamma (terrain과 동일)
    color = color / (color + vec3(1.0)) * 1.1;
    color = pow(color, vec3(0.95));

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

  // Cell management for streaming (cells contain multiple chunks)
  private cellSize = 64;  // 64x64 world units per cell (matches StreamingManager)
  private loadedCells: Set<string> = new Set();  // Track which cells are loaded
  
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
  private rockMaterial: ShaderMaterial | null = null;
  private impostorGrassMaterial: ShaderMaterial | null = null;
  private impostorRockMaterial: ShaderMaterial | null = null;

  // Impostor base mesh (simple quad billboard)
  private impostorBaseMesh: Mesh | null = null;
  
  // Performance settings
  private maxInstancesPerChunk = 5000;
  private lodDistances = {
    near: 100,   // full density
    mid: 200,    // 50% density
    far: 450,    // fade out distance
  };

  // Reusable objects for matrix generation (avoid GC pressure)
  private readonly _tempScale = new Vector3();
  private readonly _tempPosition = new Vector3();
  private readonly _tempQuaternion = new Quaternion();
  private readonly _tempMatrix = new Matrix();
  private readonly _tempRotMatrixY = new Matrix();
  private readonly _tempRotMatrixX = new Matrix();
  private readonly _tempRotMatrixZ = new Matrix();
  private readonly _tempRotMatrix = new Matrix();
  private readonly _tempFinalMatrix = new Matrix();

  // Wrapping mode for infinite terrain support (disable in game mode)
  private useWrapping = true;

  // Camera position caching for updateVisibility optimization
  private lastVisibilityCamX = -Infinity;
  private lastVisibilityCamZ = -Infinity;
  private lastVisibilityCamY = -Infinity;
  private readonly VISIBILITY_UPDATE_THRESHOLD = 2.0;  // Only update if moved > 2 units

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
    this.createImpostorSystem();
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

    // Create 2 crossing quads for a grass clump (optimized from 3)
    // backFaceCulling=false handles visibility from both sides
    const bladeCount = 2;
    const bladeWidth = 0.08;
    const bladeHeight = 0.5;

    for (let i = 0; i < bladeCount; i++) {
      const angle = (i / bladeCount) * Math.PI;  // 0° and 90°
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

      // Two triangles only (no back faces - backFaceCulling=false handles it)
      indices.push(baseIdx, baseIdx + 1, baseIdx + 2);
      indices.push(baseIdx, baseIdx + 2, baseIdx + 3);
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
    // Shader material for rocks with fog matching terrain/grass
    this.rockMaterial = new ShaderMaterial(
      "foliage_rock_mat",
      this.scene,
      {
        vertex: "rock",
        fragment: "rock",
      },
      {
        attributes: ["position", "normal"],
        uniforms: [
          "viewProjection",
          "uCameraPosition",
          "uSunDirection",
          "uSunColor",
          "uAmbient",
          "uDiffuseColor",
          "uSpecularColor",
          "uFogColor",
          "uFogDensity",
          "uFogHeightFalloff",
          "uFogHeightDensity",
        ],
      }
    );

    // Set rock material uniforms
    this.rockMaterial.setVector3("uCameraPosition", new Vector3(0, 0, 0));
    this.rockMaterial.setVector3("uSunDirection", new Vector3(0.5, 1, 0.5).normalize());
    this.rockMaterial.setColor3("uSunColor", new Color3(1, 0.95, 0.8));
    this.rockMaterial.setFloat("uAmbient", 0.4);
    this.rockMaterial.setColor3("uDiffuseColor", new Color3(0.5, 0.48, 0.45));
    this.rockMaterial.setColor3("uSpecularColor", new Color3(0.1, 0.1, 0.1));

    // Fog uniforms (matching terrain/grass defaults)
    this.rockMaterial.setColor3("uFogColor", new Color3(0.6, 0.75, 0.9));
    this.rockMaterial.setFloat("uFogDensity", 0.008);
    this.rockMaterial.setFloat("uFogHeightFalloff", 5.0);
    this.rockMaterial.setFloat("uFogHeightDensity", 0.1);

    this.rockMaterial.backFaceCulling = false;

    // Apply to rock meshes
    const rockBase = this.baseMeshes.get("rock");
    if (rockBase) rockBase.material = this.rockMaterial;

    const pebbleBase = this.baseMeshes.get("pebble");
    if (pebbleBase) pebbleBase.material = this.rockMaterial;

    // Shader material for grass with fog (opaque rendering for performance)
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
          "viewProjection",
          "uTime",
          "uWindStrength",
          "uCameraPosition",
          "uLodFar",
          "uSunDirection",
          "uSunColor",
          "uAmbient",
          "uFogColor",
          "uFogDensity",
          "uFogHeightFalloff",
          "uFogHeightDensity",
        ],
        needAlphaBlending: false,
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
    this.grassMaterial.setColor3("uFogColor", new Color3(0.6, 0.75, 0.9));
    this.grassMaterial.setFloat("uFogDensity", 0.008);
    this.grassMaterial.setFloat("uFogHeightFalloff", 5.0);
    this.grassMaterial.setFloat("uFogHeightDensity", 0.1);

    // LOD far distance
    this.grassMaterial.setFloat("uLodFar", this.lodDistances.far);

    // Grass needs both sides rendered (thin blades)
    this.grassMaterial.backFaceCulling = false;

    const grassBase = this.baseMeshes.get("grass");
    if (grassBase) grassBase.material = this.grassMaterial;

    // Also apply to grass variations
    for (const mesh of this.grassVariations) {
      mesh.material = this.grassMaterial;
    }
  }

  /**
   * Create impostor system (billboard meshes and materials)
   */
  private createImpostorSystem(): void {
    console.log("[FoliageSystem] Creating impostor system...");

    // Create base impostor mesh (simple quad facing camera)
    this.impostorBaseMesh = MeshBuilder.CreatePlane("impostor_base", {
      width: 1,
      height: 1,
    }, this.scene);
    this.impostorBaseMesh.isVisible = false;
    this.impostorBaseMesh.isPickable = false;

    // Grass impostor material (green billboards)
    this.impostorGrassMaterial = new ShaderMaterial(
      "impostor_grass_mat",
      this.scene,
      {
        vertex: "impostor",
        fragment: "impostor",
      },
      {
        attributes: ["position", "uv", "world0", "world1", "world2", "world3"],
        uniforms: [
          "view",
          "viewProjection",
          "uCameraPosition",
          "uBaseColor",
          "uFogColor",
          "uFogDensity",
        ],
        needAlphaBlending: true,
      }
    );

    this.impostorGrassMaterial.setColor3("uBaseColor", new Color3(0.35, 0.55, 0.25));
    this.impostorGrassMaterial.setVector3("uCameraPosition", new Vector3(0, 0, 0));
    this.impostorGrassMaterial.setColor3("uFogColor", new Color3(0.6, 0.75, 0.9));
    this.impostorGrassMaterial.setFloat("uFogDensity", 0.008);
    this.impostorGrassMaterial.backFaceCulling = false;
    this.impostorGrassMaterial.alphaMode = 2; // ALPHA_COMBINE

    // Rock impostor material (gray billboards)
    this.impostorRockMaterial = new ShaderMaterial(
      "impostor_rock_mat",
      this.scene,
      {
        vertex: "impostor",
        fragment: "impostor",
      },
      {
        attributes: ["position", "uv", "world0", "world1", "world2", "world3"],
        uniforms: [
          "view",
          "viewProjection",
          "uCameraPosition",
          "uBaseColor",
          "uFogColor",
          "uFogDensity",
        ],
        needAlphaBlending: true,
      }
    );

    this.impostorRockMaterial.setColor3("uBaseColor", new Color3(0.5, 0.48, 0.45));
    this.impostorRockMaterial.setVector3("uCameraPosition", new Vector3(0, 0, 0));
    this.impostorRockMaterial.setColor3("uFogColor", new Color3(0.6, 0.75, 0.9));
    this.impostorRockMaterial.setFloat("uFogDensity", 0.008);
    this.impostorRockMaterial.backFaceCulling = false;
    this.impostorRockMaterial.alphaMode = 2; // ALPHA_COMBINE

    console.log("[FoliageSystem] Impostor system created");
  }

  /**
   * Sync fog settings with scene fog for consistent appearance
   * Call this when entering game mode or when scene fog changes
   */
  syncFogSettings(
    fogColor: Color3,
    fogDensity: number,
    fogHeightFalloff: number = 5.0,
    fogHeightDensity: number = 0.1
  ): void {
    if (this.grassMaterial) {
      this.grassMaterial.setColor3("uFogColor", fogColor);
      this.grassMaterial.setFloat("uFogDensity", fogDensity);
      this.grassMaterial.setFloat("uFogHeightFalloff", fogHeightFalloff);
      this.grassMaterial.setFloat("uFogHeightDensity", fogHeightDensity);
    }

    // Rock material also uses custom shader now
    if (this.rockMaterial) {
      this.rockMaterial.setColor3("uFogColor", fogColor);
      this.rockMaterial.setFloat("uFogDensity", fogDensity);
      this.rockMaterial.setFloat("uFogHeightFalloff", fogHeightFalloff);
      this.rockMaterial.setFloat("uFogHeightDensity", fogHeightDensity);
    }

    // Impostor materials (simpler fog, no height factor)
    if (this.impostorGrassMaterial) {
      this.impostorGrassMaterial.setColor3("uFogColor", fogColor);
      this.impostorGrassMaterial.setFloat("uFogDensity", fogDensity);
    }
    if (this.impostorRockMaterial) {
      this.impostorRockMaterial.setColor3("uFogColor", fogColor);
      this.impostorRockMaterial.setFloat("uFogDensity", fogDensity);
    }
  }

  /**
   * Update camera position for fog calculation in shaders
   * Call this every frame when in game mode
   */
  updateCameraPosition(cameraPosition: Vector3): void {
    if (this.grassMaterial) {
      this.grassMaterial.setVector3("uCameraPosition", cameraPosition);
    }
    if (this.rockMaterial) {
      this.rockMaterial.setVector3("uCameraPosition", cameraPosition);
    }
    // Update impostor materials
    if (this.impostorGrassMaterial) {
      this.impostorGrassMaterial.setVector3("uCameraPosition", cameraPosition);
    }
    if (this.impostorRockMaterial) {
      this.impostorRockMaterial.setVector3("uCameraPosition", cameraPosition);
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
      impostorMesh: null,  // Created on-demand when LOD switches to Impostor
      visible: true,
      currentLOD: FoliageLOD.Near,  // Default to full density
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
            // Shuffle for even distribution when LOD reduces density
            this.shuffleMatrices(matrices, chunkX * 1000 + chunkZ * 100 + v);
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
            // Shuffle for even distribution when LOD reduces density
            this.shuffleMatrices(matrices, chunkX * 1000 + chunkZ * 100 + v + 50);
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
          // Shuffle for even distribution when LOD reduces density
          this.shuffleMatrices(matrices, chunkX * 1000 + chunkZ * 100 + typeName.charCodeAt(0));
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
    // Early exit if no variations available
    if (this.rockVariations.length === 0) {
      console.warn("[FoliageSystem] No rock variations available for generation");
      return [];
    }

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

      // Create transformation matrix using reusable objects
      this._tempScale.set(scale, scale, scale);
      this._tempPosition.set(x, y + config.yOffset, z);
      this._tempQuaternion.set(0, 0, 0, 1);  // Identity quaternion
      Matrix.ComposeToRef(this._tempScale, this._tempQuaternion, this._tempPosition, this._tempMatrix);

      // Apply rotations using reusable matrices
      Matrix.RotationYToRef(rotationY, this._tempRotMatrixY);
      Matrix.RotationXToRef(rotationX, this._tempRotMatrixX);
      Matrix.RotationZToRef(rotationZ, this._tempRotMatrixZ);
      this._tempRotMatrixZ.multiplyToRef(this._tempRotMatrixX, this._tempRotMatrix);
      this._tempRotMatrix.multiplyToRef(this._tempRotMatrixY, this._tempFinalMatrix);
      this._tempFinalMatrix.multiplyToRef(this._tempMatrix, this._tempRotMatrix);

      // Select variation based on seeded random
      const variationIndex = Math.floor(this.seededRandom() * this.rockVariations.length);

      // Add matrix values to the appropriate variation array (inline to avoid toArray allocation)
      const m = this._tempRotMatrix.m;
      variationMatrices[variationIndex].push(
        m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7],
        m[8], m[9], m[10], m[11], m[12], m[13], m[14], m[15]
      );
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
    // Early exit if no variations available
    if (this.grassVariations.length === 0) {
      console.warn("[FoliageSystem] No grass variations available for generation");
      return [];
    }

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

      // Create transformation matrix using reusable objects
      this._tempScale.set(scale, scale, scale);
      this._tempPosition.set(x, y + config.yOffset, z);
      this._tempQuaternion.set(0, 0, 0, 1);  // Identity quaternion
      Matrix.ComposeToRef(this._tempScale, this._tempQuaternion, this._tempPosition, this._tempMatrix);

      // Apply Y rotation using reusable matrix
      Matrix.RotationYToRef(rotationY, this._tempRotMatrixY);
      this._tempRotMatrixY.multiplyToRef(this._tempMatrix, this._tempFinalMatrix);

      // Select variation based on seeded random
      const variationIndex = Math.floor(this.seededRandom() * this.grassVariations.length);

      // Add matrix values inline (avoid toArray allocation)
      const m = this._tempFinalMatrix.m;
      variationMatrices[variationIndex].push(
        m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7],
        m[8], m[9], m[10], m[11], m[12], m[13], m[14], m[15]
      );
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

      // Create transformation matrix using reusable objects
      this._tempScale.set(scale, scale, scale);
      this._tempPosition.set(x, y + config.yOffset, z);
      this._tempQuaternion.set(0, 0, 0, 1);  // Identity quaternion
      Matrix.ComposeToRef(this._tempScale, this._tempQuaternion, this._tempPosition, this._tempMatrix);

      // Apply Y rotation using reusable matrix
      Matrix.RotationYToRef(rotationY, this._tempRotMatrixY);
      this._tempRotMatrixY.multiplyToRef(this._tempMatrix, this._tempFinalMatrix);

      // Add matrix values inline (avoid toArray allocation)
      const m = this._tempFinalMatrix.m;
      matrices.push(
        m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7],
        m[8], m[9], m[10], m[11], m[12], m[13], m[14], m[15]
      );
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
   * Supports infinite terrain by wrapping camera position to terrain bounds (when useWrapping is true)
   * Optimized: uses squared distance to avoid sqrt per chunk
   * Optimized: skips update if camera hasn't moved significantly
   */
  updateVisibility(cameraPosition: Vector3): void {
    // Camera position for distance calculation
    let camX: number;
    let camZ: number;

    if (this.useWrapping) {
      // Wrap camera position to terrain bounds for infinite terrain support
      camX = cameraPosition.x % this.terrainScale;
      camZ = cameraPosition.z % this.terrainScale;
      if (camX < 0) camX += this.terrainScale;
      if (camZ < 0) camZ += this.terrainScale;
    } else {
      // Use actual camera position (game mode with fixed boundaries)
      camX = cameraPosition.x;
      camZ = cameraPosition.z;
    }

    // Early exit: skip update if camera hasn't moved significantly
    const moveDx = camX - this.lastVisibilityCamX;
    const moveDz = camZ - this.lastVisibilityCamZ;
    const moveDistSq = moveDx * moveDx + moveDz * moveDz;
    const heightChanged = Math.abs(cameraPosition.y - this.lastVisibilityCamY) > 5.0;

    if (moveDistSq < this.VISIBILITY_UPDATE_THRESHOLD * this.VISIBILITY_UPDATE_THRESHOLD && !heightChanged) {
      return;  // Camera hasn't moved enough, skip chunk iteration
    }

    // Update cached position
    this.lastVisibilityCamX = camX;
    this.lastVisibilityCamZ = camZ;
    this.lastVisibilityCamY = cameraPosition.y;

    // Calculate effective LOD distance (match GPU shader logic)
    const cameraHeight = Math.max(0, cameraPosition.y - 10);
    const heightBonus = cameraHeight * 1.5;
    const effectiveLodFar = this.lodDistances.far + heightBonus;
    // Pre-compute squared distance threshold (avoid sqrt per chunk)
    const effectiveLodFarSq = effectiveLodFar * effectiveLodFar;

    for (const [key, chunk] of this.chunks) {
      const chunkCenterX = (chunk.x + 0.5) * this.chunkSize;
      const chunkCenterZ = (chunk.z + 0.5) * this.chunkSize;

      // Use squared distance (no sqrt needed)
      const dx = camX - chunkCenterX;
      const dz = camZ - chunkCenterZ;
      const distanceSq = dx * dx + dz * dz;

      // Distance-based visibility with height-adjusted LOD distance
      const visible = distanceSq < effectiveLodFarSq;

      if (chunk.visible !== visible) {
        chunk.visible = visible;
        for (const mesh of chunk.mesh.values()) {
          mesh.setEnabled(visible);
        }
      }
    }
  }

  /**
   * Set wrapping mode for camera position in updateVisibility
   * @param useWrapping true for infinite terrain (editor mode), false for fixed boundaries (game mode)
   */
  setUseWrapping(useWrapping: boolean): void {
    this.useWrapping = useWrapping;
  }

  /**
   * Reset all chunk visibility to visible (used when exiting game mode)
   * In editor mode, all chunks should always be visible since updateVisibility is not called.
   */
  resetAllChunkVisibility(): void {
    for (const [, chunk] of this.chunks) {
      if (!chunk.visible) {
        chunk.visible = true;
        for (const mesh of chunk.mesh.values()) {
          mesh.setEnabled(true);
        }
      }
    }
    // Invalidate visibility cache
    this.lastVisibilityCamX = -Infinity;
    this.lastVisibilityCamZ = -Infinity;
    this.lastVisibilityCamY = -Infinity;
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
   * Get base mesh for a foliage type (for external rendering)
   * @param typeName - e.g., "grass_v0", "rock_v1", "sandRock_v0"
   */
  getBaseMesh(typeName: string): Mesh | undefined {
    const varMatch = typeName.match(/_v(\d+)$/);
    const varIdx = varMatch ? parseInt(varMatch[1]) : 0;
    const baseTypeName = typeName.replace(/_v\d+$/, "");

    if (baseTypeName === "grass" && this.grassVariations.length > 0) {
      return this.grassVariations[varIdx] || this.grassVariations[0];
    } else if ((baseTypeName === "rock" || baseTypeName === "sandRock") && this.rockVariations.length > 0) {
      return this.rockVariations[varIdx] || this.rockVariations[0];
    } else {
      return this.baseMeshes.get(baseTypeName);
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
      // Dispose impostor mesh if exists
      if (chunk.impostorMesh) {
        chunk.impostorMesh.dispose();
      }
    }
    this.chunks.clear();

    // Invalidate visibility cache so next updateVisibility runs full check
    this.lastVisibilityCamX = -Infinity;
    this.lastVisibilityCamZ = -Infinity;
    this.lastVisibilityCamY = -Infinity;
  }

  // ============================================
  // Tile Data Export/Import
  // ============================================

  /**
   * Export all foliage instance data for saving with tile
   * Returns type -> Base64 encoded Float32Array of matrices
   */
  exportTileData(): Record<string, string> {
    const result: Record<string, string> = {};

    // Collect all matrices by type across all chunks
    const typeMatrices: Map<string, number[]> = new Map();

    for (const chunk of this.chunks.values()) {
      for (const [typeName, matrices] of chunk.instances) {
        if (!typeMatrices.has(typeName)) {
          typeMatrices.set(typeName, []);
        }
        // Add all matrix values to the type's array
        const arr = typeMatrices.get(typeName)!;
        for (let i = 0; i < matrices.length; i++) {
          arr.push(matrices[i]);
        }
      }
    }

    // Encode each type's matrices to Base64
    for (const [typeName, values] of typeMatrices) {
      if (values.length > 0) {
        const float32 = new Float32Array(values);
        result[typeName] = DataCodec.encodeFloat32Array(float32);
      }
    }

    console.log(`[FoliageSystem] Exported ${Object.keys(result).length} foliage types`);
    return result;
  }

  /**
   * Import foliage instance data from saved tile
   * @param data - type -> Base64 encoded matrices
   * @param offsetX - X offset for positioning (tile grid position * tile size)
   * @param offsetZ - Z offset for positioning
   * @param clearExisting - Whether to clear existing foliage first
   */
  importTileData(
    data: Record<string, string>,
    offsetX: number = 0,
    offsetZ: number = 0,
    clearExisting: boolean = false
  ): void {
    if (clearExisting) {
      this.disposeAll();
    }

    let totalImported = 0;

    for (const [typeName, base64] of Object.entries(data)) {
      const matrices = DataCodec.decodeFloat32Array(base64);
      if (matrices.length === 0) continue;

      const instanceCount = matrices.length / 16;

      // Apply offset to each matrix if needed
      if (offsetX !== 0 || offsetZ !== 0) {
        for (let i = 0; i < instanceCount; i++) {
          const baseIdx = i * 16;
          // Matrix column 3 contains translation (indices 12, 13, 14 for x, y, z)
          matrices[baseIdx + 12] += offsetX;
          matrices[baseIdx + 14] += offsetZ;
        }
      }

      // Find which chunks these instances belong to and add them
      this.addImportedInstances(typeName, matrices);
      totalImported += instanceCount;
    }

    console.log(`[FoliageSystem] Imported ${totalImported} foliage instances`);
  }

  /**
   * Add imported instances to appropriate chunks
   */
  private addImportedInstances(typeName: string, matrices: Float32Array): void {
    // Group instances by chunk
    const chunkInstances: Map<string, number[]> = new Map();
    const instanceCount = matrices.length / 16;

    for (let i = 0; i < instanceCount; i++) {
      const baseIdx = i * 16;
      // Get world position from matrix translation (column 3)
      const worldX = matrices[baseIdx + 12];
      const worldZ = matrices[baseIdx + 14];

      // Calculate chunk coordinates
      const chunkX = Math.floor(worldX / this.chunkSize);
      const chunkZ = Math.floor(worldZ / this.chunkSize);
      const chunkKey = `${chunkX},${chunkZ}`;

      if (!chunkInstances.has(chunkKey)) {
        chunkInstances.set(chunkKey, []);
      }

      // Add all 16 matrix values for this instance
      const arr = chunkInstances.get(chunkKey)!;
      for (let j = 0; j < 16; j++) {
        arr.push(matrices[baseIdx + j]);
      }
    }

    // Add to chunks
    for (const [chunkKey, values] of chunkInstances) {
      const [cx, cz] = chunkKey.split(",").map(Number);
      let chunk = this.chunks.get(chunkKey);

      if (!chunk) {
        chunk = {
          x: cx,
          z: cz,
          instances: new Map(),
          mesh: new Map(),
          impostorMesh: null,
          visible: true,
          currentLOD: FoliageLOD.Near,
        };
        this.chunks.set(chunkKey, chunk);
      }

      // Merge with existing instances for this type
      const existingMatrices = chunk.instances.get(typeName);
      const newMatrices = new Float32Array(values);

      if (existingMatrices) {
        const merged = new Float32Array(existingMatrices.length + newMatrices.length);
        merged.set(existingMatrices);
        merged.set(newMatrices, existingMatrices.length);
        chunk.instances.set(typeName, merged);
      } else {
        chunk.instances.set(typeName, newMatrices);
      }

      // Update mesh thin instances
      this.updateChunkMesh(chunk, typeName);
    }
  }

  /**
   * Update mesh thin instances for a specific type in a chunk
   */
  private updateChunkMesh(chunk: FoliageChunk, typeName: string): void {
    const matrices = chunk.instances.get(typeName);
    if (!matrices || matrices.length === 0) return;

    // Get or create mesh for this type
    let mesh = chunk.mesh.get(typeName);

    // Determine which base mesh to use
    // Format: "grass_v0", "rock_v1", "sandRock_v0", "pebble_v0" etc.
    let baseMesh: Mesh | undefined;

    // Parse variation index from format "type_vN"
    const varMatch = typeName.match(/_v(\d+)$/);
    const varIdx = varMatch ? parseInt(varMatch[1]) : 0;
    const baseTypeName = typeName.replace(/_v\d+$/, "");

    if (baseTypeName === "grass" && this.grassVariations.length > 0) {
      baseMesh = this.grassVariations[varIdx] || this.grassVariations[0];
    } else if ((baseTypeName === "rock" || baseTypeName === "sandRock") && this.rockVariations.length > 0) {
      baseMesh = this.rockVariations[varIdx] || this.rockVariations[0];
    } else {
      // Fallback: try baseMeshes (pebble, etc.)
      baseMesh = this.baseMeshes.get(baseTypeName);
    }

    if (!baseMesh) {
      console.warn(`[FoliageSystem] No base mesh for type: ${typeName} (base: ${baseTypeName})`);
      return;
    }

    if (!mesh) {
      // Create new mesh with independent geometry (avoid WebGPU buffer sharing issues)
      mesh = new Mesh(`foliage_${chunk.x}_${chunk.z}_${typeName}`, this.scene);

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
        vertexData.applyToMesh(mesh);
      }

      mesh.material = baseMesh.material;
      mesh.isVisible = true;
      chunk.mesh.set(typeName, mesh);
    }

    // Set thin instances
    const instanceCount = matrices.length / 16;
    mesh.thinInstanceSetBuffer("matrix", matrices, 16, false);
    mesh.thinInstanceCount = instanceCount;
    mesh.thinInstanceRefreshBoundingInfo();
  }

  // ============================================
  // Cell-based Streaming
  // ============================================

  /**
   * Set the cell size (should match StreamingManager)
   */
  setCellSize(size: number): void {
    this.cellSize = size;
    console.log(`[FoliageSystem] Cell size set to ${size}`);
  }

  /**
   * Get cell size
   */
  getCellSize(): number {
    return this.cellSize;
  }

  /**
   * Get chunk coordinates that belong to a cell
   * A cell contains (cellSize / chunkSize)^2 chunks
   */
  private getChunksInCell(cellX: number, cellZ: number): Array<{ chunkX: number; chunkZ: number }> {
    const chunksPerCellEdge = Math.ceil(this.cellSize / this.chunkSize);
    const result: Array<{ chunkX: number; chunkZ: number }> = [];

    // Cell world bounds
    const cellWorldStartX = cellX * this.cellSize;
    const cellWorldStartZ = cellZ * this.cellSize;

    // Convert to chunk coordinates
    const startChunkX = Math.floor(cellWorldStartX / this.chunkSize);
    const startChunkZ = Math.floor(cellWorldStartZ / this.chunkSize);

    for (let dx = 0; dx < chunksPerCellEdge; dx++) {
      for (let dz = 0; dz < chunksPerCellEdge; dz++) {
        result.push({
          chunkX: startChunkX + dx,
          chunkZ: startChunkZ + dz,
        });
      }
    }

    return result;
  }

  /**
   * Generate foliage for a specific cell
   * This generates all chunks that belong to the cell
   */
  generateCell(cellX: number, cellZ: number): void {
    const cellKey = `${cellX}_${cellZ}`;

    if (this.loadedCells.has(cellKey)) {
      console.log(`[FoliageSystem] Cell ${cellKey} already loaded`);
      return;
    }

    console.log(`[FoliageSystem] Generating cell (${cellX},${cellZ})...`);

    const chunks = this.getChunksInCell(cellX, cellZ);
    let generatedCount = 0;

    for (const { chunkX, chunkZ } of chunks) {
      const chunkKey = `${chunkX}_${chunkZ}`;
      if (!this.chunks.has(chunkKey)) {
        this.generateChunk(chunkX, chunkZ);
        generatedCount++;
      }
    }

    this.loadedCells.add(cellKey);
    console.log(`[FoliageSystem] Cell ${cellKey} loaded with ${generatedCount} new chunks`);
  }

  /**
   * Unload foliage for a specific cell
   * This disposes all chunks that belong to the cell
   */
  unloadCell(cellX: number, cellZ: number): void {
    const cellKey = `${cellX}_${cellZ}`;

    if (!this.loadedCells.has(cellKey)) {
      return;
    }

    console.log(`[FoliageSystem] Unloading cell (${cellX},${cellZ})...`);

    const chunks = this.getChunksInCell(cellX, cellZ);
    let unloadedCount = 0;

    for (const { chunkX, chunkZ } of chunks) {
      const chunkKey = `${chunkX}_${chunkZ}`;
      const chunk = this.chunks.get(chunkKey);

      if (chunk) {
        // Dispose all meshes in this chunk
        for (const mesh of chunk.mesh.values()) {
          mesh.dispose();
        }
        // Dispose impostor mesh if exists
        if (chunk.impostorMesh) {
          chunk.impostorMesh.dispose();
        }
        this.chunks.delete(chunkKey);
        unloadedCount++;
      }
    }

    this.loadedCells.delete(cellKey);
    console.log(`[FoliageSystem] Cell ${cellKey} unloaded (${unloadedCount} chunks disposed)`);
  }

  /**
   * Update LOD for a specific cell (adjusts foliage density)
   * Near: 100% density (3D), Mid: 50% density (3D), Impostor: billboards, Far: unloaded
   */
  updateCellLOD(cellX: number, cellZ: number, lod: FoliageLOD): void {
    const cellKey = `${cellX}_${cellZ}`;

    if (!this.loadedCells.has(cellKey)) {
      // If not loaded and LOD is Near/Mid/Impostor, generate it
      if (lod !== FoliageLOD.Far) {
        this.generateCell(cellX, cellZ);
      } else {
        return;
      }
    }

    // Get LOD density multiplier
    const densityMultiplier = this.getLODDensityMultiplier(lod);
    const useImpostor = lod === FoliageLOD.Impostor;

    const chunks = this.getChunksInCell(cellX, cellZ);
    let updatedCount = 0;

    for (const { chunkX, chunkZ } of chunks) {
      const chunkKey = `${chunkX}_${chunkZ}`;
      const chunk = this.chunks.get(chunkKey);

      if (chunk && chunk.currentLOD !== lod) {
        const prevLOD = chunk.currentLOD;
        chunk.currentLOD = lod;

        if (useImpostor) {
          // Switch to impostor mode: hide 3D meshes, show impostor
          for (const mesh of chunk.mesh.values()) {
            mesh.setEnabled(false);
          }
          this.createOrShowChunkImpostor(chunk);
        } else {
          // Switch to 3D mesh mode: show 3D meshes, hide impostor
          if (chunk.impostorMesh) {
            chunk.impostorMesh.setEnabled(false);
          }

          // Update thin instance counts based on density multiplier
          for (const [typeName, fullMatrices] of chunk.instances) {
            const mesh = chunk.mesh.get(typeName);
            if (mesh && fullMatrices.length > 0) {
              mesh.setEnabled(true);
              const fullInstanceCount = fullMatrices.length / 16;
              const targetCount = Math.max(1, Math.floor(fullInstanceCount * densityMultiplier));
              mesh.thinInstanceCount = targetCount;
            }
          }
        }
        updatedCount++;
      }
    }

    if (updatedCount > 0) {
      console.log(`[FoliageSystem] Cell ${cellKey} LOD updated to ${FoliageLOD[lod]} (${updatedCount} chunks)`);
    }
  }

  /**
   * Create or show impostor mesh for a chunk
   * Aggregates all foliage instances into a single impostor billboard mesh
   */
  private createOrShowChunkImpostor(chunk: FoliageChunk): void {
    if (!this.impostorBaseMesh) return;

    if (chunk.impostorMesh) {
      // Already exists, just show it
      chunk.impostorMesh.setEnabled(true);
      return;
    }

    // Aggregate all instance positions for impostor
    // Sample every Nth instance to reduce impostor count
    const IMPOSTOR_SAMPLE_RATE = 4;  // Use 1/4 of instances for impostors
    const matrices: number[] = [];
    let isGrassType = false;

    for (const [typeName, fullMatrices] of chunk.instances) {
      // Determine if this is grass or rock type
      if (typeName.startsWith("grass")) {
        isGrassType = true;
      }

      const instanceCount = fullMatrices.length / 16;
      for (let i = 0; i < instanceCount; i += IMPOSTOR_SAMPLE_RATE) {
        const baseIdx = i * 16;
        // Extract position (translation) and scale from matrix
        const x = fullMatrices[baseIdx + 12];
        const y = fullMatrices[baseIdx + 13];
        const z = fullMatrices[baseIdx + 14];
        const scaleX = Math.sqrt(
          fullMatrices[baseIdx] * fullMatrices[baseIdx] +
          fullMatrices[baseIdx + 4] * fullMatrices[baseIdx + 4] +
          fullMatrices[baseIdx + 8] * fullMatrices[baseIdx + 8]
        );

        // Create impostor matrix using reusable objects
        const scale = scaleX * 1.5;  // Slightly larger to compensate for fewer instances
        this._tempScale.set(scale, scale, 1);
        this._tempPosition.set(x, y + scale * 0.5, z);  // Offset Y to center billboard
        this._tempQuaternion.set(0, 0, 0, 1);
        Matrix.ComposeToRef(this._tempScale, this._tempQuaternion, this._tempPosition, this._tempMatrix);
        const m = this._tempMatrix.m;
        matrices.push(
          m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7],
          m[8], m[9], m[10], m[11], m[12], m[13], m[14], m[15]
        );
      }
    }

    if (matrices.length === 0) return;

    // Create impostor mesh for this chunk
    const impostorMesh = this.impostorBaseMesh.clone(`impostor_${chunk.x}_${chunk.z}`, null);
    if (!impostorMesh) return;

    impostorMesh.makeGeometryUnique();
    impostorMesh.material = isGrassType ? this.impostorGrassMaterial : this.impostorRockMaterial;
    impostorMesh.isVisible = true;
    impostorMesh.isPickable = false;

    // Set thin instances
    const float32Matrices = new Float32Array(matrices);
    const instanceCount = float32Matrices.length / 16;
    impostorMesh.thinInstanceSetBuffer("matrix", float32Matrices, 16, false);
    impostorMesh.thinInstanceCount = instanceCount;
    impostorMesh.thinInstanceRefreshBoundingInfo();

    chunk.impostorMesh = impostorMesh;
  }

  /**
   * Shuffle matrices in-place for even LOD distribution
   * Uses Fisher-Yates shuffle with seeded random for determinism
   */
  private shuffleMatrices(matrices: Float32Array, seed: number): void {
    const count = matrices.length / 16;
    if (count <= 1) return;

    // Simple seeded random (deterministic per chunk)
    let s = seed;
    const random = (): number => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };

    // Fisher-Yates shuffle (swap 4x4 matrices)
    const temp = new Float32Array(16);
    for (let i = count - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      if (i !== j) {
        // Swap matrix at index i with matrix at index j
        const iOffset = i * 16;
        const jOffset = j * 16;
        // Copy i to temp
        for (let k = 0; k < 16; k++) temp[k] = matrices[iOffset + k];
        // Copy j to i
        for (let k = 0; k < 16; k++) matrices[iOffset + k] = matrices[jOffset + k];
        // Copy temp to j
        for (let k = 0; k < 16; k++) matrices[jOffset + k] = temp[k];
      }
    }
  }

  /**
   * Get density multiplier for LOD level
   */
  private getLODDensityMultiplier(lod: FoliageLOD): number {
    switch (lod) {
      case FoliageLOD.Near:
        return 1.0;    // 100% density
      case FoliageLOD.Mid:
        return 0.5;    // 50% density
      case FoliageLOD.Impostor:
        return 0.0;    // Using impostor billboards instead
      case FoliageLOD.Far:
        return 0.0;    // Should be unloaded
      default:
        return 1.0;
    }
  }

  /**
   * Check if a cell is loaded
   */
  isCellLoaded(cellX: number, cellZ: number): boolean {
    return this.loadedCells.has(`${cellX}_${cellZ}`);
  }

  /**
   * Get all loaded cells
   */
  getLoadedCells(): Array<{ cellX: number; cellZ: number }> {
    const result: Array<{ cellX: number; cellZ: number }> = [];
    for (const key of this.loadedCells) {
      const [cellX, cellZ] = key.split('_').map(Number);
      result.push({ cellX, cellZ });
    }
    return result;
  }

  /**
   * Get cell statistics
   */
  getCellStats(): {
    loadedCells: number;
    totalChunks: number;
    chunksPerCell: number;
  } {
    const chunksPerCellEdge = Math.ceil(this.cellSize / this.chunkSize);
    return {
      loadedCells: this.loadedCells.size,
      totalChunks: this.chunks.size,
      chunksPerCell: chunksPerCellEdge * chunksPerCellEdge,
    };
  }

  /**
   * Full cleanup
   */
  dispose(): void {
    this.disposeAll();
    this.loadedCells.clear();

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

    // Dispose impostor system
    if (this.impostorBaseMesh) {
      this.impostorBaseMesh.dispose();
      this.impostorBaseMesh = null;
    }
    if (this.impostorGrassMaterial) {
      this.impostorGrassMaterial.dispose();
      this.impostorGrassMaterial = null;
    }
    if (this.impostorRockMaterial) {
      this.impostorRockMaterial.dispose();
      this.impostorRockMaterial = null;
    }
  }
}
