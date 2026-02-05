/**
 * TerrainRenderer - Independent terrain rendering for Babylon.js
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

import {
  Scene,
  Mesh,
  MeshBuilder,
  Vector3,
  VertexData,
  VertexBuffer,
  RawTexture,
  Texture,
  Engine,
  ShaderMaterial,
  Effect,
  Color3,
  StandardMaterial,
} from "@babylonjs/core";
import type { TerrainRenderData, TerrainRendererOptions, TerrainTextureUrls } from "./types";

// ============================================
// Simplified Terrain Shader (inline)
// ============================================

const terrainVertexShader = `
precision highp float;

// Attributes
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;

// Uniforms
uniform mat4 world;
uniform mat4 worldViewProjection;
uniform float uTerrainSize;
uniform float uDispStrength;
uniform sampler2D uSplatMap;
uniform sampler2D uWaterMask;
uniform float uWaterLevel;

// Varyings
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
    vec4 worldPos = world * vec4(positionUpdated, 1.0);
    vPositionW = worldPos.xyz;
    vHeight = positionUpdated.y;

    // Normal
    vNormalW = normalize((world * vec4(normal, 0.0)).xyz);

    // UV
    vUV = uv;

    gl_Position = worldViewProjection * vec4(positionUpdated, 1.0);
}
`;

const terrainFragmentShader = `
precision highp float;

// Varyings
varying vec3 vPositionW;
varying vec3 vNormalW;
varying vec2 vUV;
varying vec4 vSplatWeights;
varying float vWaterMask;
varying float vHeight;

// Uniforms
uniform vec3 uSunDirection;
uniform float uAmbientIntensity;
uniform float uWaterLevel;
uniform vec3 uCameraPosition;
uniform float uDebugMode;
uniform float uUseTextures;
uniform float uTileScale;
uniform vec3 uFogColor;
uniform float uFogDensity;

// Texture samplers
uniform sampler2D uGrassTexture;
uniform sampler2D uDirtTexture;
uniform sampler2D uRockTexture;
uniform sampler2D uSandTexture;

// Fallback colors (matching editor's TerrainShader)
const vec3 grassColor = vec3(0.4, 0.6, 0.25);   // Bright green grass
const vec3 dirtColor = vec3(0.52, 0.42, 0.28);  // Warm brown dirt
const vec3 rockColor = vec3(0.48, 0.48, 0.5);   // Gray rock
const vec3 sandColor = vec3(0.82, 0.72, 0.52);  // Warm sandy yellow
const vec3 waterColor = vec3(0.1, 0.3, 0.5);

void main() {
    vec3 normal = normalize(vNormalW);

    // Debug mode
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
        // Sample textures
        vec3 grassSample = texture2D(uGrassTexture, tiledUV).rgb;
        vec3 dirtSample = texture2D(uDirtTexture, tiledUV).rgb;
        vec3 rockSample = texture2D(uRockTexture, tiledUV).rgb;
        vec3 sandSample = texture2D(uSandTexture, tiledUV).rgb;

        // Blend based on splatmap
        baseColor = grassSample * vSplatWeights.r +
                    dirtSample * vSplatWeights.g +
                    rockSample * vSplatWeights.b +
                    sandSample * vSplatWeights.a;
    } else {
        // Use solid colors
        baseColor = grassColor * vSplatWeights.r +
                    dirtColor * vSplatWeights.g +
                    rockColor * vSplatWeights.b +
                    sandColor * vSplatWeights.a;
    }

    // Water mask blending
    if (vWaterMask > 0.5) {
        baseColor = mix(baseColor, waterColor, 0.7);
    }

    // Lighting
    float NdotL = max(dot(normal, normalize(uSunDirection)), 0.0);
    float diffuse = NdotL * 0.8 + uAmbientIntensity;

    vec3 color = baseColor * diffuse;

    // Fog (matching editor's TerrainShader)
    float distanceToCamera = length(uCameraPosition - vPositionW);
    float distanceFog = 1.0 - exp(-uFogDensity * uFogDensity * distanceToCamera * distanceToCamera);

    // Height fog
    float fogHeight = 10.0;
    float heightFog = clamp((fogHeight - vPositionW.y) / fogHeight, 0.0, 0.3);

    float fogFactor = clamp(distanceFog + heightFog, 0.0, 1.0);
    color = mix(color, uFogColor, fogFactor);

    // Tone mapping
    color = color / (color + vec3(1.0)) * 1.1;
    color = pow(color, vec3(0.95));

    gl_FragColor = vec4(color, 1.0);
}
`;

// ============================================
// TerrainRenderer Class
// ============================================

export class TerrainRenderer {
  private scene: Scene;
  private mesh: Mesh | null = null;
  private lodMeshes: Mesh[] = [];
  private material: ShaderMaterial | null = null;
  private fallbackMaterial: StandardMaterial | null = null;

  private splatTexture: RawTexture | null = null;
  private waterMaskTexture: RawTexture | null = null;
  private biomeTextures: Map<string, Texture> = new Map();
  private tileScale: number = 16;

  private data: TerrainRenderData | null = null;
  private options: Omit<Required<TerrainRendererOptions>, "textures"> & {
    textures?: TerrainTextureUrls;
  };

  private lodEnabled: boolean = true;
  private currentLOD: number = 0;
  private lodDistances: number[] = []; // Set dynamically based on terrain size

  private wireframe: boolean = false;
  private debugMode: number = 0;
  private dispStrength: number = 0.3;

  constructor(scene: Scene, options: TerrainRendererOptions = {}) {
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

    this.registerShader();

    // Load biome textures if provided
    if (options.textures) {
      this.loadBiomeTextures(options.textures);
    }
  }

  /**
   * Load biome textures from URLs
   */
  loadBiomeTextures(urls: TerrainTextureUrls): void {
    if (urls.grass) {
      const tex = new Texture(urls.grass, this.scene);
      tex.wrapU = Texture.WRAP_ADDRESSMODE;
      tex.wrapV = Texture.WRAP_ADDRESSMODE;
      this.biomeTextures.set("uGrassTexture", tex);
    }
    if (urls.dirt) {
      const tex = new Texture(urls.dirt, this.scene);
      tex.wrapU = Texture.WRAP_ADDRESSMODE;
      tex.wrapV = Texture.WRAP_ADDRESSMODE;
      this.biomeTextures.set("uDirtTexture", tex);
    }
    if (urls.rock) {
      const tex = new Texture(urls.rock, this.scene);
      tex.wrapU = Texture.WRAP_ADDRESSMODE;
      tex.wrapV = Texture.WRAP_ADDRESSMODE;
      this.biomeTextures.set("uRockTexture", tex);
    }
    if (urls.sand) {
      const tex = new Texture(urls.sand, this.scene);
      tex.wrapU = Texture.WRAP_ADDRESSMODE;
      tex.wrapV = Texture.WRAP_ADDRESSMODE;
      this.biomeTextures.set("uSandTexture", tex);
    }

    if (urls.tileScale) {
      this.tileScale = urls.tileScale;
    }

    // Update shader if material already exists
    if (this.material) {
      this.material.setFloat("uUseTextures", this.biomeTextures.size > 0 ? 1.0 : 0.0);
      this.material.setFloat("uTileScale", this.tileScale);
      for (const [name, texture] of this.biomeTextures) {
        this.material.setTexture(name, texture);
      }
    }

    console.log(`[TerrainRenderer] Loaded ${this.biomeTextures.size} biome textures`);
  }

  // ============================================
  // Public API
  // ============================================

  /**
   * Create terrain mesh from data
   */
  create(data: TerrainRenderData): void {
    this.dispose();
    this.data = data;

    // Create textures
    this.createTextures();

    // Create material
    if (this.options.useShader) {
      this.createShaderMaterial();
    } else {
      this.createFallbackMaterial();
    }

    // Create LOD meshes
    this.createLODMeshes();

    // Setup LOD switching
    if (this.lodEnabled) {
      this.setupLODSwitching();
    }
  }

  /**
   * Update terrain with new data
   */
  setData(data: TerrainRenderData): void {
    this.data = data;
    this.updateHeightmap(data.heightmap);
    this.updateSplatmap(data.splatmap);
    this.updateWaterMask(data.waterMask);
  }

  /**
   * Update heightmap data
   */
  updateHeightmap(heightmap: Float32Array): void {
    if (!this.data) return;
    this.data.heightmap = heightmap;

    // Rebuild all LOD meshes
    for (let i = 0; i < this.lodMeshes.length; i++) {
      const lodRes = Math.floor(this.data.resolution / Math.pow(2, i));
      this.updateMeshVertices(this.lodMeshes[i], lodRes);
    }
  }

  /**
   * Update splatmap data
   */
  updateSplatmap(splatmap: Float32Array): void {
    if (!this.data || !this.splatTexture) return;
    this.data.splatmap = splatmap;

    const res = this.data.resolution;
    const rgba = this.convertToRGBA(splatmap, res);
    this.splatTexture.update(rgba);
  }

  /**
   * Update water mask data
   */
  updateWaterMask(waterMask: Float32Array): void {
    if (!this.data || !this.waterMaskTexture) return;
    this.data.waterMask = waterMask;

    const res = this.data.resolution;
    const rgba = this.convertMaskToRGBA(waterMask, res);
    this.waterMaskTexture.update(rgba);
  }

  /**
   * Get the main mesh
   */
  getMesh(): Mesh | null {
    return this.mesh;
  }

  /**
   * Get all LOD meshes
   */
  getLODMeshes(): Mesh[] {
    return this.lodMeshes;
  }

  /**
   * Get current LOD info
   */
  getCurrentLODInfo(): { level: number; resolution: number; totalLevels: number } {
    const res = this.data?.resolution ?? 0;
    return {
      level: this.currentLOD,
      resolution: Math.floor(res / Math.pow(2, this.currentLOD)),
      totalLevels: this.lodMeshes.length,
    };
  }

  /**
   * Enable/disable LOD system
   */
  setLODEnabled(enabled: boolean): void {
    this.lodEnabled = enabled;
    if (!enabled) {
      // Show only highest LOD
      this.lodMeshes.forEach((m, i) => {
        m.setEnabled(i === 0);
      });
    }
  }

  /**
   * Set wireframe mode
   */
  setWireframe(enabled: boolean): void {
    this.wireframe = enabled;
    if (this.material) {
      this.material.wireframe = enabled;
    }
    if (this.fallbackMaterial) {
      this.fallbackMaterial.wireframe = enabled;
    }
  }

  /**
   * Set debug visualization mode
   * 0 = normal, 1 = splatmap, 2 = normals, 3 = height
   */
  setDebugMode(mode: number): void {
    this.debugMode = mode;
    if (this.material) {
      this.material.setFloat("uDebugMode", mode);
    }
  }

  /**
   * Set displacement strength
   */
  setDispStrength(strength: number): void {
    this.dispStrength = strength;
    if (this.material) {
      this.material.setFloat("uDispStrength", strength);
    }
  }

  /**
   * Set water level
   */
  setWaterLevel(level: number): void {
    if (this.data) {
      this.data.seaLevel = level;
    }
    if (this.material) {
      this.material.setFloat("uWaterLevel", level);
    }
  }

  /**
   * Set sun direction
   */
  setSunDirection(direction: Vector3): void {
    if (this.material) {
      this.material.setVector3("uSunDirection", direction);
    }
  }

  /**
   * Set ambient intensity
   */
  setAmbientIntensity(intensity: number): void {
    if (this.material) {
      this.material.setFloat("uAmbientIntensity", intensity);
    }
  }

  /**
   * Set fog parameters for terrain shader
   */
  setFog(color: Color3, density: number): void {
    if (this.material) {
      this.material.setColor3("uFogColor", color);
      this.material.setFloat("uFogDensity", density);
    }
  }

  /**
   * Dispose all resources
   */
  dispose(): void {
    // Dispose LOD meshes
    for (const mesh of this.lodMeshes) {
      mesh.dispose();
    }
    this.lodMeshes = [];
    this.mesh = null;

    // Dispose textures
    this.splatTexture?.dispose();
    this.splatTexture = null;
    this.waterMaskTexture?.dispose();
    this.waterMaskTexture = null;

    // Note: Don't dispose shared material if used by multiple instances
    // For safety, we don't dispose materials here
    this.material = null;
    this.fallbackMaterial = null;

    this.data = null;
  }

  // ============================================
  // Private Methods
  // ============================================

  private registerShader(): void {
    if (!Effect.ShadersStore["terrainSimpleVertexShader"]) {
      Effect.ShadersStore["terrainSimpleVertexShader"] = terrainVertexShader;
    }
    if (!Effect.ShadersStore["terrainSimpleFragmentShader"]) {
      Effect.ShadersStore["terrainSimpleFragmentShader"] = terrainFragmentShader;
    }
  }

  private createTextures(): void {
    if (!this.data) return;

    const res = this.data.resolution;

    // Splatmap texture (RGBA)
    const splatRGBA = this.convertToRGBA(this.data.splatmap, res);
    this.splatTexture = new RawTexture(
      splatRGBA,
      res,
      res,
      Engine.TEXTUREFORMAT_RGBA,
      this.scene,
      false,
      false,
      Texture.BILINEAR_SAMPLINGMODE
    );

    // Water mask texture (grayscale as RGBA)
    const waterRGBA = this.convertMaskToRGBA(this.data.waterMask, res);
    this.waterMaskTexture = new RawTexture(
      waterRGBA,
      res,
      res,
      Engine.TEXTUREFORMAT_RGBA,
      this.scene,
      false,
      false,
      Texture.BILINEAR_SAMPLINGMODE
    );
  }

  private createShaderMaterial(): void {
    const uniqueName = `terrainSimple_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    this.material = new ShaderMaterial(
      uniqueName,
      this.scene,
      {
        vertex: "terrainSimple",
        fragment: "terrainSimple",
      },
      {
        attributes: ["position", "normal", "uv"],
        uniforms: [
          "world",
          "worldViewProjection",
          "uTerrainSize",
          "uDispStrength",
          "uWaterLevel",
          "uSunDirection",
          "uAmbientIntensity",
          "uCameraPosition",
          "uDebugMode",
          "uUseTextures",
          "uTileScale",
          "uFogColor",
          "uFogDensity",
        ],
        samplers: [
          "uSplatMap",
          "uWaterMask",
          "uGrassTexture",
          "uDirtTexture",
          "uRockTexture",
          "uSandTexture",
        ],
      }
    );

    // Set initial uniforms
    this.material.setFloat("uTerrainSize", this.data?.size ?? 64);
    this.material.setFloat("uDispStrength", this.dispStrength);
    this.material.setFloat("uWaterLevel", this.data?.seaLevel ?? -100);
    this.material.setVector3("uSunDirection", new Vector3(0.5, 1, 0.3).normalize());
    this.material.setFloat("uAmbientIntensity", 0.3);
    this.material.setFloat("uDebugMode", this.debugMode);
    this.material.setFloat("uUseTextures", this.biomeTextures.size > 0 ? 1.0 : 0.0);
    this.material.setFloat("uTileScale", this.tileScale);

    // Fog settings (matching editor's TerrainShader)
    this.material.setColor3("uFogColor", new Color3(0.6, 0.75, 0.9));
    this.material.setFloat("uFogDensity", this.scene.fogDensity ?? 0.008);

    if (this.splatTexture) {
      this.material.setTexture("uSplatMap", this.splatTexture);
    }
    if (this.waterMaskTexture) {
      this.material.setTexture("uWaterMask", this.waterMaskTexture);
    }

    // Create a default 1x1 white texture for unbound samplers
    const defaultPixels = new Uint8Array([255, 255, 255, 255]);
    const defaultTexture = new RawTexture(
      defaultPixels, 1, 1, Engine.TEXTUREFORMAT_RGBA, this.scene, false, false
    );

    // Bind default texture to all samplers first
    this.material.setTexture("uGrassTexture", defaultTexture);
    this.material.setTexture("uDirtTexture", defaultTexture);
    this.material.setTexture("uRockTexture", defaultTexture);
    this.material.setTexture("uSandTexture", defaultTexture);

    // Override with loaded biome textures
    for (const [name, texture] of this.biomeTextures) {
      this.material.setTexture(name, texture);
    }

    this.material.wireframe = this.wireframe;
    this.material.backFaceCulling = false;

    // Update camera position each frame
    this.material.onBind = () => {
      const camera = this.scene.activeCamera;
      if (camera && this.material) {
        this.material.setVector3("uCameraPosition", camera.position);
      }
    };
  }

  private createFallbackMaterial(): void {
    this.fallbackMaterial = new StandardMaterial("terrainFallback", this.scene);
    this.fallbackMaterial.diffuseColor = new Color3(0.3, 0.5, 0.2);
    this.fallbackMaterial.wireframe = this.wireframe;
    this.fallbackMaterial.backFaceCulling = false;
  }

  private createLODMeshes(): void {
    if (!this.data) return;

    const res = this.data.resolution;
    const size = this.data.size;

    // Set LOD distances based on terrain size (matching editor behavior)
    // LOD 0 -> LOD 1 at 1x terrain size
    // LOD 1 -> LOD 2 at 2x terrain size
    this.lodDistances = [size * 1.0, size * 2.0];

    // Create 3 LOD levels: full, half, quarter resolution
    const lodResolutions = [res, Math.floor(res / 2), Math.floor(res / 4)];

    for (let i = 0; i < lodResolutions.length; i++) {
      const lodRes = Math.max(4, lodResolutions[i]); // Minimum 4 subdivisions
      const mesh = this.createMeshForResolution(lodRes, size, i);

      mesh.material = this.material ?? this.fallbackMaterial;
      mesh.setEnabled(i === 0); // Only show highest LOD initially

      this.lodMeshes.push(mesh);
    }

    this.mesh = this.lodMeshes[0];
  }

  private createMeshForResolution(resolution: number, size: number, lodIndex: number): Mesh {
    const mesh = MeshBuilder.CreateGround(
      `terrain_lod${lodIndex}`,
      {
        width: size,
        height: size,
        subdivisions: resolution,
        updatable: true,
      },
      this.scene
    );

    // Offset mesh to match editor coordinates (0,0)~(size,size) instead of centered
    mesh.position.x = size / 2;
    mesh.position.z = size / 2;

    this.updateMeshVertices(mesh, resolution);

    return mesh;
  }

  private updateMeshVertices(mesh: Mesh, _targetRes: number): void {
    if (!this.data) return;

    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    const uvs = mesh.getVerticesData(VertexBuffer.UVKind);
    if (!positions || !uvs) return;

    const sourceRes = this.data.resolution + 1;
    const heightmap = this.data.heightmap;

    // Sample heightmap at lower resolution
    for (let i = 0; i < positions.length / 3; i++) {
      const u = uvs[i * 2];
      const v = uvs[i * 2 + 1];

      // Get height from heightmap using bilinear interpolation
      const height = this.sampleHeightmap(heightmap, sourceRes, u, v);
      positions[i * 3 + 1] = height;
    }

    // Update mesh - create copy for WebGPU compatibility
    mesh.updateVerticesData(VertexBuffer.PositionKind, new Float32Array(positions));

    // Recalculate normals
    const normals = mesh.getVerticesData(VertexBuffer.NormalKind);
    if (normals) {
      VertexData.ComputeNormals(positions, mesh.getIndices(), normals);
      mesh.updateVerticesData(VertexBuffer.NormalKind, new Float32Array(normals));
    }
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

    // Bilinear interpolation
    const h0 = h00 * (1 - fx) + h10 * fx;
    const h1 = h01 * (1 - fx) + h11 * fx;

    return h0 * (1 - fz) + h1 * fz;
  }

  private setupLODSwitching(): void {
    this.scene.registerBeforeRender(() => {
      if (!this.lodEnabled || this.lodMeshes.length === 0) return;

      const camera = this.scene.activeCamera;
      if (!camera) return;

      // Calculate distance from camera to terrain center
      const terrainCenter = this.mesh?.position ?? Vector3.Zero();
      const dist = Vector3.Distance(camera.position, terrainCenter);

      // Determine LOD level
      let newLOD = 0;
      for (let i = 0; i < this.lodDistances.length; i++) {
        if (dist > this.lodDistances[i]) {
          newLOD = Math.min(i + 1, this.lodMeshes.length - 1);
        }
      }

      // Switch LOD if changed
      if (newLOD !== this.currentLOD) {
        this.lodMeshes.forEach((m, i) => {
          m.setEnabled(i === newLOD);
        });
        this.currentLOD = newLOD;
      }
    });
  }

  private convertToRGBA(splatmap: Float32Array, resolution: number): Uint8Array {
    const size = resolution * resolution;
    const rgba = new Uint8Array(size * 4);

    for (let i = 0; i < size; i++) {
      // Splatmap is stored as RGBA floats (0-1)
      rgba[i * 4 + 0] = Math.floor((splatmap[i * 4 + 0] ?? 1) * 255);
      rgba[i * 4 + 1] = Math.floor((splatmap[i * 4 + 1] ?? 0) * 255);
      rgba[i * 4 + 2] = Math.floor((splatmap[i * 4 + 2] ?? 0) * 255);
      rgba[i * 4 + 3] = Math.floor((splatmap[i * 4 + 3] ?? 0) * 255);
    }

    return rgba;
  }

  private convertMaskToRGBA(mask: Float32Array, resolution: number): Uint8Array {
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
