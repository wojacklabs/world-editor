import * as THREE from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Heightmap } from "../terrain/Heightmap";
import { ProceduralAsset, AssetParams, AssetType, DEFAULT_ASSET_PARAMS } from "./ProceduralAsset";
import { loadTextureWithFallbackSync } from "../../shared/rendering/TextureLoader.three";
import { DEFAULT_FOLIAGE_QUALITY_PROFILE } from "../../shared/foliage/FoliageQualityProfile";
import type { LightManager } from "../lighting/LightManager";
import type { HanokPlanPreset } from "../../shared/procedural/HanokGenerator";
import CustomShaderMaterial from "three-custom-shader-material/vanilla";
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
  hanok_giwa: { [MeshLOD.High]: 0, [MeshLOD.Medium]: 0, [MeshLOD.Low]: 0 },
  hanok_choga: { [MeshLOD.High]: 0, [MeshLOD.Medium]: 0, [MeshLOD.Low]: 0 },
  wall_fence_segment: { [MeshLOD.High]: 0, [MeshLOD.Medium]: 0, [MeshLOD.Low]: 0 },
  jangdokdae_set: { [MeshLOD.High]: 0, [MeshLOD.Medium]: 0, [MeshLOD.Low]: 0 },
  doghouse: { [MeshLOD.High]: 0, [MeshLOD.Medium]: 0, [MeshLOD.Low]: 0 },
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
varying vec3 vViewDirection;
varying float vCameraDistance;

void main() {
    vec4 worldPos = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vec4 mvPosition = viewMatrix * worldPos;

    gl_Position = projectionMatrix * mvPosition;

    mat3 normalMat = mat3(modelMatrix) * mat3(instanceMatrix);
    vNormal = normalize(normalMat * normal);
    vPosition = worldPos.xyz;
    vLocalPosition = position;
    vUV = uv;
    vViewDirection = normalize(cameraPosition - worldPos.xyz);
    vCameraDistance = length(cameraPosition - worldPos.xyz);

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
uniform float fogHeightFalloff;
uniform float fogHeightDensity;
uniform float uFadeStart;
uniform float uFadeEnd;
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
varying vec3 vViewDirection;
varying float vCameraDistance;

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

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>

    // Fog handled by VolumetricFogPass (post-processing)
}
`;

const structureInstancedVertexShader = `
precision highp float;

#include <common>
#include <shadowmap_pars_vertex>

attribute vec4 color;

varying vec3 vNormal;
varying vec3 vPosition;
varying vec3 vViewDirection;
varying vec4 vColor;
varying float vCameraDistance;

void main() {
    vec4 worldPos = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vec4 mvPosition = viewMatrix * worldPos;
    gl_Position = projectionMatrix * mvPosition;

    mat3 normalMat = mat3(modelMatrix) * mat3(instanceMatrix);
    vNormal = normalize(normalMat * normal);
    vPosition = worldPos.xyz;
    vViewDirection = normalize(cameraPosition - worldPos.xyz);
    vColor = color;
    vCameraDistance = length(cameraPosition - worldPos.xyz);

    vec3 transformedNormal = vNormal;
    vec4 worldPosition = worldPos;
    #include <shadowmap_vertex>
}
`;

const structureInstancedFragmentShader = `
precision highp float;

#include <common>
#include <packing>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>

uniform vec3 sunDirection;
uniform float ambientIntensity;
uniform vec3 fogColor;
uniform float fogDensity;
uniform float fogHeightFalloff;
uniform float fogHeightDensity;
uniform float uFadeStart;
uniform float uFadeEnd;

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
varying vec3 vViewDirection;
varying vec4 vColor;
varying float vCameraDistance;

void main() {
    vec3 normal = normalize(vNormal);
    vec3 color = vColor.rgb;

    float NdotL = max(dot(normal, sunDirection), 0.0);
    float diffuse = NdotL * 0.65 + 0.35;
    float ao = 0.55 + 0.45 * clamp(normal.y * 0.5 + 0.5, 0.0, 1.0);
    float rim = pow(1.0 - max(dot(normal, vViewDirection), 0.0), 2.8) * 0.08;

    float shadowFactor = 1.0;
    #if NUM_DIR_LIGHT_SHADOWS > 0
    {
        DirectionalLightShadow dirShadow = directionalLightShadows[0];
        shadowFactor = getShadow(
            directionalShadowMap[0],
            dirShadow.shadowMapSize,
            dirShadow.shadowIntensity,
            dirShadow.shadowBias,
            dirShadow.shadowRadius,
            vDirectionalShadowCoord[0]
        );
    }
    #endif

    vec3 pointLight = calcPointLights(vPosition, normal);
    color = color * (ambientIntensity * ao + diffuse * shadowFactor + pointLight) + vec3(rim);

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>

    // Fog handled by VolumetricFogPass (post-processing)
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
varying vec3 vViewDirection;
varying vec4 vColor;
varying float vCameraDistance;

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

    vec4 mvPosition = viewMatrix * worldPos;
    gl_Position = projectionMatrix * mvPosition;

    mat3 normalMat = mat3(modelMatrix) * mat3(instanceMatrix);
    // Normals: leaf vertices have pre-baked sphere normals per bush cluster
    vNormal = normalize(normalMat * normal);

    vPosition = worldPos.xyz;
    vLocalPosition = position;
    vUV = uv;
    vViewDirection = normalize(cameraPosition - worldPos.xyz);
    vColor = color;
    vCameraDistance = length(cameraPosition - worldPos.xyz);

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
uniform float fogHeightFalloff;
uniform float fogHeightDensity;
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
varying vec3 vViewDirection;
varying vec4 vColor;
varying float vCameraDistance;

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
    float leafMask = step(vColor.r + 0.02, vColor.g);
    vec4 leafSample = texture2D(leafAtlas, vUV);
    float usesLeafAtlas = uUseLeafAtlas * leafMask;
    float leafMaskAlpha = mix(leafSample.a, dot(leafSample.rgb, vec3(0.299, 0.587, 0.114)), uLeafMaskFromLuma);

    float distFactor = smoothstep(uLeafFadeStart, uLeafFadeEnd, vCameraDistance);
    float cutoff = mix(uLeafAlphaCutoff, 0.1, distFactor);
    if (usesLeafAtlas > 0.5 && leafMaskAlpha < cutoff) {
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

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>

    // Fog handled by VolumetricFogPass (post-processing)
}
`;

// ============================================
// CSM shaders for tree/bush (MeshStandardMaterial extension)
// Only handles wind displacement + sphere normals; PBR handles lighting/shadow/fog
// ============================================
const csmLeafVertexShader = `
attribute vec4 color;
varying vec4 vVertexColor;
varying vec2 vUv;
varying vec3 vWorldPos;

uniform float uTime;
uniform vec2 uWindDirection;
uniform float uWindStrength;
uniform float uMinWindHeight;
uniform float uMaxWindHeight;
uniform float uPropsPrimarySpeed;
uniform float uPropsSecondarySpeed;
uniform float uPropsNoiseSpeed;

float csm_hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float csm_noise2D(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = csm_hash(i);
    float b = csm_hash(i + vec2(1.0, 0.0));
    float c = csm_hash(i + vec2(0.0, 1.0));
    float d = csm_hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
    vVertexColor = color;
    vUv = uv;

    // Wind displacement
    vec3 worldPos = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
    vWorldPos = worldPos;

    float heightAboveMin = max(0.0, position.y - uMinWindHeight);
    float heightRange = max(0.01, uMaxWindHeight - uMinWindHeight);
    float heightFactor = clamp(heightAboveMin / heightRange, 0.0, 1.0);
    heightFactor = heightFactor * heightFactor * heightFactor;

    vec2 worldPosXZ = worldPos.xz;
    float windPhase = dot(worldPosXZ, uWindDirection) * 0.5 + uTime * uPropsPrimarySpeed;
    float primaryWave = sin(windPhase) * 0.5 + 0.5;
    float secondaryPhase = dot(worldPosXZ, uWindDirection) * 2.0 + uTime * uPropsSecondarySpeed;
    float secondaryWave = sin(secondaryPhase) * 0.3 + 0.5;
    float noiseVal = csm_noise2D(worldPosXZ * 0.3 + uTime * uPropsNoiseSpeed);
    float windAmount = (primaryWave * 0.7 + secondaryWave * 0.3 + noiseVal * 0.2) * heightFactor * uWindStrength;

    vec3 displaced = position;
    displaced.x += uWindDirection.x * windAmount * 0.2;
    displaced.z += uWindDirection.y * windAmount * 0.2;
    displaced.y -= windAmount * 0.04;
    csm_Position = displaced;
}
`;

// Fragment: bark/leaf branching via vertex color + fresnel for leaves + fog
const csmLeafFragmentShader = `
varying vec4 vVertexColor;
varying vec2 vUv;
varying vec3 vWorldPos;

uniform float uFresnelPower;
uniform float uFresnelStrength;
uniform vec3 uFresnelColor;
uniform vec3 uTrunkColor;
uniform sampler2D uLeafAlpha;
uniform float uAlphaCutoff;

float bark_hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
    // Vertex color: R>G = bark, G>R = leaf (set by setGeometryVertexColor)
    float isBark = step(vVertexColor.g + 0.02, vVertexColor.r);

    // Leaf alpha test (only for leaf vertices, bark always opaque)
    if (isBark < 0.5) {
        float alpha = texture2D(uLeafAlpha, vUv).g;
        if (alpha < uAlphaCutoff) discard;
    }

    // Bark: shaded color with grooves
    if (isBark > 0.5) {
        vec3 N = normalize(vNormal);

        // Wrapped Half-Lambert: directional light shading
        vec3 lightDir = normalize(vec3(0.5, 1.0, 0.5));
        float wrap = 0.4;
        float NdotL = clamp((dot(N, lightDir) + wrap) / (1.0 + wrap), 0.0, 1.0);

        // Hemisphere shading: top brighter, bottom darker
        float hemi = N.y * 0.5 + 0.5;

        // Combined shade factor (0.55 ~ 1.0)
        float shade = mix(0.55, 1.0, NdotL * 0.6 + hemi * 0.4);

        // Procedural bark grooves (vertical grain pattern)
        float groove = bark_hash(vec2(vUv.x * 30.0, vUv.y * 5.0));
        float grooveFactor = smoothstep(0.3, 0.7, groove);
        shade *= mix(0.8, 1.05, grooveFactor);

        csm_DiffuseColor.rgb = uTrunkColor * shade;
    } else {
        csm_DiffuseColor.rgb = csm_DiffuseColor.rgb;
    }

    // Leaf fresnel rim (skip for bark)
    float leafMask = 1.0 - isBark;
    vec3 N = normalize(vNormal);
    vec3 V = normalize(vViewPosition);
    float ndv = clamp(dot(N, V), 0.0, 1.0);
    float fresnel = pow(1.0 - ndv, uFresnelPower) * uFresnelStrength * leafMask;
    csm_DiffuseColor.rgb = mix(csm_DiffuseColor.rgb, uFresnelColor, clamp(fresnel, 0.0, 1.0));

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
  groupKey: InstanceGroupKey;
  assetType: AssetType;
  variationIndex: number;  // Which variation mesh to use
  params: AssetParams;
  position: THREE.Vector3;
  rotation: THREE.Vector3;
  scale: THREE.Vector3;
  visible: boolean;  // For LOD-based visibility
}

interface SerializedVector3 {
  x: number;
  y: number;
  z: number;
}

interface SerializedColor {
  r: number;
  g: number;
  b: number;
}

export interface SerializedProceduralPropParams {
  type: AssetType;
  seed: number;
  size: number;
  sizeVariation: number;
  noiseScale: number;
  noiseAmplitude: number;
  length?: number;
  width?: number;
  height?: number;
  baySize?: number;
  planPreset?: HanokPlanPreset;
  colorBase: SerializedColor;
  colorDetail: SerializedColor;
}

export interface SerializedProceduralPropInstance {
  id: string;
  assetType: AssetType;
  params: SerializedProceduralPropParams;
  position: SerializedVector3;
  rotation: SerializedVector3;
  scale: SerializedVector3;
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

function isWindAnimatedAssetType(type: AssetType): boolean {
  return type === "tree" || type === "bush" || type === "grass_clump";
}

function isKoreanStructureAssetType(type: AssetType): boolean {
  return (
    type === "hanok_giwa" ||
    type === "hanok_choga" ||
    type === "wall_fence_segment" ||
    type === "jangdokdae_set" ||
    type === "doghouse"
  );
}

function getEffectiveAssetScale(type: AssetType, size: number): number {
  return isKoreanStructureAssetType(type) ? 1.0 : size;
}

function quantizeNumber(value: number, precision: number = 100): number {
  return Math.round(value * precision) / precision;
}

export class PropManager {
  private scene: THREE.Scene;
  private heightmap: Heightmap;
  private instances: Map<string, PropInstance> = new Map();

  // Instancing: base variation geometries per type, per LOD level
  // Key: AssetType -> LOD level -> THREE.BufferGeometry[]
  private variationGeometries: Map<AssetType, Map<MeshLOD, THREE.BufferGeometry[]>> = new Map();
  // Parameterized structure geometry cache keyed by base group key
  private customGroupGeometries: Map<InstanceGroupKey, Map<MeshLOD, THREE.BufferGeometry>> = new Map();
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
  private previewMaterialClone: THREE.Material | null = null;  // Cloned material for preview (no fog)
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
  // GLB-extracted material data (for diagnostic purposes)
  private glbLeafColor: THREE.Color | null = null;
  private glbTrunkColor: THREE.Color | null = null;

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

  private setGeometryVertexColor(geometry: THREE.BufferGeometry, r: number, g: number, b: number, a = 1.0): void {
    const posAttr = geometry.getAttribute("position");
    if (!posAttr) return;

    const vertexCount = posAttr.count;
    const colors = new Float32Array(vertexCount * 4);
    for (let i = 0; i < vertexCount; i++) {
      colors[i * 4] = r;
      colors[i * 4 + 1] = g;
      colors[i * 4 + 2] = b;
      colors[i * 4 + 3] = a;
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 4));
  }

  private bakeGeometryToWorld(source: THREE.Mesh): THREE.BufferGeometry | null {
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

  /**
   * Replace flat normals with sphere normals based on each bush cluster's centroid.
   * This gives volume to leaf cards that would otherwise render as flat planes.
   */
  private bakeSphereNormals(geometry: THREE.BufferGeometry): void {
    const posAttr = geometry.getAttribute("position");
    const normalAttr = geometry.getAttribute("normal");
    if (!posAttr || !normalAttr) return;

    const positions = posAttr.array as Float32Array;
    const normals = normalAttr.array as Float32Array;
    const count = posAttr.count;

    // Compute centroid of this bush cluster
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < count; i++) {
      cx += positions[i * 3];
      cy += positions[i * 3 + 1];
      cz += positions[i * 3 + 2];
    }
    cx /= count;
    cy /= count;
    cz /= count;

    // Replace normals with direction from centroid to vertex (sphere normal)
    for (let i = 0; i < count; i++) {
      const dx = positions[i * 3] - cx;
      const dy = positions[i * 3 + 1] - cy;
      const dz = positions[i * 3 + 2] - cz;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      normals[i * 3] = dx / len;
      normals[i * 3 + 1] = dy / len;
      normals[i * 3 + 2] = dz / len;
    }
    normalAttr.needsUpdate = true;
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
    // Don't call computeVertexNormals() — it would destroy per-cluster
    // sphere normals baked for leaf vertices. Deformation is subtle enough
    // that pre-baked normals remain valid.
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

      // Extract GLB original material colors (diagnostic — GLB uses white + no textures)
      if (bushSources.length > 0) {
        const mat = bushSources[0].material;
        const stdMat = (Array.isArray(mat) ? mat[0] : mat) as THREE.MeshStandardMaterial;
        if (stdMat?.color) {
          this.glbLeafColor = stdMat.color.clone();
        }
      }
      if (trunkSources.length > 0) {
        const mat = trunkSources[0].material;
        const stdMat = (Array.isArray(mat) ? mat[0] : mat) as THREE.MeshStandardMaterial;
        if (stdMat?.color) {
          this.glbTrunkColor = stdMat.color.clone();
        }
      }

      const buildMergedTemplate = (
        includeTrunk: boolean
      ): THREE.BufferGeometry | null => {
        const bakedParts: THREE.BufferGeometry[] = [];

        if (includeTrunk) {
          for (let i = 0; i < trunkSources.length; i++) {
            const baked = this.bakeGeometryToWorld(trunkSources[i]);
            if (!baked) continue;
            this.setGeometryVertexColor(baked, 0.6, 0.3, 0.15, 0.0);  // R>G = bark flag, alpha=0 → use baseColor
            ensureAttributes(baked);
            bakedParts.push(baked);
          }
        }

        for (let i = 0; i < bushSources.length; i++) {
          const baked = this.bakeGeometryToWorld(bushSources[i]);
          if (!baked) continue;
          this.setGeometryVertexColor(baked, 0.2, 0.8, 0.2, 0.0);  // G>R = leaf flag, alpha=0 → use baseColor
          ensureAttributes(baked);
          // Bake sphere normals per bush cluster (centroid-based)
          this.bakeSphereNormals(baked);
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

      const bushTemplate = buildMergedTemplate(false);
      const treeTemplate = buildMergedTemplate(true);

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
    const preGeneratedTypes: AssetType[] = [
      "rock",
      "tree",
      "bush",
      "grass_clump",
    ];
    const materialTypes: AssetType[] = [
      ...preGeneratedTypes,
      "hanok_giwa",
      "hanok_choga",
      "wall_fence_segment",
      "jangdokdae_set",
      "doghouse",
    ];
    const lodLevels: MeshLOD[] = [MeshLOD.High, MeshLOD.Medium, MeshLOD.Low];
    let meshCount = 0;
    const startTime = performance.now();

    // Initialize empty maps for all asset types
    for (const assetType of preGeneratedTypes) {
      this.variationGeometries.set(assetType, new Map());
    }

    // Load GLB first to extract original material colors for tree/bush
    await this.loadReferenceTemplatesIfAvailable();

    // Create shared materials (after GLB load so tree/bush can use extracted colors)
    for (const assetType of materialTypes) {
      const material = this.createSharedMaterial(assetType);
      this.sharedMaterials.set(assetType, material);
    }

    // Create geometries progressively using requestAnimationFrame batching
    const batchSize = 4;  // Process 4 meshes per frame
    const currentBatch: Array<{ assetType: AssetType; lod: MeshLOD; variationIdx: number }> = [];

    // Build the full work queue
    for (const assetType of preGeneratedTypes) {
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
            const useReference =
              assetType === "tree" || assetType === "bush";

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
    console.log(`[PropManager] Async init complete: ${meshCount} meshes (${preGeneratedTypes.length} pre-generated types * ${lodLevels.length} LODs * ${VARIATIONS_PER_TYPE} variations, ${materialTypes.length} material types) in ${elapsed.toFixed(0)}ms`);
  }

  /**
   * Synchronous initialization (legacy, for backward compatibility)
   * Use initializeVariationsAsync() for non-blocking initialization
   */
  private initializeVariations(): void {
    const preGeneratedTypes: AssetType[] = [
      "rock",
      "tree",
      "bush",
      "grass_clump",
    ];
    const materialTypes: AssetType[] = [
      ...preGeneratedTypes,
      "hanok_giwa",
      "hanok_choga",
      "wall_fence_segment",
      "jangdokdae_set",
      "doghouse",
    ];
    const lodLevels: MeshLOD[] = [MeshLOD.High, MeshLOD.Medium, MeshLOD.Low];

    for (const assetType of preGeneratedTypes) {
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
    }

    for (const assetType of materialTypes) {
      const material = this.createSharedMaterial(assetType);
      this.sharedMaterials.set(assetType, material);
    }

    this.initializationComplete = true;
    console.log(`[PropManager] Initialized ${preGeneratedTypes.length} pre-generated asset types (${VARIATIONS_PER_TYPE} variations * 3 LOD each) and ${materialTypes.length} material types`);
  }

  /**
   * Create shared material for instanced props
   */
  private createSharedMaterial(assetType: AssetType): THREE.ShaderMaterial {
    const defaultParams = DEFAULT_ASSET_PARAMS[assetType];

    // Tree/Bush: use CustomShaderMaterial (MeshStandardMaterial extension)
    // Wind + sphere normals are custom; lighting/shadow/fog handled by PBR
    if (assetType === "tree" || assetType === "bush") {
      const windAngle = DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.directionRadians;
      const windStrength = assetType === "tree"
        ? DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.treeStrength
        : DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.bushStrength;
      const minWindHeight = assetType === "tree" ? 1.2 : 0.0;
      const maxWindHeight = assetType === "tree" ? 2.5 : 0.3;

      const leafAtlas = loadTextureWithFallbackSync(
        DEFAULT_FOLIAGE_QUALITY_PROFILE.textures.leafAtlas,
        {
          preferredExtensions: ["png", "ktx2", "jpg"],
          wrapS: THREE.ClampToEdgeWrapping,
          wrapT: THREE.ClampToEdgeWrapping,
        }
      );

      const fogUniforms = {
        fogColor: { value: new THREE.Color(0.6, 0.75, 0.9) },
        fogDensity: { value: 0.008 },
        fogHeightFalloff: { value: 15.0 },
        fogHeightDensity: { value: 0.1 },
        uFadeStart: { value: 80.0 },
        uFadeEnd: { value: 160.0 },
      };

      const csm = new CustomShaderMaterial({
        baseMaterial: THREE.MeshStandardMaterial,
        vertexShader: csmLeafVertexShader,
        fragmentShader: csmLeafFragmentShader,
        uniforms: {
          uTime: { value: 0 },
          uWindDirection: { value: new THREE.Vector2(Math.cos(windAngle), Math.sin(windAngle)) },
          uWindStrength: { value: windStrength },
          uMinWindHeight: { value: minWindHeight },
          uMaxWindHeight: { value: maxWindHeight },
          uPropsPrimarySpeed: { value: DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.propsPrimarySpeed },
          uPropsSecondarySpeed: { value: DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.propsSecondarySpeed },
          uPropsNoiseSpeed: { value: DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.propsNoiseSpeed },
          uFresnelPower: { value: 2.5 },
          uFresnelStrength: { value: 0.15 },
          uFresnelColor: { value: new THREE.Color("#90c020") },
          uTrunkColor: { value: new THREE.Color("#8b6b4a") },
          uLeafAlpha: { value: leafAtlas },
          uAlphaCutoff: { value: DEFAULT_FOLIAGE_QUALITY_PROFILE.leafAtlas.alphaCutoff },
          ...fogUniforms,
        },
        // MeshStandardMaterial properties
        color: new THREE.Color("#6a9e18"),
        fog: false,  // Disable Three.js built-in fog; custom fog via onBeforeCompile
        transparent: false,
        depthWrite: true,
        side: THREE.DoubleSide,
        roughness: 1.0,
        metalness: 0.0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      // Inject custom fog via onBeforeCompile (replaces Three.js fog includes)
      const origCompile = csm.onBeforeCompile.bind(csm);
      csm.onBeforeCompile = (shader: THREE.WebGLProgramParametersWithUniforms, renderer: THREE.WebGLRenderer) => {
        origCompile(shader, renderer);
        shader.fragmentShader = shader.fragmentShader
          .replace(
            /\s*#include <fog_pars_fragment>/,
            /* glsl */ `
              uniform vec3 fogColor;
              uniform float fogDensity;
              uniform float fogHeightFalloff;
              uniform float fogHeightDensity;
              uniform float uFadeStart;
              uniform float uFadeEnd;
            `
          )
          .replace(
            /\s*#include <fog_fragment>/,
            /* glsl */ `
              // Fog handled by VolumetricFogPass (post-processing)
            `
          );
        Object.assign(shader.uniforms, fogUniforms);
      };
      const prevCacheKey = csm.customProgramCacheKey?.bind(csm);
      csm.customProgramCacheKey = () => (prevCacheKey?.() ?? "") + "tree-fog-v2";
      csm.needsUpdate = true;

      // Cast: CSM extends THREE.Material with .uniforms; compatible at runtime
      return csm as unknown as THREE.ShaderMaterial;
    }

    // Grass clump: keep existing ShaderMaterial with wind
    if (assetType === "grass_clump") {
      const windAngle = DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.directionRadians;
      const windStrength = DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.grassClumpStrength;

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

      return new THREE.ShaderMaterial({
        vertexShader: propThinWindVertexShader,
        fragmentShader: propThinWindFragmentShader,
        uniforms: THREE.UniformsUtils.merge([
          THREE.UniformsLib.lights,
          {
            cameraPosition: { value: new THREE.Vector3() },
            uTime: { value: 0 },
            uWindDirection: { value: new THREE.Vector2(Math.cos(windAngle), Math.sin(windAngle)) },
            uWindStrength: { value: windStrength },
            uMinWindHeight: { value: 0.0 },
            uMaxWindHeight: { value: 0.7 },
            uPropsPrimarySpeed: { value: DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.propsPrimarySpeed },
            uPropsSecondarySpeed: { value: DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.propsSecondarySpeed },
            uPropsNoiseSpeed: { value: DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.propsNoiseSpeed },
            baseColor: { value: new THREE.Color(defaultParams.colorBase.r, defaultParams.colorBase.g, defaultParams.colorBase.b) },
            detailColor: { value: new THREE.Color(defaultParams.colorDetail.r, defaultParams.colorDetail.g, defaultParams.colorDetail.b) },
            sunDirection: { value: new THREE.Vector3(0.5, 0.8, 0.3).normalize() },
            ambientIntensity: { value: 0.4 },
            fogColor: { value: new THREE.Color(0.6, 0.75, 0.9) },
            fogDensity: { value: 0.008 },
            fogHeightFalloff: { value: 15.0 },
            fogHeightDensity: { value: 0.1 },
            dirtTexture: { value: dirtTex },
            dirtTextureScale: { value: 0.5 },
            leafAtlas: { value: leafAtlas },
            uLeafAlphaCutoff: { value: DEFAULT_FOLIAGE_QUALITY_PROFILE.leafAtlas.alphaCutoff },
            uLeafFadeStart: { value: DEFAULT_FOLIAGE_QUALITY_PROFILE.fade.leafFadeStart },
            uLeafFadeEnd: { value: DEFAULT_FOLIAGE_QUALITY_PROFILE.fade.leafFadeEnd },
            uUseLeafAtlas: { value: 0.0 },
            uLeafMaskFromLuma: { value: 1.0 },
            uFresnelPower: { value: 3.0 },
            uFresnelStrength: { value: 0.4 },
            uFresnelColor: { value: new THREE.Color(0.8, 0.95, 0.7) },
            uPointLightPositions: { value: new Float32Array(8 * 3) },
            uPointLightColors: { value: new Float32Array(8 * 3) },
            uPointLightRanges: { value: new Float32Array(8) },
            uPointLightCount: { value: 0 },
          },
        ]),
        lights: true,
        fog: false,
        side: THREE.DoubleSide,
        alphaTest: DEFAULT_FOLIAGE_QUALITY_PROFILE.leafAtlas.alphaCutoff,
      });
    }

    if (isKoreanStructureAssetType(assetType)) {
      return new THREE.ShaderMaterial({
        vertexShader: structureInstancedVertexShader,
        fragmentShader: structureInstancedFragmentShader,
        uniforms: THREE.UniformsUtils.merge([
          THREE.UniformsLib.lights,
          {
            cameraPosition: { value: new THREE.Vector3() },
            sunDirection: { value: new THREE.Vector3(0.5, 0.8, 0.3).normalize() },
            ambientIntensity: { value: 0.42 },
            fogColor: { value: new THREE.Color(0.6, 0.75, 0.9) },
            fogDensity: { value: 0.008 },
            fogHeightFalloff: { value: 15.0 },
            fogHeightDensity: { value: 0.1 },
            uFadeStart: { value: 80.0 },
            uFadeEnd: { value: 160.0 },
            uPointLightPositions: { value: new Float32Array(8 * 3) },
            uPointLightColors: { value: new Float32Array(8 * 3) },
            uPointLightRanges: { value: new Float32Array(8) },
            uPointLightCount: { value: 0 },
          },
        ]),
        lights: true,
        fog: false,
        side: THREE.DoubleSide,
      });
    }

    // Rock: instanced static shader with triplanar texture
    const rockTex = loadTextureWithFallbackSync(
      DEFAULT_FOLIAGE_QUALITY_PROFILE.textures.rock,
      {
        preferredExtensions: ["ktx2", "jpg", "png"],
        wrapS: THREE.RepeatWrapping,
        wrapT: THREE.RepeatWrapping,
      }
    );

    return new THREE.ShaderMaterial({
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
          fogHeightFalloff: { value: 15.0 },
          fogHeightDensity: { value: 0.1 },
          uFadeStart: { value: 80.0 },
          uFadeEnd: { value: 160.0 },
          rockTexture: { value: rockTex },
          textureScale: { value: 1.0 },
          uPointLightPositions: { value: new Float32Array(8 * 3) },
          uPointLightColors: { value: new Float32Array(8 * 3) },
          uPointLightRanges: { value: new Float32Array(8) },
          uPointLightCount: { value: 0 },
        },
      ]),
      lights: true,
      fog: false,
      side: THREE.DoubleSide,
    });
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

    const elapsed = (performance.now() - this.materialStartTime) / 1000;

    for (const [assetType, material] of this.sharedMaterials) {
      const u = material.uniforms;
      if (u.cameraPosition) {
        u.cameraPosition.value.copy(camera.position);
      }
      if (isWindAnimatedAssetType(assetType) && u.uTime) {
        u.uTime.value = elapsed;
      }
      // Apply point light uniforms (only for raw ShaderMaterial, not CSM)
      if (this.lightManager && u.uPointLightCount) {
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
  private getGroupKey(
    assetType: AssetType,
    variationIndex: number,
    signature?: string
  ): InstanceGroupKey {
    return signature
      ? `${assetType}|${variationIndex}|${signature}`
      : `${assetType}|${variationIndex}`;
  }

  /**
   * Get instance group key with LOD level
   */
  private getGroupKeyWithLOD(baseGroupKey: InstanceGroupKey, lod: MeshLOD): InstanceGroupKey {
    return `${baseGroupKey}|${lod}`;
  }

  private parseBaseGroupKey(baseGroupKey: InstanceGroupKey): {
    assetType: AssetType;
    variationIndex: number;
    signature?: string;
  } | null {
    const parts = baseGroupKey.split("|");
    if (parts.length < 2) return null;

    const variationIndex = parseInt(parts[1], 10);
    if (Number.isNaN(variationIndex)) return null;

    return {
      assetType: parts[0] as AssetType,
      variationIndex,
      signature: parts.length > 2 ? parts.slice(2).join("|") : undefined,
    };
  }

  /**
   * Parse group key with LOD
   */
  private parseGroupKeyWithLOD(groupKey: InstanceGroupKey): { baseGroupKey: InstanceGroupKey; lod: MeshLOD } | null {
    const parts = groupKey.split("|");
    if (parts.length < 3) return null;
    const lod = parseInt(parts[parts.length - 1], 10);
    if (Number.isNaN(lod)) return null;
    return {
      baseGroupKey: parts.slice(0, -1).join("|"),
      lod: lod as MeshLOD,
    };
  }

  private getStructureSignature(params: AssetParams): string {
    const defaults = DEFAULT_ASSET_PARAMS[params.type];
    const length = quantizeNumber(params.length ?? defaults.length ?? 1, 100);
    const width = quantizeNumber(params.width ?? defaults.width ?? 1, 100);
    const height = quantizeNumber(params.height ?? defaults.height ?? 1, 100);
    const baySize = quantizeNumber(params.baySize ?? defaults.baySize ?? 2.4, 100);
    const planPreset = params.planPreset ?? defaults.planPreset ?? "auto";
    const seed = quantizeNumber(params.seed, 1000);
    return `${length}_${width}_${height}_${baySize}_${planPreset}_${seed}`;
  }

  private getOrCreateCustomLODGeometry(
    baseGroupKey: InstanceGroupKey,
    assetType: AssetType,
    lod: MeshLOD,
    sampleParams: AssetParams
  ): THREE.BufferGeometry | null {
    let lodMap = this.customGroupGeometries.get(baseGroupKey);
    if (!lodMap) {
      lodMap = new Map();
      this.customGroupGeometries.set(baseGroupKey, lodMap);
    }

    const cached = lodMap.get(lod);
    if (cached) return cached;

    const subdivision = LOD_SUBDIVISIONS[assetType][lod];
    const generationParams: AssetParams = {
      ...DEFAULT_ASSET_PARAMS[assetType],
      ...sampleParams,
      type: assetType,
      size: 1.0,
      subdivisionOverride: subdivision > 0 ? subdivision : undefined,
    };

    const asset = new ProceduralAsset(null, generationParams);
    const mesh = asset.generate() as THREE.Mesh | null;
    if (!mesh) {
      asset.dispose();
      return null;
    }

    const baseGeometry = mesh.geometry.clone();
    ensureAttributes(baseGeometry);
    asset.dispose();

    if (isKoreanStructureAssetType(assetType)) {
      const lodLevels: MeshLOD[] = [MeshLOD.High, MeshLOD.Medium, MeshLOD.Low];
      for (const level of lodLevels) {
        if (level === lod) {
          lodMap.set(level, baseGeometry);
        } else {
          lodMap.set(level, baseGeometry.clone());
        }
      }
      return lodMap.get(lod) ?? null;
    }

    lodMap.set(lod, baseGeometry);
    return baseGeometry;
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
        const groupKey = instance.groupKey;
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
        const groupKey = instance.groupKey;
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
        this.markGroupDirty(instance.groupKey);
      }
    }
  }

  /**
   * Rebuild a single instance group with LOD and frustum culling support
   */
  private rebuildInstanceGroupWithLOD(baseGroupKey: InstanceGroupKey): void {
    const parsed = this.parseBaseGroupKey(baseGroupKey);
    if (!parsed) return;

    const { assetType, variationIndex } = parsed;
    const propIds = this.propsByGroup.get(baseGroupKey);

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
      // No props - dispose all LOD meshes for this group.
      for (const lod of lodLevels) {
        const lodGroupKey = this.getGroupKeyWithLOD(baseGroupKey, lod);
        const groupMesh = this.instanceGroups.get(lodGroupKey);
        if (groupMesh) {
          this.scene.remove(groupMesh);
          groupMesh.dispose();
          this.instanceGroups.delete(lodGroupKey);
        }
      }

      const customLodMap = this.customGroupGeometries.get(baseGroupKey);
      if (customLodMap) {
        for (const geometry of customLodMap.values()) {
          geometry.dispose();
        }
        this.customGroupGeometries.delete(baseGroupKey);
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
      const lodGroupKey = this.getGroupKeyWithLOD(baseGroupKey, lod);
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
        let baseGeometry: THREE.BufferGeometry | null = null;

        if (isKoreanStructureAssetType(assetType)) {
          const firstInstanceId = propIds.values().next().value as string | undefined;
          const firstInstance = firstInstanceId ? this.instances.get(firstInstanceId) : undefined;
          if (!firstInstance) continue;
          baseGeometry = this.getOrCreateCustomLODGeometry(
            baseGroupKey,
            assetType,
            lod,
            firstInstance.params
          );
        } else {
          const lodGeoMap = this.variationGeometries.get(assetType);
          const lodGeometries = lodGeoMap?.get(lod);
          if (!lodGeometries || !lodGeometries[variationIndex]) continue;
          baseGeometry = lodGeometries[variationIndex];
        }

        if (!baseGeometry) continue;

        // Allocate with extra capacity to avoid frequent re-creation
        const capacity = Math.max(count, 16) * 2;
        const material = this.sharedMaterials.get(assetType);
        if (!material) continue;

        groupMesh = new THREE.InstancedMesh(baseGeometry, material, capacity);
        groupMesh.name = `inst_${lodGroupKey}`;
        groupMesh.frustumCulled = true;
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
      groupMesh.computeBoundingSphere();
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
      // Don't dispose geometry - shared from variationGeometries
      this.previewInstancedMesh = null;
    }
    if (this.previewMaterialClone) {
      this.previewMaterialClone.dispose();
      this.previewMaterialClone = null;
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

    // Clone material for preview with fog disabled (skip CSM materials which can't be cloned safely)
    let previewMat: THREE.Material = material;
    if (type !== "tree" && type !== "bush") {
      const cloned = material.clone() as THREE.ShaderMaterial;
      if (cloned.uniforms?.fogDensity) {
        cloned.uniforms.fogDensity.value = 0;
      }
      if (cloned.uniforms?.uFadeStart) {
        cloned.uniforms.uFadeStart.value = 99999;
      }
      if (cloned.uniforms?.uLeafFadeStart) {
        cloned.uniforms.uLeafFadeStart.value = 99999;
      }
      this.previewMaterialClone = cloned;
      previewMat = cloned;
    }

    const previewMesh = new THREE.InstancedMesh(sourceGeometry, previewMat, 1);

    // For tree/bush: temporarily disable fog during preview render via callbacks
    if (type === "tree" || type === "bush") {
      const mat = material as unknown as { uniforms?: Record<string, { value: unknown }>, _savedFogDensity?: number, _savedFadeStart?: number };
      previewMesh.onBeforeRender = () => {
        if (mat.uniforms?.fogDensity) {
          mat._savedFogDensity = mat.uniforms.fogDensity.value as number;
          mat.uniforms.fogDensity.value = 0;
        }
        if (mat.uniforms?.uFadeStart) {
          mat._savedFadeStart = mat.uniforms.uFadeStart.value as number;
          mat.uniforms.uFadeStart.value = 99999;
        }
      };
      previewMesh.onAfterRender = () => {
        if (mat.uniforms?.fogDensity && mat._savedFogDensity !== undefined) {
          mat.uniforms.fogDensity.value = mat._savedFogDensity;
          delete mat._savedFogDensity;
        }
        if (mat.uniforms?.uFadeStart && mat._savedFadeStart !== undefined) {
          mat.uniforms.uFadeStart.value = mat._savedFadeStart;
          delete mat._savedFadeStart;
        }
      };
    }
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
  createPreview(
    type: AssetType,
    size: number,
    seed?: number,
    customSettings?: { length?: number; width?: number; height?: number; baySize?: number; planPreset?: HanokPlanPreset }
  ): void {
    this.disposePreviewResources();

    // Convert seed to variation seed pattern to match pre-generated variation meshes
    const rawSeed = seed ?? Math.random() * 10000;
    const normalizedSeed = isKoreanStructureAssetType(type)
      ? rawSeed
      : this.toVariationSeed(rawSeed);
    const variationIndex = this.getVariationIndex(normalizedSeed);

    // Create new preview params
    const effectiveSize = getEffectiveAssetScale(type, size);
    this.previewParams = {
      ...DEFAULT_ASSET_PARAMS[type],
      type,
      size: effectiveSize,
      seed: normalizedSeed,
      length: customSettings?.length ?? DEFAULT_ASSET_PARAMS[type].length,
      width: customSettings?.width ?? DEFAULT_ASSET_PARAMS[type].width,
      height: customSettings?.height ?? DEFAULT_ASSET_PARAMS[type].height,
      baySize: customSettings?.baySize ?? DEFAULT_ASSET_PARAMS[type].baySize,
      planPreset: customSettings?.planPreset ?? DEFAULT_ASSET_PARAMS[type].planPreset,
    };

    this.previewScale = effectiveSize;
    this.previewRotation.set(0, 0, 0);

    const useInstancedPreview = !isKoreanStructureAssetType(type);
    const createdInstancedPreview = useInstancedPreview && this.createInstancedPreviewFromVariation(type, variationIndex);
    if (!createdInstancedPreview) {
      // Fallback path when async variation geometries are not ready yet.
      this.previewAsset = new ProceduralAsset(this.scene, this.previewParams);
      this.previewMesh = this.previewAsset.generate();
      if (this.previewMesh) {
        this.previewMesh.position.copy(this.previewPosition);
        // Disable fog and fadeout on preview material
        const mat = this.previewMesh.material as THREE.ShaderMaterial;
        if (mat?.uniforms?.fogDensity) {
          mat.uniforms.fogDensity.value = 0;
        }
        if (mat?.uniforms?.uFadeStart) {
          mat.uniforms.uFadeStart.value = 99999;
        }
        if (mat?.uniforms?.uLeafFadeStart) {
          mat.uniforms.uLeafFadeStart.value = 99999;
        }
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

    let newSeed: number;
    if (isKoreanStructureAssetType(this.previewParams.type)) {
      newSeed = Math.random() * 10000;
    } else {
      // Pick random variation index and convert to variation seed
      const randomVariationIndex = Math.floor(Math.random() * VARIATIONS_PER_TYPE);
      newSeed = randomVariationIndex * 1001 + 8;
    }

    this.createPreview(this.previewParams.type, this.previewParams.size, newSeed, {
      length: this.previewParams.length,
      width: this.previewParams.width,
      height: this.previewParams.height,
      baySize: this.previewParams.baySize,
      planPreset: this.previewParams.planPreset,
    });
    return newSeed;
  }

  // Update preview size (preserves position)
  updatePreviewSize(size: number): void {
    if (!this.previewParams) return;

    const effectiveSize = getEffectiveAssetScale(this.previewParams.type, size);
    const previousSize = this.previewParams.size;
    this.previewScale = effectiveSize;
    this.previewParams.size = effectiveSize;

    if (this.previewInstancedMesh) {
      this.updateInstancedPreviewTransform();
      return;
    }

    // Fallback procedural preview path
    if (this.previewMesh) {
      const scaleFactor = effectiveSize / Math.max(0.0001, previousSize);
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
    length?: number;
    width?: number;
    height?: number;
    baySize?: number;
    planPreset?: HanokPlanPreset;
  }): void {
    this.disposePreviewResources();

    // Create new preview params with full customization
    const effectiveSize = getEffectiveAssetScale(params.type, params.size);
    this.previewParams = {
      type: params.type,
      seed: params.seed,
      size: effectiveSize,
      sizeVariation: params.sizeVariation,
      noiseScale: params.noiseScale,
      noiseAmplitude: params.noiseAmplitude,
      colorBase: params.colorBase,
      colorDetail: params.colorDetail,
      length: params.length,
      width: params.width,
      height: params.height,
      baySize: params.baySize,
      planPreset: params.planPreset,
    };
    this.previewScale = effectiveSize;
    this.previewRotation.set(0, 0, 0);

    // Generate preview asset
    this.previewAsset = new ProceduralAsset(this.scene, this.previewParams);
    this.previewMesh = this.previewAsset.generate();

    if (this.previewMesh) {
      this.previewMesh.name = "preview_asset";

      // Make semi-transparent and disable fog/fadeout on preview
      if (this.previewMesh.material && this.previewMesh.material instanceof THREE.ShaderMaterial) {
        this.previewMesh.material.transparent = true;
        this.previewMesh.material.opacity = 0.8;
        if (this.previewMesh.material.uniforms?.fogDensity) {
          this.previewMesh.material.uniforms.fogDensity.value = 0;
        }
        if (this.previewMesh.material.uniforms?.uFadeStart) {
          this.previewMesh.material.uniforms.uFadeStart.value = 99999;
        }
        if (this.previewMesh.material.uniforms?.uLeafFadeStart) {
          this.previewMesh.material.uniforms.uLeafFadeStart.value = 99999;
        }
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
    const signature = isKoreanStructureAssetType(params.type)
      ? this.getStructureSignature(params)
      : undefined;
    const groupKey = this.getGroupKey(params.type, variationIndex, signature);

    // Store instance (no mesh - managed by instancing)
    const rotation = this.previewInstancedMesh
      ? this.previewRotation.clone()
      : (this.previewMesh ? new THREE.Vector3(this.previewMesh.rotation.x, this.previewMesh.rotation.y, this.previewMesh.rotation.z) : new THREE.Vector3());

    const instance: PropInstance = {
      id,
      groupKey,
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
    customSettings?: {
      size?: number;
      seed?: number;
      length?: number;
      width?: number;
      height?: number;
      baySize?: number;
      planPreset?: HanokPlanPreset;
    }
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
    const effectiveSize = getEffectiveAssetScale(type, size);
    const variationIndex = this.getVariationIndex(seed);

    const params: AssetParams = {
      ...DEFAULT_ASSET_PARAMS[type],
      type,
      seed,
      size: effectiveSize,
      length: customSettings?.length ?? DEFAULT_ASSET_PARAMS[type].length,
      width: customSettings?.width ?? DEFAULT_ASSET_PARAMS[type].width,
      height: customSettings?.height ?? DEFAULT_ASSET_PARAMS[type].height,
      baySize: customSettings?.baySize ?? DEFAULT_ASSET_PARAMS[type].baySize,
      planPreset: customSettings?.planPreset ?? DEFAULT_ASSET_PARAMS[type].planPreset,
    };
    const signature = isKoreanStructureAssetType(type)
      ? this.getStructureSignature(params)
      : undefined;
    const groupKey = this.getGroupKey(type, variationIndex, signature);

    const rotationY = Math.random() * Math.PI * 2;

    const instance: PropInstance = {
      id,
      groupKey,
      assetType: type,
      variationIndex,
      params,
      position: new THREE.Vector3(x, y, z),
      rotation: new THREE.Vector3(0, rotationY, 0),
      scale: new THREE.Vector3(effectiveSize, effectiveSize, effectiveSize),
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
    const groupKey = instance.groupKey;
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

    for (const lodMap of this.customGroupGeometries.values()) {
      for (const geometry of lodMap.values()) {
        geometry.dispose();
      }
    }
    this.customGroupGeometries.clear();

    // Hide all instance group meshes
    for (const groupMesh of this.instanceGroups.values()) {
      groupMesh.visible = false;
      groupMesh.count = 0;
    }
  }

  // Export instances for saving
  exportInstances(): SerializedProceduralPropInstance[] {
    return Array.from(this.instances.values()).map((inst) => {
      const isStructure = isKoreanStructureAssetType(inst.assetType);
      const sizeValue = isStructure ? 1.0 : inst.params.size;
      const scale = isStructure
        ? { x: 1.0, y: 1.0, z: 1.0 }
        : { x: inst.scale.x, y: inst.scale.y, z: inst.scale.z };
      return {
      id: inst.id,
      assetType: inst.assetType,
      params: {
        type: inst.params.type,
        seed: inst.params.seed,
        size: sizeValue,
        sizeVariation: inst.params.sizeVariation,
        noiseScale: inst.params.noiseScale,
        noiseAmplitude: inst.params.noiseAmplitude,
        length: inst.params.length,
        width: inst.params.width,
        height: inst.params.height,
        baySize: inst.params.baySize,
        planPreset: inst.params.planPreset,
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
      scale,
      };
    });
  }

  // Import instances from saved data
  importInstances(data: SerializedProceduralPropInstance[]): void {
    // Clear existing
    this.clearAll();

    const affectedGroups = new Set<InstanceGroupKey>();

    for (const item of data) {
      const isStructure = isKoreanStructureAssetType(item.assetType);
      const sizeValue = isStructure ? 1.0 : item.params.size;
      const params: AssetParams = {
        type: item.params.type,
        seed: item.params.seed,
        size: sizeValue,
        sizeVariation: item.params.sizeVariation,
        noiseScale: item.params.noiseScale,
        noiseAmplitude: item.params.noiseAmplitude,
        length: item.params.length,
        width: item.params.width,
        height: item.params.height,
        baySize: item.params.baySize,
        planPreset: item.params.planPreset,
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
      const signature = isKoreanStructureAssetType(params.type)
        ? this.getStructureSignature(params)
        : undefined;
      const groupKey = this.getGroupKey(params.type, variationIndex, signature);

      const instance: PropInstance = {
        id: item.id,
        groupKey,
        assetType: item.assetType,
        variationIndex,
        params,
        position: new THREE.Vector3(item.position.x, item.position.y, item.position.z),
        rotation: new THREE.Vector3(item.rotation.x, item.rotation.y, item.rotation.z),
        scale: isStructure
          ? new THREE.Vector3(1, 1, 1)
          : new THREE.Vector3(item.scale.x, item.scale.y, item.scale.z),
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
