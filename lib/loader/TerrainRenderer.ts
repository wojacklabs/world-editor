/**
 * TerrainRenderer - Independent terrain rendering for Three.js
 *
 * Features:
 * - No editor logic dependency (brushes, dirty flags, etc.)
 * - Accepts raw Float32Array data from WorldLoader
 * - LOD system with 3 levels
 * - Full editor shader pipeline: hex tiling, triplanar, normal maps, ARM, shadow maps
 *
 * Usage:
 * ```typescript
 * import { WorldLoader, TerrainRenderer } from "@world-editor/loader";
 *
 * const result = WorldLoader.loadWorld(json);
 * const tile = result.data!.mainTile!;
 *
 * const renderer = new TerrainRenderer(scene);
 * renderer.create({
 *   heightmap: tile.heightmap,
 *   resolution: tile.resolution,
 *   splatmap: tile.splatmap,
 *   waterMask: tile.waterMask,
 *   size: tile.size,
 *   seaLevel: tile.seaLevel,
 * });
 * ```
 */

import * as THREE from "three";
import { createDataTexture } from "../shared/rendering/threeHelpers";
import { loadTextureWithFallbackSync } from "../shared/rendering/TextureLoader.three";
import type { TerrainRenderData, TerrainRendererOptions } from "./types";

// ============================================
// Editor Terrain Shader (full pipeline)
// ============================================

const terrainVertexShader = `
precision highp float;

#include <common>
#include <shadowmap_pars_vertex>

// Uniforms
uniform sampler2D uSplatMap;
uniform sampler2D uRockDisp;
uniform sampler2D uGrassDisp;
uniform float uTextureScale;
uniform float uDispStrength;
uniform float uTerrainSize;

// Varyings
varying vec3 vPosition;
varying vec3 vNormal;
varying vec2 vUV;
varying float vHeight;
varying vec3 vViewDirection;
varying float vSlope;
varying float vCameraDistance;
varying mat3 vTBN;

void main() {
    // Sample splat map to get material weights
    vec4 splat = texture2D(uSplatMap, uv);
    float rockWeight = splat.b;
    float grassWeight = splat.r;

    // Calculate texture UV for displacement sampling (same as fragment shader)
    vec2 texUV = position.xz * uTextureScale;

    // Sample displacement maps
    float rockDispValue = texture2D(uRockDisp, texUV).r;
    float grassDispValue = texture2D(uGrassDisp, texUV).r;

    // Apply displacement for rock and grass areas
    float displacement = (rockDispValue - 0.5) * uDispStrength * rockWeight +
                         (grassDispValue - 0.5) * uDispStrength * 0.5 * grassWeight;

    vec3 displacedPosition = position + vec3(0.0, displacement, 0.0);

    vec4 worldPosition = modelMatrix * vec4(displacedPosition, 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(displacedPosition, 1.0);

    vPosition = worldPosition.xyz;
    vNormal = normalize(normal);
    vUV = uv;
    vHeight = displacedPosition.y;

    vec3 toCamera = cameraPosition - worldPosition.xyz;
    vCameraDistance = length(toCamera);
    vViewDirection = normalize(toCamera);

    // Calculate slope (0 = flat, 1 = vertical)
    vSlope = 1.0 - abs(dot(vec3(0.0, 1.0, 0.0), vNormal));

    // Build TBN matrix for tangent space calculations
    vec3 T = vec3(1.0, 0.0, 0.0);
    vec3 B = vec3(0.0, 0.0, 1.0);
    vec3 N = vNormal;
    vTBN = mat3(T, B, N);

    // Required by Three.js shadow map includes
    vec3 transformedNormal = normalize(normalMatrix * normal);

    // Shadow map coordinate computation
    #include <shadowmap_vertex>
}
`;

const terrainFragmentShader = `
precision highp float;

#include <common>
#include <packing>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>

// Uniforms
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uAmbientIntensity;
uniform sampler2D uSplatMap;
uniform sampler2D uWaterMask;
uniform float uTerrainSize;
uniform int uDebugMode;

// Material colors (fallback)
uniform vec3 uGrassColor;
uniform vec3 uDirtColor;
uniform vec3 uRockColor;
uniform vec3 uSandColor;

// Textures
uniform sampler2D uRockDiffuse;
uniform sampler2D uRockNormal;
uniform sampler2D uRockDisp;
uniform sampler2D uRockARM;
uniform sampler2D uDirtDiffuse;
uniform sampler2D uDirtNormal;
uniform sampler2D uDirtDisp;
uniform sampler2D uGrassDiffuse;
uniform sampler2D uGrassNormal;
uniform sampler2D uGrassARM;
uniform sampler2D uGrassDisp;
uniform float uTextureScale;
uniform float uNormalStrength;

// Fog
uniform vec3 uFogColor;
uniform float uFogDensity;

// Water/Underwater
uniform float uWaterLevel;
uniform float uTime;

// Point lights (Forward+)
uniform vec3 uPointLightPositions[8];
uniform vec3 uPointLightColors[8];
uniform float uPointLightRanges[8];
uniform int uPointLightCount;

vec3 calcPointLights(vec3 worldPos, vec3 normal) {
    vec3 totalLight = vec3(0.0);
    for (int i = 0; i < 8; i++) {
        if (i >= uPointLightCount) break;
        vec3 lightDir = uPointLightPositions[i] - worldPos;
        float dist = length(lightDir);
        float range = uPointLightRanges[i];
        if (dist > range) continue;
        lightDir /= dist;
        float NdotL = max(dot(normal, lightDir), 0.0);
        float attenuation = 1.0 / (1.0 + dist * dist / (range * range));
        float window = max(1.0 - pow(dist / range, 4.0), 0.0);
        totalLight += uPointLightColors[i] * NdotL * attenuation * window;
    }
    return totalLight;
}

// Varyings
varying vec3 vPosition;
varying vec3 vNormal;
varying vec2 vUV;
varying float vHeight;
varying vec3 vViewDirection;
varying float vSlope;
varying float vCameraDistance;
varying mat3 vTBN;

// Hash functions for noise
float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float hash3(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

// 2D noise
float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);

    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));

    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// FBM (Fractal Brownian Motion)
float fbm(vec2 p, int octaves) {
    float value = 0.0;
    float amplitude = 0.5;
    float frequency = 1.0;
    for (int i = 0; i < 6; i++) {
        if (i >= octaves) break;
        value += amplitude * noise(p * frequency);
        frequency *= 2.0;
        amplitude *= 0.5;
    }
    return value;
}

// Grass texture pattern
vec3 grassPattern(vec2 pos, vec3 baseColor) {
    float large = fbm(pos * 0.5, 2) * 0.15;
    float medium = fbm(pos * 2.0, 2) * 0.1;
    float small = fbm(pos * 8.0, 2) * 0.08;
    float blades = noise(pos * 15.0) * 0.05;

    vec3 lightGrass = baseColor * 1.15;
    vec3 darkGrass = baseColor * 0.85;
    float colorMix = fbm(pos * 1.5, 2);

    vec3 color = mix(darkGrass, lightGrass, colorMix);
    color *= (1.0 + large + medium + small + blades);

    return color;
}

// Dirt texture pattern
vec3 dirtPattern(vec2 uv, vec2 pos, vec3 baseColor) {
    vec3 texColor = texture2D(uDirtDiffuse, uv).rgb;
    float variation = fbm(pos * 0.3, 2) * 0.1;
    texColor *= (0.95 + variation);
    return texColor;
}

// Get dirt normal from texture
vec3 getDirtNormal(vec2 uv) {
    vec3 normalTex = texture2D(uDirtNormal, uv).rgb;
    vec3 n;
    n.x = (normalTex.r * 2.0 - 1.0) * uNormalStrength;
    n.y = (normalTex.g * 2.0 - 1.0) * uNormalStrength;
    n.z = normalTex.b;
    return normalize(n);
}

// Get height from dirt displacement map
float getDirtHeight(vec2 uv) {
    return texture2D(uDirtDisp, uv).r;
}

// Hash function that returns vec2 for variation
vec2 hash2(vec2 p) {
    return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453);
}

// UV noise to break tiling pattern
vec2 getDistortedUV(vec2 pos) {
    vec2 baseUV = pos * uTextureScale;

    vec2 noise1 = vec2(
        fbm(pos * 0.1, 2),
        fbm(pos * 0.1 + vec2(43.0, 17.0), 2)
    ) * 0.15;

    vec2 noise2 = vec2(
        noise(pos * 0.5),
        noise(pos * 0.5 + vec2(31.0, 23.0))
    ) * 0.05;

    return baseUV + noise1 + noise2;
}

// =============================================================================
// HEX TILING SYSTEM
// =============================================================================

struct HexUVData {
    vec2 uv1;
    vec2 uv2;
    float blend;
    float rot1;
    float rot2;
};

float hexCellRand(vec2 cell) {
    return fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);
}

HexUVData computeHexUV(vec2 uv) {
    HexUVData h;

    vec2 centerA = floor(uv) + 0.5;
    vec2 centerB = floor(uv + 0.5);

    vec2 dA = uv - centerA;
    vec2 dB = uv - centerB;
    float distA = dot(dA, dA);
    float distB = dot(dB, dB);

    h.rot1 = hexCellRand(centerA) * 6.28318;
    h.rot2 = hexCellRand(centerB) * 6.28318;

    float c1 = cos(h.rot1), s1 = sin(h.rot1);
    float c2 = cos(h.rot2), s2 = sin(h.rot2);
    h.uv1 = vec2(uv.x * c1 - uv.y * s1, uv.x * s1 + uv.y * c1);
    h.uv2 = vec2(uv.x * c2 - uv.y * s2, uv.x * s2 + uv.y * c2);

    h.blend = smoothstep(-0.12, 0.12, distB - distA);

    return h;
}

vec3 hexRockDiffuse(HexUVData h) {
    return mix(texture2D(uRockDiffuse, h.uv2).rgb, texture2D(uRockDiffuse, h.uv1).rgb, h.blend);
}

vec3 hexRockARM(HexUVData h) {
    return mix(texture2D(uRockARM, h.uv2).rgb, texture2D(uRockARM, h.uv1).rgb, h.blend);
}

float hexRockDisp(HexUVData h) {
    return mix(texture2D(uRockDisp, h.uv2).r, texture2D(uRockDisp, h.uv1).r, h.blend);
}

vec3 hexRockNormal(HexUVData h) {
    vec3 n1raw = texture2D(uRockNormal, h.uv1).rgb;
    vec3 n2raw = texture2D(uRockNormal, h.uv2).rgb;

    vec2 n1xy = (n1raw.rg * 2.0 - 1.0) * uNormalStrength;
    vec2 n2xy = (n2raw.rg * 2.0 - 1.0) * uNormalStrength;

    float c1 = cos(h.rot1), s1 = sin(h.rot1);
    float c2 = cos(h.rot2), s2 = sin(h.rot2);
    vec2 n1r = vec2(n1xy.x * c1 + n1xy.y * s1, -n1xy.x * s1 + n1xy.y * c1);
    vec2 n2r = vec2(n2xy.x * c2 + n2xy.y * s2, -n2xy.x * s2 + n2xy.y * c2);

    vec3 n1 = vec3(n1r, n1raw.b);
    vec3 n2 = vec3(n2r, n2raw.b);
    return normalize(mix(n2, n1, h.blend));
}

vec3 hexGrassDiffuse(HexUVData h) {
    return mix(texture2D(uGrassDiffuse, h.uv2).rgb, texture2D(uGrassDiffuse, h.uv1).rgb, h.blend);
}

vec3 hexGrassARM(HexUVData h) {
    return mix(texture2D(uGrassARM, h.uv2).rgb, texture2D(uGrassARM, h.uv1).rgb, h.blend);
}

vec3 hexGrassNormal(HexUVData h) {
    vec3 n1raw = texture2D(uGrassNormal, h.uv1).rgb;
    vec3 n2raw = texture2D(uGrassNormal, h.uv2).rgb;

    vec2 n1xy = (n1raw.rg * 2.0 - 1.0) * uNormalStrength;
    vec2 n2xy = (n2raw.rg * 2.0 - 1.0) * uNormalStrength;

    float c1 = cos(h.rot1), s1 = sin(h.rot1);
    float c2 = cos(h.rot2), s2 = sin(h.rot2);
    vec2 n1r = vec2(n1xy.x * c1 + n1xy.y * s1, -n1xy.x * s1 + n1xy.y * c1);
    vec2 n2r = vec2(n2xy.x * c2 + n2xy.y * s2, -n2xy.x * s2 + n2xy.y * c2);

    vec3 n1 = vec3(n1r, n1raw.b);
    vec3 n2 = vec3(n2r, n2raw.b);
    return normalize(mix(n2, n1, h.blend));
}

float hexGrassDisp(HexUVData h) {
    return mix(texture2D(uGrassDisp, h.uv2).r, texture2D(uGrassDisp, h.uv1).r, h.blend);
}

// Triplanar UV coordinates for steep surfaces
struct TriplanarUVs {
    vec2 uvX;
    vec2 uvY;
    vec2 uvZ;
    vec3 weights;
};

TriplanarUVs calculateTriplanarUVs(vec3 worldPos, vec3 worldNormal, float scale) {
    TriplanarUVs result;

    result.uvX = worldPos.yz * scale;
    result.uvY = worldPos.xz * scale;
    result.uvZ = worldPos.xy * scale;

    vec3 blendWeights = abs(worldNormal);
    blendWeights = pow(blendWeights, vec3(4.0));

    float weightSum = blendWeights.x + blendWeights.y + blendWeights.z;
    result.weights = blendWeights / max(weightSum, 0.001);

    return result;
}

// =============================================================================
// MACRO VARIATION SYSTEM
// =============================================================================

struct MacroVariation {
    float brightness;
    float saturation;
    vec3 tint;
    float normalStrength;
};

MacroVariation calculateMacroVariation(vec2 worldPos) {
    MacroVariation mv;

    float macroNoise1 = fbm(worldPos * 0.02, 2);
    float macroNoise2 = fbm(worldPos * 0.05 + vec2(100.0, 50.0), 2);
    float macroNoise3 = fbm(worldPos * 0.03 + vec2(37.0, 89.0), 2);

    mv.brightness = 0.9 + macroNoise1 * 0.2;
    mv.saturation = 0.95 + macroNoise2 * 0.15;

    float tintR = 1.0 + (macroNoise1 - 0.5) * 0.08;
    float tintG = 1.0 + (macroNoise2 - 0.5) * 0.06;
    float tintB = 1.0 + (macroNoise3 - 0.5) * 0.04;
    mv.tint = vec3(tintR, tintG, tintB);

    mv.normalStrength = macroNoise3 * 0.15;

    return mv;
}

vec3 applyMacroVariation(vec3 color, MacroVariation mv) {
    vec3 tinted = color * mv.tint;
    float luminance = dot(tinted, vec3(0.299, 0.587, 0.114));
    vec3 saturated = mix(vec3(luminance), tinted, mv.saturation);
    vec3 result = saturated * mv.brightness;
    return result;
}

vec3 calculateMacroNormal(vec2 worldPos, vec3 baseNormal, float strength) {
    if (strength < 0.001) return baseNormal;

    float epsilon = 2.0;
    float h0 = fbm(worldPos * 0.015, 2);
    float hX = fbm((worldPos + vec2(epsilon, 0.0)) * 0.015, 2);
    float hZ = fbm((worldPos + vec2(0.0, epsilon)) * 0.015, 2);

    float dX = (hX - h0) / epsilon;
    float dZ = (hZ - h0) / epsilon;

    vec3 macroPerturbation = normalize(vec3(-dX * strength, 1.0, -dZ * strength));

    vec3 t = baseNormal + vec3(0.0, 1.0, 0.0);
    vec3 u = macroPerturbation * vec3(-1.0, -1.0, 1.0);
    vec3 result = normalize(t * dot(t, u) - u * t.y);

    return result;
}

// Sand texture pattern
vec3 sandPattern(vec2 pos, vec3 baseColor) {
    float ripples = sin(pos.x * 8.0 + fbm(pos * 2.0, 2) * 3.0) * 0.03;
    ripples += sin(pos.y * 6.0 + pos.x * 2.0) * 0.02;

    float grain = noise(pos * 50.0) * 0.03;
    float dunes = fbm(pos * 0.5, 2) * 0.1;

    vec3 lightSand = baseColor * 1.1;
    vec3 shadowSand = baseColor * 0.9;
    float colorMix = fbm(pos * 1.0, 2);

    vec3 color = mix(shadowSand, lightSand, colorMix);
    color *= (1.0 + ripples + grain + dunes);

    return color;
}

void main() {
    // Sample splat map and water mask
    vec4 splat = texture2D(uSplatMap, vUV);
    float waterMaskValue = texture2D(uWaterMask, vUV).r;
    vec2 worldPos = vPosition.xz;

    // Debug render modes
    if (uDebugMode == 1) {
        gl_FragColor = vec4(splat.rgb, 1.0);
        return;
    }
    if (uDebugMode == 7) {
        gl_FragColor = vec4(normalize(vNormal) * 0.5 + 0.5, 1.0);
        return;
    }
    if (uDebugMode == 12) {
        float normalizedHeight = (vHeight + 5.0) / 20.0;
        gl_FragColor = vec4(vec3(normalizedHeight), 1.0);
        return;
    }

    // Suppress grass in water areas, boost sand near water
    splat.r *= (1.0 - waterMaskValue);
    float sandBoost = smoothstep(0.0, 0.5, waterMaskValue) * 0.5;
    splat.a += sandBoost;

    // Normalize splat weights to ensure they sum to 1.0
    float totalWeight = splat.r + splat.g + splat.b + splat.a;
    vec4 normalizedSplat = totalWeight > 0.0 ? splat / totalWeight : vec4(1.0, 0.0, 0.0, 0.0);

    // Calculate distorted UV for flat surfaces
    vec2 texUV = getDistortedUV(worldPos);

    // Compute hex tiling UVs for rock (eliminates grid repetition)
    HexUVData hexUV = computeHexUV(texUV);

    // Calculate triplanar UVs for steep surfaces (cliffs)
    vec3 geometryNormal = normalize(vNormal);
    TriplanarUVs triUVs = calculateTriplanarUVs(vPosition, geometryNormal, uTextureScale);

    // Triplanar blend factor: use triplanar on steep slopes
    float triplanarBlend = smoothstep(0.5, 0.7, vSlope);

    // Weight threshold
    float wThresh = 0.01;

    // Generate detailed textures only for materials with significant weight
    vec3 grassColor = vec3(0.0);
    float grassAO = 1.0;
    float grassRoughness = 0.5;
    float grassHeight = 0.0;
    if (normalizedSplat.r > wThresh) {
        grassColor = hexGrassDiffuse(hexUV) * (0.95 + fbm(worldPos * 0.3, 2) * 0.1);
        vec3 grassARMVal = hexGrassARM(hexUV);
        grassAO = grassARMVal.r;
        grassRoughness = grassARMVal.g;
        grassHeight = hexGrassDisp(hexUV);
    }

    vec3 dirtColor = vec3(0.0);
    float dirtHeight = 0.0;
    if (normalizedSplat.g > wThresh) {
        dirtColor = dirtPattern(texUV, worldPos, uDirtColor);
        dirtHeight = getDirtHeight(texUV);
    }

    vec3 sandColor = vec3(0.0);
    if (normalizedSplat.a > wThresh) {
        sandColor = sandPattern(worldPos, uSandColor);
    }

    vec3 rockColor = vec3(0.0);
    float rockAO = 1.0;
    float rockRoughness = 0.5;
    float rockHeight = 0.0;
    if (normalizedSplat.b > wThresh) {
        vec3 rockColorPlanar = hexRockDiffuse(hexUV) * (0.95 + fbm(worldPos * 0.3, 2) * 0.1);
        vec3 rockColorTriplanar =
            texture2D(uRockDiffuse, triUVs.uvX).rgb * triUVs.weights.x +
            texture2D(uRockDiffuse, triUVs.uvY).rgb * triUVs.weights.y +
            texture2D(uRockDiffuse, triUVs.uvZ).rgb * triUVs.weights.z;
        float triVariation = fbm(worldPos * 0.3, 2) * 0.1;
        rockColorTriplanar *= (0.95 + triVariation);
        rockColor = mix(rockColorPlanar, rockColorTriplanar, triplanarBlend);

        vec3 rockARMPlanar = hexRockARM(hexUV);
        vec3 rockARMTriplanar =
            texture2D(uRockARM, triUVs.uvX).rgb * triUVs.weights.x +
            texture2D(uRockARM, triUVs.uvY).rgb * triUVs.weights.y +
            texture2D(uRockARM, triUVs.uvZ).rgb * triUVs.weights.z;
        vec3 rockARMVal = mix(rockARMPlanar, rockARMTriplanar, triplanarBlend);
        rockAO = rockARMVal.r;
        rockRoughness = rockARMVal.g;

        float rockHeightPlanar = hexRockDisp(hexUV);
        float rockHeightTriplanar =
            texture2D(uRockDisp, triUVs.uvX).r * triUVs.weights.x +
            texture2D(uRockDisp, triUVs.uvY).r * triUVs.weights.y +
            texture2D(uRockDisp, triUVs.uvZ).r * triUVs.weights.z;
        rockHeight = mix(rockHeightPlanar, rockHeightTriplanar, triplanarBlend);
    }

    // Blend materials based on normalized splat map weights
    vec3 baseColor = grassColor * normalizedSplat.r +
                     dirtColor * normalizedSplat.g +
                     rockColor * normalizedSplat.b +
                     sandColor * normalizedSplat.a;

    // Add height-based color variation
    float heightBlend = smoothstep(-2.0, 15.0, vHeight);
    baseColor = mix(baseColor * 0.92, baseColor * 1.08, heightBlend);

    // Macro variation
    MacroVariation macroVar = calculateMacroVariation(worldPos);
    baseColor = applyMacroVariation(baseColor, macroVar);

    // Normal maps
    float rockWeight = normalizedSplat.b;
    float dirtWeight = normalizedSplat.g;
    float grassWeight = normalizedSplat.r;

    vec3 rockNormalPlanar = vec3(0.0, 0.0, 1.0);
    vec3 rockPerturbedNormal = geometryNormal;
    vec3 dirtPerturbedNormal = geometryNormal;
    vec3 grassPerturbedNormal = geometryNormal;

    if (grassWeight > wThresh) {
        vec3 grassNormalTex = hexGrassNormal(hexUV);
        grassPerturbedNormal = vTBN * grassNormalTex;
    }

    if (dirtWeight > wThresh) {
        vec3 dirtNormalTex = getDirtNormal(texUV);
        dirtPerturbedNormal = vTBN * dirtNormalTex;
    }

    if (rockWeight > wThresh) {
        rockNormalPlanar = hexRockNormal(hexUV);
        vec3 rockPerturbedPlanar = vTBN * rockNormalPlanar;

        vec3 triNormalX = texture2D(uRockNormal, triUVs.uvX).rgb * 2.0 - 1.0;
        vec3 triNormalY = texture2D(uRockNormal, triUVs.uvY).rgb * 2.0 - 1.0;
        vec3 triNormalZ = texture2D(uRockNormal, triUVs.uvZ).rgb * 2.0 - 1.0;
        triNormalX.xy *= uNormalStrength;
        triNormalY.xy *= uNormalStrength;
        triNormalZ.xy *= uNormalStrength;
        vec3 worldNormalX = vec3(triNormalX.z, triNormalX.xy) * sign(geometryNormal.x);
        vec3 worldNormalY = vec3(triNormalY.x, triNormalY.z, triNormalY.y) * sign(geometryNormal.y);
        vec3 worldNormalZ = vec3(triNormalZ.xy, triNormalZ.z) * sign(geometryNormal.z);
        vec3 rockNormalTriplanar = normalize(
            worldNormalX * triUVs.weights.x +
            worldNormalY * triUVs.weights.y +
            worldNormalZ * triUVs.weights.z
        );

        rockPerturbedNormal = mix(rockPerturbedPlanar, rockNormalTriplanar, triplanarBlend);
    }

    // Combine perturbed normals
    vec3 perturbedNormal = normalize(
        geometryNormal * (1.0 - rockWeight - dirtWeight - grassWeight) +
        rockPerturbedNormal * rockWeight +
        dirtPerturbedNormal * dirtWeight +
        grassPerturbedNormal * grassWeight
    );

    // Apply macro normal variation
    vec3 normal = calculateMacroNormal(worldPos, perturbedNormal, macroVar.normalStrength);

    // Enhanced lighting using ARM texture
    float NdotL = max(dot(normal, uSunDirection), 0.0);
    float diffuse = NdotL * (1.0 - uAmbientIntensity) + uAmbientIntensity;

    float rim = 1.0 - max(dot(normal, vViewDirection), 0.0);
    rim = pow(rim, 4.0) * 0.1;

    // Specular - roughness controls shininess
    vec3 halfVector = normalize(uSunDirection + vViewDirection);
    float NdotH = max(dot(normal, halfVector), 0.0);

    float rockSmoothness = 1.0 - rockRoughness;
    float rockSpecPower = mix(16.0, 128.0, rockSmoothness);
    float rockSpecIntensity = mix(0.02, 0.15, rockSmoothness);
    float rockSpecular = pow(NdotH, rockSpecPower) * rockSpecIntensity;

    float grassSmoothness = 1.0 - grassRoughness;
    float grassSpecPower = mix(16.0, 128.0, grassSmoothness);
    float grassSpecIntensity = mix(0.02, 0.15, grassSmoothness);
    float grassSpecular = pow(NdotH, grassSpecPower) * grassSpecIntensity;

    float specular = rockSpecular * rockWeight + grassSpecular * grassWeight;

    // Ambient occlusion
    float geometricAO = 0.8 + 0.2 * smoothstep(-5.0, 10.0, vHeight);
    geometricAO *= (1.0 - vSlope * 0.25);
    float ao = geometricAO * mix(1.0, rockAO, rockWeight) * mix(1.0, grassAO, grassWeight);

    // Shadow factor from shadow map
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
    vec3 pointLightContrib = calcPointLights(vPosition, normal);

    // Final color composition
    vec3 color = baseColor * ao * (uAmbientIntensity + diffuse * uSunColor * shadowFactor + pointLightContrib) + specular * uSunColor * shadowFactor + rim;

    // Wet sand/shore effect
    if (waterMaskValue > 0.1) {
        float heightAboveWater = vHeight - uWaterLevel;
        float wetZoneHeight = 0.5;
        if (heightAboveWater > 0.0 && heightAboveWater < wetZoneHeight) {
            float wetness = 1.0 - (heightAboveWater / wetZoneHeight);
            wetness = pow(wetness, 0.7);
            wetness *= waterMaskValue;
            color *= mix(1.0, 0.7, wetness);

            vec3 viewDir = vViewDirection;
            vec3 lightDir = normalize(vec3(0.5, 0.8, 0.3));
            vec3 halfVec = normalize(viewDir + lightDir);
            float wetSpecular = pow(max(dot(vNormal, halfVec), 0.0), 32.0);
            color += vec3(0.1, 0.12, 0.15) * wetSpecular * wetness * 0.3;
        }
    }

    // Underwater effect
    if (waterMaskValue > 0.1) {
        float underwaterDepth = uWaterLevel - vHeight;
        if (underwaterDepth > 0.0) {
            float depthFactor = clamp(underwaterDepth / 4.0, 0.0, 1.0);
            depthFactor *= waterMaskValue;

            vec3 underwaterColor = vec3(0.1, 0.3, 0.4);
            color = mix(color, underwaterColor, depthFactor * 0.6);

            vec2 causticUV = vPosition.xz * 0.15;
            float caustic1 = sin(causticUV.x * 3.0 + uTime * 0.8) * cos(causticUV.y * 2.5 + uTime * 0.6);
            float caustic2 = sin(causticUV.x * 2.0 - uTime * 0.5) * cos(causticUV.y * 3.5 + uTime * 0.9);
            float caustics = (caustic1 + caustic2) * 0.5 + 0.5;
            caustics = pow(caustics, 2.0) * 0.3;

            float causticFade = 1.0 - depthFactor;
            color += vec3(caustics * causticFade * 0.15);

            float gray = dot(color, vec3(0.299, 0.587, 0.114));
            color = mix(color, vec3(gray), depthFactor * 0.3);
        }
    }

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>

    // Fog handled by VolumetricFogPass (post-processing)
}
`;

// ============================================
// TerrainRenderer Class
// ============================================

export class TerrainRenderer {
  private scene: THREE.Scene;
  private mesh: THREE.Mesh | null = null;
  private lodMeshes: THREE.Mesh[] = [];
  private material: THREE.ShaderMaterial | null = null;
  private fallbackMaterial: THREE.MeshStandardMaterial | null = null;

  private splatTexture: THREE.DataTexture | null = null;
  private waterMaskTexture: THREE.DataTexture | null = null;

  private data: TerrainRenderData | null = null;
  private options: Omit<Required<TerrainRendererOptions>, "textures"> & {
    textures?: undefined;
  };

  private lodEnabled: boolean = true;
  private currentLOD: number = 0;
  private lodDistances: number[] = [];

  private wireframe: boolean = false;
  private debugMode: number = 0;
  private dispStrength: number = 0.2;

  // Default 1x1 white texture for unbound samplers
  private defaultTexture: THREE.DataTexture;

  constructor(scene: THREE.Scene, options: TerrainRendererOptions = {}) {
    this.scene = scene;
    this.options = {
      lodEnabled: options.lodEnabled ?? true,
      useShader: options.useShader ?? true,
      wireframe: options.wireframe ?? false,
      dispStrength: options.dispStrength ?? 0.2,
    };

    this.wireframe = this.options.wireframe;
    this.dispStrength = this.options.dispStrength;
    this.lodEnabled = this.options.lodEnabled;

    this.defaultTexture = createDataTexture(
      new Uint8Array([128, 128, 255, 255]),
      1,
      1
    );
  }

  // ============================================
  // Public API
  // ============================================

  create(data: TerrainRenderData): void {
    this.dispose();
    this.data = data;

    this.createTextures();

    if (this.options.useShader) {
      this.createShaderMaterial();
    } else {
      this.createFallbackMaterial();
    }

    this.createLODMeshes();
  }

  setData(data: TerrainRenderData): void {
    this.data = data;
    this.updateHeightmap(data.heightmap);
    this.updateSplatmap(data.splatmap);
    this.updateWaterMask(data.waterMask);
  }

  updateHeightmap(heightmap: Float32Array): void {
    if (!this.data) return;
    this.data.heightmap = heightmap;

    for (const mesh of this.lodMeshes) {
      this.updateMeshVertices(mesh);
    }
  }

  updateSplatmap(splatmap: Float32Array): void {
    if (!this.data || !this.splatTexture) return;
    this.data.splatmap = splatmap;

    const res = this.data.resolution;
    const rgba = this.convertToRGBA(splatmap, res);
    (this.splatTexture.image as ImageData).data.set(rgba);
    this.splatTexture.needsUpdate = true;
  }

  updateWaterMask(waterMask: Float32Array): void {
    if (!this.data || !this.waterMaskTexture) return;
    this.data.waterMask = waterMask;

    const res = this.data.resolution;
    const rgba = this.convertMaskToRGBA(waterMask, res);
    (this.waterMaskTexture.image as ImageData).data.set(rgba);
    this.waterMaskTexture.needsUpdate = true;
  }

  getMesh(): THREE.Mesh | null {
    return this.mesh;
  }

  getLODMeshes(): THREE.Mesh[] {
    return this.lodMeshes;
  }

  getCurrentLODInfo(): {
    level: number;
    resolution: number;
    totalLevels: number;
  } {
    const res = this.data?.resolution ?? 0;
    return {
      level: this.currentLOD,
      resolution: Math.floor(res / Math.pow(2, this.currentLOD)),
      totalLevels: this.lodMeshes.length,
    };
  }

  setLODEnabled(enabled: boolean): void {
    this.lodEnabled = enabled;
    if (!enabled) {
      this.lodMeshes.forEach((m, i) => {
        m.visible = i === 0;
      });
    }
  }

  setWireframe(enabled: boolean): void {
    this.wireframe = enabled;
    if (this.material) {
      this.material.wireframe = enabled;
    }
    if (this.fallbackMaterial) {
      this.fallbackMaterial.wireframe = enabled;
    }
  }

  setDebugMode(mode: number): void {
    this.debugMode = mode;
    if (this.material) {
      this.material.uniforms.uDebugMode.value = mode;
    }
  }

  setDispStrength(strength: number): void {
    this.dispStrength = strength;
    if (this.material) {
      this.material.uniforms.uDispStrength.value = strength;
    }
  }

  setWaterLevel(level: number): void {
    if (this.data) {
      this.data.seaLevel = level;
    }
    if (this.material) {
      this.material.uniforms.uWaterLevel.value = level;
    }
  }

  setSunDirection(direction: THREE.Vector3): void {
    if (this.material) {
      this.material.uniforms.uSunDirection.value.copy(direction);
    }
  }

  setSunColor(color: THREE.Color): void {
    if (this.material) {
      this.material.uniforms.uSunColor.value.copy(color);
    }
  }

  setAmbientIntensity(intensity: number): void {
    if (this.material) {
      this.material.uniforms.uAmbientIntensity.value = intensity;
    }
  }

  setFog(color: THREE.Color, density: number): void {
    if (this.material) {
      this.material.uniforms.uFogColor.value.copy(color);
      this.material.uniforms.uFogDensity.value = density;
    }
  }

  /**
   * Update LOD based on camera position. Call from render loop.
   */
  updateLOD(cameraPosition: THREE.Vector3): void {
    if (!this.lodEnabled || this.lodMeshes.length === 0 || !this.mesh) return;

    const dist = cameraPosition.distanceTo(this.mesh.position);

    let newLOD = 0;
    for (let i = 0; i < this.lodDistances.length; i++) {
      if (dist > this.lodDistances[i]) {
        newLOD = Math.min(i + 1, this.lodMeshes.length - 1);
      }
    }

    if (newLOD !== this.currentLOD) {
      this.lodMeshes.forEach((m, i) => {
        m.visible = i === newLOD;
      });
      this.currentLOD = newLOD;
    }
  }

  /**
   * Update time uniform (for underwater caustics). Call from render loop.
   */
  updateTime(time: number): void {
    if (this.material) {
      this.material.uniforms.uTime.value = time;
    }
  }

  /**
   * Update camera position uniform. Call from render loop.
   */
  updateCameraPosition(_cameraPosition: THREE.Vector3): void {
    // Camera position is auto-injected by Three.js as `cameraPosition` built-in
    // No manual uniform needed for the editor shader
  }

  dispose(): void {
    for (const mesh of this.lodMeshes) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.lodMeshes = [];
    this.mesh = null;

    this.splatTexture?.dispose();
    this.splatTexture = null;
    this.waterMaskTexture?.dispose();
    this.waterMaskTexture = null;

    this.material?.dispose();
    this.material = null;
    this.fallbackMaterial?.dispose();
    this.fallbackMaterial = null;

    this.data = null;
  }

  // ============================================
  // Private Methods
  // ============================================

  private createTextures(): void {
    if (!this.data) return;

    const res = this.data.resolution;

    const splatRGBA = this.convertToRGBA(this.data.splatmap, res);
    this.splatTexture = createDataTexture(splatRGBA, res, res);

    const waterRGBA = this.convertMaskToRGBA(this.data.waterMask, res);
    this.waterMaskTexture = createDataTexture(waterRGBA, res, res);
  }

  private loadTerrainTexture(basePath: string): THREE.Texture {
    return loadTextureWithFallbackSync(basePath, {
      preferredExtensions: ["ktx2", "jpg", "png"],
      anisotropy: 16,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
    });
  }

  private createShaderMaterial(): void {
    const sunDir = new THREE.Vector3(0.5, 0.8, 0.3).normalize();

    const uniforms: Record<string, { value: unknown }> = {
      // Sun / lighting
      uSunDirection: { value: sunDir },
      uSunColor: { value: new THREE.Color(1.0, 0.95, 0.85) },
      uAmbientIntensity: { value: 0.4 },

      // Splat / water
      uSplatMap: { value: this.splatTexture },
      uWaterMask: { value: this.waterMaskTexture },
      uTerrainSize: { value: this.data?.size ?? 64 },

      // Material colors (fallback)
      uGrassColor: { value: new THREE.Color(0.4, 0.6, 0.25) },
      uDirtColor: { value: new THREE.Color(0.52, 0.42, 0.28) },
      uRockColor: { value: new THREE.Color(0.48, 0.48, 0.5) },
      uSandColor: { value: new THREE.Color(0.82, 0.72, 0.52) },

      // Rock textures
      uRockDiffuse: { value: this.loadTerrainTexture("/textures/rock_diff") },
      uRockNormal: { value: this.loadTerrainTexture("/textures/rock_nor") },
      uRockDisp: { value: this.loadTerrainTexture("/textures/rock_disp") },
      uRockARM: { value: this.loadTerrainTexture("/textures/rock_arm") },

      // Dirt textures
      uDirtDiffuse: { value: this.loadTerrainTexture("/textures/dirt_diffuse") },
      uDirtNormal: { value: this.loadTerrainTexture("/textures/dirt_normal") },
      uDirtDisp: { value: this.loadTerrainTexture("/textures/dirt_disp") },

      // Grass textures
      uGrassDiffuse: { value: this.loadTerrainTexture("/textures/grass_diff") },
      uGrassNormal: { value: this.loadTerrainTexture("/textures/grass_nor") },
      uGrassARM: { value: this.loadTerrainTexture("/textures/grass_arm") },
      uGrassDisp: { value: this.loadTerrainTexture("/textures/grass_disp") },

      // Texture settings
      uTextureScale: { value: 1.0 },
      uNormalStrength: { value: 1.5 },
      uDispStrength: { value: this.dispStrength },

      // Fog
      uFogColor: { value: new THREE.Color(0.6, 0.75, 0.9) },
      uFogDensity: { value: 0.008 },

      // Water / underwater
      uWaterLevel: { value: this.data?.seaLevel ?? -100 },
      uTime: { value: 0 },

      // Debug
      uDebugMode: { value: this.debugMode },

      // Point lights (Forward+)
      uPointLightPositions: { value: new Float32Array(8 * 3) },
      uPointLightColors: { value: new Float32Array(8 * 3) },
      uPointLightRanges: { value: new Float32Array(8) },
      uPointLightCount: { value: 0 },
    };

    this.material = new THREE.ShaderMaterial({
      vertexShader: terrainVertexShader,
      fragmentShader: terrainFragmentShader,
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.lights),
        ...uniforms,
      },
      lights: true,
      wireframe: this.wireframe,
      side: THREE.FrontSide,
    });
  }

  private createFallbackMaterial(): void {
    this.fallbackMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0.3, 0.5, 0.2),
      wireframe: this.wireframe,
      side: THREE.FrontSide,
    });
  }

  private createLODMeshes(): void {
    if (!this.data) return;

    const res = this.data.resolution;
    const size = this.data.size;

    this.lodDistances = [size * 1.0, size * 2.0];

    const lodResolutions = [res, Math.floor(res / 2), Math.floor(res / 4)];

    for (let i = 0; i < lodResolutions.length; i++) {
      const lodRes = Math.max(4, lodResolutions[i]);
      const mesh = this.createMeshForResolution(lodRes, size);

      mesh.material = this.material ?? this.fallbackMaterial!;
      mesh.visible = i === 0;
      mesh.receiveShadow = true;

      this.scene.add(mesh);
      this.lodMeshes.push(mesh);
    }

    this.mesh = this.lodMeshes[0];
  }

  private createMeshForResolution(
    resolution: number,
    size: number
  ): THREE.Mesh {
    // PlaneGeometry is in XY plane, we rotate to XZ plane
    const geometry = new THREE.PlaneGeometry(
      size,
      size,
      resolution,
      resolution
    );

    // Rotate from XY to XZ (lying flat)
    geometry.rotateX(-Math.PI / 2);

    // Apply heightmap
    this.applyHeightmapToGeometry(geometry);

    const mesh = new THREE.Mesh(geometry);

    // Offset to match editor coordinates (0,0)~(size,size) instead of centered
    mesh.position.set(size / 2, 0, size / 2);

    return mesh;
  }

  private applyHeightmapToGeometry(geometry: THREE.BufferGeometry): void {
    if (!this.data) return;

    const positions = geometry.attributes.position;
    const uvs = geometry.attributes.uv;
    if (!positions || !uvs) return;

    const sourceRes = this.data.resolution + 1;
    const heightmap = this.data.heightmap;

    for (let i = 0; i < positions.count; i++) {
      const u = uvs.getX(i);
      const v = uvs.getY(i);

      // Three.js PlaneGeometry UV: (0,1) top-left to (1,0) bottom-right
      // After rotateX(-PI/2), the plane is in XZ. UVs need v-flip for heightmap sampling.
      const height = this.sampleHeightmap(heightmap, sourceRes, u, 1 - v);
      positions.setY(i, height);
    }

    positions.needsUpdate = true;
    geometry.computeVertexNormals();
  }

  private updateMeshVertices(mesh: THREE.Mesh): void {
    const geometry = mesh.geometry as THREE.BufferGeometry;
    this.applyHeightmapToGeometry(geometry);
  }

  private sampleHeightmap(
    heightmap: Float32Array,
    resolution: number,
    u: number,
    v: number
  ): number {
    const x = u * (resolution - 1);
    const z = v * (resolution - 1);

    const x0 = Math.floor(x);
    const z0 = Math.floor(z);
    const x1 = Math.min(x0 + 1, resolution - 1);
    const z1 = Math.min(z0 + 1, resolution - 1);

    const fx = x - x0;
    const fz = z - z0;

    const h00 = heightmap[z0 * resolution + x0] ?? 0;
    const h10 = heightmap[z0 * resolution + x1] ?? 0;
    const h01 = heightmap[z1 * resolution + x0] ?? 0;
    const h11 = heightmap[z1 * resolution + x1] ?? 0;

    const h0 = h00 * (1 - fx) + h10 * fx;
    const h1 = h01 * (1 - fx) + h11 * fx;

    return h0 * (1 - fz) + h1 * fz;
  }

  private convertToRGBA(
    splatmap: Float32Array,
    resolution: number
  ): Uint8Array {
    const size = resolution * resolution;
    const rgba = new Uint8Array(size * 4);

    for (let i = 0; i < size; i++) {
      rgba[i * 4 + 0] = Math.floor((splatmap[i * 4 + 0] ?? 1) * 255);
      rgba[i * 4 + 1] = Math.floor((splatmap[i * 4 + 1] ?? 0) * 255);
      rgba[i * 4 + 2] = Math.floor((splatmap[i * 4 + 2] ?? 0) * 255);
      rgba[i * 4 + 3] = Math.floor((splatmap[i * 4 + 3] ?? 0) * 255);
    }

    return rgba;
  }

  private convertMaskToRGBA(
    mask: Float32Array,
    resolution: number
  ): Uint8Array {
    const size = resolution * resolution;
    const rgba = new Uint8Array(size * 4);

    for (let i = 0; i < size; i++) {
      const value = Math.floor((mask[i] ?? 0) * 255);
      rgba[i * 4 + 0] = value;
      rgba[i * 4 + 1] = value;
      rgba[i * 4 + 2] = value;
      rgba[i * 4 + 3] = 255;
    }

    return rgba;
  }
}
