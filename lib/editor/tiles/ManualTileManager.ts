/**
 * ManualTileManager - Template Library for terrain tiles
 *
 * This system allows users to:
 * 1. Create new terrain tiles with their own heightmap, splatmap, and water data
 * 2. Save/export individual tiles
 * 3. Load tiles from saved data
 */

import { DataCodec } from "../../loader";

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
  // Foliage instance data: type -> Base64 encoded matrices
  foliageData?: Record<string, string>;
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
  foliageData?: Record<string, string>;
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
}

export class ManualTileManager {
  private tiles: Map<string, TileData> = new Map();
  private activeTileId: string | null = null;
  private dbReady: Promise<void>;
  private db: IDBDatabase | null = null;
  private static DB_NAME = "WorldEditorTiles";
  private static DB_VERSION = 1;
  private static STORE_NAME = "tiles";

  constructor() {
    // Initialize IndexedDB and load data
    this.dbReady = this.initIndexedDB();
  }

  /**
   * Initialize IndexedDB
   */
  private async initIndexedDB(): Promise<void> {
    if (typeof window === "undefined" || !window.indexedDB) {
      console.warn("[ManualTileManager] IndexedDB not available");
      return;
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(ManualTileManager.DB_NAME, ManualTileManager.DB_VERSION);

      request.onerror = () => {
        console.error("[ManualTileManager] Failed to open IndexedDB:", request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        console.log("[ManualTileManager] IndexedDB opened successfully");
        // Load tiles after DB is ready
        this.loadTilesFromIndexedDB().then(resolve);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(ManualTileManager.STORE_NAME)) {
          db.createObjectStore(ManualTileManager.STORE_NAME, { keyPath: "id" });
          console.log("[ManualTileManager] Created tiles object store");
        }
      };
    });
  }

  /**
   * Load all tiles from IndexedDB
   */
  private async loadTilesFromIndexedDB(): Promise<void> {
    if (!this.db) return;

    return new Promise((resolve) => {
      const transaction = this.db!.transaction(ManualTileManager.STORE_NAME, "readonly");
      const store = transaction.objectStore(ManualTileManager.STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => {
        const tiles = request.result as TileData[];
        for (const tile of tiles) {
          this.tiles.set(tile.id, tile);
        }
        console.log(`[ManualTileManager] Loaded ${tiles.length} tiles from IndexedDB`);
        resolve();
      };

      request.onerror = () => {
        console.error("[ManualTileManager] Failed to load tiles:", request.error);
        resolve();
      };
    });
  }

  /**
   * Save a single tile to IndexedDB
   */
  private async saveTileToIndexedDB(tile: TileData): Promise<void> {
    await this.dbReady;
    if (!this.db) return;

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(ManualTileManager.STORE_NAME, "readwrite");
      const store = transaction.objectStore(ManualTileManager.STORE_NAME);
      const request = store.put(tile);

      request.onsuccess = () => {
        console.log(`[ManualTileManager] Saved tile ${tile.id} to IndexedDB`);
        resolve();
      };

      request.onerror = () => {
        console.error("[ManualTileManager] Failed to save tile:", request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Delete a tile from IndexedDB
   */
  private async deleteTileFromIndexedDB(tileId: string): Promise<void> {
    await this.dbReady;
    if (!this.db) return;

    return new Promise((resolve) => {
      const transaction = this.db!.transaction(ManualTileManager.STORE_NAME, "readwrite");
      const store = transaction.objectStore(ManualTileManager.STORE_NAME);
      const request = store.delete(tileId);

      request.onsuccess = () => {
        console.log(`[ManualTileManager] Deleted tile ${tileId} from IndexedDB`);
        resolve();
      };

      request.onerror = () => {
        console.error("[ManualTileManager] Failed to delete tile:", request.error);
        resolve();
      };
    });
  }

  /**
   * Wait for database to be ready
   */
  async waitForReady(): Promise<void> {
    await this.dbReady;
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
      heightmap: DataCodec.encodeFloat32Array(heightmapData),
      splatmap: DataCodec.encodeFloat32Array(splatmapData),
      waterMask: DataCodec.encodeFloat32Array(waterMaskData),
      seaLevel: -100,
      waterDepth: 2.0,
    };

    this.tiles.set(id, tileData);
    // Save to IndexedDB asynchronously
    this.saveTileToIndexedDB(tileData).catch(console.error);

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
    existingId?: string,
    foliageData?: Record<string, string>
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
      heightmap: DataCodec.encodeFloat32Array(heightmapData),
      splatmap: DataCodec.encodeFloat32Array(splatmapData),
      waterMask: DataCodec.encodeFloat32Array(waterMaskData),
      seaLevel,
      waterDepth,
      foliageData: foliageData || existingTile?.foliageData,
    };

    this.tiles.set(id, tileData);
    this.activeTileId = id;
    // Save to IndexedDB asynchronously
    this.saveTileToIndexedDB(tileData).catch(console.error);

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
      heightmapData: DataCodec.decodeFloat32Array(tileData.heightmap),
      splatmapData: DataCodec.decodeFloat32Array(tileData.splatmap),
      waterMaskData: DataCodec.decodeFloat32Array(tileData.waterMask),
      resolution: tileData.resolution,
      size: tileData.size,
      seaLevel: tileData.seaLevel,
      waterDepth: tileData.waterDepth,
      foliageData: tileData.foliageData,
    };
  }

  /**
   * Delete a tile
   */
  deleteTile(id: string): void {
    this.tiles.delete(id);
    if (this.activeTileId === id) {
      this.activeTileId = null;
    }

    // Delete from IndexedDB asynchronously
    this.deleteTileFromIndexedDB(id).catch(console.error);
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

      this.tiles.set(newId, tileData);
      // Save to IndexedDB asynchronously
      this.saveTileToIndexedDB(tileData).catch(console.error);

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
      // Save to IndexedDB asynchronously
      this.saveTileToIndexedDB(tile).catch(console.error);
    }
  }




  /**
   * Generate unique ID
   */
  private generateId(): string {
    return `tile_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Check if running in browser
   */
  private isBrowser(): boolean {
    return typeof window !== "undefined";
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
