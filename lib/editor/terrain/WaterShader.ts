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
  Texture,
  RawTexture,
  ShaderMaterial,
  Effect,
  Constants,
} from "@babylonjs/core";
import { Heightmap } from "./Heightmap";

// ============================================
// Water Vertex Shader
// ============================================
const waterVertexShader = `
precision highp float;

// Attributes
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;

// Uniforms
uniform mat4 world;
uniform mat4 view;
uniform mat4 projection;
uniform mat4 viewProjection;
uniform float uTime;
uniform float uWaterLevel;

// Gerstner wave parameters (4 waves)
uniform vec4 uWave0;
uniform vec4 uWave1;
uniform vec4 uWave2;
uniform vec4 uWave3;

// Varyings
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vUV;
varying vec4 vScreenPos;
varying vec3 vViewVector;
varying float vWaveHeight;

// Gerstner wave function
vec3 gerstnerWave(vec4 wave, vec3 p, inout vec3 tangent, inout vec3 binormal) {
    float steepness = wave.z;
    float wavelength = wave.w;

    if (wavelength < 0.01) return vec3(0.0);

    float k = 2.0 * 3.14159265 / wavelength;
    float c = sqrt(9.8 / k);
    vec2 d = normalize(wave.xy);
    float f = k * (dot(d, p.xz) - c * uTime);
    float a = steepness / k;

    tangent += vec3(
        -d.x * d.x * steepness * sin(f),
        d.x * steepness * cos(f),
        -d.x * d.y * steepness * sin(f)
    );
    binormal += vec3(
        -d.x * d.y * steepness * sin(f),
        d.y * steepness * cos(f),
        -d.y * d.y * steepness * sin(f)
    );

    return vec3(
        d.x * a * cos(f),
        a * sin(f),
        d.y * a * cos(f)
    );
}

void main() {
    vec3 worldPos = (world * vec4(position, 1.0)).xyz;

    // Initialize tangent and binormal for normal calculation
    vec3 tangent = vec3(1.0, 0.0, 0.0);
    vec3 binormal = vec3(0.0, 0.0, 1.0);

    // Apply Gerstner waves
    vec3 displacement = vec3(0.0);
    displacement += gerstnerWave(uWave0, worldPos, tangent, binormal);
    displacement += gerstnerWave(uWave1, worldPos, tangent, binormal);
    displacement += gerstnerWave(uWave2, worldPos, tangent, binormal);
    displacement += gerstnerWave(uWave3, worldPos, tangent, binormal);

    worldPos += displacement;
    vWaveHeight = displacement.y;

    // Calculate wave normal from tangent and binormal
    vec3 waveNormal = normalize(cross(binormal, tangent));

    vWorldPos = worldPos;
    vNormal = waveNormal;
    vUV = uv;

    vec4 clipPos = viewProjection * vec4(worldPos, 1.0);
    vScreenPos = clipPos;

    // View vector for Fresnel
    vec3 cameraPos = (inverse(view) * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    vViewVector = normalize(cameraPos - worldPos);

    gl_Position = clipPos;
}
`;

// ============================================
// Water Fragment Shader with Depth-based Effects
// ============================================
const waterFragmentShader = `
precision highp float;

// Varyings
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vUV;
varying vec4 vScreenPos;
varying vec3 vViewVector;
varying float vWaveHeight;

// Uniforms
uniform float uTime;
uniform float uWaterLevel;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform vec3 uCameraPosition;

// Water appearance
uniform vec3 uShallowColor;
uniform vec3 uDeepColor;
uniform vec3 uFresnelColor;
uniform float uFresnelPower;
uniform float uMaxDepth;
uniform float uShoreBlendDistance;

// Textures
uniform sampler2D uNormalMap;
uniform sampler2D uFoamTexture;
uniform sampler2D uHeightmap;

// Heightmap-based depth
uniform float uTerrainScale;
uniform float uHeightScale;

// Normal map settings
uniform float uNormalStrength;
uniform vec2 uNormalScale;
uniform vec2 uNormalSpeed;

// Foam settings
uniform float uFoamIntensity;
uniform float uShoreFoamWidth;

// Calculate terrain height from heightmap at world position
float getTerrainHeight(vec3 worldPos) {
    // Convert world position to heightmap UV (0-1 range)
    vec2 heightmapUV = worldPos.xz / uTerrainScale;
    heightmapUV = clamp(heightmapUV, 0.0, 1.0);

    // Sample heightmap (red channel contains height)
    float normalizedHeight = texture2D(uHeightmap, heightmapUV).r;

    // Convert to world height
    return normalizedHeight * uHeightScale;
}

// Calculate water depth using heightmap
float getHeightmapBasedDepth(vec3 worldPos) {
    float terrainHeight = getTerrainHeight(worldPos);
    float depth = uWaterLevel - terrainHeight;
    return max(depth, 0.0);
}

void main() {
    // Screen UV for effects
    vec2 screenUV = (vScreenPos.xy / vScreenPos.w) * 0.5 + 0.5;

    // Calculate water depth using heightmap (no scene depth pass needed)
    float waterDepth = getHeightmapBasedDepth(vWorldPos);

    // Normalized depth (0 = shore, 1 = max depth)
    float depthFactor = clamp(waterDepth / uMaxDepth, 0.0, 1.0);

    // Sample normal maps at different scales and speeds
    vec2 uv1 = vWorldPos.xz * uNormalScale.x + uTime * uNormalSpeed.x * vec2(1.0, 0.5);
    vec2 uv2 = vWorldPos.xz * uNormalScale.y + uTime * uNormalSpeed.y * vec2(-0.5, 1.0);

    vec3 normal1 = texture2D(uNormalMap, uv1).rgb * 2.0 - 1.0;
    vec3 normal2 = texture2D(uNormalMap, uv2).rgb * 2.0 - 1.0;

    // Blend normals
    vec3 detailNormal = normalize(vec3(
        normal1.xy + normal2.xy,
        normal1.z * normal2.z
    ));

    // Reduce normal strength in shallow water
    float shallowNormalReduce = mix(0.3, 1.0, depthFactor);
    vec3 finalNormal = normalize(vNormal + detailNormal * uNormalStrength * shallowNormalReduce);

    // Fresnel effect
    float fresnel = pow(1.0 - max(dot(vViewVector, finalNormal), 0.0), uFresnelPower);
    fresnel = clamp(fresnel, 0.0, 1.0);

    // Water color based on depth
    vec3 waterColor = mix(uShallowColor, uDeepColor, depthFactor);

    // Add fresnel tint
    waterColor = mix(waterColor, uFresnelColor, fresnel * 0.4);

    // Sky reflection approximation
    vec3 reflectDir = reflect(-vViewVector, finalNormal);
    float skyFactor = max(reflectDir.y, 0.0);
    vec3 skyColor = mix(vec3(0.5, 0.6, 0.7), vec3(0.7, 0.85, 1.0), skyFactor);

    // Blend reflection with water color based on fresnel
    vec3 color = mix(waterColor, skyColor, fresnel * 0.6);

    // Specular highlight (sun reflection)
    vec3 halfVector = normalize(vViewVector + uSunDirection);
    float specular = pow(max(dot(finalNormal, halfVector), 0.0), 256.0);
    specular *= smoothstep(0.0, 0.1, dot(finalNormal, uSunDirection));
    color += uSunColor * specular * 1.2;

    // Shore foam based on depth - enhanced with animated shoreline
    float shoreDistance = waterDepth;

    // Animated shoreline - waves reaching the shore
    float shoreWaveOffset = sin(uTime * 0.8 + vWorldPos.x * 0.3) * 0.15 +
                            sin(uTime * 1.2 + vWorldPos.z * 0.2) * 0.1;
    float animatedShoreWidth = uShoreFoamWidth * (1.0 + shoreWaveOffset);

    // Multi-layer shore foam for more natural look
    float shoreFoamMask1 = 1.0 - smoothstep(0.0, animatedShoreWidth * 0.3, shoreDistance);
    float shoreFoamMask2 = 1.0 - smoothstep(0.0, animatedShoreWidth * 0.7, shoreDistance);
    float shoreFoamMask3 = 1.0 - smoothstep(0.0, animatedShoreWidth, shoreDistance);

    // Combine layers with different intensities
    float shoreFoamMask = shoreFoamMask1 * 0.6 + shoreFoamMask2 * 0.3 + shoreFoamMask3 * 0.2;

    // Wave crest foam
    float crestFoam = smoothstep(0.03, 0.12, vWaveHeight);

    // Sample foam texture with multiple layers for detail
    vec2 foamUV1 = vWorldPos.xz * 0.15 + uTime * 0.03;
    vec2 foamUV2 = vWorldPos.xz * 0.08 - uTime * 0.02;
    vec2 foamUV3 = vWorldPos.xz * 0.25 + vec2(uTime * 0.05, -uTime * 0.03);
    float foamNoise = texture2D(uFoamTexture, foamUV1).r;
    foamNoise *= texture2D(uFoamTexture, foamUV2).r * 2.0;
    float foamDetail = texture2D(uFoamTexture, foamUV3).r;

    // Shore foam pattern - more active near water edge
    float shorePattern = foamNoise * 0.7 + foamDetail * 0.3;

    // Combine foam effects
    float totalFoam = (shoreFoamMask * 0.9 + crestFoam * 0.3) * shorePattern * uFoamIntensity;

    // Add subtle foam trails in shallow water
    float shallowTrails = (1.0 - depthFactor) * foamDetail * 0.15;
    totalFoam += shallowTrails;
    totalFoam = clamp(totalFoam, 0.0, 1.0);

    // Apply foam with slight color variation
    vec3 foamColor = mix(vec3(0.92, 0.96, 0.98), vec3(0.98, 1.0, 1.0), foamNoise);
    color = mix(color, foamColor, totalFoam);

    // Subsurface scattering approximation
    float sss = pow(max(dot(vViewVector, -uSunDirection), 0.0), 4.0);
    sss *= (1.0 - depthFactor) * 0.5;
    color += vec3(0.1, 0.5, 0.4) * sss * 0.25;

    // Transparency based on depth
    // Shallow = more transparent (see bottom), Deep = more opaque
    float baseAlpha = mix(0.4, 0.95, depthFactor);

    // Shore blend - fade out at very shallow areas for soft edge
    float shoreBlend = smoothstep(0.0, uShoreBlendDistance, waterDepth);

    // Final alpha
    float alpha = baseAlpha * shoreBlend;
    alpha = mix(alpha, 1.0, fresnel * 0.3); // More opaque at grazing angles
    alpha = mix(alpha, 1.0, totalFoam * 0.5); // Foam is more opaque
    alpha = clamp(alpha, 0.0, 0.98);

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
  normalStrength: number;
  normalScale: Vector2;
  normalSpeed: Vector2;

  // Foam
  foamIntensity: number;
  shoreFoamWidth: number;

  // Refraction
  refractionStrength: number;
}

/**
 * Default configuration for realistic ocean water
 */
export const DEFAULT_WATER_CONFIG: WaterConfig = {
  shallowColor: new Color3(0.18, 0.55, 0.58),  // Slightly brighter for better visibility
  deepColor: new Color3(0.02, 0.12, 0.22),
  fresnelColor: new Color3(0.45, 0.65, 0.75),  // More vibrant reflection color

  waves: [
    { direction: new Vector2(1.0, 0.3), steepness: 0.02, wavelength: 25.0 },  // Gentle waves to avoid terrain clipping
    { direction: new Vector2(0.3, 1.0), steepness: 0.015, wavelength: 15.0 },
    { direction: new Vector2(-0.5, 0.7), steepness: 0.01, wavelength: 8.0 },
    { direction: new Vector2(0.7, -0.4), steepness: 0.005, wavelength: 4.0 },
  ],

  fresnelPower: 3.5,  // Slightly less aggressive fresnel
  maxDepth: 6.0,      // Better depth sensitivity
  shoreBlendDistance: 0.4,  // Wider soft edge
  normalStrength: 0.25,     // Gentler ripples
  normalScale: new Vector2(0.05, 0.08),
  normalSpeed: new Vector2(0.01, 0.012),  // Slower, more natural movement

  foamIntensity: 1.4,       // More visible foam
  shoreFoamWidth: 1.2,      // Wider shore foam zone

  refractionStrength: 0.015,  // Subtle refraction
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
  private normalTexture: Texture | null = null;
  private foamTexture: Texture | null = null;
  private heightmapTexture: Texture | null = null;

  private config: WaterConfig;
  private waterLevel: number = 0;
  private startTime: number;
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
    // Normal map for water ripples
    this.normalTexture = new Texture("/textures/waterbump.png", this.scene);
    this.normalTexture.wrapU = Texture.WRAP_ADDRESSMODE;
    this.normalTexture.wrapV = Texture.WRAP_ADDRESSMODE;

    // Foam texture
    this.foamTexture = new Texture("/textures/waterbump.png", this.scene);
    this.foamTexture.wrapU = Texture.WRAP_ADDRESSMODE;
    this.foamTexture.wrapV = Texture.WRAP_ADDRESSMODE;

    // Create heightmap texture for depth fallback
    this.createHeightmapTexture();
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
          "uNormalStrength", "uNormalScale", "uNormalSpeed",
          "uFoamIntensity", "uShoreFoamWidth",
          "uTerrainScale", "uHeightScale",
        ],
        samplers: ["uNormalMap", "uFoamTexture", "uHeightmap"],
        needAlphaBlending: true,
      }
    );

    // Enable transparency
    this.waterMaterial.alpha = 0.9;
    this.waterMaterial.backFaceCulling = false;

    // Set textures
    if (this.normalTexture) {
      this.waterMaterial.setTexture("uNormalMap", this.normalTexture);
    }
    if (this.foamTexture) {
      this.waterMaterial.setTexture("uFoamTexture", this.foamTexture);
    }
    if (this.heightmapTexture) {
      this.waterMaterial.setTexture("uHeightmap", this.heightmapTexture);
    }

    // Set heightmap uniforms
    this.waterMaterial.setFloat("uTerrainScale", this.heightmap.getScale());
    const heightRange = this.heightmap.getMaxHeight() - this.heightmap.getMinHeight() || 1;
    this.waterMaterial.setFloat("uHeightScale", heightRange);

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
    this.waterMaterial.setFloat("uNormalStrength", cfg.normalStrength);
    this.waterMaterial.setVector2("uNormalScale", cfg.normalScale);
    this.waterMaterial.setVector2("uNormalSpeed", cfg.normalSpeed);

    // Foam
    this.waterMaterial.setFloat("uFoamIntensity", cfg.foamIntensity);
    this.waterMaterial.setFloat("uShoreFoamWidth", cfg.shoreFoamWidth);

    // Sun
    this.waterMaterial.setVector3("uSunDirection", new Vector3(0.5, 0.8, 0.3).normalize());
    this.waterMaterial.setColor3("uSunColor", new Color3(1.0, 0.95, 0.8));

    if (camera) {
      this.waterMaterial.setVector3("uCameraPosition", camera.position);
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
   * Get water mesh for adding to render lists
   */
  getMesh(): Mesh | null {
    return this.waterMesh;
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
    if (this.normalTexture) {
      this.normalTexture.dispose();
      this.normalTexture = null;
    }
    if (this.foamTexture) {
      this.foamTexture.dispose();
      this.foamTexture = null;
    }
    if (this.heightmapTexture) {
      this.heightmapTexture.dispose();
      this.heightmapTexture = null;
    }
  }
}
