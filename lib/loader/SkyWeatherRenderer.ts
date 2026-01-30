/**
 * SkyWeatherRenderer - Sky and weather rendering for game use
 *
 * Features:
 * - Procedural sky with atmospheric scattering
 * - Dynamic clouds
 * - Rain/snow precipitation effects
 * - Fog system
 *
 * Usage:
 * ```typescript
 * import { WorldLoader, SkyWeatherRenderer } from "@world-editor/loader";
 *
 * const result = WorldLoader.loadWorld(json);
 * const weather = result.data!.weather;
 *
 * const sky = new SkyWeatherRenderer(scene);
 * if (weather) {
 *   sky.setWeather(weather);
 * }
 * sky.startAnimation();
 * ```
 */

import {
  Scene,
  Mesh,
  MeshBuilder,
  ShaderMaterial,
  Vector3,
  Vector2,
  Color3,
  Color4,
  Effect,
  Observer,
  VertexData,
  Engine,
} from "@babylonjs/core";
import type { WeatherData, WeatherPreset } from "./types";

// ============================================
// Sky Shader (Simplified from Editor)
// ============================================

const skyVertexShader = `
precision highp float;

attribute vec3 position;

uniform mat4 worldViewProjection;

varying vec3 vViewDirection;

void main() {
    vViewDirection = normalize(position);
    gl_Position = worldViewProjection * vec4(position, 1.0);
}
`;

const skyFragmentShader = `
precision highp float;

varying vec3 vViewDirection;

uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uCloudCoverage;
uniform float uNightFactor;
uniform vec2 uWindOffset;
uniform float uCloudTime;

// Hash functions
float hash2(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

// Gradient noise
float gradientNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);

    float a = hash2(i);
    float b = hash2(i + vec2(1.0, 0.0));
    float c = hash2(i + vec2(0.0, 1.0));
    float d = hash2(i + vec2(1.0, 1.0));

    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// FBM
float fbm(vec2 p, int octaves) {
    float value = 0.0;
    float amplitude = 0.5;
    float frequency = 1.0;
    float maxValue = 0.0;

    for (int i = 0; i < 6; i++) {
        if (i >= octaves) break;
        value += amplitude * gradientNoise(p * frequency);
        maxValue += amplitude;
        amplitude *= 0.5;
        frequency *= 2.0;
    }

    return value / maxValue;
}

// Cloud UV projection
vec2 getCloudUV(vec3 viewDir) {
    if (viewDir.y <= 0.02) return vec2(-999.0);
    float cloudHeight = 0.35;
    float scale = cloudHeight / max(viewDir.y, 0.1);
    return viewDir.xz * scale * 0.8;
}

// Cloud layer with domain warping
float getCloudLayer(vec2 uv, float scale, vec2 offset) {
    vec2 p = uv * scale + offset;
    vec2 warp1 = vec2(fbm(p + vec2(0.0, 0.0), 3), fbm(p + vec2(5.2, 1.3), 3));
    vec2 warp2 = vec2(fbm(p + warp1 * 2.0 + vec2(1.7, 9.2), 3), fbm(p + warp1 * 2.0 + vec2(8.3, 2.8), 3));
    return fbm(p + warp2 * 1.5, 4);
}

// Cloud density
float getCloudDensity(vec2 uv, float coverage) {
    vec2 animatedUV = uv + uWindOffset;

    float uvDist = length(uv);
    float radialFade = 1.0 - smoothstep(2.5, 4.5, uvDist);

    float layer1 = getCloudLayer(animatedUV, 0.8, vec2(0.0));
    float layer2 = getCloudLayer(animatedUV, 1.2, vec2(50.0, 30.0));
    float layer3 = getCloudLayer(animatedUV, 2.0, vec2(-30.0, 70.0));

    float baseDensity = layer1 * 0.5 + layer2 * 0.3 + layer3 * 0.2;
    baseDensity = smoothstep(0.3, 0.7, baseDensity);

    float fineDetail = fbm(animatedUV * 4.0 + vec2(100.0), 4);
    float density = baseDensity * (0.7 + 0.3 * fineDetail);

    float threshold = 0.2 + (1.0 - coverage) * 0.5;
    density = smoothstep(threshold - 0.2, threshold + 0.25, density);

    return clamp(density * radialFade, 0.0, 1.0);
}

// Atmospheric scattering
vec3 calculateAtmosphere(vec3 viewDir, vec3 sunDir) {
    float cosTheta = dot(viewDir, sunDir);
    float rayleighPhase = 0.75 * (1.0 + cosTheta * cosTheta);

    float altitude = max(viewDir.y, 0.0);
    float rayleighDensity = exp(-altitude * 0.5);

    vec3 rayleigh = vec3(3.8e-6, 13.5e-6, 33.0e-6) * rayleighPhase * rayleighDensity * 40000.0;

    return rayleigh * uSunColor;
}

void main() {
    vec3 viewDir = normalize(vViewDirection);
    vec3 sunDir = normalize(uSunDirection);

    // Sky color
    vec3 skyColor = calculateAtmosphere(viewDir, sunDir);

    // Sun
    float sunAngle = dot(viewDir, sunDir);
    float sunDisc = smoothstep(0.9995, 0.9998, sunAngle);
    float sunGlow = pow(max(0.0, sunAngle), 8.0) * 0.5;
    skyColor += uSunColor * sunDisc * 50.0;
    skyColor += uSunColor * sunGlow * (1.0 - uNightFactor);

    // Horizon
    float horizonFade = 1.0 - abs(viewDir.y);
    horizonFade = pow(horizonFade, 3.0);
    vec3 horizonColor = uSunColor * vec3(1.0, 0.7, 0.5) * horizonFade;
    skyColor += horizonColor * 0.3 * (1.0 - uNightFactor * 0.5);

    // Clouds
    vec2 cloudUV = getCloudUV(viewDir);
    float cloudDensity = 0.0;
    vec3 cloudColor = vec3(1.0);

    if (cloudUV.x > -900.0 && uCloudCoverage > 0.01) {
        cloudDensity = getCloudDensity(cloudUV, uCloudCoverage);
        float horizonCloudFade = smoothstep(0.01, 0.15, viewDir.y);
        cloudDensity *= horizonCloudFade * (1.0 - uNightFactor * 0.5);
    }

    // Night sky
    vec3 nightColor = vec3(0.01, 0.015, 0.03);
    skyColor = mix(skyColor, nightColor, uNightFactor);

    // Blend clouds
    skyColor = mix(skyColor, cloudColor, cloudDensity * 0.95);

    // Tone mapping
    skyColor = skyColor / (skyColor + vec3(0.8));
    skyColor = pow(skyColor, vec3(0.95));

    gl_FragColor = vec4(skyColor, 1.0);
}
`;

// ============================================
// Precipitation Shader
// ============================================

const precipVertexShader = `
precision highp float;

attribute vec3 position;
attribute vec2 uv;
attribute vec3 particleSeed;

uniform mat4 viewProjection;
uniform float uTime;
uniform vec3 uCameraPosition;
uniform vec3 uWindDirection;
uniform float uWindSpeed;
uniform float uFallSpeed;
uniform vec3 uBoxSize;
uniform float uStreakLength;
uniform float uParticleSize;
uniform float uPrecipitationType;

varying vec2 vUV;
varying float vAlpha;
varying float vSizeScale;

void main() {
    vec3 seed = particleSeed;
    float particleId = seed.x * 127.1 + seed.z * 311.7;
    float particleRand = fract(sin(particleId) * 43758.5453);

    vSizeScale = 0.5 + particleRand * 1.0;

    vec3 particlePos = seed * uBoxSize - uBoxSize * 0.5;
    particlePos.y = seed.y * uBoxSize.y;

    float particleTime = uTime + fract(particleId) * 10.0;
    float fallDistance = mod(particleTime * uFallSpeed, uBoxSize.y);
    particlePos.y -= fallDistance;
    particlePos.x += uWindDirection.x * uWindSpeed * particleTime * 0.3;
    particlePos.z += uWindDirection.z * uWindSpeed * particleTime * 0.3;

    if (uPrecipitationType > 0.5) {
        float flutterFreq = 2.0 + particleRand * 2.0;
        float flutterAmp = 0.3 + particleRand * 0.4;
        particlePos.x += sin(particleTime * flutterFreq + particleId) * flutterAmp;
        particlePos.z += cos(particleTime * flutterFreq * 0.7 + particleId * 1.3) * flutterAmp * 0.5;
    }

    vec3 relPos = particlePos - uCameraPosition;
    relPos = mod(relPos + uBoxSize * 0.5, uBoxSize) - uBoxSize * 0.5;
    particlePos = relPos + uCameraPosition;

    vec3 toCamera = normalize(uCameraPosition - particlePos);
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCamera));
    vec3 up = vec3(0.0, 1.0, 0.0);

    float sizeMultiplier = uParticleSize * vSizeScale;
    float stretchedY = position.y * (1.0 + uStreakLength);

    vec3 billboardPos = particlePos + right * position.x * sizeMultiplier + up * stretchedY * sizeMultiplier;

    gl_Position = viewProjection * vec4(billboardPos, 1.0);
    vUV = uv;

    vec3 boxPos = relPos / uBoxSize;
    float edgeFade = 1.0 - smoothstep(0.3, 0.5, max(max(abs(boxPos.x), abs(boxPos.y)), abs(boxPos.z)));
    float distToCamera = length(relPos);
    float distFade = smoothstep(2.0, 10.0, distToCamera);

    vAlpha = edgeFade * (0.7 + distFade * 0.3);
}
`;

const precipFragmentShader = `
precision highp float;

varying vec2 vUV;
varying float vAlpha;
varying float vSizeScale;

uniform vec4 uColor;
uniform float uPrecipitationType;

float snowParticle(vec2 uv) {
    float dist = length(uv);
    return smoothstep(0.5, 0.0, dist);
}

float rainStreak(vec2 uv) {
    float taper = mix(0.04, 0.06, uv.y + 0.5);
    float streak = smoothstep(taper, taper * 0.3, abs(uv.x));
    float gradient = smoothstep(-0.5, 0.4, uv.y);
    streak *= gradient;
    streak *= smoothstep(0.5, 0.35, uv.y);
    return streak * 0.4;
}

void main() {
    vec2 center = vUV - 0.5;
    float alpha = 0.0;
    vec3 color = uColor.rgb;

    if (uPrecipitationType < 0.5) {
        alpha = rainStreak(center);
        color = mix(uColor.rgb, vec3(0.6, 0.65, 0.7), 0.3);
    } else {
        float particleScale = 0.4 + vSizeScale * 0.3;
        vec2 scaledUV = center / particleScale;
        alpha = snowParticle(scaledUV) * 0.6;
    }

    alpha *= vAlpha;
    if (alpha < 0.01) discard;

    gl_FragColor = vec4(color, uColor.a * alpha);
}
`;

// ============================================
// Weather Presets
// ============================================

interface WeatherConfig {
  cloudCoverage: number;
  precipitationIntensity: number;
  fogDensity: number;
}

const WEATHER_PRESETS: Record<WeatherPreset, WeatherConfig> = {
  clear: { cloudCoverage: 0.2, precipitationIntensity: 0, fogDensity: 0.005 },
  cloudy: { cloudCoverage: 0.6, precipitationIntensity: 0, fogDensity: 0.01 },
  rainy: { cloudCoverage: 0.85, precipitationIntensity: 0.7, fogDensity: 0.02 },
  stormy: { cloudCoverage: 0.95, precipitationIntensity: 1.0, fogDensity: 0.03 },
  snowy: { cloudCoverage: 0.75, precipitationIntensity: 0.6, fogDensity: 0.015 },
};

// ============================================
// SkyWeatherRenderer Class
// ============================================

let shaderCounter = 0;

export interface SkyWeatherOptions {
  skyRadius?: number;
  precipitationParticleCount?: number;
}

const DEFAULT_OPTIONS: Required<SkyWeatherOptions> = {
  skyRadius: 1000,
  precipitationParticleCount: 4000,
};

export class SkyWeatherRenderer {
  private scene: Scene;
  private options: Required<SkyWeatherOptions>;

  // Sky
  private skyMesh: Mesh | null = null;
  private skyMaterial: ShaderMaterial | null = null;

  // Precipitation
  private precipMesh: Mesh | null = null;
  private precipMaterial: ShaderMaterial | null = null;

  // State
  private weather: WeatherData;
  private sunDirection: Vector3 = new Vector3(0.5, 0.8, 0.3).normalize();
  private sunColor: Color3 = new Color3(1.0, 0.95, 0.85);
  private windOffset: Vector2 = new Vector2(0, 0);
  private nightFactor: number = 0;

  // Animation
  private renderObserver: Observer<Scene> | null = null;
  private startTime: number = 0;
  private animating: boolean = false;

  constructor(scene: Scene, options: SkyWeatherOptions = {}) {
    this.scene = scene;
    this.options = { ...DEFAULT_OPTIONS, ...options };

    // Default weather
    this.weather = {
      timeOfDay: 12,
      weatherPreset: "clear",
      cloudCoverage: 0.3,
      precipitationIntensity: 0,
      windSpeed: 0.2,
      windDirection: 45,
      fogDensity: 0.008,
    };

    this.registerShaders();
    this.createSky();
  }

  private registerShaders(): void {
    const id = ++shaderCounter;
    Effect.ShadersStore[`gameSky${id}VertexShader`] = skyVertexShader;
    Effect.ShadersStore[`gameSky${id}FragmentShader`] = skyFragmentShader;
    Effect.ShadersStore[`gamePrecip${id}VertexShader`] = precipVertexShader;
    Effect.ShadersStore[`gamePrecip${id}FragmentShader`] = precipFragmentShader;
  }

  private createSky(): void {
    const id = shaderCounter;

    // Create sky dome
    this.skyMesh = MeshBuilder.CreateSphere(
      "gameSky",
      { diameter: this.options.skyRadius * 2, segments: 32 },
      this.scene
    );
    this.skyMesh.infiniteDistance = true;
    this.skyMesh.isPickable = false;

    // Create material
    this.skyMaterial = new ShaderMaterial(
      `gameSkyMat_${id}`,
      this.scene,
      { vertex: `gameSky${id}`, fragment: `gameSky${id}` },
      {
        attributes: ["position"],
        uniforms: [
          "worldViewProjection",
          "uSunDirection",
          "uSunColor",
          "uCloudCoverage",
          "uNightFactor",
          "uWindOffset",
          "uCloudTime",
        ],
      }
    );

    this.skyMaterial.backFaceCulling = false;
    this.skyMaterial.disableDepthWrite = true;
    this.skyMesh.material = this.skyMaterial;

    this.updateSkyUniforms();
  }

  private createPrecipitation(): void {
    if (this.precipMesh) {
      this.precipMesh.dispose();
      this.precipMesh = null;
    }
    if (this.precipMaterial) {
      this.precipMaterial.dispose();
      this.precipMaterial = null;
    }

    if (this.weather.precipitationIntensity <= 0) return;

    const id = shaderCounter;
    const isSnow = this.weather.weatherPreset === "snowy";
    const count = Math.floor(
      this.options.precipitationParticleCount * this.weather.precipitationIntensity
    );

    if (count === 0) return;

    // Create particle mesh
    const positions = new Float32Array(count * 4 * 3);
    const uvs = new Float32Array(count * 4 * 2);
    const seeds = new Float32Array(count * 4 * 3);
    const indices = new Uint32Array(count * 6);

    const quadPos = [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0];
    const quadUVs = [0, 0, 1, 0, 1, 1, 0, 1];

    for (let i = 0; i < count; i++) {
      const seedX = Math.random();
      const seedY = Math.random();
      const seedZ = Math.random();

      for (let v = 0; v < 4; v++) {
        const vIdx = (i * 4 + v) * 3;
        const uvIdx = (i * 4 + v) * 2;

        positions[vIdx] = quadPos[v * 3];
        positions[vIdx + 1] = quadPos[v * 3 + 1];
        positions[vIdx + 2] = quadPos[v * 3 + 2];

        uvs[uvIdx] = quadUVs[v * 2];
        uvs[uvIdx + 1] = quadUVs[v * 2 + 1];

        seeds[vIdx] = seedX;
        seeds[vIdx + 1] = seedY;
        seeds[vIdx + 2] = seedZ;
      }

      const iIdx = i * 6;
      const vBase = i * 4;
      indices[iIdx] = vBase;
      indices[iIdx + 1] = vBase + 1;
      indices[iIdx + 2] = vBase + 2;
      indices[iIdx + 3] = vBase;
      indices[iIdx + 4] = vBase + 2;
      indices[iIdx + 5] = vBase + 3;
    }

    this.precipMesh = new Mesh("gamePrecip", this.scene);
    this.precipMesh.isPickable = false;

    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.uvs = uvs;
    vertexData.indices = indices;
    vertexData.applyToMesh(this.precipMesh);

    this.precipMesh.setVerticesData("particleSeed", seeds, false, 3);

    // Create material
    this.precipMaterial = new ShaderMaterial(
      `gamePrecipMat_${id}`,
      this.scene,
      { vertex: `gamePrecip${id}`, fragment: `gamePrecip${id}` },
      {
        attributes: ["position", "uv", "particleSeed"],
        uniforms: [
          "viewProjection",
          "uTime",
          "uCameraPosition",
          "uWindDirection",
          "uWindSpeed",
          "uFallSpeed",
          "uBoxSize",
          "uStreakLength",
          "uParticleSize",
          "uColor",
          "uPrecipitationType",
        ],
        needAlphaBlending: true,
      }
    );

    this.precipMaterial.backFaceCulling = false;
    this.precipMaterial.alphaMode = Engine.ALPHA_ADD;

    // Set uniforms
    const boxSize = isSnow ? new Vector3(60, 30, 60) : new Vector3(60, 40, 60);
    this.precipMaterial.setFloat("uFallSpeed", isSnow ? 2.5 : 22);
    this.precipMaterial.setVector3("uBoxSize", boxSize);
    this.precipMaterial.setFloat("uStreakLength", isSnow ? 0 : 4.0);
    this.precipMaterial.setFloat("uParticleSize", isSnow ? 0.03 : 0.06);
    this.precipMaterial.setColor4(
      "uColor",
      isSnow ? new Color4(0.95, 0.95, 1.0, 0.7) : new Color4(0.5, 0.55, 0.6, 0.35)
    );
    this.precipMaterial.setFloat("uPrecipitationType", isSnow ? 1.0 : 0.0);

    const windRad = (this.weather.windDirection * Math.PI) / 180;
    this.precipMaterial.setVector3(
      "uWindDirection",
      new Vector3(Math.cos(windRad), 0, Math.sin(windRad))
    );
    this.precipMaterial.setFloat("uWindSpeed", this.weather.windSpeed);

    this.precipMesh.material = this.precipMaterial;
  }

  private updateSkyUniforms(): void {
    if (!this.skyMaterial) return;

    this.skyMaterial.setVector3("uSunDirection", this.sunDirection);
    this.skyMaterial.setColor3("uSunColor", this.sunColor);
    this.skyMaterial.setFloat("uCloudCoverage", this.weather.cloudCoverage);
    this.skyMaterial.setFloat("uNightFactor", this.nightFactor);
    this.skyMaterial.setVector2("uWindOffset", this.windOffset);
    this.skyMaterial.setFloat("uCloudTime", 0);
  }

  private updateTimeOfDay(): void {
    const hour = this.weather.timeOfDay;

    // Calculate sun position
    const sunProgress = (hour - 6) / 12;
    const sunAngle = sunProgress * Math.PI;
    const sunY = Math.sin(sunAngle);
    const sunXZ = Math.cos(sunAngle);

    this.sunDirection = new Vector3(sunXZ * 0.7, Math.max(0.05, sunY), sunXZ * 0.7).normalize();

    // Night factor
    if (hour < 6 || hour > 20) {
      this.nightFactor = 1.0;
    } else if (hour < 8) {
      this.nightFactor = 1.0 - (hour - 6) / 2;
    } else if (hour > 18) {
      this.nightFactor = (hour - 18) / 2;
    } else {
      this.nightFactor = 0;
    }

    // Sun color
    if (hour < 7 || hour > 18) {
      this.sunColor = new Color3(1.0, 0.5, 0.3);
    } else if (hour < 8 || hour > 17) {
      this.sunColor = new Color3(1.0, 0.8, 0.6);
    } else {
      this.sunColor = new Color3(1.0, 0.95, 0.85);
    }
  }

  // ============================================
  // Public API
  // ============================================

  setWeather(weather: WeatherData): void {
    this.weather = { ...weather };
    this.updateTimeOfDay();
    this.updateSkyUniforms();
    this.createPrecipitation();

    // Update fog
    if (this.scene.fogMode !== undefined) {
      this.scene.fogMode = 3; // Exponential fog
      this.scene.fogDensity = weather.fogDensity;
      this.scene.fogColor = new Color3(0.8, 0.85, 0.9);
    }
  }

  setTimeOfDay(hour: number): void {
    this.weather.timeOfDay = Math.max(0, Math.min(24, hour));
    this.updateTimeOfDay();
    this.updateSkyUniforms();
  }

  setWeatherPreset(preset: WeatherPreset): void {
    const config = WEATHER_PRESETS[preset];
    this.weather.weatherPreset = preset;
    this.weather.cloudCoverage = config.cloudCoverage;
    this.weather.precipitationIntensity = config.precipitationIntensity;
    this.weather.fogDensity = config.fogDensity;
    this.updateSkyUniforms();
    this.createPrecipitation();
  }

  startAnimation(): void {
    if (this.animating) return;

    this.animating = true;
    this.startTime = performance.now() / 1000;

    this.renderObserver = this.scene.onBeforeRenderObservable.add(() => {
      const time = performance.now() / 1000 - this.startTime;
      const deltaTime = this.scene.getEngine().getDeltaTime() / 1000;

      // Update wind offset
      const windRad = (this.weather.windDirection * Math.PI) / 180;
      const windX = Math.cos(windRad) * this.weather.windSpeed * deltaTime * 0.1;
      const windY = Math.sin(windRad) * this.weather.windSpeed * deltaTime * 0.1;
      this.windOffset.x += windX;
      this.windOffset.y += windY;

      if (this.skyMaterial) {
        this.skyMaterial.setVector2("uWindOffset", this.windOffset);
        this.skyMaterial.setFloat("uCloudTime", time);
      }

      if (this.precipMaterial) {
        this.precipMaterial.setFloat("uTime", time);
        const camera = this.scene.activeCamera;
        if (camera) {
          this.precipMaterial.setVector3("uCameraPosition", camera.position);
        }
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

  getSunDirection(): Vector3 {
    return this.sunDirection.clone();
  }

  dispose(): void {
    this.stopAnimation();

    if (this.skyMesh) {
      this.skyMesh.dispose();
      this.skyMesh = null;
    }
    if (this.skyMaterial) {
      this.skyMaterial.dispose();
      this.skyMaterial = null;
    }
    if (this.precipMesh) {
      this.precipMesh.dispose();
      this.precipMesh = null;
    }
    if (this.precipMaterial) {
      this.precipMaterial.dispose();
      this.precipMaterial = null;
    }
  }
}
