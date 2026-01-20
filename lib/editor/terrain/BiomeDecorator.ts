import {
  Scene,
  Mesh,
  MeshBuilder,
  Vector2,
  Vector3,
  Color3,
  Texture,
} from "@babylonjs/core";
import { Heightmap } from "./Heightmap";
import { TerrainMesh } from "./TerrainMesh";
import { WaterSystem, WaterConfig, DEFAULT_WATER_CONFIG } from "./WaterShader";

export class BiomeDecorator {
  private scene: Scene;
  private heightmap: Heightmap;
  private terrainMesh: TerrainMesh;

  // Water (Enterprise-grade water system)
  private waterSystem: WaterSystem | null = null;
  private waterLevel: number = -100;  // Default below terrain, synced with EditorEngine.seaLevel
  private useFixedSeaLevel: boolean = false;  // If true, use waterLevel directly instead of calculating

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
   * Water biome: Enterprise-grade water with Gerstner waves
   * Features: Fresnel, depth-based transparency, foam, realistic waves
   */
  private buildWater(): void {
    // Collect water positions from dedicated water mask
    const validPositions = this.collectWaterPositions(0.3);

    if (validPositions.length < 4) {
      return;
    }

    // Calculate bounding box of water region
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;

    for (const pos of validPositions) {
      minX = Math.min(minX, pos.x);
      maxX = Math.max(maxX, pos.x);
      minZ = Math.min(minZ, pos.z);
      maxZ = Math.max(maxZ, pos.z);
    }

    // Use fixed sea level (set by EditorEngine)
    // The terrain has been carved by carveWaterBasin, so water sits at seaLevel
    // and terrain goes below it

    // Create water plane matching the painted area with generous padding
    // The padding ensures water extends beyond the painted area for smooth edges
    const padding = 3.0;
    const waterWidth = Math.max(maxX - minX + padding * 2, 4);
    const waterDepth = Math.max(maxZ - minZ + padding * 2, 4);
    const centerX = (minX + maxX) / 2;
    const centerZ = (minZ + maxZ) / 2;

    // Initialize water system if needed
    if (!this.waterSystem) {
      this.waterSystem = new WaterSystem(this.scene, this.heightmap);
    }

    // Create water with the fixed sea level
    this.waterSystem.createWater(
      centerX,
      centerZ,
      waterWidth,
      waterDepth,
      this.waterLevel  // Use the seaLevel set by EditorEngine
    );

    console.log(`[BiomeDecorator] Water created at level ${this.waterLevel}, size: ${waterWidth}x${waterDepth}`);
  }

  /**
   * Update water level
   */
  setWaterLevel(level: number): void {
    this.waterLevel = level;
    if (this.waterSystem) {
      this.waterSystem.setWaterLevel(level);
    }
  }

  getWaterLevel(): number {
    return this.waterLevel;
  }

  /**
   * Get the water system for external access
   */
  getWaterSystem(): WaterSystem | null {
    return this.waterSystem;
  }

  /**
   * Set visibility of all biome decorations (for debugging)
   * Note: Water visibility is handled separately via setWaterVisible
   */
  setVisible(visible: boolean): void {
    // Currently BiomeDecorator doesn't create visible meshes other than water
    // Water is controlled separately via EditorEngine.setWaterVisible
    // This method is for future decoration meshes (grass clumps, etc.)
  }

  /**
   * Dispose water system
   */
  private disposeDecorations(): void {
    if (this.waterSystem) {
      this.waterSystem.dispose();
    }
  }

  /**
   * Full cleanup
   */
  dispose(): void {
    this.disposeDecorations();
    if (this.waterSystem) {
      this.waterSystem.disposeAll();
      this.waterSystem = null;
    }
  }
}
