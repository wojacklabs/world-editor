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
uniform float uNightFactor;

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

    // Night sky
    vec3 nightColor = vec3(0.01, 0.015, 0.03);
    skyColor = mix(skyColor, nightColor, uNightFactor);

    skyColor *= 1.15;

    gl_FragColor = vec4(skyColor, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

// ============================================
// Cloud Splat Shader (Three.js)
// ============================================

const cloudVertexShader = `
attribute vec3 aOffset;
attribute vec2 aScale;
attribute vec4 aColor;

varying vec2 vUV;
varying vec4 vColor;

void main() {
    vUV = position.xy * 1.5;
    vColor = aColor;

    vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);

    vec3 worldPos = aOffset
        + camRight * position.x * aScale.x
        + camUp * position.y * aScale.y;

    gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
}
`;

const cloudFragmentShader = `
precision highp float;

varying vec2 vUV;
varying vec4 vColor;

void main() {
    vec2 d = vUV;
    float alpha = exp(-dot(d, d) * 4.0) * vColor.a;
    if (alpha < 0.005) discard;
    gl_FragColor = vec4(vColor.rgb * alpha, alpha);
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

interface CloudSplat {
  x: number; y: number; z: number;
  width: number; height: number;
  baseBrightness: number;
}

export class SkyWeatherRenderer {
  private scene: THREE.Scene;
  private options: Required<SkyWeatherOptions>;

  // Lights
  private dirLight: THREE.DirectionalLight | null = null;
  private hemiLight: THREE.HemisphereLight | null = null;
  private ambLight: THREE.AmbientLight | null = null;

  // Sky
  private skyMesh: THREE.Mesh | null = null;
  private skyGeometry: THREE.SphereGeometry | null = null;
  private skyMaterial: THREE.ShaderMaterial | null = null;

  // Clouds
  private cloudMesh: THREE.Mesh | null = null;
  private cloudGeo: THREE.InstancedBufferGeometry | null = null;
  private cloudMaterial: THREE.ShaderMaterial | null = null;
  private cloudSplats: CloudSplat[] = [];
  private lastCloudCoverage = -1;

  // Precipitation
  private precipMesh: THREE.Mesh | null = null;
  private precipGeometry: THREE.BufferGeometry | null = null;
  private precipMaterial: THREE.ShaderMaterial | null = null;

  // State
  private weather: WeatherData;
  private sunDirection: THREE.Vector3 = new THREE.Vector3(0.5, 0.8, 0.3).normalize();
  private sunColor: THREE.Color = new THREE.Color(1.0, 0.95, 0.85);
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
    this.createDirectionalLight();
  }

  private createDirectionalLight(): void {
    this.dirLight = new THREE.DirectionalLight(0xffffff, 4.5);
    this.dirLight.position.copy(this.sunDirection);

    this.dirLight.castShadow = true;
    this.dirLight.shadow.mapSize.width = 2048;
    this.dirLight.shadow.mapSize.height = 2048;
    this.dirLight.shadow.bias = -0.0005;
    this.dirLight.shadow.normalBias = 0.02;

    const shadowSize = 80;
    this.dirLight.shadow.camera.left = -shadowSize;
    this.dirLight.shadow.camera.right = shadowSize;
    this.dirLight.shadow.camera.top = shadowSize;
    this.dirLight.shadow.camera.bottom = -shadowSize;
    this.dirLight.shadow.camera.near = 0.5;
    this.dirLight.shadow.camera.far = 200;

    this.dirLight.target.position.set(32, 0, 32);
    this.scene.add(this.dirLight);
    this.scene.add(this.dirLight.target);

    // Ambient lights matching editor
    this.hemiLight = new THREE.HemisphereLight(0xffffff, 0x4d4d59, 0.6);
    this.scene.add(this.hemiLight);

    this.ambLight = new THREE.AmbientLight(0xffffff, 3.5);
    this.scene.add(this.ambLight);
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
        uNightFactor: { value: this.nightFactor },
      },
      side: THREE.BackSide,
      depthWrite: false,
    });

    this.skyMesh = new THREE.Mesh(this.skyGeometry, this.skyMaterial);
    this.skyMesh.renderOrder = -100;
    this.skyMesh.layers.enableAll();
    this.scene.add(this.skyMesh);

    this.updateSkyUniforms();
  }

  private createClouds(): void {
    // Dispose existing
    if (this.cloudMesh) {
      this.scene.remove(this.cloudMesh);
      this.cloudMesh = null;
    }
    if (this.cloudGeo) {
      this.cloudGeo.dispose();
      this.cloudGeo = null;
    }
    if (this.cloudMaterial) {
      this.cloudMaterial.dispose();
      this.cloudMaterial = null;
    }

    const coverage = this.weather.cloudCoverage;
    if (coverage < 0.01) {
      this.cloudSplats = [];
      this.lastCloudCoverage = coverage;
      return;
    }

    const CLOUD_ALTITUDE = 250;
    const ALTITUDE_SPREAD = 40;
    const DOMAIN = 800;
    const CELL_SIZE = 80;
    const GRID = DOMAIN / CELL_SIZE; // 10

    // Deterministic hash
    const hash = (a: number, b: number) => {
      const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
      return n - Math.floor(n);
    };

    this.cloudSplats = [];
    for (let gx = 0; gx < GRID; gx++) {
      for (let gz = 0; gz < GRID; gz++) {
        if (hash(gx, gz) > coverage) continue;

        const cx = (gx + 0.5) * CELL_SIZE - DOMAIN * 0.5;
        const cz = (gz + 0.5) * CELL_SIZE - DOMAIN * 0.5;

        const splatsInCluster = 30 + Math.floor(hash(gx + 50, gz + 50) * 25); // 30~55
        for (let s = 0; s < splatsInCluster; s++) {
          const h1 = hash(gx * 100 + s, gz * 100 + s * 7);
          const h2 = hash(gz * 100 + s * 3, gx * 100 + s * 11);
          const h3 = hash(s * 17 + gx, s * 31 + gz);
          const h4 = hash(s * 41 + gz, s * 59 + gx);

          const spreadX = (h1 - 0.5) * CELL_SIZE * 0.8;
          const spreadZ = (h2 - 0.5) * CELL_SIZE * 0.8;
          const spreadY = (h3 - 0.5) * ALTITUDE_SPREAD;

          const width = 40 + h4 * 60;  // 40~100
          const height = width * (0.3 + h1 * 0.3); // flattened

          this.cloudSplats.push({
            x: cx + spreadX,
            y: CLOUD_ALTITUDE + spreadY,
            z: cz + spreadZ,
            width,
            height,
            baseBrightness: 0.8 + h3 * 0.4, // 0.8~1.2
          });
        }
      }
    }

    // Build instanced geometry
    const count = this.cloudSplats.length;
    const baseGeo = new THREE.PlaneGeometry(1, 1);

    this.cloudGeo = new THREE.InstancedBufferGeometry();
    this.cloudGeo.index = baseGeo.index;
    this.cloudGeo.attributes.position = baseGeo.attributes.position;
    this.cloudGeo.attributes.uv = baseGeo.attributes.uv;
    this.cloudGeo.instanceCount = count;

    const offsets = new Float32Array(count * 3);
    const scales = new Float32Array(count * 2);
    const colors = new Float32Array(count * 4);

    for (let i = 0; i < count; i++) {
      const sp = this.cloudSplats[i];
      offsets[i * 3] = sp.x;
      offsets[i * 3 + 1] = sp.y;
      offsets[i * 3 + 2] = sp.z;
      scales[i * 2] = sp.width;
      scales[i * 2 + 1] = sp.height;
      colors[i * 4] = 1;
      colors[i * 4 + 1] = 1;
      colors[i * 4 + 2] = 1;
      colors[i * 4 + 3] = 0.35;
    }

    this.cloudGeo.setAttribute("aOffset", new THREE.InstancedBufferAttribute(offsets, 3));
    this.cloudGeo.setAttribute("aScale", new THREE.InstancedBufferAttribute(scales, 2));
    this.cloudGeo.setAttribute("aColor", new THREE.InstancedBufferAttribute(colors, 4));

    this.cloudMaterial = new THREE.ShaderMaterial({
      vertexShader: cloudVertexShader,
      fragmentShader: cloudFragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });

    this.cloudMesh = new THREE.Mesh(this.cloudGeo, this.cloudMaterial);
    this.cloudMesh.frustumCulled = false;
    this.cloudMesh.renderOrder = -99;
    this.scene.add(this.cloudMesh);

    this.lastCloudCoverage = coverage;
  }

  private updateCloudSplats(deltaTime: number): void {
    if (!this.cloudGeo || this.cloudSplats.length === 0) return;

    const DOMAIN = 800;
    const HALF = DOMAIN * 0.5;

    // Wind drift
    const windRad = (this.weather.windDirection * Math.PI) / 180;
    const driftX = Math.cos(windRad) * this.weather.windSpeed * deltaTime * 5.0;
    const driftZ = Math.sin(windRad) * this.weather.windSpeed * deltaTime * 5.0;

    const offsetAttr = this.cloudGeo.getAttribute("aOffset") as THREE.InstancedBufferAttribute;
    const colorAttr = this.cloudGeo.getAttribute("aColor") as THREE.InstancedBufferAttribute;

    for (let i = 0; i < this.cloudSplats.length; i++) {
      const sp = this.cloudSplats[i];

      // Drift position
      sp.x += driftX;
      sp.z += driftZ;

      // Wrap around domain
      if (sp.x > HALF) sp.x -= DOMAIN;
      else if (sp.x < -HALF) sp.x += DOMAIN;
      if (sp.z > HALF) sp.z -= DOMAIN;
      else if (sp.z < -HALF) sp.z += DOMAIN;

      offsetAttr.setXYZ(i, sp.x, sp.y, sp.z);

      // Lighting
      const nx = sp.x / HALF;
      const nz = sp.z / HALF;
      const splatDir = Math.sqrt(nx * nx + nz * nz) > 0.001
        ? nx * this.sunDirection.x + nz * this.sunDirection.z
        : 0;
      const sunLit = 0.4 + 0.6 * (splatDir * 0.5 + 0.5);

      // Bottom darkening: lower Y within altitude spread is darker
      const yNorm = (sp.y - 210) / 80; // 0 at bottom, 1 at top of spread
      const baseDarken = 0.6 + 0.4 * Math.min(1, Math.max(0, yNorm));

      const nightDim = 1.0 - this.nightFactor * 0.7;
      const brightness = sunLit * baseDarken * nightDim * sp.baseBrightness;

      // Tint with sun color
      const r = Math.min(1, brightness * (0.85 + this.sunColor.r * 0.15));
      const g = Math.min(1, brightness * (0.85 + this.sunColor.g * 0.15));
      const b = Math.min(1, brightness * (0.85 + this.sunColor.b * 0.15));
      const alpha = 0.35 * sp.baseBrightness;

      colorAttr.setXYZW(i, r, g, b, alpha);
    }

    offsetAttr.needsUpdate = true;
    colorAttr.needsUpdate = true;
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
    this.precipMesh.layers.enableAll();
    this.scene.add(this.precipMesh);
  }

  private updateSkyUniforms(): void {
    if (!this.skyMaterial) return;

    this.skyMaterial.uniforms.uSunDirection.value.copy(this.sunDirection);
    this.skyMaterial.uniforms.uSunColor.value.copy(this.sunColor);
    this.skyMaterial.uniforms.uNightFactor.value = this.nightFactor;
  }

  private updateTimeOfDay(): void {
    const hour = this.weather.timeOfDay;

    // Calculate sun position
    const sunProgress = (hour - 6) / 12;
    const sunAngle = sunProgress * Math.PI;
    const sunY = Math.sin(sunAngle);
    const sunXZ = Math.cos(sunAngle);

    this.sunDirection = new THREE.Vector3(sunXZ * 0.7, Math.max(0.2, sunY), sunXZ * 0.7).normalize();

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

    // Scale lights by nightFactor
    const dayFactor = 1 - this.nightFactor;
    if (this.dirLight) {
      this.dirLight.intensity = 4.5 * dayFactor;
      this.dirLight.color.copy(this.sunColor);
    }
    if (this.hemiLight) {
      this.hemiLight.intensity = 0.6 * dayFactor + 0.05;
      const groundBrightness = 0.3 - this.nightFactor * 0.2;
      this.hemiLight.groundColor.setRGB(groundBrightness, groundBrightness, groundBrightness + 0.05);
    }
    if (this.ambLight) {
      this.ambLight.intensity = 3.5 * dayFactor + 0.2;
      const nightBlue = this.nightFactor * 0.15;
      this.ambLight.color.setRGB(1.0 - nightBlue, 1.0 - nightBlue * 0.5, 1.0 + nightBlue * 0.3);
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

    // Recreate clouds if coverage changed significantly
    if (Math.abs(this.weather.cloudCoverage - this.lastCloudCoverage) > 0.05) {
      this.createClouds();
    }

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

    // Recreate clouds if coverage changed significantly
    if (Math.abs(this.weather.cloudCoverage - this.lastCloudCoverage) > 0.05) {
      this.createClouds();
    }

    // Expose fog values for caller
    this.fogDensity = config.fogDensity;
  }

  update(time: number, deltaTime: number, cameraPosition: THREE.Vector3): void {
    // Sky follows camera (replaces infiniteDistance)
    if (this.skyMesh) {
      this.skyMesh.position.copy(cameraPosition);
    }

    // Cloud splats follow camera and animate
    if (this.cloudMesh) {
      this.cloudMesh.position.copy(cameraPosition);
      this.updateCloudSplats(deltaTime);
    }

    if (this.precipMaterial) {
      this.precipMaterial.uniforms.uTime.value = time;
      this.precipMaterial.uniforms.uCameraPosition.value.copy(cameraPosition);
    }

    // Sync directional light with sun direction
    if (this.dirLight) {
      this.dirLight.position.copy(this.sunDirection);
    }
  }

  getSunDirection(): THREE.Vector3 {
    return this.sunDirection.clone();
  }

  getDirectionalLight(): THREE.DirectionalLight | null {
    return this.dirLight;
  }

  /**
   * Enable shadow rendering on the WebGL renderer.
   * Must be called once after creating the renderer.
   */
  static enableShadows(renderer: THREE.WebGLRenderer): void {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }

  dispose(): void {
    if (this.dirLight) {
      this.scene.remove(this.dirLight);
      this.scene.remove(this.dirLight.target);
      this.dirLight.dispose();
      this.dirLight = null;
    }
    if (this.hemiLight) {
      this.scene.remove(this.hemiLight);
      this.hemiLight.dispose();
      this.hemiLight = null;
    }
    if (this.ambLight) {
      this.scene.remove(this.ambLight);
      this.ambLight.dispose();
      this.ambLight = null;
    }
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
    if (this.cloudMesh) {
      this.scene.remove(this.cloudMesh);
      this.cloudMesh = null;
    }
    if (this.cloudGeo) {
      this.cloudGeo.dispose();
      this.cloudGeo = null;
    }
    if (this.cloudMaterial) {
      this.cloudMaterial.dispose();
      this.cloudMaterial = null;
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
