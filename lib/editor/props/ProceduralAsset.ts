import {
  Scene,
  Mesh,
  MeshBuilder,
  ShaderMaterial,
  Effect,
  Vector3,
  Vector2,
  Color3,
  VertexData,
  VertexBuffer,
  Quaternion,
} from "@babylonjs/core";
import * as BABYLON from "@babylonjs/core";
import { loadTextureWithFallback } from "../../shared/rendering/TextureLoader";
import { DEFAULT_FOLIAGE_QUALITY_PROFILE } from "../../shared/foliage/FoliageQualityProfile";
import { createLeafCardMesh } from "../../shared/foliage/LeafCards";
import { fbm3D, noise3D } from "../../shared/math/NoiseUtils";

// ============================================
// Wind-enabled vertex shader for foliage (grass, bush, tree leaves)
// ============================================
Effect.ShadersStore["foliageWindVertexShader"] = `
precision highp float;

attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
attribute vec4 color;  // Vertex color (RGBA)

uniform mat4 worldViewProjection;
uniform mat4 world;
uniform vec3 cameraPosition;
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
    vec4 worldPos = world * vec4(position, 1.0);
    vec3 localPos = position;

    // Height factor: higher vertices move more
    // Uses configurable min/max height for different asset types
    float heightAboveMin = max(0.0, localPos.y - uMinWindHeight);
    float heightRange = max(0.01, uMaxWindHeight - uMinWindHeight);
    float heightFactor = clamp(heightAboveMin / heightRange, 0.0, 1.0);
    heightFactor = heightFactor * heightFactor;  // Quadratic for natural feel

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

    // Apply displacement in wind direction (XZ plane)
    localPos.x += uWindDirection.x * windAmount * 0.15;
    localPos.z += uWindDirection.y * windAmount * 0.15;

    // Slight bend backward (opposite to wind for natural look)
    localPos.y -= windAmount * 0.03;

    vec4 finalWorldPos = world * vec4(localPos, 1.0);
    gl_Position = worldViewProjection * vec4(localPos, 1.0);

    vNormal = normalize(mat3(world) * normal);
    vPosition = finalWorldPos.xyz;
    vLocalPosition = localPos;
    vUV = uv;
    vCameraDistance = length(cameraPosition - finalWorldPos.xyz);
    vViewDirection = normalize(cameraPosition - finalWorldPos.xyz);
    vColor = color;  // Pass vertex color
}
`;

Effect.ShadersStore["foliageWindFragmentShader"] = `
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
}
`;

// ============================================
// Register procedural asset shaders - Per-pixel smooth shading
// ============================================
Effect.ShadersStore["proceduralAssetVertexShader"] = `
precision highp float;

attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;

uniform mat4 worldViewProjection;
uniform mat4 world;
uniform vec3 cameraPosition;

varying vec3 vNormal;
varying vec3 vPosition;
varying vec3 vLocalPosition;
varying vec2 vUV;
varying float vCameraDistance;
varying vec3 vViewDirection;

void main() {
    vec4 worldPos = world * vec4(position, 1.0);
    gl_Position = worldViewProjection * vec4(position, 1.0);

    vNormal = normalize(mat3(world) * normal);
    vPosition = worldPos.xyz;
    vLocalPosition = position;
    vUV = uv;
    vCameraDistance = length(cameraPosition - worldPos.xyz);
    vViewDirection = normalize(cameraPosition - worldPos.xyz);
}
`;

Effect.ShadersStore["proceduralAssetFragmentShader"] = `
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
    // Screen-space derivatives로 부드러운 노멀 계산
    vec3 dPdx = dFdx(vPosition);
    vec3 dPdy = dFdy(vPosition);
    vec3 geometricNormal = normalize(cross(dPdx, dPdy));

    // 버텍스 노멀
    vec3 smoothNormal = normalize(vNormal);

    // === Edge Detection (노멀 변화량 감지) ===
    vec3 dNdx = dFdx(smoothNormal);
    vec3 dNdy = dFdy(smoothNormal);
    float edgeStrength = length(dNdx) + length(dNdy);

    // 엣지 강도를 0~1로 정규화 (임계값 조정)
    float edgeFactor = smoothstep(0.1, 0.5, edgeStrength);

    // === Edge Blending (Make Seamless 방식) ===
    // 엣지에서는 geometric normal을 더 많이 사용 (부드러운 전환)
    // 비엣지에서는 vertex normal 유지 (디테일 보존)
    float blendRatio = mix(0.9, 0.5, edgeFactor);  // 엣지일수록 geometric 비중 높임
    vec3 normal = normalize(mix(geometricNormal, smoothNormal, blendRatio));

    // Per-pixel 노멀 perturbation (미세한 표면 디테일)
    float noiseScale = 8.0;
    float noiseStrength = 0.12;  // 엣지 블렌딩과 조화롭게 약간 줄임
    vec3 noisePos = vLocalPosition * noiseScale;

    float nx = fbm(noisePos + vec3(0.1, 0.0, 0.0)) - fbm(noisePos - vec3(0.1, 0.0, 0.0));
    float ny = fbm(noisePos + vec3(0.0, 0.1, 0.0)) - fbm(noisePos - vec3(0.0, 0.1, 0.0));
    float nz = fbm(noisePos + vec3(0.0, 0.0, 0.1)) - fbm(noisePos - vec3(0.0, 0.0, 0.1));
    vec3 noisePerturbation = normalize(vec3(nx, ny, nz)) * noiseStrength;

    // 엣지에서는 perturbation 줄이기 (더 부드럽게)
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

    // Tone mapping (matching terrain shader)
    color = color / (color + vec3(1.0)) * 1.1;
    color = pow(color, vec3(0.95));

    gl_FragColor = vec4(color, 1.0);
}
`;

export type AssetType = "rock" | "tree" | "bush" | "grass_clump";

export interface AssetParams {
  type: AssetType;
  seed: number;
  size: number;           // Base size
  sizeVariation: number;  // 0-1, how much size can vary
  noiseScale: number;     // Noise frequency
  noiseAmplitude: number; // Noise strength
  colorBase: Color3;
  colorDetail: Color3;
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
    colorBase: new Color3(0.35, 0.33, 0.30),
    colorDetail: new Color3(0.50, 0.48, 0.45),
  },
  tree: {
    type: "tree",
    seed: Math.random() * 10000,
    size: 3.0,
    sizeVariation: 0.4,
    noiseScale: 2.0,
    noiseAmplitude: 0.15,
    colorBase: new Color3(0.30, 0.42, 0.18),
    colorDetail: new Color3(0.42, 0.52, 0.25),
  },
  bush: {
    type: "bush",
    seed: Math.random() * 10000,
    size: 0.8,
    sizeVariation: 0.3,
    noiseScale: 4.0,
    noiseAmplitude: 0.25,
    colorBase: new Color3(0.28, 0.40, 0.16),
    colorDetail: new Color3(0.38, 0.48, 0.22),
  },
  grass_clump: {
    type: "grass_clump",
    seed: Math.random() * 10000,
    size: 0.4,
    sizeVariation: 0.2,
    noiseScale: 5.0,
    noiseAmplitude: 0.1,
    colorBase: new Color3(0.25, 0.38, 0.14),
    colorDetail: new Color3(0.40, 0.50, 0.22),
  },
};

// Size-based subdivision calculation
function calcSubdivision(size: number, base: number = 4, override?: number): number {
  if (override !== undefined) {
    return Math.max(1, Math.min(6, override));  // clamp 1~6
  }
  // size 1.0 → base, size 2.0 → base+1, size 4.0 → base+2
  const subdiv = Math.floor(base + Math.log2(Math.max(size, 0.25)));
  return Math.max(3, Math.min(6, subdiv));  // clamp 3~6
}

// Helper to add vertex colors to a mesh
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

/**
 * 바위에 자연스러운 그라데이션 색상 적용
 * - 위쪽: 이끼/지의류 (녹색-회색)
 * - 측면: 회갈색 바위
 * - 아래쪽: 어둡고 습한 느낌
 * - 노이즈로 자연스러운 변화
 */
function setRockVertexColors(mesh: Mesh, seed: number): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) return;

  const vertexCount = positions.length / 3;
  const colors = new Float32Array(vertexCount * 4);

  // 바위 기본 색상 팔레트
  const baseRock = { r: 0.45, g: 0.42, b: 0.38 };      // 중간 회갈색
  const darkRock = { r: 0.25, g: 0.23, b: 0.20 };      // 어두운 바닥
  const lightRock = { r: 0.60, g: 0.58, b: 0.52 };     // 밝은 하이라이트
  const mossColor = { r: 0.35, g: 0.45, b: 0.30 };     // 이끼 녹색
  const lichColor = { r: 0.55, g: 0.58, b: 0.45 };     // 지의류 연녹색

  // 바운딩 박스 계산
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

    // 정규화된 높이 (0 = 바닥, 1 = 꼭대기)
    const heightT = (y - minY) / heightRange;

    // 노말 추정 (중심에서 바깥 방향)
    const len = Math.sqrt(x * x + y * y + z * z) || 1;
    const ny = y / len;  // 위를 향하는 정도 (-1 ~ 1)

    // 노이즈 변화
    const noise1 = noise3D(x * 8 + seed, y * 8, z * 8) * 0.5 + 0.5;  // 0~1
    const noise2 = noise3D(x * 15 + seed * 2, y * 15, z * 15) * 0.5 + 0.5;
    const noise3Val = fbm3D(x * 3 + seed * 0.5, y * 3, z * 3, 2) * 0.5 + 0.5;

    // 이끼/지의류 강도 (위쪽에 더 많음)
    const mossStrength = Math.max(0, ny * 0.5 + 0.3) * noise3Val * (heightT > 0.4 ? 1 : heightT / 0.4);
    const lichStrength = Math.max(0, ny * 0.3 + 0.2) * noise1 * 0.5;

    // 기본 색상 (높이에 따른 그라데이션)
    let r = baseRock.r;
    let g = baseRock.g;
    let b = baseRock.b;

    // 아래쪽은 어둡게
    const darkFactor = Math.pow(1 - heightT, 1.5) * 0.4;
    r = r * (1 - darkFactor) + darkRock.r * darkFactor;
    g = g * (1 - darkFactor) + darkRock.g * darkFactor;
    b = b * (1 - darkFactor) + darkRock.b * darkFactor;

    // 위쪽 하이라이트
    const lightFactor = Math.pow(heightT, 2) * 0.3 * noise2;
    r = r * (1 - lightFactor) + lightRock.r * lightFactor;
    g = g * (1 - lightFactor) + lightRock.g * lightFactor;
    b = b * (1 - lightFactor) + lightRock.b * lightFactor;

    // 이끼 색상 혼합
    r = r * (1 - mossStrength) + mossColor.r * mossStrength;
    g = g * (1 - mossStrength) + mossColor.g * mossStrength;
    b = b * (1 - mossStrength) + mossColor.b * mossStrength;

    // 지의류 색상 혼합
    r = r * (1 - lichStrength) + lichColor.r * lichStrength;
    g = g * (1 - lichStrength) + lichColor.g * lichStrength;
    b = b * (1 - lichStrength) + lichColor.b * lichStrength;

    // 미세 노이즈 변화
    const microNoise = (noise2 - 0.5) * 0.08;
    r = Math.max(0, Math.min(1, r + microNoise));
    g = Math.max(0, Math.min(1, g + microNoise * 0.8));
    b = Math.max(0, Math.min(1, b + microNoise * 0.6));

    colors[i * 4] = r;
    colors[i * 4 + 1] = g;
    colors[i * 4 + 2] = b;
    colors[i * 4 + 3] = 1.0;
  }

  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
}

/**
 * 나무 줄기/가지에 자연스러운 나무껍질 색상 적용
 * - 아래쪽: 어둡고 이끼가 낀 느낌
 * - 위쪽: 밝은 나무껍질
 * - 노이즈로 나무껍질 질감
 */
function setBarkVertexColors(mesh: Mesh, seed: number, isBranch: boolean = false): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) return;

  const vertexCount = positions.length / 3;
  const colors = new Float32Array(vertexCount * 4);

  // 나무껍질 색상 팔레트
  const darkBark = { r: 0.38, g: 0.30, b: 0.20 };      // 어두운 나무껍질
  const midBark = { r: 0.52, g: 0.42, b: 0.28 };       // 중간 톤 (terrain dirt)
  const lightBark = { r: 0.62, g: 0.52, b: 0.36 };     // 밝은 나무껍질
  const mossBark = { r: 0.35, g: 0.40, b: 0.25 };      // 이끼 낀 부분

  // 바운딩 박스 계산
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

    // 정규화된 높이
    const heightT = (y - minY) / heightRange;

    // 노이즈 (나무껍질 패턴)
    const barkNoise = noise3D(x * 20 + seed, y * 5, z * 20 + seed * 0.5) * 0.5 + 0.5;
    const stripNoise = Math.sin(y * 30 + noise3D(x * 10, y * 2, z * 10) * 3) * 0.5 + 0.5;  // 세로 줄무늬
    const mossNoise = fbm3D(x * 6 + seed, y * 6, z * 6, 2) * 0.5 + 0.5;

    // 기본 색상 (높이 그라데이션)
    let r, g, b;
    if (heightT < 0.3) {
      // 아래쪽 - 어두운 색
      const t = heightT / 0.3;
      r = darkBark.r * (1 - t) + midBark.r * t;
      g = darkBark.g * (1 - t) + midBark.g * t;
      b = darkBark.b * (1 - t) + midBark.b * t;
    } else {
      // 위쪽 - 밝은 색
      const t = (heightT - 0.3) / 0.7;
      r = midBark.r * (1 - t) + lightBark.r * t;
      g = midBark.g * (1 - t) + lightBark.g * t;
      b = midBark.b * (1 - t) + lightBark.b * t;
    }

    // 나무껍질 질감 (어두운 홈)
    const grooveFactor = (1 - barkNoise) * stripNoise * 0.25;
    r *= (1 - grooveFactor);
    g *= (1 - grooveFactor);
    b *= (1 - grooveFactor);

    // 이끼 (아래쪽에 더 많음, 가지는 적음)
    const mossStrength = (isBranch ? 0.1 : 0.3) * (1 - heightT) * mossNoise;
    r = r * (1 - mossStrength) + mossBark.r * mossStrength;
    g = g * (1 - mossStrength) + mossBark.g * mossStrength;
    b = b * (1 - mossStrength) + mossBark.b * mossStrength;

    colors[i * 4] = Math.max(0, Math.min(1, r));
    colors[i * 4 + 1] = Math.max(0, Math.min(1, g));
    colors[i * 4 + 2] = Math.max(0, Math.min(1, b));
    colors[i * 4 + 3] = 1.0;
  }

  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
}

/**
 * 덤불에 자연스러운 그라데이션 색상 적용
 * - 위쪽: 밝은 연두색 (햇빛)
 * - 아래쪽/안쪽: 어두운 녹색 (그늘)
 * - 덤불은 옆으로 퍼지므로 중심에서 멀수록 밝게
 */
function setBushVertexColors(mesh: Mesh, seed: number): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) return;

  const vertexCount = positions.length / 3;
  const colors = new Float32Array(vertexCount * 4);

  // 덤불 색상 팔레트
  const sunBush = { r: 0.38, g: 0.55, b: 0.22 };       // 햇빛 받는 밝은 녹색
  const shadeBush = { r: 0.15, g: 0.32, b: 0.10 };     // 그늘진 진녹색
  const midBush = { r: 0.28, g: 0.45, b: 0.16 };       // 중간 톤
  const yellowTint = { r: 0.42, g: 0.52, b: 0.18 };    // 노란빛 녹색

  // 바운딩 박스 계산
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

    // 정규화된 위치
    const heightT = (y - minY) / heightRange;
    const xT = (x - minX) / xRange;  // 0~1
    const zT = (z - minZ) / zRange;  // 0~1

    // 중심에서의 거리 (0 = 중심, 1 = 가장자리)
    const centerDistX = Math.abs(xT - 0.5) * 2;
    const centerDistZ = Math.abs(zT - 0.5) * 2;
    const edgeFactor = Math.max(centerDistX, centerDistZ);

    // 노이즈 변화
    const bushNoise = noise3D(x * 15 + seed, y * 15, z * 15 + seed * 0.7) * 0.5 + 0.5;
    const varNoise = fbm3D(x * 6 + seed * 2, y * 6, z * 6, 2) * 0.5 + 0.5;

    // 햇빛 노출도 (위쪽 + 가장자리 = 햇빛)
    const sunExposure = (heightT * 0.6 + edgeFactor * 0.3 + varNoise * 0.2);

    // 기본 색상 (햇빛 노출도에 따라)
    let r, g, b;
    if (sunExposure > 0.6) {
      // 밝은 부분 (햇빛)
      const t = (sunExposure - 0.6) / 0.4;
      r = midBush.r * (1 - t) + sunBush.r * t;
      g = midBush.g * (1 - t) + sunBush.g * t;
      b = midBush.b * (1 - t) + sunBush.b * t;
    } else if (sunExposure > 0.3) {
      // 중간 부분
      const t = (sunExposure - 0.3) / 0.3;
      r = shadeBush.r * (1 - t) + midBush.r * t;
      g = shadeBush.g * (1 - t) + midBush.g * t;
      b = shadeBush.b * (1 - t) + midBush.b * t;
    } else {
      // 어두운 부분 (그늘)
      r = shadeBush.r;
      g = shadeBush.g;
      b = shadeBush.b;
    }

    // 노란빛 변화 (랜덤 포인트)
    const yellowFactor = bushNoise * bushNoise * 0.2;
    r = r * (1 - yellowFactor) + yellowTint.r * yellowFactor;
    g = g * (1 - yellowFactor) + yellowTint.g * yellowFactor;
    b = b * (1 - yellowFactor) + yellowTint.b * yellowFactor;

    // 미세 노이즈 변화
    const microVar = (bushNoise - 0.5) * 0.06;
    r = Math.max(0, Math.min(1, r + microVar * 0.5));
    g = Math.max(0, Math.min(1, g + microVar));
    b = Math.max(0, Math.min(1, b + microVar * 0.3));

    colors[i * 4] = r;
    colors[i * 4 + 1] = g;
    colors[i * 4 + 2] = b;
    colors[i * 4 + 3] = 1.0;
  }

  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
}

/**
 * 나뭇잎에 자연스러운 그라데이션 색상 적용
 * - 위쪽 (햇빛): 밝은 연두색
 * - 아래쪽 (그늘): 어두운 녹색
 * - 노이즈로 잎 변화
 */
function setLeafVertexColors(mesh: Mesh, seed: number, isTop: boolean = false): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) return;

  const vertexCount = positions.length / 3;
  const colors = new Float32Array(vertexCount * 4);

  // 나뭇잎 색상 팔레트
  const sunLeaf = { r: 0.40, g: 0.52, b: 0.24 };       // 햇빛 받는 올리브
  const shadeLeaf = { r: 0.18, g: 0.30, b: 0.12 };     // 그늘진 진녹색
  const yellowLeaf = { r: 0.45, g: 0.50, b: 0.20 };    // 살짝 노란 올리브
  const freshLeaf = { r: 0.32, g: 0.45, b: 0.20 };     // 싱싱한 올리브

  // 바운딩 박스 계산
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

    // 정규화된 높이 (잎 내에서)
    const heightT = (y - minY) / heightRange;

    // 노이즈 변화
    const leafNoise = noise3D(x * 12 + seed, y * 12, z * 12 + seed * 0.7) * 0.5 + 0.5;
    const varNoise = fbm3D(x * 5 + seed * 2, y * 5, z * 5, 2) * 0.5 + 0.5;

    // 기본 색상 (높이 그라데이션 - 위가 밝음)
    let r, g, b;
    const sunFactor = heightT * 0.7 + varNoise * 0.3;  // 위쪽일수록 + 랜덤 변화

    if (sunFactor > 0.6) {
      // 밝은 부분 (햇빛)
      const t = (sunFactor - 0.6) / 0.4;
      r = freshLeaf.r * (1 - t) + sunLeaf.r * t;
      g = freshLeaf.g * (1 - t) + sunLeaf.g * t;
      b = freshLeaf.b * (1 - t) + sunLeaf.b * t;
    } else if (sunFactor > 0.3) {
      // 중간 부분
      const t = (sunFactor - 0.3) / 0.3;
      r = shadeLeaf.r * (1 - t) + freshLeaf.r * t;
      g = shadeLeaf.g * (1 - t) + freshLeaf.g * t;
      b = shadeLeaf.b * (1 - t) + freshLeaf.b * t;
    } else {
      // 어두운 부분 (그늘)
      r = shadeLeaf.r;
      g = shadeLeaf.g;
      b = shadeLeaf.b;
    }

    // 노란빛 변화 (꼭대기 잎은 더 밝게)
    if (isTop) {
      const yellowFactor = leafNoise * 0.25;
      r = r * (1 - yellowFactor) + yellowLeaf.r * yellowFactor;
      g = g * (1 - yellowFactor) + yellowLeaf.g * yellowFactor;
      b = b * (1 - yellowFactor) + yellowLeaf.b * yellowFactor;
    }

    // 미세 노이즈 변화
    const microVar = (leafNoise - 0.5) * 0.08;
    r = Math.max(0, Math.min(1, r + microVar * 0.5));
    g = Math.max(0, Math.min(1, g + microVar));
    b = Math.max(0, Math.min(1, b + microVar * 0.3));

    colors[i * 4] = r;
    colors[i * 4 + 1] = g;
    colors[i * 4 + 2] = b;
    colors[i * 4 + 3] = 1.0;
  }

  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
}

export class ProceduralAsset {
  private scene: Scene;
  private mesh: Mesh | null = null;
  private material: ShaderMaterial | null = null;
  private params: AssetParams;

  constructor(scene: Scene, params: AssetParams) {
    this.scene = scene;
    this.params = { ...params };
  }

  generate(): Mesh {
    this.dispose();

    switch (this.params.type) {
      case "rock":
        this.mesh = this.generateRock();
        break;
      case "tree":
        this.mesh = this.generateTree();
        break;
      case "bush":
        this.mesh = this.generateBush();
        break;
      case "grass_clump":
        this.mesh = this.generateGrassClump();
        break;
    }

    this.createMaterial();
    if (this.mesh && this.material) {
      this.mesh.material = this.material;
    }

    return this.mesh!;
  }

  /**
   * 바위 생성 - 형태 공간 탐색:
   *
   * 1. 기본 비율 (elongation): 어느 축으로 늘어나는지
   *    - 기둥형: Y축이 긴 형태
   *    - 판형: Y축이 짧은 납작한 형태
   *    - 구형: 모든 축이 비슷
   *
   * 2. 테이퍼 (taper): 한쪽이 좁아지는 정도
   *    - 역삼각형: 위가 넓고 아래가 좁음
   *    - 쐐기형: 한쪽 방향으로 뾰족해짐
   *
   * 3. 비대칭 (asymmetry): 무게중심이 치우친 정도
   *    - 한쪽으로 볼록하게 튀어나옴
   *
   * 4. 비틀림 (twist): 높이에 따라 회전하는 정도
   *
   * 5. 굴곡 (bend): 전체적으로 휘어진 정도
   *
   * 6. 표면 거칠기: 작은 범프와 홈
   */
  private generateRock(): Mesh {
    const seed = this.params.seed;
    const subdivisions = calcSubdivision(this.params.size, 4, this.params.subdivisionOverride);

    const rock = MeshBuilder.CreateIcoSphere(
      "rock_" + seed,
      { radius: 0.5, subdivisions, flat: false, updatable: true },
      this.scene
    );

    // === 형태 파라미터 (seed에서 추출) - 자연스러운 범위 ===

    // 1. 기본 비율 - 각 축의 스케일
    const scaleX = 0.5 + Math.abs(noise3D(seed * 1.0, 0, 0)) * 1.2;      // 0.5 ~ 1.7
    const scaleY = 0.4 + Math.abs(noise3D(0, seed * 1.1, 0)) * 1.6;      // 0.4 ~ 2.0 (납작 ~ 길쭉)
    const scaleZ = 0.5 + Math.abs(noise3D(0, 0, seed * 1.2)) * 1.2;      // 0.5 ~ 1.7

    // 2. 테이퍼 - 높이에 따라 좁아지는 정도
    const taperY = noise3D(seed * 2.0, seed * 0.5, 0) * 0.7;             // -0.7 ~ 0.7
    const taperX = noise3D(seed * 2.1, 0, seed * 0.5) * 0.4;             // X방향 테이퍼
    const taperZ = noise3D(0, seed * 2.2, seed * 0.6) * 0.4;             // Z방향 테이퍼

    // 3. 비대칭 - 무게중심 오프셋
    const asymOffsetX = noise3D(seed * 3.0, seed * 0.3, 0) * 0.35;
    const asymOffsetY = noise3D(seed * 0.3, seed * 3.1, 0) * 0.25;
    const asymOffsetZ = noise3D(0, seed * 0.3, seed * 3.2) * 0.35;

    // 4. 비틀림 - 높이에 따른 회전량
    const twistAmount = noise3D(seed * 4.0, seed * 0.7, seed * 0.3) * 0.6;  // -0.6 ~ 0.6 라디안 (약 ±35도)

    // 5. 굴곡 - 전체 휘어짐
    const bendX = noise3D(seed * 5.0, 0, 0) * 0.4;
    const bendZ = noise3D(0, 0, seed * 5.1) * 0.4;

    // 6. 뾰족함 정도
    const peakDirX = noise3D(seed * 6.0, seed * 0.2, 0);
    const peakDirY = noise3D(seed * 0.2, seed * 6.1, 0);
    const peakDirZ = noise3D(0, seed * 0.2, seed * 6.2);
    const peakLen = Math.sqrt(peakDirX * peakDirX + peakDirY * peakDirY + peakDirZ * peakDirZ);
    const peakStrength = 0.1 + Math.abs(noise3D(seed * 6.5, seed * 6.6, seed * 6.7)) * 0.4;  // 0.1 ~ 0.5



    const positions = rock.getVerticesData(VertexBuffer.PositionKind);
    if (positions) {
      const newPositions = new Float32Array(positions.length);

      for (let i = 0; i < positions.length; i += 3) {
        let x = positions[i];
        let y = positions[i + 1];
        let z = positions[i + 2];

        // 정규화 (구 표면의 방향)
        const len = Math.sqrt(x * x + y * y + z * z);
        const nx = x / len;
        const ny = y / len;
        const nz = z / len;

        // === 형태 변형 적용 ===

        // 1. 기본 비율 적용
        x *= scaleX;
        y *= scaleY;
        z *= scaleZ;

        // 2. 테이퍼 적용 (높이에 따라 좁아짐)
        const taperFactorY = 1.0 - taperY * ny;  // ny가 +1이면 위, -1이면 아래
        const taperFactorX = 1.0 - taperX * nx;
        const taperFactorZ = 1.0 - taperZ * nz;
        x *= taperFactorY * taperFactorX;
        z *= taperFactorY * taperFactorZ;

        // 3. 비틀림 적용 (y 높이에 따라 xz 평면에서 회전)
        const twistAngle = twistAmount * ny;
        const cosT = Math.cos(twistAngle);
        const sinT = Math.sin(twistAngle);
        const rx = x * cosT - z * sinT;
        const rz = x * sinT + z * cosT;
        x = rx;
        z = rz;

        // 4. 굴곡 적용 (높이에 따라 옆으로 휨)
        x += bendX * y * y;
        z += bendZ * y * y;

        // 5. 비대칭 오프셋 (전체적으로 한쪽으로 밀림)
        x += asymOffsetX * (1.0 - Math.abs(ny));  // 중간 높이에서 가장 많이
        y += asymOffsetY;
        z += asymOffsetZ * (1.0 - Math.abs(ny));

        // 6. 뾰족한 부분 (특정 방향으로 튀어나옴)
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

        // === 표면 디테일 ===
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

    // 자연스러운 그라데이션 색상 적용
    setRockVertexColors(rock, seed);

    rock.scaling.setAll(this.params.size);
    return rock;
  }

  /**
   * 나무 생성 - 다양한 형태의 나무
   *
   * - 줄기: 두께, 높이, 휘어짐, 비틀림 다양성
   * - 가지: 뻗어가는 방향, 길이, 두께 다양성
   * - 잎: 덩어리 크기, 형태 다양성
   */
  private generateTree(): Mesh {
    const seed = this.params.seed;
    const meshes: Mesh[] = [];

    // === Trunk parameters ===
    const trunkHeight = 0.8 + Math.abs(noise3D(seed, 0, 0)) * 1.2;
    const trunkThickness = 0.025 + Math.abs(noise3D(0, seed, 0)) * 0.04;
    const trunkTaper = 0.25 + Math.abs(noise3D(0, 0, seed)) * 0.45;
    const trunkBendX = noise3D(seed * 2, 0, 0) * 0.3;
    const trunkBendZ = noise3D(0, 0, seed * 2) * 0.3;
    const trunkTwist = noise3D(seed * 3, seed * 0.5, 0) * 0.5;

    const trunk = MeshBuilder.CreateCylinder(
      "trunk",
      {
        height: trunkHeight,
        diameterTop: trunkThickness * 2 * trunkTaper,
        diameterBottom: trunkThickness * 2,
        tessellation: 8,
        subdivisions: 8,
        updatable: true,
      },
      this.scene
    );

    // Trunk deformation
    const trunkPositions = trunk.getVerticesData(VertexBuffer.PositionKind);
    if (trunkPositions) {
      const newPositions = new Float32Array(trunkPositions.length);
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

        newPositions[i] = x;
        newPositions[i + 1] = y;
        newPositions[i + 2] = z;
      }
      trunk.updateVerticesData(VertexBuffer.PositionKind, newPositions);
    }

    trunk.position.y = trunkHeight / 2;
    setBarkVertexColors(trunk, seed, false);
    meshes.push(trunk);

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

      const branch = MeshBuilder.CreateCylinder(
        "branch_" + i,
        {
          height: branchLength,
          diameterTop: branchThick * 0.5,
          diameterBottom: branchThick,
          tessellation: 6,
          updatable: true,
        },
        this.scene
      );

      const branchDirVec = new Vector3(branchDirX, branchDirY, branchDirZ).normalize();
      const upVec = Vector3.Up();
      const dot = Vector3.Dot(upVec, branchDirVec);
      if (Math.abs(dot + 1) < 0.0001) {
        branch.rotationQuaternion = Quaternion.RotationAxis(Vector3.Right(), Math.PI);
      } else if (Math.abs(dot - 1) < 0.0001) {
        branch.rotationQuaternion = Quaternion.Identity();
      } else {
        const axis = Vector3.Cross(upVec, branchDirVec).normalize();
        const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
        branch.rotationQuaternion = Quaternion.RotationAxis(axis, angle);
      }

      branch.position.x = branchCenterX;
      branch.position.y = branchCenterY;
      branch.position.z = branchCenterZ;
      setBarkVertexColors(branch, bSeed, true);
      meshes.push(branch);

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

          const card = createLeafCardMesh(
            `leaf_card_${i}_${lc}_${c}`,
            this.scene,
            {
              width: cardWidth,
              height: cardHeight,
              seed: cardSeed,
              curve: clusterRadius * 0.35,
            }
          );

          const radial =
            Math.pow(Math.abs(noise3D(cardSeed * 3.1, 0, 0)), 0.7) *
            clusterRadius *
            0.95;
          const theta = (noise3D(0, cardSeed * 4.1, 0) + 0.5) * Math.PI * 2;
          const lift = Math.abs(noise3D(0, 0, cardSeed * 5.1)) * clusterRadius * 0.7;

          card.position.x =
            branchEndX + Math.cos(theta) * radial + branchDirX * clusterRadius * 0.08;
          card.position.y = branchEndY + lift + branchDirY * clusterRadius * 0.1;
          card.position.z =
            branchEndZ + Math.sin(theta) * radial + branchDirZ * clusterRadius * 0.08;

          card.rotation.y = theta + noise3D(cardSeed * 6.1, 0, 0) * 0.6;
          card.rotation.x =
            -0.12 + Math.abs(noise3D(0, cardSeed * 6.3, 0)) * 0.45;
          card.rotation.z = noise3D(0, 0, cardSeed * 6.5) * 0.25;

          setLeafVertexColors(card, cardSeed, heightRatio > 0.7);
          meshes.push(card);
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

        const card = createLeafCardMesh(`top_leaf_card_${i}_${c}`, this.scene, {
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
        card.position.x = clusterCenterX + Math.cos(theta) * radial;
        card.position.y =
          clusterCenterY + Math.abs(noise3D(0, 0, cardSeed * 5.2)) * clusterRadius * 0.85;
        card.position.z = clusterCenterZ + Math.sin(theta) * radial;
        card.rotation.y = theta + noise3D(cardSeed * 6.1, 0, 0) * 0.8;
        card.rotation.x = -0.08 + Math.abs(noise3D(0, cardSeed * 6.7, 0)) * 0.4;
        card.rotation.z = noise3D(0, 0, cardSeed * 6.9) * 0.28;

        setLeafVertexColors(card, cardSeed, true);
        meshes.push(card);
      }
    }

    const merged = Mesh.MergeMeshes(meshes, true, true, undefined, false, true);
    if (merged) {
      merged.name = "tree_" + seed;
      merged.scaling.setAll(this.params.size);
      return merged;
    }

    return new Mesh("tree_" + seed, this.scene);
  }

  private generateBush(): Mesh {
    const seed = this.params.seed;
    const meshes: Mesh[] = [];

    const overallSpread = 0.25 + Math.abs(noise3D(0, seed, 0)) * 0.35;
    const clusterCount = 6 + Math.floor(Math.abs(noise3D(seed * 4, seed, 0)) * 7);

    // Add a few low twigs for structure before leaves.
    const twigCount = 2 + Math.floor(Math.abs(noise3D(seed * 2.2, 0, 0)) * 3);
    for (let i = 0; i < twigCount; i++) {
      const twigSeed = seed + i * 37.13;
      const twigLength = 0.11 + Math.abs(noise3D(twigSeed, 0, 0)) * 0.16;
      const twigRadius = 0.01 + Math.abs(noise3D(0, twigSeed, 0)) * 0.015;
      const twig = MeshBuilder.CreateCylinder(
        `bush_twig_${i}`,
        {
          height: twigLength,
          diameterTop: twigRadius * 0.6,
          diameterBottom: twigRadius,
          tessellation: 5,
        },
        this.scene
      );

      const yaw = (noise3D(0, twigSeed * 2.1, 0) + 0.5) * Math.PI * 2;
      const pitch = 0.2 + Math.abs(noise3D(twigSeed * 2.3, 0, 0)) * 0.45;
      twig.rotation.y = yaw;
      twig.rotation.z = pitch;
      twig.position.x = Math.cos(yaw) * 0.04;
      twig.position.z = Math.sin(yaw) * 0.04;
      twig.position.y = twigLength * 0.35;
      setBarkVertexColors(twig, twigSeed, true);
      meshes.push(twig);
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

        const card = createLeafCardMesh(`bush_leaf_card_${i}_${c}`, this.scene, {
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

        card.position.x = centerX + Math.cos(theta) * radial;
        card.position.y = centerY + lift;
        card.position.z = centerZ + Math.sin(theta) * radial;

        card.rotation.y = theta + noise3D(cardSeed * 6.1, 0, 0) * 0.7;
        card.rotation.x = -0.1 + Math.abs(noise3D(0, cardSeed * 6.3, 0)) * 0.5;
        card.rotation.z = noise3D(0, 0, cardSeed * 6.5) * 0.3;

        setLeafVertexColors(card, cardSeed, false);
        meshes.push(card);
      }
    }

    const merged = Mesh.MergeMeshes(meshes, true, true, undefined, false, true);
    if (merged) {
      merged.name = "bush_" + seed;
      merged.scaling.setAll(this.params.size);
      return merged;
    }

    return new Mesh("bush_" + seed, this.scene);
  }

  private generateGrassClump(): Mesh {
    const seed = this.params.seed;
    const blades: Mesh[] = [];

    // === 전체 뭉치 파라미터 ===
    const clumpDensity = 0.3 + Math.abs(noise3D(seed * 0.5, 0, 0)) * 0.7;           // 0.3 ~ 1.0 밀도
    const clumpSpread = 0.04 + Math.abs(noise3D(0, seed * 0.5, 0)) * 0.16;          // 0.04 ~ 0.2 퍼짐 반경
    const avgHeight = 0.2 + Math.abs(noise3D(0, 0, seed * 0.5)) * 0.5;              // 0.2 ~ 0.7 평균 높이
    const avgWidth = 0.012 + Math.abs(noise3D(seed * 0.6, seed * 0.3, 0)) * 0.028;  // 0.012 ~ 0.04 평균 두께

    // 잎 개수 (밀도 기반)
    const bladeCount = Math.floor(4 + clumpDensity * 12);                            // 4 ~ 16개

    for (let i = 0; i < bladeCount; i++) {
      const iSeed = seed + i * 73.7;

      // === 개별 잎 파라미터 (뭉치 평균 기준 변동) ===
      const heightVar = 0.6 + Math.abs(noise3D(iSeed, 0, 0)) * 0.8;                 // 0.6 ~ 1.4 배율
      const widthVar = 0.7 + Math.abs(noise3D(0, iSeed, 0)) * 0.6;                  // 0.7 ~ 1.3 배율
      const bladeHeight = avgHeight * heightVar;                                     // 실제 높이
      const bladeWidth = avgWidth * widthVar;                                        // 실제 두께

      // 휘어짐 (높이에 비례 + 랜덤)
      const curveBase = 0.02 + Math.abs(noise3D(0, 0, iSeed)) * 0.12;               // 0.02 ~ 0.14
      const bladeCurve = curveBase * (bladeHeight / 0.4);                            // 높이에 비례

      // 곡선 잎 생성 (4단계 높이)
      const h1 = bladeHeight * 0.35;
      const h2 = bladeHeight * 0.65;
      const h3 = bladeHeight * 0.9;
      const h4 = bladeHeight;

      const c1 = bladeCurve * 0.25;
      const c2 = bladeCurve * 0.6;
      const c3 = bladeCurve * 0.9;
      const c4 = bladeCurve;

      // 두께 테이퍼 (위로 갈수록 가늘어짐)
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

      // 법선 계산
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

      // 배치 (밀도에 따른 분포)
      const angle = (noise3D(iSeed * 2, 0, 0) + 0.5) * Math.PI * 2;
      const distFactor = Math.pow(Math.abs(noise3D(0, iSeed * 2, 0)), 1.0 / clumpDensity);  // 밀도 높으면 중심에 몰림
      const dist = distFactor * clumpSpread;

      blade.position.x = Math.cos(angle) * dist;
      blade.position.z = Math.sin(angle) * dist;

      // 회전과 기울기 (살짝만 기울어짐)
      blade.rotation.y = (noise3D(iSeed, iSeed, 0) + 0.5) * Math.PI * 2;
      blade.rotation.x = noise3D(iSeed * 3, 0, 0) * 0.12;                            // -0.12 ~ 0.12 rad (~±7°)
      blade.rotation.z = noise3D(0, iSeed * 3, 0) * 0.1;                             // -0.1 ~ 0.1 rad (~±6°)

      blades.push(blade);
    }

    // Set bright green vertex color for each blade before merging
    for (const blade of blades) {
      setMeshVertexColor(blade, 0.35, 0.45, 0.22);  // Olive green (matching grass biome texture)
    }

    const merged = Mesh.MergeMeshes(blades, true, true, undefined, false, true);
    if (merged) {
      merged.name = "grass_" + seed;
      merged.scaling.setAll(this.params.size);
      return merged;
    }

    const fallback = new Mesh("grass_" + seed, this.scene);
    return fallback;
  }

  private createMaterial(): void {
    // Determine if this asset needs wind animation
    const needsWind = this.params.type === "grass_clump" ||
                      this.params.type === "bush" ||
                      this.params.type === "tree";

    if (needsWind) {
      this.material = new ShaderMaterial(
        "foliageMaterial_" + this.params.seed,
        this.scene,
        {
          vertex: "foliageWind",
          fragment: "foliageWind",
        },
        {
          attributes: ["position", "normal", "uv", "color"],
          uniforms: [
            "worldViewProjection",
            "world",
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
          ],
          samplers: ["dirtTexture", "leafAtlas"],
        }
      );

      // Wind settings
      const windAngle = DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.directionRadians;
      this.material.setVector2("uWindDirection", new Vector2(
        Math.cos(windAngle),
        Math.sin(windAngle)
      ));

      // Wind settings vary by type
      let windStrength = DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.baseStrength;
      let minWindHeight = 0.0;
      let maxWindHeight = 0.8;

      if (this.params.type === "grass_clump") {
        windStrength = DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.grassClumpStrength;
        minWindHeight = 0.0;  // Wind starts at ground
        maxWindHeight = 0.7;  // Full effect at tip
      } else if (this.params.type === "bush") {
        windStrength = DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.bushStrength;
        minWindHeight = 0.0;  // Wind starts at ground
        maxWindHeight = 0.3;  // Bush is low, full effect at top
      } else if (this.params.type === "tree") {
        windStrength = DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.treeStrength;
        minWindHeight = 0.5;  // Wind only affects parts above trunk base
        maxWindHeight = 2.0;  // Leaves are at various heights
      }

      this.material.setFloat("uWindStrength", windStrength);
      this.material.setFloat("uMinWindHeight", minWindHeight);
      this.material.setFloat("uMaxWindHeight", maxWindHeight);
      this.material.setFloat("uPropsPrimarySpeed", DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.propsPrimarySpeed);
      this.material.setFloat("uPropsSecondarySpeed", DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.propsSecondarySpeed);
      this.material.setFloat("uPropsNoiseSpeed", DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.propsNoiseSpeed);
      this.material.setFloat("uTime", 0);

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
      this.material.setTexture("dirtTexture", dirtTex);
      this.material.setFloat("dirtTextureScale", 0.5);

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
      this.material.setTexture("leafAtlas", leafAtlas);
      this.material.setFloat(
        "uLeafAlphaCutoff",
        DEFAULT_FOLIAGE_QUALITY_PROFILE.leafAtlas.alphaCutoff
      );
      this.material.setFloat(
        "uLeafFadeStart",
        DEFAULT_FOLIAGE_QUALITY_PROFILE.fade.leafFadeStart
      );
      this.material.setFloat(
        "uLeafFadeEnd",
        DEFAULT_FOLIAGE_QUALITY_PROFILE.fade.leafFadeEnd
      );
      this.material.setFloat(
        "uUseLeafAtlas",
        this.params.type === "tree" || this.params.type === "bush" ? 1.0 : 0.0
      );
      this.material.setFloat("uLeafMaskFromLuma", 1.0);

    } else {
      // Rock uses the static shader with triplanar texture
      this.material = new ShaderMaterial(
        "assetMaterial_" + this.params.seed,
        this.scene,
        {
          vertex: "proceduralAsset",
          fragment: "proceduralAsset",
        },
        {
          attributes: ["position", "normal", "uv"],
          uniforms: [
            "worldViewProjection",
            "world",
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
      this.material.setTexture("rockTexture", rockTex);
      this.material.setFloat("textureScale", 1.0);
    }

    // Common uniforms
    this.material.setColor3("baseColor", this.params.colorBase);
    this.material.setColor3("detailColor", this.params.colorDetail);
    this.material.setVector3("sunDirection", new Vector3(0.5, 0.8, 0.3).normalize());
    this.material.setFloat("ambientIntensity", 0.4);
    this.material.setColor3("fogColor", new Color3(0.6, 0.75, 0.9));
    this.material.setFloat("fogDensity", 0.008);

    this.material.backFaceCulling = false;

    // Update camera position and time on each render
    const startTime = performance.now();
    this.material.onBindObservable.add(() => {
      const camera = this.scene.activeCamera;
      if (camera && this.material) {
        this.material.setVector3("cameraPosition", camera.position);

        // Update time for wind animation
        if (needsWind) {
          const elapsed = (performance.now() - startTime) / 1000;  // seconds
          this.material.setFloat("uTime", elapsed);
        }
      }
    });
  }

  getMesh(): Mesh | null {
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
    if (this.material) {
      this.material.dispose();
      this.material = null;
    }
    if (this.mesh) {
      this.mesh.dispose();
      this.mesh = null;
    }
  }
}
