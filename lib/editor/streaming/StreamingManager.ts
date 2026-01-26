import {
  Scene,
  Vector3,
  Observer,
} from "@babylonjs/core";

/**
 * Cell state for streaming
 */
export enum CellState {
  Unloaded = "unloaded",
  Loading = "loading",
  Loaded = "loaded",
  Unloading = "unloading",
}

/**
 * LOD level for streaming
 */
export enum StreamingLOD {
  Near = 0,    // Full detail
  Mid = 1,     // Medium detail
  Far = 2,     // Low detail / landmarks only
}

/**
 * Cell data structure
 */
export interface StreamingCell {
  x: number;
  z: number;
  state: CellState;
  lod: StreamingLOD;
  lastAccessTime: number;
  // References to loaded content
  terrainLoaded: boolean;
  foliageLoaded: boolean;
  propsLoaded: boolean;
}

/**
 * Streaming configuration
 */
export interface StreamingConfig {
  cellSize: number;           // World units per cell (e.g., 64)
  nearRadius: number;         // Cells in near ring (e.g., 1 = 3x3)
  midRadius: number;          // Cells in mid ring (e.g., 2 = 5x5)
  farRadius: number;          // Cells in far ring (e.g., 3 = 7x7)
  unloadDelay: number;        // MS before unloading unused cells
  maxConcurrentLoads: number; // Max simultaneous cell loads
}

const DEFAULT_CONFIG: StreamingConfig = {
  cellSize: 64,
  nearRadius: 1,    // 3x3 = 9 cells near
  midRadius: 2,     // 5x5 = 25 cells mid
  farRadius: 3,     // 7x7 = 49 cells far
  unloadDelay: 5000,
  maxConcurrentLoads: 4,
};

/**
 * StreamingManager handles loading/unloading of world cells based on camera position
 * 
 * Architecture:
 * - World is divided into cells (e.g., 64x64 units each)
 * - Near ring: Full detail terrain + foliage + props
 * - Mid ring: Medium LOD terrain + sparse foliage
 * - Far ring: Low LOD terrain only (landmarks)
 * - Beyond far ring: Unloaded
 */
export class StreamingManager {
  private scene: Scene;
  private config: StreamingConfig;
  private cells: Map<string, StreamingCell> = new Map();
  private currentCellX: number = 0;
  private currentCellZ: number = 0;
  private enabled: boolean = false;  // Disabled by default
  private updateObserver: Observer<Scene> | null = null;
  private loadQueue: Array<{ x: number; z: number; lod: StreamingLOD }> = [];
  private loadQueueSet: Set<string> = new Set();  // O(1) lookup for queue
  private activeLoads: number = 0;

  // Performance: frame skipping and object reuse
  private frameCounter: number = 0;
  private readonly UPDATE_INTERVAL: number = 5;  // Update every N frames
  private requiredCellsCache: Set<string> = new Set();  // Reusable Set

  // Protected cells (won't be unloaded while protected)
  private protectedCells: Set<string> = new Set();

  // Callbacks for cell operations
  private onLoadCell: ((x: number, z: number, lod: StreamingLOD) => Promise<void>) | null = null;
  private onUnloadCell: ((x: number, z: number) => void) | null = null;
  private onUpdateCellLOD: ((x: number, z: number, lod: StreamingLOD) => void) | null = null;

  constructor(scene: Scene, config: Partial<StreamingConfig> = {}) {
    this.scene = scene;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize streaming with callbacks
   */
  initialize(callbacks: {
    onLoadCell: (x: number, z: number, lod: StreamingLOD) => Promise<void>;
    onUnloadCell: (x: number, z: number) => void;
    onUpdateCellLOD: (x: number, z: number, lod: StreamingLOD) => void;
  }): void {
    this.onLoadCell = callbacks.onLoadCell;
    this.onUnloadCell = callbacks.onUnloadCell;
    this.onUpdateCellLOD = callbacks.onUpdateCellLOD;

    // Setup update loop
    this.updateObserver = this.scene.onBeforeRenderObservable.add(() => {
      if (this.enabled) {
        this.update();
      }
    });

    console.log("[StreamingManager] Initialized with config:", this.config);
  }

  /**
   * Main update loop - called every frame (with frame skipping for performance)
   */
  private update(): void {
    // Frame skipping: only run full update every N frames
    this.frameCounter++;
    const isFullUpdate = this.frameCounter >= this.UPDATE_INTERVAL;
    if (isFullUpdate) {
      this.frameCounter = 0;
    }

    const camera = this.scene.activeCamera;
    if (!camera) return;

    const cameraPos = camera.position;
    const cellX = Math.floor(cameraPos.x / this.config.cellSize);
    const cellZ = Math.floor(cameraPos.z / this.config.cellSize);

    // Check if we moved to a new cell (always check, but only full update periodically)
    if (cellX !== this.currentCellX || cellZ !== this.currentCellZ) {
      this.currentCellX = cellX;
      this.currentCellZ = cellZ;
      this.updateCellsAroundCamera(cellX, cellZ);
    } else if (isFullUpdate) {
      // Periodic update for unloading stale cells even when not moving
      this.updateCellsAroundCamera(cellX, cellZ);
    }

    // Process load queue (always process to avoid stalling)
    this.processLoadQueue();
  }

  /**
   * Update cells around camera position
   */
  private updateCellsAroundCamera(centerX: number, centerZ: number): void {
    const now = Date.now();
    // Reuse Set to avoid GC pressure
    this.requiredCellsCache.clear();
    const requiredCells = this.requiredCellsCache;

    // Determine which cells should be loaded at which LOD
    for (let dx = -this.config.farRadius; dx <= this.config.farRadius; dx++) {
      for (let dz = -this.config.farRadius; dz <= this.config.farRadius; dz++) {
        const x = centerX + dx;
        const z = centerZ + dz;
        const key = this.getCellKey(x, z);
        const distance = Math.max(Math.abs(dx), Math.abs(dz));

        let targetLOD: StreamingLOD;
        if (distance <= this.config.nearRadius) {
          targetLOD = StreamingLOD.Near;
        } else if (distance <= this.config.midRadius) {
          targetLOD = StreamingLOD.Mid;
        } else {
          targetLOD = StreamingLOD.Far;
        }

        requiredCells.add(key);

        const existingCell = this.cells.get(key);
        if (!existingCell) {
          // New cell - queue for loading
          this.queueCellLoad(x, z, targetLOD);
        } else {
          // Update access time
          existingCell.lastAccessTime = now;

          // Check if LOD needs update
          if (existingCell.state === CellState.Loaded && existingCell.lod !== targetLOD) {
            this.updateCellLOD(x, z, targetLOD);
          }
        }
      }
    }

    // Mark cells for unloading if outside range
    for (const [key, cell] of this.cells) {
      if (!requiredCells.has(key) && cell.state === CellState.Loaded) {
        if (now - cell.lastAccessTime > this.config.unloadDelay) {
          this.unloadCell(cell.x, cell.z);
        }
      }
    }
  }

  /**
   * Queue a cell for loading
   */
  private queueCellLoad(x: number, z: number, lod: StreamingLOD): void {
    const key = this.getCellKey(x, z);

    // Check if already queued or loading (O(1) lookup)
    if (this.cells.has(key)) return;
    if (this.loadQueueSet.has(key)) return;

    // Create cell entry
    const cell: StreamingCell = {
      x,
      z,
      state: CellState.Loading,
      lod,
      lastAccessTime: Date.now(),
      terrainLoaded: false,
      foliageLoaded: false,
      propsLoaded: false,
    };
    this.cells.set(key, cell);

    // Add to queue set for O(1) lookup
    this.loadQueueSet.add(key);

    // Add to load queue (prioritize by distance to camera)
    const distance = Math.max(
      Math.abs(x - this.currentCellX),
      Math.abs(z - this.currentCellZ)
    );

    // Insert in priority order (closer cells first)
    let inserted = false;
    for (let i = 0; i < this.loadQueue.length; i++) {
      const queuedDist = Math.max(
        Math.abs(this.loadQueue[i].x - this.currentCellX),
        Math.abs(this.loadQueue[i].z - this.currentCellZ)
      );
      if (distance < queuedDist) {
        this.loadQueue.splice(i, 0, { x, z, lod });
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      this.loadQueue.push({ x, z, lod });
    }
  }

  /**
   * Process the load queue (limited items per frame to avoid stalling)
   */
  private processLoadQueue(): void {
    // Process at most 2 items per frame to avoid blocking
    let processed = 0;
    const maxPerFrame = 2;

    while (
      processed < maxPerFrame &&
      this.loadQueue.length > 0 &&
      this.activeLoads < this.config.maxConcurrentLoads
    ) {
      const item = this.loadQueue.shift();
      if (!item) break;

      const key = this.getCellKey(item.x, item.z);
      // Remove from lookup set
      this.loadQueueSet.delete(key);

      const cell = this.cells.get(key);
      if (!cell || cell.state !== CellState.Loading) continue;

      this.activeLoads++;
      processed++;

      // Use non-blocking async load
      this.loadCellAsync(item.x, item.z, item.lod, key, cell);
    }
  }

  /**
   * Async cell loading (non-blocking)
   */
  private async loadCellAsync(
    x: number,
    z: number,
    lod: StreamingLOD,
    key: string,
    cell: StreamingCell
  ): Promise<void> {
    try {
      if (this.onLoadCell) {
        await this.onLoadCell(x, z, lod);
      }
      cell.state = CellState.Loaded;
      cell.terrainLoaded = true;
      cell.foliageLoaded = lod === StreamingLOD.Near;
      cell.propsLoaded = lod <= StreamingLOD.Mid;
    } catch (error) {
      console.error(`[StreamingManager] Failed to load cell (${x}, ${z}):`, error);
      this.cells.delete(key);
    } finally {
      this.activeLoads--;
    }
  }

  /**
   * Update LOD for a loaded cell
   */
  private updateCellLOD(x: number, z: number, lod: StreamingLOD): void {
    const key = this.getCellKey(x, z);
    const cell = this.cells.get(key);
    if (!cell) return;

    cell.lod = lod;
    if (this.onUpdateCellLOD) {
      this.onUpdateCellLOD(x, z, lod);
    }
  }

  /**
   * Unload a cell
   */
  private unloadCell(x: number, z: number): void {
    const key = this.getCellKey(x, z);

    // Don't unload protected cells
    if (this.protectedCells.has(key)) {
      return;
    }

    const cell = this.cells.get(key);
    if (!cell) return;

    cell.state = CellState.Unloading;

    if (this.onUnloadCell) {
      this.onUnloadCell(x, z);
    }

    this.cells.delete(key);
  }

  /**
   * Get cell key for map
   */
  private getCellKey(x: number, z: number): string {
    return `${x}_${z}`;
  }

  /**
   * Force load cells around a position (for teleportation)
   */
  async forceLoadAroundPosition(worldX: number, worldZ: number): Promise<void> {
    const cellX = Math.floor(worldX / this.config.cellSize);
    const cellZ = Math.floor(worldZ / this.config.cellSize);

    this.currentCellX = cellX;
    this.currentCellZ = cellZ;

    // Clear existing cells
    for (const [key, cell] of this.cells) {
      if (cell.state === CellState.Loaded && this.onUnloadCell) {
        this.onUnloadCell(cell.x, cell.z);
      }
    }
    this.cells.clear();
    this.loadQueue = [];
    this.loadQueueSet.clear();

    // Load immediate area synchronously
    for (let dx = -this.config.nearRadius; dx <= this.config.nearRadius; dx++) {
      for (let dz = -this.config.nearRadius; dz <= this.config.nearRadius; dz++) {
        const x = cellX + dx;
        const z = cellZ + dz;
        
        if (this.onLoadCell) {
          await this.onLoadCell(x, z, StreamingLOD.Near);
        }

        const cell: StreamingCell = {
          x,
          z,
          state: CellState.Loaded,
          lod: StreamingLOD.Near,
          lastAccessTime: Date.now(),
          terrainLoaded: true,
          foliageLoaded: true,
          propsLoaded: true,
        };
        this.cells.set(this.getCellKey(x, z), cell);
      }
    }

    // Queue remaining cells
    this.updateCellsAroundCamera(cellX, cellZ);
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalCells: number;
    loadedCells: number;
    loadingCells: number;
    queueLength: number;
  } {
    let loadedCells = 0;
    let loadingCells = 0;

    for (const cell of this.cells.values()) {
      if (cell.state === CellState.Loaded) loadedCells++;
      if (cell.state === CellState.Loading) loadingCells++;
    }

    return {
      totalCells: this.cells.size,
      loadedCells,
      loadingCells,
      queueLength: this.loadQueue.length,
    };
  }

  /**
   * Enable/disable streaming
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Protect a cell from being unloaded (for editing)
   */
  protectCell(x: number, z: number): void {
    const key = this.getCellKey(x, z);
    this.protectedCells.add(key);
  }

  /**
   * Remove protection from a cell
   */
  unprotectCell(x: number, z: number): void {
    const key = this.getCellKey(x, z);
    this.protectedCells.delete(key);
  }

  /**
   * Check if a cell is protected
   */
  isCellProtected(x: number, z: number): boolean {
    const key = this.getCellKey(x, z);
    return this.protectedCells.has(key);
  }

  /**
   * Get count of protected cells
   */
  getProtectedCellCount(): number {
    return this.protectedCells.size;
  }

  /**
   * Clear all cell protections
   */
  clearAllProtections(): void {
    this.protectedCells.clear();
  }

  /**
   * Get current camera cell
   */
  getCurrentCell(): { x: number; z: number } {
    return { x: this.currentCellX, z: this.currentCellZ };
  }

  /**
   * Dispose
   */
  dispose(): void {
    if (this.updateObserver) {
      this.scene.onBeforeRenderObservable.remove(this.updateObserver);
      this.updateObserver = null;
    }

    // Unload all cells
    for (const cell of this.cells.values()) {
      if (cell.state === CellState.Loaded && this.onUnloadCell) {
        this.onUnloadCell(cell.x, cell.z);
      }
    }
    this.cells.clear();
    this.loadQueue = [];
    this.loadQueueSet.clear();
    this.requiredCellsCache.clear();
  }
}
