import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { disposeMesh } from "../../shared/rendering/threeHelpers";

/**
 * Asset entry in the pool
 */
interface PooledAsset {
  scene: THREE.Group;
  refCount: number;
  lastUsed: number;
  path: string;
}

/**
 * Instance of an asset in the scene
 */
export interface AssetInstance {
  id: string;
  assetPath: string;
  rootNode: THREE.Group;
  meshes: THREE.Mesh[];
}

/**
 * AssetContainerPool manages loading, caching, and instancing of GLB/GLTF assets
 *
 * Features:
 * - Lazy loading with caching
 * - Reference counting for automatic cleanup
 * - Instancing support for multiple placements
 * - Memory management with LRU eviction
 */
export class AssetContainerPool {
  private parentScene: THREE.Scene;
  private pool: Map<string, PooledAsset> = new Map();
  private instances: Map<string, AssetInstance> = new Map();
  private maxPoolSize: number;
  private instanceCounter: number = 0;
  private gltfLoader: GLTFLoader;

  constructor(scene: THREE.Scene, maxPoolSize: number = 50) {
    this.parentScene = scene;
    this.maxPoolSize = maxPoolSize;
    this.gltfLoader = new GLTFLoader();
  }

  /**
   * Load an asset (cached)
   */
  async loadAsset(path: string): Promise<THREE.Group> {
    // Check cache first
    const existing = this.pool.get(path);
    if (existing) {
      existing.refCount++;
      existing.lastUsed = Date.now();
      return existing.scene;
    }

    // Evict if pool is full
    if (this.pool.size >= this.maxPoolSize) {
      this.evictLeastRecentlyUsed();
    }

    // Load new asset
    console.log(`[AssetContainerPool] Loading asset: ${path}`);

    try {
      const gltf = await this.gltfLoader.loadAsync(path);

      const pooled: PooledAsset = {
        scene: gltf.scene,
        refCount: 1,
        lastUsed: Date.now(),
        path,
      };

      this.pool.set(path, pooled);
      console.log(`[AssetContainerPool] Loaded and cached: ${path}`);

      return gltf.scene;
    } catch (error) {
      console.error(`[AssetContainerPool] Failed to load: ${path}`, error);
      throw error;
    }
  }

  /**
   * Create an instance of a loaded asset in the scene
   */
  async createInstance(
    assetPath: string,
    position?: { x: number; y: number; z: number },
    rotation?: { x: number; y: number; z: number },
    scale?: { x: number; y: number; z: number }
  ): Promise<AssetInstance | null> {
    try {
      const sourceScene = await this.loadAsset(assetPath);

      // Clone the scene graph
      const rootNode = sourceScene.clone();
      rootNode.name = `${sourceScene.name}_inst_${this.instanceCounter}`;

      // Collect all meshes
      const meshes: THREE.Mesh[] = [];
      rootNode.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          meshes.push(child);
        }
      });

      // Apply transforms
      if (position) {
        rootNode.position.set(position.x, position.y, position.z);
      }
      if (rotation) {
        rootNode.rotation.set(rotation.x, rotation.y, rotation.z);
      }
      if (scale) {
        rootNode.scale.set(scale.x, scale.y, scale.z);
      }

      this.parentScene.add(rootNode);

      const instanceId = `inst_${this.instanceCounter++}`;
      const instance: AssetInstance = {
        id: instanceId,
        assetPath,
        rootNode,
        meshes,
      };

      this.instances.set(instanceId, instance);

      return instance;
    } catch (error) {
      console.error(`[AssetContainerPool] Failed to create instance: ${assetPath}`, error);
      return null;
    }
  }

  /**
   * Remove an instance from the scene
   */
  removeInstance(instanceId: string): void {
    const instance = this.instances.get(instanceId);
    if (!instance) return;

    // Dispose meshes and root node
    disposeMesh(this.parentScene, instance.rootNode);

    this.instances.delete(instanceId);

    // Decrease ref count
    const pooled = this.pool.get(instance.assetPath);
    if (pooled) {
      pooled.refCount--;
    }
  }

  /**
   * Release a reference to an asset (call when done using)
   */
  releaseAsset(path: string): void {
    const pooled = this.pool.get(path);
    if (pooled) {
      pooled.refCount--;
      if (pooled.refCount <= 0) {
        // Don't immediately dispose - keep in cache for potential reuse
        pooled.refCount = 0;
      }
    }
  }

  /**
   * Evict least recently used assets with zero references
   */
  private evictLeastRecentlyUsed(): void {
    // Find assets with zero references, sorted by last used time
    const candidates: Array<{ path: string; lastUsed: number }> = [];

    for (const [path, pooled] of this.pool) {
      if (pooled.refCount <= 0) {
        candidates.push({ path, lastUsed: pooled.lastUsed });
      }
    }

    // Sort by last used (oldest first)
    candidates.sort((a, b) => a.lastUsed - b.lastUsed);

    // Evict oldest
    if (candidates.length > 0) {
      const toEvict = candidates[0];
      const pooled = this.pool.get(toEvict.path);
      if (pooled) {
        console.log(`[AssetContainerPool] Evicting: ${toEvict.path}`);
        // Dispose all geometries and materials in the cached scene
        pooled.scene.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.geometry?.dispose();
            if (Array.isArray(child.material)) {
              child.material.forEach((m) => m.dispose());
            } else {
              child.material?.dispose();
            }
          }
        });
        this.pool.delete(toEvict.path);
      }
    }
  }

  /**
   * Preload assets for faster access later
   */
  async preload(paths: string[]): Promise<void> {
    const promises = paths.map(path => this.loadAsset(path).catch(() => null));
    await Promise.all(promises);

    // Release references since we're just preloading
    paths.forEach(path => this.releaseAsset(path));
  }

  /**
   * Get pool statistics
   */
  getStats(): {
    poolSize: number;
    totalInstances: number;
    totalRefCount: number;
  } {
    let totalRefCount = 0;
    for (const pooled of this.pool.values()) {
      totalRefCount += pooled.refCount;
    }

    return {
      poolSize: this.pool.size,
      totalInstances: this.instances.size,
      totalRefCount,
    };
  }

  /**
   * Clear all unreferenced assets from pool
   */
  clearUnused(): void {
    const toRemove: string[] = [];

    for (const [path, pooled] of this.pool) {
      if (pooled.refCount <= 0) {
        toRemove.push(path);
      }
    }

    for (const path of toRemove) {
      const pooled = this.pool.get(path);
      if (pooled) {
        pooled.scene.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.geometry?.dispose();
            if (Array.isArray(child.material)) {
              child.material.forEach((m) => m.dispose());
            } else {
              child.material?.dispose();
            }
          }
        });
        this.pool.delete(path);
      }
    }

    console.log(`[AssetContainerPool] Cleared ${toRemove.length} unused assets`);
  }

  /**
   * Dispose all assets and instances
   */
  dispose(): void {
    // Remove all instances
    for (const instanceId of this.instances.keys()) {
      this.removeInstance(instanceId);
    }

    // Dispose all cached scenes
    for (const pooled of this.pool.values()) {
      pooled.scene.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry?.dispose();
          if (Array.isArray(child.material)) {
            child.material.forEach((m) => m.dispose());
          } else {
            child.material?.dispose();
          }
        }
      });
    }

    this.pool.clear();
    this.instances.clear();
    console.log("[AssetContainerPool] Disposed");
  }
}
