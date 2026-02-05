import * as THREE from "three";
import { disposeMesh } from "../../shared/rendering/threeHelpers";
import { Heightmap } from "../terrain/Heightmap";

/**
 * Collision layer types for filtering
 */
export enum CollisionLayer {
  TERRAIN = 1,
  PROPS_STATIC = 2,
  PROPS_DYNAMIC = 4,
  CHARACTER = 8,
  PROJECTILE = 16,
  TRIGGER = 32,
}

/**
 * Collision proxy configuration
 */
export interface CollisionProxyConfig {
  terrainSimplification: number;   // 1 = full resolution, 2 = half, 4 = quarter
  propSimplificationRatio: number; // Target triangle reduction ratio (0.1 = 10% of original)
  enableTerrainCollision: boolean;
  enablePropCollision: boolean;
  debugVisualization: boolean;
}

/**
 * Prop collision data
 */
interface PropCollisionData {
  id: string;
  originalMesh: THREE.Object3D;
  proxyMesh: THREE.Mesh | null;
  boundingBox: THREE.Mesh | null;
  layer: CollisionLayer;
}

/**
 * CollisionProxy - Manages optimized collision meshes for physics
 *
 * Features:
 * - Simplified terrain collision mesh
 * - Low-poly proxy meshes for props
 * - Collision layer separation
 * - Bounding box fallbacks
 */
export class CollisionProxy {
  private scene: any;
  private config: CollisionProxyConfig;

  // Terrain collision
  private terrainProxy: THREE.Mesh | null = null;
  private heightmap: Heightmap | null = null;
  private terrainSize: number = 0;

  // Prop collision proxies
  private propProxies: Map<string, PropCollisionData> = new Map();

  // Debug meshes
  private debugMeshes: THREE.Mesh[] = [];

  // Raycaster for picking
  private raycaster: THREE.Raycaster = new THREE.Raycaster();

  constructor(scene: any, config?: Partial<CollisionProxyConfig>) {
    this.scene = scene;
    this.config = {
      terrainSimplification: 4,      // Use 1/4 resolution for terrain collision
      propSimplificationRatio: 0.2,  // 20% of original triangles
      enableTerrainCollision: true,
      enablePropCollision: true,
      debugVisualization: false,
      ...config,
    };
  }

  /**
   * Set heightmap for terrain collision
   */
  setHeightmap(heightmap: Heightmap, terrainSize: number): void {
    this.heightmap = heightmap;
    this.terrainSize = terrainSize;
  }

  /**
   * Build terrain collision proxy mesh
   */
  buildTerrainProxy(): THREE.Mesh | null {
    if (!this.heightmap || !this.config.enableTerrainCollision) {
      return null;
    }

    // Dispose existing proxy
    if (this.terrainProxy) {
      disposeMesh(this.scene, this.terrainProxy);
      this.terrainProxy = null;
    }

    const fullRes = this.heightmap.getResolution();
    const simplification = this.config.terrainSimplification;
    const proxyRes = Math.max(3, Math.floor(fullRes / simplification));

    console.log(`[CollisionProxy] Building terrain proxy: ${proxyRes}x${proxyRes} (from ${fullRes}x${fullRes})`);

    // Generate simplified vertex data
    const positions: number[] = [];
    const indices: number[] = [];

    const step = this.terrainSize / (proxyRes - 1);
    const sampleStep = (fullRes - 1) / (proxyRes - 1);

    // Generate vertices
    for (let z = 0; z < proxyRes; z++) {
      for (let x = 0; x < proxyRes; x++) {
        const worldX = x * step - this.terrainSize / 2;
        const worldZ = z * step - this.terrainSize / 2;

        // Sample height from heightmap
        const hx = Math.min(fullRes - 1, Math.round(x * sampleStep));
        const hz = Math.min(fullRes - 1, Math.round(z * sampleStep));
        const height = this.heightmap.getHeight(hx, hz);

        positions.push(worldX, height, worldZ);
      }
    }

    // Generate indices
    for (let z = 0; z < proxyRes - 1; z++) {
      for (let x = 0; x < proxyRes - 1; x++) {
        const topLeft = z * proxyRes + x;
        const topRight = topLeft + 1;
        const bottomLeft = (z + 1) * proxyRes + x;
        const bottomRight = bottomLeft + 1;

        // Two triangles per quad
        indices.push(topLeft, bottomLeft, topRight);
        indices.push(topRight, bottomLeft, bottomRight);
      }
    }

    // Create geometry
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    // Create mesh
    const material = new THREE.MeshBasicMaterial({
      wireframe: true,
      color: 0x00ff00,
      transparent: true,
      opacity: 0.3,
    });
    this.terrainProxy = new THREE.Mesh(geometry, material);
    this.terrainProxy.name = "terrain_collision_proxy";

    // Make invisible but keep in scene for raycasting
    this.terrainProxy.visible = this.config.debugVisualization;

    // Set collision layer metadata
    this.terrainProxy.userData = {
      collisionLayer: CollisionLayer.TERRAIN,
    };

    this.scene.add(this.terrainProxy);

    console.log(`[CollisionProxy] Terrain proxy built: ${positions.length / 3} vertices, ${indices.length / 3} triangles`);

    return this.terrainProxy;
  }

  /**
   * Create collision proxy for a prop mesh
   */
  createPropProxy(
    id: string,
    originalMesh: THREE.Object3D,
    layer: CollisionLayer = CollisionLayer.PROPS_STATIC
  ): THREE.Mesh | null {
    if (!this.config.enablePropCollision) return null;

    // Remove existing proxy if any
    this.removePropProxy(id);

    // Get bounding box
    const box = new THREE.Box3().setFromObject(originalMesh);
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);

    // Create bounding box proxy (simple and fast)
    const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
    const material = new THREE.MeshBasicMaterial({
      wireframe: true,
      color: 0xff0000,
      transparent: true,
      opacity: 0.3,
    });
    const proxyMesh = new THREE.Mesh(geometry, material);
    proxyMesh.name = `collision_proxy_${id}`;

    proxyMesh.position.copy(center);
    proxyMesh.visible = this.config.debugVisualization;

    // Set collision layer metadata
    proxyMesh.userData = {
      collisionLayer: layer,
      originalMeshId: id,
    };

    this.scene.add(proxyMesh);

    // Store proxy data
    this.propProxies.set(id, {
      id,
      originalMesh,
      proxyMesh,
      boundingBox: proxyMesh,
      layer,
    });

    return proxyMesh;
  }

  /**
   * Create simplified mesh proxy (more accurate than bounding box)
   */
  createSimplifiedPropProxy(
    id: string,
    originalMesh: THREE.Object3D,
    layer: CollisionLayer = CollisionLayer.PROPS_STATIC
  ): THREE.Mesh | null {
    if (!this.config.enablePropCollision) return null;

    // Remove existing proxy if any
    this.removePropProxy(id);

    const box = new THREE.Box3().setFromObject(originalMesh);
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);

    // Create capsule for tall objects (like trees)
    const isVertical = size.y > Math.max(size.x, size.z) * 1.5;

    let proxyMesh: THREE.Mesh;

    if (isVertical) {
      // Use capsule for vertical objects
      const radius = Math.max(size.x, size.z) / 2;
      const capsuleHeight = Math.max(0.1, size.y - radius * 2);

      const geometry = new THREE.CapsuleGeometry(radius, capsuleHeight, 4, 8);
      const material = new THREE.MeshBasicMaterial({
        wireframe: true,
        color: 0xffff00,
        transparent: true,
        opacity: 0.3,
      });
      proxyMesh = new THREE.Mesh(geometry, material);
    } else {
      // Use box for other objects
      const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
      const material = new THREE.MeshBasicMaterial({
        wireframe: true,
        color: 0xff0000,
        transparent: true,
        opacity: 0.3,
      });
      proxyMesh = new THREE.Mesh(geometry, material);
    }

    proxyMesh.name = `collision_proxy_${id}`;
    proxyMesh.position.copy(center);
    proxyMesh.visible = this.config.debugVisualization;

    proxyMesh.userData = {
      collisionLayer: layer,
      originalMeshId: id,
    };

    this.scene.add(proxyMesh);

    this.propProxies.set(id, {
      id,
      originalMesh,
      proxyMesh,
      boundingBox: null,
      layer,
    });

    return proxyMesh;
  }

  /**
   * Remove collision proxy for a prop
   */
  removePropProxy(id: string): void {
    const data = this.propProxies.get(id);
    if (data) {
      if (data.proxyMesh) {
        disposeMesh(this.scene, data.proxyMesh);
      }
      if (data.boundingBox && data.boundingBox !== data.proxyMesh) {
        disposeMesh(this.scene, data.boundingBox);
      }
      this.propProxies.delete(id);
    }
  }

  /**
   * Update prop proxy position/rotation
   */
  updatePropProxy(id: string): void {
    const data = this.propProxies.get(id);
    if (!data || !data.proxyMesh) return;

    const box = new THREE.Box3().setFromObject(data.originalMesh);
    const center = new THREE.Vector3();
    box.getCenter(center);
    data.proxyMesh.position.copy(center);
  }

  /**
   * Raycast against collision proxies
   */
  raycast(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    maxDistance: number = 1000,
    layerMask: number = CollisionLayer.TERRAIN | CollisionLayer.PROPS_STATIC
  ): { hit: boolean; point: THREE.Vector3 | null; distance: number; meshId: string | null } {
    const result = {
      hit: false,
      point: null as THREE.Vector3 | null,
      distance: maxDistance,
      meshId: null as string | null,
    };

    const normalizedDir = direction.clone().normalize();
    this.raycaster.set(origin, normalizedDir);
    this.raycaster.far = maxDistance;

    // Collect meshes to test against
    const meshesToTest: THREE.Object3D[] = [];

    // Check terrain proxy
    if ((layerMask & CollisionLayer.TERRAIN) && this.terrainProxy) {
      meshesToTest.push(this.terrainProxy);
    }

    // Check prop proxies
    for (const [, data] of this.propProxies) {
      if (!(layerMask & data.layer)) continue;
      if (!data.proxyMesh) continue;
      meshesToTest.push(data.proxyMesh);
    }

    const intersects = this.raycaster.intersectObjects(meshesToTest, false);

    if (intersects.length > 0) {
      const closest = intersects[0];
      result.hit = true;
      result.point = closest.point.clone();
      result.distance = closest.distance;

      // Determine mesh id
      if (closest.object === this.terrainProxy) {
        result.meshId = "terrain";
      } else {
        result.meshId = closest.object.userData?.originalMeshId ?? null;
      }
    }

    return result;
  }

  /**
   * Toggle debug visualization
   */
  setDebugVisualization(enabled: boolean): void {
    this.config.debugVisualization = enabled;

    if (this.terrainProxy) {
      this.terrainProxy.visible = enabled;
    }

    for (const [, data] of this.propProxies) {
      if (data.proxyMesh) {
        data.proxyMesh.visible = enabled;
      }
    }
  }

  /**
   * Get statistics
   */
  getStats(): {
    terrainProxyVertices: number;
    terrainProxyTriangles: number;
    propProxies: number;
  } {
    let terrainVertices = 0;
    let terrainTriangles = 0;

    if (this.terrainProxy) {
      const geo = this.terrainProxy.geometry;
      const posAttr = geo.getAttribute("position");
      terrainVertices = posAttr ? posAttr.count : 0;
      terrainTriangles = geo.index ? geo.index.count / 3 : 0;
    }

    return {
      terrainProxyVertices: terrainVertices,
      terrainProxyTriangles: terrainTriangles,
      propProxies: this.propProxies.size,
    };
  }

  /**
   * Rebuild collision proxy for loaded tiles only (for streaming)
   * @param loadedTileKeys Array of loaded tile keys (format: "gridX_gridY")
   */
  rebuildForLoadedTiles(loadedTileKeys: string[]): void {
    // Placeholder for streaming integration
    // When streaming is enabled, this method rebuilds terrain collision
    // for only the currently loaded tiles instead of the entire terrain.
    //
    // Implementation would:
    // 1. Dispose current terrain proxy
    // 2. Build a new proxy covering only the loaded tile areas
    // 3. Keep prop proxies that are within loaded tiles
    //
    // For now, just rebuild the full terrain proxy if heightmap is set
    if (this.heightmap) {
      this.buildTerrainProxy();
    }
    console.log(`[CollisionProxy] rebuildForLoadedTiles called with ${loadedTileKeys.length} tiles (placeholder)`);
  }

  /**
   * Dispose all resources
   */
  dispose(): void {
    if (this.terrainProxy) {
      disposeMesh(this.scene, this.terrainProxy);
      this.terrainProxy = null;
    }

    for (const [, data] of this.propProxies) {
      if (data.proxyMesh) {
        disposeMesh(this.scene, data.proxyMesh);
      }
      if (data.boundingBox && data.boundingBox !== data.proxyMesh) {
        disposeMesh(this.scene, data.boundingBox);
      }
    }
    this.propProxies.clear();

    for (const mesh of this.debugMeshes) {
      disposeMesh(this.scene, mesh);
    }
    this.debugMeshes = [];

    console.log("[CollisionProxy] Disposed");
  }
}
