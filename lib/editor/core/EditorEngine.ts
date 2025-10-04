import {
  Engine,
  WebGPUEngine,
  Scene,
  ArcRotateCamera,
  Vector3,
  HemisphericLight,
  DirectionalLight,
  Color4,
  Color3,
  PointerEventTypes,
  PointerInfo,
  KeyboardEventTypes,
  KeyboardInfo,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  PickingInfo,
  IKeyboardEvent,
} from "@babylonjs/core";
import { GridMaterial } from "@babylonjs/materials";
import type { BrushSettings, ToolType, HeightmapTool, MaterialType } from "../types/EditorTypes";
import { Heightmap } from "../terrain/Heightmap";
import { TerrainMesh } from "../terrain/TerrainMesh";
import { BiomeDecorator } from "../terrain/BiomeDecorator";
import { GamePreview } from "./GamePreview";
import { PropManager } from "../props/PropManager";
import { FoliageSystem } from "../foliage/FoliageSystem";
import { ImpostorSystem } from "../foliage/ImpostorSystem";
import { initializeKTX2Support } from "./KTX2Setup";
import { StreamingManager, StreamingLOD } from "../streaming/StreamingManager";
import { AssetContainerPool } from "../streaming/AssetContainerPool";

export class EditorEngine {
  private canvas: HTMLCanvasElement;
  private engine!: Engine | WebGPUEngine;
  private scene!: Scene;
  private camera!: ArcRotateCamera;
  private gridMesh: Mesh | null = null;

  // Terrain
  private heightmap: Heightmap | null = null;
  private terrainMesh: TerrainMesh | null = null;

  // Brush preview
  private brushPreview: Mesh | null = null;

  // Props
  private propManager: PropManager | null = null;

  // Biome decorations
  private biomeDecorator: BiomeDecorator | null = null;
  private biomeDirty = false;

  // Foliage system (Thin Instance based)
  private foliageSystem: FoliageSystem | null = null;
  private foliageDirty = false;

  // Impostor system (Billboard LOD)
  private impostorSystem: ImpostorSystem | null = null;

  // Streaming system
  private streamingManager: StreamingManager | null = null;
  private assetPool: AssetContainerPool | null = null;
  private streamingEnabled = false;  // Disabled by default for editor mode

  // Game preview
  private gamePreview: GamePreview | null = null;
  private isGameMode = false;
  private savedClearColor: Color4 | null = null;

  // Callbacks
  private onModified: (() => void) | null = null;
  private onGameModeChange: ((isGameMode: boolean) => void) | null = null;

  // State
  private isInitialized = false;
  private isPointerDown = false;
  private currentPickInfo: PickingInfo | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  async init(): Promise<void> {
    // Initialize KTX2 texture support
    initializeKTX2Support();

    // Check WebGPU support
    const webGPUSupported = await WebGPUEngine.IsSupportedAsync;
    console.log("[EditorEngine] WebGPU supported:", webGPUSupported);

    if (webGPUSupported) {
      this.engine = new WebGPUEngine(this.canvas, {
        antialias: true,
      });
      await (this.engine as WebGPUEngine).initAsync();
      console.log("[EditorEngine] Using WebGPU engine");
    } else {
      this.engine = new Engine(this.canvas, true, {
        preserveDrawingBuffer: true,
        stencil: true,
      });
      console.log("[EditorEngine] Using WebGL engine");
    }

    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(0.08, 0.08, 0.1, 1);

    this.setupCamera();
    this.setupLighting();
    this.setupGrid();
    this.setupInputHandlers();
    this.createBrushPreview();

    // Create initial terrain
    console.log("[EditorEngine] Creating initial terrain...");
    this.createNewTerrain(64, 512);
    console.log("[EditorEngine] Terrain created");

    // Start render loop
    this.engine.runRenderLoop(() => {
      this.scene.render();
    });
    console.log("[EditorEngine] Render loop started");

    // Handle resize
    window.addEventListener("resize", this.handleResize);

    // Initialize streaming infrastructure (disabled by default in editor)
    this.assetPool = new AssetContainerPool(this.scene, 50);
    this.streamingManager = new StreamingManager(this.scene, {
      cellSize: 64,
      nearRadius: 1,
      midRadius: 2,
      farRadius: 3,
    });
    console.log("[EditorEngine] Streaming infrastructure initialized");

    this.isInitialized = true;
  }

  private setupCamera(): void {
    this.camera = new ArcRotateCamera(
      "editorCamera",
      -Math.PI / 4,
      Math.PI / 3,
      100,
      new Vector3(32, 0, 32),
      this.scene
    );

    this.camera.attachControl(this.canvas, true);
    this.camera.lowerRadiusLimit = 10;
    this.camera.upperRadiusLimit = 300;
    this.camera.wheelPrecision = 10;
    this.camera.panningSensibility = 100;
    this.camera.lowerBetaLimit = 0.1;
    this.camera.upperBetaLimit = Math.PI / 2 - 0.1;

    // Enable panning with shift
    this.camera.panningAxis = new Vector3(1, 0, 1);
  }

  private setupLighting(): void {
    const hemiLight = new HemisphericLight(
      "hemiLight",
      new Vector3(0, 1, 0),
      this.scene
    );
    hemiLight.intensity = 0.6;
    hemiLight.groundColor = new Color3(0.3, 0.3, 0.35);

    const dirLight = new DirectionalLight(
      "dirLight",
      new Vector3(-0.5, -1, -0.5),
      this.scene
    );
    dirLight.intensity = 0.6;
  }

  private setupGrid(): void {
    const gridMaterial = new GridMaterial("gridMaterial", this.scene);
    gridMaterial.majorUnitFrequency = 8;
    gridMaterial.minorUnitVisibility = 0.3;
    gridMaterial.gridRatio = 1;
    gridMaterial.backFaceCulling = false;
    gridMaterial.mainColor = new Color3(0.3, 0.3, 0.35);
    gridMaterial.lineColor = new Color3(0.4, 0.4, 0.45);
    gridMaterial.opacity = 0.8;

    this.gridMesh = MeshBuilder.CreateGround(
      "grid",
      { width: 256, height: 256, subdivisions: 1 },
      this.scene
    );
    this.gridMesh.material = gridMaterial;
    this.gridMesh.position.y = -0.01;
    this.gridMesh.position.x = 32;
    this.gridMesh.position.z = 32;
    this.gridMesh.isPickable = false;
  }

  private setupInputHandlers(): void {
    // Pointer events
    this.scene.onPointerObservable.add((pointerInfo: PointerInfo) => {
      switch (pointerInfo.type) {
        case PointerEventTypes.POINTERDOWN:
          if (pointerInfo.event.button === 0) {
            this.isPointerDown = true;
          }
          break;
        case PointerEventTypes.POINTERUP:
          if (pointerInfo.event.button === 0) {
            this.isPointerDown = false;
            // Rebuild biome decorations if dirty
            if (this.biomeDirty && this.biomeDecorator) {
              this.biomeDecorator.rebuildAll();
              this.biomeDirty = false;
            }
            // Rebuild foliage if dirty
            if (this.foliageDirty && this.foliageSystem) {
              this.foliageSystem.generateAll();
              this.foliageDirty = false;
            }
          }
          break;
        case PointerEventTypes.POINTERMOVE:
          this.handlePointerMove(pointerInfo);
          break;
      }
    });

    // Keyboard events
    this.scene.onKeyboardObservable.add((kbInfo: KeyboardInfo) => {
      if (kbInfo.type === KeyboardEventTypes.KEYDOWN) {
        this.handleKeyDown(kbInfo.event);
      }
    });
  }

  private handlePointerMove(pointerInfo: PointerInfo): void {
    // Raycast to terrain
    const pickResult = this.scene.pick(
      this.scene.pointerX,
      this.scene.pointerY,
      (mesh) => mesh.name.startsWith("terrain")
    );

    this.currentPickInfo = pickResult;

    // Update brush preview position
    if (pickResult?.hit && pickResult.pickedPoint && this.brushPreview) {
      this.brushPreview.position.x = pickResult.pickedPoint.x;
      this.brushPreview.position.z = pickResult.pickedPoint.z;
      this.brushPreview.position.y = pickResult.pickedPoint.y + 0.1;
      this.brushPreview.isVisible = true;
    } else if (this.brushPreview) {
      this.brushPreview.isVisible = false;
    }
  }

  private handleKeyDown(event: IKeyboardEvent): void {
    // Bracket keys for brush size
    if (event.key === "[") {
      // Decrease brush size - handled by React
    } else if (event.key === "]") {
      // Increase brush size - handled by React
    }
  }

  private createBrushPreview(): void {
    this.brushPreview = MeshBuilder.CreateDisc(
      "brushPreview",
      { radius: 2.5, tessellation: 32 },
      this.scene
    );

    const brushMaterial = new StandardMaterial("brushMaterial", this.scene);
    brushMaterial.diffuseColor = new Color3(0.3, 0.7, 1);
    brushMaterial.alpha = 0.3;
    brushMaterial.emissiveColor = new Color3(0.2, 0.5, 0.8);
    brushMaterial.backFaceCulling = false;

    this.brushPreview.material = brushMaterial;
    this.brushPreview.rotation.x = Math.PI / 2;
    this.brushPreview.isPickable = false;
    this.brushPreview.isVisible = false;
  }

  createNewTerrain(size: number, resolution: number): void {
    // Dispose existing terrain
    if (this.terrainMesh) {
      this.terrainMesh.dispose();
    }

    // Dispose existing biome decorator
    if (this.biomeDecorator) {
      this.biomeDecorator.dispose();
      this.biomeDecorator = null;
    }

    // Dispose existing foliage system
    if (this.foliageSystem) {
      this.foliageSystem.dispose();
      this.foliageSystem = null;
    }

    // Dispose existing impostor system
    if (this.impostorSystem) {
      this.impostorSystem.dispose();
      this.impostorSystem = null;
    }

    // Create new heightmap with minimal initial variation
    this.heightmap = new Heightmap(resolution, size);
    this.heightmap.generateFromNoise(Math.random() * 1000, 0.5); // Very low amplitude for mostly flat base

    // Make seamless so tiles connect properly when repeated
    this.heightmap.makeSeamless();

    // Create terrain mesh
    this.terrainMesh = new TerrainMesh(this.scene, this.heightmap);
    this.terrainMesh.create();

    // Initialize biome decorator
    this.biomeDecorator = new BiomeDecorator(this.scene, this.heightmap, this.terrainMesh);

    // Initialize foliage system (Thin Instance based)
    this.foliageSystem = new FoliageSystem(
      this.scene,
      this.heightmap,
      this.terrainMesh.getSplatMap(),
      size
    );
    // Generate initial foliage
    this.foliageSystem.generateAll();
    console.log("[EditorEngine] FoliageSystem initialized:", this.foliageSystem.getStats());

    // Initialize impostor system for distant LOD
    // (already disposed above in cleanup section)
    this.impostorSystem = new ImpostorSystem(this.scene);
    console.log("[EditorEngine] ImpostorSystem initialized");

    // Initialize prop manager
    if (this.propManager) {
      this.propManager.dispose();
    }
    this.propManager = new PropManager(this.scene, this.heightmap);
  }

  // Prop placement and preview
  createPropPreview(type: string, size: number, seed?: number): void {
    if (!this.propManager) return;
    this.propManager.createPreview(type as any, size, seed);
  }

  randomizePropPreview(): number {
    if (!this.propManager) return 0;
    return this.propManager.randomizePreview();
  }

  updatePropPreviewSize(size: number): void {
    if (!this.propManager) return;
    this.propManager.updatePreviewSize(size);
  }

  updatePropPreviewPosition(x: number, z: number): void {
    if (!this.propManager) return;
    this.propManager.updatePreviewPosition(x, z);
  }

  setPropPreviewVisible(visible: boolean): void {
    if (!this.propManager) return;
    this.propManager.setPreviewVisible(visible);
  }

  placeCurrentPropPreview(): { id: string; newSeed: number } | null {
    if (!this.propManager) return null;
    return this.propManager.placeCurrentPreview();
  }

  placeProp(
    propType: string,
    x: number,
    z: number,
    settings?: { size?: number; seed?: number }
  ): string | null {
    if (!this.propManager) return null;
    return this.propManager.placeProp(propType, x, z, settings);
  }

  removeProp(instanceId: string): void {
    if (this.propManager) {
      this.propManager.removeProp(instanceId);
    }
  }

  getPropManager(): PropManager | null {
    return this.propManager;
  }

  applyBrush(
    tool: HeightmapTool,
    settings: BrushSettings,
    deltaTime: number
  ): void {
    if (!this.isPointerDown || !this.currentPickInfo?.hit) return;
    if (!this.currentPickInfo.pickedPoint || !this.heightmap || !this.terrainMesh) return;

    const point = this.currentPickInfo.pickedPoint;
    const modified = this.heightmap.applyBrush(
      point.x,
      point.z,
      tool,
      settings,
      deltaTime
    );

    if (modified) {
      this.terrainMesh.updateFromHeightmap();
      this.onModified?.();
    }
  }

  applyPaintBrush(
    material: MaterialType,
    settings: BrushSettings
  ): void {
    if (!this.isPointerDown || !this.currentPickInfo?.hit) return;
    if (!this.currentPickInfo.pickedPoint || !this.heightmap || !this.terrainMesh) return;

    const point = this.currentPickInfo.pickedPoint;
    const splatMap = this.terrainMesh.getSplatMap();

    // Convert world coordinates to splat map coordinates
    const scale = this.heightmap.getScale();
    const resolution = splatMap.getResolution();
    const splatX = (point.x / scale) * (resolution - 1);
    const splatZ = (point.z / scale) * (resolution - 1);
    const splatRadius = (settings.size / scale) * (resolution - 1);

    const modified = splatMap.paint(
      splatX,
      splatZ,
      splatRadius,
      material,
      settings.strength,
      settings.falloff
    );

    if (modified) {
      this.terrainMesh.updateSplatTexture();
      this.onModified?.();
    }
  }

  /**
   * Apply biome brush - paints material and marks decorations for rebuild
   */
  applyBiomeBrush(
    material: MaterialType,
    settings: BrushSettings
  ): void {
    if (!this.isPointerDown || !this.currentPickInfo?.hit) return;
    if (!this.currentPickInfo.pickedPoint || !this.heightmap || !this.terrainMesh) return;

    const point = this.currentPickInfo.pickedPoint;
    const splatMap = this.terrainMesh.getSplatMap();

    // Convert world coordinates to splat map coordinates
    const scale = this.heightmap.getScale();
    const resolution = splatMap.getResolution();
    const splatX = (point.x / scale) * (resolution - 1);
    const splatZ = (point.z / scale) * (resolution - 1);
    const splatRadius = (settings.size / scale) * (resolution - 1);

    const modified = splatMap.paint(
      splatX,
      splatZ,
      splatRadius,
      material,
      settings.strength,
      settings.falloff
    );

    if (modified) {
      this.terrainMesh.updateSplatTexture();
      this.biomeDirty = true; // Mark for decoration rebuild on pointer up
      this.foliageDirty = true; // Mark foliage for rebuild on pointer up
      this.onModified?.();
    }
  }

  /**
   * Get biome decorator instance
   */
  getBiomeDecorator(): BiomeDecorator | null {
    return this.biomeDecorator;
  }

  /**
   * Manually trigger biome decoration rebuild
   */
  rebuildBiomeDecorations(): void {
    if (this.biomeDecorator) {
      this.biomeDecorator.rebuildAll();
      this.biomeDirty = false;
    }
  }

  /**
   * Get streaming system statistics
   */
  getStreamingStats(): { cells: number; assets: number } | null {
    if (!this.streamingManager || !this.assetPool) return null;
    const streamStats = this.streamingManager.getStats();
    const assetStats = this.assetPool.getStats();
    return {
      cells: streamStats.loadedCells,
      assets: assetStats.poolSize,
    };
  }

  /**
   * Get foliage system statistics
   */
  getFoliageStats(): { chunks: number; instances: number } | null {
    if (!this.foliageSystem) return null;
    const stats = this.foliageSystem.getStats();
    return { chunks: stats.chunks, instances: stats.totalInstances };
  }

  updateBrushPreview(size: number): void {
    if (this.brushPreview) {
      this.brushPreview.scaling.setAll(size / 5);
    }
  }

  setGridVisible(visible: boolean): void {
    if (this.gridMesh) {
      this.gridMesh.isVisible = visible;
    }
  }

  setWireframe(enabled: boolean): void {
    if (this.terrainMesh) {
      this.terrainMesh.setWireframe(enabled);
    }
  }

  setOnModified(callback: () => void): void {
    this.onModified = callback;
  }

  getHeightmap(): Heightmap | null {
    return this.heightmap;
  }

  getTerrainMesh(): TerrainMesh | null {
    return this.terrainMesh;
  }

  getScene(): Scene {
    return this.scene;
  }

  getEngine(): Engine | WebGPUEngine {
    return this.engine;
  }

  focusOnTerrain(): void {
    if (this.heightmap) {
      const size = this.heightmap.getScale();
      this.camera.target = new Vector3(size / 2, 0, size / 2);
      this.camera.radius = size * 1.5;
    }
  }

  // Control camera wheel zoom
  setCameraWheelEnabled(enabled: boolean): void {
    // Use wheelDeltaPercentage instead of wheelPrecision for more reliable control
    if (enabled) {
      this.camera.wheelPrecision = 10;
      this.camera.wheelDeltaPercentage = 0;
    } else {
      // Disable wheel by setting precision very high
      this.camera.wheelPrecision = 999999;
      this.camera.wheelDeltaPercentage = 0;
    }
  }

  // Manual camera zoom using raw deltaY from wheel event
  zoomCamera(deltaY: number): void {
    const minRadius = this.camera.lowerRadiusLimit || 10;
    const maxRadius = this.camera.upperRadiusLimit || 300;

    // Use deltaY directly: positive = scroll down = zoom out, negative = scroll up = zoom in
    const zoomAmount = deltaY * 0.002 * this.camera.radius;
    const newRadius = this.camera.radius + zoomAmount;

    this.camera.radius = Math.max(minRadius, Math.min(maxRadius, newRadius));
  }

  setTopView(): void {
    this.camera.alpha = 0;
    this.camera.beta = 0.01;
  }

  // Game Preview Mode
  enterGameMode(): void {
    if (this.isGameMode || !this.heightmap || !this.terrainMesh) return;

    const mesh = this.terrainMesh.getMesh();
    if (!mesh) return;

    // Save current state
    this.savedClearColor = this.scene.clearColor.clone();

    // Hide editor elements
    if (this.gridMesh) this.gridMesh.isVisible = false;
    if (this.brushPreview) this.brushPreview.isVisible = false;

    // Detach editor camera
    this.camera.detachControl();

    // Create and enable game preview
    this.gamePreview = new GamePreview(this.scene, this.heightmap);
    this.gamePreview.enable(mesh);

    this.isGameMode = true;
    this.onGameModeChange?.(true);
  }

  exitGameMode(): void {
    if (!this.isGameMode) return;

    // Disable game preview
    if (this.gamePreview) {
      this.gamePreview.disable();
      this.gamePreview = null;
    }

    // Restore editor camera
    this.camera.attachControl(this.canvas, true);
    this.scene.activeCamera = this.camera;

    // Restore clear color
    if (this.savedClearColor) {
      this.scene.clearColor = this.savedClearColor;
    }

    // Show editor elements
    if (this.gridMesh) this.gridMesh.isVisible = true;

    this.isGameMode = false;
    this.onGameModeChange?.(false);
  }

  toggleGameMode(): void {
    if (this.isGameMode) {
      this.exitGameMode();
    } else {
      this.enterGameMode();
    }
  }

  getIsGameMode(): boolean {
    return this.isGameMode;
  }

  setOnGameModeChange(callback: (isGameMode: boolean) => void): void {
    this.onGameModeChange = callback;
  }

  private handleResize = (): void => {
    this.engine.resize();
  };

  dispose(): void {
    if (this.isGameMode) {
      this.exitGameMode();
    }
    if (this.propManager) {
      this.propManager.dispose();
      this.propManager = null;
    }
    if (this.biomeDecorator) {
      this.biomeDecorator.dispose();
      this.biomeDecorator = null;
    }
    if (this.foliageSystem) {
      this.foliageSystem.dispose();
      this.foliageSystem = null;
    }
    if (this.impostorSystem) {
      this.impostorSystem.dispose();
      this.impostorSystem = null;
    }
    if (this.streamingManager) {
      this.streamingManager.dispose();
      this.streamingManager = null;
    }
    if (this.assetPool) {
      this.assetPool.dispose();
      this.assetPool = null;
    }
    if (this.brushPreview) {
      this.brushPreview.dispose();
      this.brushPreview = null;
    }
    if (this.gridMesh) {
      this.gridMesh.dispose();
      this.gridMesh = null;
    }
    if (this.terrainMesh) {
      this.terrainMesh.dispose();
      this.terrainMesh = null;
    }
    this.heightmap = null;
    window.removeEventListener("resize", this.handleResize);
    this.scene.dispose();
    this.engine.dispose();
  }
}
