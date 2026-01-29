import {
  Scene,
  Vector3,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  ShaderMaterial,
  Color3,
  Color4,
  FreeCamera,
  KeyboardEventTypes,
} from "@babylonjs/core";
import { Heightmap } from "../terrain/Heightmap";
import { TerrainMesh } from "../terrain/TerrainMesh";
import { FoliageSystem } from "../foliage/FoliageSystem";
import { BiomeDecorator } from "../terrain/BiomeDecorator";
import type { SkyWeatherSystem } from "../weather/SkyWeatherSystem";

export class GamePreview {
  private scene: Scene;
  private heightmap: Heightmap;
  private terrainMeshRef: TerrainMesh | null = null;
  private foliageSystem: FoliageSystem | null = null;
  private biomeDecorator: BiomeDecorator | null = null;
  private skyWeatherSystem: SkyWeatherSystem | null = null;
  private camera: FreeCamera | null = null;
  private originalMesh: Mesh | null = null;
  private unifiedWater: Mesh | null = null;
  private originalWaterVisible: boolean = true;

  // Free camera state
  private moveSpeed = 5.625;      // 3x speed (was 1.875)
  private fastMoveSpeed = 11.25;  // 3x speed (was 3.75)

  // Input state
  private inputMap: { [key: string]: boolean } = {};
  private isPointerLocked = false;

  // Event handler references for cleanup
  private canvas: HTMLCanvasElement | null = null;
  private onCanvasClick: (() => void) | null = null;
  private onPointerLockChange: (() => void) | null = null;
  private onMouseMove: ((e: MouseEvent) => void) | null = null;
  private onWheel: ((e: WheelEvent) => void) | null = null;
  private keyboardObserver: any = null;
  private updateBound: (() => void) | null = null;

  // Reusable vectors for update loop (avoid GC pressure)
  private readonly _forward = new Vector3();
  private readonly _right = new Vector3();
  private readonly _up = new Vector3(0, 1, 0);
  private readonly _moveDir = new Vector3();

  constructor(
    scene: Scene,
    heightmap: Heightmap,
    terrainMesh?: TerrainMesh | null,
    foliageSystem?: FoliageSystem | null,
    biomeDecorator?: BiomeDecorator | null,
    skyWeatherSystem?: SkyWeatherSystem | null
  ) {
    this.scene = scene;
    this.heightmap = heightmap;
    this.terrainMeshRef = terrainMesh || null;
    this.foliageSystem = foliageSystem || null;
    this.biomeDecorator = biomeDecorator || null;
    this.skyWeatherSystem = skyWeatherSystem || null;
  }

  setSkyWeatherSystem(system: SkyWeatherSystem | null): void {
    this.skyWeatherSystem = system;
  }

  enable(terrainMesh: Mesh): void {
    this.originalMesh = terrainMesh;

    // Adjust foliage LOD distances for game mode
    // Use smaller distances for performance - foliage fades into fog
    const size = this.heightmap.getScale();
    if (this.foliageSystem) {
      this.foliageSystem.setLODDistances(
        size * 0.25,  // near: 25% of terrain size (full detail)
        size * 0.35,  // mid: 35% of terrain size (reduced)
        size * 0.5    // far: 50% of terrain size (culled)
      );
      // Force initial visibility update
      const startPos = new Vector3(size / 2, 0, size / 2);
      this.foliageSystem.updateVisibility(startPos);
    }

    // Create unified water plane
    this.createUnifiedWater();

    // Refresh water reflections render list for game mode
    if (this.biomeDecorator) {
      this.biomeDecorator.refreshWaterReflections();
    }

    // Setup first-person camera
    this.setupCamera();

    // Setup input
    this.setupInput();

    // Get sky/fog values from weather system, or use defaults
    const skyColor = this.skyWeatherSystem?.getSkyHorizonColor() || new Color3(0.55, 0.7, 0.9);
    const fogDensity = this.skyWeatherSystem?.getFogDensity() || 0.015;

    // Change scene background for game feel - sky/horizon color
    this.scene.clearColor = new Color4(skyColor.r, skyColor.g, skyColor.b, 1);

    // Atmospheric fog - blends objects into the sky at distance
    this.scene.fogMode = Scene.FOGMODE_EXP2;
    this.scene.fogDensity = fogDensity;
    this.scene.fogColor = skyColor;

    // Notify weather system of game mode (it will handle shader sync)
    if (this.skyWeatherSystem) {
      this.skyWeatherSystem.setGameMode(true);
    } else {
      // Fallback: manual sync if no weather system
      // Sync terrain shader fog with scene fog (same color = seamless blend)
      if (this.originalMesh && this.originalMesh.material) {
        const material = this.originalMesh.material as ShaderMaterial;
        if (material.setFloat && material.setColor3) {
          material.setFloat("uFogDensity", fogDensity);
          material.setColor3("uFogColor", skyColor);
        }
      }

      // Also apply to terrainMeshRef if available
      if (this.terrainMeshRef) {
        const material = this.terrainMeshRef.getMaterial() as ShaderMaterial | null;
        if (material && material.setFloat && material.setColor3) {
          material.setFloat("uFogDensity", fogDensity);
          material.setColor3("uFogColor", skyColor);
        }
      }

      // Sync foliage system fog with scene fog for consistent blending
      if (this.foliageSystem) {
        this.foliageSystem.syncFogSettings(skyColor, fogDensity);
      }
    }

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

    if (this.canvas && this.onWheel) {
      this.canvas.removeEventListener("wheel", this.onWheel);
      this.onWheel = null;
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

    // Notify weather system of editor mode
    if (this.skyWeatherSystem) {
      this.skyWeatherSystem.setGameMode(false);
    }

    // Restore foliage LOD distances
    if (this.foliageSystem) {
      this.foliageSystem.setLODDistances(30, 60, 100);

      // Reset fog to editor defaults (minimal fog in editor mode)
      this.foliageSystem.syncFogSettings(new Color3(0.6, 0.75, 0.9), 0.008);
    }

    // Re-enable terrain LOD and restore shader fog settings
    if (this.terrainMeshRef) {
      this.terrainMeshRef.setLODEnabled(true);
      const material = this.terrainMeshRef.getMaterial() as ShaderMaterial | null;
      if (material && material.setFloat && material.setColor3) {
        // Restore original fog values from TerrainShader.ts
        material.setFloat("uFogDensity", 0.008);
        material.setColor3("uFogColor", new Color3(0.6, 0.75, 0.9));
      }
    }

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
  }


  /**
   * Create a unified water plane covering the single terrain
   */
  private createUnifiedWater(): void {
    const originalWater = this.scene.getMeshByName("water_plane") as Mesh;
    if (!originalWater) {
      return;
    }

    // Store original visibility
    this.originalWaterVisible = originalWater.isVisible;

    // Hide original water
    originalWater.isVisible = false;

    const tileSize = this.heightmap.getScale();
    const totalSize = tileSize;

    // Create unified water plane covering single terrain
    this.unifiedWater = MeshBuilder.CreateGround(
      "unified_water",
      { width: totalSize, height: totalSize, subdivisions: 64 },
      this.scene
    );

    // Position at center of terrain
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

    // Block mouse wheel events in game mode (prevents unwanted camera manipulation)
    this.onWheel = (e: WheelEvent) => {
      // Prevent default scroll behavior and stop propagation to Babylon.js
      e.preventDefault();
      e.stopPropagation();
    };
    canvas.addEventListener("wheel", this.onWheel, { passive: false });

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

    // Calculate movement direction - FPS style (horizontal movement only for WASD)
    // Forward/back moves along the direction camera is facing, but always horizontal
    // Reuse vectors to avoid GC pressure
    const rotY = this.camera.rotation.y;
    this._forward.set(Math.sin(rotY), 0, Math.cos(rotY));
    this._right.set(Math.sin(rotY + Math.PI / 2), 0, Math.cos(rotY + Math.PI / 2));
    // this._up is already (0, 1, 0)

    // Apply movement: WASD for horizontal, Q/E/Space for vertical
    // Manual calculation to avoid creating intermediate vectors
    this._moveDir.set(
      this._forward.x * moveZ + this._right.x * moveX,
      moveY,  // up component
      this._forward.z * moveZ + this._right.z * moveX
    );

    this.camera.position.x += this._moveDir.x * speed * deltaTime;
    this.camera.position.y += this._moveDir.y * speed * deltaTime;
    this.camera.position.z += this._moveDir.z * speed * deltaTime;

    // Keep camera within single terrain bounds (0 to size)
    const minBound = 0;
    const maxBound = size;
    this.camera.position.x = Math.max(minBound, Math.min(maxBound, this.camera.position.x));
    this.camera.position.z = Math.max(minBound, Math.min(maxBound, this.camera.position.z));

    // Prevent going below ground
    const checkX = Math.max(0, Math.min(size - 0.01, this.camera.position.x));
    const checkZ = Math.max(0, Math.min(size - 0.01, this.camera.position.z));

    const groundHeight = this.heightmap.getInterpolatedHeight(checkX, checkZ);
    const minY = groundHeight + 1; // Minimum 1 unit above ground

    if (this.camera.position.y < minY) {
      this.camera.position.y = minY;
    }

    // Update foliage visibility based on camera position (LOD culling)
    if (this.foliageSystem) {
      this.foliageSystem.updateVisibility(this.camera.position);

      // Update camera position for fog calculation in grass shader
      this.foliageSystem.updateCameraPosition(this.camera.position);

      // Update time for wind animation
      const time = performance.now() / 1000;
      this.foliageSystem.updateTime(time);
    }
  };

  getCamera(): FreeCamera | null {
    return this.camera;
  }
}
