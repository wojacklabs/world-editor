/**
 * WaterRenderer - Gerstner wave water plane rendering for game use
 *
 * Features:
 * - Heightmap-based water depth calculation (no extra render pass)
 * - Soft edge blending at shore
 * - Shore foam based on depth
 * - Fresnel effect for angle-based reflection
 * - Depth-based color and transparency
 * - Gerstner waves for realistic wave motion
 * - Wind-driven waves (shared with grass)
 * - Interactive water ripples
 * - Planar reflection support
 *
 * Usage:
 * ```typescript
 * import { WorldLoader, WaterRenderer } from "@world-editor/loader";
 *
 * const result = WorldLoader.loadWorld(json);
 * const tile = result.data!.mainTile!;
 *
 * const water = new WaterRenderer(scene);
 * water.create({
 *   size: tile.size,
 *   seaLevel: tile.seaLevel,
 *   heightmap: tile.heightmap,
 *   resolution: tile.resolution,
 * });
 * // In render loop:
 * water.update(time, camera.position);
 * ```
 */

import * as THREE from "three";

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

// ============================================
// WaterRenderer Class
// ============================================

interface GerstnerWave {
  direction: THREE.Vector2;
  steepness: number;
  wavelength: number;
}

export interface WaterConfig {
  size: number;
  seaLevel: number;
  // Heightmap for depth calculation
  heightmap?: Float32Array;
  resolution?: number;
  // Colors
  shallowColor?: THREE.Color;
  deepColor?: THREE.Color;
  fresnelColor?: THREE.Color;
  // Waves
  waves?: GerstnerWave[];
  fresnelPower?: number;
  maxDepth?: number;
  shoreBlendDistance?: number;
  // Foam
  foamIntensity?: number;
  shoreFoamWidth?: number;
  // Wind
  windWaveStrength?: number;
  windNormalStrength?: number;
  // Reflection
  reflectionEnabled?: boolean;
  reflectionStrength?: number;
  // Sun
  sunDirection?: THREE.Vector3;
  sunColor?: THREE.Color;
  // Water type
  waterType?: "lake" | "river";
  waterFlowAngle?: number;
}

const DEFAULT_WAVES: GerstnerWave[] = [
  { direction: new THREE.Vector2(1.0, 0.3), steepness: 0.375, wavelength: 7.3 },
  { direction: new THREE.Vector2(0.3, 1.0), steepness: 0.27, wavelength: 4.7 },
  { direction: new THREE.Vector2(-0.5, 0.7), steepness: 0.18, wavelength: 2.9 },
  { direction: new THREE.Vector2(0.7, -0.4), steepness: 0.09, wavelength: 1.3 },
];

const LAKE_WAVES: GerstnerWave[] = [
  { direction: new THREE.Vector2(1.0, 0.3), steepness: 0.005, wavelength: 2.3 },
  { direction: new THREE.Vector2(-0.4, 1.0), steepness: 0.004, wavelength: 1.7 },
  { direction: new THREE.Vector2(0.7, -0.5), steepness: 0.003, wavelength: 1.1 },
  { direction: new THREE.Vector2(-0.3, -0.8), steepness: 0.002, wavelength: 0.7 },
];

export class WaterRenderer {
  private scene: THREE.Scene;
  private mesh: THREE.Mesh | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private heightmapTexture: THREE.DataTexture | null = null;
  private dummyTexture: THREE.DataTexture | null = null;

  private sunDirection: THREE.Vector3 = new THREE.Vector3(0.5, 0.8, 0.3).normalize();

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    // 1x1 dummy texture for sampler binding
    const dummyData = new Uint8Array([0, 0, 0, 255]);
    this.dummyTexture = new THREE.DataTexture(dummyData, 1, 1, THREE.RGBAFormat);
    this.dummyTexture.magFilter = THREE.NearestFilter;
    this.dummyTexture.minFilter = THREE.NearestFilter;
    this.dummyTexture.needsUpdate = true;
  }

  /**
   * Create heightmap texture from Float32Array for depth calculation
   */
  private createHeightmapTexture(
    heightmap: Float32Array,
    resolution: number,
  ): { texture: THREE.DataTexture; minHeight: number; heightScale: number } {
    let minHeight = Infinity;
    let maxHeight = -Infinity;
    for (let i = 0; i < heightmap.length; i++) {
      if (heightmap[i] < minHeight) minHeight = heightmap[i];
      if (heightmap[i] > maxHeight) maxHeight = heightmap[i];
    }
    const heightRange = maxHeight - minHeight || 1;

    const data = new Uint8Array(resolution * resolution * 4);
    for (let z = 0; z < resolution; z++) {
      for (let x = 0; x < resolution; x++) {
        const height = heightmap[z * resolution + x] ?? 0;
        const normalizedHeight = Math.floor(((height - minHeight) / heightRange) * 255);
        const clampedHeight = Math.max(0, Math.min(255, normalizedHeight));

        const idx = (z * resolution + x) * 4;
        data[idx] = clampedHeight;
        data[idx + 1] = clampedHeight;
        data[idx + 2] = clampedHeight;
        data[idx + 3] = 255;
      }
    }

    const texture = new THREE.DataTexture(data, resolution, resolution, THREE.RGBAFormat);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;

    return { texture, minHeight, heightScale: heightRange };
  }

  create(config: WaterConfig): void {
    this.dispose();

    const {
      size,
      seaLevel,
      heightmap,
      resolution,
      shallowColor = new THREE.Color(0.04, 0.12, 0.15),
      deepColor = new THREE.Color(0.01, 0.04, 0.08),
      fresnelColor = new THREE.Color(0.45, 0.65, 0.75),
      fresnelPower = 2.0,
      maxDepth = 6.0,
      shoreBlendDistance = 0.6,
      foamIntensity = 1.4,
      shoreFoamWidth = 1.2,
      windWaveStrength = 0.12,
      windNormalStrength = 0.3,
      reflectionEnabled = false,
      reflectionStrength = 0.90,
      sunDirection,
      sunColor = new THREE.Color(1.0, 0.95, 0.8),
    } = config;

    // Select waves based on water type
    let waves = config.waves ?? DEFAULT_WAVES;
    if (!config.waves && config.waterType === "lake") {
      waves = LAKE_WAVES;
    }

    if (sunDirection) {
      this.sunDirection = sunDirection.clone().normalize();
    }

    // Compute wave angle (river mode uses flowAngle)
    const flowAngleRad = config.waterType === "river" && config.waterFlowAngle != null
      ? (config.waterFlowAngle * Math.PI) / 180
      : 0;
    const waveAngleCos = Math.cos(flowAngleRad);
    const waveAngleSin = Math.sin(flowAngleRad);

    // Create heightmap texture if heightmap data provided
    let hmTexture: THREE.Texture = this.dummyTexture!;
    let minHeight = 0;
    let heightScale = 1;
    let terrainScale = size;

    if (heightmap && resolution) {
      const result = this.createHeightmapTexture(heightmap, resolution);
      this.heightmapTexture = result.texture;
      hmTexture = result.texture;
      minHeight = result.minHeight;
      heightScale = result.heightScale;
      terrainScale = size;
    }

    // Create water plane geometry (PlaneGeometry is XY, rotate to XZ)
    const geometry = new THREE.PlaneGeometry(size, size, 64, 64);
    geometry.rotateX(-Math.PI / 2);

    // Create material
    this.material = new THREE.ShaderMaterial({
      vertexShader: waterVertexShader,
      fragmentShader: waterFragmentShader,
      uniforms: {
        uTime: { value: 0.0 },
        uWaterLevel: { value: seaLevel },

        uWave0: { value: new THREE.Vector4(waves[0]?.direction.x ?? 0, waves[0]?.direction.y ?? 0, waves[0]?.steepness ?? 0, waves[0]?.wavelength ?? 0) },
        uWave1: { value: new THREE.Vector4(waves[1]?.direction.x ?? 0, waves[1]?.direction.y ?? 0, waves[1]?.steepness ?? 0, waves[1]?.wavelength ?? 0) },
        uWave2: { value: new THREE.Vector4(waves[2]?.direction.x ?? 0, waves[2]?.direction.y ?? 0, waves[2]?.steepness ?? 0, waves[2]?.wavelength ?? 0) },
        uWave3: { value: new THREE.Vector4(waves[3]?.direction.x ?? 0, waves[3]?.direction.y ?? 0, waves[3]?.steepness ?? 0, waves[3]?.wavelength ?? 0) },

        uSunDirection: { value: this.sunDirection.clone() },
        uSunColor: { value: sunColor },

        uShallowColor: { value: shallowColor },
        uDeepColor: { value: deepColor },
        uFresnelColor: { value: fresnelColor },
        uFresnelPower: { value: fresnelPower },
        uMaxDepth: { value: maxDepth },
        uShoreBlendDistance: { value: shoreBlendDistance },

        uFoamIntensity: { value: foamIntensity },
        uShoreFoamWidth: { value: shoreFoamWidth },

        uTerrainScale: { value: terrainScale },
        uHeightScale: { value: heightScale },
        uMinHeight: { value: minHeight },

        uHeightmap: { value: hmTexture },
        uReflectionSampler: { value: this.dummyTexture },
        uInteractiveHeight: { value: this.dummyTexture },

        uReflectionStrength: { value: reflectionStrength },
        uReflectionEnabled: { value: reflectionEnabled ? 1.0 : 0.0 },

        uFogColor: { value: new THREE.Color(0.6, 0.75, 0.9) },
        uFogDensity: { value: 0.008 },

        uWaveAngleCos: { value: waveAngleCos },
        uWaveAngleSin: { value: waveAngleSin },

        uInteractiveEnabled: { value: 0.0 },
        uInteractiveStrength: { value: 1.0 },

        uWindTexture: { value: this.dummyTexture },
        uWindWaveStrength: { value: windWaveStrength },
        uWindNormalStrength: { value: windNormalStrength },
        uWindDirection: { value: new THREE.Vector2(0.707, 0.707) },
        uWindEnabled: { value: 0.0 },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    // Create mesh and position at center offset + sea level
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.position.set(size / 2, seaLevel, size / 2);
    this.mesh.layers.enableAll();

    this.scene.add(this.mesh);
  }

  /**
   * Update water animation. Call this every frame from the render loop.
   * @param time Elapsed time in seconds
   * @param _cameraPosition Current camera world position (unused, three.js provides cameraPosition built-in)
   */
  update(time: number, _cameraPosition: THREE.Vector3): void {
    if (!this.material) return;

    this.material.uniforms.uTime.value = time;
  }

  setSunDirection(direction: THREE.Vector3): void {
    this.sunDirection = direction.clone().normalize();
    if (this.material) {
      this.material.uniforms.uSunDirection.value.copy(this.sunDirection);
    }
  }

  setEnabled(enabled: boolean): void {
    if (this.mesh) {
      this.mesh.visible = enabled;
    }
  }

  /**
   * Bind wind noise texture (shared with grass) for synchronized wind waves
   */
  setWindTexture(texture: THREE.Texture | null, windDirection?: THREE.Vector2): void {
    if (!this.material) return;

    if (texture) {
      this.material.uniforms.uWindTexture.value = texture;
      this.material.uniforms.uWindEnabled.value = 1.0;
      if (windDirection) {
        this.material.uniforms.uWindDirection.value.copy(windDirection);
      }
    } else {
      if (this.dummyTexture) {
        this.material.uniforms.uWindTexture.value = this.dummyTexture;
      }
      this.material.uniforms.uWindEnabled.value = 0.0;
    }
  }

  /**
   * Enable interactive water and bind height texture
   */
  setInteractiveWater(heightTexture: THREE.Texture | null, strength: number = 1.0): void {
    if (!this.material) return;

    if (heightTexture) {
      this.material.uniforms.uInteractiveHeight.value = heightTexture;
      this.material.uniforms.uInteractiveEnabled.value = 1.0;
      this.material.uniforms.uInteractiveStrength.value = strength;
    } else {
      if (this.dummyTexture) {
        this.material.uniforms.uInteractiveHeight.value = this.dummyTexture;
      }
      this.material.uniforms.uInteractiveEnabled.value = 0.0;
    }
  }

  /**
   * Sync fog settings
   */
  syncFogSettings(fogColor: THREE.Color, fogDensity: number): void {
    if (!this.material) return;
    this.material.uniforms.uFogColor.value = fogColor;
    this.material.uniforms.uFogDensity.value = fogDensity;
  }

  dispose(): void {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    if (this.material) {
      this.material.dispose();
      this.material = null;
    }
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
