import {
  Scene,
  Mesh,
  Vector3,
  Matrix,
  Color3,
  ShaderMaterial,
  Effect,
  VertexBuffer,
  VertexData,
  Frustum,
  BoundingInfo,
  BoundingSphere,
} from "@babylonjs/core";
import * as BABYLON from "@babylonjs/core";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/loaders/glTF";
import { Heightmap } from "../terrain/Heightmap";
import { ProceduralAsset, AssetParams, AssetType, DEFAULT_ASSET_PARAMS } from "./ProceduralAsset";
import { loadTextureWithFallback } from "../../shared/rendering/TextureLoader";
import { DEFAULT_FOLIAGE_QUALITY_PROFILE } from "../../shared/foliage/FoliageQualityProfile";

// ============================================
// LOD Configuration
// ============================================
export enum MeshLOD {
  High = 0,   // Near distance, full detail
  Medium = 1, // Medium distance, reduced detail
  Low = 2,    // Far distance, minimal detail
}

// Subdivision levels for each LOD tier
// IcoSphere triangles: 20 × 4^subdivisions (1=80, 2=320, 3=1280, 4=5120)
const LOD_SUBDIVISIONS: Record<AssetType, Record<MeshLOD, number>> = {
  rock: { [MeshLOD.High]: 3, [MeshLOD.Medium]: 2, [MeshLOD.Low]: 2 },   // 1280/320/320 tri
  tree: { [MeshLOD.High]: 3, [MeshLOD.Medium]: 2, [MeshLOD.Low]: 2 },   // 1280/320/320 tri
  bush: { [MeshLOD.High]: 3, [MeshLOD.Medium]: 2, [MeshLOD.Low]: 2 },   // 1280/320/320 tri
  grass_clump: { [MeshLOD.High]: 0, [MeshLOD.Medium]: 0, [MeshLOD.Low]: 0 },  // Grass doesn't use subdivisions
};

// Distance thresholds for LOD switching (in world units)
const LOD_DISTANCES = {
  highToMedium: 30,   // Switch from High to Medium at 30 units
  mediumToLow: 80,    // Switch from Medium to Low at 80 units
};

const REFERENCE_TREE_ROOT_URL = "/assets/references/infinite-terrain/";
const REFERENCE_TREE_FILE_NAME = "tree.glb";

// ============================================
// Thin instance shaders for props (supports world0-world3 attributes)
// ============================================
Effect.ShadersStore["propThinVertexShader"] = `
precision highp float;

attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;

// Thin instance world matrix (4 columns as vec4 attributes)
attribute vec4 world0;
attribute vec4 world1;
attribute vec4 world2;
attribute vec4 world3;

uniform mat4 viewProjection;
uniform vec3 cameraPosition;

varying vec3 vNormal;
varying vec3 vPosition;
varying vec3 vLocalPosition;
varying vec2 vUV;
varying float vCameraDistance;
varying vec3 vViewDirection;

void main() {
    // Reconstruct world matrix from thin instance attributes
    mat4 worldMatrix = mat4(world0, world1, world2, world3);
    vec4 worldPos = worldMatrix * vec4(position, 1.0);

    gl_Position = viewProjection * worldPos;

    vNormal = normalize(mat3(worldMatrix) * normal);
    vPosition = worldPos.xyz;
    vLocalPosition = position;
    vUV = uv;
    vCameraDistance = length(cameraPosition - worldPos.xyz);
    vViewDirection = normalize(cameraPosition - worldPos.xyz);
}
`;

Effect.ShadersStore["propThinFragmentShader"] = `
precision highp float;

uniform vec3 baseColor;
uniform vec3 detailColor;
uniform vec3 sunDirection;
uniform float ambientIntensity;
uniform vec3 fogColor;
uniform float fogDensity;
uniform sampler2D rockTexture;
uniform float textureScale;

varying vec3 vNormal;
varying vec3 vPosition;
varying vec3 vLocalPosition;
varying vec2 vUV;
varying float vCameraDistance;
varying vec3 vViewDirection;

// 3D noise functions for per-pixel detail
float hash3D(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

float noise3D(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);

    float n000 = hash3D(i);
    float n100 = hash3D(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash3D(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash3D(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash3D(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash3D(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash3D(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash3D(i + vec3(1.0, 1.0, 1.0));

    vec4 n_z0 = vec4(n000, n100, n010, n110);
    vec4 n_z1 = vec4(n001, n101, n011, n111);
    vec4 n_zz = mix(n_z0, n_z1, f.z);
    vec2 n_y = mix(n_zz.xy, n_zz.zw, f.y);
    return mix(n_y.x, n_y.y, f.x);
}

float fbm(vec3 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 3; i++) {
        value += amplitude * noise3D(p);
        p *= 2.0;
        amplitude *= 0.5;
    }
    return value;
}

void main() {
    vec3 normal = normalize(vNormal);

    // Triplanar texture sampling (world-space projection)
    vec3 blending = abs(normal);
    blending = blending / (blending.x + blending.y + blending.z);

    vec3 texX = texture2D(rockTexture, vPosition.yz * textureScale).rgb;
    vec3 texY = texture2D(rockTexture, vPosition.xz * textureScale).rgb;
    vec3 texZ = texture2D(rockTexture, vPosition.xy * textureScale).rgb;
    vec3 texColor = texX * blending.x + texY * blending.y + texZ * blending.z;

    // Procedural color variation
    float colorNoise = fbm(vPosition * 2.0);
    vec3 procColor = mix(baseColor, detailColor, colorNoise * 0.5);

    // Blend: 70% texture, 30% procedural
    vec3 color = mix(procColor, texColor, 0.7);

    // Diffuse lighting (standard Lambert, matching terrain)
    float NdotL = max(dot(normal, sunDirection), 0.0);
    float diffuse = NdotL * 0.6 + 0.4;

    // Rim lighting
    float rimFactor = 1.0 - max(dot(normal, vViewDirection), 0.0);
    rimFactor = pow(rimFactor, 3.0) * 0.1;

    // Ambient occlusion approximation
    float ao = 0.5 + 0.5 * normal.y;

    // Final lighting
    vec3 ambient = vec3(ambientIntensity) * ao;
    vec3 rim = vec3(rimFactor) * vec3(0.8, 0.85, 1.0);

    color = color * (ambient + diffuse) + rim;

    // Fog
    float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vCameraDistance * vCameraDistance);
    color = mix(color, fogColor, clamp(fogFactor, 0.0, 1.0));

    // Tone mapping (matching terrain shader)
    color = color / (color + vec3(1.0)) * 1.1;
    color = pow(color, vec3(0.95));

    gl_FragColor = vec4(color, 1.0);
}
`;

// Wind-enabled thin instance shader for foliage props
Effect.ShadersStore["propThinWindVertexShader"] = `
precision highp float;

attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
attribute vec4 color;

// Thin instance world matrix (4 columns as vec4 attributes)
attribute vec4 world0;
attribute vec4 world1;
attribute vec4 world2;
attribute vec4 world3;

uniform mat4 viewProjection;
uniform vec3 cameraPosition;
uniform float uTime;
uniform vec2 uWindDirection;
uniform float uWindStrength;
uniform float uMinWindHeight;
uniform float uMaxWindHeight;
uniform float uPropsPrimarySpeed;
uniform float uPropsSecondarySpeed;
uniform float uPropsNoiseSpeed;

varying vec3 vNormal;
varying vec3 vPosition;
varying vec3 vLocalPosition;
varying vec2 vUV;
varying float vCameraDistance;
varying vec3 vViewDirection;
varying vec4 vColor;

float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise2D(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);

    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));

    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
    // Reconstruct world matrix from thin instance attributes
    mat4 worldMatrix = mat4(world0, world1, world2, world3);
    vec4 worldPos = worldMatrix * vec4(position, 1.0);
    vec3 localPos = position;

    // Height factor for wind
    float heightAboveMin = max(0.0, localPos.y - uMinWindHeight);
    float heightRange = max(0.01, uMaxWindHeight - uMinWindHeight);
    float heightFactor = clamp(heightAboveMin / heightRange, 0.0, 1.0);
    heightFactor = heightFactor * heightFactor;

    // Wind wave
    vec2 worldPosXZ = worldPos.xz;
    float windPhase = dot(worldPosXZ, uWindDirection) * 0.5 + uTime * uPropsPrimarySpeed;
    float primaryWave = sin(windPhase) * 0.5 + 0.5;
    float secondaryPhase = dot(worldPosXZ, uWindDirection) * 2.0 + uTime * uPropsSecondarySpeed;
    float secondaryWave = sin(secondaryPhase) * 0.3 + 0.5;
    float noiseVal = noise2D(worldPosXZ * 0.3 + uTime * uPropsNoiseSpeed);
    float windAmount = (primaryWave * 0.7 + secondaryWave * 0.3 + noiseVal * 0.2) * heightFactor * uWindStrength;

    // Apply wind displacement
    localPos.x += uWindDirection.x * windAmount * 0.15;
    localPos.z += uWindDirection.y * windAmount * 0.15;
    localPos.y -= windAmount * 0.03;

    vec4 finalWorldPos = worldMatrix * vec4(localPos, 1.0);
    gl_Position = viewProjection * finalWorldPos;

    vNormal = normalize(mat3(worldMatrix) * normal);
    vPosition = finalWorldPos.xyz;
    vLocalPosition = localPos;
    vUV = uv;
    vCameraDistance = length(cameraPosition - finalWorldPos.xyz);
    vViewDirection = normalize(cameraPosition - finalWorldPos.xyz);
    vColor = color;
}
`;

Effect.ShadersStore["propThinWindFragmentShader"] = `
precision highp float;

uniform vec3 baseColor;
uniform vec3 detailColor;
uniform vec3 sunDirection;
uniform float ambientIntensity;
uniform vec3 fogColor;
uniform float fogDensity;
uniform sampler2D dirtTexture;
uniform float dirtTextureScale;
uniform sampler2D leafAtlas;
uniform float uLeafAlphaCutoff;
uniform float uLeafFadeStart;
uniform float uLeafFadeEnd;
uniform float uUseLeafAtlas;
uniform float uLeafMaskFromLuma;
uniform float uFresnelPower;
uniform float uFresnelStrength;
uniform vec3 uFresnelColor;

varying vec3 vNormal;
varying vec3 vPosition;
varying vec3 vLocalPosition;
varying vec2 vUV;
varying float vCameraDistance;
varying vec3 vViewDirection;
varying vec4 vColor;

float hash3D(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

float noise3D(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);

    float n000 = hash3D(i);
    float n100 = hash3D(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash3D(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash3D(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash3D(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash3D(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash3D(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash3D(i + vec3(1.0, 1.0, 1.0));

    vec4 n_z0 = vec4(n000, n100, n010, n110);
    vec4 n_z1 = vec4(n001, n101, n011, n111);
    vec4 n_zz = mix(n_z0, n_z1, f.z);
    vec2 n_y = mix(n_zz.xy, n_zz.zw, f.y);
    return mix(n_y.x, n_y.y, f.x);
}

float fbm(vec3 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 3; i++) {
        value += amplitude * noise3D(p);
        p *= 2.0;
        amplitude *= 0.5;
    }
    return value;
}

float hash2D(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
    vec3 normal = normalize(vNormal);
    float leafMask = step(vColor.r + 0.02, vColor.g);
    vec4 leafSample = texture2D(leafAtlas, vUV);
    float usesLeafAtlas = uUseLeafAtlas * leafMask;
    float leafMaskAlpha = mix(leafSample.a, dot(leafSample.rgb, vec3(0.299, 0.587, 0.114)), uLeafMaskFromLuma);

    if (usesLeafAtlas > 0.5 && leafMaskAlpha < uLeafAlphaCutoff) {
        discard;
    }

    float fadeAlpha = 1.0 - smoothstep(uLeafFadeStart, uLeafFadeEnd, vCameraDistance);
    float dither = hash2D(gl_FragCoord.xy + vPosition.xz * 3.17);
    if (leafMask > 0.5 && dither > clamp(fadeAlpha, 0.0, 1.0)) {
        discard;
    }

    // Use vertex color if available, otherwise use baseColor
    vec3 meshColor = vColor.a > 0.5 ? vColor.rgb : baseColor;

    // Color variation
    float colorNoise = fbm(vPosition * 2.0);
    vec3 color = mix(meshColor, meshColor * 0.8, colorNoise * 0.3);

    // Height-based color (tips lighter)
    float tipFactor = smoothstep(0.0, 0.6, vLocalPosition.y);
    float isLeaf = mix(0.3, 1.0, leafMask);
    color = mix(color * 0.85, color * 1.1, tipFactor * isLeaf);

    // Triplanar dirt texture for bark (R > G = brown = bark)
    // Always sample outside control flow for WebGPU/WGSL compatibility
    vec3 barkBlend = abs(normal);
    barkBlend = barkBlend / (barkBlend.x + barkBlend.y + barkBlend.z);
    vec3 dirtTexX = texture2D(dirtTexture, vPosition.yz * dirtTextureScale).rgb;
    vec3 dirtTexY = texture2D(dirtTexture, vPosition.xz * dirtTextureScale).rgb;
    vec3 dirtTexZ = texture2D(dirtTexture, vPosition.xy * dirtTextureScale).rgb;
    vec3 dirtSample = dirtTexX * barkBlend.x + dirtTexY * barkBlend.y + dirtTexZ * barkBlend.z;
    float isBark = step(vColor.g, vColor.r);  // 1.0 if R > G (bark), 0.0 otherwise
    color = mix(color, mix(color, dirtSample, 0.4), isBark);

    // Half-Lambert diffuse
    float NdotL = dot(normal, sunDirection);
    float halfLambert = NdotL * 0.5 + 0.5;
    halfLambert = halfLambert * halfLambert;

    // Rim lighting
    float rimFactor = 1.0 - max(dot(normal, vViewDirection), 0.0);
    rimFactor = pow(rimFactor, 3.0) * 0.08;

    // Fresnel rim light for leaves
    float ndv = clamp(dot(normal, vViewDirection), 0.0, 1.0);
    float fresnel = pow(1.0 - ndv, uFresnelPower) * uFresnelStrength;

    // Subsurface scattering approximation
    float sss = max(0.0, dot(-vViewDirection, sunDirection)) * tipFactor * 0.15;

    // Final lighting
    float diffuse = halfLambert * 0.6 + 0.4;
    vec3 ambient = vec3(ambientIntensity);
    vec3 rim = vec3(rimFactor) * vec3(0.8, 0.9, 1.0);

    color = color * (ambient + diffuse) + rim + vec3(0.1, 0.15, 0.05) * sss;

    // Fresnel: mix blend for softer rim
    color = mix(color, uFresnelColor, clamp(fresnel * leafMask, 0.0, 1.0));

    // Fog
    float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vCameraDistance * vCameraDistance);
    color = mix(color, fogColor, clamp(fogFactor, 0.0, 1.0));

    // Tone mapping and gamma (matching terrain/foliage shaders)
    color = color / (color + vec3(1.0)) * 1.1;
    color = pow(color, vec3(0.95));

    gl_FragColor = vec4(color, 1.0);
}
`;

// LOD level for props visibility
export enum PropLOD {
  Near = 0,   // All props visible
  Mid = 1,    // Medium/large props only
  Far = 2,    // Large props only (landmarks)
}

// Number of variations per asset type for thin instancing
const VARIATIONS_PER_TYPE = 8;

// Thin instancing group key: "assetType_variationIndex"
type InstanceGroupKey = string;

export interface PropInstance {
  id: string;
  assetType: AssetType;
  variationIndex: number;  // Which variation mesh to use
  params: AssetParams;
  position: Vector3;
  rotation: Vector3;
  scale: Vector3;
  visible: boolean;  // For LOD-based visibility
}

export class PropManager {
  private scene: Scene;
  private heightmap: Heightmap;
  private instances: Map<string, PropInstance> = new Map();

  // Thin instancing: base variation meshes per type, per LOD level
  // Key: AssetType -> LOD level -> Mesh[]
  private variationMeshes: Map<AssetType, Map<MeshLOD, Mesh[]>> = new Map();
  // Thin instancing: shared materials per type
  private sharedMaterials: Map<AssetType, ShaderMaterial> = new Map();
  // Thin instancing: group meshes for thin instances (per LOD)
  // Key format: "assetType_variationIndex_lodLevel"
  private instanceGroups: Map<InstanceGroupKey, Mesh> = new Map();
  // Track which props belong to which group (base group without LOD suffix)
  private propsByGroup: Map<InstanceGroupKey, Set<string>> = new Map();
  // Dirty flag to rebuild instance buffers
  private dirtyGroups: Set<InstanceGroupKey> = new Set();

  // Buffer cache for partial updates (avoid reallocating Float32Array)
  private bufferCache: Map<InstanceGroupKey, Float32Array> = new Map();
  // Reusable objects to avoid GC pressure
  private readonly _tempQuaternion = new BABYLON.Quaternion();
  private readonly _tempMatrix = new Matrix();
  private readonly _tempVector3 = new Vector3();

  // Tile-based grouping for streaming
  private propsByTile: Map<string, Set<string>> = new Map();  // tileKey -> Set<propId>
  private tileSize: number = 64;  // Default tile size

  // Spatial hash for fast picking (O(1) lookup instead of O(n))
  private spatialHash: Map<string, Set<string>> = new Map();  // gridKey -> Set<propId>
  private readonly SPATIAL_GRID_SIZE = 8;  // 8x8 unit grid cells

  // Preview system
  private previewAsset: ProceduralAsset | null = null;
  private previewMesh: Mesh | null = null;
  private previewParams: AssetParams | null = null;
  private previewVisible = false;
  private previewMatrixBuffer: Float32Array | null = null;
  private previewPosition = new Vector3(0, 0, 0);
  private previewRotation = new Vector3(0, 0, 0);
  private previewScale = 1.0;

  // Async initialization state
  private initializationComplete = false;
  private initializationPromise: Promise<void> | null = null;
  private isDisposed = false;

  // Frustum culling
  private frustumPlanesCache: BABYLON.Plane[] = [];
  private lastFrustumUpdateFrame = -1;
  private referenceTemplates: Partial<Record<"tree" | "bush", Mesh>> = {};

  constructor(scene: Scene, heightmap: Heightmap) {
    this.scene = scene;
    this.heightmap = heightmap;
    // Start async initialization
    this.initializationPromise = this.initializeVariationsAsync();
  }

  /**
   * Wait for initialization to complete
   */
  async waitForInitialization(): Promise<void> {
    if (this.initializationPromise) {
      await this.initializationPromise;
    }
  }

  /**
   * Check if initialization is complete
   */
  isReady(): boolean {
    return this.initializationComplete;
  }

  private seeded01(seed: number): number {
    const n = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
    return n - Math.floor(n);
  }

  private setMeshVertexColor(mesh: Mesh, r: number, g: number, b: number): void {
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

  private bakeMeshToWorld(source: Mesh, name: string): Mesh | null {
    const positions = source.getVerticesData(VertexBuffer.PositionKind);
    const normals = source.getVerticesData(VertexBuffer.NormalKind);
    const uvs = source.getVerticesData(VertexBuffer.UVKind);
    const indices = source.getIndices();

    if (!positions || !indices) {
      return null;
    }

    source.computeWorldMatrix(true);
    const world = source.getWorldMatrix();

    const outPositions = new Float32Array(positions.length);
    for (let i = 0; i < positions.length; i += 3) {
      BABYLON.Vector3.TransformCoordinatesFromFloatsToRef(
        positions[i],
        positions[i + 1],
        positions[i + 2],
        world,
        this._tempVector3
      );
      outPositions[i] = this._tempVector3.x;
      outPositions[i + 1] = this._tempVector3.y;
      outPositions[i + 2] = this._tempVector3.z;
    }

    let outNormals: Float32Array | null = null;
    if (normals) {
      outNormals = new Float32Array(normals.length);
      for (let i = 0; i < normals.length; i += 3) {
        BABYLON.Vector3.TransformNormalFromFloatsToRef(
          normals[i],
          normals[i + 1],
          normals[i + 2],
          world,
          this._tempVector3
        );
        this._tempVector3.normalize();
        outNormals[i] = this._tempVector3.x;
        outNormals[i + 1] = this._tempVector3.y;
        outNormals[i + 2] = this._tempVector3.z;
      }
    }

    const baked = new Mesh(name, this.scene);
    const vertexData = new VertexData();
    vertexData.positions = outPositions;
    vertexData.indices = Array.from(indices);
    vertexData.uvs = uvs ? Array.from(uvs) : null;
    vertexData.normals = outNormals ? Array.from(outNormals) : null;
    if (!vertexData.normals) {
      const computedNormals: number[] = [];
      VertexData.ComputeNormals(
        Array.from(outPositions),
        Array.from(indices),
        computedNormals
      );
      vertexData.normals = computedNormals;
    }
    vertexData.applyToMesh(baked);

    return baked;
  }

  private recenterMeshToGround(mesh: Mesh): void {
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    if (!positions || positions.length < 3) return;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;

    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i];
      const y = positions[i + 1];
      const z = positions[i + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }

    const centerX = (minX + maxX) * 0.5;
    const centerZ = (minZ + maxZ) * 0.5;

    const shifted = new Float32Array(positions.length);
    for (let i = 0; i < positions.length; i += 3) {
      shifted[i] = positions[i] - centerX;
      shifted[i + 1] = positions[i + 1] - minY;
      shifted[i + 2] = positions[i + 2] - centerZ;
    }

    mesh.setVerticesData(VertexBuffer.PositionKind, shifted, true);
    mesh.refreshBoundingInfo();
  }

  private applyReferenceVariationDeformation(
    mesh: Mesh,
    seedBase: number,
    assetType: "tree" | "bush"
  ): void {
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    const indices = mesh.getIndices();
    if (!positions || !indices || positions.length < 3) {
      return;
    }

    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 1; i < positions.length; i += 3) {
      const y = positions[i];
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }

    const heightRange = Math.max(maxY - minY, 0.0001);
    const bendScale = assetType === "tree" ? 0.22 : 0.14;
    const twistScale = assetType === "tree" ? 0.75 : 0.45;
    const jitterScale = assetType === "tree" ? 0.018 : 0.012;
    const crownScale = 0.8 + this.seeded01(seedBase + 5.7) * 0.55;
    const trunkScale = 0.82 + this.seeded01(seedBase + 6.1) * 0.22;
    const bendX = (this.seeded01(seedBase + 7.3) - 0.5) * bendScale;
    const bendZ = (this.seeded01(seedBase + 8.9) - 0.5) * bendScale;
    const twistAmount = (this.seeded01(seedBase + 9.7) - 0.5) * twistScale;
    const stretch = 0.9 + this.seeded01(seedBase + 10.9) * 0.35;

    const deformed = new Float32Array(positions.length);
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i];
      const y = positions[i + 1];
      const z = positions[i + 2];

      const tRaw = (y - minY) / heightRange;
      const t = Math.max(0, Math.min(1, tRaw));
      const smoothT = t * t * (3 - 2 * t);
      const topWeight = smoothT * smoothT;

      const radiusScale = trunkScale + (crownScale - trunkScale) * smoothT;
      let px = x * radiusScale;
      let py = y * stretch;
      let pz = z * radiusScale;

      const twist = twistAmount * topWeight;
      const cosTwist = Math.cos(twist);
      const sinTwist = Math.sin(twist);
      const tx = px * cosTwist - pz * sinTwist;
      const tz = px * sinTwist + pz * cosTwist;

      px = tx + bendX * topWeight;
      pz = tz + bendZ * topWeight;

      const jitterSeed = seedBase + x * 13.37 + y * 7.11 + z * 5.73;
      const jitter = (this.seeded01(jitterSeed) - 0.5) * jitterScale * smoothT;
      px += jitter;
      pz += (this.seeded01(jitterSeed + 17.0) - 0.5) * jitterScale * smoothT;
      py += (this.seeded01(jitterSeed + 29.0) - 0.5) * jitterScale * 0.6 * smoothT;

      deformed[i] = px;
      deformed[i + 1] = py;
      deformed[i + 2] = pz;
    }

    mesh.setVerticesData(VertexBuffer.PositionKind, deformed, true);
    const normals: number[] = [];
    VertexData.ComputeNormals(Array.from(deformed), Array.from(indices), normals);
    mesh.setVerticesData(VertexBuffer.NormalKind, normals, true);
    mesh.refreshBoundingInfo();
  }

  private createReferenceVariationMesh(
    assetType: "tree" | "bush",
    lod: MeshLOD,
    variationIdx: number
  ): Mesh | null {
    const template = this.referenceTemplates[assetType];
    if (!template) return null;

    const mesh = template.clone(`${assetType}_ref_var${variationIdx}_lod${lod}`);
    if (!mesh) return null;

    mesh.makeGeometryUnique();

    const seedBase =
      variationIdx * 37.17 +
      (assetType === "tree" ? 11.7 : 29.3);
    const yaw = (this.seeded01(seedBase + 0.9) - 0.5) * 0.65;
    const sx = 0.88 + this.seeded01(seedBase + 1.7) * 0.26;
    const sy = 0.9 + this.seeded01(seedBase + 2.5) * 0.34;
    const sz = 0.88 + this.seeded01(seedBase + 3.3) * 0.26;

    const variationTransform = Matrix.Scaling(sx, sy, sz).multiply(
      Matrix.RotationY(yaw)
    );
    mesh.bakeTransformIntoVertices(variationTransform);
    this.applyReferenceVariationDeformation(mesh, seedBase, assetType);

    return mesh;
  }

  private async loadReferenceTemplatesIfAvailable(): Promise<void> {
    if (this.referenceTemplates.tree || this.referenceTemplates.bush) {
      return;
    }

    try {
      const result = await SceneLoader.ImportMeshAsync(
        "",
        REFERENCE_TREE_ROOT_URL,
        REFERENCE_TREE_FILE_NAME,
        this.scene
      );

      if (this.isDisposed) {
        for (const mesh of result.meshes) {
          mesh.dispose(false, true);
        }
        result.skeletons?.forEach((skeleton) => skeleton.dispose());
        result.animationGroups?.forEach((group) => group.dispose());
        result.particleSystems?.forEach((ps) => ps.dispose());
        result.transformNodes?.forEach((node) => node.dispose());
        return;
      }

      const importedMeshes = result.meshes.filter(
        (mesh): mesh is Mesh =>
          mesh instanceof Mesh &&
          !!mesh.getVerticesData(VertexBuffer.PositionKind) &&
          !!mesh.getIndices()
      );

      if (importedMeshes.length === 0) {
        return;
      }

      const trunkSources = importedMeshes.filter((mesh) =>
        mesh.name.toLowerCase().includes("trunk")
      );
      const bushSources = importedMeshes.filter((mesh) =>
        mesh.name.toLowerCase().startsWith("bush_")
      );

      const buildMergedTemplate = (
        includeTrunk: boolean,
        mergedName: string
      ): Mesh | null => {
        const bakedParts: Mesh[] = [];

        if (includeTrunk) {
          for (let i = 0; i < trunkSources.length; i++) {
            const baked = this.bakeMeshToWorld(trunkSources[i], `ref_trunk_${i}`);
            if (!baked) continue;
            this.setMeshVertexColor(baked, 0.44, 0.32, 0.18);
            bakedParts.push(baked);
          }
        }

        for (let i = 0; i < bushSources.length; i++) {
          const baked = this.bakeMeshToWorld(bushSources[i], `ref_bush_${i}`);
          if (!baked) continue;
          this.setMeshVertexColor(baked, 0.23, 0.48, 0.2);
          bakedParts.push(baked);
        }

        if (bakedParts.length === 0) {
          return null;
        }

        const merged = Mesh.MergeMeshes(
          bakedParts,
          true,
          true,
          undefined,
          false,
          true
        );
        if (!merged) {
          return null;
        }

        merged.name = mergedName;
        this.recenterMeshToGround(merged);
        merged.isVisible = false;
        merged.isPickable = false;
        merged.material = null;
        return merged;
      };

      const bushTemplate = buildMergedTemplate(false, "ref_bush_template");
      const treeTemplate = buildMergedTemplate(true, "ref_tree_template");

      if (bushTemplate) {
        this.referenceTemplates.bush = bushTemplate;
      }
      if (treeTemplate) {
        this.referenceTemplates.tree = treeTemplate;
      }

      for (const mesh of result.meshes) {
        mesh.dispose(false, true);
      }
      result.skeletons?.forEach((skeleton) => skeleton.dispose());
      result.animationGroups?.forEach((group) => group.dispose());
      result.particleSystems?.forEach((ps) => ps.dispose());
      result.transformNodes?.forEach((node) => node.dispose());

      if (this.referenceTemplates.tree || this.referenceTemplates.bush) {
        console.log("[PropManager] Loaded reference tree/bush templates from GLB");
      }
    } catch (error) {
      console.warn(
        "[PropManager] Reference GLB not available, using procedural tree/bush variations.",
        error
      );
    }
  }

  /**
   * Initialize base variation meshes for each asset type (async version)
   * Creates meshes for all LOD levels progressively to avoid blocking
   */
  private async initializeVariationsAsync(): Promise<void> {
    const assetTypes: AssetType[] = ["rock", "tree", "bush", "grass_clump"];
    const lodLevels: MeshLOD[] = [MeshLOD.High, MeshLOD.Medium, MeshLOD.Low];
    let meshCount = 0;
    const startTime = performance.now();

    // Create shared materials first (fast, synchronous)
    for (const assetType of assetTypes) {
      const material = this.createSharedMaterial(assetType);
      this.sharedMaterials.set(assetType, material);
    }

    // Initialize empty maps for all asset types
    for (const assetType of assetTypes) {
      this.variationMeshes.set(assetType, new Map());
    }

    await this.loadReferenceTemplatesIfAvailable();

    // Create meshes progressively using requestAnimationFrame batching
    // Process one (assetType, LOD, variation) combination per frame to avoid blocking
    const batchSize = 4;  // Process 4 meshes per frame
    let currentBatch: Array<{ assetType: AssetType; lod: MeshLOD; variationIdx: number }> = [];

    // Build the full work queue
    for (const assetType of assetTypes) {
      for (const lod of lodLevels) {
        for (let i = 0; i < VARIATIONS_PER_TYPE; i++) {
          currentBatch.push({ assetType, lod, variationIdx: i });
        }
      }
    }

    // Process batches
    const processBatch = (startIdx: number): Promise<void> => {
      return new Promise((resolve) => {
        requestAnimationFrame(() => {
          // Skip if disposed during async init (React Strict Mode, etc.)
          if (this.isDisposed) {
            resolve();
            return;
          }

          const endIdx = Math.min(startIdx + batchSize, currentBatch.length);

          for (let i = startIdx; i < endIdx; i++) {
            const { assetType, lod, variationIdx } = currentBatch[i];
            const lodMap = this.variationMeshes.get(assetType);

            // Safety check - skip if map was cleared
            if (!lodMap) {
              continue;
            }

            // Initialize LOD array if not exists
            if (!lodMap.has(lod)) {
              lodMap.set(lod, []);
            }

            const seed = variationIdx * 1001 + 8;
            const subdivision = LOD_SUBDIVISIONS[assetType][lod];
            const useReference =
              assetType === "tree" || assetType === "bush";

            let mesh: Mesh | null = null;
            if (useReference) {
              mesh = this.createReferenceVariationMesh(
                assetType as "tree" | "bush",
                lod,
                variationIdx
              );
            }

            if (!mesh) {
              const params: AssetParams = {
                ...DEFAULT_ASSET_PARAMS[assetType],
                seed,
                size: 1.0,
                subdivisionOverride: subdivision > 0 ? subdivision : undefined,
              };

              const asset = new ProceduralAsset(this.scene, params);
              mesh = asset.generate();
            }

            if (mesh) {
              mesh.name = `${assetType}_var${variationIdx}_lod${lod}`;
              mesh.isVisible = false;
              mesh.isPickable = false;
              mesh.material = null;
              lodMap.get(lod)!.push(mesh);
              meshCount++;
            }
          }

          if (endIdx < currentBatch.length) {
            processBatch(endIdx).then(resolve);
          } else {
            resolve();
          }
        });
      });
    };

    await processBatch(0);

    const elapsed = performance.now() - startTime;
    this.initializationComplete = true;
    console.log(`[PropManager] Async init complete: ${meshCount} meshes (${assetTypes.length} types × ${lodLevels.length} LODs × ${VARIATIONS_PER_TYPE} variations) in ${elapsed.toFixed(0)}ms`);
  }

  /**
   * Synchronous initialization (legacy, for backward compatibility)
   * Use initializeVariationsAsync() for non-blocking initialization
   */
  private initializeVariations(): void {
    const assetTypes: AssetType[] = ["rock", "tree", "bush", "grass_clump"];
    const lodLevels: MeshLOD[] = [MeshLOD.High, MeshLOD.Medium, MeshLOD.Low];

    for (const assetType of assetTypes) {
      const lodMap = new Map<MeshLOD, Mesh[]>();

      for (const lod of lodLevels) {
        const variations: Mesh[] = [];

        for (let i = 0; i < VARIATIONS_PER_TYPE; i++) {
          const seed = i * 1001 + 8;
          const subdivision = LOD_SUBDIVISIONS[assetType][lod];
          const useReference =
            assetType === "tree" || assetType === "bush";

          let mesh: Mesh | null = null;
          if (useReference) {
            mesh = this.createReferenceVariationMesh(
              assetType as "tree" | "bush",
              lod,
              i
            );
          }

          if (!mesh) {
            const params: AssetParams = {
              ...DEFAULT_ASSET_PARAMS[assetType],
              seed,
              size: 1.0,
              subdivisionOverride: subdivision > 0 ? subdivision : undefined,
            };

            const asset = new ProceduralAsset(this.scene, params);
            mesh = asset.generate();
          }

          if (mesh) {
            mesh.name = `${assetType}_var${i}_lod${lod}`;
            mesh.isVisible = false;
            mesh.isPickable = false;
            mesh.material = null;
            variations.push(mesh);
          }
        }

        lodMap.set(lod, variations);
      }

      this.variationMeshes.set(assetType, lodMap);
      const material = this.createSharedMaterial(assetType);
      this.sharedMaterials.set(assetType, material);
    }

    this.initializationComplete = true;
    console.log(`[PropManager] Initialized ${assetTypes.length} asset types with ${VARIATIONS_PER_TYPE} variations × 3 LOD levels each`);
  }

  /**
   * Create shared material for thin instanced props
   */
  private createSharedMaterial(assetType: AssetType): ShaderMaterial {
    const needsWind = assetType !== "rock";
    const defaultParams = DEFAULT_ASSET_PARAMS[assetType];

    let material: ShaderMaterial;

    if (needsWind) {
      // Use thin instance wind shader for foliage
      // NOTE: Do NOT include world0-world3 in attributes - Babylon.js adds them
      // automatically when using thinInstanceSetBuffer("matrix", ...)
      // Including them manually causes WebGPU validation errors (duplicate locations)
      material = new ShaderMaterial(
        `prop_thin_wind_${assetType}`,
        this.scene,
        {
          vertex: "propThinWind",
          fragment: "propThinWind",
        },
        {
          attributes: ["position", "normal", "uv", "color"],
          uniforms: [
            "viewProjection",
            "cameraPosition",
            "uTime",
            "uWindDirection",
            "uWindStrength",
            "uMinWindHeight",
            "uMaxWindHeight",
            "uPropsPrimarySpeed",
            "uPropsSecondarySpeed",
            "uPropsNoiseSpeed",
            "baseColor",
            "detailColor",
            "sunDirection",
            "ambientIntensity",
            "fogColor",
            "fogDensity",
            "dirtTextureScale",
            "uLeafAlphaCutoff",
            "uLeafFadeStart",
            "uLeafFadeEnd",
            "uUseLeafAtlas",
            "uLeafMaskFromLuma",
            "uFresnelPower",
            "uFresnelStrength",
            "uFresnelColor",
          ],
          samplers: ["dirtTexture", "leafAtlas"],
        }
      );

      // Wind settings
      const windAngle = DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.directionRadians;
      material.setVector2("uWindDirection", new BABYLON.Vector2(
        Math.cos(windAngle),
        Math.sin(windAngle)
      ));

      // Wind settings by type
      let windStrength = DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.baseStrength;
      let minWindHeight = 0.0;
      let maxWindHeight = 0.8;

      if (assetType === "grass_clump") {
        windStrength = DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.grassClumpStrength;
        minWindHeight = 0.0;
        maxWindHeight = 0.7;
      } else if (assetType === "bush") {
        windStrength = DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.bushStrength;
        minWindHeight = 0.0;
        maxWindHeight = 0.3;
      } else if (assetType === "tree") {
        windStrength = DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.treeStrength;
        minWindHeight = 0.5;
        maxWindHeight = 2.0;
      }

      material.setFloat("uWindStrength", windStrength);
      material.setFloat("uMinWindHeight", minWindHeight);
      material.setFloat("uMaxWindHeight", maxWindHeight);
      material.setFloat("uPropsPrimarySpeed", DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.propsPrimarySpeed);
      material.setFloat("uPropsSecondarySpeed", DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.propsSecondarySpeed);
      material.setFloat("uPropsNoiseSpeed", DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.propsNoiseSpeed);
      material.setFloat("uTime", 0);

      // Load dirt texture for bark triplanar mapping
      const dirtTex = loadTextureWithFallback(
        this.scene,
        DEFAULT_FOLIAGE_QUALITY_PROFILE.textures.dirt,
        {
          preferredExtensions: ["ktx2", "jpg", "png"],
          wrapU: BABYLON.Texture.WRAP_ADDRESSMODE,
          wrapV: BABYLON.Texture.WRAP_ADDRESSMODE,
          anisotropicFilteringLevel: 8,
        }
      );
      material.setTexture("dirtTexture", dirtTex);
      material.setFloat("dirtTextureScale", 0.5);

      const leafAtlas = loadTextureWithFallback(
        this.scene,
        DEFAULT_FOLIAGE_QUALITY_PROFILE.textures.leafAtlas,
        {
          preferredExtensions: ["png", "ktx2", "jpg"],
          wrapU: BABYLON.Texture.CLAMP_ADDRESSMODE,
          wrapV: BABYLON.Texture.CLAMP_ADDRESSMODE,
          anisotropicFilteringLevel: 4,
        }
      );
      material.setTexture("leafAtlas", leafAtlas);
      material.setFloat(
        "uLeafAlphaCutoff",
        DEFAULT_FOLIAGE_QUALITY_PROFILE.leafAtlas.alphaCutoff
      );
      material.setFloat(
        "uLeafFadeStart",
        DEFAULT_FOLIAGE_QUALITY_PROFILE.fade.leafFadeStart
      );
      material.setFloat(
        "uLeafFadeEnd",
        DEFAULT_FOLIAGE_QUALITY_PROFILE.fade.leafFadeEnd
      );
      material.setFloat(
        "uUseLeafAtlas",
        assetType === "tree" || assetType === "bush" ? 1.0 : 0.0
      );
      material.setFloat("uLeafMaskFromLuma", 1.0);

      // Fresnel rim light settings
      material.setFloat("uFresnelPower", 3.0);
      material.setFloat("uFresnelStrength", 0.4);
      material.setColor3("uFresnelColor", new Color3(0.8, 0.95, 0.7));
    } else {
      // Rock uses thin instance static shader with triplanar texture
      // NOTE: Do NOT include world0-world3 in attributes - Babylon.js adds them
      // automatically when using thinInstanceSetBuffer("matrix", ...)
      material = new ShaderMaterial(
        `prop_thin_${assetType}`,
        this.scene,
        {
          vertex: "propThin",
          fragment: "propThin",
        },
        {
          attributes: ["position", "normal", "uv"],
          uniforms: [
            "viewProjection",
            "cameraPosition",
            "baseColor",
            "detailColor",
            "sunDirection",
            "ambientIntensity",
            "fogColor",
            "fogDensity",
            "textureScale",
          ],
          samplers: ["rockTexture"],
        }
      );

      // Load rock diffuse texture for triplanar mapping
      const rockTex = loadTextureWithFallback(
        this.scene,
        DEFAULT_FOLIAGE_QUALITY_PROFILE.textures.rock,
        {
          preferredExtensions: ["ktx2", "jpg", "png"],
          wrapU: BABYLON.Texture.WRAP_ADDRESSMODE,
          wrapV: BABYLON.Texture.WRAP_ADDRESSMODE,
          anisotropicFilteringLevel: 8,
        }
      );
      material.setTexture("rockTexture", rockTex);
      material.setFloat("textureScale", 1.0);
    }

    // Common uniforms
    material.setColor3("baseColor", defaultParams.colorBase);
    material.setColor3("detailColor", defaultParams.colorDetail);
    material.setVector3("sunDirection", new Vector3(0.5, 0.8, 0.3).normalize());
    material.setFloat("ambientIntensity", 0.4);
    material.setColor3("fogColor", new Color3(0.6, 0.75, 0.9));
    material.setFloat("fogDensity", 0.008);
    material.backFaceCulling = false;

    // Update camera position and time on each render
    const startTime = performance.now();
    material.onBindObservable.add(() => {
      const camera = this.scene.activeCamera;
      if (camera) {
        material.setVector3("cameraPosition", camera.position);
        if (needsWind) {
          const elapsed = (performance.now() - startTime) / 1000;
          material.setFloat("uTime", elapsed);
        }
      }
    });

    return material;
  }

  /**
   * Get variation index from seed
   */
  private getVariationIndex(seed: number): number {
    return Math.floor(Math.abs(seed)) % VARIATIONS_PER_TYPE;
  }

  /**
   * Get base instance group key (without LOD)
   */
  private getGroupKey(assetType: AssetType, variationIndex: number): InstanceGroupKey {
    return `${assetType}|${variationIndex}`;
  }

  /**
   * Get instance group key with LOD level
   */
  private getGroupKeyWithLOD(assetType: AssetType, variationIndex: number, lod: MeshLOD): InstanceGroupKey {
    return `${assetType}|${variationIndex}|${lod}`;
  }

  /**
   * Parse group key with LOD
   */
  private parseGroupKeyWithLOD(groupKey: InstanceGroupKey): { assetType: AssetType; variationIndex: number; lod: MeshLOD } | null {
    const parts = groupKey.split("|");
    if (parts.length < 3) return null;
    return {
      assetType: parts[0] as AssetType,
      variationIndex: parseInt(parts[1], 10),
      lod: parseInt(parts[2], 10) as MeshLOD,
    };
  }

  /**
   * Determine LOD level based on distance from camera
   */
  private getLODForDistance(distance: number): MeshLOD {
    if (distance < LOD_DISTANCES.highToMedium) {
      return MeshLOD.High;
    } else if (distance < LOD_DISTANCES.mediumToLow) {
      return MeshLOD.Medium;
    } else {
      return MeshLOD.Low;
    }
  }

  /**
   * Update frustum planes cache (call once per frame before rebuilding)
   */
  private updateFrustumPlanes(): void {
    const frameNumber = this.scene.getFrameId();
    if (this.lastFrustumUpdateFrame === frameNumber) return;

    const camera = this.scene.activeCamera;
    if (!camera) return;

    // Get view-projection matrix
    const viewMatrix = camera.getViewMatrix();
    const projMatrix = camera.getProjectionMatrix();
    const vpMatrix = viewMatrix.multiply(projMatrix);

    // Extract frustum planes
    this.frustumPlanesCache = Frustum.GetPlanes(vpMatrix);
    this.lastFrustumUpdateFrame = frameNumber;
  }

  /**
   * Check if a point is inside the camera frustum
   */
  private isInFrustum(position: Vector3, radius: number = 1): boolean {
    if (this.frustumPlanesCache.length === 0) return true;

    // Simple sphere-frustum test
    for (const plane of this.frustumPlanesCache) {
      const distance = plane.dotCoordinate(position);
      if (distance < -radius) {
        return false;  // Outside this plane
      }
    }
    return true;
  }

  /**
   * Set tile size for streaming grouping
   */
  setTileSize(tileSize: number): void {
    this.tileSize = tileSize;
  }

  /**
   * Get tile key for a world position
   */
  private getTileKey(x: number, z: number): string {
    const gridX = Math.floor(x / this.tileSize);
    const gridZ = Math.floor(z / this.tileSize);
    return `${gridX}_${gridZ}`;
  }

  /**
   * Register prop to tile group
   */
  private registerPropToTile(propId: string, x: number, z: number): void {
    const tileKey = this.getTileKey(x, z);
    let tileProps = this.propsByTile.get(tileKey);
    if (!tileProps) {
      tileProps = new Set();
      this.propsByTile.set(tileKey, tileProps);
    }
    tileProps.add(propId);
  }

  /**
   * Unregister prop from tile group
   */
  private unregisterPropFromTile(propId: string): void {
    const instance = this.instances.get(propId);
    if (!instance) return;
    const tileKey = this.getTileKey(instance.position.x, instance.position.z);
    const tileProps = this.propsByTile.get(tileKey);
    if (tileProps) {
      tileProps.delete(propId);
      if (tileProps.size === 0) {
        this.propsByTile.delete(tileKey);
      }
    }
  }

  /**
   * Get spatial hash grid key for a position
   */
  private getSpatialKey(x: number, z: number): string {
    const gx = Math.floor(x / this.SPATIAL_GRID_SIZE);
    const gz = Math.floor(z / this.SPATIAL_GRID_SIZE);
    return `${gx}_${gz}`;
  }

  /**
   * Register prop to spatial hash
   */
  private registerPropToSpatialHash(propId: string, x: number, z: number): void {
    const key = this.getSpatialKey(x, z);
    let cell = this.spatialHash.get(key);
    if (!cell) {
      cell = new Set();
      this.spatialHash.set(key, cell);
    }
    cell.add(propId);
  }

  /**
   * Unregister prop from spatial hash
   */
  private unregisterPropFromSpatialHash(propId: string): void {
    const instance = this.instances.get(propId);
    if (!instance) return;
    const key = this.getSpatialKey(instance.position.x, instance.position.z);
    const cell = this.spatialHash.get(key);
    if (cell) {
      cell.delete(propId);
      if (cell.size === 0) {
        this.spatialHash.delete(key);
      }
    }
  }

  /**
   * Unload all props for a specific tile (for streaming)
   */
  unloadPropsForTile(gridX: number, gridY: number): void {
    const tileKey = `${gridX}_${gridY}`;
    const tileProps = this.propsByTile.get(tileKey);
    if (!tileProps) return;

    const dirtyGroupsSet = new Set<InstanceGroupKey>();

    // Remove all props in this tile
    for (const propId of tileProps) {
      const instance = this.instances.get(propId);
      if (instance) {
        // Unregister from instance group
        const groupKey = this.getGroupKey(instance.assetType, instance.variationIndex);
        const groupProps = this.propsByGroup.get(groupKey);
        if (groupProps) {
          groupProps.delete(propId);
          dirtyGroupsSet.add(groupKey);
        }
        this.instances.delete(propId);
      }
    }
    this.propsByTile.delete(tileKey);

    // Mark affected groups dirty and rebuild
    for (const groupKey of dirtyGroupsSet) {
      this.markGroupDirty(groupKey);
    }
    this.rebuildDirtyGroups();

    console.log(`[PropManager] Unloaded ${tileProps.size} props for tile (${gridX},${gridY})`);
  }

  /**
   * Get props for a specific tile
   */
  getPropsForTile(gridX: number, gridY: number): PropInstance[] {
    const tileKey = `${gridX}_${gridY}`;
    const tileProps = this.propsByTile.get(tileKey);
    if (!tileProps) return [];

    const result: PropInstance[] = [];
    for (const propId of tileProps) {
      const instance = this.instances.get(propId);
      if (instance) {
        result.push(instance);
      }
    }
    return result;
  }

  /**
   * Update LOD for props in a specific tile
   * Near: all props visible, Mid: medium/large only, Far: large only
   */
  updateTileLOD(gridX: number, gridY: number, lod: PropLOD): void {
    const tileKey = `${gridX}_${gridY}`;
    const tileProps = this.propsByTile.get(tileKey);
    if (!tileProps) return;

    let visibleCount = 0;
    let hiddenCount = 0;
    const affectedGroups = new Set<InstanceGroupKey>();

    for (const propId of tileProps) {
      const instance = this.instances.get(propId);
      if (!instance) continue;

      const size = instance.params.size;
      const shouldBeVisible = this.shouldPropBeVisible(size, lod);

      if (instance.visible !== shouldBeVisible) {
        instance.visible = shouldBeVisible;
        const groupKey = this.getGroupKey(instance.assetType, instance.variationIndex);
        affectedGroups.add(groupKey);

        if (shouldBeVisible) {
          visibleCount++;
        } else {
          hiddenCount++;
        }
      }
    }

    // Mark affected groups dirty and rebuild
    for (const groupKey of affectedGroups) {
      this.markGroupDirty(groupKey);
    }
    this.rebuildDirtyGroups();

    if (visibleCount > 0 || hiddenCount > 0) {
      console.log(`[PropManager] Tile (${gridX},${gridY}) LOD=${PropLOD[lod]}: ${visibleCount} visible, ${hiddenCount} hidden`);
    }
  }

  /**
   * Determine if a prop should be visible based on size and LOD
   */
  private shouldPropBeVisible(size: number, lod: PropLOD): boolean {
    switch (lod) {
      case PropLOD.Near:
        return true;  // All props visible
      case PropLOD.Mid:
        return size >= 0.5;  // Medium/large props only (size >= 0.5)
      case PropLOD.Far:
        return size >= 1.0;  // Large props only (landmarks, size >= 1.0)
      default:
        return true;
    }
  }

  /**
   * Get loaded tile keys
   */
  getLoadedTileKeys(): string[] {
    return Array.from(this.propsByTile.keys());
  }

  /**
   * Mark a group as dirty (needs rebuild)
   */
  private markGroupDirty(groupKey: InstanceGroupKey): void {
    this.dirtyGroups.add(groupKey);
  }

  /**
   * Rebuild all dirty instance groups with LOD support
   */
  rebuildDirtyGroups(): void {
    if (!this.initializationComplete) return;

    // Update frustum planes for culling
    this.updateFrustumPlanes();

    for (const groupKey of this.dirtyGroups) {
      this.rebuildInstanceGroupWithLOD(groupKey);
    }
    this.dirtyGroups.clear();
  }

  /**
   * Re-sample Y positions from heightmap for all prop instances.
   * Call this after terrain height changes to keep props grounded.
   */
  updateAllHeights(): void {
    for (const [, instance] of this.instances) {
      const newY = this.heightmap.getInterpolatedHeight(instance.position.x, instance.position.z);
      if (instance.position.y !== newY) {
        instance.position.y = newY;
        const groupKey = `${instance.assetType}|${instance.variationIndex}`;
        this.markGroupDirty(groupKey);
      }
    }
  }

  /**
   * Rebuild a single instance group with LOD and frustum culling support
   */
  private rebuildInstanceGroupWithLOD(baseGroupKey: InstanceGroupKey): void {
    const propIds = this.propsByGroup.get(baseGroupKey);
    const [assetType, variationIndexStr] = baseGroupKey.split("|") as [AssetType, string];
    const variationIndex = parseInt(variationIndexStr, 10);

    // Get variation meshes for all LOD levels
    const lodMeshMap = this.variationMeshes.get(assetType);
    if (!lodMeshMap) return;

    // Get camera position for LOD calculation
    const camera = this.scene.activeCamera;
    const cameraPos = camera ? camera.position : Vector3.Zero();

    // Categorize instances by LOD level
    const lodMatrices: Map<MeshLOD, Float32Array> = new Map();
    const lodCounts: Map<MeshLOD, number> = new Map();

    // Initialize LOD buffers
    const lodLevels: MeshLOD[] = [MeshLOD.High, MeshLOD.Medium, MeshLOD.Low];
    for (const lod of lodLevels) {
      lodCounts.set(lod, 0);
    }

    if (!propIds || propIds.size === 0) {
      // No props - hide all LOD meshes for this group
      for (const lod of lodLevels) {
        const lodGroupKey = this.getGroupKeyWithLOD(assetType, variationIndex, lod);
        const groupMesh = this.instanceGroups.get(lodGroupKey);
        if (groupMesh) {
          groupMesh.isVisible = false;
          groupMesh.thinInstanceCount = 0;
        }
      }
      return;
    }

    // First pass: count instances per LOD (with frustum culling)
    for (const propId of propIds) {
      const instance = this.instances.get(propId);
      if (!instance || !instance.visible) continue;

      // Frustum culling check
      const radius = Math.max(instance.scale.x, instance.scale.y, instance.scale.z) * 2;
      if (!this.isInFrustum(instance.position, radius)) {
        continue;  // Skip instances outside frustum
      }

      // Calculate distance to camera
      const dx = instance.position.x - cameraPos.x;
      const dy = instance.position.y - cameraPos.y;
      const dz = instance.position.z - cameraPos.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

      // Determine LOD
      const lod = this.getLODForDistance(distance);
      lodCounts.set(lod, (lodCounts.get(lod) || 0) + 1);
    }

    // Allocate buffers for each LOD
    for (const lod of lodLevels) {
      const count = lodCounts.get(lod) || 0;
      if (count > 0) {
        const bufferKey = this.getGroupKeyWithLOD(assetType, variationIndex, lod);
        let buffer = this.bufferCache.get(bufferKey);
        const requiredSize = count * 16;
        if (!buffer || buffer.length < requiredSize) {
          buffer = new Float32Array(Math.ceil(requiredSize * 1.5));
          this.bufferCache.set(bufferKey, buffer);
        }
        lodMatrices.set(lod, buffer);
      }
    }

    // Second pass: fill matrices
    const lodIndices = new Map<MeshLOD, number>();
    for (const lod of lodLevels) {
      lodIndices.set(lod, 0);
    }

    for (const propId of propIds) {
      const instance = this.instances.get(propId);
      if (!instance || !instance.visible) continue;

      // Frustum culling check (same as first pass)
      const radius = Math.max(instance.scale.x, instance.scale.y, instance.scale.z) * 2;
      if (!this.isInFrustum(instance.position, radius)) {
        continue;
      }

      // Calculate distance and LOD
      const dx = instance.position.x - cameraPos.x;
      const dy = instance.position.y - cameraPos.y;
      const dz = instance.position.z - cameraPos.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const lod = this.getLODForDistance(distance);

      const matrices = lodMatrices.get(lod);
      if (!matrices) continue;

      // Build transform matrix
      BABYLON.Quaternion.FromEulerAnglesToRef(
        instance.rotation.x,
        instance.rotation.y,
        instance.rotation.z,
        this._tempQuaternion
      );
      Matrix.ComposeToRef(
        instance.scale,
        this._tempQuaternion,
        instance.position,
        this._tempMatrix
      );

      const index = lodIndices.get(lod) || 0;
      this._tempMatrix.copyToArray(matrices, index * 16);
      lodIndices.set(lod, index + 1);
    }

    // Apply matrices to each LOD mesh
    for (const lod of lodLevels) {
      const lodGroupKey = this.getGroupKeyWithLOD(assetType, variationIndex, lod);
      const count = lodIndices.get(lod) || 0;

      if (count === 0) {
        // Hide this LOD mesh
        const groupMesh = this.instanceGroups.get(lodGroupKey);
        if (groupMesh) {
          groupMesh.isVisible = false;
          groupMesh.thinInstanceCount = 0;
        }
        continue;
      }

      // Get or create LOD group mesh
      let groupMesh = this.instanceGroups.get(lodGroupKey);
      if (!groupMesh) {
        const lodMeshes = lodMeshMap.get(lod);
        if (!lodMeshes || !lodMeshes[variationIndex]) continue;

        const baseMesh = lodMeshes[variationIndex];
        groupMesh = baseMesh.clone(`inst_${lodGroupKey}`, null);
        if (!groupMesh) continue;

        // Keep shared geometry for instance-group meshes.
        // Some imported GLB geometries use accessor layouts that can throw in makeGeometryUnique()
        // ("Last accessed byte is out of bounds"), and we do not mutate vertex data here anyway.
        groupMesh.isPickable = true;

        const material = this.sharedMaterials.get(assetType);
        if (material) {
          groupMesh.material = material;
        }

        this.instanceGroups.set(lodGroupKey, groupMesh);
      }

      // Apply thin instances
      const matrices = lodMatrices.get(lod)!;
      groupMesh.thinInstanceSetBuffer("matrix", matrices, 16, false);
      groupMesh.thinInstanceCount = count;
      groupMesh.thinInstanceRefreshBoundingInfo();
      groupMesh.isVisible = true;
    }
  }

  /**
   * Legacy rebuild method (for backward compatibility)
   */
  private rebuildInstanceGroup(groupKey: InstanceGroupKey): void {
    this.rebuildInstanceGroupWithLOD(groupKey);
  }

  /**
   * Get mesh at a world position (for picking)
   * Uses spatial hash for O(1) lookup instead of O(n) linear search
   */
  getInstanceAtPosition(worldX: number, worldZ: number, tolerance: number = 0.5): PropInstance | null {
    let closest: PropInstance | null = null;
    let closestDistSq = tolerance * tolerance;

    // Calculate grid cell range to search based on tolerance
    const gridRadius = Math.ceil(tolerance / this.SPATIAL_GRID_SIZE) + 1;
    const centerGx = Math.floor(worldX / this.SPATIAL_GRID_SIZE);
    const centerGz = Math.floor(worldZ / this.SPATIAL_GRID_SIZE);

    // Search only nearby grid cells
    for (let dx = -gridRadius; dx <= gridRadius; dx++) {
      for (let dz = -gridRadius; dz <= gridRadius; dz++) {
        const key = `${centerGx + dx}_${centerGz + dz}`;
        const cell = this.spatialHash.get(key);
        if (!cell) continue;

        for (const propId of cell) {
          const instance = this.instances.get(propId);
          if (!instance) continue;

          const px = instance.position.x - worldX;
          const pz = instance.position.z - worldZ;
          const distSq = px * px + pz * pz;

          if (distSq < closestDistSq) {
            closestDistSq = distSq;
            closest = instance;
          }
        }
      }
    }

    return closest;
  }

  /**
   * Convert any seed to a variation seed that matches pre-generated variation meshes.
   * Variation meshes are generated with seeds: 8, 1009, 2010, 3011, 4012, 5013, 6014, 7015
   * Formula: i * 1001 + 8 ensures seed % 8 = i (since 1001 % 8 = 1)
   * This ensures preview matches the installed mesh.
   */
  private toVariationSeed(seed: number): number {
    const variationIndex = this.getVariationIndex(seed);
    return variationIndex * 1001 + 8;
  }

  private disposePreviewResources(): void {
    if (this.previewAsset) {
      this.previewAsset.dispose();
      this.previewAsset = null;
      this.previewMesh = null;
    } else if (this.previewMesh) {
      this.previewMesh.dispose();
      this.previewMesh = null;
    }
    this.previewMatrixBuffer = null;
  }

  private updateThinPreviewTransform(): void {
    if (!this.previewMesh || !this.previewMatrixBuffer) return;

    this._tempVector3.set(this.previewScale, this.previewScale, this.previewScale);
    BABYLON.Quaternion.FromEulerAnglesToRef(
      this.previewRotation.x,
      this.previewRotation.y,
      this.previewRotation.z,
      this._tempQuaternion
    );
    Matrix.ComposeToRef(
      this._tempVector3,
      this._tempQuaternion,
      this.previewPosition,
      this._tempMatrix
    );
    this._tempMatrix.copyToArray(this.previewMatrixBuffer, 0);
    this.previewMesh.thinInstanceSetBuffer("matrix", this.previewMatrixBuffer, 16, false);
    this.previewMesh.thinInstanceCount = 1;
    this.previewMesh.thinInstanceRefreshBoundingInfo();
  }

  private createThinPreviewFromVariation(type: AssetType, variationIndex: number): boolean {
    const lodMap = this.variationMeshes.get(type);
    const sourceMesh = lodMap?.get(MeshLOD.High)?.[variationIndex];
    if (!sourceMesh) {
      return false;
    }

    const previewMesh = sourceMesh.clone("preview_asset", null);
    if (!previewMesh) {
      return false;
    }

    previewMesh.isPickable = false;
    previewMesh.material = this.sharedMaterials.get(type) ?? null;
    previewMesh.isVisible = this.previewVisible;

    this.previewMesh = previewMesh;
    this.previewMatrixBuffer = new Float32Array(16);
    this.updateThinPreviewTransform();
    return true;
  }

  // Create or update the preview with given params
  createPreview(type: AssetType, size: number, seed?: number): void {
    this.disposePreviewResources();

    // Convert seed to variation seed pattern to match pre-generated variation meshes
    const rawSeed = seed ?? Math.random() * 10000;
    const variationSeed = this.toVariationSeed(rawSeed);
    const variationIndex = this.getVariationIndex(variationSeed);

    // Create new preview params
    this.previewParams = {
      ...DEFAULT_ASSET_PARAMS[type],
      type,
      size,
      seed: variationSeed,
    };

    this.previewScale = size;
    this.previewRotation.set(0, 0, 0);

    const createdThinPreview = this.createThinPreviewFromVariation(type, variationIndex);
    if (!createdThinPreview) {
      // Fallback path when async variation meshes are not ready yet.
      this.previewAsset = new ProceduralAsset(this.scene, this.previewParams);
      this.previewMesh = this.previewAsset.generate();
      if (this.previewMesh) {
        this.previewMesh.position.copyFrom(this.previewPosition);
      }
    }

    if (this.previewMesh) {
      this.previewMesh.name = "preview_asset";
      this.previewMesh.isPickable = false;
      this.previewMesh.isVisible = this.previewVisible;
    }
  }

  // Randomize the preview (new seed)
  randomizePreview(): number {
    if (!this.previewParams) return 0;

    // Pick random variation index and convert to variation seed
    const randomVariationIndex = Math.floor(Math.random() * VARIATIONS_PER_TYPE);
    const newSeed = randomVariationIndex * 1001 + 8;
    this.createPreview(this.previewParams.type, this.previewParams.size, newSeed);
    return newSeed;
  }

  // Update preview size (preserves position)
  updatePreviewSize(size: number): void {
    if (!this.previewParams || !this.previewMesh) return;

    const previousSize = this.previewParams.size;
    this.previewScale = size;
    this.previewParams.size = size;
    if (this.previewMatrixBuffer) {
      this.updateThinPreviewTransform();
      return;
    }

    // Fallback procedural preview path
    const scaleFactor = size / Math.max(0.0001, previousSize);
    this.previewMesh.scaling.scaleInPlace(scaleFactor);
  }

  // Update preview with full asset params (from AI chat panel)
  updatePreviewAsset(params: {
    type: AssetType;
    seed: number;
    size: number;
    sizeVariation: number;
    noiseScale: number;
    noiseAmplitude: number;
    colorBase: Color3;
    colorDetail: Color3;
  }): void {
    this.disposePreviewResources();

    // Create new preview params with full customization
    this.previewParams = {
      type: params.type,
      seed: params.seed,
      size: params.size,
      sizeVariation: params.sizeVariation,
      noiseScale: params.noiseScale,
      noiseAmplitude: params.noiseAmplitude,
      colorBase: params.colorBase,
      colorDetail: params.colorDetail,
    };
    this.previewScale = params.size;
    this.previewRotation.set(0, 0, 0);

    // Generate preview asset
    this.previewAsset = new ProceduralAsset(this.scene, this.previewParams);
    this.previewMesh = this.previewAsset.generate();

    if (this.previewMesh) {
      this.previewMesh.name = "preview_asset";
      this.previewMesh.isPickable = false;

      // Make semi-transparent
      if (this.previewMesh.material) {
        const mat = this.previewMesh.material as BABYLON.ShaderMaterial;
        mat.alpha = 0.8;
      }

      // Position at center of terrain initially
      const scale = this.heightmap.getScale();
      const centerX = scale / 2;
      const centerZ = scale / 2;
      const centerY = this.heightmap.getInterpolatedHeight(centerX, centerZ);
      this.previewPosition.set(centerX, centerY, centerZ);
      this.previewMesh.position.set(centerX, centerY, centerZ);

      this.previewMesh.isVisible = true;
      this.previewVisible = true;
    }
  }

  // Update preview position (called on mouse move)
  updatePreviewPosition(x: number, z: number): void {
    if (!this.previewMesh) return;

    const y = this.heightmap.getInterpolatedHeight(x, z);
    this.previewPosition.set(x, y, z);
    if (this.previewMatrixBuffer) {
      this.updateThinPreviewTransform();
      return;
    }
    this.previewMesh.position.set(x, y, z);
  }

  // Show/hide preview
  setPreviewVisible(visible: boolean): void {
    this.previewVisible = visible;
    if (this.previewMesh) {
      this.previewMesh.isVisible = visible;
    }
  }

  // Get current preview params
  getPreviewParams(): AssetParams | null {
    return this.previewParams ? { ...this.previewParams } : null;
  }

  // Place the current preview as a permanent prop
  // Returns { id, newSeed } so caller can update store
  placeCurrentPreview(): { id: string; newSeed: number } | null {
    if (!this.previewMesh || !this.previewParams) {
      return null;
    }

    const x = this.previewMatrixBuffer ? this.previewPosition.x : this.previewMesh.position.x;
    const z = this.previewMatrixBuffer ? this.previewPosition.z : this.previewMesh.position.z;
    const y = this.heightmap.getInterpolatedHeight(x, z);

    const id = `prop_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Store params BEFORE randomizing
    const params = { ...this.previewParams };
    const variationIndex = this.getVariationIndex(params.seed);
    const groupKey = this.getGroupKey(params.type, variationIndex);

    // Store instance (no mesh - managed by thin instancing)
    const instance: PropInstance = {
      id,
      assetType: params.type,
      variationIndex,
      params,
      position: new Vector3(x, y, z),
      rotation: this.previewMatrixBuffer
        ? this.previewRotation.clone()
        : this.previewMesh.rotation.clone(),
      scale: new Vector3(this.previewScale, this.previewScale, this.previewScale),
      visible: true,
    };

    this.instances.set(id, instance);

    // Register to group for thin instancing
    let groupProps = this.propsByGroup.get(groupKey);
    if (!groupProps) {
      groupProps = new Set();
      this.propsByGroup.set(groupKey, groupProps);
    }
    groupProps.add(id);

    // Register to tile group for streaming
    this.registerPropToTile(id, x, z);
    // Register to spatial hash for fast picking
    this.registerPropToSpatialHash(id, x, z);

    // Mark group dirty and rebuild
    this.markGroupDirty(groupKey);
    this.rebuildDirtyGroups();

    // Create new preview with different seed for next placement
    const newSeed = this.randomizePreview();

    return { id, newSeed };
  }

  // Place a prop at the specified position
  placeProp(
    assetType: string,
    x: number,
    z: number,
    customSettings?: { size?: number; seed?: number }
  ): string | null {
    const type = assetType as AssetType;
    if (!DEFAULT_ASSET_PARAMS[type]) return null;

    // If we have a preview, use its params
    if (this.previewParams && this.previewParams.type === type) {
      this.updatePreviewPosition(x, z);
      const result = this.placeCurrentPreview();
      return result ? result.id : null;
    }

    // Otherwise create new
    const y = this.heightmap.getInterpolatedHeight(x, z);
    const id = `prop_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const seed = customSettings?.seed ?? Math.random() * 10000;
    const size = customSettings?.size ?? DEFAULT_ASSET_PARAMS[type].size;
    const variationIndex = this.getVariationIndex(seed);
    const groupKey = this.getGroupKey(type, variationIndex);

    const params: AssetParams = {
      ...DEFAULT_ASSET_PARAMS[type],
      type,
      seed,
      size,
    };

    const rotationY = Math.random() * Math.PI * 2;

    const instance: PropInstance = {
      id,
      assetType: type,
      variationIndex,
      params,
      position: new Vector3(x, y, z),
      rotation: new Vector3(0, rotationY, 0),
      scale: new Vector3(size, size, size),
      visible: true,
    };

    this.instances.set(id, instance);

    // Register to group for thin instancing
    let groupProps = this.propsByGroup.get(groupKey);
    if (!groupProps) {
      groupProps = new Set();
      this.propsByGroup.set(groupKey, groupProps);
    }
    groupProps.add(id);

    // Register to tile group for streaming
    this.registerPropToTile(id, x, z);
    // Register to spatial hash for fast picking
    this.registerPropToSpatialHash(id, x, z);

    // Mark group dirty and rebuild
    this.markGroupDirty(groupKey);
    this.rebuildDirtyGroups();

    return id;
  }

  // Remove a prop by ID
  removeProp(id: string): boolean {
    const instance = this.instances.get(id);
    if (!instance) return false;

    // Unregister from tile group
    this.unregisterPropFromTile(id);
    // Unregister from spatial hash
    this.unregisterPropFromSpatialHash(id);

    // Unregister from instance group
    const groupKey = this.getGroupKey(instance.assetType, instance.variationIndex);
    const groupProps = this.propsByGroup.get(groupKey);
    if (groupProps) {
      groupProps.delete(id);
    }

    this.instances.delete(id);

    // Mark group dirty and rebuild
    this.markGroupDirty(groupKey);
    this.rebuildDirtyGroups();

    return true;
  }

  // Get all instances
  getAllInstances(): PropInstance[] {
    return Array.from(this.instances.values());
  }

  // Get instance by ID
  getInstance(id: string): PropInstance | undefined {
    return this.instances.get(id);
  }

  // Clear all props
  clearAll(): void {
    this.instances.clear();
    this.propsByTile.clear();
    this.propsByGroup.clear();
    this.dirtyGroups.clear();
    this.bufferCache.clear();  // Clear buffer cache
    this.spatialHash.clear();  // Clear spatial hash

    // Hide all instance group meshes
    for (const groupMesh of this.instanceGroups.values()) {
      groupMesh.isVisible = false;
      groupMesh.thinInstanceCount = 0;
    }
  }

  // Export instances for saving
  exportInstances(): any[] {
    return Array.from(this.instances.values()).map((inst) => ({
      id: inst.id,
      assetType: inst.assetType,
      params: {
        type: inst.params.type,
        seed: inst.params.seed,
        size: inst.params.size,
        sizeVariation: inst.params.sizeVariation,
        noiseScale: inst.params.noiseScale,
        noiseAmplitude: inst.params.noiseAmplitude,
        colorBase: {
          r: inst.params.colorBase.r,
          g: inst.params.colorBase.g,
          b: inst.params.colorBase.b,
        },
        colorDetail: {
          r: inst.params.colorDetail.r,
          g: inst.params.colorDetail.g,
          b: inst.params.colorDetail.b,
        },
      },
      position: { x: inst.position.x, y: inst.position.y, z: inst.position.z },
      rotation: { x: inst.rotation.x, y: inst.rotation.y, z: inst.rotation.z },
      scale: { x: inst.scale.x, y: inst.scale.y, z: inst.scale.z },
    }));
  }

  // Import instances from saved data
  importInstances(data: any[]): void {
    // Clear existing
    this.clearAll();

    const affectedGroups = new Set<InstanceGroupKey>();

    for (const item of data) {
      const params: AssetParams = {
        type: item.params.type,
        seed: item.params.seed,
        size: item.params.size,
        sizeVariation: item.params.sizeVariation,
        noiseScale: item.params.noiseScale,
        noiseAmplitude: item.params.noiseAmplitude,
        colorBase: new Color3(
          item.params.colorBase.r,
          item.params.colorBase.g,
          item.params.colorBase.b
        ),
        colorDetail: new Color3(
          item.params.colorDetail.r,
          item.params.colorDetail.g,
          item.params.colorDetail.b
        ),
      };

      const variationIndex = this.getVariationIndex(params.seed);
      const groupKey = this.getGroupKey(params.type, variationIndex);

      const instance: PropInstance = {
        id: item.id,
        assetType: item.assetType,
        variationIndex,
        params,
        position: new Vector3(item.position.x, item.position.y, item.position.z),
        rotation: new Vector3(item.rotation.x, item.rotation.y, item.rotation.z),
        scale: new Vector3(item.scale.x, item.scale.y, item.scale.z),
        visible: true,
      };

      this.instances.set(item.id, instance);

      // Register to group
      let groupProps = this.propsByGroup.get(groupKey);
      if (!groupProps) {
        groupProps = new Set();
        this.propsByGroup.set(groupKey, groupProps);
      }
      groupProps.add(item.id);
      affectedGroups.add(groupKey);

      // Register to tile
      this.registerPropToTile(item.id, item.position.x, item.position.z);
      // Register to spatial hash
      this.registerPropToSpatialHash(item.id, item.position.x, item.position.z);
    }

    // Rebuild all affected groups at once
    for (const groupKey of affectedGroups) {
      this.markGroupDirty(groupKey);
    }
    this.rebuildDirtyGroups();

    console.log(`[PropManager] Imported ${data.length} props using thin instancing`);
  }

  dispose(): void {
    this.isDisposed = true;  // Prevent pending async callbacks from running
    this.clearAll();

    // Dispose preview resources
    this.disposePreviewResources();

    // Dispose instance group meshes
    for (const groupMesh of this.instanceGroups.values()) {
      groupMesh.dispose();
    }
    this.instanceGroups.clear();

    // Dispose variation meshes (now Map<AssetType, Map<MeshLOD, Mesh[]>>)
    for (const lodMap of this.variationMeshes.values()) {
      for (const meshes of lodMap.values()) {
        for (const mesh of meshes) {
          mesh.dispose();
        }
      }
    }
    this.variationMeshes.clear();

    // Dispose shared materials
    for (const material of this.sharedMaterials.values()) {
      material.dispose();
    }
    this.sharedMaterials.clear();

    if (this.referenceTemplates.tree) {
      this.referenceTemplates.tree.dispose();
    }
    if (this.referenceTemplates.bush) {
      this.referenceTemplates.bush.dispose();
    }
    this.referenceTemplates = {};
  }
}
