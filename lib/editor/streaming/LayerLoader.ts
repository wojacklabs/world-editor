import { Scene } from "@babylonjs/core";

/**
 * Loading layer types with priority order
 * Lower number = higher priority (loads first)
 */
export enum LoadingLayer {
  TERRAIN = 0,           // Terrain geometry - highest priority
  COLLISION_NAV = 1,     // Collision proxies and NavMesh
  STRUCTURES = 2,        // Large structures (buildings, bridges)
  PROPS_LARGE = 3,       // Large props (trees, rocks)
  PROPS_MEDIUM = 4,      // Medium props
  PROPS_SMALL = 5,       // Small props (grass, debris)
  FOLIAGE = 6,           // Foliage and vegetation
  EFFECTS = 7,           // Particle effects, decals
  AUDIO = 8,             // Audio sources
}

/**
 * Layer loading state
 */
export enum LayerState {
  UNLOADED = "unloaded",
  QUEUED = "queued",
  LOADING = "loading",
  LOADED = "loaded",
  ERROR = "error",
}

/**
 * Layer load request
 */
interface LayerRequest {
  id: string;
  layer: LoadingLayer;
  cellX: number;
  cellZ: number;
  loadFn: () => Promise<void>;
  priority: number;
  state: LayerState;
  error?: string;
}

/**
 * Layer loading statistics
 */
export interface LayerStats {
  queued: number;
  loading: number;
  loaded: number;
  errors: number;
  byLayer: Record<LoadingLayer, { queued: number; loaded: number }>;
}

/**
 * LayerLoader - Manages prioritized loading of world layers
 * 
 * Features:
 * - Priority-based loading queue
 * - Concurrent loading limits
 * - Layer-specific callbacks
 * - Progress tracking
 * - Error handling with retry
 */
export class LayerLoader {
  private scene: Scene;
  
  // Loading queue
  private queue: LayerRequest[] = [];
  private activeLoads: Map<string, LayerRequest> = new Map();
  
  // Configuration
  private maxConcurrentLoads = 4;
  private retryAttempts = 2;
  private retryDelay = 1000;
  
  // State tracking
  private loadedLayers: Map<string, LayerRequest> = new Map();
  private isProcessing = false;
  
  // Callbacks
  private onLayerLoaded?: (layer: LoadingLayer, cellX: number, cellZ: number) => void;
  private onLayerError?: (layer: LoadingLayer, cellX: number, cellZ: number, error: string) => void;
  private onProgress?: (loaded: number, total: number) => void;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  /**
   * Configure loader settings
   */
  configure(options: {
    maxConcurrentLoads?: number;
    retryAttempts?: number;
    retryDelay?: number;
    onLayerLoaded?: (layer: LoadingLayer, cellX: number, cellZ: number) => void;
    onLayerError?: (layer: LoadingLayer, cellX: number, cellZ: number, error: string) => void;
    onProgress?: (loaded: number, total: number) => void;
  }): void {
    if (options.maxConcurrentLoads !== undefined) {
      this.maxConcurrentLoads = options.maxConcurrentLoads;
    }
    if (options.retryAttempts !== undefined) {
      this.retryAttempts = options.retryAttempts;
    }
    if (options.retryDelay !== undefined) {
      this.retryDelay = options.retryDelay;
    }
    if (options.onLayerLoaded) {
      this.onLayerLoaded = options.onLayerLoaded;
    }
    if (options.onLayerError) {
      this.onLayerError = options.onLayerError;
    }
    if (options.onProgress) {
      this.onProgress = options.onProgress;
    }
  }

  /**
   * Queue a layer for loading
   */
  queueLayer(
    layer: LoadingLayer,
    cellX: number,
    cellZ: number,
    loadFn: () => Promise<void>
  ): void {
    const id = this.getLayerId(layer, cellX, cellZ);
    
    // Skip if already loaded or in queue
    if (this.loadedLayers.has(id) || this.queue.some(r => r.id === id) || this.activeLoads.has(id)) {
      return;
    }

    // Calculate priority (lower = higher priority)
    // Layer type is primary, distance from origin is secondary
    const distancePriority = Math.abs(cellX) + Math.abs(cellZ);
    const priority = layer * 1000 + distancePriority;

    const request: LayerRequest = {
      id,
      layer,
      cellX,
      cellZ,
      loadFn,
      priority,
      state: LayerState.QUEUED,
    };

    // Insert in priority order
    const insertIndex = this.queue.findIndex(r => r.priority > priority);
    if (insertIndex === -1) {
      this.queue.push(request);
    } else {
      this.queue.splice(insertIndex, 0, request);
    }

    // Start processing if not already
    this.processQueue();
  }

  /**
   * Queue multiple layers for a cell
   */
  queueCell(
    cellX: number,
    cellZ: number,
    layers: { layer: LoadingLayer; loadFn: () => Promise<void> }[]
  ): void {
    for (const { layer, loadFn } of layers) {
      this.queueLayer(layer, cellX, cellZ, loadFn);
    }
  }

  /**
   * Unload layers for a cell
   */
  unloadCell(cellX: number, cellZ: number): void {
    // Remove from queue
    this.queue = this.queue.filter(
      r => !(r.cellX === cellX && r.cellZ === cellZ)
    );

    // Remove from loaded tracking
    const keysToRemove: string[] = [];
    for (const [id, request] of this.loadedLayers) {
      if (request.cellX === cellX && request.cellZ === cellZ) {
        keysToRemove.push(id);
      }
    }
    keysToRemove.forEach(key => this.loadedLayers.delete(key));
  }

  /**
   * Check if a specific layer is loaded
   */
  isLayerLoaded(layer: LoadingLayer, cellX: number, cellZ: number): boolean {
    const id = this.getLayerId(layer, cellX, cellZ);
    return this.loadedLayers.has(id);
  }

  /**
   * Check if all layers for a cell are loaded
   */
  isCellFullyLoaded(cellX: number, cellZ: number): boolean {
    // Check all layer types
    for (let layer = LoadingLayer.TERRAIN; layer <= LoadingLayer.AUDIO; layer++) {
      const id = this.getLayerId(layer, cellX, cellZ);
      if (!this.loadedLayers.has(id)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Process the loading queue
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    while (this.queue.length > 0 && this.activeLoads.size < this.maxConcurrentLoads) {
      const request = this.queue.shift();
      if (!request) break;

      request.state = LayerState.LOADING;
      this.activeLoads.set(request.id, request);

      // Start loading (don't await - process concurrently)
      this.loadLayer(request);
    }

    this.isProcessing = false;
  }

  /**
   * Load a single layer
   */
  private async loadLayer(request: LayerRequest, attempt: number = 0): Promise<void> {
    try {
      await request.loadFn();
      
      request.state = LayerState.LOADED;
      this.loadedLayers.set(request.id, request);
      this.activeLoads.delete(request.id);

      // Callback
      if (this.onLayerLoaded) {
        this.onLayerLoaded(request.layer, request.cellX, request.cellZ);
      }

      // Progress update
      this.reportProgress();

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      
      if (attempt < this.retryAttempts) {
        // Retry after delay
        console.warn(`[LayerLoader] Retrying ${request.id} (attempt ${attempt + 1}/${this.retryAttempts})`);
        await this.delay(this.retryDelay);
        return this.loadLayer(request, attempt + 1);
      }

      // Mark as error
      request.state = LayerState.ERROR;
      request.error = errorMsg;
      this.activeLoads.delete(request.id);

      console.error(`[LayerLoader] Failed to load ${request.id}:`, errorMsg);
      
      if (this.onLayerError) {
        this.onLayerError(request.layer, request.cellX, request.cellZ, errorMsg);
      }
    }

    // Continue processing queue
    this.processQueue();
  }

  /**
   * Report loading progress
   */
  private reportProgress(): void {
    if (!this.onProgress) return;

    const total = this.loadedLayers.size + this.queue.length + this.activeLoads.size;
    const loaded = this.loadedLayers.size;
    
    this.onProgress(loaded, total);
  }

  /**
   * Get layer identifier
   */
  private getLayerId(layer: LoadingLayer, cellX: number, cellZ: number): string {
    return `${layer}_${cellX}_${cellZ}`;
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get loading statistics
   */
  getStats(): LayerStats {
    const stats: LayerStats = {
      queued: this.queue.length,
      loading: this.activeLoads.size,
      loaded: this.loadedLayers.size,
      errors: 0,
      byLayer: {} as Record<LoadingLayer, { queued: number; loaded: number }>,
    };

    // Initialize by-layer stats
    for (let layer = LoadingLayer.TERRAIN; layer <= LoadingLayer.AUDIO; layer++) {
      stats.byLayer[layer] = { queued: 0, loaded: 0 };
    }

    // Count queued by layer
    for (const request of this.queue) {
      stats.byLayer[request.layer].queued++;
    }

    // Count loaded by layer
    for (const [, request] of this.loadedLayers) {
      stats.byLayer[request.layer].loaded++;
      if (request.state === LayerState.ERROR) {
        stats.errors++;
      }
    }

    return stats;
  }

  /**
   * Clear all queued and loaded layers
   */
  clear(): void {
    this.queue = [];
    this.activeLoads.clear();
    this.loadedLayers.clear();
    console.log("[LayerLoader] Cleared all layers");
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    this.clear();
    this.onLayerLoaded = undefined;
    this.onLayerError = undefined;
    this.onProgress = undefined;
    console.log("[LayerLoader] Disposed");
  }
}
