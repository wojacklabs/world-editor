import * as THREE from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import {
  loadTextureWithFallbackSync,
} from "../../shared/rendering/TextureLoader.three";
import { DEFAULT_FOLIAGE_QUALITY_PROFILE } from "../../shared/foliage/FoliageQualityProfile";
import { createLeafCardGeometry } from "../../shared/foliage/LeafCards.three";
import { fbm3D, noise3D } from "../../shared/math/NoiseUtils";
import {
  generateDoghouseGeometry,
  generateFenceSegmentGeometry,
  generateHanokHouseGeometry,
  generateJangdokdaeGeometry,
} from "../../shared/procedural/HanokGenerator";

// ============================================
// Wind-enabled vertex shader for foliage (grass, bush, tree leaves)
// ============================================
const foliageWindVertexShader = `
precision highp float;

attribute vec4 color;  // Vertex color (RGBA)

uniform float uTime;
uniform vec2 uWindDirection;  // Normalized XZ direction
uniform float uWindStrength;  // 0.0 ~ 1.0
uniform float uMinWindHeight; // Y threshold where wind starts
uniform float uMaxWindHeight; // Y where wind is at full strength
uniform float uPropsPrimarySpeed;
uniform float uPropsSecondarySpeed;
uniform float uPropsNoiseSpeed;

varying vec3 vNormal;
varying vec3 vPosition;
varying vec3 vLocalPosition;
varying vec2 vUV;
varying float vCameraDistance;
varying vec3 vViewDirection;
varying vec4 vColor;  // Pass vertex color to fragment

// Simple noise for wind variation
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
    vec4 worldPos = modelMatrix * vec4(position, 1.0);

    // Height factor: higher vertices move more (use local Y) - cubic for trees
    float heightAboveMin = max(0.0, position.y - uMinWindHeight);
    float heightRange = max(0.01, uMaxWindHeight - uMinWindHeight);
    float heightFactor = clamp(heightAboveMin / heightRange, 0.0, 1.0);
    heightFactor = heightFactor * heightFactor * heightFactor;  // Cubic: trunk stays still

    // Wind wave: travels through space over time
    vec2 worldPosXZ = worldPos.xz;
    float windPhase = dot(worldPosXZ, uWindDirection) * 0.5 + uTime * uPropsPrimarySpeed;

    // Primary wave (slow, large movement)
    float primaryWave = sin(windPhase) * 0.5 + 0.5;

    // Secondary wave (faster, smaller, gives rustling effect)
    float secondaryPhase = dot(worldPosXZ, uWindDirection) * 2.0 + uTime * uPropsSecondarySpeed;
    float secondaryWave = sin(secondaryPhase) * 0.3 + 0.5;

    // Noise for variation (so not all grass moves identically)
    float noiseVal = noise2D(worldPosXZ * 0.3 + uTime * uPropsNoiseSpeed);

    // Combined wind displacement
    float windAmount = (primaryWave * 0.7 + secondaryWave * 0.3 + noiseVal * 0.2) * heightFactor * uWindStrength;

    // Apply displacement in world space (not local!)
    worldPos.x += uWindDirection.x * windAmount * 0.2;
    worldPos.z += uWindDirection.y * windAmount * 0.2;
    worldPos.y -= windAmount * 0.04;

    gl_Position = projectionMatrix * viewMatrix * worldPos;

    vNormal = normalize(mat3(modelMatrix) * normal);
    vPosition = worldPos.xyz;
    vLocalPosition = position;
    vUV = uv;
    vCameraDistance = length(cameraPosition - worldPos.xyz);
    vViewDirection = normalize(cameraPosition - worldPos.xyz);
    vColor = color;  // Pass vertex color
}
`;

const foliageWindFragmentShader = `
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

varying vec3 vNormal;
varying vec3 vPosition;
varying vec3 vLocalPosition;
varying vec2 vUV;
varying float vCameraDistance;
varying vec3 vViewDirection;
varying vec4 vColor;  // Vertex color from vertex shader

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

    // Use vertex color if available (alpha > 0), otherwise use baseColor
    vec3 meshColor = vColor.a > 0.5 ? vColor.rgb : baseColor;

    // Color variation with noise
    float colorNoise = fbm(vPosition * 2.0);
    vec3 color = mix(meshColor, meshColor * 0.8, colorNoise * 0.3);

    // Height-based color (tips lighter) - only for foliage, not trunk
    float tipFactor = smoothstep(0.0, 0.6, vLocalPosition.y);
    float isLeaf = mix(0.3, 1.0, leafMask);  // Green = leaf, brown = trunk
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

    // Subsurface scattering approximation (light through leaves)
    float sss = max(0.0, dot(-vViewDirection, sunDirection)) * tipFactor * 0.15;

    // Final lighting
    float diffuse = halfLambert * 0.6 + 0.4;
    vec3 ambient = vec3(ambientIntensity);
    vec3 rim = vec3(rimFactor) * vec3(0.8, 0.9, 1.0);

    color = color * (ambient + diffuse) + rim + vec3(0.1, 0.15, 0.05) * sss;

    // Fog
    float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vCameraDistance * vCameraDistance);
    color = mix(color, fogColor, clamp(fogFactor, 0.0, 1.0));

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

// ============================================
// Register procedural asset shaders - Per-pixel smooth shading
// ============================================
const proceduralAssetVertexShader = `
precision highp float;

varying vec3 vNormal;
varying vec3 vPosition;
varying vec3 vLocalPosition;
varying vec2 vUV;
varying float vCameraDistance;
varying vec3 vViewDirection;

void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);

    vNormal = normalize(mat3(modelMatrix) * normal);
    vPosition = worldPos.xyz;
    vLocalPosition = position;
    vUV = uv;
    vCameraDistance = length(cameraPosition - worldPos.xyz);
    vViewDirection = normalize(cameraPosition - worldPos.xyz);
}
`;

const proceduralAssetFragmentShader = `
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
    // Screen-space derivatives for smooth normals
    vec3 dPdx = dFdx(vPosition);
    vec3 dPdy = dFdy(vPosition);
    vec3 geometricNormal = normalize(cross(dPdx, dPdy));

    // Vertex normal
    vec3 smoothNormal = normalize(vNormal);

    // === Edge Detection ===
    vec3 dNdx = dFdx(smoothNormal);
    vec3 dNdy = dFdy(smoothNormal);
    float edgeStrength = length(dNdx) + length(dNdy);

    float edgeFactor = smoothstep(0.1, 0.5, edgeStrength);

    // === Edge Blending ===
    float blendRatio = mix(0.9, 0.5, edgeFactor);
    vec3 normal = normalize(mix(geometricNormal, smoothNormal, blendRatio));

    // Per-pixel normal perturbation
    float noiseScale2 = 8.0;
    float noiseStrength = 0.12;
    vec3 noisePos = vLocalPosition * noiseScale2;

    float nx = fbm(noisePos + vec3(0.1, 0.0, 0.0)) - fbm(noisePos - vec3(0.1, 0.0, 0.0));
    float ny = fbm(noisePos + vec3(0.0, 0.1, 0.0)) - fbm(noisePos - vec3(0.0, 0.1, 0.0));
    float nz = fbm(noisePos + vec3(0.0, 0.0, 0.1)) - fbm(noisePos - vec3(0.0, 0.0, 0.1));
    vec3 noisePerturbation = normalize(vec3(nx, ny, nz)) * noiseStrength;

    noisePerturbation *= (1.0 - edgeFactor * 0.5);
    normal = normalize(normal + noisePerturbation);

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

    // Edge softening (smooth lighting at edges)
    diffuse = mix(diffuse, diffuse * 0.7 + 0.3, edgeFactor * 0.4);

    // Rim lighting
    float rimFactor = 1.0 - max(dot(normal, vViewDirection), 0.0);
    rimFactor = pow(rimFactor, 3.0) * 0.1;

    // Ambient occlusion
    float ao = 0.5 + 0.5 * smoothNormal.y;

    // Final lighting
    vec3 ambient = vec3(ambientIntensity) * ao;
    vec3 rim = vec3(rimFactor) * vec3(0.8, 0.85, 1.0);

    color = color * (ambient + diffuse) + rim;

    // Fog
    float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vCameraDistance * vCameraDistance);
    color = mix(color, fogColor, clamp(fogFactor, 0.0, 1.0));

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

const structureAssetVertexShader = `
precision highp float;

attribute vec4 color;

varying vec3 vNormal;
varying vec3 vPosition;
varying float vCameraDistance;
varying vec3 vViewDirection;
varying vec4 vColor;

void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);

    vNormal = normalize(mat3(modelMatrix) * normal);
    vPosition = worldPos.xyz;
    vCameraDistance = length(cameraPosition - worldPos.xyz);
    vViewDirection = normalize(cameraPosition - worldPos.xyz);
    vColor = color;
}
`;

const structureAssetFragmentShader = `
precision highp float;

uniform vec3 sunDirection;
uniform float ambientIntensity;
uniform vec3 fogColor;
uniform float fogDensity;

varying vec3 vNormal;
varying vec3 vPosition;
varying float vCameraDistance;
varying vec3 vViewDirection;
varying vec4 vColor;

void main() {
    vec3 normal = normalize(vNormal);
    vec3 base = vColor.rgb;

    float NdotL = max(dot(normal, sunDirection), 0.0);
    float diffuse = NdotL * 0.65 + 0.35;
    float ao = 0.55 + 0.45 * clamp(normal.y * 0.5 + 0.5, 0.0, 1.0);
    float rim = pow(1.0 - max(dot(normal, vViewDirection), 0.0), 2.8) * 0.08;

    vec3 color = base * (ambientIntensity * ao + diffuse) + vec3(rim);

    float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vCameraDistance * vCameraDistance);
    color = mix(color, fogColor, clamp(fogFactor, 0.0, 1.0));

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

function isWindAnimatedAsset(type: AssetType): boolean {
  return type === "grass_clump" || type === "bush" || type === "tree";
}

function isKoreanStructureAsset(type: AssetType): boolean {
  return (
    type === "hanok_giwa" ||
    type === "hanok_choga" ||
    type === "wall_fence_segment" ||
    type === "jangdokdae_set" ||
    type === "doghouse"
  );
}

export type AssetType =
  | "rock"
  | "tree"
  | "bush"
  | "grass_clump"
  | "hanok_giwa"
  | "hanok_choga"
  | "wall_fence_segment"
  | "jangdokdae_set"
  | "doghouse";

export interface AssetParams {
  type: AssetType;
  seed: number;
  size: number;           // Base size
  sizeVariation: number;  // 0-1, how much size can vary
  noiseScale: number;     // Noise frequency
  noiseAmplitude: number; // Noise strength
  colorBase: THREE.Color;
  colorDetail: THREE.Color;
  length?: number;
  width?: number;
  height?: number;
  baySize?: number;
  subdivisionOverride?: number;  // Override subdivision level for LOD
}

export const DEFAULT_ASSET_PARAMS: Record<AssetType, AssetParams> = {
  rock: {
    type: "rock",
    seed: Math.random() * 10000,
    size: 1.0,
    sizeVariation: 0.3,
    noiseScale: 3.0,
    noiseAmplitude: 0.2,
    colorBase: new THREE.Color(0.35, 0.33, 0.30),
    colorDetail: new THREE.Color(0.50, 0.48, 0.45),
  },
  tree: {
    type: "tree",
    seed: Math.random() * 10000,
    size: 3.0,
    sizeVariation: 0.4,
    noiseScale: 2.0,
    noiseAmplitude: 0.15,
    colorBase: new THREE.Color(0.30, 0.42, 0.18),
    colorDetail: new THREE.Color(0.42, 0.52, 0.25),
  },
  bush: {
    type: "bush",
    seed: Math.random() * 10000,
    size: 0.8,
    sizeVariation: 0.3,
    noiseScale: 4.0,
    noiseAmplitude: 0.25,
    colorBase: new THREE.Color(0.28, 0.40, 0.16),
    colorDetail: new THREE.Color(0.38, 0.48, 0.22),
  },
  grass_clump: {
    type: "grass_clump",
    seed: Math.random() * 10000,
    size: 0.4,
    sizeVariation: 0.2,
    noiseScale: 5.0,
    noiseAmplitude: 0.1,
    colorBase: new THREE.Color(0.25, 0.38, 0.14),
    colorDetail: new THREE.Color(0.40, 0.50, 0.22),
  },
  hanok_giwa: {
    type: "hanok_giwa",
    seed: Math.random() * 10000,
    size: 1.0,
    sizeVariation: 0.08,
    noiseScale: 1.0,
    noiseAmplitude: 0.05,
    colorBase: new THREE.Color(0.84, 0.80, 0.72),
    colorDetail: new THREE.Color(0.29, 0.31, 0.35),
    length: 10,
    width: 6,
    height: 2.6,
    baySize: 2.4,
  },
  hanok_choga: {
    type: "hanok_choga",
    seed: Math.random() * 10000,
    size: 1.0,
    sizeVariation: 0.08,
    noiseScale: 1.0,
    noiseAmplitude: 0.05,
    colorBase: new THREE.Color(0.77, 0.67, 0.48),
    colorDetail: new THREE.Color(0.68, 0.58, 0.39),
    length: 9,
    width: 5.4,
    height: 2.4,
    baySize: 2.2,
  },
  wall_fence_segment: {
    type: "wall_fence_segment",
    seed: Math.random() * 10000,
    size: 1.0,
    sizeVariation: 0.05,
    noiseScale: 1.0,
    noiseAmplitude: 0.03,
    colorBase: new THREE.Color(0.70, 0.62, 0.52),
    colorDetail: new THREE.Color(0.40, 0.31, 0.22),
    length: 6,
    width: 0.45,
    height: 1.6,
  },
  jangdokdae_set: {
    type: "jangdokdae_set",
    seed: Math.random() * 10000,
    size: 1.0,
    sizeVariation: 0.05,
    noiseScale: 1.0,
    noiseAmplitude: 0.03,
    colorBase: new THREE.Color(0.23, 0.16, 0.12),
    colorDetail: new THREE.Color(0.52, 0.47, 0.41),
    length: 3.2,
    width: 2.2,
    height: 0.8,
  },
  doghouse: {
    type: "doghouse",
    seed: Math.random() * 10000,
    size: 1.0,
    sizeVariation: 0.08,
    noiseScale: 1.0,
    noiseAmplitude: 0.04,
    colorBase: new THREE.Color(0.42, 0.31, 0.22),
    colorDetail: new THREE.Color(0.29, 0.31, 0.34),
    length: 1.7,
    width: 1.2,
    height: 1.3,
  },
};

// Size-based subdivision calculation
function calcSubdivision(size: number, base: number = 4, override?: number): number {
  if (override !== undefined) {
    return Math.max(1, Math.min(6, override));  // clamp 1~6
  }
  // size 1.0 -> base, size 2.0 -> base+1, size 4.0 -> base+2
  const subdiv = Math.floor(base + Math.log2(Math.max(size, 0.25)));
  return Math.max(3, Math.min(6, subdiv));  // clamp 3~6
}

// ============================================
// Vertex Color Helpers (operate on BufferGeometry)
// ============================================

function getPositions(geometry: THREE.BufferGeometry): Float32Array | null {
  const attr = geometry.getAttribute("position");
  if (!attr) return null;
  return attr.array as Float32Array;
}

function setGeometryVertexColor(geometry: THREE.BufferGeometry, r: number, g: number, b: number): void {
  const positions = getPositions(geometry);
  if (!positions) return;

  const vertexCount = positions.length / 3;
  const colors = new Float32Array(vertexCount * 4);

  for (let i = 0; i < vertexCount; i++) {
    colors[i * 4] = r;
    colors[i * 4 + 1] = g;
    colors[i * 4 + 2] = b;
    colors[i * 4 + 3] = 1.0;
  }

  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 4));
}

function setRockVertexColors(geometry: THREE.BufferGeometry, seed: number): void {
  const positions = getPositions(geometry);
  if (!positions) return;

  const vertexCount = positions.length / 3;
  const colors = new Float32Array(vertexCount * 4);

  const baseRock = { r: 0.45, g: 0.42, b: 0.38 };
  const darkRock = { r: 0.25, g: 0.23, b: 0.20 };
  const lightRock = { r: 0.60, g: 0.58, b: 0.52 };
  const mossColor = { r: 0.35, g: 0.45, b: 0.30 };
  const lichColor = { r: 0.55, g: 0.58, b: 0.45 };

  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const y = positions[i + 1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const heightRange = maxY - minY || 1;

  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];

    const heightT = (y - minY) / heightRange;
    const len = Math.sqrt(x * x + y * y + z * z) || 1;
    const ny = y / len;

    const noise1 = noise3D(x * 8 + seed, y * 8, z * 8) * 0.5 + 0.5;
    const noise2 = noise3D(x * 15 + seed * 2, y * 15, z * 15) * 0.5 + 0.5;
    const noise3Val = fbm3D(x * 3 + seed * 0.5, y * 3, z * 3, 2) * 0.5 + 0.5;

    const mossStrength = Math.max(0, ny * 0.5 + 0.3) * noise3Val * (heightT > 0.4 ? 1 : heightT / 0.4);
    const lichStrength = Math.max(0, ny * 0.3 + 0.2) * noise1 * 0.5;

    let r = baseRock.r;
    let g = baseRock.g;
    let b = baseRock.b;

    const darkFactor = Math.pow(1 - heightT, 1.5) * 0.4;
    r = r * (1 - darkFactor) + darkRock.r * darkFactor;
    g = g * (1 - darkFactor) + darkRock.g * darkFactor;
    b = b * (1 - darkFactor) + darkRock.b * darkFactor;

    const lightFactor = Math.pow(heightT, 2) * 0.3 * noise2;
    r = r * (1 - lightFactor) + lightRock.r * lightFactor;
    g = g * (1 - lightFactor) + lightRock.g * lightFactor;
    b = b * (1 - lightFactor) + lightRock.b * lightFactor;

    r = r * (1 - mossStrength) + mossColor.r * mossStrength;
    g = g * (1 - mossStrength) + mossColor.g * mossStrength;
    b = b * (1 - mossStrength) + mossColor.b * mossStrength;

    r = r * (1 - lichStrength) + lichColor.r * lichStrength;
    g = g * (1 - lichStrength) + lichColor.g * lichStrength;
    b = b * (1 - lichStrength) + lichColor.b * lichStrength;

    const microNoise = (noise2 - 0.5) * 0.08;
    r = Math.max(0, Math.min(1, r + microNoise));
    g = Math.max(0, Math.min(1, g + microNoise * 0.8));
    b = Math.max(0, Math.min(1, b + microNoise * 0.6));

    colors[i * 4] = r;
    colors[i * 4 + 1] = g;
    colors[i * 4 + 2] = b;
    colors[i * 4 + 3] = 1.0;
  }

  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 4));
}

function setBarkVertexColors(geometry: THREE.BufferGeometry, seed: number, isBranch: boolean = false): void {
  const positions = getPositions(geometry);
  if (!positions) return;

  const vertexCount = positions.length / 3;
  const colors = new Float32Array(vertexCount * 4);

  const darkBark = { r: 0.38, g: 0.30, b: 0.20 };
  const midBark = { r: 0.52, g: 0.42, b: 0.28 };
  const lightBark = { r: 0.62, g: 0.52, b: 0.36 };
  const mossBark = { r: 0.35, g: 0.40, b: 0.25 };

  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const y = positions[i + 1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const heightRange = maxY - minY || 1;

  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];

    const heightT = (y - minY) / heightRange;

    const barkNoise = noise3D(x * 20 + seed, y * 5, z * 20 + seed * 0.5) * 0.5 + 0.5;
    const stripNoise = Math.sin(y * 30 + noise3D(x * 10, y * 2, z * 10) * 3) * 0.5 + 0.5;
    const mossNoise = fbm3D(x * 6 + seed, y * 6, z * 6, 2) * 0.5 + 0.5;

    let r, g, b;
    if (heightT < 0.3) {
      const t = heightT / 0.3;
      r = darkBark.r * (1 - t) + midBark.r * t;
      g = darkBark.g * (1 - t) + midBark.g * t;
      b = darkBark.b * (1 - t) + midBark.b * t;
    } else {
      const t = (heightT - 0.3) / 0.7;
      r = midBark.r * (1 - t) + lightBark.r * t;
      g = midBark.g * (1 - t) + lightBark.g * t;
      b = midBark.b * (1 - t) + lightBark.b * t;
    }

    const grooveFactor = (1 - barkNoise) * stripNoise * 0.25;
    r *= (1 - grooveFactor);
    g *= (1 - grooveFactor);
    b *= (1 - grooveFactor);

    const mossStrength = (isBranch ? 0.1 : 0.3) * (1 - heightT) * mossNoise;
    r = r * (1 - mossStrength) + mossBark.r * mossStrength;
    g = g * (1 - mossStrength) + mossBark.g * mossStrength;
    b = b * (1 - mossStrength) + mossBark.b * mossStrength;

    colors[i * 4] = Math.max(0, Math.min(1, r));
    colors[i * 4 + 1] = Math.max(0, Math.min(1, g));
    colors[i * 4 + 2] = Math.max(0, Math.min(1, b));
    colors[i * 4 + 3] = 1.0;
  }

  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 4));
}

function setBushVertexColors(geometry: THREE.BufferGeometry, seed: number): void {
  const positions = getPositions(geometry);
  if (!positions) return;

  const vertexCount = positions.length / 3;
  const colors = new Float32Array(vertexCount * 4);

  const sunBush = { r: 0.38, g: 0.55, b: 0.22 };
  const shadeBush = { r: 0.15, g: 0.32, b: 0.10 };
  const midBush = { r: 0.28, g: 0.45, b: 0.16 };
  const yellowTint = { r: 0.42, g: 0.52, b: 0.18 };

  let minY = Infinity, maxY = -Infinity;
  let minX = Infinity, maxX = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const heightRange = maxY - minY || 1;
  const xRange = maxX - minX || 1;
  const zRange = maxZ - minZ || 1;

  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];

    const heightT = (y - minY) / heightRange;
    const xT = (x - minX) / xRange;
    const zT = (z - minZ) / zRange;

    const centerDistX = Math.abs(xT - 0.5) * 2;
    const centerDistZ = Math.abs(zT - 0.5) * 2;
    const edgeFactor = Math.max(centerDistX, centerDistZ);

    const bushNoise = noise3D(x * 15 + seed, y * 15, z * 15 + seed * 0.7) * 0.5 + 0.5;
    const varNoise = fbm3D(x * 6 + seed * 2, y * 6, z * 6, 2) * 0.5 + 0.5;

    const sunExposure = (heightT * 0.6 + edgeFactor * 0.3 + varNoise * 0.2);

    let r, g, b;
    if (sunExposure > 0.6) {
      const t = (sunExposure - 0.6) / 0.4;
      r = midBush.r * (1 - t) + sunBush.r * t;
      g = midBush.g * (1 - t) + sunBush.g * t;
      b = midBush.b * (1 - t) + sunBush.b * t;
    } else if (sunExposure > 0.3) {
      const t = (sunExposure - 0.3) / 0.3;
      r = shadeBush.r * (1 - t) + midBush.r * t;
      g = shadeBush.g * (1 - t) + midBush.g * t;
      b = shadeBush.b * (1 - t) + midBush.b * t;
    } else {
      r = shadeBush.r;
      g = shadeBush.g;
      b = shadeBush.b;
    }

    const yellowFactor = bushNoise * bushNoise * 0.2;
    r = r * (1 - yellowFactor) + yellowTint.r * yellowFactor;
    g = g * (1 - yellowFactor) + yellowTint.g * yellowFactor;
    b = b * (1 - yellowFactor) + yellowTint.b * yellowFactor;

    const microVar = (bushNoise - 0.5) * 0.06;
    r = Math.max(0, Math.min(1, r + microVar * 0.5));
    g = Math.max(0, Math.min(1, g + microVar));
    b = Math.max(0, Math.min(1, b + microVar * 0.3));

    colors[i * 4] = r;
    colors[i * 4 + 1] = g;
    colors[i * 4 + 2] = b;
    colors[i * 4 + 3] = 1.0;
  }

  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 4));
}

function setLeafVertexColors(geometry: THREE.BufferGeometry, seed: number, isTop: boolean = false): void {
  const positions = getPositions(geometry);
  if (!positions) return;

  const vertexCount = positions.length / 3;
  const colors = new Float32Array(vertexCount * 4);

  const sunLeaf = { r: 0.467, g: 0.667, b: 0.102 };
  const shadeLeaf = { r: 0.15, g: 0.28, b: 0.06 };
  const yellowLeaf = { r: 0.50, g: 0.70, b: 0.12 };
  const freshLeaf = { r: 0.224, g: 0.424, b: 0.094 };

  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const y = positions[i + 1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const heightRange = maxY - minY || 1;

  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];

    const heightT = (y - minY) / heightRange;

    const leafNoise = noise3D(x * 12 + seed, y * 12, z * 12 + seed * 0.7) * 0.5 + 0.5;
    const varNoise = fbm3D(x * 5 + seed * 2, y * 5, z * 5, 2) * 0.5 + 0.5;

    let r, g, b;
    const sunFactor = heightT * 0.7 + varNoise * 0.3;

    if (sunFactor > 0.6) {
      const t = (sunFactor - 0.6) / 0.4;
      r = freshLeaf.r * (1 - t) + sunLeaf.r * t;
      g = freshLeaf.g * (1 - t) + sunLeaf.g * t;
      b = freshLeaf.b * (1 - t) + sunLeaf.b * t;
    } else if (sunFactor > 0.3) {
      const t = (sunFactor - 0.3) / 0.3;
      r = shadeLeaf.r * (1 - t) + freshLeaf.r * t;
      g = shadeLeaf.g * (1 - t) + freshLeaf.g * t;
      b = shadeLeaf.b * (1 - t) + freshLeaf.b * t;
    } else {
      r = shadeLeaf.r;
      g = shadeLeaf.g;
      b = shadeLeaf.b;
    }

    if (isTop) {
      const yellowFactor = leafNoise * 0.25;
      r = r * (1 - yellowFactor) + yellowLeaf.r * yellowFactor;
      g = g * (1 - yellowFactor) + yellowLeaf.g * yellowFactor;
      b = b * (1 - yellowFactor) + yellowLeaf.b * yellowFactor;
    }

    const microVar = (leafNoise - 0.5) * 0.08;
    r = Math.max(0, Math.min(1, r + microVar * 0.5));
    g = Math.max(0, Math.min(1, g + microVar));
    b = Math.max(0, Math.min(1, b + microVar * 0.3));

    colors[i * 4] = r;
    colors[i * 4 + 1] = g;
    colors[i * 4 + 2] = b;
    colors[i * 4 + 3] = 1.0;
  }

  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 4));
}

/**
 * Ensure a geometry has all required attributes for merging (position, normal, uv, color).
 */
function ensureAttributes(geometry: THREE.BufferGeometry): void {
  const posAttr = geometry.getAttribute("position");
  if (!posAttr) return;
  const vertexCount = posAttr.count;

  if (!geometry.getAttribute("normal")) {
    geometry.computeVertexNormals();
  }
  if (!geometry.getAttribute("uv")) {
    const uvs = new Float32Array(vertexCount * 2);
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  }
  if (!geometry.getAttribute("color")) {
    const colors = new Float32Array(vertexCount * 4);
    for (let i = 0; i < vertexCount; i++) {
      colors[i * 4] = 0.5;
      colors[i * 4 + 1] = 0.5;
      colors[i * 4 + 2] = 0.5;
      colors[i * 4 + 3] = 1.0;
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 4));
  }
}

export class ProceduralAsset {
  private scene: THREE.Scene | null;
  private mesh: THREE.Mesh | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private params: AssetParams;

  constructor(scene: THREE.Scene | null, params: AssetParams) {
    this.scene = scene;
    this.params = { ...params };
  }

  generate(): THREE.Mesh {
    this.dispose();

    let geometry: THREE.BufferGeometry | null = null;

    switch (this.params.type) {
      case "rock":
        geometry = this.generateRock();
        break;
      case "tree":
        geometry = this.generateTree();
        break;
      case "bush":
        geometry = this.generateBush();
        break;
      case "grass_clump":
        geometry = this.generateGrassClump();
        break;
      case "hanok_giwa":
        geometry = this.generateHanokGiwa();
        break;
      case "hanok_choga":
        geometry = this.generateHanokChoga();
        break;
      case "wall_fence_segment":
        geometry = this.generateFenceSegment();
        break;
      case "jangdokdae_set":
        geometry = this.generateJangdokdaeSet();
        break;
      case "doghouse":
        geometry = this.generateDoghouse();
        break;
    }

    if (!geometry) {
      geometry = new THREE.BufferGeometry();
    }

    ensureAttributes(geometry);
    this.createMaterial();
    this.mesh = new THREE.Mesh(geometry, this.material!);
    this.mesh.scale.setScalar(this.params.size);

    if (this.scene && typeof this.scene.add === "function") {
      this.scene.add(this.mesh);
    }

    return this.mesh;
  }

  private generateRock(): THREE.BufferGeometry {
    const seed = this.params.seed;
    const subdivisions = calcSubdivision(this.params.size, 4, this.params.subdivisionOverride);

    const geometry = new THREE.IcosahedronGeometry(0.5, subdivisions);

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

    const peakDirX = noise3D(seed * 6.0, seed * 0.2, 0);
    const peakDirY = noise3D(seed * 0.2, seed * 6.1, 0);
    const peakDirZ = noise3D(0, seed * 0.2, seed * 6.2);
    const peakLen = Math.sqrt(peakDirX * peakDirX + peakDirY * peakDirY + peakDirZ * peakDirZ);
    const peakStrength = 0.1 + Math.abs(noise3D(seed * 6.5, seed * 6.6, seed * 6.7)) * 0.4;

    const posAttr = geometry.getAttribute("position");
    const positions = posAttr.array as Float32Array;

    for (let i = 0; i < positions.length; i += 3) {
      let x = positions[i];
      let y = positions[i + 1];
      let z = positions[i + 2];

      const len = Math.sqrt(x * x + y * y + z * z);
      const nx = x / len;
      const ny = y / len;
      const nz = z / len;

      x *= scaleX;
      y *= scaleY;
      z *= scaleZ;

      const taperFactorY = 1.0 - taperY * ny;
      const taperFactorX = 1.0 - taperX * nx;
      const taperFactorZ = 1.0 - taperZ * nz;
      x *= taperFactorY * taperFactorX;
      z *= taperFactorY * taperFactorZ;

      const twistAngle = twistAmount * ny;
      const cosT = Math.cos(twistAngle);
      const sinT = Math.sin(twistAngle);
      const rx = x * cosT - z * sinT;
      const rz = x * sinT + z * cosT;
      x = rx;
      z = rz;

      x += bendX * y * y;
      z += bendZ * y * y;

      x += asymOffsetX * (1.0 - Math.abs(ny));
      y += asymOffsetY;
      z += asymOffsetZ * (1.0 - Math.abs(ny));

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

      const largeDetail = fbm3D(nx * 3 + seed, ny * 3 + seed * 0.7, nz * 3 + seed * 0.3, 2) * 0.12;
      const mediumDetail = fbm3D(nx * 6 + seed * 2, ny * 6 + seed * 1.5, nz * 6 + seed, 2) * 0.06;
      const smallDetail = noise3D(nx * 12 + seed * 3, ny * 12 + seed * 2.5, nz * 12) * 0.03;
      const surfaceDisp = largeDetail + mediumDetail + smallDetail;
      x += nx * surfaceDisp;
      y += ny * surfaceDisp;
      z += nz * surfaceDisp;

      positions[i] = x;
      positions[i + 1] = y;
      positions[i + 2] = z;
    }

    posAttr.needsUpdate = true;
    geometry.computeVertexNormals();

    setRockVertexColors(geometry, seed);
    return geometry;
  }

  private generateTree(): THREE.BufferGeometry {
    const seed = this.params.seed;
    const geometries: THREE.BufferGeometry[] = [];

    // === Trunk parameters ===
    const trunkHeight = 0.8 + Math.abs(noise3D(seed, 0, 0)) * 1.2;
    const trunkThickness = 0.025 + Math.abs(noise3D(0, seed, 0)) * 0.04;
    const trunkTaper = 0.25 + Math.abs(noise3D(0, 0, seed)) * 0.45;
    const trunkBendX = noise3D(seed * 2, 0, 0) * 0.3;
    const trunkBendZ = noise3D(0, 0, seed * 2) * 0.3;
    const trunkTwist = noise3D(seed * 3, seed * 0.5, 0) * 0.5;

    const trunkGeo = new THREE.CylinderGeometry(
      trunkThickness * trunkTaper,
      trunkThickness,
      trunkHeight,
      8,
      8
    );

    // Trunk deformation
    const trunkPositions = trunkGeo.getAttribute("position").array as Float32Array;
    const halfHeight = trunkHeight / 2;

    for (let i = 0; i < trunkPositions.length; i += 3) {
      let x = trunkPositions[i];
      const y = trunkPositions[i + 1];
      let z = trunkPositions[i + 2];

      const t = (y + halfHeight) / trunkHeight;

      x += trunkBendX * t * t;
      z += trunkBendZ * t * t;

      const twistAngle = trunkTwist * t;
      const cosT = Math.cos(twistAngle);
      const sinT = Math.sin(twistAngle);
      const rx = x * cosT - z * sinT;
      const rz = x * sinT + z * cosT;
      x = rx;
      z = rz;

      const bark = fbm3D(x * 20 + seed, y * 10, z * 20 + seed, 2) * 0.015;
      x += bark;
      z += bark;

      trunkPositions[i] = x;
      trunkPositions[i + 1] = y;
      trunkPositions[i + 2] = z;
    }
    trunkGeo.getAttribute("position").needsUpdate = true;
    trunkGeo.computeVertexNormals();

    // Translate trunk up so bottom is at y=0
    const trunkTranslate = new THREE.Matrix4().makeTranslation(0, trunkHeight / 2, 0);
    trunkGeo.applyMatrix4(trunkTranslate);

    setBarkVertexColors(trunkGeo, seed, false);
    ensureAttributes(trunkGeo);
    geometries.push(trunkGeo);

    // === Branch parameters ===
    const branchCount = 3 + Math.floor(Math.abs(noise3D(seed * 4, seed, 0)) * 4);
    const branchStartY =
      trunkHeight * (0.35 + Math.abs(noise3D(seed * 4.5, 0, 0)) * 0.2);

    for (let i = 0; i < branchCount; i++) {
      const bSeed = seed + i * 73.1;
      const heightRatio = i / Math.max(branchCount - 1, 1);
      const branchLength =
        (0.2 + Math.abs(noise3D(bSeed, 0, 0)) * 0.25) * (1.15 - heightRatio * 0.4);
      const branchThick =
        (0.025 + Math.abs(noise3D(0, bSeed, 0)) * 0.02) * (1.2 - heightRatio * 0.3);

      const goldenAngle = Math.PI * (3 - Math.sqrt(5));
      const branchAngleH = i * goldenAngle + noise3D(0, 0, bSeed) * 0.4;
      const branchAngleV =
        0.35 + heightRatio * 0.35 + Math.abs(noise3D(bSeed * 2, 0, 0)) * 0.25;

      const branchY =
        branchStartY + heightRatio * (trunkHeight * 0.85 - branchStartY);

      const t = branchY / trunkHeight;
      const trunkRadiusAtY = trunkThickness * (1 - t * (1 - trunkTaper));
      const bendOffsetX = trunkBendX * t * t;
      const bendOffsetZ = trunkBendZ * t * t;

      const branchStartOffset = trunkRadiusAtY * 0.3;
      const branchStartX =
        bendOffsetX + Math.cos(branchAngleH) * branchStartOffset;
      const branchStartZ =
        bendOffsetZ + Math.sin(branchAngleH) * branchStartOffset;

      const cosV = Math.cos(branchAngleV);
      const sinV = Math.sin(branchAngleV);
      const branchDirX = Math.cos(branchAngleH) * cosV;
      const branchDirY = sinV;
      const branchDirZ = Math.sin(branchAngleH) * cosV;

      const branchEndX = branchStartX + branchDirX * branchLength;
      const branchEndY = branchY + branchDirY * branchLength;
      const branchEndZ = branchStartZ + branchDirZ * branchLength;

      const branchCenterX = (branchStartX + branchEndX) / 2;
      const branchCenterY = (branchY + branchEndY) / 2;
      const branchCenterZ = (branchStartZ + branchEndZ) / 2;

      const branchGeo = new THREE.CylinderGeometry(
        branchThick * 0.5,
        branchThick,
        branchLength,
        6,
        4
      );

      // Apply curvature deformation to branch
      const branchPositions = branchGeo.getAttribute("position").array as Float32Array;
      const halfLen = branchLength / 2;
      const droopAmount = 0.08 + Math.abs(noise3D(bSeed * 7.3, 0, 0)) * 0.12;
      const sideBend = (noise3D(0, bSeed * 8.1, 0) - 0.5) * 0.06;

      for (let vi = 0; vi < branchPositions.length; vi += 3) {
        let bx = branchPositions[vi];
        const by = branchPositions[vi + 1];
        let bz = branchPositions[vi + 2];

        const bt = (by + halfLen) / branchLength;
        bz += droopAmount * bt * bt * branchLength;
        bx += sideBend * Math.sin(bt * Math.PI) * branchLength;

        branchPositions[vi] = bx;
        branchPositions[vi + 1] = by;
        branchPositions[vi + 2] = bz;
      }
      branchGeo.getAttribute("position").needsUpdate = true;
      branchGeo.computeVertexNormals();

      // Rotate branch to point in direction
      const branchDirVec = new THREE.Vector3(branchDirX, branchDirY, branchDirZ).normalize();
      const upVec = new THREE.Vector3(0, 1, 0);
      const quat = new THREE.Quaternion();

      const dot = upVec.dot(branchDirVec);
      if (Math.abs(dot + 1) < 0.0001) {
        quat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
      } else if (Math.abs(dot - 1) < 0.0001) {
        quat.identity();
      } else {
        const axis = new THREE.Vector3().crossVectors(upVec, branchDirVec).normalize();
        const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
        quat.setFromAxisAngle(axis, angle);
      }

      // Build transform: rotate then translate
      const branchMatrix = new THREE.Matrix4()
        .makeRotationFromQuaternion(quat)
        .setPosition(branchCenterX, branchCenterY, branchCenterZ);
      branchGeo.applyMatrix4(branchMatrix);

      setBarkVertexColors(branchGeo, bSeed, true);
      ensureAttributes(branchGeo);
      geometries.push(branchGeo);

      // Leaf-card clusters at branch ends
      const leafClusterCount = 1 + Math.floor(Math.abs(noise3D(bSeed * 5, 0, 0)) * 2.2);
      for (let lc = 0; lc < leafClusterCount; lc++) {
        const lcSeed = bSeed + lc * 31.7;
        const clusterRadius =
          (0.06 + Math.abs(noise3D(lcSeed * 1.3, 0, 0)) * 0.12) *
          (1.1 - heightRatio * 0.25);
        const cardCount = 6 + Math.floor(Math.abs(noise3D(0, lcSeed * 1.7, 0)) * 8);

        for (let c = 0; c < cardCount; c++) {
          const cardSeed = lcSeed + c * 19.73;
          const cardWidth =
            clusterRadius * (0.45 + Math.abs(noise3D(cardSeed * 2, 0, 0)) * 0.55);
          const cardHeight =
            clusterRadius * (0.9 + Math.abs(noise3D(0, cardSeed * 2, 0)) * 1.05);

          const cardGeo = createLeafCardGeometry({
            width: cardWidth,
            height: cardHeight,
            seed: cardSeed,
            curve: clusterRadius * 0.35,
          });

          const radial =
            Math.pow(Math.abs(noise3D(cardSeed * 3.1, 0, 0)), 0.7) *
            clusterRadius *
            0.95;
          const theta = (noise3D(0, cardSeed * 4.1, 0) + 0.5) * Math.PI * 2;
          const lift = Math.abs(noise3D(0, 0, cardSeed * 5.1)) * clusterRadius * 0.7;

          const cardX =
            branchEndX + Math.cos(theta) * radial + branchDirX * clusterRadius * 0.08;
          const cardY = branchEndY + lift + branchDirY * clusterRadius * 0.1;
          const cardZ =
            branchEndZ + Math.sin(theta) * radial + branchDirZ * clusterRadius * 0.08;

          const rotY = theta + noise3D(cardSeed * 6.1, 0, 0) * 0.6;
          const rotX = -0.12 + Math.abs(noise3D(0, cardSeed * 6.3, 0)) * 0.45;
          const rotZ = noise3D(0, 0, cardSeed * 6.5) * 0.25;

          const euler = new THREE.Euler(rotX, rotY, rotZ);
          const cardMatrix = new THREE.Matrix4()
            .makeRotationFromEuler(euler)
            .setPosition(cardX, cardY, cardZ);
          cardGeo.applyMatrix4(cardMatrix);

          setLeafVertexColors(cardGeo, cardSeed, heightRatio > 0.7);
          ensureAttributes(cardGeo);
          geometries.push(cardGeo);
        }
      }
    }

    // Top canopy leaf-card clusters
    const topClusterCount = 2 + Math.floor(Math.abs(noise3D(seed * 7, seed, 0)) * 3);
    const trunkTopX = trunkBendX;
    const trunkTopZ = trunkBendZ;
    const trunkTopY = trunkHeight;
    const trunkTopRadius = trunkThickness * trunkTaper;

    for (let i = 0; i < topClusterCount; i++) {
      const tSeed = seed + i * 51.7 + 1000;
      const clusterRadius = 0.08 + Math.abs(noise3D(tSeed * 1.9, 0, 0)) * 0.16;
      const cardCount = 8 + Math.floor(Math.abs(noise3D(0, tSeed * 2.1, 0)) * 8);
      const topTheta =
        i * (Math.PI * 2 / topClusterCount) + noise3D(0, tSeed * 3, 0) * 0.6;
      const topDist = trunkTopRadius * 0.25 + Math.abs(noise3D(tSeed * 4, 0, 0)) * 0.09;
      const clusterCenterX = trunkTopX + Math.cos(topTheta) * topDist;
      const clusterCenterZ = trunkTopZ + Math.sin(topTheta) * topDist;
      const clusterCenterY = trunkTopY + i * 0.04;

      for (let c = 0; c < cardCount; c++) {
        const cardSeed = tSeed + c * 17.11;
        const cardWidth =
          clusterRadius * (0.45 + Math.abs(noise3D(cardSeed * 2.4, 0, 0)) * 0.55);
        const cardHeight =
          clusterRadius * (0.95 + Math.abs(noise3D(0, cardSeed * 2.4, 0)) * 1.1);

        const cardGeo = createLeafCardGeometry({
          width: cardWidth,
          height: cardHeight,
          seed: cardSeed,
          curve: clusterRadius * 0.4,
        });

        const radial =
          Math.pow(Math.abs(noise3D(cardSeed * 3.3, 0, 0)), 0.72) *
          clusterRadius *
          1.05;
        const theta = (noise3D(0, cardSeed * 4.7, 0) + 0.5) * Math.PI * 2;
        const cardX = clusterCenterX + Math.cos(theta) * radial;
        const cardY =
          clusterCenterY + Math.abs(noise3D(0, 0, cardSeed * 5.2)) * clusterRadius * 0.85;
        const cardZ = clusterCenterZ + Math.sin(theta) * radial;
        const rotY = theta + noise3D(cardSeed * 6.1, 0, 0) * 0.8;
        const rotX = -0.08 + Math.abs(noise3D(0, cardSeed * 6.7, 0)) * 0.4;
        const rotZ = noise3D(0, 0, cardSeed * 6.9) * 0.28;

        const euler = new THREE.Euler(rotX, rotY, rotZ);
        const cardMatrix = new THREE.Matrix4()
          .makeRotationFromEuler(euler)
          .setPosition(cardX, cardY, cardZ);
        cardGeo.applyMatrix4(cardMatrix);

        setLeafVertexColors(cardGeo, cardSeed, true);
        ensureAttributes(cardGeo);
        geometries.push(cardGeo);
      }
    }

    const merged = BufferGeometryUtils.mergeGeometries(geometries, false);
    for (const geo of geometries) geo.dispose();
    if (merged) {
      return merged;
    }

    return new THREE.BufferGeometry();
  }

  private generateBush(): THREE.BufferGeometry {
    const seed = this.params.seed;
    const geometries: THREE.BufferGeometry[] = [];

    const overallSpread = 0.25 + Math.abs(noise3D(0, seed, 0)) * 0.35;
    const clusterCount = 6 + Math.floor(Math.abs(noise3D(seed * 4, seed, 0)) * 7);

    // Add a few low twigs for structure before leaves.
    const twigCount = 2 + Math.floor(Math.abs(noise3D(seed * 2.2, 0, 0)) * 3);
    for (let i = 0; i < twigCount; i++) {
      const twigSeed = seed + i * 37.13;
      const twigLength = 0.11 + Math.abs(noise3D(twigSeed, 0, 0)) * 0.16;
      const twigRadius = 0.01 + Math.abs(noise3D(0, twigSeed, 0)) * 0.015;
      const twigGeo = new THREE.CylinderGeometry(
        twigRadius * 0.6,
        twigRadius,
        twigLength,
        5
      );

      const yaw = (noise3D(0, twigSeed * 2.1, 0) + 0.5) * Math.PI * 2;
      const pitch = 0.2 + Math.abs(noise3D(twigSeed * 2.3, 0, 0)) * 0.45;

      const euler = new THREE.Euler(0, yaw, pitch);
      const twigMatrix = new THREE.Matrix4()
        .makeRotationFromEuler(euler)
        .setPosition(
          Math.cos(yaw) * 0.04,
          twigLength * 0.35,
          Math.sin(yaw) * 0.04
        );
      twigGeo.applyMatrix4(twigMatrix);

      setBarkVertexColors(twigGeo, twigSeed, true);
      ensureAttributes(twigGeo);
      geometries.push(twigGeo);
    }

    for (let i = 0; i < clusterCount; i++) {
      const iSeed = seed + i * 97.3;
      const radialDist =
        Math.pow(Math.abs(noise3D(iSeed * 3.1, 0, 0)), 0.9) * overallSpread;
      const centerTheta = (noise3D(iSeed * 3.5, 0, 0) + 0.5) * Math.PI * 2;
      const centerX = Math.cos(centerTheta) * radialDist;
      const centerZ = Math.sin(centerTheta) * radialDist;
      const centerY = 0.03 + Math.abs(noise3D(0, iSeed * 3.9, 0)) * 0.16;

      const clusterRadius = 0.08 + Math.abs(noise3D(iSeed * 4.1, 0, 0)) * 0.12;
      const cardCount = 8 + Math.floor(Math.abs(noise3D(0, iSeed * 4.3, 0)) * 11);

      for (let c = 0; c < cardCount; c++) {
        const cardSeed = iSeed + c * 29.17;
        const cardWidth =
          clusterRadius * (0.5 + Math.abs(noise3D(cardSeed * 2.2, 0, 0)) * 0.55);
        const cardHeight =
          clusterRadius * (0.95 + Math.abs(noise3D(0, cardSeed * 2.2, 0)) * 1.0);

        const cardGeo = createLeafCardGeometry({
          width: cardWidth,
          height: cardHeight,
          seed: cardSeed,
          curve: clusterRadius * 0.35,
        });

        const radial =
          Math.pow(Math.abs(noise3D(cardSeed * 3.4, 0, 0)), 0.75) *
          clusterRadius *
          1.05;
        const theta = (noise3D(0, cardSeed * 4.6, 0) + 0.5) * Math.PI * 2;
        const lift = Math.abs(noise3D(0, 0, cardSeed * 5.3)) * clusterRadius * 0.85;

        const cardX = centerX + Math.cos(theta) * radial;
        const cardY = centerY + lift;
        const cardZ = centerZ + Math.sin(theta) * radial;

        const rotY = theta + noise3D(cardSeed * 6.1, 0, 0) * 0.7;
        const rotX = -0.1 + Math.abs(noise3D(0, cardSeed * 6.3, 0)) * 0.5;
        const rotZ = noise3D(0, 0, cardSeed * 6.5) * 0.3;

        const euler = new THREE.Euler(rotX, rotY, rotZ);
        const cardMatrix = new THREE.Matrix4()
          .makeRotationFromEuler(euler)
          .setPosition(cardX, cardY, cardZ);
        cardGeo.applyMatrix4(cardMatrix);

        setLeafVertexColors(cardGeo, cardSeed, false);
        ensureAttributes(cardGeo);
        geometries.push(cardGeo);
      }
    }

    const merged = BufferGeometryUtils.mergeGeometries(geometries, false);
    for (const geo of geometries) geo.dispose();
    if (merged) {
      return merged;
    }

    return new THREE.BufferGeometry();
  }

  private generateGrassClump(): THREE.BufferGeometry {
    const seed = this.params.seed;
    const bladeGeometries: THREE.BufferGeometry[] = [];

    // === Clump parameters ===
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

      const bladeGeo = new THREE.BufferGeometry();
      bladeGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
      bladeGeo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(normals), 3));
      bladeGeo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvs), 2));
      bladeGeo.setIndex(indices);

      // Position and rotate blade
      const angle = (noise3D(iSeed * 2, 0, 0) + 0.5) * Math.PI * 2;
      const distFactor = Math.pow(Math.abs(noise3D(0, iSeed * 2, 0)), 1.0 / clumpDensity);
      const dist = distFactor * clumpSpread;

      const posX = Math.cos(angle) * dist;
      const posZ = Math.sin(angle) * dist;

      const rotY = (noise3D(iSeed, iSeed, 0) + 0.5) * Math.PI * 2;
      const rotX = noise3D(iSeed * 3, 0, 0) * 0.12;
      const rotZ = noise3D(0, iSeed * 3, 0) * 0.1;

      const euler = new THREE.Euler(rotX, rotY, rotZ);
      const bladeMatrix = new THREE.Matrix4()
        .makeRotationFromEuler(euler)
        .setPosition(posX, 0, posZ);
      bladeGeo.applyMatrix4(bladeMatrix);

      setGeometryVertexColor(bladeGeo, 0.35, 0.45, 0.22);
      ensureAttributes(bladeGeo);
      bladeGeometries.push(bladeGeo);
    }

    const merged = BufferGeometryUtils.mergeGeometries(bladeGeometries, false);
    for (const geo of bladeGeometries) geo.dispose();
    if (merged) {
      return merged;
    }

    return new THREE.BufferGeometry();
  }

  private getStructureDimensions(
    defaults: { length: number; width: number; height: number; baySize?: number }
  ): { lengthM: number; widthM: number; heightM: number; baySizeM?: number } {
    const lengthM = Math.max(0.5, this.params.length ?? defaults.length);
    const widthM = Math.max(0.4, this.params.width ?? defaults.width);
    const heightM = Math.max(0.4, this.params.height ?? defaults.height);
    const baySizeM = this.params.baySize ?? defaults.baySize;

    return { lengthM, widthM, heightM, baySizeM };
  }

  private generateHanokGiwa(): THREE.BufferGeometry {
    const dimensions = this.getStructureDimensions({
      length: 10,
      width: 6,
      height: 2.6,
      baySize: 2.4,
    });
    return generateHanokHouseGeometry("giwa", dimensions, this.params.seed);
  }

  private generateHanokChoga(): THREE.BufferGeometry {
    const dimensions = this.getStructureDimensions({
      length: 9,
      width: 5.4,
      height: 2.4,
      baySize: 2.2,
    });
    return generateHanokHouseGeometry("choga", dimensions, this.params.seed);
  }

  private generateFenceSegment(): THREE.BufferGeometry {
    const dimensions = this.getStructureDimensions({
      length: 6,
      width: 0.45,
      height: 1.6,
    });
    return generateFenceSegmentGeometry(dimensions, this.params.seed);
  }

  private generateJangdokdaeSet(): THREE.BufferGeometry {
    const dimensions = this.getStructureDimensions({
      length: 3.2,
      width: 2.2,
      height: 0.8,
    });
    return generateJangdokdaeGeometry(dimensions, this.params.seed);
  }

  private generateDoghouse(): THREE.BufferGeometry {
    const dimensions = this.getStructureDimensions({
      length: 1.7,
      width: 1.2,
      height: 1.3,
    });
    return generateDoghouseGeometry(dimensions, this.params.seed);
  }

  private createMaterial(): void {
    // Determine if this asset needs wind animation
    const needsWind = isWindAnimatedAsset(this.params.type);

    if (needsWind) {
      // Wind settings vary by type
      let windStrength = DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.baseStrength;
      let minWindHeight = 0.0;
      let maxWindHeight = 0.8;

      if (this.params.type === "grass_clump") {
        windStrength = DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.grassClumpStrength;
        minWindHeight = 0.0;
        maxWindHeight = 0.7;
      } else if (this.params.type === "bush") {
        windStrength = DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.bushStrength;
        minWindHeight = 0.0;
        maxWindHeight = 0.3;
      } else if (this.params.type === "tree") {
        windStrength = DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.treeStrength;
        minWindHeight = 1.2;
        maxWindHeight = 2.5;
      }

      const windAngle = DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.directionRadians;

      // Load dirt texture for bark triplanar mapping
      const dirtTex = loadTextureWithFallbackSync(
        DEFAULT_FOLIAGE_QUALITY_PROFILE.textures.dirt,
        {
          preferredExtensions: ["ktx2", "jpg", "png"],
          wrapS: THREE.RepeatWrapping,
          wrapT: THREE.RepeatWrapping,
          anisotropy: 8,
        }
      );

      const leafAtlas = loadTextureWithFallbackSync(
        DEFAULT_FOLIAGE_QUALITY_PROFILE.textures.leafAtlas,
        {
          preferredExtensions: ["png", "ktx2", "jpg"],
          wrapS: THREE.ClampToEdgeWrapping,
          wrapT: THREE.ClampToEdgeWrapping,
          anisotropy: 4,
        }
      );

      this.material = new THREE.ShaderMaterial({
        vertexShader: foliageWindVertexShader,
        fragmentShader: foliageWindFragmentShader,
        side: THREE.DoubleSide,
        uniforms: {
          uTime: { value: 0 },
          uWindDirection: { value: new THREE.Vector2(Math.cos(windAngle), Math.sin(windAngle)) },
          uWindStrength: { value: windStrength },
          uMinWindHeight: { value: minWindHeight },
          uMaxWindHeight: { value: maxWindHeight },
          uPropsPrimarySpeed: { value: DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.propsPrimarySpeed },
          uPropsSecondarySpeed: { value: DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.propsSecondarySpeed },
          uPropsNoiseSpeed: { value: DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.propsNoiseSpeed },
          baseColor: { value: new THREE.Color(this.params.colorBase.r, this.params.colorBase.g, this.params.colorBase.b) },
          detailColor: { value: new THREE.Color(this.params.colorDetail.r, this.params.colorDetail.g, this.params.colorDetail.b) },
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
          uUseLeafAtlas: { value: this.params.type === "tree" || this.params.type === "bush" ? 1.0 : 0.0 },
          uLeafMaskFromLuma: { value: 1.0 },
        },
      });
    } else if (isKoreanStructureAsset(this.params.type)) {
      this.material = new THREE.ShaderMaterial({
        vertexShader: structureAssetVertexShader,
        fragmentShader: structureAssetFragmentShader,
        side: THREE.DoubleSide,
        uniforms: {
          sunDirection: { value: new THREE.Vector3(0.5, 0.8, 0.3).normalize() },
          ambientIntensity: { value: 0.42 },
          fogColor: { value: new THREE.Color(0.6, 0.75, 0.9) },
          fogDensity: { value: 0.008 },
        },
      });
    } else {
      // Rock uses the static shader with triplanar texture
      const rockTex = loadTextureWithFallbackSync(
        DEFAULT_FOLIAGE_QUALITY_PROFILE.textures.rock,
        {
          preferredExtensions: ["ktx2", "jpg", "png"],
          wrapS: THREE.RepeatWrapping,
          wrapT: THREE.RepeatWrapping,
          anisotropy: 8,
        }
      );

      this.material = new THREE.ShaderMaterial({
        vertexShader: proceduralAssetVertexShader,
        fragmentShader: proceduralAssetFragmentShader,
        side: THREE.DoubleSide,
        uniforms: {
          baseColor: { value: new THREE.Color(this.params.colorBase.r, this.params.colorBase.g, this.params.colorBase.b) },
          detailColor: { value: new THREE.Color(this.params.colorDetail.r, this.params.colorDetail.g, this.params.colorDetail.b) },
          sunDirection: { value: new THREE.Vector3(0.5, 0.8, 0.3).normalize() },
          ambientIntensity: { value: 0.4 },
          fogColor: { value: new THREE.Color(0.6, 0.75, 0.9) },
          fogDensity: { value: 0.008 },
          rockTexture: { value: rockTex },
          textureScale: { value: 1.0 },
        },
      });
    }
  }

  /**
   * Update time uniform for wind animation. Call from render loop.
   */
  update(deltaTime: number): void {
    if (this.material && this.material.uniforms.uTime) {
      this.material.uniforms.uTime.value += deltaTime;
    }
  }

  getMesh(): THREE.Mesh | null {
    return this.mesh;
  }

  getParams(): AssetParams {
    return { ...this.params };
  }

  updateParams(params: Partial<AssetParams>): void {
    this.params = { ...this.params, ...params };
  }

  randomizeSeed(): void {
    this.params.seed = Math.random() * 10000;
  }

  dispose(): void {
    if (this.mesh) {
      if (this.scene && typeof this.scene.remove === "function") {
        this.scene.remove(this.mesh);
      }
      this.mesh.geometry?.dispose();
      if (this.material) {
        // Dispose textures in shader material uniforms
        for (const key of Object.keys(this.material.uniforms)) {
          const val = this.material.uniforms[key].value;
          if (val instanceof THREE.Texture) {
            val.dispose();
          }
        }
        this.material.dispose();
        this.material = null;
      }
      this.mesh = null;
    }
  }
}
