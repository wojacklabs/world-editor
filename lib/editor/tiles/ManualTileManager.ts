/**
 * ManualTileManager - Manages independent terrain tiles for manual world building
 *
 * This system allows users to:
 * 1. Create new terrain tiles with their own heightmap, splatmap, and water data
 * 2. Save/export individual tiles
 * 3. Load tiles from saved data
 * 4. Connect tiles with direction-aware seamless stitching
 */

import { DataCodec } from "../../loader";

export type SeamlessDirection = "left" | "right" | "top" | "bottom";

/**
 * Pool tile entry for infinite expansion
 */
export interface PoolTileEntry {
  tileId: string;
  weight: number;    // 0-100
  enabled: boolean;
}

/**
 * Manual tile placement on world grid
 */
export interface TilePlacement {
  gridX: number;
  gridY: number;
  tileId: string;
}

/**
 * World configuration for infinite expansion and manual placements
 */
export interface WorldConfig {
  infinitePool: PoolTileEntry[];
  manualPlacements: TilePlacement[];
  gridSize: number;  // Visible grid size (e.g., 5x5)
}

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
  foliageData?: Record<string, string>;
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
  private worldConfig: WorldConfig = {
    infinitePool: [],
    manualPlacements: [],
    gridSize: 5,
  };
  private dbReady: Promise<void>;
  private db: IDBDatabase | null = null;
  private static DB_NAME = "WorldEditorTiles";
  private static DB_VERSION = 1;
  private static STORE_NAME = "tiles";

  constructor() {
    // Initialize IndexedDB and load data
    this.dbReady = this.initIndexedDB();
    this.loadWorldConfig();
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
        // Clean up World Config references to deleted tiles
        this.cleanupWorldConfig();
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
      connections: {},
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
      connections: existingTile?.connections || {},
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

    // Also remove from World Config (pool and placements)
    const poolIndex = this.worldConfig.infinitePool.findIndex((e) => e.tileId === id);
    if (poolIndex !== -1) {
      this.worldConfig.infinitePool.splice(poolIndex, 1);
      console.log(`[ManualTileManager] Removed tile ${id} from infinite pool`);
    }

    const placementsBefore = this.worldConfig.manualPlacements.length;
    this.worldConfig.manualPlacements = this.worldConfig.manualPlacements.filter(
      (p) => p.tileId !== id
    );
    if (this.worldConfig.manualPlacements.length < placementsBefore) {
      console.log(`[ManualTileManager] Removed tile ${id} from manual placements`);
    }

    // Save updated World Config
    this.saveWorldConfig();

    // Delete from IndexedDB asynchronously
    this.deleteTileFromIndexedDB(id).catch(console.error);
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

    // Save both tiles to IndexedDB
    this.saveTileToIndexedDB(sourceTile).catch(console.error);
    this.saveTileToIndexedDB(targetTile).catch(console.error);
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
        // Save target tile to IndexedDB
        this.saveTileToIndexedDB(targetTile).catch(console.error);
      }
    }

    sourceTile.connections[direction] = undefined;
    // Save source tile to IndexedDB
    this.saveTileToIndexedDB(sourceTile).catch(console.error);
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

    const heightmap = DataCodec.decodeFloat32Array(tileData.heightmap);
    const splatmap = DataCodec.decodeFloat32Array(tileData.splatmap);
    const waterMask = DataCodec.decodeFloat32Array(tileData.waterMask);
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

  // ============================================
  // Pool Management
  // ============================================

  /**
   * Add a tile to the infinite expansion pool
   */
  addToPool(tileId: string, weight: number = 50): void {
    // Don't add duplicates
    if (this.worldConfig.infinitePool.some(e => e.tileId === tileId)) return;

    this.worldConfig.infinitePool.push({
      tileId,
      weight,
      enabled: true,
    });
    this.saveWorldConfig();
  }

  /**
   * Remove a tile from the pool
   */
  removeFromPool(tileId: string): void {
    this.worldConfig.infinitePool = this.worldConfig.infinitePool.filter(
      e => e.tileId !== tileId
    );
    this.saveWorldConfig();
  }

  /**
   * Update pool tile weight
   */
  updatePoolWeight(tileId: string, weight: number): void {
    const entry = this.worldConfig.infinitePool.find(e => e.tileId === tileId);
    if (entry) {
      entry.weight = Math.max(0, Math.min(100, weight));
      this.saveWorldConfig();
    }
  }

  /**
   * Toggle pool tile enabled state
   */
  togglePoolTile(tileId: string, enabled: boolean): void {
    const entry = this.worldConfig.infinitePool.find(e => e.tileId === tileId);
    if (entry) {
      entry.enabled = enabled;
      this.saveWorldConfig();
    }
  }

  /**
   * Get all pool entries
   */
  getPool(): PoolTileEntry[] {
    return [...this.worldConfig.infinitePool];
  }

  /**
   * Check if a tile is in the pool
   */
  isInPool(tileId: string): boolean {
    return this.worldConfig.infinitePool.some(e => e.tileId === tileId);
  }

  // ============================================
  // Manual Placement Management
  // ============================================

  /**
   * Set a tile at a specific grid position
   */
  setPlacement(x: number, y: number, tileId: string): void {
    // Remove existing placement at this position
    this.worldConfig.manualPlacements = this.worldConfig.manualPlacements.filter(
      p => !(p.gridX === x && p.gridY === y)
    );

    // Add new placement
    this.worldConfig.manualPlacements.push({
      gridX: x,
      gridY: y,
      tileId,
    });
    this.saveWorldConfig();
  }

  /**
   * Clear placement at a specific position
   */
  clearPlacement(x: number, y: number): void {
    this.worldConfig.manualPlacements = this.worldConfig.manualPlacements.filter(
      p => !(p.gridX === x && p.gridY === y)
    );
    this.saveWorldConfig();
  }

  /**
   * Get placement at a specific position
   */
  getPlacement(x: number, y: number): string | null {
    const placement = this.worldConfig.manualPlacements.find(
      p => p.gridX === x && p.gridY === y
    );
    return placement?.tileId || null;
  }

  /**
   * Get all manual placements
   */
  getAllPlacements(): TilePlacement[] {
    return [...this.worldConfig.manualPlacements];
  }

  // ============================================
  // World Config
  // ============================================

  /**
   * Get the full world configuration
   */
  getWorldConfig(): WorldConfig {
    return { ...this.worldConfig };
  }

  /**
   * Set grid size for the world grid display
   */
  setGridSize(size: number): void {
    this.worldConfig.gridSize = Math.max(3, Math.min(15, size));
    this.saveWorldConfig();
  }

  /**
   * Save world config to localStorage
   */
  saveWorldConfig(): void {
    if (!this.isBrowser()) return;

    try {
      localStorage.setItem("worldEditor_worldConfig", JSON.stringify(this.worldConfig));
    } catch (e) {
      console.warn("Failed to save world config:", e);
    }
  }

  /**
   * Load world config from localStorage
   */
  private loadWorldConfig(): void {
    if (!this.isBrowser()) return;

    try {
      const json = localStorage.getItem("worldEditor_worldConfig");
      if (json) {
        const config = JSON.parse(json) as WorldConfig;
        this.worldConfig = {
          infinitePool: config.infinitePool || [],
          manualPlacements: config.manualPlacements || [],
          gridSize: config.gridSize || 5,
        };
      }
    } catch (e) {
      console.warn("Failed to load world config:", e);
    }
  }

  /**
   * Remove references to deleted tiles from World Config
   * Called after tiles are loaded from IndexedDB
   */
  private cleanupWorldConfig(): void {
    let needsSave = false;

    // Clean up infinite pool - remove entries for tiles that no longer exist
    const validPool = this.worldConfig.infinitePool.filter((entry) => {
      const exists = this.tiles.has(entry.tileId);
      if (!exists) {
        console.log(`[ManualTileManager] Removing deleted tile from pool: ${entry.tileId}`);
        needsSave = true;
      }
      return exists;
    });

    // Clean up manual placements - remove placements for tiles that no longer exist
    const validPlacements = this.worldConfig.manualPlacements.filter((placement) => {
      const exists = this.tiles.has(placement.tileId);
      if (!exists) {
        console.log(`[ManualTileManager] Removing deleted tile placement at (${placement.gridX},${placement.gridY}): ${placement.tileId}`);
        needsSave = true;
      }
      return exists;
    });

    if (needsSave) {
      this.worldConfig.infinitePool = validPool;
      this.worldConfig.manualPlacements = validPlacements;
      this.saveWorldConfig();
      console.log(`[ManualTileManager] World Config cleaned up: ${this.worldConfig.infinitePool.length} pool entries, ${this.worldConfig.manualPlacements.length} placements`);
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

  // ============================================
  // WorldProject Export
  // ============================================

  /**
   * Export current tile as WorldProject JSON
   * Compatible with other Babylon.js/Three.js projects
   */
  exportWorldProject(
    name: string,
    heightmapData: Float32Array,
    splatmapData: Float32Array,
    waterMaskData: Float32Array,
    resolution: number,
    size: number,
    seaLevel: number,
    waterDepth: number,
    foliageData?: Record<string, string>
  ): string {
    const now = new Date().toISOString();

    const project = {
      version: "1.0.0",
      name,
      createdAt: now,
      modifiedAt: now,

      terrain: {
        size,
        resolution,
        heightmap: DataCodec.encodeFloat32Array(heightmapData),
        splatmap: DataCodec.encodeFloat32Array(splatmapData),
        waterMask: DataCodec.encodeFloat32Array(waterMaskData),
      },

      // Foliage data for recreation in target project
      foliage: foliageData || {},

      // Props array (future: integrate with PropManager)
      props: [] as Array<{
        id: string;
        name: string;
        glbPath?: string;
        position: { x: number; y: number; z: number };
        rotation: { x: number; y: number; z: number };
        scale: { x: number; y: number; z: number };
      }>,

      materials: {
        slots: [
          { name: "grass", channel: 0 },
          { name: "dirt", channel: 1 },
          { name: "rock", channel: 2 },
          { name: "sand", channel: 3 },
        ],
      },

      settings: {
        seamlessTiling: true,
        waterLevel: seaLevel,
        waterDepth,
      },
    };

    return JSON.stringify(project, null, 2);
  }

  /**
   * Export entire world (all tiles + placements) as WorldProject
   */
  exportFullWorld(
    name: string,
    currentTileData: {
      heightmapData: Float32Array;
      splatmapData: Float32Array;
      waterMaskData: Float32Array;
      resolution: number;
      size: number;
      seaLevel: number;
      waterDepth: number;
      foliageData?: Record<string, string>;
    }
  ): string {
    const now = new Date().toISOString();

    // Collect all tiles
    const tiles: Array<{
      id: string;
      name: string;
      terrain: {
        heightmap: string;
        splatmap: string;
        waterMask: string;
        resolution: number;
        size: number;
      };
      foliage: Record<string, string>;
    }> = [];

    for (const [id, tileData] of this.tiles) {
      tiles.push({
        id,
        name: tileData.name,
        terrain: {
          heightmap: tileData.heightmap,
          splatmap: tileData.splatmap,
          waterMask: tileData.waterMask,
          resolution: tileData.resolution,
          size: tileData.size,
        },
        foliage: tileData.foliageData || {},
      });
    }

    const project = {
      version: "1.0.0",
      name,
      createdAt: now,
      modifiedAt: now,

      // Current/main tile
      mainTile: {
        terrain: {
          size: currentTileData.size,
          resolution: currentTileData.resolution,
          heightmap: DataCodec.encodeFloat32Array(currentTileData.heightmapData),
          splatmap: DataCodec.encodeFloat32Array(currentTileData.splatmapData),
          waterMask: DataCodec.encodeFloat32Array(currentTileData.waterMaskData),
        },
        foliage: currentTileData.foliageData || {},
      },

      // All saved tiles
      tiles,

      // World Grid configuration
      worldGrid: {
        infinitePool: this.worldConfig.infinitePool,
        manualPlacements: this.worldConfig.manualPlacements,
        gridSize: this.worldConfig.gridSize,
      },

      materials: {
        slots: [
          { name: "grass", channel: 0 },
          { name: "dirt", channel: 1 },
          { name: "rock", channel: 2 },
          { name: "sand", channel: 3 },
        ],
      },

      settings: {
        seamlessTiling: true,
        waterLevel: currentTileData.seaLevel,
        waterDepth: currentTileData.waterDepth,
      },
    };

    return JSON.stringify(project, null, 2);
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
