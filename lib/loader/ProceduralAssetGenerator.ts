/**
 * ProceduralAssetGenerator - Generates procedural meshes matching the editor
 *
 * This is a port of the editor's ProceduralAsset.ts mesh generation logic
 * for use in the game loader. It creates identical meshes using the same
 * noise functions, vertex colors, and shape deformations.
 */

import {
  Scene,
  Mesh,
  MeshBuilder,
  ShaderMaterial,
  Effect,
  Vector3,
  Vector2,
  Matrix,
  Color3,
  VertexData,
  VertexBuffer,
  Quaternion,
  Texture,
} from "@babylonjs/core";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/loaders/glTF";
import { loadTextureWithFallback } from "../shared/rendering/TextureLoader";
import { DEFAULT_FOLIAGE_QUALITY_PROFILE } from "../shared/foliage/FoliageQualityProfile";
import { createLeafCardMesh } from "../shared/foliage/LeafCards";
import { fbm3D, noise3D } from "../shared/math/NoiseUtils";

const REFERENCE_TREE_ROOT_URL = "/assets/references/infinite-terrain/";
const REFERENCE_TREE_FILE_NAME = "tree.glb";

// ============================================
// Register Shaders
// ============================================

// Wind-enabled vertex shader for foliage (grass, bush, tree leaves)
Effect.ShadersStore["loaderFoliageWindVertexShader"] = `
precision highp float;

attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
attribute vec4 color;

uniform mat4 viewProjection;
uniform mat4 world;
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
    vec4 worldPos = world * vec4(position, 1.0);

    // Height factor (use local Y) - cubic for natural tree sway
    float heightAboveMin = max(0.0, position.y - uMinWindHeight);
    float heightRange = max(0.01, uMaxWindHeight - uMinWindHeight);
    float heightFactor = clamp(heightAboveMin / heightRange, 0.0, 1.0);
    heightFactor = heightFactor * heightFactor * heightFactor;  // Cubic: trunk stays still

    vec2 worldPosXZ = worldPos.xz;
    float windPhase = dot(worldPosXZ, uWindDirection) * 0.5 + uTime * uPropsPrimarySpeed;
    float primaryWave = sin(windPhase) * 0.5 + 0.5;
    float secondaryPhase = dot(worldPosXZ, uWindDirection) * 2.0 + uTime * uPropsSecondarySpeed;
    float secondaryWave = sin(secondaryPhase) * 0.3 + 0.5;
    float noiseVal = noise2D(worldPosXZ * 0.3 + uTime * uPropsNoiseSpeed);
    float windAmount = (primaryWave * 0.7 + secondaryWave * 0.3 + noiseVal * 0.2) * heightFactor * uWindStrength;

    // Apply wind in world space (not local!)
    worldPos.x += uWindDirection.x * windAmount * 0.2;
    worldPos.z += uWindDirection.y * windAmount * 0.2;
    worldPos.y -= windAmount * 0.04;

    gl_Position = viewProjection * worldPos;

    vNormal = normalize(mat3(world) * normal);
    vPosition = worldPos.xyz;
    vLocalPosition = position;
    vUV = uv;
    vCameraDistance = length(cameraPosition - worldPos.xyz);
    vViewDirection = normalize(cameraPosition - worldPos.xyz);
    vColor = color;
}
`;

Effect.ShadersStore["loaderFoliageWindFragmentShader"] = `
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

    vec3 meshColor = vColor.a > 0.5 ? vColor.rgb : baseColor;

    // For leaves: use vertex color directly (like grass shader)
    // For bark: apply subtle noise variation
    float colorNoise = fbm(vPosition * 2.0);
    vec3 color = mix(meshColor, mix(meshColor, meshColor * 0.85, colorNoise * 0.2), 1.0 - leafMask);

    // Triplanar bark texture sampling (for tree trunks/branches)
    vec3 barkBlend = abs(normal);
    barkBlend = barkBlend / (barkBlend.x + barkBlend.y + barkBlend.z);
    vec3 dirtTexX = texture2D(dirtTexture, vPosition.yz * dirtTextureScale).rgb;
    vec3 dirtTexY = texture2D(dirtTexture, vPosition.xz * dirtTextureScale).rgb;
    vec3 dirtTexZ = texture2D(dirtTexture, vPosition.xy * dirtTextureScale).rgb;
    vec3 dirtSample = dirtTexX * barkBlend.x + dirtTexY * barkBlend.y + dirtTexZ * barkBlend.z;

    // Apply bark texture where R > G (bark vertices)
    float isBark = step(vColor.g, vColor.r);
    color = mix(color, mix(color, dirtSample, 0.4), isBark);

    float NdotL = dot(normal, sunDirection);
    float halfLambert = NdotL * 0.5 + 0.5;
    halfLambert = halfLambert * halfLambert;

    float rimFactor = 1.0 - max(dot(normal, vViewDirection), 0.0);
    rimFactor = pow(rimFactor, 3.0) * 0.08;

    // Fresnel rim light for leaves
    float ndv = clamp(dot(normal, vViewDirection), 0.0, 1.0);
    float fresnel = pow(1.0 - ndv, uFresnelPower) * uFresnelStrength;

    // Subsurface scattering approximation (tipFactor for leaves only)
    float tipFactor = smoothstep(0.0, 0.6, vLocalPosition.y) * leafMask;
    float sss = max(0.0, dot(-vViewDirection, sunDirection)) * tipFactor * 0.15;

    float diffuse = halfLambert * 0.6 + 0.4;
    vec3 ambient = vec3(ambientIntensity);
    vec3 rim = vec3(rimFactor) * vec3(0.8, 0.9, 1.0);

    color = color * (ambient + diffuse) + rim + vec3(0.1, 0.15, 0.05) * sss;

    // Fresnel: mix blend for softer rim
    color = mix(color, uFresnelColor, clamp(fresnel * leafMask, 0.0, 1.0));

    float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vCameraDistance * vCameraDistance);
    color = mix(color, fogColor, clamp(fogFactor, 0.0, 1.0));

    // Tone mapping and gamma (matching editor/terrain shaders)
    color = color / (color + vec3(1.0)) * 1.1;
    color = pow(color, vec3(0.95));

    gl_FragColor = vec4(color, 1.0);
}
`;

// Procedural asset shader (for rocks)
Effect.ShadersStore["loaderProceduralAssetVertexShader"] = `
precision highp float;

attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
attribute vec4 color;

uniform mat4 worldViewProjection;
uniform mat4 world;
uniform vec3 cameraPosition;

varying vec3 vNormal;
varying vec3 vPosition;
varying vec3 vLocalPosition;
varying vec2 vUV;
varying float vCameraDistance;
varying vec3 vViewDirection;
varying vec4 vColor;

void main() {
    vec4 worldPos = world * vec4(position, 1.0);
    gl_Position = worldViewProjection * vec4(position, 1.0);

    vNormal = normalize(mat3(world) * normal);
    vPosition = worldPos.xyz;
    vLocalPosition = position;
    vUV = uv;
    vCameraDistance = length(cameraPosition - worldPos.xyz);
    vViewDirection = normalize(cameraPosition - worldPos.xyz);
    vColor = color;
}
`;

Effect.ShadersStore["loaderProceduralAssetFragmentShader"] = `
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

void main() {
    // Screen-space derivatives for smooth normals
    vec3 dPdx = dFdx(vPosition);
    vec3 dPdy = dFdy(vPosition);
    vec3 geometricNormal = normalize(cross(dPdx, dPdy));
    vec3 smoothNormal = normalize(vNormal);

    // Edge detection (normal variation)
    vec3 dNdx = dFdx(smoothNormal);
    vec3 dNdy = dFdy(smoothNormal);
    float edgeStrength = length(dNdx) + length(dNdy);
    float edgeFactor = smoothstep(0.1, 0.5, edgeStrength);

    // Edge blending
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

    // Diffuse lighting
    float NdotL = max(dot(normal, sunDirection), 0.0);
    float diffuse = NdotL * 0.6 + 0.4;

    // Edge softening
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

    // Tone mapping
    color = color / (color + vec3(1.0)) * 1.1;
    color = pow(color, vec3(0.95));

    gl_FragColor = vec4(color, 1.0);
}
`;

function calcSubdivision(size: number, base: number = 4, override?: number): number {
  if (override !== undefined) {
    return Math.max(1, Math.min(6, override));
  }
  const subdiv = Math.floor(base + Math.log2(Math.max(size, 0.25)));
  return Math.max(3, Math.min(6, subdiv));
}

// ============================================
// Vertex Color Helpers
// ============================================

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

function setRockVertexColors(mesh: Mesh, seed: number): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
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

  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
}

function setBarkVertexColors(mesh: Mesh, seed: number, isBranch: boolean = false): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
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

  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
}

function setBushVertexColors(mesh: Mesh, seed: number): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
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

  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
}

function setLeafVertexColors(mesh: Mesh, seed: number, isTop: boolean = false): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) return;

  const vertexCount = positions.length / 3;
  const colors = new Float32Array(vertexCount * 4);

  // 잔디와 동일 톤 팔레트
  const sunLeaf = { r: 0.467, g: 0.667, b: 0.102 };    // 잔디 top
  const shadeLeaf = { r: 0.15, g: 0.28, b: 0.06 };     // 그늘
  const yellowLeaf = { r: 0.50, g: 0.70, b: 0.12 };    // 밝은 변형
  const freshLeaf = { r: 0.224, g: 0.424, b: 0.094 };  // 잔디 base

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

  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
}

// ============================================
// Generator Params Interface
// ============================================

export interface GeneratorParams {
  type: string;
  seed: number;
  size: number;
  sizeVariation: number;
  noiseScale: number;
  noiseAmplitude: number;
  colorBase: { r: number; g: number; b: number };
  colorDetail: { r: number; g: number; b: number };
}

// ============================================
// ProceduralAssetGenerator Class
// ============================================

export class ProceduralAssetGenerator {
  private scene: Scene;
  private time: number = 0;
  private windDirection: Vector2 = new Vector2(
    Math.cos(DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.directionRadians),
    Math.sin(DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.directionRadians)
  );
  private windStrength: number = 0.5;
  private fogColor: Color3 = new Color3(0.6, 0.75, 0.9);  // Matching editor
  private fogDensity: number = 0.008;  // Matching editor
  private renderingProfileVersion: string =
    DEFAULT_FOLIAGE_QUALITY_PROFILE.proceduralProfileVersion;
  private textureUrls: {
    rock: string;
    dirt: string;
    leafAtlas: string;
  } = {
    rock: DEFAULT_FOLIAGE_QUALITY_PROFILE.textures.rock,
    dirt: DEFAULT_FOLIAGE_QUALITY_PROFILE.textures.dirt,
    leafAtlas: DEFAULT_FOLIAGE_QUALITY_PROFILE.textures.leafAtlas,
  };
  private referenceTemplates: Partial<Record<"tree" | "bush", Mesh>> = {};
  private referenceTemplatesPromise: Promise<void> | null = null;
  private disposed = false;

  constructor(scene: Scene) {
    this.scene = scene;
    // Use scene fog settings if available
    if (scene.fogColor) {
      this.fogColor = new Color3(scene.fogColor.r, scene.fogColor.g, scene.fogColor.b);
    }
    if (scene.fogDensity) {
      this.fogDensity = scene.fogDensity;
    }
  }

  private seeded01(seed: number): number {
    const n = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
    return n - Math.floor(n);
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
    const temp = new Vector3();

    const outPositions = new Float32Array(positions.length);
    for (let i = 0; i < positions.length; i += 3) {
      Vector3.TransformCoordinatesFromFloatsToRef(
        positions[i],
        positions[i + 1],
        positions[i + 2],
        world,
        temp
      );
      outPositions[i] = temp.x;
      outPositions[i + 1] = temp.y;
      outPositions[i + 2] = temp.z;
    }

    let outNormals: Float32Array | null = null;
    if (normals) {
      outNormals = new Float32Array(normals.length);
      for (let i = 0; i < normals.length; i += 3) {
        Vector3.TransformNormalFromFloatsToRef(
          normals[i],
          normals[i + 1],
          normals[i + 2],
          world,
          temp
        );
        temp.normalize();
        outNormals[i] = temp.x;
        outNormals[i + 1] = temp.y;
        outNormals[i + 2] = temp.z;
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
    seed: number,
    size: number
  ): Mesh | null {
    const template = this.referenceTemplates[assetType];
    if (!template) {
      return null;
    }

    const mesh = template.clone(`${assetType}_ref_${seed}`);
    if (!mesh) {
      return null;
    }

    mesh.makeGeometryUnique();

    const variationIndex = Math.floor(Math.abs(seed)) % 8;
    const seedBase =
      variationIndex * 37.17 +
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
    mesh.scaling.setAll(size);

    return mesh;
  }

  async ensureReferenceTemplatesLoaded(): Promise<void> {
    if (this.referenceTemplates.tree || this.referenceTemplates.bush) {
      return;
    }

    if (this.referenceTemplatesPromise) {
      await this.referenceTemplatesPromise;
      return;
    }

    this.referenceTemplatesPromise = this.loadReferenceTemplatesIfAvailable();
    await this.referenceTemplatesPromise;
  }

  private async loadReferenceTemplatesIfAvailable(): Promise<void> {
    try {
      const result = await SceneLoader.ImportMeshAsync(
        "",
        REFERENCE_TREE_ROOT_URL,
        REFERENCE_TREE_FILE_NAME,
        this.scene
      );

      if (this.disposed) {
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
        name: string
      ): Mesh | null => {
        const bakedParts: Mesh[] = [];

        if (includeTrunk) {
          for (let i = 0; i < trunkSources.length; i++) {
            const baked = this.bakeMeshToWorld(trunkSources[i], `loader_ref_trunk_${i}`);
            if (!baked) continue;
            setMeshVertexColor(baked, 0.44, 0.32, 0.18);
            bakedParts.push(baked);
          }
        }

        for (let i = 0; i < bushSources.length; i++) {
          const baked = this.bakeMeshToWorld(bushSources[i], `loader_ref_bush_${i}`);
          if (!baked) continue;
          setMeshVertexColor(baked, 0.23, 0.48, 0.2);
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

        merged.name = name;
        this.recenterMeshToGround(merged);
        merged.isVisible = false;
        merged.isPickable = false;
        merged.material = null;
        return merged;
      };

      const bushTemplate = buildMergedTemplate(false, "loader_ref_bush_template");
      const treeTemplate = buildMergedTemplate(true, "loader_ref_tree_template");

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
        console.log(
          "[ProceduralAssetGenerator] Loaded reference tree/bush templates from GLB"
        );
      }
    } catch {
      // Keep fallback path procedural if reference asset is unavailable.
    }
  }

  /**
   * Update wind animation time
   */
  updateTime(deltaTime: number): void {
    this.time += deltaTime;
  }

  /**
   * Set wind parameters
   */
  setWind(direction: Vector2, strength: number): void {
    this.windDirection = direction.normalize();
    this.windStrength = strength;
  }

  /**
   * Set fog parameters
   */
  setFog(color: Color3, density: number): void {
    this.fogColor = color;
    this.fogDensity = density;
  }

  setRenderingProfileVersion(version: string): void {
    this.renderingProfileVersion = version;
  }

  setTextureUrls(urls: { rock?: string; dirt?: string; leafAtlas?: string }): void {
    this.textureUrls = {
      rock: urls.rock ?? this.textureUrls.rock,
      dirt: urls.dirt ?? this.textureUrls.dirt,
      leafAtlas: urls.leafAtlas ?? this.textureUrls.leafAtlas,
    };
  }

  /**
   * Generate a procedural mesh based on params
   */
  generate(params: GeneratorParams): Mesh | null {
    switch (params.type) {
      case "rock":
        return this.generateRock(params);
      case "tree":
        return (
          this.createReferenceVariationMesh("tree", params.seed, params.size) ??
          this.generateTree(params)
        );
      case "bush":
        return (
          this.createReferenceVariationMesh("bush", params.seed, params.size) ??
          this.generateBush(params)
        );
      case "grass_clump":
        return this.generateGrassClump(params);
      default:
        console.warn(`[ProceduralAssetGenerator] Unknown type: ${params.type}`);
        return null;
    }
  }

  /**
   * Create material for the mesh
   */
  createMaterial(params: GeneratorParams): ShaderMaterial {
    const needsWind = params.type === "grass_clump" || params.type === "bush" || params.type === "tree";

    if (needsWind) {
      const material = new ShaderMaterial(
        `loaderFoliageMat_${this.renderingProfileVersion}_${params.seed}`,
        this.scene,
        {
          vertex: "loaderFoliageWind",
          fragment: "loaderFoliageWind",
        },
        {
          attributes: ["position", "normal", "uv", "color"],
          uniforms: [
            "viewProjection", "world", "cameraPosition",
            "uTime", "uWindDirection", "uWindStrength",
            "uMinWindHeight", "uMaxWindHeight",
            "uPropsPrimarySpeed", "uPropsSecondarySpeed", "uPropsNoiseSpeed",
            "baseColor", "detailColor", "sunDirection",
            "ambientIntensity", "fogColor", "fogDensity",
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

      material.setVector2("uWindDirection", this.windDirection);

      let windStr = DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.baseStrength, minHeight = 0.0, maxHeight = 0.8;
      if (params.type === "grass_clump") {
        windStr = DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.grassClumpStrength;
        minHeight = 0.0;
        maxHeight = 0.5;
      } else if (params.type === "bush") {
        windStr = DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.bushStrength;
        minHeight = 0.05;
        maxHeight = 0.4;
      } else if (params.type === "tree") {
        windStr = DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.treeStrength;
        minHeight = 1.2;  // Only upper part moves (trunk stays still)
        maxHeight = 2.5;
      }

      material.setFloat("uWindStrength", windStr * this.windStrength);
      material.setFloat("uMinWindHeight", minHeight);
      material.setFloat("uMaxWindHeight", maxHeight);
      material.setFloat("uPropsPrimarySpeed", DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.propsPrimarySpeed);
      material.setFloat("uPropsSecondarySpeed", DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.propsSecondarySpeed);
      material.setFloat("uPropsNoiseSpeed", DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.propsNoiseSpeed);
      material.setFloat("uTime", this.time);

      material.setColor3("baseColor", new Color3(params.colorBase.r, params.colorBase.g, params.colorBase.b));
      material.setColor3("detailColor", new Color3(params.colorDetail.r, params.colorDetail.g, params.colorDetail.b));
      material.setVector3("sunDirection", new Vector3(0.5, 0.8, 0.3).normalize());
      material.setFloat("ambientIntensity", 0.4);
      material.setColor3("fogColor", this.fogColor);
      material.setFloat("fogDensity", this.fogDensity);
      material.setFloat("dirtTextureScale", 0.5);

      // Load dirt texture for bark triplanar mapping
      const dirtTex = loadTextureWithFallback(this.scene, this.textureUrls.dirt, {
        preferredExtensions: ["ktx2", "jpg", "png"],
        wrapU: Texture.WRAP_ADDRESSMODE,
        wrapV: Texture.WRAP_ADDRESSMODE,
        anisotropicFilteringLevel: 8,
      });
      material.setTexture("dirtTexture", dirtTex);

      const leafAtlas = loadTextureWithFallback(this.scene, this.textureUrls.leafAtlas, {
        preferredExtensions: ["png", "ktx2", "jpg"],
        wrapU: Texture.CLAMP_ADDRESSMODE,
        wrapV: Texture.CLAMP_ADDRESSMODE,
        anisotropicFilteringLevel: 4,
      });
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
        params.type === "tree" || params.type === "bush" ? 1.0 : 0.0
      );
      material.setFloat("uLeafMaskFromLuma", 1.0);

      // Fresnel rim light settings
      material.setFloat("uFresnelPower", 3.0);
      material.setFloat("uFresnelStrength", 0.4);
      material.setColor3("uFresnelColor", new Color3(0.8, 0.95, 0.7));

      // Register update for wind animation
      this.scene.registerBeforeRender(() => {
        material.setFloat("uTime", this.time);
      });

      return material;
    } else {
      // Rock shader with triplanar texture
      const material = new ShaderMaterial(
        `loaderRockMat_${this.renderingProfileVersion}_${params.seed}`,
        this.scene,
        {
          vertex: "loaderProceduralAsset",
          fragment: "loaderProceduralAsset",
        },
        {
          attributes: ["position", "normal", "uv", "color"],
          uniforms: [
            "worldViewProjection", "world", "cameraPosition",
            "baseColor", "detailColor", "sunDirection",
            "ambientIntensity", "fogColor", "fogDensity",
            "textureScale",
          ],
          samplers: ["rockTexture"],
        }
      );

      material.setColor3("baseColor", new Color3(params.colorBase.r, params.colorBase.g, params.colorBase.b));
      material.setColor3("detailColor", new Color3(params.colorDetail.r, params.colorDetail.g, params.colorDetail.b));
      material.setVector3("sunDirection", new Vector3(0.5, 0.8, 0.3).normalize());
      material.setFloat("ambientIntensity", 0.4);
      material.setColor3("fogColor", this.fogColor);
      material.setFloat("fogDensity", this.fogDensity);
      material.setFloat("textureScale", 0.5);

      // Load rock diffuse texture for triplanar mapping
      const rockTex = loadTextureWithFallback(this.scene, this.textureUrls.rock, {
        preferredExtensions: ["ktx2", "jpg", "png"],
        wrapU: Texture.WRAP_ADDRESSMODE,
        wrapV: Texture.WRAP_ADDRESSMODE,
        anisotropicFilteringLevel: 8,
      });
      material.setTexture("rockTexture", rockTex);

      return material;
    }
  }

  // ============================================
  // Rock Generation
  // ============================================

  private generateRock(params: GeneratorParams): Mesh {
    const seed = params.seed;
    const subdivisions = calcSubdivision(params.size, 4);

    const rock = MeshBuilder.CreateIcoSphere(
      "rock_" + seed,
      { radius: 0.5, subdivisions, flat: false, updatable: true },
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

    setRockVertexColors(rock, seed);
    rock.scaling.setAll(params.size);
    return rock;
  }

  // ============================================
  // Tree Generation
  // ============================================

  private generateTree(params: GeneratorParams): Mesh {
    const seed = params.seed;
    const meshes: Mesh[] = [];

    // Trunk parameters
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

    // Deform trunk
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

    // Branches
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
          subdivisions: 4,
          updatable: true,
        },
        this.scene
      );

      // Apply curvature deformation to branch (droop + slight S-curve)
      const branchPositions = branch.getVerticesData(VertexBuffer.PositionKind);
      if (branchPositions) {
        const newBranchPositions = new Float32Array(branchPositions.length);
        const halfLen = branchLength / 2;
        // Curve parameters: droop and sideways bend
        const droopAmount = 0.08 + Math.abs(noise3D(bSeed * 7.3, 0, 0)) * 0.12;
        const sideBend = (noise3D(0, bSeed * 8.1, 0) - 0.5) * 0.06;

        for (let vi = 0; vi < branchPositions.length; vi += 3) {
          let bx = branchPositions[vi];
          const by = branchPositions[vi + 1];
          let bz = branchPositions[vi + 2];

          // t: 0 at base, 1 at tip
          const bt = (by + halfLen) / branchLength;
          // Quadratic droop (stronger toward tip)
          bz += droopAmount * bt * bt * branchLength;
          // Slight S-curve sideways
          bx += sideBend * Math.sin(bt * Math.PI) * branchLength;

          newBranchPositions[vi] = bx;
          newBranchPositions[vi + 1] = by;
          newBranchPositions[vi + 2] = bz;
        }
        branch.updateVerticesData(VertexBuffer.PositionKind, newBranchPositions);
      }

      // Rotate branch
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

      // Leaf-card clusters at branch end
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

    // Top canopy clusters
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
      merged.scaling.setAll(params.size);
      return merged;
    }

    return new Mesh("tree_" + seed, this.scene);
  }

  private generateBush(params: GeneratorParams): Mesh {
    const seed = params.seed;
    const meshes: Mesh[] = [];

    const overallSpread = 0.25 + Math.abs(noise3D(0, seed, 0)) * 0.35;
    const clusterCount = 6 + Math.floor(Math.abs(noise3D(seed * 4, seed, 0)) * 7);

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
      merged.scaling.setAll(params.size);
      return merged;
    }

    return new Mesh("bush_" + seed, this.scene);
  }

  private generateGrassClump(params: GeneratorParams): Mesh {
    const seed = params.seed;
    const blades: Mesh[] = [];

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

    // Set grass vertex colors
    for (const blade of blades) {
      setMeshVertexColor(blade, 0.35, 0.45, 0.22);
    }

    const merged = Mesh.MergeMeshes(blades, true, true, undefined, false, true);
    if (merged) {
      merged.name = "grass_" + seed;
      merged.scaling.setAll(params.size);
      return merged;
    }

    return new Mesh("grass_" + seed, this.scene);
  }

  dispose(): void {
    this.disposed = true;
    if (this.referenceTemplates.tree) {
      this.referenceTemplates.tree.dispose();
    }
    if (this.referenceTemplates.bush) {
      this.referenceTemplates.bush.dispose();
    }
    this.referenceTemplates = {};
  }
}
