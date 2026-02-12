/**
 * Optimized Open World Water Shader
 *
 * Features:
 * - Heightmap-based water depth calculation (no extra render pass)
 * - Soft edge blending at shore
 * - Shore foam based on depth
 * - Fresnel effect for angle-based reflection
 * - Depth-based color and transparency
 * - Gerstner waves for realistic wave motion
 *
 * Optimizations:
 * - No DepthRenderer (saves 1 render pass)
 * - No RefractionRTT (saves 1 render pass)
 * - Reduced mesh subdivisions (64 vs 128)
 */

import * as THREE from "three";
import { Heightmap } from "./Heightmap";

// ============================================
// Water Vertex Shader
// ============================================
const waterVertexShader = `
precision highp float;

uniform float uTime;
uniform float uWaterLevel;

uniform vec4 uWave0;
uniform vec4 uWave1;
uniform vec4 uWave2;
uniform vec4 uWave3;

// Wave direction rotation (pre-computed cos/sin)
uniform float uWaveAngleCos;
uniform float uWaveAngleSin;

// Heightmap for depth-based wave attenuation
uniform sampler2D uHeightmap;
uniform float uTerrainScale;
uniform float uHeightScale;
uniform float uMinHeight;

// Interactive water (ripples from player/objects)
uniform sampler2D uInteractiveHeight;
uniform float uInteractiveEnabled;
uniform float uInteractiveStrength;

// Wind-driven waves (shared with grass)
uniform sampler2D uWindTexture;
uniform float uWindWaveStrength;
uniform vec2 uWindDirection;
uniform float uWindEnabled;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vUV;
varying vec4 vScreenPos;
varying vec3 vViewVector;
varying float vWaveHeight;
varying vec2 vOrigXZ;
varying float vDepth;
varying vec3 vWindNormal;
varying float vWindMod;

vec3 gerstnerWave(vec4 wave, vec3 p) {
    float steepness = wave.z;
    float wavelength = wave.w;
    if (wavelength < 0.01) return vec3(0.0);
    float k = 2.0 * 3.14159265 / wavelength;
    float c = sqrt(9.8 / k);
    vec2 rawD = normalize(wave.xy);
    vec2 d = vec2(rawD.x * uWaveAngleCos - rawD.y * uWaveAngleSin, rawD.x * uWaveAngleSin + rawD.y * uWaveAngleCos);
    float f = k * (dot(d, p.xz) - c * uTime);
    float a = steepness / k;
    return vec3(d.x * a * cos(f), a * sin(f), d.y * a * cos(f));
}

void main() {
    vec3 worldPos = (modelMatrix * vec4(position, 1.0)).xyz;
    vOrigXZ = worldPos.xz;

    // Sample terrain height for depth-based wave attenuation
    vec2 hmUV = clamp(worldPos.xz / uTerrainScale, 0.0, 1.0);
    float terrainH = texture2D(uHeightmap, hmUV).r * uHeightScale + uMinHeight;
    float localDepth = max(uWaterLevel - terrainH, 0.0);
    vDepth = localDepth;

    // Attenuate waves in shallow water (prevents clipping through terrain)
    float depthDamping = smoothstep(0.0, 1.5, localDepth);

    // Wind-driven waves (synced with grass wind texture)
    // Sample wind FIRST so we can modulate Gerstner with it
    vWindNormal = vec3(0.0, 1.0, 0.0);
    float windMod = 1.0; // Gerstner modulation factor (1.0 = no wind texture)
    float windDisp = 0.0;
    if (uWindEnabled > 0.5) {
        vec2 windDir = normalize(uWindDirection);
        // Slower scroll than grass (0.06 vs 0.1) — water has more inertia
        vec2 windUV = worldPos.xz * 0.025 + windDir * uTime * 0.06;
        float windNoise = texture2D(uWindTexture, windUV).r * 2.0 - 1.0;

        vec2 flutterUV = worldPos.xz * 0.06 + windDir * uTime * 0.09;
        float flutter = texture2D(uWindTexture, flutterUV).r * 0.15;

        float combinedWind = windNoise + flutter;

        // Modulate Gerstner: calm when wind is low, active when wind is strong
        windMod = smoothstep(-0.3, 0.7, combinedWind);

        // Direct wind displacement (bidirectional — creates back-and-forth)
        windDisp = combinedWind * uWindWaveStrength * depthDamping;

        // Vertex finite-difference normal for wind displacement
        float eps = 0.02;
        float hx = (texture2D(uWindTexture, windUV + vec2(eps, 0.0)).r * 2.0 - 1.0
                   + texture2D(uWindTexture, flutterUV + vec2(eps, 0.0)).r * 0.15) * uWindWaveStrength;
        float hz = (texture2D(uWindTexture, windUV + vec2(0.0, eps)).r * 2.0 - 1.0
                   + texture2D(uWindTexture, flutterUV + vec2(0.0, eps)).r * 0.15) * uWindWaveStrength;
        float h0 = combinedWind * uWindWaveStrength;
        vWindNormal = normalize(vec3((h0 - hx) / eps, 1.0, (h0 - hz) / eps));
    }

    // Gerstner waves modulated by wind intensity
    vec3 displacement = vec3(0.0);
    displacement += gerstnerWave(uWave0, worldPos);
    displacement += gerstnerWave(uWave1, worldPos);
    displacement += gerstnerWave(uWave2, worldPos);
    displacement += gerstnerWave(uWave3, worldPos);
    displacement *= depthDamping * windMod;

    // Add wind-driven displacement
    displacement.y += windDisp;

    // Add interactive water ripples (from player/objects)
    if (uInteractiveEnabled > 0.5) {
        vec2 interactiveUV = clamp(worldPos.xz / uTerrainScale, 0.0, 1.0);
        float interactiveHeight = texture2D(uInteractiveHeight, interactiveUV).r;
        displacement.y += interactiveHeight * uInteractiveStrength * depthDamping;
    }

    worldPos += displacement;
    vWaveHeight = displacement.y;
    vWindMod = windMod;

    vWorldPos = worldPos;
    vNormal = vec3(0.0, 1.0, 0.0);
    vUV = uv;

    vec4 clipPos = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
    vScreenPos = clipPos;

    vViewVector = normalize(cameraPosition - worldPos);

    gl_Position = clipPos;
}
`;

// ============================================
// Water Fragment Shader with Depth-based Effects
// ============================================
const waterFragmentShader = `
precision highp float;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vUV;
varying vec4 vScreenPos;
varying vec3 vViewVector;
varying float vWaveHeight;
varying vec2 vOrigXZ;
varying float vDepth;
varying vec3 vWindNormal;
varying float vWindMod;

uniform float uTime;
uniform float uWaterLevel;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;

uniform vec4 uWave0;
uniform vec4 uWave1;
uniform vec4 uWave2;
uniform vec4 uWave3;

uniform vec3 uShallowColor;
uniform vec3 uDeepColor;
uniform vec3 uFresnelColor;
uniform float uFresnelPower;
uniform float uMaxDepth;
uniform float uShoreBlendDistance;

uniform float uFoamIntensity;
uniform float uShoreFoamWidth;

// Wave direction rotation (pre-computed cos/sin)
uniform float uWaveAngleCos;
uniform float uWaveAngleSin;

uniform sampler2D uReflectionSampler;
uniform float uReflectionStrength;
uniform float uReflectionEnabled;

uniform vec3 uFogColor;
uniform float uFogDensity;

uniform float uWindNormalStrength;

// ---- Analytical Gerstner wave normals ----

void gerstnerWaveNormal(vec4 wave, vec2 xz, float time, inout vec3 tangent, inout vec3 binormal) {
    float steepness = wave.z;
    float wavelength = wave.w;
    if (wavelength < 0.01) return;
    float k = 6.28318 / wavelength;
    float c = sqrt(9.8 / k);
    vec2 rawD = normalize(wave.xy);
    vec2 d = vec2(rawD.x * uWaveAngleCos - rawD.y * uWaveAngleSin, rawD.x * uWaveAngleSin + rawD.y * uWaveAngleCos);
    float f = k * (dot(d, xz) - c * time);
    float sinF = sin(f);
    float cosF = cos(f);
    tangent += vec3(-d.x*d.x*steepness*sinF, d.x*steepness*cosF, -d.x*d.y*steepness*sinF);
    binormal += vec3(-d.x*d.y*steepness*sinF, d.y*steepness*cosF, -d.y*d.y*steepness*sinF);
}

vec3 computeWaveNormal(vec2 origXZ, float time, float damping) {
    vec3 tangent = vec3(1.0, 0.0, 0.0);
    vec3 binormal = vec3(0.0, 0.0, 1.0);

    // Main waves (attenuated by depth damping)
    vec4 w0 = uWave0; w0.z *= damping;
    vec4 w1 = uWave1; w1.z *= damping;
    vec4 w2 = uWave2; w2.z *= damping;
    vec4 w3 = uWave3; w3.z *= damping;
    gerstnerWaveNormal(w0, origXZ, time, tangent, binormal);
    gerstnerWaveNormal(w1, origXZ, time, tangent, binormal);
    gerstnerWaveNormal(w2, origXZ, time, tangent, binormal);
    gerstnerWaveNormal(w3, origXZ, time, tangent, binormal);

    // Detail waves (fragment-only, also attenuated — irrational wavelengths to avoid repetition)
    gerstnerWaveNormal(vec4( 0.8,  0.6, 0.05*damping, 0.97),  origXZ, time, tangent, binormal);
    gerstnerWaveNormal(vec4(-0.6,  0.8, 0.04*damping, 0.67),  origXZ, time, tangent, binormal);
    gerstnerWaveNormal(vec4( 0.9, -0.4, 0.03*damping, 0.41),  origXZ, time, tangent, binormal);
    gerstnerWaveNormal(vec4(-0.3, -0.9, 0.02*damping, 0.23), origXZ, time, tangent, binormal);

    return normalize(cross(binormal, tangent));
}

void main() {
    // Depth from vertex shader (heightmap-based, already attenuated)
    float waterDepth = vDepth;
    float depthFactor = clamp(waterDepth / uMaxDepth, 0.0, 1.0);

    // Depth-based wave normal damping (matches vertex displacement damping)
    float depthDamping = smoothstep(0.0, 1.5, waterDepth);

    // Analytical wave normal with depth attenuation, modulated by wind
    vec3 waveNormal = computeWaveNormal(vOrigXZ, uTime, depthDamping * vWindMod);

    // Blend wind-driven normal into Gerstner normal
    vec3 windNormDelta = (vWindNormal - vec3(0.0, 1.0, 0.0)) * uWindNormalStrength;
    vec3 finalNormal = normalize(waveNormal + windNormDelta);

    // Fresnel: F0=0.35 (reflection-dominant — base color is dark undertone only)
    float rawFresnel = pow(1.0 - max(dot(vViewVector, finalNormal), 0.0), uFresnelPower);
    float fresnel = clamp(mix(0.35, 1.0, rawFresnel), 0.0, 1.0);

    // Water color: flat dark undertone (all visual detail comes from reflections)
    vec3 waterColor = mix(uShallowColor, uDeepColor, depthFactor);

    // Reflection
    vec3 reflectDir = reflect(-vViewVector, finalNormal);
    float skyUp = max(reflectDir.y, 0.0);
    float skyHoriz = 1.0 - abs(reflectDir.y);
    vec3 skyZenith = vec3(0.35, 0.55, 0.9);
    vec3 skyHorizon = vec3(0.75, 0.85, 0.95);
    vec3 skyBase = vec3(0.55, 0.65, 0.75);
    vec3 skyColor = mix(skyBase, skyHorizon, skyHoriz * 0.7);
    skyColor = mix(skyColor, skyZenith, skyUp * skyUp);

    vec3 reflectionColor;
    if (uReflectionEnabled > 0.5) {
        vec2 reflectUV = vScreenPos.xy / vScreenPos.w * 0.5 + 0.5;
        vec2 distortion = finalNormal.xz * 0.12;
        reflectUV += distortion;
        reflectUV = clamp(reflectUV, 0.001, 0.999);
        reflectionColor = texture2D(uReflectionSampler, reflectUV).rgb;
        float reflBrightness = dot(reflectionColor, vec3(0.299, 0.587, 0.114));
        reflectionColor = mix(skyColor, reflectionColor, smoothstep(0.01, 0.1, reflBrightness));
    } else {
        reflectionColor = skyColor;
    }

    // Reflection-dominant compositing: fresnel drives reflection vs transmission
    float reflectionAmount = fresnel;
    vec3 color = mix(waterColor, reflectionColor, reflectionAmount);

    // GGX microfacet specular (physically-based water surface)
    vec3 halfVector = normalize(vViewVector + uSunDirection);
    float NdotH = max(dot(finalNormal, halfVector), 0.0);
    float roughness = 0.07;
    float ggxAlpha = roughness * roughness;
    float ggxAlpha2 = ggxAlpha * ggxAlpha;
    float denom = NdotH * NdotH * (ggxAlpha2 - 1.0) + 1.0;
    float D = ggxAlpha2 / (3.14159 * denom * denom);
    float specular = D * max(dot(finalNormal, uSunDirection), 0.0);
    color += uSunColor * specular * 0.5;

    // Improved subsurface scattering — wave crest translucency
    float sssWaveHeight = max(vWaveHeight, 0.0);
    float sssDot = pow(max(dot(vViewVector, -uSunDirection), 0.0), 3.0);
    float sssThickness = sssWaveHeight * (1.0 - depthFactor);
    vec3 sssColor = mix(vec3(0.05, 0.3, 0.35), vec3(0.15, 0.6, 0.5), sssThickness);
    color += sssColor * sssDot * sssThickness * 0.6;

    // Fresnel-driven opacity: reflective angles → opaque, transmission → transparent
    float baseAlpha = mix(0.3, 0.92, depthFactor);
    float shoreBlend = smoothstep(0.0, uShoreBlendDistance, waterDepth);
    float alpha = baseAlpha * shoreBlend;
    alpha = mix(alpha, 1.0, fresnel);
    alpha = clamp(alpha, 0.0, 0.98);

    gl_FragColor = vec4(color, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>

    // Fog handled by VolumetricFogPass (post-processing)
}
`;

/**
 * Gerstner Wave Configuration
 */
interface GerstnerWave {
  direction: THREE.Vector2;
  steepness: number;
  wavelength: number;
}

/**
 * Water System Configuration
 */
export interface WaterConfig {
  // Colors
  shallowColor: THREE.Color;
  deepColor: THREE.Color;
  fresnelColor: THREE.Color;

  // Waves
  waves: GerstnerWave[];

  // Appearance
  fresnelPower: number;
  maxDepth: number;
  shoreBlendDistance: number;

  // Foam
  foamIntensity: number;
  shoreFoamWidth: number;

  // Wind-driven waves (synced with grass wind texture)
  windWaveStrength: number;
  windNormalStrength: number;

  // Reflection
  reflectionEnabled: boolean;
  reflectionStrength: number;
  reflectionResolution: number;
  reflectionBlur: number;
}

/**
 * Default configuration for realistic ocean water
 */
export const DEFAULT_WATER_CONFIG: WaterConfig = {
  shallowColor: new THREE.Color(0.04, 0.12, 0.15),  // Dark teal undertone (reflections dominate)
  deepColor: new THREE.Color(0.01, 0.04, 0.08),    // Near-black deep water
  fresnelColor: new THREE.Color(0.45, 0.65, 0.75),  // More vibrant reflection color

  waves: [
    { direction: new THREE.Vector2(1.0, 0.3), steepness: 0.375, wavelength: 7.3 },
    { direction: new THREE.Vector2(0.3, 1.0), steepness: 0.27, wavelength: 4.7 },
    { direction: new THREE.Vector2(-0.5, 0.7), steepness: 0.18, wavelength: 2.9 },
    { direction: new THREE.Vector2(0.7, -0.4), steepness: 0.09, wavelength: 1.3 },
  ],

  fresnelPower: 2.0,
  maxDepth: 6.0,
  shoreBlendDistance: 0.6,

  foamIntensity: 1.4,
  shoreFoamWidth: 1.2,

  windWaveStrength: 0.12,
  windNormalStrength: 0.3,

  reflectionEnabled: false,  // RT created but never rendered into — disabled to save VRAM
  reflectionStrength: 0.90,
  reflectionResolution: 256,
  reflectionBlur: 4,
};

/**
 * River water config (alias for default — flowing Gerstner waves)
 */
export const RIVER_WATER_CONFIG = DEFAULT_WATER_CONFIG;

/**
 * Lake water config — calm surface with gentle wind-driven ripples
 * Steepness ~1/15 of river, shorter wavelengths for subtle surface variation
 */
export const LAKE_WATER_CONFIG: WaterConfig = {
  ...DEFAULT_WATER_CONFIG,
  waves: [
    { direction: new THREE.Vector2(1.0, 0.3), steepness: 0.005, wavelength: 2.3 },
    { direction: new THREE.Vector2(-0.4, 1.0), steepness: 0.004, wavelength: 1.7 },
    { direction: new THREE.Vector2(0.7, -0.5), steepness: 0.003, wavelength: 1.1 },
    { direction: new THREE.Vector2(-0.3, -0.8), steepness: 0.002, wavelength: 0.7 },
  ],
  windWaveStrength: 0.25,
  windNormalStrength: 0.6,
};

/**
 * Optimized Water System with Heightmap-based Depth
 *
 * Performance optimizations:
 * - No DepthRenderer (saves 1 render pass per frame)
 * - No RefractionRTT (saves 1 render pass per frame)
 * - Reduced mesh subdivisions (64 vs 128)
 * - Uses heightmap texture for depth calculation instead
 */
export class WaterSystem {
  private scene: THREE.Scene;
  private heightmap: Heightmap;

  private waterMesh: THREE.Mesh | null = null;
  private waterMaterial: THREE.ShaderMaterial | null = null;
  private heightmapTexture: THREE.DataTexture | null = null;
  private dummyTexture: THREE.DataTexture | null = null;

  private config: WaterConfig;
  private waterLevel: number = 0;
  private startTime: number;
  private reflectionRenderTarget: THREE.WebGLRenderTarget | null = null;

  constructor(scene: THREE.Scene, heightmap: Heightmap, config?: Partial<WaterConfig>) {
    this.scene = scene;
    this.heightmap = heightmap;
    this.config = { ...DEFAULT_WATER_CONFIG, ...config };
    this.startTime = performance.now() / 1000;

    // Skip DepthRenderer - we use heightmap-based depth (useHeightmapDepth = 1.0)
    // This saves an entire render pass per frame
    this.loadTextures();
  }

  /**
   * Load required textures
   */
  private loadTextures(): void {
    // Heightmap texture for depth calculation (vertex + fragment)
    this.createHeightmapTexture();

    // 1x1 dummy texture for sampler binding
    const dummyData = new Uint8Array([0, 0, 0, 255]);
    this.dummyTexture = new THREE.DataTexture(dummyData, 1, 1, THREE.RGBAFormat);
    this.dummyTexture.magFilter = THREE.NearestFilter;
    this.dummyTexture.minFilter = THREE.NearestFilter;
    this.dummyTexture.needsUpdate = true;
  }

  /**
   * Create texture from heightmap data for water depth calculation
   */
  private createHeightmapTexture(): void {
    const resolution = this.heightmap.getResolution();
    const minHeight = this.heightmap.getMinHeight();
    const maxHeight = this.heightmap.getMaxHeight();
    const heightRange = maxHeight - minHeight || 1; // Avoid division by zero

    // Create RGBA array (4 bytes per pixel)
    const data = new Uint8Array(resolution * resolution * 4);

    for (let z = 0; z < resolution; z++) {
      for (let x = 0; x < resolution; x++) {
        const height = this.heightmap.getHeight(x, z);
        // Normalize height to 0-255 range based on min-max
        const normalizedHeight = Math.floor(((height - minHeight) / heightRange) * 255);
        const clampedHeight = Math.max(0, Math.min(255, normalizedHeight));

        const idx = (z * resolution + x) * 4;
        data[idx] = clampedHeight;     // R - height
        data[idx + 1] = clampedHeight; // G
        data[idx + 2] = clampedHeight; // B
        data[idx + 3] = 255;           // A
      }
    }

    // Create DataTexture from data
    this.heightmapTexture = new THREE.DataTexture(
      data,
      resolution,
      resolution,
      THREE.RGBAFormat
    );
    this.heightmapTexture.magFilter = THREE.LinearFilter;
    this.heightmapTexture.minFilter = THREE.LinearFilter;
    this.heightmapTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.heightmapTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.heightmapTexture.needsUpdate = true;
  }

  /**
   * Update heightmap texture when terrain changes
   */
  updateHeightmapTexture(): void {
    if (this.heightmapTexture) {
      this.heightmapTexture.dispose();
    }
    this.createHeightmapTexture();

    if (this.waterMaterial && this.heightmapTexture) {
      this.waterMaterial.uniforms.uHeightmap.value = this.heightmapTexture;
      // Update height range and min height (may have changed from terrain editing)
      const heightRange = this.heightmap.getMaxHeight() - this.heightmap.getMinHeight() || 1;
      this.waterMaterial.uniforms.uHeightScale.value = heightRange;
      this.waterMaterial.uniforms.uMinHeight.value = this.heightmap.getMinHeight();
    }
  }

  /**
   * Create water surface for a given region
   */
  createWater(
    centerX: number,
    centerZ: number,
    width: number,
    depth: number,
    waterLevel: number
  ): THREE.Mesh | null {
    this.dispose();

    this.waterLevel = waterLevel;

    // Create shader material first
    this.createMaterial();

    // Create water mesh - reduced subdivisions for better performance
    // 64 subdivisions is sufficient for gentle Gerstner waves
    const geometry = new THREE.PlaneGeometry(width, depth, 64, 64);
    geometry.rotateX(-Math.PI / 2); // XZ plane

    this.waterMesh = new THREE.Mesh(geometry, this.waterMaterial!);
    this.waterMesh.position.set(centerX, waterLevel, centerZ);
    this.waterMesh.name = "water_plane";

    this.scene.add(this.waterMesh);

    // Skip RefractionRTT - minimal visual benefit, high performance cost
    // This saves an entire render pass per frame

    // Setup reflection render target if enabled
    if (this.config.reflectionEnabled) {
      this.createReflectionRenderTarget();
    }

    console.log("[WaterSystem] Created water (optimized: no depth/refraction passes)");

    return this.waterMesh;
  }

  /**
   * Create the water shader material
   */
  private createMaterial(): void {
    const cfg = this.config;
    const heightRange = this.heightmap.getMaxHeight() - this.heightmap.getMinHeight() || 1;

    this.waterMaterial = new THREE.ShaderMaterial({
      vertexShader: waterVertexShader,
      fragmentShader: waterFragmentShader,
      uniforms: {
        uTime: { value: 0.0 },
        uWaterLevel: { value: this.waterLevel },

        uWave0: { value: new THREE.Vector4(cfg.waves[0]?.direction.x ?? 0, cfg.waves[0]?.direction.y ?? 0, cfg.waves[0]?.steepness ?? 0, cfg.waves[0]?.wavelength ?? 0) },
        uWave1: { value: new THREE.Vector4(cfg.waves[1]?.direction.x ?? 0, cfg.waves[1]?.direction.y ?? 0, cfg.waves[1]?.steepness ?? 0, cfg.waves[1]?.wavelength ?? 0) },
        uWave2: { value: new THREE.Vector4(cfg.waves[2]?.direction.x ?? 0, cfg.waves[2]?.direction.y ?? 0, cfg.waves[2]?.steepness ?? 0, cfg.waves[2]?.wavelength ?? 0) },
        uWave3: { value: new THREE.Vector4(cfg.waves[3]?.direction.x ?? 0, cfg.waves[3]?.direction.y ?? 0, cfg.waves[3]?.steepness ?? 0, cfg.waves[3]?.wavelength ?? 0) },

        uSunDirection: { value: new THREE.Vector3(0.5, 0.8, 0.3).normalize() },
        uSunColor: { value: new THREE.Color(1.0, 0.95, 0.8) },

        uShallowColor: { value: cfg.shallowColor.clone() },
        uDeepColor: { value: cfg.deepColor.clone() },
        uFresnelColor: { value: cfg.fresnelColor.clone() },
        uFresnelPower: { value: cfg.fresnelPower },
        uMaxDepth: { value: cfg.maxDepth },
        uShoreBlendDistance: { value: cfg.shoreBlendDistance },

        uFoamIntensity: { value: cfg.foamIntensity },
        uShoreFoamWidth: { value: cfg.shoreFoamWidth },

        uTerrainScale: { value: this.heightmap.getScale() },
        uHeightScale: { value: heightRange },
        uMinHeight: { value: this.heightmap.getMinHeight() },

        uHeightmap: { value: this.heightmapTexture },
        uReflectionSampler: { value: this.dummyTexture },
        uInteractiveHeight: { value: this.dummyTexture },

        uReflectionStrength: { value: cfg.reflectionStrength },
        uReflectionEnabled: { value: cfg.reflectionEnabled ? 1.0 : 0.0 },

        uFogColor: { value: new THREE.Color(0.6, 0.75, 0.9) },
        uFogDensity: { value: 0.008 },

        uWaveAngleCos: { value: 1.0 },
        uWaveAngleSin: { value: 0.0 },

        uInteractiveEnabled: { value: 0.0 },
        uInteractiveStrength: { value: 1.0 },

        uWindTexture: { value: this.dummyTexture },
        uWindWaveStrength: { value: cfg.windWaveStrength },
        uWindNormalStrength: { value: cfg.windNormalStrength },
        uWindDirection: { value: new THREE.Vector2(0.707, 0.707) },
        uWindEnabled: { value: 0.0 },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }

  /**
   * Public update method - call from render loop
   */
  update(time: number): void {
    if (!this.waterMaterial) return;

    const elapsed = time - this.startTime;
    this.waterMaterial.uniforms.uTime.value = elapsed;
    this.waterMaterial.uniforms.uWaterLevel.value = this.waterLevel;
  }

  /**
   * Update configuration
   */
  setConfig(config: Partial<WaterConfig>): void {
    this.config = { ...this.config, ...config };
    this.updateUniforms();
  }

  /**
   * Set water level
   */
  setWaterLevel(level: number): void {
    this.waterLevel = level;
    if (this.waterMesh) {
      this.waterMesh.position.y = level;
    }
  }

  /**
   * Get water level
   */
  getWaterLevel(): number {
    return this.waterLevel;
  }

  /**
   * Create WebGLRenderTarget for planar reflections
   */
  private createReflectionRenderTarget(): void {
    if (!this.config.reflectionEnabled) return;

    if (this.reflectionRenderTarget) {
      this.reflectionRenderTarget.dispose();
      this.reflectionRenderTarget = null;
    }

    const resolution = this.config.reflectionResolution;

    this.reflectionRenderTarget = new THREE.WebGLRenderTarget(resolution, resolution, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
    });

    if (this.waterMaterial) {
      this.waterMaterial.uniforms.uReflectionSampler.value = this.reflectionRenderTarget.texture;
      this.waterMaterial.uniforms.uReflectionEnabled.value = 1.0;
      this.waterMaterial.uniforms.uReflectionStrength.value = this.config.reflectionStrength;
    }
  }

  /**
   * Get reflection render target (for external reflection rendering)
   */
  getReflectionRenderTarget(): THREE.WebGLRenderTarget | null {
    return this.reflectionRenderTarget;
  }

  /**
   * Enable or disable reflections at runtime
   */
  setReflectionEnabled(enabled: boolean): void {
    this.config.reflectionEnabled = enabled;
    if (enabled) {
      if (!this.reflectionRenderTarget) {
        this.createReflectionRenderTarget();
      }
    } else {
      if (this.reflectionRenderTarget) {
        this.reflectionRenderTarget.dispose();
        this.reflectionRenderTarget = null;
      }
      if (this.waterMaterial) {
        this.waterMaterial.uniforms.uReflectionEnabled.value = 0.0;
        // Rebind dummy texture so sampler stays valid
        if (this.dummyTexture) {
          this.waterMaterial.uniforms.uReflectionSampler.value = this.dummyTexture;
        }
      }
    }
  }

  /**
   * Set wave direction angle (radians)
   * Rotates all wave directions uniformly — used for river flow direction
   */
  setWaveAngle(angleRadians: number): void {
    if (this.waterMaterial) {
      this.waterMaterial.uniforms.uWaveAngleCos.value = Math.cos(angleRadians);
      this.waterMaterial.uniforms.uWaveAngleSin.value = Math.sin(angleRadians);
    }
  }

  /**
   * Switch water type between river (flowing) and lake (calm)
   * Applies the appropriate wave config and sets the direction angle
   */
  setWaterType(type: "river" | "lake", angleRadians: number): void {
    if (type === "lake") {
      this.config = { ...this.config, waves: LAKE_WATER_CONFIG.waves };
    } else {
      this.config = { ...this.config, waves: RIVER_WATER_CONFIG.waves };
    }
    this.updateUniforms();
    this.setWaveAngle(angleRadians);
  }

  /**
   * Sync fog settings with terrain/foliage (used by GamePreview for game mode fog)
   */
  syncFogSettings(fogColor: THREE.Color, fogDensity: number): void {
    if (!this.waterMaterial) return;
    this.waterMaterial.uniforms.uFogColor.value = fogColor;
    this.waterMaterial.uniforms.uFogDensity.value = fogDensity;
  }

  /**
   * Get water mesh for adding to render lists
   */
  getMesh(): THREE.Mesh | null {
    return this.waterMesh;
  }

  /**
   * Get water material for sharing with other meshes
   */
  getMaterial(): THREE.ShaderMaterial | null {
    return this.waterMaterial;
  }

  /**
   * Enable interactive water and bind height texture
   * @param heightTexture - Height field texture from InteractiveWater.getHeightTexture()
   * @param strength - Ripple strength multiplier (default 1.0)
   */
  setInteractiveWater(heightTexture: THREE.Texture | null, strength: number = 1.0): void {
    if (!this.waterMaterial) return;

    if (heightTexture) {
      this.waterMaterial.uniforms.uInteractiveHeight.value = heightTexture;
      this.waterMaterial.uniforms.uInteractiveEnabled.value = 1.0;
      this.waterMaterial.uniforms.uInteractiveStrength.value = strength;
    } else {
      // Disable interactive water
      if (this.dummyTexture) {
        this.waterMaterial.uniforms.uInteractiveHeight.value = this.dummyTexture;
      }
      this.waterMaterial.uniforms.uInteractiveEnabled.value = 0.0;
    }
  }

  /**
   * Bind wind noise texture (shared with grass) for synchronized wind waves
   */
  setWindTexture(texture: THREE.Texture | null, windDirection?: THREE.Vector2): void {
    if (!this.waterMaterial) return;

    if (texture) {
      this.waterMaterial.uniforms.uWindTexture.value = texture;
      this.waterMaterial.uniforms.uWindEnabled.value = 1.0;
      if (windDirection) {
        this.waterMaterial.uniforms.uWindDirection.value.copy(windDirection);
      }
    } else {
      if (this.dummyTexture) {
        this.waterMaterial.uniforms.uWindTexture.value = this.dummyTexture;
      }
      this.waterMaterial.uniforms.uWindEnabled.value = 0.0;
    }
  }

  /**
   * Update interactive water strength
   */
  setInteractiveStrength(strength: number): void {
    if (this.waterMaterial) {
      this.waterMaterial.uniforms.uInteractiveStrength.value = strength;
    }
  }

  /**
   * Update shader uniforms from current config
   */
  private updateUniforms(): void {
    if (!this.waterMaterial) return;

    const cfg = this.config;

    // Colors
    this.waterMaterial.uniforms.uShallowColor.value = cfg.shallowColor.clone();
    this.waterMaterial.uniforms.uDeepColor.value = cfg.deepColor.clone();
    this.waterMaterial.uniforms.uFresnelColor.value = cfg.fresnelColor.clone();

    // Waves (pack into vec4)
    for (let i = 0; i < 4; i++) {
      const wave = cfg.waves[i] || { direction: new THREE.Vector2(0, 0), steepness: 0, wavelength: 0 };
      this.waterMaterial.uniforms[`uWave${i}`].value = new THREE.Vector4(
        wave.direction.x, wave.direction.y, wave.steepness, wave.wavelength
      );
    }

    // Appearance
    this.waterMaterial.uniforms.uFresnelPower.value = cfg.fresnelPower;
    this.waterMaterial.uniforms.uMaxDepth.value = cfg.maxDepth;
    this.waterMaterial.uniforms.uShoreBlendDistance.value = cfg.shoreBlendDistance;

    // Foam
    this.waterMaterial.uniforms.uFoamIntensity.value = cfg.foamIntensity;
    this.waterMaterial.uniforms.uShoreFoamWidth.value = cfg.shoreFoamWidth;

    // Wind waves
    this.waterMaterial.uniforms.uWindWaveStrength.value = cfg.windWaveStrength;
    this.waterMaterial.uniforms.uWindNormalStrength.value = cfg.windNormalStrength;

    // Sun
    this.waterMaterial.uniforms.uSunDirection.value = new THREE.Vector3(0.5, 0.8, 0.3).normalize();
    this.waterMaterial.uniforms.uSunColor.value = new THREE.Color(1.0, 0.95, 0.8);

    // Fog (matches terrain/foliage defaults)
    this.waterMaterial.uniforms.uFogColor.value = new THREE.Color(0.6, 0.75, 0.9);
    this.waterMaterial.uniforms.uFogDensity.value = 0.008;

    // Wave direction angle (default 0 = no rotation)
    this.waterMaterial.uniforms.uWaveAngleCos.value = 1.0;
    this.waterMaterial.uniforms.uWaveAngleSin.value = 0.0;

    // Reflection
    this.waterMaterial.uniforms.uReflectionStrength.value = cfg.reflectionStrength;
    this.waterMaterial.uniforms.uReflectionEnabled.value = cfg.reflectionEnabled ? 1.0 : 0.0;
    if (this.reflectionRenderTarget && cfg.reflectionEnabled) {
      this.waterMaterial.uniforms.uReflectionSampler.value = this.reflectionRenderTarget.texture;
    }
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    if (this.reflectionRenderTarget) {
      this.reflectionRenderTarget.dispose();
      this.reflectionRenderTarget = null;
    }
    if (this.waterMesh) {
      this.scene.remove(this.waterMesh);
      this.waterMesh.geometry.dispose();
      if (this.waterMesh.material instanceof THREE.ShaderMaterial) {
        this.waterMesh.material.dispose();
      }
      this.waterMesh = null;
    }
    this.waterMaterial = null;
  }

  /**
   * Full cleanup including textures
   */
  disposeAll(): void {
    this.dispose();
    if (this.heightmapTexture) {
      this.heightmapTexture.dispose();
      this.heightmapTexture = null;
    }
    if (this.dummyTexture) {
      this.dummyTexture.dispose();
      this.dummyTexture = null;
    }
  }
}
