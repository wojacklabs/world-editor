import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { disposeMesh } from "../../shared/rendering/threeHelpers";
import { Heightmap } from "../terrain/Heightmap";
import { TerrainMesh } from "../terrain/TerrainMesh";
import { FoliageSystem } from "../foliage/FoliageSystem";
import { BiomeDecorator } from "../terrain/BiomeDecorator";
import type { SkyWeatherSystem } from "../weather/SkyWeatherSystem";

export class GamePreview {
  private scene: THREE.Scene;
  private heightmap: Heightmap;
  private terrainMeshRef: TerrainMesh | null = null;
  private foliageSystem: FoliageSystem | null = null;
  private biomeDecorator: BiomeDecorator | null = null;
  private skyWeatherSystem: SkyWeatherSystem | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private controls: PointerLockControls | null = null;
  private originalMesh: THREE.Mesh | null = null;
  private unifiedWater: THREE.Mesh | null = null;
  private originalWaterVisible: boolean = true;

  // Free camera state
  private moveSpeed = 5.625;      // 3x speed (was 1.875)
  private fastMoveSpeed = 11.25;  // 3x speed (was 3.75)

  // Input state
  private moveForward = false;
  private moveBackward = false;
  private moveLeft = false;
  private moveRight = false;
  private moveUp = false;
  private moveDown = false;
  private isSprinting = false;

  // Multi-tile grid bounds (defaults to single tile)
  private gridBoundsMin = new THREE.Vector2(0, 0);
  private gridBoundsMax = new THREE.Vector2(0, 0); // Set in enable()

  // Event handler references for cleanup
  private canvas: HTMLCanvasElement | null = null;
  private onCanvasClick: (() => void) | null = null;
  private onKeyDown: ((e: KeyboardEvent) => void) | null = null;
  private onKeyUp: ((e: KeyboardEvent) => void) | null = null;
  private onWheel: ((e: WheelEvent) => void) | null = null;

  constructor(
    scene: THREE.Scene,
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

  /**
   * Set the world bounds for multi-tile grid (in world units).
   * Camera will be clamped within these bounds.
   */
  setGridBounds(minX: number, minZ: number, maxX: number, maxZ: number): void {
    this.gridBoundsMin.set(minX, minZ);
    this.gridBoundsMax.set(maxX, maxZ);
  }

  enable(terrainMesh: THREE.Mesh): void {
    this.originalMesh = terrainMesh;

    // Set default bounds to single tile
    const size = this.heightmap.getScale();
    if (this.gridBoundsMax.x === 0 && this.gridBoundsMax.y === 0) {
      this.gridBoundsMin.set(0, 0);
      this.gridBoundsMax.set(size, size);
    }

    // Adjust foliage LOD distances for game mode
    // Use smaller distances for performance - foliage fades into fog
    if (this.foliageSystem) {
      this.foliageSystem.setLODDistances(
        size * 0.25,  // near: 25% of terrain size (full detail)
        size * 0.35,  // mid: 35% of terrain size (reduced)
        size * 0.5    // far: 50% of terrain size (culled)
      );
      // Force initial visibility update
      const startPos = new THREE.Vector3(size / 2, 0, size / 2);
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
    const skyColor = this.skyWeatherSystem?.getSkyHorizonColor() || new THREE.Color(0.55, 0.7, 0.9);
    const fogDensity = this.skyWeatherSystem?.getFogDensity() || 0.008;

    // Change scene background for game feel - sky/horizon color
    this.scene.background = new THREE.Color(skyColor.r, skyColor.g, skyColor.b);

    // Notify weather system of game mode (it will handle shader sync)
    if (this.skyWeatherSystem) {
      this.skyWeatherSystem.setGameMode(true);
      // Set game camera so sky sphere follows it
      if (this.camera) {
        this.skyWeatherSystem.setCamera(this.camera);
      }
    } else {
      // Fallback: manual sync if no weather system
      // Sync terrain shader fog with scene fog (same color = seamless blend)
      if (this.originalMesh && this.originalMesh.material) {
        const material = this.originalMesh.material as any;
        if (material.uniforms) {
          if (material.uniforms.uFogDensity) material.uniforms.uFogDensity.value = fogDensity;
          if (material.uniforms.uFogColor) material.uniforms.uFogColor.value.set(skyColor.r, skyColor.g, skyColor.b);
        }
      }

      // Also apply to terrainMeshRef if available
      if (this.terrainMeshRef) {
        const material = this.terrainMeshRef.getMaterial() as any;
        if (material?.uniforms) {
          if (material.uniforms.uFogDensity) material.uniforms.uFogDensity.value = fogDensity;
          if (material.uniforms.uFogColor) material.uniforms.uFogColor.value.set(skyColor.r, skyColor.g, skyColor.b);
        }
      }

      // Sync foliage system fog with scene fog for consistent blending
      if (this.foliageSystem) {
        this.foliageSystem.syncFogSettings(new THREE.Color(skyColor.r, skyColor.g, skyColor.b), fogDensity);
      }
    }
  }

  disable(): void {
    // Remove event listeners first
    if (this.canvas && this.onCanvasClick) {
      this.canvas.removeEventListener("click", this.onCanvasClick);
      this.onCanvasClick = null;
    }

    if (this.onKeyDown) {
      document.removeEventListener("keydown", this.onKeyDown);
      this.onKeyDown = null;
    }

    if (this.onKeyUp) {
      document.removeEventListener("keyup", this.onKeyUp);
      this.onKeyUp = null;
    }

    if (this.canvas && this.onWheel) {
      this.canvas.removeEventListener("wheel", this.onWheel);
      this.onWheel = null;
    }

    // Notify weather system of editor mode
    if (this.skyWeatherSystem) {
      this.skyWeatherSystem.setGameMode(false);
    }

    // Restore foliage LOD distances
    if (this.foliageSystem) {
      this.foliageSystem.setLODDistances(30, 60, 100);

      // Reset fog to editor defaults (minimal fog in editor mode)
      this.foliageSystem.syncFogSettings(new THREE.Color(0.6, 0.75, 0.9), 0.008);
    }

    // Re-enable terrain LOD and restore shader fog settings
    if (this.terrainMeshRef) {
      this.terrainMeshRef.setLODEnabled(true);
      const material = this.terrainMeshRef.getMaterial() as any;
      if (material?.uniforms) {
        // Restore original fog values from TerrainShader.ts
        if (material.uniforms.uFogDensity) material.uniforms.uFogDensity.value = 0.008;
        if (material.uniforms.uFogColor) material.uniforms.uFogColor.value.set(0.6, 0.75, 0.9);
      }
    }

    // Remove unified water and restore original
    if (this.unifiedWater) {
      disposeMesh(this.scene, this.unifiedWater);
      this.unifiedWater = null;
    }
    const originalWater = this.scene.getObjectByName("water_plane");
    if (originalWater) {
      originalWater.visible = this.originalWaterVisible;
    }

    // Unlock pointer before disposing controls
    if (this.controls?.isLocked) {
      this.controls.unlock();
    }

    // Dispose controls and camera
    if (this.controls) {
      this.controls.dispose();
      this.controls = null;
    }
    this.camera = null;

    // Fallback: ensure pointer is unlocked even after controls disposal
    if (document.pointerLockElement) {
      document.exitPointerLock();
    }

    // Reset input state
    this.moveForward = false;
    this.moveBackward = false;
    this.moveLeft = false;
    this.moveRight = false;
    this.moveUp = false;
    this.moveDown = false;
    this.isSprinting = false;
    this.canvas = null;
  }


  /**
   * Create a unified water plane covering the single terrain
   */
  private createUnifiedWater(): void {
    const originalWater = this.scene.getObjectByName("water_plane") as THREE.Mesh;
    if (!originalWater) {
      return;
    }

    // Store original visibility
    this.originalWaterVisible = originalWater.visible;

    // Hide original water
    originalWater.visible = false;

    const tileSize = this.heightmap.getScale();
    const totalSize = tileSize;

    // Create unified water plane covering single terrain
    const geometry = new THREE.PlaneGeometry(totalSize, totalSize, 64, 64);
    geometry.rotateX(-Math.PI / 2); // PlaneGeometry faces +Y by default, rotate to XZ

    this.unifiedWater = new THREE.Mesh(geometry, originalWater.material);

    // Position at center of terrain
    this.unifiedWater.position.set(
      tileSize / 2,
      originalWater.position.y,
      tileSize / 2
    );

    this.unifiedWater.frustumCulled = false;
    this.scene.add(this.unifiedWater);
  }

  private setupCamera(): void {
    const size = this.heightmap.getScale();
    const centerX = size / 2;
    const centerZ = size / 2;

    // Start at a good overview position
    const groundHeight = this.heightmap.getInterpolatedHeight(centerX, centerZ);
    const startY = groundHeight + 15; // Higher starting position for overview

    // fov ~57 degrees (1.0 rad), aspect will be set by renderer
    this.camera = new THREE.PerspectiveCamera(57, 1, 0.1, 1000);
    this.camera.position.set(centerX, startY, centerZ);

    // Look slightly downward initially
    this.camera.rotation.order = "YXZ";
    this.camera.rotation.x = -0.3;
  }

  private setupInput(): void {
    this.canvas = document.querySelector("canvas");
    if (!this.canvas) return;

    const canvas = this.canvas;

    // Setup PointerLockControls
    this.controls = new PointerLockControls(this.camera!, canvas);

    // Pointer lock on click
    this.onCanvasClick = () => {
      if (this.controls && !this.controls.isLocked) {
        this.controls.lock();
      }
    };
    canvas.addEventListener("click", this.onCanvasClick);

    // Block mouse wheel events in game mode (prevents unwanted camera manipulation)
    this.onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    canvas.addEventListener("wheel", this.onWheel, { passive: false });

    // Keyboard input
    this.onKeyDown = (e: KeyboardEvent) => {
      switch (e.code) {
        case "KeyW": this.moveForward = true; break;
        case "KeyS": this.moveBackward = true; break;
        case "KeyA": this.moveLeft = true; break;
        case "KeyD": this.moveRight = true; break;
        case "KeyE":
        case "Space": this.moveUp = true; break;
        case "KeyQ": this.moveDown = true; break;
        case "ShiftLeft":
        case "ShiftRight": this.isSprinting = true; break;
        case "Escape":
          if (this.controls?.isLocked) {
            this.controls.unlock();
          }
          break;
      }
    };
    document.addEventListener("keydown", this.onKeyDown);

    this.onKeyUp = (e: KeyboardEvent) => {
      switch (e.code) {
        case "KeyW": this.moveForward = false; break;
        case "KeyS": this.moveBackward = false; break;
        case "KeyA": this.moveLeft = false; break;
        case "KeyD": this.moveRight = false; break;
        case "KeyE":
        case "Space": this.moveUp = false; break;
        case "KeyQ": this.moveDown = false; break;
        case "ShiftLeft":
        case "ShiftRight": this.isSprinting = false; break;
      }
    };
    document.addEventListener("keyup", this.onKeyUp);
  }

  update(deltaTime: number): void {
    if (!this.camera || !this.controls) return;

    const size = this.heightmap.getScale();

    // Fast movement with Shift
    const speed = this.isSprinting ? this.fastMoveSpeed : this.moveSpeed;

    // Calculate movement direction using PointerLockControls helpers
    const forwardAmount = Number(this.moveForward) - Number(this.moveBackward);
    const rightAmount = Number(this.moveRight) - Number(this.moveLeft);
    const upAmount = Number(this.moveUp) - Number(this.moveDown);

    // PointerLockControls.moveForward/moveRight move on the XZ plane (horizontal)
    if (forwardAmount !== 0) {
      this.controls.moveForward(forwardAmount * speed * deltaTime);
    }
    if (rightAmount !== 0) {
      this.controls.moveRight(rightAmount * speed * deltaTime);
    }

    // Vertical movement (Q/E/Space) - directly adjust Y
    if (upAmount !== 0) {
      this.camera.position.y += upAmount * speed * deltaTime;
    }

    // Keep camera within terrain bounds (supports multi-tile grid)
    const minBoundX = this.gridBoundsMin.x;
    const maxBoundX = this.gridBoundsMax.x > 0 ? this.gridBoundsMax.x : size;
    const minBoundZ = this.gridBoundsMin.y;
    const maxBoundZ = this.gridBoundsMax.y > 0 ? this.gridBoundsMax.y : size;
    this.camera.position.x = Math.max(minBoundX, Math.min(maxBoundX, this.camera.position.x));
    this.camera.position.z = Math.max(minBoundZ, Math.min(maxBoundZ, this.camera.position.z));

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
  }

  getCamera(): any {
    return this.camera;
  }
}
