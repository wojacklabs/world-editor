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
 * water.startAnimation();
 * ```
 */

import {
  Scene,
  Mesh,
  MeshBuilder,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  Color3,
  Effect,
  Observer,
} from "@babylonjs/core";

// ============================================
// Water Vertex Shader (Gerstner Waves)
// ============================================

const waterVertexShader = `
precision highp float;

attribute vec3 position;
attribute vec2 uv;

uniform mat4 world;
uniform mat4 viewProjection;
uniform float uTime;

uniform vec4 uWave0;
uniform vec4 uWave1;
uniform vec4 uWave2;
uniform vec4 uWave3;

uniform float uWaveAngle;
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

    gl_Position = viewProjection * vec4(worldPos, 1.0);
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

uniform float uWaveAngle;

// ---- Analytical Gerstner wave normals ----

void gerstnerWaveNormal(vec4 wave, vec2 xz, float time, inout vec3 tangent, inout vec3 binormal) {
    float steepness = wave.z;
    float wavelength = wave.w;
    if (wavelength < 0.01) return;
    float k = 6.28318 / wavelength;
    float c = sqrt(9.8 / k);
    float ca = cos(uWaveAngle), sa = sin(uWaveAngle);
    vec2 rawD = normalize(wave.xy);
    vec2 d = vec2(rawD.x * ca - rawD.y * sa, rawD.x * sa + rawD.y * ca);
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

    // Detail waves (fragment-only, adds surface detail)
    gerstnerWaveNormal(vec4( 0.8,  0.6, 0.05, 1.0),  origXZ, time, tangent, binormal);
    gerstnerWaveNormal(vec4(-0.6,  0.8, 0.04, 0.7),  origXZ, time, tangent, binormal);
    gerstnerWaveNormal(vec4( 0.9, -0.4, 0.03, 0.4),  origXZ, time, tangent, binormal);
    gerstnerWaveNormal(vec4(-0.3, -0.9, 0.02, 0.25), origXZ, time, tangent, binormal);

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
}
`;

// ============================================
// WaterRenderer Class
// ============================================

let waterShaderCounter = 0;

interface GerstnerWave {
  direction: Vector2;
  steepness: number;
  wavelength: number;
}

export interface WaterConfig {
  size: number;
  seaLevel: number;
  // Colors
  shallowColor?: Color3;
  deepColor?: Color3;
  fresnelColor?: Color3;
  // Waves
  waves?: GerstnerWave[];
  fresnelPower?: number;
  // Sun
  sunDirection?: Vector3;
  sunColor?: Color3;
}

const DEFAULT_WAVES: GerstnerWave[] = [
  { direction: new Vector2(1.0, 0.3), steepness: 0.375, wavelength: 8.0 },
  { direction: new Vector2(0.3, 1.0), steepness: 0.27, wavelength: 5.0 },
  { direction: new Vector2(-0.5, 0.7), steepness: 0.18, wavelength: 3.0 },
  { direction: new Vector2(0.7, -0.4), steepness: 0.09, wavelength: 1.5 },
];

export class WaterRenderer {
  private scene: Scene;
  private mesh: Mesh | null = null;
  private material: ShaderMaterial | null = null;
  private renderObserver: Observer<Scene> | null = null;
  private startTime: number = 0;
  private animating: boolean = false;
  private shaderId: number;

  private sunDirection: Vector3 = new Vector3(0.5, 0.8, 0.3).normalize();

  constructor(scene: Scene) {
    this.scene = scene;
    this.shaderId = ++waterShaderCounter;
    this.registerShaders();
  }

  private registerShaders(): void {
    Effect.ShadersStore[`gameWater${this.shaderId}VertexShader`] = waterVertexShader;
    Effect.ShadersStore[`gameWater${this.shaderId}FragmentShader`] = waterFragmentShader;
  }

  create(config: WaterConfig): void {
    this.dispose();

    const {
      size,
      seaLevel,
      shallowColor = new Color3(0.04, 0.12, 0.15),
      deepColor = new Color3(0.01, 0.04, 0.08),
      fresnelColor = new Color3(0.45, 0.65, 0.75),
      waves = DEFAULT_WAVES,
      fresnelPower = 2.0,
      sunDirection,
      sunColor = new Color3(1.0, 0.95, 0.8),
    } = config;

    if (sunDirection) {
      this.sunDirection = sunDirection.normalize();
    }

    // Create water plane
    this.mesh = MeshBuilder.CreateGround(
      "gameWater",
      { width: size, height: size, subdivisions: 64 },
      this.scene
    );
    this.mesh.position.y = seaLevel;
    this.mesh.isPickable = false;

    // Create material
    this.material = new ShaderMaterial(
      `gameWaterMat_${this.shaderId}`,
      this.scene,
      { vertex: `gameWater${this.shaderId}`, fragment: `gameWater${this.shaderId}` },
      {
        attributes: ["position", "uv"],
        uniforms: [
          "world",
          "viewProjection",
          "uTime",
          "uWave0", "uWave1", "uWave2", "uWave3",
          "uWaveAngle",
          "uCameraPosition",
          "uSunDirection",
          "uSunColor",
          "uShallowColor",
          "uDeepColor",
          "uFresnelColor",
          "uFresnelPower",
        ],
        needAlphaBlending: true,
      }
    );

    this.material.backFaceCulling = false;
    this.material.setFloat("uTime", 0);
    this.material.setFloat("uWaveAngle", 0);
    this.material.setFloat("uFresnelPower", fresnelPower);
    this.material.setColor3("uShallowColor", shallowColor);
    this.material.setColor3("uDeepColor", deepColor);
    this.material.setColor3("uFresnelColor", fresnelColor);
    this.material.setVector3("uSunDirection", this.sunDirection);
    this.material.setColor3("uSunColor", sunColor);

    // Set wave uniforms
    for (let i = 0; i < 4; i++) {
      const wave = waves[i] || { direction: new Vector2(0, 0), steepness: 0, wavelength: 0 };
      this.material.setVector4(
        `uWave${i}`,
        new Vector4(wave.direction.x, wave.direction.y, wave.steepness, wave.wavelength)
      );
    }

    this.mesh.material = this.material;
  }

  setSunDirection(direction: Vector3): void {
    this.sunDirection = direction.normalize();
    if (this.material) {
      this.material.setVector3("uSunDirection", this.sunDirection);
    }
  }

  startAnimation(): void {
    if (this.animating) return;

    this.animating = true;
    this.startTime = performance.now() / 1000;

    this.renderObserver = this.scene.onBeforeRenderObservable.add(() => {
      if (!this.material) return;

      const time = performance.now() / 1000 - this.startTime;
      this.material.setFloat("uTime", time);

      const camera = this.scene.activeCamera;
      if (camera) {
        this.material.setVector3("uCameraPosition", camera.position);
      }
    });
  }

  stopAnimation(): void {
    if (this.renderObserver) {
      this.scene.onBeforeRenderObservable.remove(this.renderObserver);
      this.renderObserver = null;
    }
    this.animating = false;
  }

  setEnabled(enabled: boolean): void {
    if (this.mesh) {
      this.mesh.setEnabled(enabled);
    }
  }

  dispose(): void {
    this.stopAnimation();

    if (this.mesh) {
      this.mesh.dispose();
      this.mesh = null;
    }
    if (this.material) {
      this.material.dispose();
      this.material = null;
    }
  }
}
