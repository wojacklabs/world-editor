/**
 * WaterRenderer - Gerstner wave water plane rendering for game use
 *
 * Features:
 * - Water plane at sea level
 * - Gerstner wave vertex displacement (matches editor WaterShader)
 * - Analytical wave normals for accurate lighting
 * - GGX specular, Fresnel, sky gradient reflection, SSS
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
 * });
 * // In render loop:
 * water.update(time, camera.position);
 * ```
 */

import * as THREE from "three";

// ============================================
// Water Vertex Shader (Gerstner Waves)
// ============================================

const waterVertexShader = `
precision highp float;

uniform float uTime;

uniform vec4 uWave0;
uniform vec4 uWave1;
uniform vec4 uWave2;
uniform vec4 uWave3;

uniform float uWaveAngleCos;
uniform float uWaveAngleSin;
uniform vec3 uCameraPosition;

varying vec3 vWorldPos;
varying vec2 vUV;
varying float vWaveHeight;
varying vec2 vOrigXZ;
varying vec3 vViewVector;

vec3 gerstnerWave(vec4 wave, vec3 p) {
    float steepness = wave.z;
    float wavelength = wave.w;
    if (wavelength < 0.01) return vec3(0.0);
    float k = 6.28318 / wavelength;
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

    vec3 displacement = vec3(0.0);
    displacement += gerstnerWave(uWave0, worldPos);
    displacement += gerstnerWave(uWave1, worldPos);
    displacement += gerstnerWave(uWave2, worldPos);
    displacement += gerstnerWave(uWave3, worldPos);

    worldPos += displacement;
    vWaveHeight = displacement.y;

    vWorldPos = worldPos;
    vUV = uv;
    vViewVector = normalize(uCameraPosition - worldPos);

    gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
}
`;

// ============================================
// Water Fragment Shader (Gerstner Normals + PBR)
// ============================================

const waterFragmentShader = `
precision highp float;

varying vec3 vWorldPos;
varying vec2 vUV;
varying float vWaveHeight;
varying vec2 vOrigXZ;
varying vec3 vViewVector;

uniform float uTime;
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

uniform float uWaveAngleCos;
uniform float uWaveAngleSin;

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

vec3 computeWaveNormal(vec2 origXZ, float time) {
    vec3 tangent = vec3(1.0, 0.0, 0.0);
    vec3 binormal = vec3(0.0, 0.0, 1.0);

    // Main waves
    gerstnerWaveNormal(uWave0, origXZ, time, tangent, binormal);
    gerstnerWaveNormal(uWave1, origXZ, time, tangent, binormal);
    gerstnerWaveNormal(uWave2, origXZ, time, tangent, binormal);
    gerstnerWaveNormal(uWave3, origXZ, time, tangent, binormal);

    // Detail waves (fragment-only — irrational wavelengths to avoid repetition)
    gerstnerWaveNormal(vec4( 0.8,  0.6, 0.05, 0.97),  origXZ, time, tangent, binormal);
    gerstnerWaveNormal(vec4(-0.6,  0.8, 0.04, 0.67),  origXZ, time, tangent, binormal);
    gerstnerWaveNormal(vec4( 0.9, -0.4, 0.03, 0.41),  origXZ, time, tangent, binormal);
    gerstnerWaveNormal(vec4(-0.3, -0.9, 0.02, 0.23), origXZ, time, tangent, binormal);

    return normalize(cross(binormal, tangent));
}

void main() {
    // Deep water assumed (no heightmap in loader)
    float depthFactor = 1.0;

    // Analytical wave normal
    vec3 finalNormal = computeWaveNormal(vOrigXZ, uTime);

    // Fresnel: F0=0.35
    float rawFresnel = pow(1.0 - max(dot(vViewVector, finalNormal), 0.0), uFresnelPower);
    float fresnel = clamp(mix(0.35, 1.0, rawFresnel), 0.0, 1.0);

    // Water color (deep water dominant)
    vec3 waterColor = mix(uShallowColor, uDeepColor, depthFactor);

    // Sky gradient reflection
    vec3 reflectDir = reflect(-vViewVector, finalNormal);
    float skyUp = max(reflectDir.y, 0.0);
    float skyHoriz = 1.0 - abs(reflectDir.y);
    vec3 skyZenith = vec3(0.35, 0.55, 0.9);
    vec3 skyHorizon = vec3(0.75, 0.85, 0.95);
    vec3 skyBase = vec3(0.55, 0.65, 0.75);
    vec3 skyColor = mix(skyBase, skyHorizon, skyHoriz * 0.7);
    skyColor = mix(skyColor, skyZenith, skyUp * skyUp);

    // Reflection-dominant compositing
    vec3 color = mix(waterColor, skyColor, fresnel);

    // GGX microfacet specular
    vec3 halfVector = normalize(vViewVector + uSunDirection);
    float NdotH = max(dot(finalNormal, halfVector), 0.0);
    float roughness = 0.07;
    float ggxAlpha = roughness * roughness;
    float ggxAlpha2 = ggxAlpha * ggxAlpha;
    float denom = NdotH * NdotH * (ggxAlpha2 - 1.0) + 1.0;
    float D = ggxAlpha2 / (3.14159 * denom * denom);
    float specular = D * max(dot(finalNormal, uSunDirection), 0.0);
    color += uSunColor * specular * 0.5;

    // Subsurface scattering — wave crest translucency
    float sssWaveHeight = max(vWaveHeight, 0.0);
    float sssDot = pow(max(dot(vViewVector, -uSunDirection), 0.0), 3.0);
    float sssThickness = sssWaveHeight;
    vec3 sssColor = mix(vec3(0.05, 0.3, 0.35), vec3(0.15, 0.6, 0.5), sssThickness);
    color += sssColor * sssDot * sssThickness * 0.6;

    // Fresnel-driven opacity
    float alpha = mix(0.92, 1.0, fresnel);

    gl_FragColor = vec4(color, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
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
  // Colors
  shallowColor?: THREE.Color;
  deepColor?: THREE.Color;
  fresnelColor?: THREE.Color;
  // Waves
  waves?: GerstnerWave[];
  fresnelPower?: number;
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

export class WaterRenderer {
  private scene: THREE.Scene;
  private mesh: THREE.Mesh | null = null;
  private material: THREE.ShaderMaterial | null = null;

  private sunDirection: THREE.Vector3 = new THREE.Vector3(0.5, 0.8, 0.3).normalize();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  create(config: WaterConfig): void {
    this.dispose();

    const {
      size,
      seaLevel,
      shallowColor = new THREE.Color(0.04, 0.12, 0.15),
      deepColor = new THREE.Color(0.01, 0.04, 0.08),
      fresnelColor = new THREE.Color(0.45, 0.65, 0.75),
      waves = DEFAULT_WAVES,
      fresnelPower = 2.0,
      sunDirection,
      sunColor = new THREE.Color(1.0, 0.95, 0.8),
    } = config;

    if (sunDirection) {
      this.sunDirection = sunDirection.clone().normalize();
    }

    // Compute wave angle (river mode uses flowAngle)
    const flowAngleRad = config.waterType === "river" && config.waterFlowAngle != null
      ? (config.waterFlowAngle * Math.PI) / 180
      : 0;
    const waveAngleCos = Math.cos(flowAngleRad);
    const waveAngleSin = Math.sin(flowAngleRad);

    // Create water plane geometry (PlaneGeometry is XY, rotate to XZ)
    const geometry = new THREE.PlaneGeometry(size, size, 64, 64);
    geometry.rotateX(-Math.PI / 2);

    // Create material
    this.material = new THREE.ShaderMaterial({
      vertexShader: waterVertexShader,
      fragmentShader: waterFragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uWaveAngleCos: { value: waveAngleCos },
        uWaveAngleSin: { value: waveAngleSin },
        uFresnelPower: { value: fresnelPower },
        uShallowColor: { value: shallowColor },
        uDeepColor: { value: deepColor },
        uFresnelColor: { value: fresnelColor },
        uSunDirection: { value: this.sunDirection.clone() },
        uSunColor: { value: sunColor },
        uCameraPosition: { value: new THREE.Vector3() },
        uWave0: { value: new THREE.Vector4() },
        uWave1: { value: new THREE.Vector4() },
        uWave2: { value: new THREE.Vector4() },
        uWave3: { value: new THREE.Vector4() },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    // Set wave uniforms
    for (let i = 0; i < 4; i++) {
      const wave = waves[i] || { direction: new THREE.Vector2(0, 0), steepness: 0, wavelength: 0 };
      const uniform = this.material.uniforms[`uWave${i}`];
      uniform.value.set(wave.direction.x, wave.direction.y, wave.steepness, wave.wavelength);
    }

    // Create mesh and position at center offset + sea level
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.position.set(size / 2, seaLevel, size / 2);
    this.mesh.layers.enableAll();

    this.scene.add(this.mesh);
  }

  /**
   * Update water animation. Call this every frame from the render loop.
   * @param time Elapsed time in seconds
   * @param cameraPosition Current camera world position
   */
  update(time: number, cameraPosition: THREE.Vector3): void {
    if (!this.material) return;

    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uCameraPosition.value.copy(cameraPosition);
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
  }
}
