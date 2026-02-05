/**
 * TerrainRenderer - Independent terrain rendering for Three.js
 *
 * Features:
 * - No editor logic dependency (brushes, dirty flags, etc.)
 * - Accepts raw Float32Array data from WorldLoader
 * - LOD system with 3 levels
 * - Shader-based terrain rendering
 *
 * Usage:
 * ```typescript
 * import { WorldLoader, TerrainRenderer } from "@world-editor/loader";
 *
 * const result = WorldLoader.loadWorld(json);
 * const tile = result.data!.mainTile!;
 *
 * const renderer = new TerrainRenderer(scene);
 * renderer.create({
 *   heightmap: tile.heightmap,
 *   resolution: tile.resolution,
 *   splatmap: tile.splatmap,
 *   waterMask: tile.waterMask,
 *   size: tile.size,
 *   seaLevel: tile.seaLevel,
 * });
 * ```
 */

import * as THREE from "three";
import { createDataTexture } from "@/lib/shared/rendering/threeHelpers";
import type { TerrainRenderData, TerrainRendererOptions, TerrainTextureUrls } from "./types";

// ============================================
// Simplified Terrain Shader (inline)
// Three.js auto-injects: position, normal, uv, modelMatrix,
// modelViewMatrix, projectionMatrix, viewMatrix, normalMatrix
// ============================================

const terrainVertexShader = `
uniform float uTerrainSize;
uniform float uDispStrength;
uniform sampler2D uSplatMap;
uniform sampler2D uWaterMask;
uniform float uWaterLevel;

varying vec3 vPositionW;
varying vec3 vNormalW;
varying vec2 vUV;
varying vec4 vSplatWeights;
varying float vWaterMask;
varying float vHeight;

void main() {
    vec3 positionUpdated = position;

    // Sample splatmap
    vSplatWeights = texture2D(uSplatMap, uv);
    vWaterMask = texture2D(uWaterMask, uv).r;

    // World position
    vec4 worldPos = modelMatrix * vec4(positionUpdated, 1.0);
    vPositionW = worldPos.xyz;
    vHeight = positionUpdated.y;

    // Normal
    vNormalW = normalize((modelMatrix * vec4(normal, 0.0)).xyz);

    // UV
    vUV = uv;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(positionUpdated, 1.0);
}
`;

const terrainFragmentShader = `
precision highp float;

varying vec3 vPositionW;
varying vec3 vNormalW;
varying vec2 vUV;
varying vec4 vSplatWeights;
varying float vWaterMask;
varying float vHeight;

uniform vec3 uSunDirection;
uniform float uAmbientIntensity;
uniform float uWaterLevel;
uniform vec3 uCameraPosition;
uniform float uDebugMode;
uniform float uUseTextures;
uniform float uTileScale;
uniform vec3 uFogColor;
uniform float uFogDensity;

uniform sampler2D uGrassTexture;
uniform sampler2D uDirtTexture;
uniform sampler2D uRockTexture;
uniform sampler2D uSandTexture;

const vec3 grassColor = vec3(0.4, 0.6, 0.25);
const vec3 dirtColor = vec3(0.52, 0.42, 0.28);
const vec3 rockColor = vec3(0.48, 0.48, 0.5);
const vec3 sandColor = vec3(0.82, 0.72, 0.52);
const vec3 waterColor = vec3(0.1, 0.3, 0.5);

void main() {
    vec3 normal = normalize(vNormalW);

    if (uDebugMode > 0.5 && uDebugMode < 1.5) {
        gl_FragColor = vec4(vSplatWeights.rgb, 1.0);
        return;
    }
    if (uDebugMode > 1.5 && uDebugMode < 2.5) {
        gl_FragColor = vec4(normal * 0.5 + 0.5, 1.0);
        return;
    }
    if (uDebugMode > 2.5) {
        float h = clamp(vHeight / 20.0, 0.0, 1.0);
        gl_FragColor = vec4(h, h, h, 1.0);
        return;
    }

    vec3 baseColor;
    vec2 tiledUV = vUV * uTileScale;

    if (uUseTextures > 0.5) {
        vec3 grassSample = texture2D(uGrassTexture, tiledUV).rgb;
        vec3 dirtSample = texture2D(uDirtTexture, tiledUV).rgb;
        vec3 rockSample = texture2D(uRockTexture, tiledUV).rgb;
        vec3 sandSample = texture2D(uSandTexture, tiledUV).rgb;

        baseColor = grassSample * vSplatWeights.r +
                    dirtSample * vSplatWeights.g +
                    rockSample * vSplatWeights.b +
                    sandSample * vSplatWeights.a;
    } else {
        baseColor = grassColor * vSplatWeights.r +
                    dirtColor * vSplatWeights.g +
                    rockColor * vSplatWeights.b +
                    sandColor * vSplatWeights.a;
    }

    if (vWaterMask > 0.5) {
        baseColor = mix(baseColor, waterColor, 0.7);
    }

    float NdotL = max(dot(normal, normalize(uSunDirection)), 0.0);
    float diffuse = NdotL * 0.8 + uAmbientIntensity;

    vec3 color = baseColor * diffuse;

    float distanceToCamera = length(uCameraPosition - vPositionW);
    float distanceFog = 1.0 - exp(-uFogDensity * uFogDensity * distanceToCamera * distanceToCamera);

    float fogHeight = 10.0;
    float heightFog = clamp((fogHeight - vPositionW.y) / fogHeight, 0.0, 0.3);

    float fogFactor = clamp(distanceFog + heightFog, 0.0, 1.0);
    color = mix(color, uFogColor, fogFactor);

    color = color / (color + vec3(1.0)) * 1.1;
    color = pow(color, vec3(0.95));

    gl_FragColor = vec4(color, 1.0);
}
`;

// ============================================
// TerrainRenderer Class
// ============================================

export class TerrainRenderer {
  private scene: THREE.Scene;
  private mesh: THREE.Mesh | null = null;
  private lodMeshes: THREE.Mesh[] = [];
  private material: THREE.ShaderMaterial | null = null;
  private fallbackMaterial: THREE.MeshStandardMaterial | null = null;

  private splatTexture: THREE.DataTexture | null = null;
  private waterMaskTexture: THREE.DataTexture | null = null;
  private biomeTextures: Map<string, THREE.Texture> = new Map();
  private tileScale: number = 16;

  private data: TerrainRenderData | null = null;
  private options: Omit<Required<TerrainRendererOptions>, "textures"> & {
    textures?: TerrainTextureUrls;
  };

  private lodEnabled: boolean = true;
  private currentLOD: number = 0;
  private lodDistances: number[] = [];

  private wireframe: boolean = false;
  private debugMode: number = 0;
  private dispStrength: number = 0.3;

  // Default 1x1 white texture for unbound samplers
  private defaultTexture: THREE.DataTexture;

  constructor(scene: THREE.Scene, options: TerrainRendererOptions = {}) {
    this.scene = scene;
    this.options = {
      lodEnabled: options.lodEnabled ?? true,
      useShader: options.useShader ?? true,
      wireframe: options.wireframe ?? false,
      dispStrength: options.dispStrength ?? 0.3,
      textures: options.textures,
    };

    this.wireframe = this.options.wireframe;
    this.dispStrength = this.options.dispStrength;
    this.lodEnabled = this.options.lodEnabled;
    this.tileScale = options.textures?.tileScale ?? 16;

    this.defaultTexture = createDataTexture(
      new Uint8Array([255, 255, 255, 255]),
      1,
      1
    );

    if (options.textures) {
      this.loadBiomeTextures(options.textures);
    }
  }

  loadBiomeTextures(urls: TerrainTextureUrls): void {
    const loader = new THREE.TextureLoader();

    const loadTex = (url: string | undefined, name: string) => {
      if (!url) return;
      loader.load(url, (tex) => {
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.colorSpace = THREE.SRGBColorSpace;
        this.biomeTextures.set(name, tex);

        if (this.material) {
          this.material.uniforms[name].value = tex;
          this.material.uniforms.uUseTextures.value =
            this.biomeTextures.size > 0 ? 1.0 : 0.0;
        }
      });
    };

    loadTex(urls.grass, "uGrassTexture");
    loadTex(urls.dirt, "uDirtTexture");
    loadTex(urls.rock, "uRockTexture");
    loadTex(urls.sand, "uSandTexture");

    if (urls.tileScale) {
      this.tileScale = urls.tileScale;
      if (this.material) {
        this.material.uniforms.uTileScale.value = this.tileScale;
      }
    }

    console.log(`[TerrainRenderer] Loading biome textures`);
  }

  // ============================================
  // Public API
  // ============================================

  create(data: TerrainRenderData): void {
    this.dispose();
    this.data = data;

    this.createTextures();

    if (this.options.useShader) {
      this.createShaderMaterial();
    } else {
      this.createFallbackMaterial();
    }

    this.createLODMeshes();
  }

  setData(data: TerrainRenderData): void {
    this.data = data;
    this.updateHeightmap(data.heightmap);
    this.updateSplatmap(data.splatmap);
    this.updateWaterMask(data.waterMask);
  }

  updateHeightmap(heightmap: Float32Array): void {
    if (!this.data) return;
    this.data.heightmap = heightmap;

    for (const mesh of this.lodMeshes) {
      this.updateMeshVertices(mesh);
    }
  }

  updateSplatmap(splatmap: Float32Array): void {
    if (!this.data || !this.splatTexture) return;
    this.data.splatmap = splatmap;

    const res = this.data.resolution;
    const rgba = this.convertToRGBA(splatmap, res);
    (this.splatTexture.image as ImageData).data.set(rgba);
    this.splatTexture.needsUpdate = true;
  }

  updateWaterMask(waterMask: Float32Array): void {
    if (!this.data || !this.waterMaskTexture) return;
    this.data.waterMask = waterMask;

    const res = this.data.resolution;
    const rgba = this.convertMaskToRGBA(waterMask, res);
    (this.waterMaskTexture.image as ImageData).data.set(rgba);
    this.waterMaskTexture.needsUpdate = true;
  }

  getMesh(): THREE.Mesh | null {
    return this.mesh;
  }

  getLODMeshes(): THREE.Mesh[] {
    return this.lodMeshes;
  }

  getCurrentLODInfo(): {
    level: number;
    resolution: number;
    totalLevels: number;
  } {
    const res = this.data?.resolution ?? 0;
    return {
      level: this.currentLOD,
      resolution: Math.floor(res / Math.pow(2, this.currentLOD)),
      totalLevels: this.lodMeshes.length,
    };
  }

  setLODEnabled(enabled: boolean): void {
    this.lodEnabled = enabled;
    if (!enabled) {
      this.lodMeshes.forEach((m, i) => {
        m.visible = i === 0;
      });
    }
  }

  setWireframe(enabled: boolean): void {
    this.wireframe = enabled;
    if (this.material) {
      this.material.wireframe = enabled;
    }
    if (this.fallbackMaterial) {
      this.fallbackMaterial.wireframe = enabled;
    }
  }

  setDebugMode(mode: number): void {
    this.debugMode = mode;
    if (this.material) {
      this.material.uniforms.uDebugMode.value = mode;
    }
  }

  setDispStrength(strength: number): void {
    this.dispStrength = strength;
    if (this.material) {
      this.material.uniforms.uDispStrength.value = strength;
    }
  }

  setWaterLevel(level: number): void {
    if (this.data) {
      this.data.seaLevel = level;
    }
    if (this.material) {
      this.material.uniforms.uWaterLevel.value = level;
    }
  }

  setSunDirection(direction: THREE.Vector3): void {
    if (this.material) {
      this.material.uniforms.uSunDirection.value.copy(direction);
    }
  }

  setAmbientIntensity(intensity: number): void {
    if (this.material) {
      this.material.uniforms.uAmbientIntensity.value = intensity;
    }
  }

  setFog(color: THREE.Color, density: number): void {
    if (this.material) {
      this.material.uniforms.uFogColor.value.copy(color);
      this.material.uniforms.uFogDensity.value = density;
    }
  }

  /**
   * Update LOD based on camera position. Call from render loop.
   */
  updateLOD(cameraPosition: THREE.Vector3): void {
    if (!this.lodEnabled || this.lodMeshes.length === 0 || !this.mesh) return;

    const dist = cameraPosition.distanceTo(this.mesh.position);

    let newLOD = 0;
    for (let i = 0; i < this.lodDistances.length; i++) {
      if (dist > this.lodDistances[i]) {
        newLOD = Math.min(i + 1, this.lodMeshes.length - 1);
      }
    }

    if (newLOD !== this.currentLOD) {
      this.lodMeshes.forEach((m, i) => {
        m.visible = i === newLOD;
      });
      this.currentLOD = newLOD;
    }
  }

  /**
   * Update camera position uniform. Call from render loop.
   */
  updateCameraPosition(cameraPosition: THREE.Vector3): void {
    if (this.material) {
      this.material.uniforms.uCameraPosition.value.copy(cameraPosition);
    }
  }

  dispose(): void {
    for (const mesh of this.lodMeshes) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.lodMeshes = [];
    this.mesh = null;

    this.splatTexture?.dispose();
    this.splatTexture = null;
    this.waterMaskTexture?.dispose();
    this.waterMaskTexture = null;

    this.material?.dispose();
    this.material = null;
    this.fallbackMaterial?.dispose();
    this.fallbackMaterial = null;

    this.data = null;
  }

  // ============================================
  // Private Methods
  // ============================================

  private createTextures(): void {
    if (!this.data) return;

    const res = this.data.resolution;

    const splatRGBA = this.convertToRGBA(this.data.splatmap, res);
    this.splatTexture = createDataTexture(splatRGBA, res, res);

    const waterRGBA = this.convertMaskToRGBA(this.data.waterMask, res);
    this.waterMaskTexture = createDataTexture(waterRGBA, res, res);
  }

  private createShaderMaterial(): void {
    const sunDir = new THREE.Vector3(0.5, 1, 0.3).normalize();

    this.material = new THREE.ShaderMaterial({
      vertexShader: terrainVertexShader,
      fragmentShader: terrainFragmentShader,
      uniforms: {
        uTerrainSize: { value: this.data?.size ?? 64 },
        uDispStrength: { value: this.dispStrength },
        uWaterLevel: { value: this.data?.seaLevel ?? -100 },
        uSunDirection: { value: sunDir },
        uAmbientIntensity: { value: 0.3 },
        uCameraPosition: { value: new THREE.Vector3() },
        uDebugMode: { value: this.debugMode },
        uUseTextures: {
          value: this.biomeTextures.size > 0 ? 1.0 : 0.0,
        },
        uTileScale: { value: this.tileScale },
        uFogColor: { value: new THREE.Color(0.6, 0.75, 0.9) },
        uFogDensity: { value: 0.008 },
        uSplatMap: { value: this.splatTexture },
        uWaterMask: { value: this.waterMaskTexture },
        uGrassTexture: {
          value: this.biomeTextures.get("uGrassTexture") ?? this.defaultTexture,
        },
        uDirtTexture: {
          value: this.biomeTextures.get("uDirtTexture") ?? this.defaultTexture,
        },
        uRockTexture: {
          value: this.biomeTextures.get("uRockTexture") ?? this.defaultTexture,
        },
        uSandTexture: {
          value: this.biomeTextures.get("uSandTexture") ?? this.defaultTexture,
        },
      },
      wireframe: this.wireframe,
      side: THREE.DoubleSide,
    });
  }

  private createFallbackMaterial(): void {
    this.fallbackMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0.3, 0.5, 0.2),
      wireframe: this.wireframe,
      side: THREE.DoubleSide,
    });
  }

  private createLODMeshes(): void {
    if (!this.data) return;

    const res = this.data.resolution;
    const size = this.data.size;

    this.lodDistances = [size * 1.0, size * 2.0];

    const lodResolutions = [res, Math.floor(res / 2), Math.floor(res / 4)];

    for (let i = 0; i < lodResolutions.length; i++) {
      const lodRes = Math.max(4, lodResolutions[i]);
      const mesh = this.createMeshForResolution(lodRes, size);

      mesh.material = this.material ?? this.fallbackMaterial!;
      mesh.visible = i === 0;

      this.scene.add(mesh);
      this.lodMeshes.push(mesh);
    }

    this.mesh = this.lodMeshes[0];
  }

  private createMeshForResolution(
    resolution: number,
    size: number
  ): THREE.Mesh {
    // PlaneGeometry is in XY plane, we rotate to XZ plane
    const geometry = new THREE.PlaneGeometry(
      size,
      size,
      resolution,
      resolution
    );

    // Rotate from XY to XZ (lying flat)
    geometry.rotateX(-Math.PI / 2);

    // Apply heightmap
    this.applyHeightmapToGeometry(geometry);

    const mesh = new THREE.Mesh(geometry);

    // Offset to match editor coordinates (0,0)~(size,size) instead of centered
    mesh.position.set(size / 2, 0, size / 2);

    return mesh;
  }

  private applyHeightmapToGeometry(geometry: THREE.BufferGeometry): void {
    if (!this.data) return;

    const positions = geometry.attributes.position;
    const uvs = geometry.attributes.uv;
    if (!positions || !uvs) return;

    const sourceRes = this.data.resolution + 1;
    const heightmap = this.data.heightmap;

    for (let i = 0; i < positions.count; i++) {
      const u = uvs.getX(i);
      const v = uvs.getY(i);

      // Three.js PlaneGeometry UV: (0,1) top-left to (1,0) bottom-right
      // After rotateX(-PI/2), the plane is in XZ. UVs need v-flip for heightmap sampling.
      const height = this.sampleHeightmap(heightmap, sourceRes, u, 1 - v);
      positions.setY(i, height);
    }

    positions.needsUpdate = true;
    geometry.computeVertexNormals();
  }

  private updateMeshVertices(mesh: THREE.Mesh): void {
    const geometry = mesh.geometry as THREE.BufferGeometry;
    this.applyHeightmapToGeometry(geometry);
  }

  private sampleHeightmap(
    heightmap: Float32Array,
    resolution: number,
    u: number,
    v: number
  ): number {
    const x = u * (resolution - 1);
    const z = v * (resolution - 1);

    const x0 = Math.floor(x);
    const z0 = Math.floor(z);
    const x1 = Math.min(x0 + 1, resolution - 1);
    const z1 = Math.min(z0 + 1, resolution - 1);

    const fx = x - x0;
    const fz = z - z0;

    const h00 = heightmap[z0 * resolution + x0] ?? 0;
    const h10 = heightmap[z0 * resolution + x1] ?? 0;
    const h01 = heightmap[z1 * resolution + x0] ?? 0;
    const h11 = heightmap[z1 * resolution + x1] ?? 0;

    const h0 = h00 * (1 - fx) + h10 * fx;
    const h1 = h01 * (1 - fx) + h11 * fx;

    return h0 * (1 - fz) + h1 * fz;
  }

  private convertToRGBA(
    splatmap: Float32Array,
    resolution: number
  ): Uint8Array {
    const size = resolution * resolution;
    const rgba = new Uint8Array(size * 4);

    for (let i = 0; i < size; i++) {
      rgba[i * 4 + 0] = Math.floor((splatmap[i * 4 + 0] ?? 1) * 255);
      rgba[i * 4 + 1] = Math.floor((splatmap[i * 4 + 1] ?? 0) * 255);
      rgba[i * 4 + 2] = Math.floor((splatmap[i * 4 + 2] ?? 0) * 255);
      rgba[i * 4 + 3] = Math.floor((splatmap[i * 4 + 3] ?? 0) * 255);
    }

    return rgba;
  }

  private convertMaskToRGBA(
    mask: Float32Array,
    resolution: number
  ): Uint8Array {
    const size = resolution * resolution;
    const rgba = new Uint8Array(size * 4);

    for (let i = 0; i < size; i++) {
      const value = Math.floor((mask[i] ?? 0) * 255);
      rgba[i * 4 + 0] = value;
      rgba[i * 4 + 1] = value;
      rgba[i * 4 + 2] = value;
      rgba[i * 4 + 3] = 255;
    }

    return rgba;
  }
}
