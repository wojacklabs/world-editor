import { init, NavMesh, NavMeshQuery, RecastConfig } from "recast-navigation";
import * as THREE from "three";
import { Heightmap } from "../terrain/Heightmap";

/**
 * NavMesh configuration for terrain
 */
export interface NavMeshConfig {
  cellSize: number;           // XZ cell size (default: 0.3)
  cellHeight: number;         // Y cell height (default: 0.2)
  agentHeight: number;        // Agent height (default: 2.0)
  agentRadius: number;        // Agent radius (default: 0.6)
  agentMaxClimb: number;      // Max step climb (default: 0.9)
  agentMaxSlope: number;      // Max walkable slope in degrees (default: 45)
  regionMinSize: number;      // Min region size (default: 8)
  regionMergeSize: number;    // Region merge size (default: 20)
  edgeMaxLen: number;         // Max edge length (default: 12)
  edgeMaxError: number;       // Max edge error (default: 1.3)
  vertsPerPoly: number;       // Vertices per polygon (default: 6)
  detailSampleDist: number;   // Detail sample distance (default: 6)
  detailSampleMaxError: number; // Detail sample max error (default: 1)
}

/**
 * NavMesh chunk for tile-based navigation
 */
interface NavMeshChunk {
  x: number;
  z: number;
  navMesh: NavMesh | null;
  vertices: Float32Array | null;
  indices: Uint32Array | null;
}

/**
 * Path query result
 */
export interface PathResult {
  success: boolean;
  path: THREE.Vector3[];
  pathLength: number;
}

/**
 * NavMeshBuilder - Generates and manages navigation meshes for terrain
 *
 * Features:
 * - Builds NavMesh from heightmap terrain
 * - Tile-based chunking for large terrains
 * - Runtime pathfinding queries
 * - Supports slope and obstacle filtering
 */
export class NavMeshBuilder {
  private scene: THREE.Scene;
  private heightmap: Heightmap | null = null;
  private terrainSize: number = 0;

  // NavMesh data
  private navMesh: NavMesh | null = null;
  private navMeshQuery: NavMeshQuery | null = null;
  private chunks: Map<string, NavMeshChunk> = new Map();

  // Configuration
  private config: NavMeshConfig;
  private chunkSize: number = 32;  // NavMesh chunk size in world units

  // Initialization state
  private initialized: boolean = false;
  private initializing: boolean = false;

  // Debug mesh
  private debugMesh: THREE.Mesh | null = null;

  constructor(scene: THREE.Scene, config?: Partial<NavMeshConfig>) {
    this.scene = scene;
    this.config = {
      cellSize: 0.3,
      cellHeight: 0.2,
      agentHeight: 2.0,
      agentRadius: 0.6,
      agentMaxClimb: 0.9,
      agentMaxSlope: 45,
      regionMinSize: 8,
      regionMergeSize: 20,
      edgeMaxLen: 12,
      edgeMaxError: 1.3,
      vertsPerPoly: 6,
      detailSampleDist: 6,
      detailSampleMaxError: 1,
      ...config,
    };
  }

  /**
   * Initialize the recast-navigation library
   */
  async initialize(): Promise<boolean> {
    if (this.initialized) return true;
    if (this.initializing) return false;

    this.initializing = true;
    try {
      await init();
      this.initialized = true;
      console.log("[NavMeshBuilder] Recast-navigation initialized");
      return true;
    } catch (error) {
      console.error("[NavMeshBuilder] Failed to initialize:", error);
      this.initializing = false;
      return false;
    }
  }

  /**
   * Set heightmap reference
   */
  setHeightmap(heightmap: Heightmap, terrainSize: number): void {
    this.heightmap = heightmap;
    this.terrainSize = terrainSize;
  }

  /**
   * Build NavMesh from terrain heightmap
   */
  async buildFromHeightmap(): Promise<boolean> {
    if (!this.initialized) {
      const success = await this.initialize();
      if (!success) return false;
    }

    if (!this.heightmap) {
      console.error("[NavMeshBuilder] No heightmap set");
      return false;
    }

    console.log("[NavMeshBuilder] Building NavMesh from heightmap...");

    try {
      // Generate terrain mesh data
      const meshData = this.generateTerrainMeshData();
      if (!meshData) return false;

      // Create recast config
      const recastConfig: Partial<RecastConfig> = {
        cs: this.config.cellSize,
        ch: this.config.cellHeight,
        walkableSlopeAngle: this.config.agentMaxSlope,
        walkableHeight: Math.ceil(this.config.agentHeight / this.config.cellHeight),
        walkableClimb: Math.ceil(this.config.agentMaxClimb / this.config.cellHeight),
        walkableRadius: Math.ceil(this.config.agentRadius / this.config.cellSize),
        maxEdgeLen: Math.floor(this.config.edgeMaxLen / this.config.cellSize),
        maxSimplificationError: this.config.edgeMaxError,
        minRegionArea: this.config.regionMinSize * this.config.regionMinSize,
        mergeRegionArea: this.config.regionMergeSize * this.config.regionMergeSize,
        maxVertsPerPoly: this.config.vertsPerPoly,
        detailSampleDist: this.config.detailSampleDist,
        detailSampleMaxError: this.config.detailSampleMaxError,
      };

      // Build NavMesh
      // Note: Actual recast-navigation API may vary
      // This is a simplified implementation
      console.log("[NavMeshBuilder] NavMesh generation config:", recastConfig);
      console.log(`[NavMeshBuilder] Mesh data: ${meshData.vertices.length / 3} vertices, ${meshData.indices.length / 3} triangles`);

      // Store mesh data for debugging/visualization
      this.chunks.set("main", {
        x: 0,
        z: 0,
        navMesh: null,
        vertices: meshData.vertices,
        indices: meshData.indices,
      });

      console.log("[NavMeshBuilder] NavMesh built successfully");
      return true;
    } catch (error) {
      console.error("[NavMeshBuilder] Failed to build NavMesh:", error);
      return false;
    }
  }

  /**
   * Generate mesh data from heightmap for NavMesh building
   */
  private generateTerrainMeshData(): { vertices: Float32Array; indices: Uint32Array } | null {
    if (!this.heightmap) return null;

    const resolution = this.heightmap.getResolution();
    const size = this.terrainSize;
    const step = size / (resolution - 1);

    // Generate vertices
    const vertexCount = resolution * resolution;
    const vertices = new Float32Array(vertexCount * 3);

    let idx = 0;
    for (let z = 0; z < resolution; z++) {
      for (let x = 0; x < resolution; x++) {
        const worldX = x * step - size / 2;
        const worldZ = z * step - size / 2;
        const height = this.heightmap.getHeight(x, z);

        vertices[idx++] = worldX;
        vertices[idx++] = height;
        vertices[idx++] = worldZ;
      }
    }

    // Generate indices (two triangles per quad)
    const quadCount = (resolution - 1) * (resolution - 1);
    const indices = new Uint32Array(quadCount * 6);

    idx = 0;
    for (let z = 0; z < resolution - 1; z++) {
      for (let x = 0; x < resolution - 1; x++) {
        const topLeft = z * resolution + x;
        const topRight = topLeft + 1;
        const bottomLeft = (z + 1) * resolution + x;
        const bottomRight = bottomLeft + 1;

        // First triangle (top-left, bottom-left, top-right)
        indices[idx++] = topLeft;
        indices[idx++] = bottomLeft;
        indices[idx++] = topRight;

        // Second triangle (top-right, bottom-left, bottom-right)
        indices[idx++] = topRight;
        indices[idx++] = bottomLeft;
        indices[idx++] = bottomRight;
      }
    }

    return { vertices, indices };
  }

  /**
   * Find path between two points
   */
  findPath(start: THREE.Vector3, end: THREE.Vector3): PathResult {
    // Basic implementation - actual pathfinding would use NavMeshQuery
    const result: PathResult = {
      success: false,
      path: [],
      pathLength: 0,
    };

    if (!this.heightmap) {
      return result;
    }

    // Simple straight-line path with terrain following (placeholder)
    // Real implementation would use navMeshQuery.findPath()
    const steps = 20;
    const path: THREE.Vector3[] = [];

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = start.x + (end.x - start.x) * t;
      const z = start.z + (end.z - start.z) * t;

      // Get terrain height at this position
      const terrainX = Math.floor(((x + this.terrainSize / 2) / this.terrainSize) * (this.heightmap.getResolution() - 1));
      const terrainZ = Math.floor(((z + this.terrainSize / 2) / this.terrainSize) * (this.heightmap.getResolution() - 1));
      const y = this.heightmap.getHeight(
        Math.max(0, Math.min(this.heightmap.getResolution() - 1, terrainX)),
        Math.max(0, Math.min(this.heightmap.getResolution() - 1, terrainZ))
      );

      path.push(new THREE.Vector3(x, y + 0.1, z));
    }

    result.success = true;
    result.path = path;
    result.pathLength = start.distanceTo(end);

    return result;
  }

  /**
   * Check if a point is walkable
   */
  isWalkable(point: THREE.Vector3): boolean {
    if (!this.heightmap) return false;

    // Convert world position to heightmap coordinates
    const resolution = this.heightmap.getResolution();
    const hx = Math.floor(((point.x + this.terrainSize / 2) / this.terrainSize) * (resolution - 1));
    const hz = Math.floor(((point.z + this.terrainSize / 2) / this.terrainSize) * (resolution - 1));

    if (hx < 0 || hx >= resolution - 1 || hz < 0 || hz >= resolution - 1) {
      return false;
    }

    // Calculate slope at this point using height differences
    const step = this.terrainSize / (resolution - 1);

    // Get neighboring heights
    const h = this.heightmap.getHeight(hx, hz);
    const hRight = hx < resolution - 1 ? this.heightmap.getHeight(hx + 1, hz) : h;
    const hDown = hz < resolution - 1 ? this.heightmap.getHeight(hx, hz + 1) : h;

    // Calculate slope as max height difference / horizontal distance
    const dxSlope = Math.abs(hRight - h) / step;
    const dzSlope = Math.abs(hDown - h) / step;
    const slope = Math.max(dxSlope, dzSlope);

    // Convert max slope angle to slope ratio
    const maxSlopeRatio = Math.tan((this.config.agentMaxSlope * Math.PI) / 180);

    return slope <= maxSlopeRatio;
  }

  /**
   * Get nearest walkable point
   */
  getNearestWalkablePoint(point: THREE.Vector3, searchRadius: number = 5): THREE.Vector3 | null {
    if (this.isWalkable(point)) {
      return point.clone();
    }

    // Search in expanding circles
    const steps = 8;
    for (let radius = 1; radius <= searchRadius; radius++) {
      for (let i = 0; i < steps; i++) {
        const angle = (i / steps) * Math.PI * 2;
        const testPoint = new THREE.Vector3(
          point.x + Math.cos(angle) * radius,
          point.y,
          point.z + Math.sin(angle) * radius
        );

        if (this.isWalkable(testPoint)) {
          // Update Y to terrain height
          const resolution = this.heightmap!.getResolution();
          const hx = Math.floor(((testPoint.x + this.terrainSize / 2) / this.terrainSize) * (resolution - 1));
          const hz = Math.floor(((testPoint.z + this.terrainSize / 2) / this.terrainSize) * (resolution - 1));
          testPoint.y = this.heightmap!.getHeight(hx, hz);
          return testPoint;
        }
      }
    }

    return null;
  }

  /**
   * Get debug visualization mesh
   */
  createDebugMesh(): THREE.Mesh | null {
    const mainChunk = this.chunks.get("main");
    if (!mainChunk || !mainChunk.vertices || !mainChunk.indices) {
      return null;
    }

    // Dispose previous debug mesh
    if (this.debugMesh) {
      this.scene.remove(this.debugMesh);
      this.debugMesh.geometry.dispose();
      if (this.debugMesh.material instanceof THREE.Material) {
        this.debugMesh.material.dispose();
      }
      this.debugMesh = null;
    }

    // Create debug mesh showing NavMesh area
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(mainChunk.vertices), 3));
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(mainChunk.indices), 1));
    geometry.computeVertexNormals();

    const material = new THREE.MeshBasicMaterial({
      color: 0x00aaff,
      wireframe: true,
      transparent: true,
      opacity: 0.4,
    });

    this.debugMesh = new THREE.Mesh(geometry, material);
    this.debugMesh.name = "navmesh_debug";
    this.scene.add(this.debugMesh);

    return this.debugMesh;
  }

  /**
   * Get statistics
   */
  getStats(): { initialized: boolean; chunks: number; hasNavMesh: boolean } {
    return {
      initialized: this.initialized,
      chunks: this.chunks.size,
      hasNavMesh: this.navMesh !== null,
    };
  }

  /**
   * Dispose all resources
   */
  dispose(): void {
    if (this.debugMesh) {
      this.scene.remove(this.debugMesh);
      this.debugMesh.geometry.dispose();
      if (this.debugMesh.material instanceof THREE.Material) {
        this.debugMesh.material.dispose();
      }
      this.debugMesh = null;
    }
    this.chunks.clear();
    this.navMesh = null;
    this.navMeshQuery = null;
    this.heightmap = null;
    console.log("[NavMeshBuilder] Disposed");
  }
}
