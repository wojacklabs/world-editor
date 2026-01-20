/**
 * ManualTileManager - Manages independent terrain tiles for manual world building
 *
 * This system allows users to:
 * 1. Create new terrain tiles with their own heightmap, splatmap, and water data
 * 2. Save/export individual tiles
 * 3. Load tiles from saved data
 * 4. Connect tiles with direction-aware seamless stitching
 */

export type SeamlessDirection = "left" | "right" | "top" | "bottom";

/**
 * Serialized tile data for saving/loading
 */
export interface TileData {
  id: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  resolution: number; // Heightmap resolution
  size: number; // World size
  heightmap: string; // Base64 encoded Float32Array
  splatmap: string; // Base64 encoded Float32Array (4 channels)
  waterMask: string; // Base64 encoded Float32Array
  seaLevel: number;
  waterDepth: number;
  // Connection info: which tiles connect where
  connections: {
    left?: string;   // Tile ID connected to left edge
    right?: string;
    top?: string;
    bottom?: string;
  };
}

/**
 * Active tile in memory
 */
export interface ActiveTile {
  id: string;
  name: string;
  isDirty: boolean;
  heightmapData: Float32Array;
  splatmapData: Float32Array;
  waterMaskData: Float32Array;
  resolution: number;
  size: number;
  seaLevel: number;
  waterDepth: number;
  connections: {
    left?: string;
    right?: string;
    top?: string;
    bottom?: string;
  };
}

/**
 * Tile reference for the tile list (lightweight)
 */
export interface TileRef {
  id: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  resolution: number;
  size: number;
  hasConnections: boolean;
}

export class ManualTileManager {
  private tiles: Map<string, TileData> = new Map();
  private activeTileId: string | null = null;

  constructor() {
    // Load tiles from localStorage on init
    this.loadFromStorage();
  }

  /**
   * Create a new blank tile
   */
  createTile(name: string, resolution: number = 512, size: number = 64): string {
    const id = this.generateId();
    const now = new Date().toISOString();

    // Create blank heightmap
    const res = resolution + 1;
    const heightmapData = new Float32Array(res * res);

    // Create default splatmap (all grass)
    const splatmapData = new Float32Array(res * res * 4);
    for (let i = 0; i < res * res; i++) {
      splatmapData[i * 4] = 1; // Grass
      splatmapData[i * 4 + 1] = 0; // Dirt
      splatmapData[i * 4 + 2] = 0; // Rock
      splatmapData[i * 4 + 3] = 0; // Sand
    }

    // Create blank water mask
    const waterMaskData = new Float32Array(res * res);

    const tileData: TileData = {
      id,
      name,
      createdAt: now,
      modifiedAt: now,
      resolution,
      size,
      heightmap: this.encodeFloat32Array(heightmapData),
      splatmap: this.encodeFloat32Array(splatmapData),
      waterMask: this.encodeFloat32Array(waterMaskData),
      seaLevel: -100,
      waterDepth: 2.0,
      connections: {},
    };

    this.tiles.set(id, tileData);
    this.saveToStorage();

    return id;
  }

  /**
   * Save current terrain state as a new tile or update existing
   */
  saveTileFromCurrent(
    name: string,
    heightmapData: Float32Array,
    splatmapData: Float32Array,
    waterMaskData: Float32Array,
    resolution: number,
    size: number,
    seaLevel: number,
    waterDepth: number,
    existingId?: string
  ): string {
    const id = existingId || this.generateId();
    const now = new Date().toISOString();

    const existingTile = existingId ? this.tiles.get(existingId) : null;

    const tileData: TileData = {
      id,
      name,
      createdAt: existingTile?.createdAt || now,
      modifiedAt: now,
      resolution,
      size,
      heightmap: this.encodeFloat32Array(heightmapData),
      splatmap: this.encodeFloat32Array(splatmapData),
      waterMask: this.encodeFloat32Array(waterMaskData),
      seaLevel,
      waterDepth,
      connections: existingTile?.connections || {},
    };

    this.tiles.set(id, tileData);
    this.activeTileId = id;
    this.saveToStorage();

    return id;
  }

  /**
   * Load a tile by ID and return the data
   */
  loadTile(id: string): ActiveTile | null {
    const tileData = this.tiles.get(id);
    if (!tileData) return null;

    this.activeTileId = id;

    return {
      id: tileData.id,
      name: tileData.name,
      isDirty: false,
      heightmapData: this.decodeFloat32Array(tileData.heightmap),
      splatmapData: this.decodeFloat32Array(tileData.splatmap),
      waterMaskData: this.decodeFloat32Array(tileData.waterMask),
      resolution: tileData.resolution,
      size: tileData.size,
      seaLevel: tileData.seaLevel,
      waterDepth: tileData.waterDepth,
      connections: { ...tileData.connections },
    };
  }

  /**
   * Delete a tile
   */
  deleteTile(id: string): void {
    // Remove connections from other tiles
    for (const [, tile] of this.tiles) {
      if (tile.connections.left === id) tile.connections.left = undefined;
      if (tile.connections.right === id) tile.connections.right = undefined;
      if (tile.connections.top === id) tile.connections.top = undefined;
      if (tile.connections.bottom === id) tile.connections.bottom = undefined;
    }

    this.tiles.delete(id);
    if (this.activeTileId === id) {
      this.activeTileId = null;
    }
    this.saveToStorage();
  }

  /**
   * Connect two tiles in a specified direction
   * This marks which tiles should have their edges aligned
   */
  connectTiles(sourceTileId: string, targetTileId: string, direction: SeamlessDirection): void {
    const sourceTile = this.tiles.get(sourceTileId);
    const targetTile = this.tiles.get(targetTileId);

    if (!sourceTile || !targetTile) return;

    // Set connection on source tile
    sourceTile.connections[direction] = targetTileId;

    // Set opposite connection on target tile
    const oppositeDir: Record<SeamlessDirection, SeamlessDirection> = {
      left: "right",
      right: "left",
      top: "bottom",
      bottom: "top",
    };
    targetTile.connections[oppositeDir[direction]] = sourceTileId;

    this.saveToStorage();
  }

  /**
   * Disconnect tiles
   */
  disconnectTiles(sourceTileId: string, direction: SeamlessDirection): void {
    const sourceTile = this.tiles.get(sourceTileId);
    if (!sourceTile) return;

    const targetTileId = sourceTile.connections[direction];
    if (targetTileId) {
      const targetTile = this.tiles.get(targetTileId);
      if (targetTile) {
        const oppositeDir: Record<SeamlessDirection, SeamlessDirection> = {
          left: "right",
          right: "left",
          top: "bottom",
          bottom: "top",
        };
        targetTile.connections[oppositeDir[direction]] = undefined;
      }
    }

    sourceTile.connections[direction] = undefined;
    this.saveToStorage();
  }

  /**
   * Get edge data from a tile for seamless stitching
   * Returns the height and splat data for the specified edge
   */
  getEdgeData(tileId: string, edge: SeamlessDirection): {
    heights: Float32Array;
    splats: Float32Array;
    water: Float32Array;
  } | null {
    const tileData = this.tiles.get(tileId);
    if (!tileData) return null;

    const heightmap = this.decodeFloat32Array(tileData.heightmap);
    const splatmap = this.decodeFloat32Array(tileData.splatmap);
    const waterMask = this.decodeFloat32Array(tileData.waterMask);
    const res = tileData.resolution + 1;

    const heights = new Float32Array(res);
    const splats = new Float32Array(res * 4);
    const water = new Float32Array(res);

    if (edge === "left") {
      for (let z = 0; z < res; z++) {
        heights[z] = heightmap[z * res + 0];
        water[z] = waterMask[z * res + 0];
        for (let c = 0; c < 4; c++) {
          splats[z * 4 + c] = splatmap[(z * res + 0) * 4 + c];
        }
      }
    } else if (edge === "right") {
      for (let z = 0; z < res; z++) {
        heights[z] = heightmap[z * res + (res - 1)];
        water[z] = waterMask[z * res + (res - 1)];
        for (let c = 0; c < 4; c++) {
          splats[z * 4 + c] = splatmap[(z * res + (res - 1)) * 4 + c];
        }
      }
    } else if (edge === "top") {
      for (let x = 0; x < res; x++) {
        heights[x] = heightmap[0 * res + x];
        water[x] = waterMask[0 * res + x];
        for (let c = 0; c < 4; c++) {
          splats[x * 4 + c] = splatmap[(0 * res + x) * 4 + c];
        }
      }
    } else {
      // bottom
      for (let x = 0; x < res; x++) {
        heights[x] = heightmap[(res - 1) * res + x];
        water[x] = waterMask[(res - 1) * res + x];
        for (let c = 0; c < 4; c++) {
          splats[x * 4 + c] = splatmap[((res - 1) * res + x) * 4 + c];
        }
      }
    }

    return { heights, splats, water };
  }

  /**
   * Get list of all tiles (lightweight refs)
   */
  getTileList(): TileRef[] {
    const refs: TileRef[] = [];
    for (const [, tile] of this.tiles) {
      refs.push({
        id: tile.id,
        name: tile.name,
        createdAt: tile.createdAt,
        modifiedAt: tile.modifiedAt,
        resolution: tile.resolution,
        size: tile.size,
        hasConnections:
          !!tile.connections.left ||
          !!tile.connections.right ||
          !!tile.connections.top ||
          !!tile.connections.bottom,
      });
    }
    return refs.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }

  /**
   * Get tile data by ID
   */
  getTile(id: string): TileData | undefined {
    return this.tiles.get(id);
  }

  /**
   * Get active tile ID
   */
  getActiveTileId(): string | null {
    return this.activeTileId;
  }

  /**
   * Set active tile
   */
  setActiveTileId(id: string | null): void {
    this.activeTileId = id;
  }

  /**
   * Get connected tile data for a direction
   */
  getConnectedTile(tileId: string, direction: SeamlessDirection): TileData | null {
    const tile = this.tiles.get(tileId);
    if (!tile) return null;

    const connectedId = tile.connections[direction];
    if (!connectedId) return null;

    return this.tiles.get(connectedId) || null;
  }

  /**
   * Export a tile to JSON
   */
  exportTile(id: string): string | null {
    const tile = this.tiles.get(id);
    if (!tile) return null;
    return JSON.stringify(tile);
  }

  /**
   * Import a tile from JSON
   */
  importTile(json: string): string | null {
    try {
      const tileData = JSON.parse(json) as TileData;

      // Generate new ID to avoid conflicts
      const newId = this.generateId();
      tileData.id = newId;
      tileData.modifiedAt = new Date().toISOString();

      // Clear connections since they reference other IDs
      tileData.connections = {};

      this.tiles.set(newId, tileData);
      this.saveToStorage();

      return newId;
    } catch {
      console.error("Failed to import tile");
      return null;
    }
  }

  /**
   * Rename a tile
   */
  renameTile(id: string, name: string): void {
    const tile = this.tiles.get(id);
    if (tile) {
      tile.name = name;
      tile.modifiedAt = new Date().toISOString();
      this.saveToStorage();
    }
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return `tile_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Encode Float32Array to Base64
   */
  private encodeFloat32Array(arr: Float32Array): string {
    const uint8 = new Uint8Array(arr.buffer);
    let binary = "";
    for (let i = 0; i < uint8.length; i++) {
      binary += String.fromCharCode(uint8[i]);
    }
    return btoa(binary);
  }

  /**
   * Decode Base64 to Float32Array
   */
  private decodeFloat32Array(base64: string): Float32Array {
    const binary = atob(base64);
    const uint8 = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      uint8[i] = binary.charCodeAt(i);
    }
    return new Float32Array(uint8.buffer);
  }

  /**
   * Check if running in browser
   */
  private isBrowser(): boolean {
    return typeof window !== "undefined" && typeof localStorage !== "undefined";
  }

  /**
   * Save to localStorage
   */
  private saveToStorage(): void {
    if (!this.isBrowser()) return;

    try {
      const data: TileData[] = [];
      for (const [, tile] of this.tiles) {
        data.push(tile);
      }
      localStorage.setItem("worldEditor_manualTiles", JSON.stringify(data));
    } catch (e) {
      console.warn("Failed to save tiles to localStorage:", e);
    }
  }

  /**
   * Load from localStorage
   */
  private loadFromStorage(): void {
    if (!this.isBrowser()) return;

    try {
      const json = localStorage.getItem("worldEditor_manualTiles");
      if (json) {
        const data = JSON.parse(json) as TileData[];
        for (const tile of data) {
          this.tiles.set(tile.id, tile);
        }
      }
    } catch (e) {
      console.warn("Failed to load tiles from localStorage:", e);
    }
  }
}

// Singleton instance
let manualTileManagerInstance: ManualTileManager | null = null;

export function getManualTileManager(): ManualTileManager {
  if (!manualTileManagerInstance) {
    manualTileManagerInstance = new ManualTileManager();
  }
  return manualTileManagerInstance;
}
