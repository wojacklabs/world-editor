import {
  Scene,
  Mesh,
  MeshBuilder,
  Vector2,
  Vector3,
  Color3,
  Texture,
} from "@babylonjs/core";
import { WaterMaterial } from "@babylonjs/materials";
import { Heightmap } from "./Heightmap";
import { TerrainMesh } from "./TerrainMesh";

export class BiomeDecorator {
  private scene: Scene;
  private heightmap: Heightmap;
  private terrainMesh: TerrainMesh;

  // Water
  private waterMesh: Mesh | null = null;
  private waterMaterial: WaterMaterial | null = null;
  private waterLevel: number = 0;

  constructor(scene: Scene, heightmap: Heightmap, terrainMesh: TerrainMesh) {
    this.scene = scene;
    this.heightmap = heightmap;
    this.terrainMesh = terrainMesh;
  }

  /**
   * Rebuild all biome decorations based on current SplatMap
   */
  rebuildAll(): void {
    this.disposeDecorations();

    this.buildGrassDecorations();
    this.buildDirtDecorations();
    this.buildSandDecorations();
    this.buildWater();
  }

  /**
   * Collect valid positions from SplatMap where a specific channel has weight above threshold
   */
  private collectValidPositions(channel: number, threshold: number): Array<{x: number, z: number, weight: number}> {
    const splatMap = this.terrainMesh.getSplatMap();
    const scale = this.heightmap.getScale();
    const resolution = splatMap.getResolution();
    const positions: Array<{x: number, z: number, weight: number}> = [];

    for (let sz = 0; sz < resolution; sz++) {
      for (let sx = 0; sx < resolution; sx++) {
        const weights = splatMap.getWeights(sx, sz);
        const weight = weights[channel];
        
        if (weight >= threshold) {
          // Convert splat coords to world coords
          const worldX = (sx / (resolution - 1)) * scale;
          const worldZ = (sz / (resolution - 1)) * scale;
          positions.push({ x: worldX, z: worldZ, weight });
        }
      }
    }

    return positions;
  }

  /**
   * Grass biome: grass clumps + trees
   * NOTE: Grass is the DEFAULT biome (weight=1.0 initially).
   * Terrain shader handles grass texture.
   */
  private buildGrassDecorations(): void {
    // Skip grass decorations - terrain shader handles grass texture
  }

  /**
   * Dirt biome: terrain shader handles the dirt texture
   * No SPS decorations needed - dirt is just ground texture
   */
  private buildDirtDecorations(): void {
    // Dirt biome uses terrain shader only
  }

  /**
   * Sand biome: terrain shader handles the sand texture
   * No SPS decorations needed - sand is just ground texture
   */
  private buildSandDecorations(): void {
    // Sand biome uses terrain shader only
  }

  /**
   * Collect water positions from the separate water mask
   */
  private collectWaterPositions(threshold: number): Array<{x: number, z: number, weight: number}> {
    const splatMap = this.terrainMesh.getSplatMap();
    const scale = this.heightmap.getScale();
    const resolution = splatMap.getResolution();
    const positions: Array<{x: number, z: number, weight: number}> = [];

    for (let sz = 0; sz < resolution; sz++) {
      for (let sx = 0; sx < resolution; sx++) {
        const weight = splatMap.getWaterWeight(sx, sz);
        
        if (weight >= threshold) {
          // Convert splat coords to world coords
          const worldX = (sx / (resolution - 1)) * scale;
          const worldZ = (sz / (resolution - 1)) * scale;
          positions.push({ x: worldX, z: worldZ, weight });
        }
      }
    }

    return positions;
  }

  /**
   * Water biome: WaterMaterial on water regions
   * Following official Babylon.js WaterMaterial documentation
   */
  private buildWater(): void {
    // Collect water positions from dedicated water mask
    const validPositions = this.collectWaterPositions(0.3);
    
    if (validPositions.length < 4) {
      return;
    }

    // Calculate bounding box of water region
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    let totalHeight = 0;
    let minHeight = Infinity;

    for (const pos of validPositions) {
      minX = Math.min(minX, pos.x);
      maxX = Math.max(maxX, pos.x);
      minZ = Math.min(minZ, pos.z);
      maxZ = Math.max(maxZ, pos.z);
      const h = this.heightmap.getInterpolatedHeight(pos.x, pos.z);
      totalHeight += h;
      minHeight = Math.min(minHeight, h);
    }

    // Water level: above the average terrain height in the painted region
    const avgHeight = totalHeight / validPositions.length;
    this.waterLevel = avgHeight + 0.5;  // Water sits above the terrain

    // Create water plane matching the painted area closely
    const padding = 0.5; // Small padding around painted area
    const waterWidth = Math.max(maxX - minX + padding * 2, 2);
    const waterDepth = Math.max(maxZ - minZ + padding * 2, 2);
    const centerX = (minX + maxX) / 2;
    const centerZ = (minZ + maxZ) / 2;

    // Create a simple flat ground for water (as per Babylon.js docs)
    this.waterMesh = MeshBuilder.CreateGround(
      "waterMesh",
      {
        width: waterWidth,
        height: waterDepth,
        subdivisions: 32,  // Smooth subdivisions for wave effect
      },
      this.scene
    );

    this.waterMesh.position.set(centerX, this.waterLevel, centerZ);

    // Create WaterMaterial following official documentation
    // Reference: https://doc.babylonjs.com/toolsAndResources/assetLibraries/materialsLibrary/waterMat/
    this.waterMaterial = new WaterMaterial("waterMaterial", this.scene, new Vector2(512, 512));
    
    // Bump texture is required for water to render properly
    this.waterMaterial.bumpTexture = new Texture("/textures/waterbump.png", this.scene);
    
    // Water appearance settings - gentler waves
    this.waterMaterial.windForce = -5;         // Reduced wind strength
    this.waterMaterial.waveHeight = 0.1;       // Lower wave amplitude (was 0.5)
    this.waterMaterial.bumpHeight = 0.1;       // Bump intensity
    this.waterMaterial.waveLength = 0.1;       // Lower wave frequency
    this.waterMaterial.windDirection = new Vector2(1.0, 1.0);
    
    // Water color
    this.waterMaterial.waterColor = new Color3(0.1, 0.3, 0.5);
    this.waterMaterial.waterColor2 = new Color3(0.1, 0.3, 0.5);
    this.waterMaterial.colorBlendFactor = 0.3;
    
    // Transparency and blending
    this.waterMaterial.alpha = 0.9;
    this.waterMaterial.backFaceCulling = true;

    // Add meshes to render list for reflections/refractions
    const terrainMesh = this.terrainMesh.getMesh();
    if (terrainMesh) {
      this.waterMaterial.addToRenderList(terrainMesh);
    }

    this.waterMesh.material = this.waterMaterial;
  }

  /**
   * Update water level
   */
  setWaterLevel(level: number): void {
    this.waterLevel = level;
    if (this.waterMesh) {
      this.waterMesh.position.y = level;
    }
  }

  getWaterLevel(): number {
    return this.waterLevel;
  }

  /**
   * Dispose water mesh and material
   */
  private disposeDecorations(): void {
    if (this.waterMesh) {
      this.waterMesh.dispose();
      this.waterMesh = null;
    }
    if (this.waterMaterial) {
      this.waterMaterial.dispose();
      this.waterMaterial = null;
    }
  }

  /**
   * Full cleanup
   */
  dispose(): void {
    this.disposeDecorations();
  }
}
