import * as THREE from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Heightmap } from "../terrain/Heightmap";
import { ProceduralAsset, AssetParams, AssetType, DEFAULT_ASSET_PARAMS } from "./ProceduralAsset";
import { loadTextureWithFallbackSync } from "../../shared/rendering/TextureLoader.three";
import { DEFAULT_FOLIAGE_QUALITY_PROFILE } from "../../shared/foliage/FoliageQualityProfile";
import type { LightManager } from "../lighting/LightManager";
// ============================================
// LOD Configuration
// ============================================
export enum MeshLOD {
  High = 0,   // Near distance, full detail
  Medium = 1, // Medium distance, reduced detail
  Low = 2,    // Far distance, minimal detail
}

// Subdivision levels for each LOD tier
// IcoSphere triangles: 20 * 4^subdivisions (1=80, 2=320, 3=1280, 4=5120)
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

const REFERENCE_TREE_URL = "/assets/references/infinite-terrain/tree.glb";

// ============================================
// Instanced mesh shaders for props
// Uses Three.js built-in instanceMatrix (no manual world0-world3)
// ============================================
const propThinVertexShader = `
precision highp float;

#include <common>
#include <shadowmap_pars_vertex>

varying vec3 vNormal;
varying vec3 vPosition;
varying vec3 vLocalPosition;
varying vec2 vUV;
varying float vCameraDistance;
varying vec3 vViewDirection;

void main() {
    vec4 worldPos = modelMatrix * instanceMatrix * vec4(position, 1.0);

    gl_Position = projectionMatrix * viewMatrix * worldPos;

    mat3 normalMat = mat3(modelMatrix) * mat3(instanceMatrix);
    vNormal = normalize(normalMat * normal);
    vPosition = worldPos.xyz;
    vLocalPosition = position;
    vUV = uv;
    vCameraDistance = length(cameraPosition - worldPos.xyz);
    vViewDirection = normalize(cameraPosition - worldPos.xyz);

    vec3 transformedNormal = vNormal;
    vec4 worldPosition = worldPos;
    #include <shadowmap_vertex>
}
`;

const propThinFragmentShader = `
precision highp float;

#include <common>
#include <packing>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>

uniform vec3 baseColor;
uniform vec3 detailColor;
uniform vec3 sunDirection;
uniform float ambientIntensity;
uniform vec3 fogColor;
uniform float fogDensity;
uniform sampler2D rockTexture;
uniform float textureScale;

// Point lights
uniform vec3 uPointLightPositions[8];
uniform vec3 uPointLightColors[8];
uniform float uPointLightRanges[8];
uniform int uPointLightCount;

vec3 calcPointLights(vec3 worldPos, vec3 n) {
    vec3 total = vec3(0.0);
    for (int i = 0; i < 8; i++) {
        if (i >= uPointLightCount) break;
        vec3 ld = uPointLightPositions[i] - worldPos;
        float d = length(ld);
        float r = uPointLightRanges[i];
        if (d > r) continue;
        ld /= d;
        float nl = max(dot(n, ld), 0.0);
        float att = 1.0 / (1.0 + d * d / (r * r));
        float w = max(1.0 - pow(d / r, 4.0), 0.0);
        total += uPointLightColors[i] * nl * att * w;
    }
    return total;
}

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

    // Shadow factor
    float shadowFactor = 1.0;
    #if NUM_DIR_LIGHT_SHADOWS > 0
    {
        DirectionalLightShadow dirShadow = directionalLightShadows[0];
        shadowFactor = getShadow(
            directionalShadowMap[0],
            dirShadow.shadowMapSize,
            dirShadow.shadowIntensity,
            dirShadow.shadowBias,
            dirShadow.shadowNormalBias,
            dirShadow.shadowRadius,
            vDirectionalShadowCoord[0]
        );
    }
    #endif

    // Point light contribution
    vec3 ptLight = calcPointLights(vPosition, normal);

    // Final lighting (shadow affects diffuse, not ambient)
    vec3 ambient = vec3(ambientIntensity) * ao;
    vec3 rim = vec3(rimFactor) * vec3(0.8, 0.85, 1.0);

    color = color * (ambient + diffuse * shadowFactor + ptLight) + rim;

    // Fog
    float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vCameraDistance * vCameraDistance);
    color = mix(color, fogColor, clamp(fogFactor, 0.0, 1.0));

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

// Wind-enabled instanced mesh shader for foliage props
const propThinWindVertexShader = `
precision highp float;

#include <common>
#include <shadowmap_pars_vertex>

attribute vec4 color;

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
    vec4 worldPos = modelMatrix * instanceMatrix * vec4(position, 1.0);

    // Height factor for wind (use local Y) - cubic for natural tree sway
    float heightAboveMin = max(0.0, position.y - uMinWindHeight);
    float heightRange = max(0.01, uMaxWindHeight - uMinWindHeight);
    float heightFactor = clamp(heightAboveMin / heightRange, 0.0, 1.0);
    heightFactor = heightFactor * heightFactor * heightFactor;  // Cubic: trunk stays still

    // Wind wave
    vec2 worldPosXZ = worldPos.xz;
    float windPhase = dot(worldPosXZ, uWindDirection) * 0.5 + uTime * uPropsPrimarySpeed;
    float primaryWave = sin(windPhase) * 0.5 + 0.5;
    float secondaryPhase = dot(worldPosXZ, uWindDirection) * 2.0 + uTime * uPropsSecondarySpeed;
    float secondaryWave = sin(secondaryPhase) * 0.3 + 0.5;
    float noiseVal = noise2D(worldPosXZ * 0.3 + uTime * uPropsNoiseSpeed);
    float windAmount = (primaryWave * 0.7 + secondaryWave * 0.3 + noiseVal * 0.2) * heightFactor * uWindStrength;

    // Apply wind displacement in world space (not local!)
    worldPos.x += uWindDirection.x * windAmount * 0.2;
    worldPos.z += uWindDirection.y * windAmount * 0.2;
    worldPos.y -= windAmount * 0.04;

    gl_Position = projectionMatrix * viewMatrix * worldPos;

    mat3 normalMat = mat3(modelMatrix) * mat3(instanceMatrix);
    vNormal = normalize(normalMat * normal);
    vPosition = worldPos.xyz;
    vLocalPosition = position;
    vUV = uv;
    vCameraDistance = length(cameraPosition - worldPos.xyz);
    vViewDirection = normalize(cameraPosition - worldPos.xyz);
    vColor = color;

    vec3 transformedNormal = vNormal;
    vec4 worldPosition = worldPos;
    #include <shadowmap_vertex>
}
`;

const propThinWindFragmentShader = `
precision highp float;

#include <common>
#include <packing>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>

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

// Point lights
uniform vec3 uPointLightPositions[8];
uniform vec3 uPointLightColors[8];
uniform float uPointLightRanges[8];
uniform int uPointLightCount;

vec3 calcPointLights(vec3 worldPos, vec3 n) {
    vec3 total = vec3(0.0);
    for (int i = 0; i < 8; i++) {
        if (i >= uPointLightCount) break;
        vec3 ld = uPointLightPositions[i] - worldPos;
        float d = length(ld);
        float r = uPointLightRanges[i];
        if (d > r) continue;
        ld /= d;
        float nl = max(dot(n, ld), 0.0);
        float att = 1.0 / (1.0 + d * d / (r * r));
        float w = max(1.0 - pow(d / r, 4.0), 0.0);
        total += uPointLightColors[i] * nl * att * w;
    }
    return total;
}

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

    // For leaves: use vertex color directly (like grass shader)
    // For bark: apply subtle noise variation
    float colorNoise = fbm(vPosition * 2.0);
    vec3 color = mix(meshColor, mix(meshColor, meshColor * 0.85, colorNoise * 0.2), 1.0 - leafMask);

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

    // Subsurface scattering approximation (tipFactor for leaves only)
    float tipFactor = smoothstep(0.0, 0.6, vLocalPosition.y) * leafMask;
    float sss = max(0.0, dot(-vViewDirection, sunDirection)) * tipFactor * 0.15;

    // Shadow factor
    float shadowFactor = 1.0;
    #if NUM_DIR_LIGHT_SHADOWS > 0
    {
        DirectionalLightShadow dirShadow = directionalLightShadows[0];
        shadowFactor = getShadow(
            directionalShadowMap[0],
            dirShadow.shadowMapSize,
            dirShadow.shadowIntensity,
            dirShadow.shadowBias,
            dirShadow.shadowNormalBias,
            dirShadow.shadowRadius,
            vDirectionalShadowCoord[0]
        );
    }
    #endif

    // Final lighting (shadow affects diffuse, not ambient)
    float diffuse = halfLambert * 0.6 + 0.4;
    vec3 ambient = vec3(ambientIntensity);
    vec3 rim = vec3(rimFactor) * vec3(0.8, 0.9, 1.0);

    vec3 ptLight = calcPointLights(vPosition, normal);
    color = color * (ambient + diffuse * shadowFactor + ptLight) + rim + vec3(0.1, 0.15, 0.05) * sss;

    // Fresnel: mix blend for softer rim
    color = mix(color, uFresnelColor, clamp(fresnel * leafMask, 0.0, 1.0));

    // Fog
    float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vCameraDistance * vCameraDistance);
    color = mix(color, fogColor, clamp(fogFactor, 0.0, 1.0));

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
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

// Instance group key: "assetType_variationIndex"
type InstanceGroupKey = string;

export interface PropInstance {
  id: string;
  assetType: AssetType;
  variationIndex: number;  // Which variation mesh to use
  params: AssetParams;
  position: THREE.Vector3;
  rotation: THREE.Vector3;
  scale: THREE.Vector3;
  visible: boolean;  // For LOD-based visibility
}

/**
 * Ensure a geometry has all required attributes for instanced rendering.
 * Adds missing color attribute if absent.
 */
function ensureAttributes(geometry: THREE.BufferGeometry): void {
  const posCount = geometry.getAttribute("position")?.count ?? 0;

  // Strip unexpected attributes so mergeGeometries sees a uniform set
  const keep = new Set(["position", "normal", "uv", "color"]);
  const names = Object.keys(geometry.attributes);
  for (const name of names) {
    if (!keep.has(name)) {
      geometry.deleteAttribute(name);
    }
  }

  if (!geometry.getAttribute("normal")) {
    geometry.computeVertexNormals();
  }
  if (!geometry.getAttribute("uv")) {
    geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(posCount * 2), 2));
  }
  if (!geometry.getAttribute("color")) {
    const colors = new Float32Array(posCount * 4);
    for (let i = 0; i < posCount; i++) {
      colors[i * 4 + 3] = 1.0;
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 4));
  }
}

export class PropManager {
  private scene: THREE.Scene;
  private heightmap: Heightmap;
  private instances: Map<string, PropInstance> = new Map();

  // Instancing: base variation geometries per type, per LOD level
  // Key: AssetType -> LOD level -> THREE.BufferGeometry[]
  private variationGeometries: Map<AssetType, Map<MeshLOD, THREE.BufferGeometry[]>> = new Map();
  // Instancing: shared materials per type
  private sharedMaterials: Map<AssetType, THREE.ShaderMaterial> = new Map();
  // Instancing: group meshes for InstancedMesh (per LOD)
  // Key format: "assetType|variationIndex|lodLevel"
  private instanceGroups: Map<InstanceGroupKey, THREE.InstancedMesh> = new Map();
  // Track which props belong to which group (base group without LOD suffix)
  private propsByGroup: Map<InstanceGroupKey, Set<string>> = new Map();
  // Dirty flag to rebuild instance buffers
  private dirtyGroups: Set<InstanceGroupKey> = new Set();

  // Reusable objects to avoid GC pressure
  private readonly _tempQuaternion = new THREE.Quaternion();
  private readonly _tempMatrix = new THREE.Matrix4();
  private readonly _tempVector3 = new THREE.Vector3();
  private readonly _tempScale = new THREE.Vector3();
  private readonly _tempEuler = new THREE.Euler();
  private readonly _tempSphere = new THREE.Sphere();

  // Tile-based grouping for streaming
  private propsByTile: Map<string, Set<string>> = new Map();  // tileKey -> Set<propId>
  private tileSize: number = 64;  // Default tile size

  // Spatial hash for fast picking (O(1) lookup instead of O(n))
  private spatialHash: Map<string, Set<string>> = new Map();  // gridKey -> Set<propId>
  private readonly SPATIAL_GRID_SIZE = 8;  // 8x8 unit grid cells

  // Preview system
  private previewAsset: ProceduralAsset | null = null;
  private previewMesh: THREE.Mesh | null = null;
  private previewInstancedMesh: THREE.InstancedMesh | null = null;
  private previewParams: AssetParams | null = null;
  private previewVisible = false;
  private previewPosition = new THREE.Vector3(0, 0, 0);
  private previewRotation = new THREE.Vector3(0, 0, 0);
  private previewScale = 1.0;

  // Async initialization state
  private initializationComplete = false;
  private initializationPromise: Promise<void> | null = null;
  private isDisposed = false;

  // Camera reference for frustum culling
  private camera: THREE.Camera | null = null;

  // Frustum culling
  private frustum = new THREE.Frustum();
  private frustumMatrix = new THREE.Matrix4();
  private lastFrustumUpdateFrame = -1;
  private frameCounter = 0;
  private referenceTemplates: Partial<Record<"tree" | "bush", THREE.BufferGeometry>> = {};

  // Material start time for wind animation
  private materialStartTime = 0;

  // Light manager reference for point light uniforms
  private lightManager: LightManager | null = null;

  constructor(scene: THREE.Scene, heightmap: Heightmap) {
    this.scene = scene;
    this.heightmap = heightmap;
    this.materialStartTime = performance.now();
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

  private setGeometryVertexColor(geometry: THREE.BufferGeometry, r: number, g: number, b: number): void {
    const posAttr = geometry.getAttribute("position");
    if (!posAttr) return;

    const vertexCount = posAttr.count;
    const colors = new Float32Array(vertexCount * 4);
    for (let i = 0; i < vertexCount; i++) {
      colors[i * 4] = r;
      colors[i * 4 + 1] = g;
      colors[i * 4 + 2] = b;
      colors[i * 4 + 3] = 1.0;
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 4));
  }

  private bakeGeometryToWorld(source: THREE.Mesh, _name: string): THREE.BufferGeometry | null {
    const geometry = source.geometry;
    if (!geometry) return null;

    const posAttr = geometry.getAttribute("position");
    const indices = geometry.getIndex();
    if (!posAttr || !indices) return null;

    // Clone geometry and apply world matrix
    source.updateMatrixWorld(true);
    const cloned = geometry.clone();
    cloned.applyMatrix4(source.matrixWorld);

    // Recompute normals after transform
    cloned.computeVertexNormals();

    return cloned;
  }

  private recenterGeometryToGround(geometry: THREE.BufferGeometry): void {
    const posAttr = geometry.getAttribute("position");
    if (!posAttr || posAttr.count < 1) return;

    const positions = posAttr.array as Float32Array;
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

    for (let i = 0; i < positions.length; i += 3) {
      positions[i] -= centerX;
      positions[i + 1] -= minY;
      positions[i + 2] -= centerZ;
    }

    posAttr.needsUpdate = true;
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  }

  private applyReferenceVariationDeformation(
    geometry: THREE.BufferGeometry,
    seedBase: number,
    assetType: "tree" | "bush"
  ): void {
    const posAttr = geometry.getAttribute("position");
    if (!posAttr || posAttr.count < 1) return;

    const positions = posAttr.array as Float32Array;

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

      positions[i] = px;
      positions[i + 1] = py;
      positions[i + 2] = pz;
    }

    posAttr.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  }

  private createReferenceVariationGeometry(
    assetType: "tree" | "bush",
    _lod: MeshLOD,
    variationIdx: number
  ): THREE.BufferGeometry | null {
    const template = this.referenceTemplates[assetType];
    if (!template) return null;

    const geometry = template.clone();

    const seedBase =
      variationIdx * 37.17 +
      (assetType === "tree" ? 11.7 : 29.3);
    const yaw = (this.seeded01(seedBase + 0.9) - 0.5) * 0.65;
    const sx = 0.88 + this.seeded01(seedBase + 1.7) * 0.26;
    const sy = 0.9 + this.seeded01(seedBase + 2.5) * 0.34;
    const sz = 0.88 + this.seeded01(seedBase + 3.3) * 0.26;

    const variationTransform = new THREE.Matrix4();
    const scaleMatrix = new THREE.Matrix4().makeScale(sx, sy, sz);
    const rotMatrix = new THREE.Matrix4().makeRotationY(yaw);
    variationTransform.multiplyMatrices(rotMatrix, scaleMatrix);
    geometry.applyMatrix4(variationTransform);

    this.applyReferenceVariationDeformation(geometry, seedBase, assetType);

    return geometry;
  }

  private async loadReferenceTemplatesIfAvailable(): Promise<void> {
    if (this.referenceTemplates.tree || this.referenceTemplates.bush) {
      return;
    }

    try {
      const loader = new GLTFLoader();
      const gltf = await loader.loadAsync(REFERENCE_TREE_URL);

      if (this.isDisposed) {
        gltf.scene.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.geometry?.dispose();
            if (child.material) {
              if (Array.isArray(child.material)) {
                child.material.forEach((m) => m.dispose());
              } else {
                child.material.dispose();
              }
            }
          }
        });
        return;
      }

      const importedMeshes: THREE.Mesh[] = [];
      gltf.scene.traverse((child) => {
        if (
          child instanceof THREE.Mesh &&
          child.geometry &&
          child.geometry.getAttribute("position") &&
          child.geometry.getIndex()
        ) {
          importedMeshes.push(child);
        }
      });

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
        _mergedName: string
      ): THREE.BufferGeometry | null => {
        const bakedParts: THREE.BufferGeometry[] = [];

        if (includeTrunk) {
          for (let i = 0; i < trunkSources.length; i++) {
            const baked = this.bakeGeometryToWorld(trunkSources[i], `ref_trunk_${i}`);
            if (!baked) continue;
            this.setGeometryVertexColor(baked, 0.44, 0.32, 0.18);
            ensureAttributes(baked);
            bakedParts.push(baked);
          }
        }

        for (let i = 0; i < bushSources.length; i++) {
          const baked = this.bakeGeometryToWorld(bushSources[i], `ref_bush_${i}`);
          if (!baked) continue;
          this.setGeometryVertexColor(baked, 0.23, 0.48, 0.2);
          ensureAttributes(baked);
          bakedParts.push(baked);
        }

        if (bakedParts.length === 0) {
          return null;
        }

        const merged = BufferGeometryUtils.mergeGeometries(bakedParts, false);
        if (!merged) {
          return null;
        }

        this.recenterGeometryToGround(merged);
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

      // Dispose original imported meshes
      gltf.scene.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry?.dispose();
          if (child.material) {
            if (Array.isArray(child.material)) {
              child.material.forEach((m) => m.dispose());
            } else {
              child.material.dispose();
            }
          }
        }
      });

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
   * Initialize base variation geometries for each asset type (async version)
   * Creates geometries for all LOD levels progressively to avoid blocking
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
      this.variationGeometries.set(assetType, new Map());
    }

    await this.loadReferenceTemplatesIfAvailable();

    // Create geometries progressively using requestAnimationFrame batching
    const batchSize = 4;  // Process 4 meshes per frame
    const currentBatch: Array<{ assetType: AssetType; lod: MeshLOD; variationIdx: number }> = [];

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
            const lodMap = this.variationGeometries.get(assetType);

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
            const useReference = false;

            let geometry: THREE.BufferGeometry | null = null;
            if (useReference) {
              geometry = this.createReferenceVariationGeometry(
                assetType as "tree" | "bush",
                lod,
                variationIdx
              );
            }

            if (!geometry) {
              const params: AssetParams = {
                ...DEFAULT_ASSET_PARAMS[assetType],
                seed,
                size: 1.0,
                subdivisionOverride: subdivision > 0 ? subdivision : undefined,
              };

              const asset = new ProceduralAsset(null, params);
              const mesh = asset.generate() as THREE.Mesh | null;
              if (mesh) {
                geometry = mesh.geometry.clone();
                // Remove from scene since ProceduralAsset with null scene won't add
                asset.dispose();
              }
            }

            if (geometry) {
              ensureAttributes(geometry);
              lodMap.get(lod)!.push(geometry);
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
    console.log(`[PropManager] Async init complete: ${meshCount} meshes (${assetTypes.length} types * ${lodLevels.length} LODs * ${VARIATIONS_PER_TYPE} variations) in ${elapsed.toFixed(0)}ms`);
  }

  /**
   * Synchronous initialization (legacy, for backward compatibility)
   * Use initializeVariationsAsync() for non-blocking initialization
   */
  private initializeVariations(): void {
    const assetTypes: AssetType[] = ["rock", "tree", "bush", "grass_clump"];
    const lodLevels: MeshLOD[] = [MeshLOD.High, MeshLOD.Medium, MeshLOD.Low];

    for (const assetType of assetTypes) {
      const lodMap = new Map<MeshLOD, THREE.BufferGeometry[]>();

      for (const lod of lodLevels) {
        const variations: THREE.BufferGeometry[] = [];

        for (let i = 0; i < VARIATIONS_PER_TYPE; i++) {
          const seed = i * 1001 + 8;
          const subdivision = LOD_SUBDIVISIONS[assetType][lod];
          const useReference =
            assetType === "tree" || assetType === "bush";

          let geometry: THREE.BufferGeometry | null = null;
          if (useReference) {
            geometry = this.createReferenceVariationGeometry(
              assetType as "tree" | "bush",
              lod,
              i
            );
          }

          if (!geometry) {
            const params: AssetParams = {
              ...DEFAULT_ASSET_PARAMS[assetType],
              seed,
              size: 1.0,
              subdivisionOverride: subdivision > 0 ? subdivision : undefined,
            };

            const asset = new ProceduralAsset(null, params);
            const mesh = asset.generate() as THREE.Mesh | null;
            if (mesh) {
              geometry = mesh.geometry.clone();
              asset.dispose();
            }
          }

          if (geometry) {
            ensureAttributes(geometry);
            variations.push(geometry);
          }
        }

        lodMap.set(lod, variations);
      }

      this.variationGeometries.set(assetType, lodMap);
      const material = this.createSharedMaterial(assetType);
      this.sharedMaterials.set(assetType, material);
    }

    this.initializationComplete = true;
    console.log(`[PropManager] Initialized ${assetTypes.length} asset types with ${VARIATIONS_PER_TYPE} variations * 3 LOD levels each`);
  }

  /**
   * Create shared material for instanced props
   */
  private createSharedMaterial(assetType: AssetType): THREE.ShaderMaterial {
    const needsWind = assetType !== "rock";
    const defaultParams = DEFAULT_ASSET_PARAMS[assetType];

    let material: THREE.ShaderMaterial;

    if (needsWind) {
      // Wind settings
      const windAngle = DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.directionRadians;

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
        minWindHeight = 1.2;  // Only upper part moves (trunk stays still)
        maxWindHeight = 2.5;
      }

      // Load textures
      const dirtTex = loadTextureWithFallbackSync(
        DEFAULT_FOLIAGE_QUALITY_PROFILE.textures.dirt,
        {
          preferredExtensions: ["ktx2", "jpg", "png"],
          wrapS: THREE.RepeatWrapping,
          wrapT: THREE.RepeatWrapping,
        }
      );

      const leafAtlas = loadTextureWithFallbackSync(
        DEFAULT_FOLIAGE_QUALITY_PROFILE.textures.leafAtlas,
        {
          preferredExtensions: ["png", "ktx2", "jpg"],
          wrapS: THREE.ClampToEdgeWrapping,
          wrapT: THREE.ClampToEdgeWrapping,
        }
      );

      material = new THREE.ShaderMaterial({
        vertexShader: propThinWindVertexShader,
        fragmentShader: propThinWindFragmentShader,
        uniforms: THREE.UniformsUtils.merge([
          THREE.UniformsLib.lights,
          {
            cameraPosition: { value: new THREE.Vector3() },
            uTime: { value: 0 },
            uWindDirection: { value: new THREE.Vector2(Math.cos(windAngle), Math.sin(windAngle)) },
            uWindStrength: { value: windStrength },
            uMinWindHeight: { value: minWindHeight },
            uMaxWindHeight: { value: maxWindHeight },
            uPropsPrimarySpeed: { value: DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.propsPrimarySpeed },
            uPropsSecondarySpeed: { value: DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.propsSecondarySpeed },
            uPropsNoiseSpeed: { value: DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.propsNoiseSpeed },
            baseColor: { value: new THREE.Color(defaultParams.colorBase.r, defaultParams.colorBase.g, defaultParams.colorBase.b) },
            detailColor: { value: new THREE.Color(defaultParams.colorDetail.r, defaultParams.colorDetail.g, defaultParams.colorDetail.b) },
            sunDirection: { value: new THREE.Vector3(0.5, 0.8, 0.3).normalize() },
            ambientIntensity: { value: 0.4 },
            fogColor: { value: new THREE.Color(0.6, 0.75, 0.9) },
            fogDensity: { value: 0.008 },
            dirtTexture: { value: dirtTex },
            dirtTextureScale: { value: 0.5 },
            leafAtlas: { value: leafAtlas },
            uLeafAlphaCutoff: { value: DEFAULT_FOLIAGE_QUALITY_PROFILE.leafAtlas.alphaCutoff },
            uLeafFadeStart: { value: DEFAULT_FOLIAGE_QUALITY_PROFILE.fade.leafFadeStart },
            uLeafFadeEnd: { value: DEFAULT_FOLIAGE_QUALITY_PROFILE.fade.leafFadeEnd },
            uUseLeafAtlas: { value: assetType === "tree" || assetType === "bush" ? 1.0 : 0.0 },
            uLeafMaskFromLuma: { value: 1.0 },
            uFresnelPower: { value: 3.0 },
            uFresnelStrength: { value: 0.4 },
            uFresnelColor: { value: new THREE.Color(0.8, 0.95, 0.7) },
            // Point lights
            uPointLightPositions: { value: new Float32Array(8 * 3) },
            uPointLightColors: { value: new Float32Array(8 * 3) },
            uPointLightRanges: { value: new Float32Array(8) },
            uPointLightCount: { value: 0 },
          },
        ]),
        lights: true,
        side: THREE.DoubleSide,
      });
    } else {
      // Rock uses instanced static shader with triplanar texture
      const rockTex = loadTextureWithFallbackSync(
        DEFAULT_FOLIAGE_QUALITY_PROFILE.textures.rock,
        {
          preferredExtensions: ["ktx2", "jpg", "png"],
          wrapS: THREE.RepeatWrapping,
          wrapT: THREE.RepeatWrapping,
        }
      );

      material = new THREE.ShaderMaterial({
        vertexShader: propThinVertexShader,
        fragmentShader: propThinFragmentShader,
        uniforms: THREE.UniformsUtils.merge([
          THREE.UniformsLib.lights,
          {
            cameraPosition: { value: new THREE.Vector3() },
            baseColor: { value: new THREE.Color(defaultParams.colorBase.r, defaultParams.colorBase.g, defaultParams.colorBase.b) },
            detailColor: { value: new THREE.Color(defaultParams.colorDetail.r, defaultParams.colorDetail.g, defaultParams.colorDetail.b) },
            sunDirection: { value: new THREE.Vector3(0.5, 0.8, 0.3).normalize() },
            ambientIntensity: { value: 0.4 },
            fogColor: { value: new THREE.Color(0.6, 0.75, 0.9) },
            fogDensity: { value: 0.008 },
            rockTexture: { value: rockTex },
            textureScale: { value: 1.0 },
            // Point lights
            uPointLightPositions: { value: new Float32Array(8 * 3) },
            uPointLightColors: { value: new Float32Array(8 * 3) },
            uPointLightRanges: { value: new Float32Array(8) },
            uPointLightCount: { value: 0 },
          },
        ]),
        lights: true,
        side: THREE.DoubleSide,
      });
    }

    return material;
  }

  /**
   * Sync fog settings from SkyWeatherSystem to all shared materials
   */
  syncFogSettings(fogColor: THREE.Color, fogDensity: number): void {
    for (const material of this.sharedMaterials.values()) {
      if (material.uniforms.fogColor) {
        material.uniforms.fogColor.value.copy(fogColor);
      }
      if (material.uniforms.fogDensity) {
        material.uniforms.fogDensity.value = fogDensity;
      }
    }
  }

  /**
   * Sync sun direction and ambient intensity from SkyWeatherSystem to all shared materials
   */
  syncSunDirection(sunDir: THREE.Vector3, sunColor: THREE.Color, ambientIntensity?: number): void {
    for (const material of this.sharedMaterials.values()) {
      if (material.uniforms.sunDirection) {
        material.uniforms.sunDirection.value.copy(sunDir);
      }
      if (ambientIntensity !== undefined && material.uniforms.ambientIntensity) {
        material.uniforms.ambientIntensity.value = ambientIntensity;
      }
    }
  }

  /**
   * Set light manager for point light uniform sync
   */
  setLightManager(manager: LightManager | null): void {
    this.lightManager = manager;
  }

  /**
   * Update per-frame uniforms (camera position, time).
   * Call this once per frame from the editor engine.
   */
  update(camera?: { position: THREE.Vector3 }): void {
    if (!camera) return;

    for (const [assetType, material] of this.sharedMaterials) {
      material.uniforms.cameraPosition.value.copy(camera.position);
      const needsWind = assetType !== "rock";
      if (needsWind) {
        const elapsed = (performance.now() - this.materialStartTime) / 1000;
        material.uniforms.uTime.value = elapsed;
      }
      // Apply point light uniforms
      if (this.lightManager) {
        this.lightManager.applyToMaterial(material);
      }
    }

    this.frameCounter++;
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
    if (this.lastFrustumUpdateFrame === this.frameCounter) return;

    if (!this.camera) return;

    this.frustumMatrix.multiplyMatrices(
      this.camera.projectionMatrix,
      this.camera.matrixWorldInverse
    );
    this.frustum.setFromProjectionMatrix(this.frustumMatrix);
    this.lastFrustumUpdateFrame = this.frameCounter;
  }

  /**
   * Check if a point is inside the camera frustum
   */
  private isInFrustum(position: THREE.Vector3, radius: number = 1): boolean {
    this._tempSphere.set(position, radius);
    return this.frustum.intersectsSphere(this._tempSphere);
  }

  /**
   * Set tile size for streaming grouping
   */
  setTileSize(tileSize: number): void {
    this.tileSize = tileSize;
  }

  setCamera(camera: THREE.Camera): void {
    this.camera = camera;
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

    // Get variation geometries for all LOD levels
    const lodGeoMap = this.variationGeometries.get(assetType);
    if (!lodGeoMap) return;

    // Get camera position for LOD calculation
    const cameraPos = this.camera ? this.camera.position : new THREE.Vector3();

    // Categorize instances by LOD level
    const lodInstanceLists: Map<MeshLOD, { position: THREE.Vector3; rotation: THREE.Vector3; scale: THREE.Vector3 }[]> = new Map();

    // Initialize LOD lists
    const lodLevels: MeshLOD[] = [MeshLOD.High, MeshLOD.Medium, MeshLOD.Low];
    for (const lod of lodLevels) {
      lodInstanceLists.set(lod, []);
    }

    if (!propIds || propIds.size === 0) {
      // No props - hide all LOD meshes for this group
      for (const lod of lodLevels) {
        const lodGroupKey = this.getGroupKeyWithLOD(assetType, variationIndex, lod);
        const groupMesh = this.instanceGroups.get(lodGroupKey);
        if (groupMesh) {
          groupMesh.visible = false;
          groupMesh.count = 0;
        }
      }
      return;
    }

    // First pass: categorize instances by LOD (with frustum culling)
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
      lodInstanceLists.get(lod)!.push({
        position: instance.position,
        rotation: instance.rotation,
        scale: instance.scale,
      });
    }

    // Apply to each LOD mesh
    for (const lod of lodLevels) {
      const lodGroupKey = this.getGroupKeyWithLOD(assetType, variationIndex, lod);
      const instanceList = lodInstanceLists.get(lod)!;
      const count = instanceList.length;

      if (count === 0) {
        // Hide this LOD mesh
        const groupMesh = this.instanceGroups.get(lodGroupKey);
        if (groupMesh) {
          groupMesh.visible = false;
          groupMesh.count = 0;
        }
        continue;
      }

      // Get or create LOD group mesh
      let groupMesh = this.instanceGroups.get(lodGroupKey);

      // If the existing mesh doesn't have enough capacity, recreate it
      if (groupMesh && groupMesh.instanceMatrix.count < count) {
        this.scene.remove(groupMesh);
        groupMesh.dispose();
        this.instanceGroups.delete(lodGroupKey);
        groupMesh = undefined;
      }

      if (!groupMesh) {
        const lodGeometries = lodGeoMap.get(lod);
        if (!lodGeometries || !lodGeometries[variationIndex]) continue;

        const baseGeometry = lodGeometries[variationIndex];
        // Allocate with extra capacity to avoid frequent re-creation
        const capacity = Math.max(count, 16) * 2;
        const material = this.sharedMaterials.get(assetType);
        if (!material) continue;

        groupMesh = new THREE.InstancedMesh(baseGeometry, material, capacity);
        groupMesh.name = `inst_${lodGroupKey}`;
        groupMesh.frustumCulled = false;  // We handle frustum culling manually
        groupMesh.castShadow = true;
        groupMesh.receiveShadow = true;
        this.scene.add(groupMesh);
        this.instanceGroups.set(lodGroupKey, groupMesh);
      }

      // Fill instance matrices
      for (let i = 0; i < count; i++) {
        const inst = instanceList[i];
        this._tempEuler.set(inst.rotation.x, inst.rotation.y, inst.rotation.z);
        this._tempQuaternion.setFromEuler(this._tempEuler);
        this._tempMatrix.compose(inst.position, this._tempQuaternion, inst.scale);
        groupMesh.setMatrixAt(i, this._tempMatrix);
      }

      groupMesh.count = count;
      groupMesh.instanceMatrix.needsUpdate = true;
      groupMesh.visible = true;
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
      if (this.scene && typeof this.scene.remove === "function") {
        this.scene.remove(this.previewMesh);
      }
      this.previewMesh.geometry?.dispose();
      if (this.previewMesh.material) {
        if (Array.isArray(this.previewMesh.material)) {
          this.previewMesh.material.forEach((m: THREE.Material) => m.dispose());
        } else {
          (this.previewMesh.material as THREE.Material).dispose();
        }
      }
      this.previewMesh = null;
    }
    if (this.previewInstancedMesh) {
      if (this.scene && typeof this.scene.remove === "function") {
        this.scene.remove(this.previewInstancedMesh);
      }
      // Don't dispose geometry/material - they're shared from variationGeometries/sharedMaterials
      this.previewInstancedMesh = null;
    }
  }

  private updateInstancedPreviewTransform(): void {
    if (!this.previewInstancedMesh) return;

    this._tempScale.set(this.previewScale, this.previewScale, this.previewScale);
    this._tempEuler.set(
      this.previewRotation.x,
      this.previewRotation.y,
      this.previewRotation.z
    );
    this._tempQuaternion.setFromEuler(this._tempEuler);
    this._tempMatrix.compose(this.previewPosition, this._tempQuaternion, this._tempScale);
    this.previewInstancedMesh.setMatrixAt(0, this._tempMatrix);
    this.previewInstancedMesh.count = 1;
    this.previewInstancedMesh.instanceMatrix.needsUpdate = true;
  }

  private createInstancedPreviewFromVariation(type: AssetType, variationIndex: number): boolean {
    const lodMap = this.variationGeometries.get(type);
    const sourceGeometry = lodMap?.get(MeshLOD.High)?.[variationIndex];
    if (!sourceGeometry) {
      return false;
    }

    const material = this.sharedMaterials.get(type);
    if (!material) return false;

    const previewMesh = new THREE.InstancedMesh(sourceGeometry, material, 1);
    previewMesh.name = "preview_asset";
    previewMesh.frustumCulled = false;
    previewMesh.visible = this.previewVisible;

    if (this.scene && typeof this.scene.add === "function") {
      this.scene.add(previewMesh);
    }

    this.previewInstancedMesh = previewMesh;
    this.updateInstancedPreviewTransform();
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

    const createdInstancedPreview = this.createInstancedPreviewFromVariation(type, variationIndex);
    if (!createdInstancedPreview) {
      // Fallback path when async variation geometries are not ready yet.
      this.previewAsset = new ProceduralAsset(this.scene, this.previewParams);
      this.previewMesh = this.previewAsset.generate();
      if (this.previewMesh) {
        this.previewMesh.position.copy(this.previewPosition);
      }
    }

    if (this.previewInstancedMesh) {
      this.previewInstancedMesh.name = "preview_asset";
      this.previewInstancedMesh.visible = this.previewVisible;
    } else if (this.previewMesh) {
      this.previewMesh.name = "preview_asset";
      this.previewMesh.visible = this.previewVisible;
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
    if (!this.previewParams) return;

    const previousSize = this.previewParams.size;
    this.previewScale = size;
    this.previewParams.size = size;

    if (this.previewInstancedMesh) {
      this.updateInstancedPreviewTransform();
      return;
    }

    // Fallback procedural preview path
    if (this.previewMesh) {
      const scaleFactor = size / Math.max(0.0001, previousSize);
      this.previewMesh.scale.multiplyScalar(scaleFactor);
    }
  }

  // Update preview with full asset params (from AI chat panel)
  updatePreviewAsset(params: {
    type: AssetType;
    seed: number;
    size: number;
    sizeVariation: number;
    noiseScale: number;
    noiseAmplitude: number;
    colorBase: THREE.Color;
    colorDetail: THREE.Color;
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

      // Make semi-transparent
      if (this.previewMesh.material && this.previewMesh.material instanceof THREE.ShaderMaterial) {
        this.previewMesh.material.transparent = true;
        this.previewMesh.material.opacity = 0.8;
      }

      // Position at center of terrain initially
      const scale = this.heightmap.getScale();
      const centerX = scale / 2;
      const centerZ = scale / 2;
      const centerY = this.heightmap.getInterpolatedHeight(centerX, centerZ);
      this.previewPosition.set(centerX, centerY, centerZ);
      this.previewMesh.position.set(centerX, centerY, centerZ);

      this.previewMesh.visible = true;
      this.previewVisible = true;
    }
  }

  // Update preview position (called on mouse move)
  updatePreviewPosition(x: number, z: number): void {
    const y = this.heightmap.getInterpolatedHeight(x, z);
    this.previewPosition.set(x, y, z);

    if (this.previewInstancedMesh) {
      this.updateInstancedPreviewTransform();
      return;
    }

    if (this.previewMesh) {
      this.previewMesh.position.set(x, y, z);
    }
  }

  // Show/hide preview
  setPreviewVisible(visible: boolean): void {
    this.previewVisible = visible;
    if (this.previewInstancedMesh) {
      this.previewInstancedMesh.visible = visible;
    } else if (this.previewMesh) {
      this.previewMesh.visible = visible;
    }
  }

  // Get current preview params
  getPreviewParams(): AssetParams | null {
    return this.previewParams ? { ...this.previewParams } : null;
  }

  // Place the current preview as a permanent prop
  // Returns { id, newSeed } so caller can update store
  placeCurrentPreview(): { id: string; newSeed: number } | null {
    if ((!this.previewMesh && !this.previewInstancedMesh) || !this.previewParams) {
      return null;
    }

    const x = this.previewPosition.x;
    const z = this.previewPosition.z;
    const y = this.heightmap.getInterpolatedHeight(x, z);

    const id = `prop_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Store params BEFORE randomizing
    const params = { ...this.previewParams };
    const variationIndex = this.getVariationIndex(params.seed);
    const groupKey = this.getGroupKey(params.type, variationIndex);

    // Store instance (no mesh - managed by instancing)
    const rotation = this.previewInstancedMesh
      ? this.previewRotation.clone()
      : (this.previewMesh ? new THREE.Vector3(this.previewMesh.rotation.x, this.previewMesh.rotation.y, this.previewMesh.rotation.z) : new THREE.Vector3());

    const instance: PropInstance = {
      id,
      assetType: params.type,
      variationIndex,
      params,
      position: new THREE.Vector3(x, y, z),
      rotation,
      scale: new THREE.Vector3(this.previewScale, this.previewScale, this.previewScale),
      visible: true,
    };

    this.instances.set(id, instance);

    // Register to group for instancing
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

    // IMPORTANT: Dispose preview BEFORE rebuilding instance group
    this.disposePreviewResources();

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
      position: new THREE.Vector3(x, y, z),
      rotation: new THREE.Vector3(0, rotationY, 0),
      scale: new THREE.Vector3(size, size, size),
      visible: true,
    };

    this.instances.set(id, instance);

    // Register to group for instancing
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
    this.spatialHash.clear();

    // Hide all instance group meshes
    for (const groupMesh of this.instanceGroups.values()) {
      groupMesh.visible = false;
      groupMesh.count = 0;
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
        colorBase: new THREE.Color(
          item.params.colorBase.r,
          item.params.colorBase.g,
          item.params.colorBase.b
        ),
        colorDetail: new THREE.Color(
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
        position: new THREE.Vector3(item.position.x, item.position.y, item.position.z),
        rotation: new THREE.Vector3(item.rotation.x, item.rotation.y, item.rotation.z),
        scale: new THREE.Vector3(item.scale.x, item.scale.y, item.scale.z),
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

    console.log(`[PropManager] Imported ${data.length} props using instanced meshes`);
  }

  dispose(): void {
    this.isDisposed = true;  // Prevent pending async callbacks from running
    this.clearAll();

    // Dispose preview resources
    this.disposePreviewResources();

    // Dispose instance group meshes
    for (const groupMesh of this.instanceGroups.values()) {
      if (this.scene && typeof this.scene.remove === "function") {
        this.scene.remove(groupMesh);
      }
      groupMesh.dispose();
    }
    this.instanceGroups.clear();

    // Dispose variation geometries
    for (const lodMap of this.variationGeometries.values()) {
      for (const geometries of lodMap.values()) {
        for (const geometry of geometries) {
          geometry.dispose();
        }
      }
    }
    this.variationGeometries.clear();

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
