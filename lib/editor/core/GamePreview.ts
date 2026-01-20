import {
  Scene,
  UniversalCamera,
  Vector3,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Color4,
  HemisphericLight,
  DirectionalLight,
  FreeCamera,
  KeyboardEventTypes,
  PointerEventTypes,
  LinesMesh,
  DynamicTexture,
} from "@babylonjs/core";
import { Heightmap } from "../terrain/Heightmap";
import { TerrainMesh } from "../terrain/TerrainMesh";
import { FoliageSystem } from "../foliage/FoliageSystem";
import { BiomeDecorator } from "../terrain/BiomeDecorator";

export type TileMode = "clone" | "mirror";

export class GamePreview {
  private scene: Scene;
  private heightmap: Heightmap;
  private terrainMeshRef: TerrainMesh | null = null;
  private foliageSystem: FoliageSystem | null = null;
  private biomeDecorator: BiomeDecorator | null = null;
  private camera: FreeCamera | null = null;
  private tileClones: Mesh[] = [];
  private originalMesh: Mesh | null = null;
  private unifiedWater: Mesh | null = null;
  private originalWaterVisible: boolean = true;

  // Tile mode: "clone" (random extension) or "mirror" (symmetric mirroring)
  private tileMode: TileMode = "mirror";

  // Store original thin instance data for restoration
  private originalFoliageMatrices: Map<Mesh, Float32Array> = new Map();
  private originalFoliageCounts: Map<Mesh, number> = new Map();

  // Free camera state
  private moveSpeed = 30;
  private fastMoveSpeed = 60;

  // Input state
  private inputMap: { [key: string]: boolean } = {};
  private isPointerLocked = false;

  // Event handler references for cleanup
  private canvas: HTMLCanvasElement | null = null;
  private onCanvasClick: (() => void) | null = null;
  private onPointerLockChange: (() => void) | null = null;
  private onMouseMove: ((e: MouseEvent) => void) | null = null;
  private keyboardObserver: any = null;
  private updateBound: (() => void) | null = null;

  // Debug visualization
  private debugEnabled: boolean = false;
  private debugMeshes: Mesh[] = [];
  private debugLines: LinesMesh[] = [];

  constructor(
    scene: Scene,
    heightmap: Heightmap,
    terrainMesh?: TerrainMesh | null,
    foliageSystem?: FoliageSystem | null,
    biomeDecorator?: BiomeDecorator | null,
    tileMode: TileMode = "mirror"
  ) {
    this.scene = scene;
    this.heightmap = heightmap;
    this.terrainMeshRef = terrainMesh || null;
    this.foliageSystem = foliageSystem || null;
    this.biomeDecorator = biomeDecorator || null;
    this.tileMode = tileMode;
  }

  setTileMode(mode: TileMode): void {
    this.tileMode = mode;
  }

  getTileMode(): TileMode {
    return this.tileMode;
  }

  enable(terrainMesh: Mesh): void {
    this.originalMesh = terrainMesh;

    // Create 3x3 tile grid for terrain
    this.createTileGrid();

    // Extend foliage to cover all tiles
    this.extendFoliage();

    // Create unified water plane
    this.createUnifiedWater();

    // Setup first-person camera
    this.setupCamera();

    // Setup input
    this.setupInput();

    // Change scene background for game feel
    this.scene.clearColor = new Color4(0.4, 0.6, 0.9, 1); // Sky blue

    // Add fog for depth
    this.scene.fogMode = Scene.FOGMODE_EXP2;
    this.scene.fogDensity = 0.005;
    this.scene.fogColor = new Color3(0.6, 0.7, 0.85);

    // Register update loop
    this.updateBound = this.update.bind(this);
    this.scene.registerBeforeRender(this.updateBound);
  }

  disable(): void {
    // Remove event listeners first
    if (this.canvas && this.onCanvasClick) {
      this.canvas.removeEventListener("click", this.onCanvasClick);
      this.onCanvasClick = null;
    }

    if (this.onPointerLockChange) {
      document.removeEventListener("pointerlockchange", this.onPointerLockChange);
      this.onPointerLockChange = null;
    }

    if (this.onMouseMove) {
      document.removeEventListener("mousemove", this.onMouseMove);
      this.onMouseMove = null;
    }

    if (this.keyboardObserver) {
      this.scene.onKeyboardObservable.remove(this.keyboardObserver);
      this.keyboardObserver = null;
    }

    // Unregister update
    if (this.updateBound) {
      this.scene.unregisterBeforeRender(this.updateBound);
      this.updateBound = null;
    }

    // Restore original foliage matrices
    this.restoreFoliage();

    // Remove unified water and restore original
    if (this.unifiedWater) {
      this.unifiedWater.dispose();
      this.unifiedWater = null;
    }
    const originalWater = this.scene.getMeshByName("water_plane");
    if (originalWater) {
      originalWater.isVisible = this.originalWaterVisible;
      originalWater.alwaysSelectAsActiveMesh = false;
    }

    // Collect terrain clones for disposal
    const tilesToDispose = [...this.tileClones];
    this.tileClones = [];

    // Remove terrain clones from scene
    for (const clone of tilesToDispose) {
      this.scene.removeMesh(clone);
    }

    // Re-enable frustum culling on original terrain
    if (this.originalMesh) {
      this.originalMesh.alwaysSelectAsActiveMesh = false;
    }

    // Dispose terrain clones after frame completes
    this.scene.onAfterRenderObservable.addOnce(() => {
      for (const clone of tilesToDispose) {
        if (!clone.isDisposed()) {
          clone.dispose();
        }
      }
    });

    // Dispose camera
    if (this.camera) {
      this.camera.dispose();
      this.camera = null;
    }

    // Reset fog
    this.scene.fogMode = Scene.FOGMODE_NONE;

    // Unlock pointer
    if (this.isPointerLocked) {
      document.exitPointerLock();
      this.isPointerLocked = false;
    }

    // Reset input state
    this.inputMap = {};
    this.canvas = null;

    // Dispose debug visualization
    this.disposeDebugVisualization();
  }

  private createTileGrid(): void {
    if (!this.originalMesh) return;

    const size = this.heightmap.getScale();

    // Refresh original mesh bounding info
    this.originalMesh.refreshBoundingInfo();

    if (this.tileMode === "mirror") {
      this.createMirroredTileGrid(size);
    } else {
      this.createClonedTileGrid(size);
    }

    // Also disable frustum culling on original
    this.originalMesh.alwaysSelectAsActiveMesh = true;
  }

  /**
   * Create tiles using simple cloning (original behavior)
   */
  private createClonedTileGrid(size: number): void {
    if (!this.originalMesh) return;

    for (let x = -1; x <= 1; x++) {
      for (let z = -1; z <= 1; z++) {
        if (x === 0 && z === 0) continue;

        const clone = this.originalMesh.clone(`tile_${x}_${z}`);
        if (clone) {
          clone.position.x = x * size;
          clone.position.z = z * size;
          clone.material = this.originalMesh.material;
          clone.refreshBoundingInfo();
          clone.alwaysSelectAsActiveMesh = true;
          this.tileClones.push(clone);
        }
      }
    }
  }

  /**
   * Create tiles using symmetric mirroring for seamless water/terrain connections.
   * Mirroring ensures edges match perfectly without needing to modify original data.
   *
   * Layout (looking down, +Z is up):
   *   (-1,-1) (0,-1) (1,-1)    XZ-mir  Z-mir  XZ-mir
   *   (-1, 0) (0, 0) (1, 0)    X-mir   orig   X-mir
   *   (-1, 1) (0, 1) (1, 1)    XZ-mir  Z-mir  XZ-mir
   */
  private createMirroredTileGrid(size: number): void {
    if (!this.originalMesh) return;

    for (let tx = -1; tx <= 1; tx++) {
      for (let tz = -1; tz <= 1; tz++) {
        if (tx === 0 && tz === 0) continue;

        const clone = this.originalMesh.clone(`tile_${tx}_${tz}`);
        if (!clone) continue;

        // Determine mirroring based on position
        // X-axis neighbors (left/right) mirror on X
        // Z-axis neighbors (top/bottom) mirror on Z
        // Diagonal neighbors mirror on both
        const mirrorX = tx !== 0;
        const mirrorZ = tz !== 0;

        // Apply scaling for mirroring
        // When mirroring, flip the scale on that axis
        const scaleX = mirrorX ? -1 : 1;
        const scaleZ = mirrorZ ? -1 : 1;
        clone.scaling = new Vector3(scaleX, 1, scaleZ);

        // Position calculation:
        // For mirrored tiles, the pivot point is at (0,0) so we need to offset
        // After mirroring with scaling, the mesh flips around its origin
        // We need to position it so the mirrored edge touches the original edge

        // For X mirror: tile at x=-1 should have its right edge touch original's left edge
        // Mirroring flips the mesh, so position needs adjustment
        let posX: number;
        let posZ: number;

        if (mirrorX) {
          // X-mirrored: position at boundary, mesh extends away
          posX = tx < 0 ? 0 : size;
        } else {
          // Not X-mirrored: normal positioning
          posX = tx * size;
        }

        if (mirrorZ) {
          // Z-mirrored: position at boundary
          posZ = tz < 0 ? 0 : size;
        } else {
          // Not Z-mirrored: normal positioning
          posZ = tz * size;
        }

        clone.position = new Vector3(posX, 0, posZ);

        // Ensure material handles backface correctly
        // Mirrored meshes need double-sided rendering or adjusted culling
        if (clone.material) {
          const mat = clone.material.clone(`mat_tile_${tx}_${tz}`);
          if (mat && "backFaceCulling" in mat) {
            (mat as StandardMaterial).backFaceCulling = false;
          }
          clone.material = mat;
        }

        clone.refreshBoundingInfo();
        clone.alwaysSelectAsActiveMesh = true;
        this.tileClones.push(clone);
      }
    }
  }

  /**
   * Extend foliage thin instances to cover all 9 tiles
   * Uses mirroring in mirror mode for seamless water/terrain connections
   */
  private extendFoliage(): void {
    if (this.tileMode === "mirror") {
      this.extendFoliageMirrored();
    } else {
      this.extendFoliageCloned();
    }
  }

  /**
   * Extend foliage with edge wrapping (clone mode)
   */
  private extendFoliageCloned(): void {
    const tileSize = this.heightmap.getScale();
    const wrapMargin = 8;

    const foliageMeshes = this.scene.meshes.filter(
      (mesh) =>
        mesh.name.startsWith("grass_v") ||
        mesh.name.startsWith("rock_v") ||
        mesh.name.startsWith("sandRock_v") ||
        mesh.name.startsWith("pebble_")
    ) as Mesh[];

    for (const mesh of foliageMeshes) {
      if (mesh.thinInstanceCount <= 0) continue;

      const originalBuffer = mesh.thinInstanceGetWorldMatrices();
      if (!originalBuffer || originalBuffer.length === 0) continue;

      const originalCount = mesh.thinInstanceCount;
      const originalMatrices = new Float32Array(originalCount * 16);
      for (let i = 0; i < originalBuffer.length; i++) {
        for (let j = 0; j < 16; j++) {
          originalMatrices[i * 16 + j] = originalBuffer[i].m[j];
        }
      }
      this.originalFoliageMatrices.set(mesh, originalMatrices);
      this.originalFoliageCounts.set(mesh, originalCount);

      const wrappedInstances: number[] = [];
      for (let i = 0; i < originalCount; i++) {
        for (let j = 0; j < 16; j++) {
          wrappedInstances.push(originalMatrices[i * 16 + j]);
        }
      }

      for (let i = 0; i < originalCount; i++) {
        const x = originalMatrices[i * 16 + 12];
        const z = originalMatrices[i * 16 + 14];
        const nearXMin = x < wrapMargin;
        const nearXMax = x > tileSize - wrapMargin;
        const nearZMin = z < wrapMargin;
        const nearZMax = z > tileSize - wrapMargin;

        if (nearXMin || nearXMax) {
          const matrix: number[] = [];
          for (let j = 0; j < 16; j++) matrix.push(originalMatrices[i * 16 + j]);
          matrix[12] = nearXMin ? x + tileSize : x - tileSize;
          wrappedInstances.push(...matrix);
        }

        if (nearZMin || nearZMax) {
          const matrix: number[] = [];
          for (let j = 0; j < 16; j++) matrix.push(originalMatrices[i * 16 + j]);
          matrix[14] = nearZMin ? z + tileSize : z - tileSize;
          wrappedInstances.push(...matrix);
        }

        if ((nearXMin || nearXMax) && (nearZMin || nearZMax)) {
          const matrix: number[] = [];
          for (let j = 0; j < 16; j++) matrix.push(originalMatrices[i * 16 + j]);
          matrix[12] = nearXMin ? x + tileSize : x - tileSize;
          matrix[14] = nearZMin ? z + tileSize : z - tileSize;
          wrappedInstances.push(...matrix);
        }
      }

      const wrappedCount = wrappedInstances.length / 16;
      const extendedMatrices = new Float32Array(wrappedCount * 9 * 16);

      let idx = 0;
      for (let tx = -1; tx <= 1; tx++) {
        for (let tz = -1; tz <= 1; tz++) {
          const offsetX = tx * tileSize;
          const offsetZ = tz * tileSize;
          for (let i = 0; i < wrappedCount; i++) {
            for (let j = 0; j < 16; j++) {
              extendedMatrices[idx * 16 + j] = wrappedInstances[i * 16 + j];
            }
            extendedMatrices[idx * 16 + 12] += offsetX;
            extendedMatrices[idx * 16 + 14] += offsetZ;
            idx++;
          }
        }
      }

      mesh.thinInstanceSetBuffer("matrix", extendedMatrices, 16, false);
      mesh.thinInstanceCount = wrappedCount * 9;
      mesh.thinInstanceRefreshBoundingInfo();
      mesh.alwaysSelectAsActiveMesh = true;
    }
  }

  /**
   * Extend foliage with mirroring for seamless connections.
   * Each tile's foliage is mirrored to match terrain mirroring.
   */
  private extendFoliageMirrored(): void {
    const tileSize = this.heightmap.getScale();

    const foliageMeshes = this.scene.meshes.filter(
      (mesh) =>
        mesh.name.startsWith("grass_v") ||
        mesh.name.startsWith("rock_v") ||
        mesh.name.startsWith("sandRock_v") ||
        mesh.name.startsWith("pebble_")
    ) as Mesh[];

    for (const mesh of foliageMeshes) {
      if (mesh.thinInstanceCount <= 0) continue;

      const originalBuffer = mesh.thinInstanceGetWorldMatrices();
      if (!originalBuffer || originalBuffer.length === 0) continue;

      const originalCount = mesh.thinInstanceCount;
      const originalMatrices = new Float32Array(originalCount * 16);
      for (let i = 0; i < originalBuffer.length; i++) {
        for (let j = 0; j < 16; j++) {
          originalMatrices[i * 16 + j] = originalBuffer[i].m[j];
        }
      }
      this.originalFoliageMatrices.set(mesh, originalMatrices);
      this.originalFoliageCounts.set(mesh, originalCount);

      // Create mirrored instances for all 9 tiles
      const extendedMatrices: number[] = [];

      for (let tx = -1; tx <= 1; tx++) {
        for (let tz = -1; tz <= 1; tz++) {
          const mirrorX = tx !== 0;
          const mirrorZ = tz !== 0;

          for (let i = 0; i < originalCount; i++) {
            // Get original position
            let x = originalMatrices[i * 16 + 12];
            let z = originalMatrices[i * 16 + 14];

            // Mirror positions
            if (mirrorX) {
              x = tileSize - x; // Mirror around center of tile
            }
            if (mirrorZ) {
              z = tileSize - z;
            }

            // Calculate final position with tile offset
            let finalX: number;
            let finalZ: number;

            if (tx < 0) {
              finalX = -x; // Left tiles: extend to negative X
            } else if (tx > 0) {
              finalX = tileSize + (tileSize - x); // Right tiles: extend past tileSize
            } else {
              finalX = x; // Center: original position
            }

            if (tz < 0) {
              finalZ = -z; // Bottom tiles: extend to negative Z
            } else if (tz > 0) {
              finalZ = tileSize + (tileSize - z); // Top tiles: extend past tileSize
            } else {
              finalZ = z; // Center: original position
            }

            // Copy matrix and update position
            for (let j = 0; j < 16; j++) {
              extendedMatrices.push(originalMatrices[i * 16 + j]);
            }
            const lastIdx = extendedMatrices.length - 16;
            extendedMatrices[lastIdx + 12] = finalX;
            extendedMatrices[lastIdx + 14] = finalZ;

            // Mirror the scale for proper rotation appearance
            if (mirrorX) {
              extendedMatrices[lastIdx + 0] *= -1; // Scale X in matrix
            }
            if (mirrorZ) {
              extendedMatrices[lastIdx + 10] *= -1; // Scale Z in matrix
            }
          }
        }
      }

      mesh.thinInstanceSetBuffer("matrix", new Float32Array(extendedMatrices), 16, false);
      mesh.thinInstanceCount = extendedMatrices.length / 16;
      mesh.thinInstanceRefreshBoundingInfo();
      mesh.alwaysSelectAsActiveMesh = true;
    }
  }

  /**
   * Restore original foliage thin instance data
   */
  private restoreFoliage(): void {
    for (const [mesh, originalMatrices] of this.originalFoliageMatrices) {
      const originalCount = this.originalFoliageCounts.get(mesh);
      if (originalCount && !mesh.isDisposed()) {
        mesh.thinInstanceSetBuffer("matrix", originalMatrices, 16, false);
        mesh.thinInstanceCount = originalCount;
        mesh.thinInstanceRefreshBoundingInfo();
        mesh.alwaysSelectAsActiveMesh = false;
      }
    }
    this.originalFoliageMatrices.clear();
    this.originalFoliageCounts.clear();
  }

  /**
   * Create a unified water plane covering the entire 3x3 grid
   */
  private createUnifiedWater(): void {
    const originalWater = this.scene.getMeshByName("water_plane") as Mesh;
    if (!originalWater) return;

    // Store original visibility
    this.originalWaterVisible = originalWater.isVisible;

    // Hide original water
    originalWater.isVisible = false;

    const tileSize = this.heightmap.getScale();
    const totalSize = tileSize * 3;

    // Create unified water plane
    this.unifiedWater = MeshBuilder.CreateGround(
      "unified_water",
      { width: totalSize, height: totalSize, subdivisions: 64 },
      this.scene
    );

    // Position at center of 3x3 grid
    this.unifiedWater.position.x = tileSize / 2;
    this.unifiedWater.position.y = originalWater.position.y;
    this.unifiedWater.position.z = tileSize / 2;

    // Use same material as original water
    this.unifiedWater.material = originalWater.material;
    this.unifiedWater.alwaysSelectAsActiveMesh = true;
  }

  private setupCamera(): void {
    const size = this.heightmap.getScale();
    const centerX = size / 2;
    const centerZ = size / 2;

    // Start at a good overview position
    const groundHeight = this.heightmap.getInterpolatedHeight(centerX, centerZ);
    const startY = groundHeight + 15; // Higher starting position for overview

    this.camera = new FreeCamera(
      "gameCamera",
      new Vector3(centerX, startY, centerZ),
      this.scene
    );

    this.camera.minZ = 0.1;
    this.camera.maxZ = 1000;
    this.camera.fov = 1.0; // ~57 degrees, slightly narrower for exploration
    this.camera.inertia = 0;
    this.camera.angularSensibility = 500;

    // Look slightly downward initially
    this.camera.rotation.x = 0.3;

    // Detach default controls - we'll handle manually
    this.camera.inputs.clear();

    this.scene.activeCamera = this.camera;
  }

  private setupInput(): void {
    this.canvas = this.scene.getEngine().getRenderingCanvas();
    if (!this.canvas) return;

    const canvas = this.canvas;

    // Pointer lock on click
    this.onCanvasClick = () => {
      if (!this.isPointerLocked) {
        canvas.requestPointerLock();
      }
    };
    canvas.addEventListener("click", this.onCanvasClick);

    this.onPointerLockChange = () => {
      this.isPointerLocked = document.pointerLockElement === canvas;
    };
    document.addEventListener("pointerlockchange", this.onPointerLockChange);

    // Mouse movement for camera rotation
    this.onMouseMove = (e: MouseEvent) => {
      if (!this.isPointerLocked || !this.camera) return;

      const sensitivity = 0.002;
      this.camera.rotation.y += e.movementX * sensitivity;
      this.camera.rotation.x += e.movementY * sensitivity;

      // Clamp vertical rotation
      this.camera.rotation.x = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, this.camera.rotation.x));
    };
    document.addEventListener("mousemove", this.onMouseMove);

    // Keyboard input
    this.keyboardObserver = this.scene.onKeyboardObservable.add((kbInfo) => {
      const key = kbInfo.event.key.toLowerCase();

      if (kbInfo.type === KeyboardEventTypes.KEYDOWN) {
        this.inputMap[key] = true;

        // Exit pointer lock with Escape
        if (key === "escape" && this.isPointerLocked) {
          document.exitPointerLock();
        }
      } else if (kbInfo.type === KeyboardEventTypes.KEYUP) {
        this.inputMap[key] = false;
      }
    });
  }

  private update = (): void => {
    if (!this.camera) return;

    const deltaTime = this.scene.getEngine().getDeltaTime() / 1000;
    const size = this.heightmap.getScale();

    // Movement input
    let moveX = 0;
    let moveY = 0;
    let moveZ = 0;

    if (this.inputMap["w"]) moveZ += 1;
    if (this.inputMap["s"]) moveZ -= 1;
    if (this.inputMap["a"]) moveX -= 1;
    if (this.inputMap["d"]) moveX += 1;
    if (this.inputMap["e"] || this.inputMap[" "]) moveY += 1;  // Up
    if (this.inputMap["q"]) moveY -= 1;  // Down

    // Fast movement with Shift
    const speed = this.inputMap["shift"] ? this.fastMoveSpeed : this.moveSpeed;

    // Calculate movement direction based on camera rotation (free flight)
    const forward = new Vector3(
      Math.sin(this.camera.rotation.y) * Math.cos(this.camera.rotation.x),
      -Math.sin(this.camera.rotation.x),
      Math.cos(this.camera.rotation.y) * Math.cos(this.camera.rotation.x)
    );
    const right = new Vector3(
      Math.sin(this.camera.rotation.y + Math.PI / 2),
      0,
      Math.cos(this.camera.rotation.y + Math.PI / 2)
    );
    const up = new Vector3(0, 1, 0);

    // Apply movement in all directions
    const moveDir = forward.scale(moveZ).add(right.scale(moveX)).add(up.scale(moveY));

    this.camera.position.x += moveDir.x * speed * deltaTime;
    this.camera.position.y += moveDir.y * speed * deltaTime;
    this.camera.position.z += moveDir.z * speed * deltaTime;

    // Wrap position for infinite world feel
    const wrapMargin = size * 1.5;
    if (this.camera.position.x > wrapMargin) this.camera.position.x -= size;
    if (this.camera.position.x < -wrapMargin + size) this.camera.position.x += size;
    if (this.camera.position.z > wrapMargin) this.camera.position.z -= size;
    if (this.camera.position.z < -wrapMargin + size) this.camera.position.z += size;

    // Prevent going below ground
    let checkX = this.camera.position.x % size;
    let checkZ = this.camera.position.z % size;
    if (checkX < 0) checkX += size;
    if (checkZ < 0) checkZ += size;

    const groundHeight = this.heightmap.getInterpolatedHeight(checkX, checkZ);
    const minY = groundHeight + 1; // Minimum 1 unit above ground

    if (this.camera.position.y < minY) {
      this.camera.position.y = minY;
    }
  };

  getCamera(): FreeCamera | null {
    return this.camera;
  }

  /**
   * Enable or disable debug visualization for tile boundaries
   */
  setDebugEnabled(enabled: boolean): void {
    this.debugEnabled = enabled;
    if (enabled) {
      this.createDebugVisualization();
    } else {
      this.disposeDebugVisualization();
    }
  }

  /**
   * Create debug visualization showing tile boundaries, heights, and materials
   */
  private createDebugVisualization(): void {
    this.disposeDebugVisualization();

    const size = this.heightmap.getScale();
    const sampleCount = 16; // Number of sample points per edge

    // Get splat map for material info
    const splatMap = this.terrainMeshRef?.getSplatMap();

    // Material colors for visualization
    const biomeColors = [
      new Color3(0.2, 0.8, 0.2), // grass - green
      new Color3(0.6, 0.4, 0.2), // dirt - brown
      new Color3(0.5, 0.5, 0.5), // rock - gray
      new Color3(0.9, 0.85, 0.6), // sand - tan
    ];
    const waterColor = new Color3(0.2, 0.5, 0.9);

    // Create boundary lines for the center tile (original)
    const boundaryMat = new StandardMaterial("debug_boundary_mat", this.scene);
    boundaryMat.emissiveColor = new Color3(1, 1, 0);
    boundaryMat.disableLighting = true;

    // Log edge data to console
    console.log("=== TILE BOUNDARY DEBUG INFO ===");

    // Sample and visualize each edge
    const edges = [
      { name: "LEFT (X=0)", getPos: (t: number) => ({ x: 0, z: t * size }) },
      { name: "RIGHT (X=max)", getPos: (t: number) => ({ x: size, z: t * size }) },
      { name: "TOP (Z=0)", getPos: (t: number) => ({ x: t * size, z: 0 }) },
      { name: "BOTTOM (Z=max)", getPos: (t: number) => ({ x: t * size, z: size }) },
    ];

    for (const edge of edges) {
      console.log(`\n--- ${edge.name} ---`);
      const heights: number[] = [];
      const materials: string[] = [];

      for (let i = 0; i <= sampleCount; i++) {
        const t = i / sampleCount;
        const pos = edge.getPos(t);

        // Get height
        const height = this.heightmap.getInterpolatedHeight(
          Math.min(pos.x, size - 0.01),
          Math.min(pos.z, size - 0.01)
        );
        heights.push(height);

        // Get material info
        if (splatMap) {
          const sRes = splatMap.getResolution();
          const sx = Math.floor((pos.x / size) * (sRes - 1));
          const sz = Math.floor((pos.z / size) * (sRes - 1));
          const weights = splatMap.getWeights(
            Math.min(sx, sRes - 1),
            Math.min(sz, sRes - 1)
          );
          const waterWeight = splatMap.getWaterWeight(
            Math.min(sx, sRes - 1),
            Math.min(sz, sRes - 1)
          );

          // Find dominant material
          let maxWeight = 0;
          let dominantIdx = 0;
          const matNames = ["grass", "dirt", "rock", "sand"];
          for (let c = 0; c < 4; c++) {
            if (weights[c] > maxWeight) {
              maxWeight = weights[c];
              dominantIdx = c;
            }
          }
          const matName = waterWeight > 0.3 ? "WATER" : matNames[dominantIdx];
          materials.push(matName);

          // Create debug sphere at sample point
          const sphereColor = waterWeight > 0.3 ? waterColor : biomeColors[dominantIdx];
          const sphere = MeshBuilder.CreateSphere(
            `debug_sphere_${edge.name}_${i}`,
            { diameter: 0.5 },
            this.scene
          );
          sphere.position = new Vector3(pos.x, height + 0.5, pos.z);

          const sphereMat = new StandardMaterial(`debug_mat_${edge.name}_${i}`, this.scene);
          sphereMat.emissiveColor = sphereColor;
          sphereMat.disableLighting = true;
          sphere.material = sphereMat;

          this.debugMeshes.push(sphere);
        }
      }

      // Log edge data
      console.log(`Heights: min=${Math.min(...heights).toFixed(2)}, max=${Math.max(...heights).toFixed(2)}`);
      console.log(`Materials: ${[...new Set(materials)].join(", ")}`);

      // Check if edges match (for seamless tiling)
      if (edge.name.includes("LEFT") || edge.name.includes("RIGHT")) {
        // Compare left and right
      }
    }

    // Create edge comparison
    console.log("\n=== EDGE COMPARISON ===");

    // Compare LEFT vs RIGHT edges
    let leftRightMatch = true;
    let topBottomMatch = true;

    for (let i = 0; i <= sampleCount; i++) {
      const t = i / sampleCount;
      const z = t * size;
      const x_t = t * size;

      // Left vs Right
      const leftH = this.heightmap.getInterpolatedHeight(0, z);
      const rightH = this.heightmap.getInterpolatedHeight(size - 0.01, z);
      if (Math.abs(leftH - rightH) > 0.5) {
        leftRightMatch = false;
      }

      // Top vs Bottom
      const topH = this.heightmap.getInterpolatedHeight(x_t, 0);
      const bottomH = this.heightmap.getInterpolatedHeight(x_t, size - 0.01);
      if (Math.abs(topH - bottomH) > 0.5) {
        topBottomMatch = false;
      }
    }

    console.log(`LEFT-RIGHT edges match: ${leftRightMatch ? "YES" : "NO (height mismatch!)"}`);
    console.log(`TOP-BOTTOM edges match: ${topBottomMatch ? "YES" : "NO (height mismatch!)"}`);

    // Create boundary lines
    const lineHeight = this.heightmap.getInterpolatedHeight(size / 2, size / 2) + 10;
    const linePoints = [
      // Original tile boundaries
      [new Vector3(0, lineHeight, 0), new Vector3(size, lineHeight, 0)],
      [new Vector3(size, lineHeight, 0), new Vector3(size, lineHeight, size)],
      [new Vector3(size, lineHeight, size), new Vector3(0, lineHeight, size)],
      [new Vector3(0, lineHeight, size), new Vector3(0, lineHeight, 0)],
    ];

    for (let i = 0; i < linePoints.length; i++) {
      const line = MeshBuilder.CreateLines(
        `debug_line_${i}`,
        { points: linePoints[i] },
        this.scene
      );
      line.color = new Color3(1, 1, 0);
      this.debugLines.push(line);
    }

    console.log("=== DEBUG VISUALIZATION CREATED ===");
  }

  /**
   * Dispose all debug visualization meshes
   */
  private disposeDebugVisualization(): void {
    for (const mesh of this.debugMeshes) {
      mesh.material?.dispose();
      mesh.dispose();
    }
    this.debugMeshes = [];

    for (const line of this.debugLines) {
      line.dispose();
    }
    this.debugLines = [];
  }
}
