/**
 * SkyWeatherRenderer - Sky and weather rendering for game use (Three.js)
 *
 * Features:
 * - Procedural sky with atmospheric scattering
 * - Dynamic clouds
 * - Rain/snow precipitation effects
 * - Fog values exposed (caller applies to scene)
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
 * // In render loop:
 * sky.update(time, deltaTime, camera.position);
 * ```
 */

import * as THREE from "three";
import type { WeatherData, WeatherPreset } from "./types";

// ============================================
// Sky Shader (Three.js)
// ============================================

const skyVertexShader = `
varying vec3 vViewDirection;

void main() {
    vViewDirection = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
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
// Precipitation Shader (Three.js)
// ============================================

const precipVertexShader = `
attribute vec3 particleSeed;

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

    gl_Position = projectionMatrix * viewMatrix * vec4(billboardPos, 1.0);
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

export interface SkyWeatherOptions {
  skyRadius?: number;
  precipitationParticleCount?: number;
}

const DEFAULT_OPTIONS: Required<SkyWeatherOptions> = {
  skyRadius: 1000,
  precipitationParticleCount: 4000,
};

export class SkyWeatherRenderer {
  private scene: THREE.Scene;
  private options: Required<SkyWeatherOptions>;

  // Sky
  private skyMesh: THREE.Mesh | null = null;
  private skyGeometry: THREE.SphereGeometry | null = null;
  private skyMaterial: THREE.ShaderMaterial | null = null;

  // Precipitation
  private precipMesh: THREE.Mesh | null = null;
  private precipGeometry: THREE.BufferGeometry | null = null;
  private precipMaterial: THREE.ShaderMaterial | null = null;

  // State
  private weather: WeatherData;
  private sunDirection: THREE.Vector3 = new THREE.Vector3(0.5, 0.8, 0.3).normalize();
  private sunColor: THREE.Color = new THREE.Color(1.0, 0.95, 0.85);
  private windOffset: THREE.Vector2 = new THREE.Vector2(0, 0);
  private nightFactor: number = 0;

  // Fog (exposed for caller to apply)
  fogColor: THREE.Color = new THREE.Color(0.8, 0.85, 0.9);
  fogDensity: number = 0.008;

  constructor(scene: THREE.Scene, options: SkyWeatherOptions = {}) {
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

    this.createSky();
  }

  private createSky(): void {
    // Create sky dome
    this.skyGeometry = new THREE.SphereGeometry(
      this.options.skyRadius,
      32,
      32
    );

    this.skyMaterial = new THREE.ShaderMaterial({
      vertexShader: skyVertexShader,
      fragmentShader: skyFragmentShader,
      uniforms: {
        uSunDirection: { value: this.sunDirection.clone() },
        uSunColor: { value: this.sunColor.clone() },
        uCloudCoverage: { value: this.weather.cloudCoverage },
        uNightFactor: { value: this.nightFactor },
        uWindOffset: { value: this.windOffset.clone() },
        uCloudTime: { value: 0 },
      },
      side: THREE.BackSide,
      depthWrite: false,
    });

    this.skyMesh = new THREE.Mesh(this.skyGeometry, this.skyMaterial);
    this.skyMesh.renderOrder = -100;
    this.skyMesh.layers.set(1);
    this.scene.add(this.skyMesh);

    this.updateSkyUniforms();
  }

  private createPrecipitation(): void {
    // Dispose existing
    if (this.precipMesh) {
      this.scene.remove(this.precipMesh);
      this.precipMesh = null;
    }
    if (this.precipGeometry) {
      this.precipGeometry.dispose();
      this.precipGeometry = null;
    }
    if (this.precipMaterial) {
      this.precipMaterial.dispose();
      this.precipMaterial = null;
    }

    if (this.weather.precipitationIntensity <= 0) return;

    const isSnow = this.weather.weatherPreset === "snowy";
    const count = Math.floor(
      this.options.precipitationParticleCount * this.weather.precipitationIntensity
    );

    if (count === 0) return;

    // Create particle geometry
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

    this.precipGeometry = new THREE.BufferGeometry();
    this.precipGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.precipGeometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    this.precipGeometry.setAttribute("particleSeed", new THREE.BufferAttribute(seeds, 3));
    this.precipGeometry.setIndex(new THREE.BufferAttribute(indices, 1));

    // Precipitation uniforms
    const boxSize = isSnow ? new THREE.Vector3(60, 30, 60) : new THREE.Vector3(60, 40, 60);
    const windRad = (this.weather.windDirection * Math.PI) / 180;

    this.precipMaterial = new THREE.ShaderMaterial({
      vertexShader: precipVertexShader,
      fragmentShader: precipFragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uCameraPosition: { value: new THREE.Vector3() },
        uWindDirection: { value: new THREE.Vector3(Math.cos(windRad), 0, Math.sin(windRad)) },
        uWindSpeed: { value: this.weather.windSpeed },
        uFallSpeed: { value: isSnow ? 2.5 : 22 },
        uBoxSize: { value: boxSize },
        uStreakLength: { value: isSnow ? 0 : 4.0 },
        uParticleSize: { value: isSnow ? 0.03 : 0.06 },
        uColor: {
          value: isSnow
            ? new THREE.Vector4(0.95, 0.95, 1.0, 0.7)
            : new THREE.Vector4(0.5, 0.55, 0.6, 0.35),
        },
        uPrecipitationType: { value: isSnow ? 1.0 : 0.0 },
      },
      side: THREE.DoubleSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.precipMesh = new THREE.Mesh(this.precipGeometry, this.precipMaterial);
    this.precipMesh.frustumCulled = false;
    this.precipMesh.layers.set(1);
    this.scene.add(this.precipMesh);
  }

  private updateSkyUniforms(): void {
    if (!this.skyMaterial) return;

    this.skyMaterial.uniforms.uSunDirection.value.copy(this.sunDirection);
    this.skyMaterial.uniforms.uSunColor.value.copy(this.sunColor);
    this.skyMaterial.uniforms.uCloudCoverage.value = this.weather.cloudCoverage;
    this.skyMaterial.uniforms.uNightFactor.value = this.nightFactor;
    this.skyMaterial.uniforms.uWindOffset.value.copy(this.windOffset);
    this.skyMaterial.uniforms.uCloudTime.value = 0;
  }

  private updateTimeOfDay(): void {
    const hour = this.weather.timeOfDay;

    // Calculate sun position
    const sunProgress = (hour - 6) / 12;
    const sunAngle = sunProgress * Math.PI;
    const sunY = Math.sin(sunAngle);
    const sunXZ = Math.cos(sunAngle);

    this.sunDirection = new THREE.Vector3(sunXZ * 0.7, Math.max(0.05, sunY), sunXZ * 0.7).normalize();

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
      this.sunColor = new THREE.Color(1.0, 0.5, 0.3);
    } else if (hour < 8 || hour > 17) {
      this.sunColor = new THREE.Color(1.0, 0.8, 0.6);
    } else {
      this.sunColor = new THREE.Color(1.0, 0.95, 0.85);
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

    // Expose fog values for caller
    this.fogDensity = weather.fogDensity;
    this.fogColor = new THREE.Color(0.8, 0.85, 0.9);
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

    // Expose fog values for caller
    this.fogDensity = config.fogDensity;
  }

  update(time: number, deltaTime: number, cameraPosition: THREE.Vector3): void {
    // Update wind offset
    const windRad = (this.weather.windDirection * Math.PI) / 180;
    const windX = Math.cos(windRad) * this.weather.windSpeed * deltaTime * 0.1;
    const windY = Math.sin(windRad) * this.weather.windSpeed * deltaTime * 0.1;
    this.windOffset.x += windX;
    this.windOffset.y += windY;

    // Sky follows camera (replaces infiniteDistance)
    if (this.skyMesh) {
      this.skyMesh.position.copy(cameraPosition);
    }

    if (this.skyMaterial) {
      this.skyMaterial.uniforms.uWindOffset.value.copy(this.windOffset);
      this.skyMaterial.uniforms.uCloudTime.value = time;
    }

    if (this.precipMaterial) {
      this.precipMaterial.uniforms.uTime.value = time;
      this.precipMaterial.uniforms.uCameraPosition.value.copy(cameraPosition);
    }
  }

  getSunDirection(): THREE.Vector3 {
    return this.sunDirection.clone();
  }

  dispose(): void {
    if (this.skyMesh) {
      this.scene.remove(this.skyMesh);
      this.skyMesh = null;
    }
    if (this.skyGeometry) {
      this.skyGeometry.dispose();
      this.skyGeometry = null;
    }
    if (this.skyMaterial) {
      this.skyMaterial.dispose();
      this.skyMaterial = null;
    }
    if (this.precipMesh) {
      this.scene.remove(this.precipMesh);
      this.precipMesh = null;
    }
    if (this.precipGeometry) {
      this.precipGeometry.dispose();
      this.precipGeometry = null;
    }
    if (this.precipMaterial) {
      this.precipMaterial.dispose();
      this.precipMaterial = null;
    }
  }
}
