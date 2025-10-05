import { Scene } from "@babylonjs/core";
import { TerrainTile, TileType, TileConfig, TILE_COLORS } from "./TerrainTile";

export interface TileGridConfig {
  rows: number;
  cols: number;
  tileWidth: number;   // World units per tile
  tileHeight: number;  // World units per tile
  blendWidth: number;  // Edge blend zone width (0-1, percentage of tile)
}

export interface TileData {
  row: number;
  col: number;
  type: TileType;
}

/**
 * Manages a grid of terrain tiles with automatic edge blending
 */
export class TerrainTileManager {
  private scene: Scene;
  private config: TileGridConfig;
  private tiles: Map<string, TerrainTile> = new Map();
  private tileTypes: TileType[][] = [];

  constructor(scene: Scene, config: TileGridConfig) {
    this.scene = scene;
    this.config = config;

    // Initialize tile types grid with default (grass)
    for (let r = 0; r < config.rows; r++) {
      this.tileTypes[r] = [];
      for (let c = 0; c < config.cols; c++) {
        this.tileTypes[r][c] = "grass";
      }
    }
  }

  /**
   * Generate all tiles in the grid
   */
  generate(): void {
    this.disposeAll();

    const { rows, cols, tileWidth, tileHeight } = this.config;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const tileConfig: TileConfig = {
          type: this.tileTypes[r][c],
          row: r,
          col: c,
          width: tileWidth,
          height: tileHeight,
        };

        const tile = new TerrainTile(this.scene, tileConfig);
        tile.generate();

        const key = this.getTileKey(r, c);
        this.tiles.set(key, tile);
      }
    }

    // Apply edge blending after all tiles are created
    this.updateAllEdgeBlending();
  }

  /**
   * Set tile type at position
   */
  setTileType(row: number, col: number, type: TileType): void {
    if (row < 0 || row >= this.config.rows || col < 0 || col >= this.config.cols) {
      return;
    }

    this.tileTypes[row][col] = type;

    // Regenerate affected tile
    const key = this.getTileKey(row, col);
    const existingTile = this.tiles.get(key);
    if (existingTile) {
      existingTile.dispose();
    }

    const tileConfig: TileConfig = {
      type,
      row,
      col,
      width: this.config.tileWidth,
      height: this.config.tileHeight,
    };

    const newTile = new TerrainTile(this.scene, tileConfig);
    newTile.generate();
    this.tiles.set(key, newTile);

    // Update edge blending for this tile and neighbors
    this.updateEdgeBlendingForTile(row, col);
    this.updateEdgeBlendingForTile(row - 1, col);
    this.updateEdgeBlendingForTile(row + 1, col);
    this.updateEdgeBlendingForTile(row, col - 1);
    this.updateEdgeBlendingForTile(row, col + 1);
  }

  /**
   * Get tile type at position
   */
  getTileType(row: number, col: number): TileType | null {
    if (row < 0 || row >= this.config.rows || col < 0 || col >= this.config.cols) {
      return null;
    }
    return this.tileTypes[row][col];
  }

  /**
   * Get all tile data for serialization
   */
  getAllTileData(): TileData[] {
    const data: TileData[] = [];
    for (let r = 0; r < this.config.rows; r++) {
      for (let c = 0; c < this.config.cols; c++) {
        data.push({
          row: r,
          col: c,
          type: this.tileTypes[r][c],
        });
      }
    }
    return data;
  }

  /**
   * Load tile data from serialized format
   */
  loadTileData(data: TileData[]): void {
    for (const tile of data) {
      if (tile.row >= 0 && tile.row < this.config.rows &&
          tile.col >= 0 && tile.col < this.config.cols) {
        this.tileTypes[tile.row][tile.col] = tile.type;
      }
    }
    this.generate();
  }

  /**
   * Update grid size (regenerates all tiles)
   */
  setGridSize(rows: number, cols: number): void {
    const oldTypes = this.tileTypes;

    // Resize and preserve existing types where possible
    this.tileTypes = [];
    for (let r = 0; r < rows; r++) {
      this.tileTypes[r] = [];
      for (let c = 0; c < cols; c++) {
        if (oldTypes[r] && oldTypes[r][c]) {
          this.tileTypes[r][c] = oldTypes[r][c];
        } else {
          this.tileTypes[r][c] = "grass";
        }
      }
    }

    this.config.rows = rows;
    this.config.cols = cols;
    this.generate();
  }

  /**
   * Update tile size (regenerates all tiles)
   */
  setTileSize(width: number, height: number): void {
    this.config.tileWidth = width;
    this.config.tileHeight = height;
    this.generate();
  }

  /**
   * Get current configuration
   */
  getConfig(): TileGridConfig {
    return { ...this.config };
  }

  /**
   * Update edge blending for all tiles
   */
  private updateAllEdgeBlending(): void {
    for (let r = 0; r < this.config.rows; r++) {
      for (let c = 0; c < this.config.cols; c++) {
        this.updateEdgeBlendingForTile(r, c);
      }
    }
  }

  /**
   * Update edge blending for a specific tile based on neighbors
   */
  private updateEdgeBlendingForTile(row: number, col: number): void {
    if (row < 0 || row >= this.config.rows || col < 0 || col >= this.config.cols) {
      return;
    }

    const key = this.getTileKey(row, col);
    const tile = this.tiles.get(key);
    if (!tile) return;

    const currentType = this.tileTypes[row][col];

    // Check all 4 neighbors
    const neighbors: (TileType | null)[] = [
      this.getTileType(row - 1, col), // North
      this.getTileType(row + 1, col), // South
      this.getTileType(row, col - 1), // West
      this.getTileType(row, col + 1), // East
    ];

    // Find different neighbor types for blending
    let blendNeeded = false;
    let blendType: TileType = currentType;

    for (const neighbor of neighbors) {
      if (neighbor && neighbor !== currentType) {
        blendNeeded = true;
        blendType = neighbor;
        break;
      }
    }

    if (blendNeeded) {
      tile.setEdgeBlend(this.config.blendWidth * 0.3, blendType);
    } else {
      tile.setEdgeBlend(0, currentType);
    }
  }

  /**
   * Get tile key for map
   */
  private getTileKey(row: number, col: number): string {
    return `${row}_${col}`;
  }

  /**
   * Get world bounds
   */
  getWorldBounds(): { minX: number; maxX: number; minZ: number; maxZ: number } {
    return {
      minX: 0,
      maxX: this.config.cols * this.config.tileWidth,
      minZ: 0,
      maxZ: this.config.rows * this.config.tileHeight,
    };
  }

  /**
   * Get tile at world position
   */
  getTileAtPosition(worldX: number, worldZ: number): { row: number; col: number } | null {
    const col = Math.floor(worldX / this.config.tileWidth);
    const row = Math.floor(worldZ / this.config.tileHeight);

    if (row >= 0 && row < this.config.rows && col >= 0 && col < this.config.cols) {
      return { row, col };
    }
    return null;
  }

  /**
   * Dispose all tiles
   */
  disposeAll(): void {
    for (const tile of this.tiles.values()) {
      tile.dispose();
    }
    this.tiles.clear();
  }
}
