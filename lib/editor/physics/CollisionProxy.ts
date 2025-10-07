import {
  Scene,
  Mesh,
  MeshBuilder,
  Vector3,
  VertexData,
  PhysicsAggregate,
  PhysicsShapeType,
  AbstractMesh,
  BoundingInfo,
  Matrix,
} from "@babylonjs/core";
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
  originalMesh: AbstractMesh;
  proxyMesh: Mesh | null;
  boundingBox: Mesh | null;
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
  private scene: Scene;
  private config: CollisionProxyConfig;
  
  // Terrain collision
  private terrainProxy: Mesh | null = null;
  private heightmap: Heightmap | null = null;
  private terrainSize: number = 0;
  
  // Prop collision proxies
  private propProxies: Map<string, PropCollisionData> = new Map();
  
  // Debug meshes
  private debugMeshes: Mesh[] = [];

  constructor(scene: Scene, config?: Partial<CollisionProxyConfig>) {
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
  buildTerrainProxy(): Mesh | null {
    if (!this.heightmap || !this.config.enableTerrainCollision) {
      return null;
    }

    // Dispose existing proxy
    if (this.terrainProxy) {
      this.terrainProxy.dispose();
      this.terrainProxy = null;
    }

    const fullRes = this.heightmap.getResolution();
    const simplification = this.config.terrainSimplification;
    const proxyRes = Math.max(3, Math.floor(fullRes / simplification));
    
    console.log(`[CollisionProxy] Building terrain proxy: ${proxyRes}x${proxyRes} (from ${fullRes}x${fullRes})`);

    // Generate simplified vertex data
    const positions: number[] = [];
    const indices: number[] = [];
    const normals: number[] = [];

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
        normals.push(0, 1, 0);  // Will recalculate
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

    // Create mesh
    this.terrainProxy = new Mesh("terrain_collision_proxy", this.scene);
    
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    
    // Compute normals
    VertexData.ComputeNormals(positions, indices, normals);
    vertexData.normals = normals;
    
    vertexData.applyToMesh(this.terrainProxy);

    // Make invisible but collidable
    this.terrainProxy.isVisible = this.config.debugVisualization;
    this.terrainProxy.checkCollisions = true;
    
    // Set collision layer metadata
    this.terrainProxy.metadata = {
      collisionLayer: CollisionLayer.TERRAIN,
    };

    console.log(`[CollisionProxy] Terrain proxy built: ${positions.length / 3} vertices, ${indices.length / 3} triangles`);
    
    return this.terrainProxy;
  }

  /**
   * Create collision proxy for a prop mesh
   */
  createPropProxy(
    id: string,
    originalMesh: AbstractMesh,
    layer: CollisionLayer = CollisionLayer.PROPS_STATIC
  ): Mesh | null {
    if (!this.config.enablePropCollision) return null;

    // Remove existing proxy if any
    this.removePropProxy(id);

    // Get bounding info
    originalMesh.computeWorldMatrix(true);
    const boundingInfo = originalMesh.getBoundingInfo();
    const size = boundingInfo.boundingBox.maximumWorld.subtract(
      boundingInfo.boundingBox.minimumWorld
    );
    const center = boundingInfo.boundingBox.centerWorld;

    // Create bounding box proxy (simple and fast)
    const proxyMesh = MeshBuilder.CreateBox(
      `collision_proxy_${id}`,
      {
        width: size.x,
        height: size.y,
        depth: size.z,
      },
      this.scene
    );
    
    proxyMesh.position = center.clone();
    proxyMesh.isVisible = this.config.debugVisualization;
    proxyMesh.checkCollisions = true;
    
    // Set collision layer metadata
    proxyMesh.metadata = {
      collisionLayer: layer,
      originalMeshId: id,
    };

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
    originalMesh: AbstractMesh,
    layer: CollisionLayer = CollisionLayer.PROPS_STATIC
  ): Mesh | null {
    if (!this.config.enablePropCollision) return null;

    // For complex meshes, we'd use mesh simplification
    // For now, use convex hull approximation with bounding box
    
    // Remove existing proxy if any
    this.removePropProxy(id);

    originalMesh.computeWorldMatrix(true);
    const boundingInfo = originalMesh.getBoundingInfo();
    const size = boundingInfo.boundingBox.maximumWorld.subtract(
      boundingInfo.boundingBox.minimumWorld
    );
    const center = boundingInfo.boundingBox.centerWorld;

    // Create capsule for tall objects (like trees)
    const isVertical = size.y > Math.max(size.x, size.z) * 1.5;
    
    let proxyMesh: Mesh;
    
    if (isVertical) {
      // Use capsule for vertical objects
      const radius = Math.max(size.x, size.z) / 2;
      const height = size.y - radius * 2;
      
      proxyMesh = MeshBuilder.CreateCapsule(
        `collision_proxy_${id}`,
        {
          radius: radius,
          height: Math.max(0.1, height),
          tessellation: 8,
          subdivisions: 1,
        },
        this.scene
      );
    } else {
      // Use box for other objects
      proxyMesh = MeshBuilder.CreateBox(
        `collision_proxy_${id}`,
        {
          width: size.x,
          height: size.y,
          depth: size.z,
        },
        this.scene
      );
    }

    proxyMesh.position = center.clone();
    proxyMesh.isVisible = this.config.debugVisualization;
    proxyMesh.checkCollisions = true;
    
    proxyMesh.metadata = {
      collisionLayer: layer,
      originalMeshId: id,
    };

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
        data.proxyMesh.dispose();
      }
      if (data.boundingBox && data.boundingBox !== data.proxyMesh) {
        data.boundingBox.dispose();
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

    data.originalMesh.computeWorldMatrix(true);
    const boundingInfo = data.originalMesh.getBoundingInfo();
    data.proxyMesh.position = boundingInfo.boundingBox.centerWorld.clone();
  }

  /**
   * Raycast against collision proxies
   */
  raycast(
    origin: Vector3,
    direction: Vector3,
    maxDistance: number = 1000,
    layerMask: number = CollisionLayer.TERRAIN | CollisionLayer.PROPS_STATIC
  ): { hit: boolean; point: Vector3 | null; distance: number; meshId: string | null } {
    const result = {
      hit: false,
      point: null as Vector3 | null,
      distance: maxDistance,
      meshId: null as string | null,
    };

    // Check terrain proxy
    if ((layerMask & CollisionLayer.TERRAIN) && this.terrainProxy) {
      const terrainHit = this.raycastMesh(this.terrainProxy, origin, direction, maxDistance);
      if (terrainHit.hit && terrainHit.distance < result.distance) {
        result.hit = true;
        result.point = terrainHit.point;
        result.distance = terrainHit.distance;
        result.meshId = "terrain";
      }
    }

    // Check prop proxies
    for (const [id, data] of this.propProxies) {
      if (!(layerMask & data.layer)) continue;
      if (!data.proxyMesh) continue;

      const propHit = this.raycastMesh(data.proxyMesh, origin, direction, maxDistance);
      if (propHit.hit && propHit.distance < result.distance) {
        result.hit = true;
        result.point = propHit.point;
        result.distance = propHit.distance;
        result.meshId = id;
      }
    }

    return result;
  }

  /**
   * Raycast against a single mesh
   */
  private raycastMesh(
    mesh: Mesh,
    origin: Vector3,
    direction: Vector3,
    maxDistance: number
  ): { hit: boolean; point: Vector3 | null; distance: number } {
    const ray = new (Vector3 as any).constructor().copyFrom(direction).normalize();
    
    // Use Babylon's built-in ray picking
    const pickInfo = this.scene.pickWithRay(
      new (this.scene as any).constructor.Ray(origin, direction, maxDistance),
      (m) => m === mesh
    );

    if (pickInfo && pickInfo.hit && pickInfo.pickedPoint) {
      return {
        hit: true,
        point: pickInfo.pickedPoint,
        distance: pickInfo.distance,
      };
    }

    return { hit: false, point: null, distance: maxDistance };
  }

  /**
   * Toggle debug visualization
   */
  setDebugVisualization(enabled: boolean): void {
    this.config.debugVisualization = enabled;
    
    if (this.terrainProxy) {
      this.terrainProxy.isVisible = enabled;
    }
    
    for (const [, data] of this.propProxies) {
      if (data.proxyMesh) {
        data.proxyMesh.isVisible = enabled;
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
      const positions = this.terrainProxy.getVerticesData("position");
      const indices = this.terrainProxy.getIndices();
      terrainVertices = positions ? positions.length / 3 : 0;
      terrainTriangles = indices ? indices.length / 3 : 0;
    }

    return {
      terrainProxyVertices: terrainVertices,
      terrainProxyTriangles: terrainTriangles,
      propProxies: this.propProxies.size,
    };
  }

  /**
   * Dispose all resources
   */
  dispose(): void {
    if (this.terrainProxy) {
      this.terrainProxy.dispose();
      this.terrainProxy = null;
    }

    for (const [, data] of this.propProxies) {
      if (data.proxyMesh) {
        data.proxyMesh.dispose();
      }
      if (data.boundingBox && data.boundingBox !== data.proxyMesh) {
        data.boundingBox.dispose();
      }
    }
    this.propProxies.clear();

    for (const mesh of this.debugMeshes) {
      mesh.dispose();
    }
    this.debugMeshes = [];

    console.log("[CollisionProxy] Disposed");
  }
}
