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

import {
  Scene,
  Mesh,
  MeshBuilder,
  Vector2,
  Vector3,
  Vector4,
  Color3,
  Color4,
  Texture,
  RawTexture,
  ShaderMaterial,
  Effect,
  Constants,
  MirrorTexture,
  Plane,
} from "@babylonjs/core";
import { Heightmap } from "./Heightmap";

// ============================================
// Water Vertex Shader
// ============================================
const waterVertexShader = `
precision highp float;

attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;

uniform mat4 world;
uniform mat4 view;
uniform mat4 projection;
uniform mat4 viewProjection;
uniform float uTime;
uniform float uWaterLevel;

uniform vec4 uWave0;
uniform vec4 uWave1;
uniform vec4 uWave2;
uniform vec4 uWave3;

// Camera position (avoid inverse(view) per vertex)
uniform vec3 uCameraPosition;

// Wave direction rotation (radians)
uniform float uWaveAngle;

// Heightmap for depth-based wave attenuation
uniform sampler2D uHeightmap;
uniform float uTerrainScale;
uniform float uHeightScale;
uniform float uMinHeight;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vUV;
varying vec4 vScreenPos;
varying vec3 vViewVector;
varying float vWaveHeight;
varying vec2 vOrigXZ;
varying float vDepth;

vec3 gerstnerWave(vec4 wave, vec3 p) {
    float steepness = wave.z;
    float wavelength = wave.w;
    if (wavelength < 0.01) return vec3(0.0);
    float k = 2.0 * 3.14159265 / wavelength;
    float c = sqrt(9.8 / k);
    // Rotate wave direction by uWaveAngle
    float ca = cos(uWaveAngle), sa = sin(uWaveAngle);
    vec2 rawD = normalize(wave.xy);
    vec2 d = vec2(rawD.x * ca - rawD.y * sa, rawD.x * sa + rawD.y * ca);
    float f = k * (dot(d, p.xz) - c * uTime);
    float a = steepness / k;
    return vec3(d.x * a * cos(f), a * sin(f), d.y * a * cos(f));
}

void main() {
    vec3 worldPos = (world * vec4(position, 1.0)).xyz;
    vOrigXZ = worldPos.xz;

    // Sample terrain height for depth-based wave attenuation
    vec2 hmUV = clamp(worldPos.xz / uTerrainScale, 0.0, 1.0);
    float terrainH = texture2D(uHeightmap, hmUV).r * uHeightScale + uMinHeight;
    float localDepth = max(uWaterLevel - terrainH, 0.0);
    vDepth = localDepth;

    // Attenuate waves in shallow water (prevents clipping through terrain)
    float depthDamping = smoothstep(0.0, 1.5, localDepth);

    vec3 displacement = vec3(0.0);
    displacement += gerstnerWave(uWave0, worldPos);
    displacement += gerstnerWave(uWave1, worldPos);
    displacement += gerstnerWave(uWave2, worldPos);
    displacement += gerstnerWave(uWave3, worldPos);
    displacement *= depthDamping;

    worldPos += displacement;
    vWaveHeight = displacement.y;

    vWorldPos = worldPos;
    vNormal = vec3(0.0, 1.0, 0.0);
    vUV = uv;

    vec4 clipPos = viewProjection * vec4(worldPos, 1.0);
    vScreenPos = clipPos;

    vViewVector = normalize(uCameraPosition - worldPos);

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

uniform float uTime;
uniform float uWaterLevel;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform vec3 uCameraPosition;

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

// Wave direction rotation (radians)
uniform float uWaveAngle;

uniform sampler2D uReflectionSampler;
uniform float uReflectionStrength;
uniform float uReflectionEnabled;

uniform vec3 uFogColor;
uniform float uFogDensity;

// ---- Analytical Gerstner wave normals ----

void gerstnerWaveNormal(vec4 wave, vec2 xz, float time, inout vec3 tangent, inout vec3 binormal) {
    float steepness = wave.z;
    float wavelength = wave.w;
    if (wavelength < 0.01) return;
    float k = 6.28318 / wavelength;
    float c = sqrt(9.8 / k);
    // Rotate wave direction by uWaveAngle
    float ca = cos(uWaveAngle), sa = sin(uWaveAngle);
    vec2 rawD = normalize(wave.xy);
    vec2 d = vec2(rawD.x * ca - rawD.y * sa, rawD.x * sa + rawD.y * ca);
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

    // Detail waves (fragment-only, also attenuated)
    gerstnerWaveNormal(vec4( 0.8,  0.6, 0.05*damping, 1.0),  origXZ, time, tangent, binormal);
    gerstnerWaveNormal(vec4(-0.6,  0.8, 0.04*damping, 0.7),  origXZ, time, tangent, binormal);
    gerstnerWaveNormal(vec4( 0.9, -0.4, 0.03*damping, 0.4),  origXZ, time, tangent, binormal);
    gerstnerWaveNormal(vec4(-0.3, -0.9, 0.02*damping, 0.25), origXZ, time, tangent, binormal);

    return normalize(cross(binormal, tangent));
}

void main() {
    // Depth from vertex shader (heightmap-based, already attenuated)
    float waterDepth = vDepth;
    float depthFactor = clamp(waterDepth / uMaxDepth, 0.0, 1.0);

    // Depth-based wave normal damping (matches vertex displacement damping)
    float depthDamping = smoothstep(0.0, 1.5, waterDepth);

    // Analytical wave normal with depth attenuation
    vec3 waveNormal = computeWaveNormal(vOrigXZ, uTime, depthDamping);

    vec3 finalNormal = waveNormal;

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

    // Distance fog (matches terrain/foliage exponential squared fog)
    float distanceToCamera = length(vWorldPos - uCameraPosition);
    float distanceFog = 1.0 - exp(-uFogDensity * uFogDensity * distanceToCamera * distanceToCamera);
    float fogFactor = clamp(distanceFog, 0.0, 1.0);
    color = mix(color, uFogColor, fogFactor);

    gl_FragColor = vec4(color, alpha);
}
`;

// Register shaders
Effect.ShadersStore["enterpriseWaterVertexShader"] = waterVertexShader;
Effect.ShadersStore["enterpriseWaterFragmentShader"] = waterFragmentShader;

/**
 * Gerstner Wave Configuration
 */
interface GerstnerWave {
  direction: Vector2;
  steepness: number;
  wavelength: number;
}

/**
 * Water System Configuration
 */
export interface WaterConfig {
  // Colors
  shallowColor: Color3;
  deepColor: Color3;
  fresnelColor: Color3;

  // Waves
  waves: GerstnerWave[];

  // Appearance
  fresnelPower: number;
  maxDepth: number;
  shoreBlendDistance: number;

  // Foam
  foamIntensity: number;
  shoreFoamWidth: number;

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
  shallowColor: new Color3(0.04, 0.12, 0.15),  // Dark teal undertone (reflections dominate)
  deepColor: new Color3(0.01, 0.04, 0.08),    // Near-black deep water
  fresnelColor: new Color3(0.45, 0.65, 0.75),  // More vibrant reflection color

  waves: [
    { direction: new Vector2(1.0, 0.3), steepness: 0.25, wavelength: 8.0 },
    { direction: new Vector2(0.3, 1.0), steepness: 0.18, wavelength: 5.0 },
    { direction: new Vector2(-0.5, 0.7), steepness: 0.12, wavelength: 3.0 },
    { direction: new Vector2(0.7, -0.4), steepness: 0.06, wavelength: 1.5 },
  ],

  fresnelPower: 2.0,
  maxDepth: 6.0,
  shoreBlendDistance: 0.6,

  foamIntensity: 1.4,
  shoreFoamWidth: 1.2,

  reflectionEnabled: true,
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
    { direction: new Vector2(1.0, 0.3), steepness: 0.015, wavelength: 2.5 },
    { direction: new Vector2(-0.4, 1.0), steepness: 0.012, wavelength: 1.8 },
    { direction: new Vector2(0.7, -0.5), steepness: 0.008, wavelength: 1.2 },
    { direction: new Vector2(-0.3, -0.8), steepness: 0.005, wavelength: 0.8 },
  ],
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
  private scene: Scene;
  private heightmap: Heightmap;

  private waterMesh: Mesh | null = null;
  private waterMaterial: ShaderMaterial | null = null;
  private heightmapTexture: Texture | null = null;
  private dummyTexture: RawTexture | null = null;

  private config: WaterConfig;
  private waterLevel: number = 0;
  private startTime: number;
  private mirrorTexture: MirrorTexture | null = null;
  private renderObserver: ReturnType<typeof this.scene.onBeforeRenderObservable.add> | null = null;

  constructor(scene: Scene, heightmap: Heightmap, config?: Partial<WaterConfig>) {
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

    // 1x1 dummy texture for WebGPU sampler binding (all declared samplers must be bound)
    this.dummyTexture = new RawTexture(
      new Uint8Array([0, 0, 0, 255]),
      1, 1,
      Constants.TEXTUREFORMAT_RGBA,
      this.scene,
      false, false,
      Texture.NEAREST_SAMPLINGMODE
    );
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

    // Create RawTexture from data
    this.heightmapTexture = new RawTexture(
      data,
      resolution,
      resolution,
      Constants.TEXTUREFORMAT_RGBA,
      this.scene,
      false,  // generateMipMaps
      false,  // invertY
      Texture.BILINEAR_SAMPLINGMODE
    );
    this.heightmapTexture.wrapU = Texture.CLAMP_ADDRESSMODE;
    this.heightmapTexture.wrapV = Texture.CLAMP_ADDRESSMODE;
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
      this.waterMaterial.setTexture("uHeightmap", this.heightmapTexture);
      // Update height range and min height (may have changed from terrain editing)
      const heightRange = this.heightmap.getMaxHeight() - this.heightmap.getMinHeight() || 1;
      this.waterMaterial.setFloat("uHeightScale", heightRange);
      this.waterMaterial.setFloat("uMinHeight", this.heightmap.getMinHeight());
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
  ): Mesh | null {
    this.dispose();

    this.waterLevel = waterLevel;

    // Create water mesh - reduced subdivisions for better performance
    // 64 subdivisions is sufficient for gentle Gerstner waves
    this.waterMesh = MeshBuilder.CreateGround(
      "water_plane",
      {
        width: width,
        height: depth,
        subdivisions: 64,
        updatable: false,
      },
      this.scene
    );

    this.waterMesh.position.set(centerX, waterLevel, centerZ);

    // Skip RefractionRTT - minimal visual benefit, high performance cost
    // This saves an entire render pass per frame

    // Create shader material
    this.createMaterial();

    if (this.waterMaterial) {
      this.waterMesh.material = this.waterMaterial;
    }

    // Setup mirror reflection if enabled
    if (this.config.reflectionEnabled) {
      this.createMirrorTexture();
    }

    // Register update loop (store observer for cleanup)
    this.renderObserver = this.scene.onBeforeRenderObservable.add(() => this.update());

    console.log("[WaterSystem] Created water (optimized: no depth/refraction passes)");

    return this.waterMesh;
  }

  /**
   * Create the water shader material
   */
  private createMaterial(): void {
    this.waterMaterial = new ShaderMaterial(
      "enterpriseWaterMaterial",
      this.scene,
      {
        vertex: "enterpriseWater",
        fragment: "enterpriseWater",
      },
      {
        attributes: ["position", "normal", "uv"],
        uniforms: [
          "world", "view", "projection", "viewProjection",
          "uTime", "uWaterLevel",
          "uWave0", "uWave1", "uWave2", "uWave3",
          "uSunDirection", "uSunColor", "uCameraPosition",
          "uShallowColor", "uDeepColor", "uFresnelColor",
          "uFresnelPower", "uMaxDepth", "uShoreBlendDistance",
          "uFoamIntensity", "uShoreFoamWidth",
          "uTerrainScale", "uHeightScale", "uMinHeight",
          "uReflectionStrength", "uReflectionEnabled",
          "uFogColor", "uFogDensity",
          "uWaveAngle",
        ],
        samplers: ["uHeightmap", "uReflectionSampler"],
        needAlphaBlending: true,
      }
    );

    // Enable transparency
    this.waterMaterial.alpha = 0.9;
    this.waterMaterial.backFaceCulling = false;

    // Set textures
    if (this.heightmapTexture) {
      this.waterMaterial.setTexture("uHeightmap", this.heightmapTexture);
    }
    // Always bind reflection sampler (WebGPU requires all declared samplers bound)
    if (this.dummyTexture) {
      this.waterMaterial.setTexture("uReflectionSampler", this.dummyTexture);
    }

    // Set heightmap uniforms (used in both vertex and fragment shaders)
    this.waterMaterial.setFloat("uTerrainScale", this.heightmap.getScale());
    const heightRange = this.heightmap.getMaxHeight() - this.heightmap.getMinHeight() || 1;
    this.waterMaterial.setFloat("uHeightScale", heightRange);
    this.waterMaterial.setFloat("uMinHeight", this.heightmap.getMinHeight());

    // Set initial uniforms
    this.updateUniforms();
  }

  /**
   * Update shader uniforms
   */
  private updateUniforms(): void {
    if (!this.waterMaterial) return;

    const cfg = this.config;
    const engine = this.scene.getEngine();
    const camera = this.scene.activeCamera;

    // Colors
    this.waterMaterial.setColor3("uShallowColor", cfg.shallowColor);
    this.waterMaterial.setColor3("uDeepColor", cfg.deepColor);
    this.waterMaterial.setColor3("uFresnelColor", cfg.fresnelColor);

    // Waves (pack into vec4)
    for (let i = 0; i < 4; i++) {
      const wave = cfg.waves[i] || { direction: new Vector2(0, 0), steepness: 0, wavelength: 0 };
      this.waterMaterial.setVector4(
        `uWave${i}`,
        new Vector4(wave.direction.x, wave.direction.y, wave.steepness, wave.wavelength)
      );
    }

    // Appearance
    this.waterMaterial.setFloat("uFresnelPower", cfg.fresnelPower);
    this.waterMaterial.setFloat("uMaxDepth", cfg.maxDepth);
    this.waterMaterial.setFloat("uShoreBlendDistance", cfg.shoreBlendDistance);

    // Foam
    this.waterMaterial.setFloat("uFoamIntensity", cfg.foamIntensity);
    this.waterMaterial.setFloat("uShoreFoamWidth", cfg.shoreFoamWidth);

    // Sun
    this.waterMaterial.setVector3("uSunDirection", new Vector3(0.5, 0.8, 0.3).normalize());
    this.waterMaterial.setColor3("uSunColor", new Color3(1.0, 0.95, 0.8));

    if (camera) {
      this.waterMaterial.setVector3("uCameraPosition", camera.position);
    }

    // Fog (matches terrain/foliage defaults)
    this.waterMaterial.setColor3("uFogColor", new Color3(0.6, 0.75, 0.9));
    this.waterMaterial.setFloat("uFogDensity", 0.008);

    // Wave direction angle (default 0 = no rotation)
    this.waterMaterial.setFloat("uWaveAngle", 0);

    // Reflection
    this.waterMaterial.setFloat("uReflectionStrength", cfg.reflectionStrength);
    this.waterMaterial.setFloat("uReflectionEnabled", cfg.reflectionEnabled ? 1.0 : 0.0);
    if (this.mirrorTexture && cfg.reflectionEnabled) {
      this.waterMaterial.setTexture("uReflectionSampler", this.mirrorTexture);
    }
  }

  /**
   * Update loop
   */
  private update(): void {
    if (!this.waterMaterial) return;

    const time = (performance.now() / 1000) - this.startTime;
    this.waterMaterial.setFloat("uTime", time);
    this.waterMaterial.setFloat("uWaterLevel", this.waterLevel);

    // Update camera position
    const camera = this.scene.activeCamera;
    if (camera) {
      this.waterMaterial.setVector3("uCameraPosition", camera.position);
    }

    // Update reflection mirror plane
    if (this.mirrorTexture && this.config.reflectionEnabled) {
      this.mirrorTexture.mirrorPlane = new Plane(0, -1, 0, this.waterLevel);
    }
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
   * Create MirrorTexture for planar reflections
   */
  private createMirrorTexture(): void {
    if (!this.config.reflectionEnabled) return;

    if (this.mirrorTexture) {
      this.mirrorTexture.dispose();
      this.mirrorTexture = null;
    }

    const resolution = this.config.reflectionResolution;

    this.mirrorTexture = new MirrorTexture(
      "waterReflection",
      resolution,
      this.scene,
      false
    );

    this.mirrorTexture.mirrorPlane = new Plane(0, -1, 0, this.waterLevel);

    if (this.config.reflectionBlur > 0) {
      this.mirrorTexture.adaptiveBlurKernel = this.config.reflectionBlur;
    }

    this.mirrorTexture.refreshRate = 2;
    this.mirrorTexture.clearColor = new Color4(0.55, 0.7, 0.9, 1.0);

    this.updateReflectionRenderList();

    if (this.waterMaterial) {
      this.waterMaterial.setTexture("uReflectionSampler", this.mirrorTexture);
      this.waterMaterial.setFloat("uReflectionEnabled", 1.0);
      this.waterMaterial.setFloat("uReflectionStrength", this.config.reflectionStrength);
    }
  }

  /**
   * Update which meshes appear in the reflection
   */
  updateReflectionRenderList(): void {
    if (!this.mirrorTexture) return;

    this.mirrorTexture.renderList = [];

    for (const mesh of this.scene.meshes) {
      if (mesh.name === "water_plane" || mesh.name === "unified_water") continue;
      if (!mesh.isVisible || !mesh.isEnabled()) continue;

      if (
        mesh.name.startsWith("terrain_lod") ||
        mesh.name.startsWith("rock_") ||
        mesh.name.startsWith("foliage_") ||
        mesh.name.startsWith("inst_") ||
        mesh.name.includes("_var") ||
        mesh.name.includes("_lod")
      ) {
        this.mirrorTexture.renderList.push(mesh);
      }
    }
  }

  /**
   * Enable or disable reflections at runtime
   */
  setReflectionEnabled(enabled: boolean): void {
    this.config.reflectionEnabled = enabled;
    if (enabled) {
      if (!this.mirrorTexture) {
        this.createMirrorTexture();
      }
    } else {
      if (this.mirrorTexture) {
        this.mirrorTexture.dispose();
        this.mirrorTexture = null;
      }
      if (this.waterMaterial) {
        this.waterMaterial.setFloat("uReflectionEnabled", 0.0);
        // Rebind dummy texture so WebGPU sampler stays valid
        if (this.dummyTexture) {
          this.waterMaterial.setTexture("uReflectionSampler", this.dummyTexture);
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
      this.waterMaterial.setFloat("uWaveAngle", angleRadians);
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
  syncFogSettings(fogColor: Color3, fogDensity: number): void {
    if (!this.waterMaterial) return;
    this.waterMaterial.setColor3("uFogColor", fogColor);
    this.waterMaterial.setFloat("uFogDensity", fogDensity);
  }

  /**
   * Get water mesh for adding to render lists
   */
  getMesh(): Mesh | null {
    return this.waterMesh;
  }

  /**
   * Get water material for sharing with other meshes
   */
  getMaterial(): ShaderMaterial | null {
    return this.waterMaterial;
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    // Unregister render callback first
    if (this.renderObserver) {
      this.scene.onBeforeRenderObservable.remove(this.renderObserver);
      this.renderObserver = null;
    }

    if (this.mirrorTexture) {
      this.mirrorTexture.dispose();
      this.mirrorTexture = null;
    }
    if (this.waterMesh) {
      this.waterMesh.dispose();
      this.waterMesh = null;
    }
    if (this.waterMaterial) {
      this.waterMaterial.dispose();
      this.waterMaterial = null;
    }
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
