import {
  Scene,
  Mesh,
  VertexData,
  Vector3,
  Color3,
  StandardMaterial,
  ShaderMaterial,
  RawTexture,
  Texture,
  Engine,
  Material,
  Observer,
} from "@babylonjs/core";
import { Heightmap } from "./Heightmap";
import { SplatMap } from "./SplatMap";
import { createTerrainMaterial, updateSplatTexture } from "./TerrainShader";

// LOD level configuration
interface LODLevel {
  distance: number;  // Camera distance threshold
  resolution: number;  // Target resolution for this LOD
  mesh: Mesh | null;
}

export class TerrainMesh {
  private scene: Scene;
  private heightmap: Heightmap;
  private splatMap: SplatMap;
  private mesh: Mesh | null = null;  // Current active mesh
  private shaderMaterial: ShaderMaterial | null = null;
  private simpleMaterial: StandardMaterial | null = null;
  private splatTexture: RawTexture | null = null;
  private waterMaskTexture: RawTexture | null = null;
  private useShader = true;

  // Displacement strength (GPU shader based)
  private dispStrength = 0.5;
  private textureScale = 1.0;  // Must match shader's uTextureScale
  
  // Displacement texture data for baking
  private dispTextureData: { pixels: Uint8Array; width: number; height: number } | null = null;
  private dispTextureLoaded = false;

  // LOD system
  private lodLevels: LODLevel[] = [];
  private currentLOD = 0;
  private lodEnabled = true;
  private beforeRenderObserver: Observer<Scene> | null = null;

  constructor(scene: Scene, heightmap: Heightmap) {
    this.scene = scene;
    this.heightmap = heightmap;
    this.splatMap = new SplatMap(heightmap.getResolution() * 2);
    this.loadDisplacementTexture();
  }

  /**
   * Load displacement texture for baking into mesh during export
   */
  private loadDisplacementTexture(): void {
    const dispTexture = new Texture("/textures/rock_disp.jpg", this.scene, false, false);
    dispTexture.onLoadObservable.addOnce(async () => {
      const size = dispTexture.getSize();
      const pixels = await dispTexture.readPixels() as Uint8Array;
      this.dispTextureData = {
        pixels: pixels || new Uint8Array([128]),
        width: size.width,
        height: size.height,
      };
      this.dispTextureLoaded = true;
      console.log("[TerrainMesh] Displacement texture loaded for baking:", size.width, "x", size.height);
      dispTexture.dispose();
    });
  }

  /**
   * Sample displacement texture with bilinear interpolation
   */
  private sampleDisplacement(worldX: number, worldZ: number): number {
    if (!this.dispTextureData) return 0;

    const { pixels, width, height } = this.dispTextureData;

    // UV coordinates (tiled based on textureScale, same as shader)
    const u = ((worldX * this.textureScale) % 1 + 1) % 1;
    const v = ((worldZ * this.textureScale) % 1 + 1) % 1;

    // Bilinear interpolation
    const x = u * (width - 1);
    const y = v * (height - 1);
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = (x0 + 1) % width;
    const y1 = (y0 + 1) % height;
    const xFrac = x - x0;
    const yFrac = y - y0;

    const getPixel = (px: number, py: number): number => {
      const idx = (py * width + px) * 4;  // RGBA format
      return pixels[idx] / 255;
    };

    const p00 = getPixel(x0, y0);
    const p10 = getPixel(x1, y0);
    const p01 = getPixel(x0, y1);
    const p11 = getPixel(x1, y1);

    const p0 = p00 * (1 - xFrac) + p10 * xFrac;
    const p1 = p01 * (1 - xFrac) + p11 * xFrac;

    return p0 * (1 - yFrac) + p1 * yFrac;
  }

  create(): void {
    const resolution = this.heightmap.getResolution();
    const scale = this.heightmap.getScale();
    console.log("[TerrainMesh] Creating terrain mesh with LOD, base resolution:", resolution, "scale:", scale);

    // Create materials first (shared across all LOD levels)
    this.createMaterials();

    // Define LOD levels based on base resolution and terrain scale
    // Distance thresholds are relative to terrain size for proper scaling
    this.lodLevels = [];
    
    // LOD 0: Full resolution (always) - close up view
    this.lodLevels.push({
      distance: 0,
      resolution: resolution,
      mesh: null,
    });

    // LOD 1: Half resolution - medium distance (1x terrain size)
    if (resolution > 256) {
      const lod1Res = Math.max(129, Math.floor(resolution / 2) + 1);
      this.lodLevels.push({
        distance: scale * 1.0,  // 1x terrain size (64 units for 64-scale terrain)
        resolution: lod1Res,
        mesh: null,
      });
    }

    // LOD 2: Quarter resolution - far distance (2x terrain size)
    if (resolution > 512) {
      const lod2Res = Math.max(65, Math.floor(resolution / 4) + 1);
      this.lodLevels.push({
        distance: scale * 2.0,  // 2x terrain size (128 units for 64-scale terrain)
        resolution: lod2Res,
        mesh: null,
      });
    }

    // LOD 3: Eighth resolution - very far (3x terrain size)
    if (resolution > 1024) {
      const lod3Res = Math.max(33, Math.floor(resolution / 8) + 1);
      this.lodLevels.push({
        distance: scale * 3.0,  // 3x terrain size (192 units for 64-scale terrain)
        resolution: lod3Res,
        mesh: null,
      });
    }

    console.log("[TerrainMesh] LOD levels:", this.lodLevels.map(l => `${l.resolution} @ ${l.distance}u`).join(", "));

    // Create meshes for each LOD level
    for (let i = 0; i < this.lodLevels.length; i++) {
      this.lodLevels[i].mesh = this.createMeshForResolution(
        this.lodLevels[i].resolution,
        `terrain_lod${i}`
      );
      // Hide all except LOD 0
      if (i > 0 && this.lodLevels[i].mesh) {
        this.lodLevels[i].mesh!.setEnabled(false);
      }
    }

    // Set current mesh to LOD 0
    this.mesh = this.lodLevels[0].mesh;
    this.currentLOD = 0;

    // Setup LOD switching in render loop
    this.setupLODSwitching();

    console.log("[TerrainMesh] Mesh created with", this.lodLevels.length, "LOD levels");
  }

  /**
   * Create a mesh at specific resolution
   */
  private createMeshForResolution(targetResolution: number, name: string): Mesh {
    const baseResolution = this.heightmap.getResolution();
    const scale = this.heightmap.getScale();
    const step = Math.max(1, Math.floor((baseResolution - 1) / (targetResolution - 1)));
    const actualResolution = Math.floor((baseResolution - 1) / step) + 1;
    const cellSize = scale / (actualResolution - 1);

    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    // Create vertices (sampling from heightmap at step intervals)
    for (let z = 0; z < actualResolution; z++) {
      for (let x = 0; x < actualResolution; x++) {
        const hx = Math.min(x * step, baseResolution - 1);
        const hz = Math.min(z * step, baseResolution - 1);
        const height = this.heightmap.getHeight(hx, hz);
        positions.push(x * cellSize, height, z * cellSize);
        uvs.push(x / (actualResolution - 1), z / (actualResolution - 1));
        normals.push(0, 1, 0);
      }
    }

    // Create indices
    for (let z = 0; z < actualResolution - 1; z++) {
      for (let x = 0; x < actualResolution - 1; x++) {
        const topLeft = z * actualResolution + x;
        const topRight = topLeft + 1;
        const bottomLeft = (z + 1) * actualResolution + x;
        const bottomRight = bottomLeft + 1;

        indices.push(topLeft, bottomLeft, topRight);
        indices.push(topRight, bottomLeft, bottomRight);
      }
    }

    const mesh = new Mesh(name, this.scene);

    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.uvs = uvs;
    vertexData.applyToMesh(mesh, true);

    // Calculate normals
    this.calculateNormalsForMesh(mesh, actualResolution, cellSize, positions);

    // Apply material
    mesh.material = this.useShader ? this.shaderMaterial : this.simpleMaterial;

    console.log(`[TerrainMesh] Created ${name}: ${actualResolution}x${actualResolution} = ${positions.length / 3} vertices`);
    return mesh;
  }

  /**
   * Calculate normals for a specific mesh
   */
  private calculateNormalsForMesh(mesh: Mesh, resolution: number, cellSize: number, positions: number[]): void {
    const normals: number[] = [];

    for (let z = 0; z < resolution; z++) {
      for (let x = 0; x < resolution; x++) {
        const idx = (z * resolution + x) * 3;
        const idxL = (z * resolution + Math.max(0, x - 1)) * 3;
        const idxR = (z * resolution + Math.min(resolution - 1, x + 1)) * 3;
        const idxD = (Math.max(0, z - 1) * resolution + x) * 3;
        const idxU = (Math.min(resolution - 1, z + 1) * resolution + x) * 3;

        const hL = positions[idxL + 1];
        const hR = positions[idxR + 1];
        const hD = positions[idxD + 1];
        const hU = positions[idxU + 1];

        const nx = (hL - hR) / (2 * cellSize);
        const nz = (hD - hU) / (2 * cellSize);

        // Normalize without creating Vector3 object
        const len = Math.sqrt(nx * nx + 1 + nz * nz);
        normals.push(nx / len, 1 / len, nz / len);
      }
    }

    mesh.setVerticesData("normal", normals, true);
  }

  /**
   * Setup automatic LOD switching based on camera distance
   */
  private setupLODSwitching(): void {
    if (this.lodLevels.length <= 1) return;  // No LOD switching needed

    const terrainCenter = new Vector3(
      this.heightmap.getScale() / 2,
      0,
      this.heightmap.getScale() / 2
    );

    this.beforeRenderObserver = this.scene.onBeforeRenderObservable.add(() => {
      if (!this.lodEnabled) return;

      const camera = this.scene.activeCamera;
      if (!camera) return;

      const distance = Vector3.Distance(camera.position, terrainCenter);

      // Find appropriate LOD level
      let targetLOD = 0;
      for (let i = this.lodLevels.length - 1; i >= 0; i--) {
        if (distance >= this.lodLevels[i].distance) {
          targetLOD = i;
          break;
        }
      }

      // Switch LOD if needed
      if (targetLOD !== this.currentLOD) {
        this.switchLOD(targetLOD);
      }
    });
  }

  /**
   * Switch to a different LOD level
   */
  private switchLOD(level: number): void {
    if (level < 0 || level >= this.lodLevels.length) return;
    if (level === this.currentLOD) return;

    // Hide current LOD mesh
    if (this.lodLevels[this.currentLOD].mesh) {
      this.lodLevels[this.currentLOD].mesh!.setEnabled(false);
    }

    // Show new LOD mesh
    if (this.lodLevels[level].mesh) {
      this.lodLevels[level].mesh!.setEnabled(true);
    }

    this.currentLOD = level;
    this.mesh = this.lodLevels[level].mesh;

    console.log(`[TerrainMesh] Switched to LOD ${level} (${this.lodLevels[level].resolution})`);
  }

  private calculateNormals(): void {
    if (!this.mesh) return;

    const resolution = this.heightmap.getResolution();
    const scale = this.heightmap.getScale();
    const cellSize = scale / (resolution - 1);
    const normals: number[] = [];

    for (let z = 0; z < resolution; z++) {
      for (let x = 0; x < resolution; x++) {
        const hL = this.heightmap.getHeight(Math.max(0, x - 1), z);
        const hR = this.heightmap.getHeight(Math.min(resolution - 1, x + 1), z);
        const hD = this.heightmap.getHeight(x, Math.max(0, z - 1));
        const hU = this.heightmap.getHeight(x, Math.min(resolution - 1, z + 1));

        const nx = (hL - hR) / (2 * cellSize);
        const nz = (hD - hU) / (2 * cellSize);

        // Inline normalization to avoid Vector3 object creation
        const len = Math.sqrt(nx * nx + 1 + nz * nz);
        normals.push(nx / len, 1 / len, nz / len);
      }
    }

    this.mesh.setVerticesData("normal", normals, true);
  }

  private createMaterials(): void {
    const resolution = this.heightmap.getResolution();
    console.log("[TerrainMesh] Creating materials, resolution:", resolution);

    // Create splat texture
    this.splatTexture = this.createSplatTexture();
    console.log("[TerrainMesh] Splat texture created");

    // Create water mask texture
    this.waterMaskTexture = this.createWaterMaskTexture();
    console.log("[TerrainMesh] Water mask texture created");

    // Create shader material
    try {
      this.shaderMaterial = createTerrainMaterial(
        this.scene,
        this.splatMap.getData(),
        resolution
      );
      this.shaderMaterial.setTexture("uSplatMap", this.splatTexture);
      this.shaderMaterial.setTexture("uWaterMask", this.waterMaskTexture);
      // Set initial displacement strength
      this.shaderMaterial.setFloat("uDispStrength", this.dispStrength);
      console.log("[TerrainMesh] Shader material created successfully");
    } catch (e) {
      console.error("[TerrainMesh] Failed to create shader material:", e);
      this.useShader = false;
    }

    // Create simple fallback material
    this.simpleMaterial = new StandardMaterial("terrainSimple", this.scene);
    this.simpleMaterial.diffuseColor = new Color3(0.35, 0.55, 0.2);
    this.simpleMaterial.specularColor = new Color3(0.1, 0.1, 0.1);
    this.simpleMaterial.specularPower = 16;
    console.log("[TerrainMesh] Using shader:", this.useShader);
  }

  private createSplatTexture(): RawTexture {
    const resolution = this.splatMap.getResolution();
    const data = this.splatMap.getData();
    const uint8Data = new Uint8Array(resolution * resolution * 4);

    for (let i = 0; i < resolution * resolution * 4; i++) {
      uint8Data[i] = Math.floor(data[i] * 255);
    }

    const texture = new RawTexture(
      uint8Data,
      resolution,
      resolution,
      Engine.TEXTUREFORMAT_RGBA,
      this.scene,
      false,
      false,
      Texture.BILINEAR_SAMPLINGMODE
    );

    texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    texture.wrapV = Texture.CLAMP_ADDRESSMODE;

    return texture;
  }

  private createWaterMaskTexture(): RawTexture {
    const resolution = this.splatMap.getResolution();
    const waterMask = this.splatMap.getWaterMask();
    // Use RGBA format for compatibility - store water value in R channel
    const uint8Data = new Uint8Array(resolution * resolution * 4);

    for (let i = 0; i < resolution * resolution; i++) {
      const value = Math.floor(waterMask[i] * 255);
      uint8Data[i * 4] = value;      // R
      uint8Data[i * 4 + 1] = value;  // G
      uint8Data[i * 4 + 2] = value;  // B
      uint8Data[i * 4 + 3] = 255;    // A
    }

    const texture = new RawTexture(
      uint8Data,
      resolution,
      resolution,
      Engine.TEXTUREFORMAT_RGBA,
      this.scene,
      false,
      false,
      Texture.BILINEAR_SAMPLINGMODE
    );

    texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    texture.wrapV = Texture.CLAMP_ADDRESSMODE;

    return texture;
  }

  updateWaterMaskTexture(): void {
    if (!this.waterMaskTexture) {
      console.warn("[TerrainMesh] updateWaterMaskTexture: No waterMaskTexture!");
      return;
    }

    const resolution = this.splatMap.getResolution();
    const waterMask = this.splatMap.getWaterMask();
    const uint8Data = new Uint8Array(resolution * resolution * 4);

    for (let i = 0; i < resolution * resolution; i++) {
      const value = Math.floor(waterMask[i] * 255);
      uint8Data[i * 4] = value;      // R
      uint8Data[i * 4 + 1] = value;  // G
      uint8Data[i * 4 + 2] = value;  // B
      uint8Data[i * 4 + 3] = 255;    // A
    }

    this.waterMaskTexture.update(uint8Data);
  }

  updateSplatTexture(): void {
    if (!this.splatTexture) {
      console.warn("[TerrainMesh] updateSplatTexture: No splatTexture!");
      return;
    }

    const resolution = this.splatMap.getResolution();
    const data = this.splatMap.getData();
    const uint8Data = new Uint8Array(resolution * resolution * 4);

    for (let i = 0; i < resolution * resolution; i++) {
      const idx = i * 4;
      uint8Data[idx] = Math.floor(data[idx] * 255);
      uint8Data[idx + 1] = Math.floor(data[idx + 1] * 255);
      uint8Data[idx + 2] = Math.floor(data[idx + 2] * 255);
      uint8Data[idx + 3] = Math.floor(data[idx + 3] * 255);
    }

    this.splatTexture.update(uint8Data);
  }

  getSplatMap(): SplatMap {
    return this.splatMap;
  }

  updateFromHeightmap(): void {
    // Update all LOD meshes
    for (const lod of this.lodLevels) {
      if (!lod.mesh) continue;
      this.updateMeshFromHeightmap(lod.mesh, lod.resolution);
    }
  }

  /**
   * Update a specific mesh from heightmap
   */
  private updateMeshFromHeightmap(mesh: Mesh, targetResolution: number): void {
    const baseResolution = this.heightmap.getResolution();
    const scale = this.heightmap.getScale();
    const step = Math.max(1, Math.floor((baseResolution - 1) / (targetResolution - 1)));
    const actualResolution = Math.floor((baseResolution - 1) / step) + 1;
    const cellSize = scale / (actualResolution - 1);

    const positions = mesh.getVerticesData("position");
    if (!positions) return;

    for (let z = 0; z < actualResolution; z++) {
      for (let x = 0; x < actualResolution; x++) {
        const idx = (z * actualResolution + x) * 3;
        const hx = Math.min(x * step, baseResolution - 1);
        const hz = Math.min(z * step, baseResolution - 1);
        positions[idx + 1] = this.heightmap.getHeight(hx, hz);
      }
    }

    mesh.setVerticesData("position", positions, true);
    this.calculateNormalsForMesh(mesh, actualResolution, cellSize, Array.from(positions));
    mesh.refreshBoundingInfo();
  }

  /**
   * Set displacement strength (updates GPU shader uniform)
   */
  setDispStrength(strength: number): void {
    this.dispStrength = strength;
    if (this.shaderMaterial) {
      this.shaderMaterial.setFloat("uDispStrength", strength);
    }
  }

  /**
   * Get current displacement strength
   */
  getDispStrength(): number {
    return this.dispStrength;
  }

  /**
   * Enable/disable LOD system
   */
  setLODEnabled(enabled: boolean): void {
    this.lodEnabled = enabled;
    if (!enabled) {
      // Switch back to highest quality
      this.switchLOD(0);
    }
  }

  /**
   * Get current LOD level info
   */
  getCurrentLODInfo(): { level: number; resolution: number; totalLevels: number } {
    return {
      level: this.currentLOD,
      resolution: this.lodLevels[this.currentLOD]?.resolution || 0,
      totalLevels: this.lodLevels.length,
    };
  }

  setWireframe(enabled: boolean): void {
    if (this.shaderMaterial) {
      this.shaderMaterial.wireframe = enabled;
    }
    if (this.simpleMaterial) {
      this.simpleMaterial.wireframe = enabled;
    }
  }

  setSplatMapEnabled(enabled: boolean): void {
    if (this.shaderMaterial) {
      this.shaderMaterial.setFloat("uUseSplatMap", enabled ? 1.0 : 0.0);
    }
  }

  setDebugMode(mode: number): void {
    if (this.shaderMaterial) {
      this.shaderMaterial.setInt("uDebugMode", mode);
    }
  }

  setUseShader(use: boolean): void {
    this.useShader = use;
    // Update material for all LOD meshes
    for (const lod of this.lodLevels) {
      if (lod.mesh) {
        lod.mesh.material = use ? this.shaderMaterial : this.simpleMaterial;
      }
    }
  }

  getMesh(): Mesh | null {
    return this.mesh;
  }

  getMaterial(): Material | null {
    return this.useShader ? this.shaderMaterial : this.simpleMaterial;
  }

  /**
   * Create a mesh with displacement baked into vertices for export
   * This replicates what the vertex shader does but on CPU
   */
  createBakedMeshForExport(): Mesh | null {
    if (!this.dispTextureLoaded || !this.dispTextureData) {
      console.warn("[TerrainMesh] Displacement texture not loaded yet, exporting without displacement");
    }

    const resolution = this.heightmap.getResolution();
    const scale = this.heightmap.getScale();
    const cellSize = scale / (resolution - 1);

    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    // Create vertices with baked displacement
    for (let z = 0; z < resolution; z++) {
      for (let x = 0; x < resolution; x++) {
        const worldX = x * cellSize;
        const worldZ = z * cellSize;
        
        // Base height from heightmap
        let height = this.heightmap.getHeight(x, z);
        
        // Add displacement for rock areas (same logic as vertex shader)
        if (this.dispTextureData) {
          const weights = this.splatMap.getWeights(x, z);
          const rockWeight = weights[2];  // index 2 = rock (blue channel)
          
          if (rockWeight > 0) {
            const dispValue = this.sampleDisplacement(worldX, worldZ);
            // Same formula as vertex shader: (dispValue - 0.5) * strength * rockWeight
            height += (dispValue - 0.5) * this.dispStrength * rockWeight;
          }
        }
        
        positions.push(worldX, height, worldZ);
        uvs.push(x / (resolution - 1), z / (resolution - 1));
        normals.push(0, 1, 0);
      }
    }

    // Create indices
    for (let z = 0; z < resolution - 1; z++) {
      for (let x = 0; x < resolution - 1; x++) {
        const topLeft = z * resolution + x;
        const topRight = topLeft + 1;
        const bottomLeft = (z + 1) * resolution + x;
        const bottomRight = bottomLeft + 1;

        indices.push(topLeft, bottomLeft, topRight);
        indices.push(topRight, bottomLeft, bottomRight);
      }
    }

    // Create export mesh
    const exportMesh = new Mesh("terrain_export", this.scene);

    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.uvs = uvs;
    vertexData.applyToMesh(exportMesh, false);

    // Calculate normals for baked mesh
    const bakedNormals: number[] = [];
    for (let z = 0; z < resolution; z++) {
      for (let x = 0; x < resolution; x++) {
        const idx = (z * resolution + x) * 3;
        const idxL = (z * resolution + Math.max(0, x - 1)) * 3;
        const idxR = (z * resolution + Math.min(resolution - 1, x + 1)) * 3;
        const idxD = (Math.max(0, z - 1) * resolution + x) * 3;
        const idxU = (Math.min(resolution - 1, z + 1) * resolution + x) * 3;

        const hL = positions[idxL + 1];
        const hR = positions[idxR + 1];
        const hD = positions[idxD + 1];
        const hU = positions[idxU + 1];

        const nx = (hL - hR) / (2 * cellSize);
        const nz = (hD - hU) / (2 * cellSize);

        // Inline normalization to avoid Vector3 object creation
        const len = Math.sqrt(nx * nx + 1 + nz * nz);
        bakedNormals.push(nx / len, 1 / len, nz / len);
      }
    }
    exportMesh.setVerticesData("normal", bakedNormals, false);

    // Apply simple material for export (shader won't work in GLB)
    const exportMaterial = new StandardMaterial("terrain_export_mat", this.scene);
    exportMaterial.diffuseColor = new Color3(0.5, 0.5, 0.5);
    exportMesh.material = exportMaterial;

    console.log("[TerrainMesh] Created baked mesh for export with", positions.length / 3, "vertices");
    return exportMesh;
  }

  dispose(): void {
    // Remove render observer
    if (this.beforeRenderObserver) {
      this.scene.onBeforeRenderObservable.remove(this.beforeRenderObserver);
      this.beforeRenderObserver = null;
    }

    // Dispose all LOD meshes
    for (const lod of this.lodLevels) {
      if (lod.mesh) {
        lod.mesh.dispose();
        lod.mesh = null;
      }
    }
    this.lodLevels = [];
    this.mesh = null;

    if (this.shaderMaterial) {
      this.shaderMaterial.dispose();
      this.shaderMaterial = null;
    }
    if (this.simpleMaterial) {
      this.simpleMaterial.dispose();
      this.simpleMaterial = null;
    }
    if (this.splatTexture) {
      this.splatTexture.dispose();
      this.splatTexture = null;
    }
    if (this.waterMaskTexture) {
      this.waterMaskTexture.dispose();
      this.waterMaskTexture = null;
    }
  }
}
