/**
 * FoliageRenderer - Independent foliage rendering for Three.js
 *
 * Features:
 * - No editor logic dependency (Heightmap, SplatMap, dirty flags)
 * - Accepts pre-computed foliage data from WorldLoader
 * - Chunk-based InstancedMesh management
 * - Simple built-in meshes (can be customized)
 *
 * Usage:
 * ```typescript
 * import { WorldLoader, FoliageRenderer } from "@world-editor/loader";
 *
 * const result = WorldLoader.loadWorld(json);
 * const tile = result.data!.mainTile!;
 *
 * const renderer = new FoliageRenderer(scene);
 * renderer.loadTile(tile.foliage);
 * ```
 */

import * as THREE from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import type { FoliageRendererOptions } from "./types";
import { DEFAULT_FOLIAGE_QUALITY_PROFILE } from "../shared/foliage/FoliageQualityProfile";
import { fbm3D, noise3D } from "../shared/math/NoiseUtils";

// ============================================
// Grass Vertex Shader
// Three.js InstancedMesh auto-injects: instanceMatrix, modelMatrix, viewMatrix, projectionMatrix
// ============================================

const grassVertexShader = `
uniform float uTime;
uniform float uWindStrength;
uniform float uWindScale;
uniform float uWindSecondaryStrength;
uniform float uWindMacroSpeed;
uniform float uWindMicroSpeed;
uniform float uBladeThickness;
uniform vec2 uWindDirection;
uniform vec3 uCameraPosition;
uniform float uLodFar;
uniform float uVariationStrength;

uniform vec3 uGrassBaseColor;
uniform vec3 uGrassTopColor;

uniform sampler2D uWindTexture;
uniform float uWindTextureScale;

#define GRASS_SEGMENTS 4
#define GRASS_VERTICES 10
#define GRASS_WIDTH 0.15
#define GRASS_HEIGHT 1.15

varying vec3 vNormal;
varying vec3 vColor;
varying float vHeight;
varying vec3 vWorldPosition;
varying float vVariation;
varying float vGrassX;
varying float vHeightPercent;

float easeOut(float x, float t) {
    float clamped = clamp(1.0 - x, 0.0, 1.0);
    return 1.0 - pow(clamped, t);
}

float hash2D(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise2D(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash2D(i);
    float b = hash2D(i + vec2(1.0, 0.0));
    float c = hash2D(i + vec2(0.0, 1.0));
    float d = hash2D(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm2D(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 3; i++) {
        value += amplitude * noise2D(p);
        p = p * 2.02 + vec2(13.1, 7.7);
        amplitude *= 0.5;
    }
    return value;
}

vec3 bezier(vec3 P0, vec3 P1, vec3 P2, vec3 P3, float t) {
    float mt = 1.0 - t;
    return mt*mt*mt*P0 + 3.0*mt*mt*t*P1 + 3.0*mt*t*t*P2 + t*t*t*P3;
}

vec3 bezierGrad(vec3 P0, vec3 P1, vec3 P2, vec3 P3, float t) {
    float mt = 1.0 - t;
    return 3.0*mt*mt*(P1-P0) + 6.0*mt*t*(P2-P1) + 3.0*t*t*(P3-P2);
}

mat3 rotateY(float theta) {
    float c = cos(theta);
    float s = sin(theta);
    return mat3(vec3(c, 0, s), vec3(0, 1, 0), vec3(-s, 0, c));
}

mat3 rotateAxis(vec3 axis, float angle) {
    float s = sin(angle);
    float c = cos(angle);
    float oc = 1.0 - c;
    return mat3(
        oc*axis.x*axis.x+c,         oc*axis.x*axis.y-axis.z*s, oc*axis.z*axis.x+axis.y*s,
        oc*axis.x*axis.y+axis.z*s,  oc*axis.y*axis.y+c,        oc*axis.y*axis.z-axis.x*s,
        oc*axis.z*axis.x-axis.y*s,  oc*axis.y*axis.z+axis.x*s, oc*axis.z*axis.z+c
    );
}

void main() {
    // Extract instance position from instanceMatrix (Three.js auto-injected)
    vec3 grassBase = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);

    float heightPercent = position.y / GRASS_HEIGHT;
    float xSide = step(0.0, position.x);
    float zSide = -1.0;

    float cameraHeight = max(0.0, uCameraPosition.y - 10.0);
    float heightBonus = cameraHeight * 1.5;
    float effectiveLodFar = uLodFar + heightBonus;

    float distanceToCamera = length(grassBase.xz - uCameraPosition.xz);
    float distanceRatio = distanceToCamera / effectiveLodFar;
    float lodScale = 1.0;
    float variation = (hash2D(grassBase.xz * 0.12) - 0.5) * uVariationStrength;

    float randomHeight = (hash2D(grassBase.xz * 0.19) * 2.0 - 1.0) * 0.2;

    float grassHeight = 1.0;
    float bladeWidth = GRASS_WIDTH * easeOut(1.08 - heightPercent, 2.0) * grassHeight;
    float bladeHeight = GRASS_HEIGHT * grassHeight + randomHeight;

    float x = position.x;

    float windScaleAtten = 1.0 - smoothstep(0.6, 0.9, distanceRatio);
    float heightWindAtten = 1.0 / (1.0 + cameraHeight * 0.03);
    vec2 windDir = normalize(uWindDirection);

    vec2 windUV = grassBase.xz * 0.035 + windDir * uTime * 0.1;
    float windNoise = texture2D(uWindTexture, windUV).r * 2.0 - 1.0;
    vec2 flutterUV = grassBase.xz * 0.08 + windDir * uTime * 0.15;
    float flutter = texture2D(uWindTexture, flutterUV).r * 0.15;
    float combinedWind = windNoise + flutter;

    float baseLean = (hash2D(grassBase.xz * 0.31) - 0.5) * 0.4;

    float windStrengthNorm = combinedWind * uWindStrength * windScaleAtten * heightWindAtten;
    float leanAnimation = windStrengthNorm * 0.5;
    float leanFactor = baseLean + leanAnimation;

    float angle = (hash2D(grassBase.xz * 0.23) - 0.5) * 1.5708;

    float windAngle = 0.6;
    vec3 windAxis = vec3(cos(windAngle), 0.0, sin(windAngle));
    float windLeanAngle = windStrengthNorm * heightPercent;

    vec3 p0 = vec3(0.0, 0.0, 0.0);
    vec3 p1 = vec3(0.0, 0.33, 0.0);
    vec3 p2 = vec3(0.0, 0.66, 0.0);
    vec3 p3 = vec3(0.0, cos(leanFactor), sin(leanFactor));

    vec3 curvePoint = bezier(p0, p1, p2, p3, heightPercent);
    vec3 curveGrad = bezierGrad(p0, p1, p2, p3, heightPercent);

    float y = curvePoint.y * bladeHeight;
    float z = curvePoint.z * bladeHeight;

    mat3 grassMat = rotateAxis(windAxis, windLeanAngle) * rotateY(angle);
    vec3 grassLocalPosition = grassMat * vec3(x, y, z);

    mat2 curveRot90 = mat2(0.0, 1.0, -1.0, 0.0) * -zSide;
    vec3 grassLocalNormal = grassMat * vec3(0.0, curveRot90 * curveGrad.yz);

    vec3 finalPos = grassBase + grassLocalPosition * lodScale;

    vec3 viewDir = normalize(uCameraPosition - grassBase);
    vec3 grassFaceNormal = grassMat * vec3(0.0, 0.0, -zSide);
    float viewDotNormal = clamp(dot(grassFaceNormal, viewDir), 0.0, 1.0);
    float viewSpaceThickenFactor = easeOut(1.0 - viewDotNormal, 4.0) * smoothstep(0.0, 0.2, viewDotNormal);

    vec3 viewRight = cross(vec3(0.0, 1.0, 0.0), viewDir);
    if (length(viewRight) < 0.0001) {
        viewRight = vec3(1.0, 0.0, 0.0);
    } else {
        viewRight = normalize(viewRight);
    }
    finalPos += viewRight * viewSpaceThickenFactor * (xSide - 0.5) * bladeWidth * 0.5 * -zSide * lodScale;

    vWorldPosition = finalPos;
    vHeight = heightPercent * bladeHeight * lodScale * (1.0 + variation * 0.15);
    vVariation = variation;

    gl_Position = projectionMatrix * viewMatrix * vec4(finalPos, 1.0);

    float distanceBlend = smoothstep(0.0, 10.0, distanceToCamera);
    vec3 blendedNormal = mix(grassLocalNormal, vec3(0.0, 1.0, 0.0), distanceBlend * 0.5);
    vNormal = normalize(blendedNormal);

    vColor = mix(uGrassBaseColor, uGrassTopColor, heightPercent);
    vGrassX = x;
    vHeightPercent = heightPercent;
}
`;

const grassFragmentShader = `
precision highp float;

varying vec3 vNormal;
varying vec3 vColor;
varying float vHeight;
varying vec3 vWorldPosition;
varying float vVariation;
varying float vGrassX;
varying float vHeightPercent;

uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uAmbient;
uniform vec3 uCameraPosition;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFadeStart;
uniform float uFadeEnd;
uniform float uDitherPixelSize;
uniform int uDitherMode;

float hash3D(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

float noise3D(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash3D(i);
    float n100 = hash3D(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash3D(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash3D(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash3D(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash3D(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash3D(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash3D(i + vec3(1.0, 1.0, 1.0));
    vec4 n_z0 = vec4(n000, n100, n010, n110);
    vec4 n_z1 = vec4(n001, n101, n011, n111);
    vec4 n_zz = mix(n_z0, n_z1, f.z);
    vec2 n_y = mix(n_zz.xy, n_zz.zw, f.y);
    return mix(n_y.x, n_y.y, f.x);
}

float fbm(vec3 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 3; i++) {
        value += amplitude * noise3D(p);
        p *= 2.0;
        amplitude *= 0.5;
    }
    return value;
}

vec3 hemiLight(vec3 normal, vec3 groundColor, vec3 skyColor) {
    return mix(groundColor, skyColor, 0.5 * normal.y + 0.5);
}

float hash2D(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float getDiamondThreshold(vec2 fragCoord, float pixelSize) {
    vec2 uv = mod(fragCoord + 0.01, pixelSize);
    vec2 centered = (uv / pixelSize) * 2.0 - 1.0;
    float dist = abs(centered.x) + abs(centered.y);
    return clamp(dist * 0.5, 0.0, 1.0);
}

float getBayer4Threshold(vec2 fragCoord, float pixelSize) {
    vec2 pixelCoord = floor(fragCoord / max(pixelSize, 1.0));
    float x = mod(pixelCoord.x, 4.0);
    float y = mod(pixelCoord.y, 4.0);

    float idx = 0.0;
    if (y < 0.5) {
        if (x < 0.5) idx = 0.0;
        else if (x < 1.5) idx = 8.0;
        else if (x < 2.5) idx = 2.0;
        else idx = 10.0;
    } else if (y < 1.5) {
        if (x < 0.5) idx = 12.0;
        else if (x < 1.5) idx = 4.0;
        else if (x < 2.5) idx = 14.0;
        else idx = 6.0;
    } else if (y < 2.5) {
        if (x < 0.5) idx = 3.0;
        else if (x < 1.5) idx = 11.0;
        else if (x < 2.5) idx = 1.0;
        else idx = 9.0;
    } else {
        if (x < 0.5) idx = 15.0;
        else if (x < 1.5) idx = 7.0;
        else if (x < 2.5) idx = 13.0;
        else idx = 5.0;
    }

    return (idx + 0.5) / 16.0;
}

float sampleDitherThreshold(vec2 fragCoord) {
    if (uDitherMode == 0) {
        return getDiamondThreshold(fragCoord, max(uDitherPixelSize, 1.0));
    }
    if (uDitherMode == 1) {
        return getBayer4Threshold(fragCoord, max(uDitherPixelSize, 1.0));
    }
    return hash2D(fragCoord + vWorldPosition.xz * 2.7);
}

void main() {
    vec3 normal = normalize(vNormal);
    vec3 viewDir = normalize(uCameraPosition - vWorldPosition);

    vec3 skyColor = vec3(1.0, 1.0, 0.75);
    vec3 groundColor = vec3(0.05, 0.05, 0.25);
    vec3 ambientLighting = hemiLight(normal, groundColor, skyColor);

    vec3 lightDir = normalize(uSunDirection);
    float wrap = 0.5;
    float dotNL = clamp((dot(normal, lightDir) + wrap) / (1.0 + wrap), 0.0, 1.0);
    float backlight = clamp((dot(viewDir, -lightDir) + wrap) / (1.0 + wrap), 0.0, 1.0);
    vec3 scatter = vec3(pow(backlight, 2.0));
    vec3 diffuseLighting = (vec3(dotNL) + scatter) * uSunColor;

    vec3 lighting = (diffuseLighting * 0.2 + ambientLighting * 0.8) * uAmbient;

    vec3 color = vColor * lighting;

    float distanceToCamera = length(vWorldPosition - uCameraPosition);
    float fadeAlpha = 1.0 - smoothstep(uFadeStart, uFadeEnd, distanceToCamera);
    float dither = sampleDitherThreshold(gl_FragCoord.xy);
    if (dither > clamp(fadeAlpha, 0.0, 1.0)) discard;

    if (uFogDensity > 0.001) {
      float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * distanceToCamera * distanceToCamera);
      color = mix(color, uFogColor, clamp(fogFactor, 0.0, 1.0));
    }

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

// ============================================
// Helper: set vertex colors on BufferGeometry
// ============================================

function setGeometryVertexColor(
  geometry: THREE.BufferGeometry,
  r: number,
  g: number,
  b: number
): void {
  const posAttr = geometry.attributes.position;
  if (!posAttr) return;
  const count = posAttr.count;
  const colors = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    colors[i * 4] = r;
    colors[i * 4 + 1] = g;
    colors[i * 4 + 2] = b;
    colors[i * 4 + 3] = 1;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 4));
}

// ============================================
// Types
// ============================================

interface FoliageChunk {
  x: number;
  z: number;
  meshes: Map<string, THREE.InstancedMesh>;
  instanceCounts: Map<string, number>;
}

type NormalizedFoliageRendererOptions = {
  chunkSize: number;
  maxInstancesPerChunk: number;
  lodEnabled: boolean;
  lodDistances: { near: number; mid: number; far: number };
  renderingProfile?: {
    foliageProfileVersion: string;
    proceduralProfileVersion: string;
  };
  textureUrls?: {
    grass?: string;
    dirt?: string;
    rock?: string;
    sand?: string;
    leafAtlas?: string;
  };
};

// ============================================
// FoliageRenderer Class
// ============================================

export class FoliageRenderer {
  private scene: THREE.Scene;
  private options: NormalizedFoliageRendererOptions;

  private chunks: Map<string, FoliageChunk> = new Map();
  private baseGeometries: Map<string, THREE.BufferGeometry> = new Map();
  private baseMaterials: Map<string, THREE.Material> = new Map();

  private grassMaterial: THREE.ShaderMaterial | null = null;
  private rockMaterial: THREE.MeshStandardMaterial | null = null;
  private treeMaterial: THREE.MeshStandardMaterial | null = null;
  private flowerMaterial: THREE.MeshStandardMaterial | null = null;
  private bushMaterial: THREE.MeshStandardMaterial | null = null;

  private totalInstances: number = 0;

  private windNoiseTexture: THREE.DataTexture | null = null;
  private readonly WIND_TEXTURE_SIZE = 256;

  private frustum = new THREE.Frustum();
  private vpMatrix = new THREE.Matrix4();

  private terrainScale: number = 256;

  constructor(scene: THREE.Scene, options: FoliageRendererOptions = {}) {
    this.scene = scene;
    this.options = {
      chunkSize: options.chunkSize ?? 16,
      maxInstancesPerChunk: options.maxInstancesPerChunk ?? 5000,
      lodEnabled: options.lodEnabled ?? true,
      lodDistances: options.lodDistances ?? { near: 100, mid: 200, far: 450 },
      renderingProfile: options.renderingProfile,
      textureUrls: options.textureUrls,
    };

    this.createMaterials();
    this.createBaseGeometries();
  }

  // ============================================
  // Public API
  // ============================================

  loadTile(
    foliageData: Map<string, Float32Array>,
    offsetX: number = 0,
    offsetZ: number = 0
  ): void {
    for (const [typeName, matrices] of foliageData) {
      if (matrices.length === 0) continue;

      const offsetMatrices =
        offsetX !== 0 || offsetZ !== 0
          ? this.applyOffset(matrices, offsetX, offsetZ)
          : matrices;

      this.loadTypeInstances(typeName, offsetMatrices);
    }

    console.log(
      `[FoliageRenderer] Loaded ${this.totalInstances} instances in ${this.chunks.size} chunks`
    );
  }

  loadTileFromSerialized(
    foliageData: Record<string, string>,
    offsetX: number = 0,
    offsetZ: number = 0
  ): void {
    const decoded = new Map<string, Float32Array>();
    for (const [typeName, base64] of Object.entries(foliageData)) {
      decoded.set(typeName, this.decodeFloat32Array(base64));
    }
    this.loadTile(decoded, offsetX, offsetZ);
  }

  unloadChunk(chunkX: number, chunkZ: number): void {
    const key = `${chunkX}_${chunkZ}`;
    const chunk = this.chunks.get(key);
    if (!chunk) return;

    for (const mesh of chunk.meshes.values()) {
      this.totalInstances -= mesh.count;
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.chunks.delete(key);
  }

  /**
   * Update time uniform for wind animation. Call from render loop.
   */
  updateTime(time: number): void {
    if (this.grassMaterial) {
      this.grassMaterial.uniforms.uTime.value = time;
    }
  }

  /**
   * Update camera position uniform. Call from render loop.
   */
  updateCamera(cameraPosition: THREE.Vector3): void {
    if (this.grassMaterial) {
      this.grassMaterial.uniforms.uCameraPosition.value.copy(cameraPosition);
    }
  }

  /**
   * Update visibility based on camera (frustum culling).
   */
  updateVisibility(camera: THREE.Camera): void {
    if (!this.options.lodEnabled) return;

    const chunkSize = this.options.chunkSize;

    // Update frustum
    this.vpMatrix.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse
    );
    this.frustum.setFromProjectionMatrix(this.vpMatrix);

    const sphere = new THREE.Sphere();
    // Radius covers chunk diagonal + grass height headroom
    const radius = chunkSize * 0.7071 + 2;

    for (const [, chunk] of this.chunks) {
      const cx = (chunk.x + 0.5) * chunkSize;
      const cz = (chunk.z + 0.5) * chunkSize;

      sphere.center.set(cx, 0, cz);
      sphere.radius = radius;

      const visible = this.frustum.intersectsSphere(sphere);

      for (const mesh of chunk.meshes.values()) {
        mesh.visible = visible;
      }
    }
  }

  getTotalInstances(): number {
    return this.totalInstances;
  }

  getChunkCount(): number {
    return this.chunks.size;
  }

  getStats(): { chunks: number; instances: number; types: string[] } {
    const types = new Set<string>();
    for (const chunk of this.chunks.values()) {
      for (const typeName of chunk.meshes.keys()) {
        types.add(typeName);
      }
    }
    return {
      chunks: this.chunks.size,
      instances: this.totalInstances,
      types: Array.from(types),
    };
  }

  setBaseMesh(typeName: string, geometry: THREE.BufferGeometry): void {
    this.baseGeometries.set(typeName, geometry);
  }

  setSunDirection(direction: THREE.Vector3): void {
    if (this.grassMaterial) {
      this.grassMaterial.uniforms.uSunDirection.value.copy(
        direction.clone().normalize()
      );
    }
  }

  setAmbient(value: number): void {
    if (this.grassMaterial) {
      this.grassMaterial.uniforms.uAmbient.value = value;
    }
  }

  setFog(color: THREE.Color, density: number): void {
    if (this.grassMaterial) {
      this.grassMaterial.uniforms.uFogColor.value.copy(color);
      this.grassMaterial.uniforms.uFogDensity.value = density;
    }
  }

  setWindStrength(strength: number): void {
    if (this.grassMaterial) {
      this.grassMaterial.uniforms.uWindStrength.value = strength;
    }
  }

  dispose(): void {
    for (const chunk of this.chunks.values()) {
      for (const mesh of chunk.meshes.values()) {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
      }
    }
    this.chunks.clear();
    this.totalInstances = 0;

    for (const geo of this.baseGeometries.values()) {
      geo.dispose();
    }
    this.baseGeometries.clear();

    this.grassMaterial?.dispose();
    this.rockMaterial?.dispose();
    this.treeMaterial?.dispose();
    this.flowerMaterial?.dispose();
    this.bushMaterial?.dispose();
    this.grassMaterial = null;
    this.rockMaterial = null;
    this.treeMaterial = null;
    this.flowerMaterial = null;
    this.bushMaterial = null;

    if (this.windNoiseTexture) {
      this.windNoiseTexture.dispose();
      this.windNoiseTexture = null;
    }
  }

  // ============================================
  // Private Methods
  // ============================================

  private createMaterials(): void {
    this.createWindTexture();

    const prof = DEFAULT_FOLIAGE_QUALITY_PROFILE;

    this.grassMaterial = new THREE.ShaderMaterial({
      vertexShader: grassVertexShader,
      fragmentShader: grassFragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uWindStrength: { value: prof.wind.biomeGrassStrength },
        uWindScale: { value: prof.grass.windScale },
        uWindSecondaryStrength: { value: prof.grass.windSecondaryStrength },
        uWindMacroSpeed: { value: prof.wind.grassMacroSpeed },
        uWindMicroSpeed: { value: prof.wind.grassMicroSpeed },
        uBladeThickness: { value: prof.grass.bladeThickness },
        uWindDirection: {
          value: new THREE.Vector2(
            Math.cos(prof.wind.directionRadians),
            Math.sin(prof.wind.directionRadians)
          ),
        },
        uCameraPosition: { value: new THREE.Vector3(0, 10, 0) },
        uLodFar: { value: this.options.lodDistances.far },
        uVariationStrength: { value: prof.fade.biomeVariationStrength },
        uFadeStart: { value: prof.fade.biomeGrassFadeStart },
        uFadeEnd: { value: prof.fade.biomeGrassFadeEnd },
        uDitherPixelSize: { value: prof.grass.ditherPixelSize },
        uDitherMode: { value: prof.grass.ditherMode },
        uGrassBaseColor: { value: new THREE.Color(57 / 255, 108 / 255, 24 / 255) },
        uGrassTopColor: { value: new THREE.Color(119 / 255, 170 / 255, 26 / 255) },
        uSunDirection: { value: new THREE.Vector3(-0.5, 0.8, -0.3).normalize() },
        uSunColor: { value: new THREE.Color(1.0, 0.95, 0.85) },
        uAmbient: { value: 0.4 },
        uFogColor: { value: new THREE.Color(0.55, 0.7, 0.9) },
        uFogDensity: { value: 0.008 },
        uWindTexture: { value: this.windNoiseTexture },
        uWindTextureScale: { value: this.terrainScale },
      },
      side: THREE.DoubleSide,
    });

    this.baseMaterials.set("grass", this.grassMaterial);

    this.rockMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0.5, 0.48, 0.45),
      roughness: 0.85,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });
    this.baseMaterials.set("rock", this.rockMaterial);
    this.baseMaterials.set("pebble", this.rockMaterial);

    this.treeMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color(1, 1, 1),
      roughness: 0.8,
      side: THREE.DoubleSide,
      vertexColors: true,
    });
    this.baseMaterials.set("tree", this.treeMaterial);

    this.flowerMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color(1, 1, 1),
      roughness: 0.7,
      side: THREE.DoubleSide,
      vertexColors: true,
    });
    this.baseMaterials.set("flower", this.flowerMaterial);

    this.bushMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color(1, 1, 1),
      roughness: 0.8,
      side: THREE.DoubleSide,
      vertexColors: true,
    });
    this.baseMaterials.set("bush", this.bushMaterial);
  }

  private createWindTexture(): void {
    const size = this.WIND_TEXTURE_SIZE;
    const data = new Uint8Array(size * size * 4);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const nx = x / size;
        const ny = y / size;

        let value = 0;
        let amplitude = 0.5;
        let frequency = 1;
        const px = nx * 4;
        const py = ny * 4;

        for (let i = 0; i < 3; i++) {
          const noiseVal = this.tileableNoise2D(
            px * frequency,
            py * frequency,
            4
          );
          value += amplitude * noiseVal;
          frequency *= 2.02;
          amplitude *= 0.5;
        }

        const byteVal = Math.floor(Math.min(1, value) * 255);
        const idx = (y * size + x) * 4;
        data[idx] = byteVal;
        data[idx + 1] = byteVal;
        data[idx + 2] = byteVal;
        data[idx + 3] = 255;
      }
    }

    this.windNoiseTexture = new THREE.DataTexture(
      data,
      size,
      size,
      THREE.RGBAFormat
    );
    this.windNoiseTexture.wrapS = THREE.RepeatWrapping;
    this.windNoiseTexture.wrapT = THREE.RepeatWrapping;
    this.windNoiseTexture.minFilter = THREE.LinearMipmapLinearFilter;
    this.windNoiseTexture.magFilter = THREE.LinearFilter;
    this.windNoiseTexture.generateMipmaps = true;
    this.windNoiseTexture.needsUpdate = true;
  }

  private tileableNoise2D(x: number, y: number, period: number): number {
    const ix = Math.floor(x) % period;
    const iy = Math.floor(y) % period;
    const fx = x - Math.floor(x);
    const fy = y - Math.floor(y);

    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);

    const n00 = this.hash2DVal(ix, iy);
    const n10 = this.hash2DVal((ix + 1) % period, iy);
    const n01 = this.hash2DVal(ix, (iy + 1) % period);
    const n11 = this.hash2DVal((ix + 1) % period, (iy + 1) % period);

    const nx0 = n00 * (1 - ux) + n10 * ux;
    const nx1 = n01 * (1 - ux) + n11 * ux;
    return nx0 * (1 - uy) + nx1 * uy;
  }

  private hash2DVal(x: number, y: number): number {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return n - Math.floor(n);
  }

  private createBaseGeometries(): void {
    // Grass blade
    const grassGeo = this.generateIsoscelesGrassBlade(2000);
    this.baseGeometries.set("grass", grassGeo);

    // Rock
    const rockGeo = this.generateProceduralRock(1000);
    this.baseGeometries.set("rock", rockGeo);

    // Tree
    const treeGeo = this.generateProceduralTree(3000);
    this.baseGeometries.set("tree", treeGeo);

    // Flower
    const flowerGeo = this.generateProceduralFlower(4000);
    this.baseGeometries.set("flower", flowerGeo);

    // Bush
    const bushGeo = this.generateProceduralBush(5000);
    this.baseGeometries.set("bush", bushGeo);

    // Pebble
    const pebbleGeo = new THREE.IcosahedronGeometry(0.15, 1);
    setGeometryVertexColor(pebbleGeo, 0.5, 0.5, 0.52);
    this.baseGeometries.set("pebble", pebbleGeo);
  }

  private generateIsoscelesGrassBlade(seed: number): THREE.BufferGeometry {
    const easeOut = (x: number, t: number): number => {
      const clamped = Math.max(0, Math.min(1, 1 - x));
      return 1 - Math.pow(clamped, t);
    };

    const GRASS_WIDTH = 0.15;
    const GRASS_HEIGHT = 1.15;
    const SEGMENTS = 4;

    const heightVar = 0.8 + Math.abs(noise3D(seed, 0, 0)) * 0.4;
    const bladeHeight = GRASS_HEIGHT * heightVar;

    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];

    for (let seg = 0; seg <= SEGMENTS; seg++) {
      const heightPercent = seg / SEGMENTS;
      const y = heightPercent * bladeHeight;
      const widthFactor = easeOut(1.08 - heightPercent, 2.0);
      const halfWidth = (GRASS_WIDTH * widthFactor) / 2;

      if (seg === SEGMENTS) {
        positions.push(0, y, 0);
        normals.push(0, 0, 1);
        colors.push(0.3, 0.4, 0.18, 1.0);
      } else {
        positions.push(-halfWidth, y, 0);
        normals.push(0, 0, 1);
        colors.push(0.3, 0.4, 0.18, 1.0);
        positions.push(halfWidth, y, 0);
        normals.push(0, 0, 1);
        colors.push(0.3, 0.4, 0.18, 1.0);
      }
    }

    for (let seg = 0; seg < SEGMENTS; seg++) {
      const vi = seg * 2;
      if (seg === SEGMENTS - 1) {
        const tipIndex = SEGMENTS * 2;
        indices.push(vi, vi + 1, tipIndex);
      } else {
        indices.push(vi, vi + 1, vi + 2);
        indices.push(vi + 2, vi + 1, vi + 3);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(positions), 3)
    );
    geometry.setAttribute(
      "normal",
      new THREE.BufferAttribute(new Float32Array(normals), 3)
    );
    geometry.setAttribute(
      "color",
      new THREE.BufferAttribute(new Float32Array(colors), 4)
    );
    geometry.setIndex(indices);

    return geometry;
  }

  private generateProceduralRock(seed: number): THREE.BufferGeometry {
    const geo = new THREE.IcosahedronGeometry(0.5, 4);

    const scaleX = 0.5 + Math.abs(noise3D(seed * 1.0, 0, 0)) * 1.2;
    const scaleY = 0.4 + Math.abs(noise3D(0, seed * 1.1, 0)) * 1.6;
    const scaleZ = 0.5 + Math.abs(noise3D(0, 0, seed * 1.2)) * 1.2;

    const taperY = noise3D(seed * 2.0, seed * 0.5, 0) * 0.7;
    const taperX = noise3D(seed * 2.1, 0, seed * 0.5) * 0.4;
    const taperZ = noise3D(0, seed * 2.2, seed * 0.6) * 0.4;

    const asymOffsetX = noise3D(seed * 3.0, seed * 0.3, 0) * 0.35;
    const asymOffsetY = noise3D(seed * 0.3, seed * 3.1, 0) * 0.25;
    const asymOffsetZ = noise3D(0, seed * 0.3, seed * 3.2) * 0.35;

    const twistAmount = noise3D(seed * 4.0, seed * 0.7, seed * 0.3) * 0.6;
    const bendX = noise3D(seed * 5.0, 0, 0) * 0.4;
    const bendZ = noise3D(0, 0, seed * 5.1) * 0.4;

    const posAttr = geo.attributes.position;
    for (let i = 0; i < posAttr.count; i++) {
      let x = posAttr.getX(i);
      let y = posAttr.getY(i);
      let z = posAttr.getZ(i);

      const len = Math.sqrt(x * x + y * y + z * z);
      const nx = x / len;
      const ny = y / len;
      const nz = z / len;

      x *= scaleX;
      y *= scaleY;
      z *= scaleZ;

      const taperFactorY = 1.0 - taperY * ny;
      const taperFactorX = 1.0 - taperX * nx;
      const taperFactorZ = 1.0 - taperZ * nz;
      x *= taperFactorY * taperFactorX;
      z *= taperFactorY * taperFactorZ;

      const twistAngle = twistAmount * ny;
      const cosT = Math.cos(twistAngle);
      const sinT = Math.sin(twistAngle);
      const rx = x * cosT - z * sinT;
      const rz = x * sinT + z * cosT;
      x = rx;
      z = rz;

      x += bendX * y * y;
      z += bendZ * y * y;

      x += asymOffsetX * (1.0 - Math.abs(ny));
      y += asymOffsetY;
      z += asymOffsetZ * (1.0 - Math.abs(ny));

      const surfaceNoise = fbm3D(nx * 3 + seed, ny * 3, nz * 3, 3);
      const surfaceDisp = surfaceNoise * 0.15;
      x += nx * surfaceDisp;
      y += ny * surfaceDisp;
      z += nz * surfaceDisp;

      posAttr.setXYZ(i, x, y, z);
    }

    geo.computeVertexNormals();
    setGeometryVertexColor(geo, 0.5, 0.5, 0.52);

    return geo;
  }

  private generateProceduralTree(seed: number): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];

    const trunkHeight = 1.0 + Math.abs(noise3D(seed, 0, 0)) * 0.5;
    const trunkRadius = 0.08 + Math.abs(noise3D(0, seed, 0)) * 0.04;

    const trunkGeo = new THREE.CylinderGeometry(
      trunkRadius * 1.5,
      trunkRadius * 2.5,
      trunkHeight,
      8
    );
    trunkGeo.translate(0, trunkHeight / 2, 0);
    setGeometryVertexColor(trunkGeo, 0.35, 0.22, 0.1);
    parts.push(trunkGeo);

    const foliageBaseY = trunkHeight * 0.7;
    const foliageLayers = 3;

    for (let i = 0; i < foliageLayers; i++) {
      const layerSeed = seed + i * 111;
      const layerHeight =
        0.6 + Math.abs(noise3D(layerSeed, 0, 0)) * 0.3;
      const layerRadius =
        0.5 - i * 0.12 + Math.abs(noise3D(0, layerSeed, 0)) * 0.15;
      const layerY = foliageBaseY + i * 0.35;

      const coneGeo = new THREE.CylinderGeometry(
        0,
        layerRadius,
        layerHeight,
        8
      );
      coneGeo.translate(0, layerY + layerHeight / 2, 0);
      setGeometryVertexColor(
        coneGeo,
        0.15 + i * 0.05,
        0.4 + i * 0.05,
        0.1
      );
      parts.push(coneGeo);
    }

    return BufferGeometryUtils.mergeGeometries(parts);
  }

  private generateProceduralFlower(seed: number): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];

    const stemHeight = 0.25 + Math.abs(noise3D(seed, 0, 0)) * 0.2;

    const stemGeo = new THREE.CylinderGeometry(0.01, 0.01, stemHeight, 6);
    stemGeo.translate(0, stemHeight / 2, 0);
    setGeometryVertexColor(stemGeo, 0.2, 0.5, 0.15);
    parts.push(stemGeo);

    const centerGeo = new THREE.SphereGeometry(0.03, 6, 6);
    centerGeo.translate(0, stemHeight + 0.03, 0);
    setGeometryVertexColor(centerGeo, 0.9, 0.8, 0.2);
    parts.push(centerGeo);

    const petalCount =
      5 + Math.floor(Math.abs(noise3D(0, seed, 0)) * 3);
    for (let i = 0; i < petalCount; i++) {
      const angle = (i / petalCount) * Math.PI * 2;
      const petalGeo = new THREE.CircleGeometry(0.05, 6);

      // Apply rotation and position manually via matrix
      const mat = new THREE.Matrix4();
      mat.makeRotationX(-Math.PI / 3);
      const rotY = new THREE.Matrix4().makeRotationY(angle);
      mat.premultiply(rotY);
      mat.setPosition(
        Math.cos(angle) * 0.04,
        stemHeight + 0.02,
        Math.sin(angle) * 0.04
      );
      petalGeo.applyMatrix4(mat);

      const r = 0.8 + Math.abs(noise3D(seed + i, 0, 0)) * 0.2;
      const g = 0.2 + Math.abs(noise3D(0, seed + i, 0)) * 0.3;
      const b = 0.3 + Math.abs(noise3D(0, 0, seed + i)) * 0.4;
      setGeometryVertexColor(petalGeo, r, g, b);
      parts.push(petalGeo);
    }

    // Ensure all parts have consistent index state (toNonIndexed)
    const nonIndexedParts = parts.map((g) => (g.index ? g.toNonIndexed() : g));
    return BufferGeometryUtils.mergeGeometries(nonIndexedParts);
  }

  private generateProceduralBush(seed: number): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];

    const mainGeo = new THREE.IcosahedronGeometry(0.4, 2);

    const posAttr = mainGeo.attributes.position;
    for (let i = 0; i < posAttr.count; i++) {
      let x = posAttr.getX(i);
      let y = posAttr.getY(i);
      let z = posAttr.getZ(i);

      const len = Math.sqrt(x * x + y * y + z * z);
      const noiseVal = fbm3D(x * 3 + seed, y * 3, z * 3, 2) * 0.15;

      x += (x / len) * noiseVal;
      y = y * 0.7 + (y / len) * noiseVal;
      z += (z / len) * noiseVal;

      posAttr.setXYZ(i, x, y, z);
    }

    mainGeo.computeVertexNormals();
    mainGeo.translate(0, 0.25, 0);
    setGeometryVertexColor(mainGeo, 0.15, 0.35, 0.1);
    parts.push(mainGeo);

    for (let i = 0; i < 5; i++) {
      const bumpSeed = seed + i * 77;
      const angle = (i / 5) * Math.PI * 2;
      const bumpGeo = new THREE.SphereGeometry(
        0.1 + Math.abs(noise3D(bumpSeed, 0, 0)) * 0.05,
        4,
        4
      );
      bumpGeo.translate(
        Math.cos(angle) * 0.25,
        0.2 + Math.abs(noise3D(0, bumpSeed, 0)) * 0.1,
        Math.sin(angle) * 0.25
      );
      setGeometryVertexColor(
        bumpGeo,
        0.12 + i * 0.02,
        0.32 + i * 0.02,
        0.08
      );
      parts.push(bumpGeo);
    }

    const normalizedBushParts = parts.map((g) => (g.index ? g.toNonIndexed() : g));
    return BufferGeometryUtils.mergeGeometries(normalizedBushParts);
  }

  private loadTypeInstances(typeName: string, matrices: Float32Array): void {
    const instanceCount = Math.floor(matrices.length / 16);
    if (instanceCount === 0) return;

    const chunkInstances = new Map<string, number[]>();
    const chunkSize = this.options.chunkSize;

    for (let i = 0; i < instanceCount; i++) {
      const baseIdx = i * 16;
      const worldX = matrices[baseIdx + 12];
      const worldZ = matrices[baseIdx + 14];

      const chunkX = Math.floor(worldX / chunkSize);
      const chunkZ = Math.floor(worldZ / chunkSize);
      const key = `${chunkX}_${chunkZ}`;

      if (!chunkInstances.has(key)) {
        chunkInstances.set(key, []);
      }

      for (let j = 0; j < 16; j++) {
        chunkInstances.get(key)!.push(matrices[baseIdx + j]);
      }
    }

    for (const [key, values] of chunkInstances) {
      const [cx, cz] = key.split("_").map(Number);
      const chunkMatrices = new Float32Array(values);
      this.createChunkMesh(cx, cz, typeName, chunkMatrices);
    }
  }

  private createChunkMesh(
    chunkX: number,
    chunkZ: number,
    typeName: string,
    matrices: Float32Array
  ): void {
    const key = `${chunkX}_${chunkZ}`;
    const instanceCount = Math.floor(matrices.length / 16);
    if (instanceCount === 0) return;

    let chunk = this.chunks.get(key);
    if (!chunk) {
      chunk = {
        x: chunkX,
        z: chunkZ,
        meshes: new Map(),
        instanceCounts: new Map(),
      };
      this.chunks.set(key, chunk);
    }

    const baseGeo = this.getBaseGeoForType(typeName);
    const baseMat = this.getBaseMaterialForType(typeName);
    if (!baseGeo || !baseMat) {
      console.warn(`[FoliageRenderer] No base mesh for type: ${typeName}`);
      return;
    }

    const instMesh = new THREE.InstancedMesh(
      baseGeo,
      baseMat,
      instanceCount
    );

    const mat4 = new THREE.Matrix4();
    for (let i = 0; i < instanceCount; i++) {
      mat4.fromArray(matrices, i * 16);
      instMesh.setMatrixAt(i, mat4);
    }
    instMesh.instanceMatrix.needsUpdate = true;

    // Shadow support: rocks cast shadows, all foliage receives
    const isRock = typeName.startsWith("rock");
    instMesh.castShadow = isRock;
    instMesh.receiveShadow = true;

    this.scene.add(instMesh);

    chunk.meshes.set(typeName, instMesh);
    chunk.instanceCounts.set(typeName, instanceCount);
    this.totalInstances += instanceCount;
  }

  private getBaseGeoForType(
    typeName: string
  ): THREE.BufferGeometry | undefined {
    if (this.baseGeometries.has(typeName)) {
      return this.baseGeometries.get(typeName);
    }

    const varMatch = typeName.match(/^(.+?)(_v\d+)?$/);
    if (varMatch) {
      const baseType = varMatch[1];
      if (this.baseGeometries.has(baseType)) {
        return this.baseGeometries.get(baseType);
      }
    }

    if (typeName.startsWith("grass")) return this.baseGeometries.get("grass");
    if (typeName.startsWith("rock") || typeName.startsWith("sandRock"))
      return this.baseGeometries.get("rock");
    if (typeName.startsWith("pebble"))
      return this.baseGeometries.get("pebble");
    if (typeName.startsWith("tree")) return this.baseGeometries.get("tree");
    if (typeName.startsWith("flower"))
      return this.baseGeometries.get("flower");
    if (typeName.startsWith("bush")) return this.baseGeometries.get("bush");
    if (typeName.startsWith("sand")) return this.baseGeometries.get("rock");

    return undefined;
  }

  private getBaseMaterialForType(
    typeName: string
  ): THREE.Material | undefined {
    if (this.baseMaterials.has(typeName)) {
      return this.baseMaterials.get(typeName);
    }

    if (typeName.startsWith("grass")) return this.baseMaterials.get("grass");
    if (typeName.startsWith("rock") || typeName.startsWith("sandRock"))
      return this.baseMaterials.get("rock");
    if (typeName.startsWith("pebble"))
      return this.baseMaterials.get("pebble");
    if (typeName.startsWith("tree")) return this.baseMaterials.get("tree");
    if (typeName.startsWith("flower"))
      return this.baseMaterials.get("flower");
    if (typeName.startsWith("bush")) return this.baseMaterials.get("bush");
    if (typeName.startsWith("sand")) return this.baseMaterials.get("rock");

    return undefined;
  }

  private applyOffset(
    matrices: Float32Array,
    offsetX: number,
    offsetZ: number
  ): Float32Array {
    const result = new Float32Array(matrices);
    const instanceCount = Math.floor(matrices.length / 16);

    for (let i = 0; i < instanceCount; i++) {
      const baseIdx = i * 16;
      result[baseIdx + 12] += offsetX;
      result[baseIdx + 14] += offsetZ;
    }

    return result;
  }

  private decodeFloat32Array(base64: string): Float32Array {
    const binary =
      typeof atob !== "undefined"
        ? atob(base64)
        : Buffer.from(base64, "base64").toString("binary");

    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Float32Array(bytes.buffer);
  }
}
