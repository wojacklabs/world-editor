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
  LinesMesh,
  MeshBuilder,
  StandardMaterial,
  ShaderMaterial,
  PickingInfo,
  IKeyboardEvent,
  VertexData,
  VertexBuffer,
  RawTexture,
  Texture,
  Matrix,
  Quaternion,
} from "@babylonjs/core";
import { GridMaterial } from "@babylonjs/materials";
import type { BrushSettings, ToolType, HeightmapTool, MaterialType } from "../types/EditorTypes";
import { Heightmap } from "../terrain/Heightmap";
import { TerrainMesh } from "../terrain/TerrainMesh";
import { createTerrainMaterial, createSplatTexture } from "../terrain/TerrainShader";
import { SplatMap } from "../terrain/SplatMap";
import { BiomeDecorator } from "../terrain/BiomeDecorator";
import { GamePreview, TileMode } from "./GamePreview";
import { PropManager, PropLOD } from "../props/PropManager";
import { FoliageSystem, FoliageLOD } from "../foliage/FoliageSystem";
import { ImpostorSystem } from "../foliage/ImpostorSystem";
import { initializeKTX2Support } from "./KTX2Setup";
import { StreamingManager, StreamingLOD } from "../streaming/StreamingManager";
import { AssetContainerPool } from "../streaming/AssetContainerPool";
import { CellManager } from "../streaming/CellManager";
import { getManualTileManager, type TilePlacement, type PoolTileEntry } from "../tiles/ManualTileManager";

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

  // Water system
  private seaLevel: number = -100;  // Default below terrain, set properly when water is activated
  private waterDepth: number = 2.0;  // How deep water carves into terrain

  // Foliage system (Thin Instance based)
  private foliageSystem: FoliageSystem | null = null;
  private foliageDirty = false;

  // Impostor system (Billboard LOD)
  private impostorSystem: ImpostorSystem | null = null;

  // Streaming system
  private streamingManager: StreamingManager | null = null;
  private assetPool: AssetContainerPool | null = null;
  private cellManager: CellManager | null = null;
  private streamingEnabled = false;  // Disabled by default for editor mode

  // Game preview
  private gamePreview: GamePreview | null = null;
  private isGameMode = false;
  private savedClearColor: Color4 | null = null;
  private tileMode: TileMode = "mirror"; // Default to mirror mode

  // World Grid - editable tiles
  private neighborTileMeshes: Map<string, Mesh> = new Map();
  private neighborFoliageMeshes: Map<string, Mesh[]> = new Map(); // gridKey -> foliage meshes
  private neighborWaterMeshes: Map<string, Mesh> = new Map(); // gridKey -> water mesh
  private showNeighborTiles = true;
  private tileHighlightMesh: LinesMesh | null = null; // Selected tile boundary highlight

  // Editable tile data for each grid position (including neighbors)
  private editableTileData: Map<string, {
    heightmapData: Float32Array;
    splatmapData: Float32Array;
    waterMaskData: Float32Array;
    resolution: number;
    splatResolution: number;
  }> = new Map();

  // Currently active tile being edited (grid position)
  private activeTileGrid: { x: number; y: number } = { x: 0, y: 0 };

  // Tiles that were modified in the current stroke (for edge syncing)
  private modifiedTiles: Set<string> = new Set();

  // Cells being edited (protected from streaming unload)
  private editingCells: Set<string> = new Set();

  // Per-tile dirty flags for streaming auto-save
  private tileDirtyFlags: Map<string, {
    heightmapDirty: boolean;
    splatmapDirty: boolean;
    foliageDirty: boolean;
    waterDirty: boolean;
    lastModified: number;
  }> = new Map();

  // Tile loading state for streaming
  private tileLoadingState: Map<string, {
    loaded: boolean;
    loading: boolean;
  }> = new Map();

  // Default tile template for infinite expansion (saved from initial terrain)
  private defaultTileTemplate: {
    heightmapData: Float32Array;
    splatmapData: Float32Array;
    waterMaskData: Float32Array;
    resolution: number;
    size: number;
  } | null = null;

  // Callbacks
  private onModified: (() => void) | null = null;
  private onGameModeChange: ((isGameMode: boolean) => void) | null = null;

  // State
  private isInitialized = false;
  private isPointerDown = false;
  private currentPickInfo: PickingInfo | null = null;
  private lastPointerX: number = 0;
  private lastPointerY: number = 0;

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
    const startTime = performance.now() / 1000;
    this.engine.runRenderLoop(() => {
      const time = (performance.now() / 1000) - startTime;

      // Update terrain shader uniforms for water effects
      if (this.terrainMesh) {
        const material = this.terrainMesh.getMaterial() as ShaderMaterial | null;
        if (material && material.setFloat) {
          material.setFloat("uWaterLevel", this.seaLevel);
          material.setFloat("uTime", time);
        }
      }

      // Sync uniforms to neighbor tile materials
      for (const mesh of this.neighborTileMeshes.values()) {
        const material = mesh.material as ShaderMaterial | null;
        if (material && material.setFloat) {
          material.setFloat("uWaterLevel", this.seaLevel);
          material.setFloat("uTime", time);
        }
      }

      // Update foliage shader uniforms in editor mode
      // Note: updateVisibility is NOT called in editor mode - all chunks stay visible
      // Visibility/LOD culling is only applied in game mode (GamePreview.ts)
      if (this.foliageSystem && !this.isGameMode) {
        const cameraPos = this.camera.position;
        this.foliageSystem.updateCameraPosition(cameraPos);
        this.foliageSystem.updateTime(performance.now() / 1000);
      }

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

    // Initialize cell manager (will be updated when terrain is created)
    this.cellManager = new CellManager({
      cellSize: 64,
      tileSize: 64,  // Default, updated in createNewTerrain
    });

    // Setup streaming callbacks (but don't enable yet)
    this.streamingManager.initialize({
      onLoadCell: this.handleStreamingLoadCell.bind(this),
      onUnloadCell: this.handleStreamingUnloadCell.bind(this),
      onUpdateCellLOD: this.handleStreamingUpdateCellLOD.bind(this),
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
      // Disable editing in game mode
      if (this.isGameMode) return;

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
    const currentX = this.scene.pointerX;
    const currentY = this.scene.pointerY;

    // When pointer is down, only update pick info if mouse actually moved
    // This prevents terrain carving from chasing the raycast as ground lowers
    if (this.isPointerDown) {
      const dx = currentX - this.lastPointerX;
      const dy = currentY - this.lastPointerY;
      const movedDistance = Math.sqrt(dx * dx + dy * dy);

      // Only update if moved more than 3 pixels
      if (movedDistance < 3) {
        return;
      }
    }

    this.lastPointerX = currentX;
    this.lastPointerY = currentY;

    // Raycast to terrain
    const pickResult = this.scene.pick(
      currentX,
      currentY,
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

    // Reset water system state
    this.seaLevel = -100;
    this.waterDepth = 2.0;

    // Create new heightmap with minimal initial variation
    this.heightmap = new Heightmap(resolution, size);
    this.heightmap.generateFromNoise(Math.random() * 1000, 0.5); // Very low amplitude for mostly flat base

    // Only make seamless for small tiles that might be repeated
    if (size <= 64) {
      this.heightmap.makeSeamless();
    }

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
    this.propManager.setTileSize(size);  // Set tile size for streaming grouping

    // Save initial tile as default template (only for small tiles that might be repeated)
    if (size <= 64) {
      this.saveDefaultTileTemplate();
      console.log("[EditorEngine] Default tile template saved for infinite expansion");
    }

    // Update CellManager with actual tile size
    if (this.cellManager) {
      this.cellManager.updateTileSize(size);
    }

    // Update grid and camera to match terrain size
    if (this.gridMesh) {
      const gridScale = Math.max(256, size * 4);
      this.gridMesh.scaling.x = gridScale / 256;
      this.gridMesh.scaling.z = gridScale / 256;
      this.gridMesh.position.x = size / 2;
      this.gridMesh.position.z = size / 2;
    }
    this.focusOnTerrain();
  }

  /**
   * Save current terrain state as default tile template for infinite expansion
   */
  private saveDefaultTileTemplate(): void {
    if (!this.heightmap || !this.terrainMesh) return;

    const splatMap = this.terrainMesh.getSplatMap();
    const splatData = splatMap.getData();
    const resolution = this.heightmap.getResolution();

    // Validate splatmap data - ensure at least first pixel is valid grass
    const firstPixelGrass = splatData[0];
    const firstPixelSum = splatData[0] + splatData[1] + splatData[2] + splatData[3];

    // If splatmap looks invalid (all zeros or NaN), force grass initialization
    if (!Number.isFinite(firstPixelSum) || firstPixelSum === 0 || firstPixelGrass < 0.9) {
      console.warn("[EditorEngine] Splatmap not properly initialized, forcing grass fill");
      splatMap.fillWithMaterial("grass");
    }

    this.defaultTileTemplate = {
      heightmapData: new Float32Array(this.heightmap.getData()),
      splatmapData: new Float32Array(splatMap.getData()),
      waterMaskData: new Float32Array(splatMap.getWaterMask()),
      resolution: resolution,
      size: this.heightmap.getScale(),
    };

    // Verify template data
    console.log(`[EditorEngine] Template saved: res=${resolution}, splatGrass[0]=${this.defaultTileTemplate.splatmapData[0].toFixed(3)}`);
  }

  /**
   * Sync tile edges for seamless connections between adjacent tiles
   * Makes edge heights exactly match and blends smoothly into interior
   * Also handles diagonal (corner) tiles and splatmap synchronization
   */
  private syncTileEdges(): void {
    if (!this.heightmap) return;
    if (this.modifiedTiles.size === 0) return;

    // Very wide blend for extremely gradual transition
    const blendWidth = 30;
    const processedPairs = new Set<string>();
    const tilesToUpdate = new Set<string>();

    // Process each modified tile
    for (const tileKey of this.modifiedTiles) {
      const [gx, gy] = tileKey.split(",").map(Number);

      // Adjacent tiles (4-directional)
      const neighbors = [
        { dx: -1, dy: 0 }, // Left
        { dx: 1, dy: 0 },  // Right
        { dx: 0, dy: -1 }, // Top
        { dx: 0, dy: 1 },  // Bottom
      ];

      for (const n of neighbors) {
        const nx = gx + n.dx;
        const ny = gy + n.dy;

        // Create unique pair key to avoid processing same edge twice
        const pairKey = [
          `${Math.min(gx, nx)},${Math.min(gy, ny)}`,
          `${Math.max(gx, nx)},${Math.max(gy, ny)}`,
          n.dx !== 0 ? "h" : "v"
        ].join("|");

        if (processedPairs.has(pairKey)) continue;
        processedPairs.add(pairKey);

        const tile1Data = this.getTileHeightData(gx, gy);
        const tile2Data = this.getTileHeightData(nx, ny);

        if (!tile1Data || !tile2Data) continue;

        // Get splatmap data
        const tile1Splat = this.getTileSplatData(gx, gy);
        const tile2Splat = this.getTileSplatData(nx, ny);

        // Determine which edges to sync
        let tile1Edge: "left" | "right" | "top" | "bottom";
        let tile2Edge: "left" | "right" | "top" | "bottom";

        if (n.dx === -1) { tile1Edge = "left"; tile2Edge = "right"; }
        else if (n.dx === 1) { tile1Edge = "right"; tile2Edge = "left"; }
        else if (n.dy === -1) { tile1Edge = "top"; tile2Edge = "bottom"; }
        else { tile1Edge = "bottom"; tile2Edge = "top"; }

        // Sync heightmap edges
        this.syncTwoEdgesSmooth(
          tile1Data.heightmapData, tile1Data.resolution, tile1Edge,
          tile2Data.heightmapData, tile2Data.resolution, tile2Edge,
          blendWidth, false, false
        );

        // Sync splatmap edges
        if (tile1Splat && tile2Splat) {
          this.syncTwoEdgesSplatmap(
            tile1Splat.splatmapData, tile1Splat.resolution, tile1Edge,
            tile2Splat.splatmapData, tile2Splat.resolution, tile2Edge,
            blendWidth
          );
        }

        tilesToUpdate.add(tileKey);
        tilesToUpdate.add(`${nx},${ny}`);
      }

      // Diagonal tiles (corners) - sync corner areas
      const diagonals = [
        { dx: -1, dy: -1 }, // Top-left
        { dx: 1, dy: -1 },  // Top-right
        { dx: -1, dy: 1 },  // Bottom-left
        { dx: 1, dy: 1 },   // Bottom-right
      ];

      for (const d of diagonals) {
        const nx = gx + d.dx;
        const ny = gy + d.dy;

        const cornerKey = `corner|${Math.min(gx, nx)},${Math.min(gy, ny)}|${Math.max(gx, nx)},${Math.max(gy, ny)}`;
        if (processedPairs.has(cornerKey)) continue;
        processedPairs.add(cornerKey);

        const tile1Data = this.getTileHeightData(gx, gy);
        const tile2Data = this.getTileHeightData(nx, ny);

        if (!tile1Data || !tile2Data) continue;

        // Sync corner area for heightmap
        this.syncCornerArea(
          tile1Data.heightmapData, tile1Data.resolution,
          tile2Data.heightmapData, tile2Data.resolution,
          d.dx, d.dy, blendWidth
        );

        // Sync corner area for splatmap
        const tile1Splat = this.getTileSplatData(gx, gy);
        const tile2Splat = this.getTileSplatData(nx, ny);
        if (tile1Splat && tile2Splat) {
          this.syncCornerAreaSplatmap(
            tile1Splat.splatmapData, tile1Splat.resolution,
            tile2Splat.splatmapData, tile2Splat.resolution,
            d.dx, d.dy, blendWidth
          );
        }

        tilesToUpdate.add(`${nx},${ny}`);
      }
    }

    // Update all affected tile meshes and splatmaps
    for (const key of tilesToUpdate) {
      const [gx, gy] = key.split(",").map(Number);
      if (gx === 0 && gy === 0) {
        this.terrainMesh?.updateFromHeightmap();
        this.terrainMesh?.updateSplatTexture();
        this.markTileDirty(0, 0, 'heightmap');
        this.markTileDirty(0, 0, 'splatmap');
      } else {
        this.updateNeighborTileMesh(gx, gy);
        this.updateNeighborTileSplatmap(gx, gy);
        this.updateNeighborTileFoliage(gx, gy);
        // Mark neighbor tiles as dirty (they were modified during edge sync)
        this.markTileDirty(gx, gy, 'heightmap');
        this.markTileDirty(gx, gy, 'splatmap');
      }
    }

    this.modifiedTiles.clear();

    if (tilesToUpdate.size > 0) {
      console.log(`[EditorEngine] Synced edges for ${tilesToUpdate.size} tiles`);
    }
  }

  /**
   * Get splatmap data for any tile
   */
  private getTileSplatData(gridX: number, gridY: number): { splatmapData: Float32Array; resolution: number } | null {
    if (gridX === 0 && gridY === 0) {
      if (!this.terrainMesh) return null;
      const splatMap = this.terrainMesh.getSplatMap();
      return {
        splatmapData: splatMap.getData(),
        resolution: splatMap.getResolution(),
      };
    } else {
      const key = `${gridX},${gridY}`;
      const tileData = this.editableTileData.get(key);
      if (!tileData) return null;
      return {
        splatmapData: tileData.splatmapData,
        resolution: tileData.splatResolution,
      };
    }
  }

  /**
   * Sync splatmap edges between two tiles
   */
  private syncTwoEdgesSplatmap(
    splat1: Float32Array, res1: number, edge1: "left" | "right" | "top" | "bottom",
    splat2: Float32Array, res2: number, edge2: "left" | "right" | "top" | "bottom",
    blendWidth: number
  ): void {
    // Iterate over tile2's edge pixels
    for (let i2 = 0; i2 < res2; i2++) {
      const t = i2 / (res2 - 1);
      const float_i1 = t * (res1 - 1);
      const i1_0 = Math.floor(float_i1);
      const i1_1 = Math.min(i1_0 + 1, res1 - 1);
      const frac = float_i1 - i1_0;

      // Get edge indices
      const idx1_0 = this.getSplatEdgeIndex(i1_0, res1, edge1);
      const idx1_1 = this.getSplatEdgeIndex(i1_1, res1, edge1);
      const idx2 = this.getSplatEdgeIndex(i2, res2, edge2);

      // Interpolate and copy edge values (4 channels)
      for (let c = 0; c < 4; c++) {
        const val1 = splat1[idx1_0 * 4 + c] * (1 - frac) + splat1[idx1_1 * 4 + c] * frac;
        splat2[idx2 * 4 + c] = val1;
      }

      // Blend interior
      for (let d = 1; d < blendWidth && d < res2 / 2; d++) {
        const blend = 1 - d / blendWidth;
        const interiorIdx = this.getSplatInteriorIndex(i2, d, res2, edge2);
        const srcIdx0 = this.getSplatInteriorIndex(i1_0, d, res1, edge1);
        const srcIdx1 = this.getSplatInteriorIndex(i1_1, d, res1, edge1);

        if (interiorIdx >= 0 && interiorIdx < res2 * res2 &&
            srcIdx0 >= 0 && srcIdx0 < res1 * res1 &&
            srcIdx1 >= 0 && srcIdx1 < res1 * res1) {
          for (let c = 0; c < 4; c++) {
            const srcVal = splat1[srcIdx0 * 4 + c] * (1 - frac) + splat1[srcIdx1 * 4 + c] * frac;
            const originalVal = splat2[interiorIdx * 4 + c];
            splat2[interiorIdx * 4 + c] = originalVal * (1 - blend) + srcVal * blend;
          }
        }
      }
    }
  }

  /**
   * Sync corner area between modified tile and diagonal neighbor
   */
  private syncCornerArea(
    heights1: Float32Array, res1: number,
    heights2: Float32Array, res2: number,
    dx: number, dy: number, blendWidth: number
  ): void {
    // Determine corner positions
    // dx=1, dy=1: tile1's bottom-right → tile2's top-left
    const corner1X = dx > 0 ? res1 - 1 : 0;
    const corner1Y = dy > 0 ? res1 - 1 : 0;
    const corner2X = dx > 0 ? 0 : res2 - 1;
    const corner2Y = dy > 0 ? 0 : res2 - 1;

    // Sync corner point
    const corner1Idx = corner1Y * res1 + corner1X;
    const corner2Idx = corner2Y * res2 + corner2X;
    heights2[corner2Idx] = heights1[corner1Idx];

    // Blend corner region with 2D distance-based falloff
    for (let oy = 0; oy < blendWidth && oy < res2; oy++) {
      for (let ox = 0; ox < blendWidth && ox < res2; ox++) {
        if (ox === 0 && oy === 0) continue; // Already set corner

        const dist = Math.sqrt(ox * ox + oy * oy);
        if (dist >= blendWidth) continue;

        const blend = 1 - dist / blendWidth;

        // Target position in tile2
        const t2x = corner2X + (dx > 0 ? ox : -ox);
        const t2y = corner2Y + (dy > 0 ? oy : -oy);
        if (t2x < 0 || t2x >= res2 || t2y < 0 || t2y >= res2) continue;

        // Source position in tile1
        const t1x = corner1X + (dx > 0 ? -ox : ox);
        const t1y = corner1Y + (dy > 0 ? -oy : oy);
        if (t1x < 0 || t1x >= res1 || t1y < 0 || t1y >= res1) continue;

        const idx1 = t1y * res1 + t1x;
        const idx2 = t2y * res2 + t2x;

        const originalHeight = heights2[idx2];
        heights2[idx2] = originalHeight * (1 - blend) + heights1[idx1] * blend;
      }
    }
  }

  /**
   * Sync corner area for splatmap
   */
  private syncCornerAreaSplatmap(
    splat1: Float32Array, res1: number,
    splat2: Float32Array, res2: number,
    dx: number, dy: number, blendWidth: number
  ): void {
    const corner1X = dx > 0 ? res1 - 1 : 0;
    const corner1Y = dy > 0 ? res1 - 1 : 0;
    const corner2X = dx > 0 ? 0 : res2 - 1;
    const corner2Y = dy > 0 ? 0 : res2 - 1;

    // Sync corner point
    const corner1Idx = corner1Y * res1 + corner1X;
    const corner2Idx = corner2Y * res2 + corner2X;
    for (let c = 0; c < 4; c++) {
      splat2[corner2Idx * 4 + c] = splat1[corner1Idx * 4 + c];
    }

    // Blend corner region
    for (let oy = 0; oy < blendWidth && oy < res2; oy++) {
      for (let ox = 0; ox < blendWidth && ox < res2; ox++) {
        if (ox === 0 && oy === 0) continue;

        const dist = Math.sqrt(ox * ox + oy * oy);
        if (dist >= blendWidth) continue;

        const blend = 1 - dist / blendWidth;

        const t2x = corner2X + (dx > 0 ? ox : -ox);
        const t2y = corner2Y + (dy > 0 ? oy : -oy);
        if (t2x < 0 || t2x >= res2 || t2y < 0 || t2y >= res2) continue;

        const t1x = corner1X + (dx > 0 ? -ox : ox);
        const t1y = corner1Y + (dy > 0 ? -oy : oy);
        if (t1x < 0 || t1x >= res1 || t1y < 0 || t1y >= res1) continue;

        const idx1 = t1y * res1 + t1x;
        const idx2 = t2y * res2 + t2x;

        for (let c = 0; c < 4; c++) {
          const originalVal = splat2[idx2 * 4 + c];
          splat2[idx2 * 4 + c] = originalVal * (1 - blend) + splat1[idx1 * 4 + c] * blend;
        }
      }
    }
  }

  /**
   * Get splatmap index for edge position
   */
  private getSplatEdgeIndex(i: number, res: number, edge: "left" | "right" | "top" | "bottom"): number {
    switch (edge) {
      case "left": return i * res + 0;
      case "right": return i * res + (res - 1);
      case "top": return 0 * res + i;
      case "bottom": return (res - 1) * res + i;
    }
  }

  /**
   * Get splatmap index for interior position
   */
  private getSplatInteriorIndex(i: number, d: number, res: number, edge: "left" | "right" | "top" | "bottom"): number {
    switch (edge) {
      case "left": return i * res + d;
      case "right": return i * res + (res - 1 - d);
      case "top": return d * res + i;
      case "bottom": return (res - 1 - d) * res + i;
    }
  }

  /**
   * Get heightmap data for any tile (center or neighbor)
   */
  private getTileHeightData(gridX: number, gridY: number): { heightmapData: Float32Array; resolution: number } | null {
    if (gridX === 0 && gridY === 0) {
      if (!this.heightmap) return null;
      return {
        heightmapData: this.heightmap.getData(),
        resolution: this.heightmap.getResolution(),
      };
    } else {
      const key = `${gridX},${gridY}`;
      const tileData = this.editableTileData.get(key);
      if (!tileData) return null;
      return {
        heightmapData: tileData.heightmapData,
        resolution: tileData.resolution,
      };
    }
  }

  /**
   * Sync two tile edges with symmetric blending
   * tile1 is the MODIFIED tile, tile2 is the adjacent tile being synced
   * Copies from modified tile to adjacent tile with symmetric slope mirroring
   * Uses normalized positions (0~1) to handle different resolutions
   */
  private syncTwoEdgesSmooth(
    heights1: Float32Array, res1: number, edge1: "left" | "right" | "top" | "bottom",
    heights2: Float32Array, res2: number, edge2: "left" | "right" | "top" | "bottom",
    blendWidth: number,
    tile1IsCenter: boolean = false,
    tile2IsCenter: boolean = false
  ): void {
    // Iterate over tile2's vertices (the target tile being synced)
    for (let i2 = 0; i2 < res2; i2++) {
      // Normalized position along edge (0 to 1)
      const t = i2 / (res2 - 1);

      // Map to tile1's index space (may be fractional)
      const float_i1 = t * (res1 - 1);

      // Get interpolated height from tile1 at this position
      const height1 = this.getInterpolatedEdgeHeight(heights1, res1, edge1, float_i1);

      // Set tile2's edge vertex
      const idx2 = this.getEdgeIndex(i2, res2, edge2);
      heights2[idx2] = height1;

      // Mirror the slope from modified tile into adjacent tile with gradual blending
      // Near edge: mostly mirrored value, far from edge: mostly original value
      for (let d = 1; d < blendWidth; d++) {
        const interiorHeight = this.getInterpolatedInteriorHeight(heights1, res1, edge1, float_i1, d);
        const adjacentInteriorIdx = this.getInteriorIndex(i2, d, res2, edge2);

        if (adjacentInteriorIdx >= 0 && adjacentInteriorIdx < heights2.length) {
          // Gradual blend: 1 at edge (d=1), 0 at blendWidth
          const blend = 1 - d / blendWidth;
          const originalHeight = heights2[adjacentInteriorIdx];
          heights2[adjacentInteriorIdx] = originalHeight * (1 - blend) + interiorHeight * blend;
        }
      }
    }
  }

  /**
   * Get interpolated height at a fractional edge position
   */
  private getInterpolatedEdgeHeight(
    heights: Float32Array,
    res: number,
    edge: "left" | "right" | "top" | "bottom",
    floatI: number
  ): number {
    const i0 = Math.floor(floatI);
    const i1 = Math.min(i0 + 1, res - 1);
    const frac = floatI - i0;

    const idx0 = this.getEdgeIndex(i0, res, edge);
    const idx1 = this.getEdgeIndex(i1, res, edge);

    return heights[idx0] * (1 - frac) + heights[idx1] * frac;
  }

  /**
   * Get interpolated height at a fractional interior position (d cells from edge)
   */
  private getInterpolatedInteriorHeight(
    heights: Float32Array,
    res: number,
    edge: "left" | "right" | "top" | "bottom",
    floatI: number,
    d: number
  ): number {
    const i0 = Math.floor(floatI);
    const i1 = Math.min(i0 + 1, res - 1);
    const frac = floatI - i0;

    const idx0 = this.getInteriorIndex(i0, d, res, edge);
    const idx1 = this.getInteriorIndex(i1, d, res, edge);

    // Check bounds
    if (idx0 < 0 || idx0 >= heights.length || idx1 < 0 || idx1 >= heights.length) {
      // Fallback to edge value
      return this.getInterpolatedEdgeHeight(heights, res, edge, floatI);
    }

    return heights[idx0] * (1 - frac) + heights[idx1] * frac;
  }

  /**
   * Get heightmap index for edge position
   */
  private getEdgeIndex(i: number, res: number, edge: "left" | "right" | "top" | "bottom"): number {
    switch (edge) {
      case "left": return i * res + 0;
      case "right": return i * res + (res - 1);
      case "top": return 0 * res + i;
      case "bottom": return (res - 1) * res + i;
    }
  }

  /**
   * Get heightmap index for interior position (d cells from edge)
   */
  private getInteriorIndex(i: number, d: number, res: number, edge: "left" | "right" | "top" | "bottom"): number {
    switch (edge) {
      case "left": return i * res + d;
      case "right": return i * res + (res - 1 - d);
      case "top": return d * res + i;
      case "bottom": return (res - 1 - d) * res + i;
    }
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

  /**
   * Get which tile grid position a world point is on
   */
  private getGridPositionFromWorld(worldX: number, worldZ: number): { gridX: number; gridY: number; localX: number; localZ: number } {
    const tileSize = this.heightmap?.getScale() || 64;
    const gridX = Math.floor(worldX / tileSize);
    const gridY = Math.floor(worldZ / tileSize);
    const localX = worldX - gridX * tileSize;
    const localZ = worldZ - gridY * tileSize;
    return { gridX, gridY, localX, localZ };
  }

  /**
   * Ensure editable data exists for a tile position
   */
  private ensureEditableTileData(gridX: number, gridY: number): void {
    const key = `${gridX},${gridY}`;
    if (this.editableTileData.has(key)) return;

    if (!this.defaultTileTemplate) return;

    // Create a copy of the default template for this tile
    const template = this.defaultTileTemplate;
    this.editableTileData.set(key, {
      heightmapData: new Float32Array(template.heightmapData),
      splatmapData: new Float32Array(template.splatmapData),
      waterMaskData: new Float32Array(template.splatmapData.length / 4), // Same resolution as splat
      resolution: template.resolution,
      splatResolution: Math.sqrt(template.splatmapData.length / 4),
    });

    console.log(`[EditorEngine] Created editable data for tile (${gridX},${gridY})`);
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
      this.foliageDirty = true;
      this.biomeDirty = true;
      this.onModified?.();
    }
  }

  /**
   * Apply brush to a neighbor tile's heightmap data
   */
  private applyBrushToNeighborTile(
    gridX: number,
    gridY: number,
    localX: number,
    localZ: number,
    tool: HeightmapTool,
    settings: BrushSettings,
    deltaTime: number
  ): boolean {
    const key = `${gridX},${gridY}`;
    const tileData = this.editableTileData.get(key);
    if (!tileData) return false;

    const tileSize = this.heightmap?.getScale() || 64;
    const resolution = tileData.resolution;
    const cellSize = tileSize / (resolution - 1);

    // Convert local coords to heightmap indices
    const centerX = localX / cellSize;
    const centerZ = localZ / cellSize;
    const radius = settings.size / cellSize;

    let modified = false;

    const minX = Math.max(0, Math.floor(centerX - radius));
    const maxX = Math.min(resolution - 1, Math.ceil(centerX + radius));
    const minZ = Math.max(0, Math.floor(centerZ - radius));
    const maxZ = Math.min(resolution - 1, Math.ceil(centerZ + radius));

    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - centerX;
        const dz = z - centerZ;
        const distance = Math.sqrt(dx * dx + dz * dz);

        if (distance <= radius) {
          // Use same falloff calculation as Heightmap.applyBrush
          const normalizedDist = distance / radius;
          const t = Math.pow(1 - normalizedDist, 2 - settings.falloff * 2);
          const falloff = Math.max(0, Math.min(1, t));

          const idx = z * resolution + x;
          const currentHeight = tileData.heightmapData[idx];
          let newHeight = currentHeight;

          const amount = settings.strength * falloff * deltaTime * 10;

          switch (tool) {
            case "raise":
              newHeight = currentHeight + amount;
              break;
            case "lower":
              newHeight = currentHeight - amount;
              break;
            case "flatten":
              // Get target height from brush center
              const targetIdx = Math.floor(centerZ) * resolution + Math.floor(centerX);
              const targetHeight = tileData.heightmapData[targetIdx] ?? currentHeight;
              newHeight = currentHeight + (targetHeight - currentHeight) * falloff * 0.1;
              break;
            case "smooth":
              let sum = 0;
              let count = 0;
              for (let sz = -1; sz <= 1; sz++) {
                for (let sx = -1; sx <= 1; sx++) {
                  const nx = x + sx;
                  const nz = z + sz;
                  if (nx >= 0 && nx < resolution && nz >= 0 && nz < resolution) {
                    sum += tileData.heightmapData[nz * resolution + nx];
                    count++;
                  }
                }
              }
              const avgHeight = sum / count;
              newHeight = currentHeight + (avgHeight - currentHeight) * falloff * 0.5;
              break;
          }

          tileData.heightmapData[idx] = newHeight;
          modified = true;
        }
      }
    }

    return modified;
  }

  /**
   * Update a neighbor tile's mesh after editing
   */
  private updateNeighborTileMesh(gridX: number, gridY: number): void {
    const key = `${gridX},${gridY}`;
    const tileData = this.editableTileData.get(key);
    const mesh = this.neighborTileMeshes.get(key);

    if (!tileData || !mesh) return;

    const tileSize = this.heightmap?.getScale() || 64;
    const resolution = tileData.resolution;

    // Get current vertex positions
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    if (!positions) return;

    // Update heights from editable data
    // Note: mesh resolution might be lower than data resolution
    const meshRes = Math.sqrt(positions.length / 3);
    const step = (resolution - 1) / (meshRes - 1);

    for (let z = 0; z < meshRes; z++) {
      for (let x = 0; x < meshRes; x++) {
        const dataX = Math.min(Math.floor(x * step), resolution - 1);
        const dataZ = Math.min(Math.floor(z * step), resolution - 1);
        const dataIdx = dataZ * resolution + dataX;
        const meshIdx = (z * meshRes + x) * 3;

        positions[meshIdx + 1] = tileData.heightmapData[dataIdx];
      }
    }

    mesh.updateVerticesData(VertexBuffer.PositionKind, positions);

    // Recompute normals using gradient method (same as center tile for consistency)
    const cellSize = tileSize / (meshRes - 1);
    this.calculateGradientNormals(mesh, meshRes, cellSize, Array.from(positions));

    mesh.refreshBoundingInfo();
  }

  /**
   * Apply biome brush to a neighbor tile's splatmap data
   */
  private applyBiomeBrushToNeighborTile(
    gridX: number,
    gridY: number,
    localX: number,
    localZ: number,
    material: MaterialType,
    settings: BrushSettings
  ): boolean {
    const key = `${gridX},${gridY}`;
    const tileData = this.editableTileData.get(key);
    if (!tileData) return false;

    const tileSize = this.heightmap?.getScale() || 64;
    const resolution = tileData.splatResolution;
    const cellSize = tileSize / (resolution - 1);

    // Convert local coords to splatmap indices
    const centerX = localX / cellSize;
    const centerZ = localZ / cellSize;
    const radius = settings.size / cellSize;

    let modified = false;

    const minX = Math.max(0, Math.floor(centerX - radius));
    const maxX = Math.min(resolution - 1, Math.ceil(centerX + radius));
    const minZ = Math.max(0, Math.floor(centerZ - radius));
    const maxZ = Math.min(resolution - 1, Math.ceil(centerZ + radius));

    // Material channel mapping
    const materialChannels: Record<MaterialType, number> = {
      grass: 0,
      dirt: 1,
      rock: 2,
      sand: 3,
      water: -1, // Water uses separate mask
    };

    const channel = materialChannels[material];

    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - centerX;
        const dz = z - centerZ;
        const distance = Math.sqrt(dx * dx + dz * dz);

        if (distance <= radius) {
          const normalizedDist = distance / radius;
          const t = Math.pow(1 - normalizedDist, 2 - settings.falloff * 2);
          const falloff = Math.max(0, Math.min(1, t));
          const paintStrength = settings.strength * falloff * 0.1;

          const idx = z * resolution + x;

          if (material === "water") {
            // Paint to water mask
            tileData.waterMaskData[idx] = Math.min(1, tileData.waterMaskData[idx] + paintStrength);
          } else {
            // Paint to splatmap channel
            const splatIdx = idx * 4;

            // Reduce other channels
            for (let c = 0; c < 4; c++) {
              if (c !== channel) {
                tileData.splatmapData[splatIdx + c] *= (1 - paintStrength);
              }
            }

            // Increase target channel
            tileData.splatmapData[splatIdx + channel] = Math.min(1,
              tileData.splatmapData[splatIdx + channel] + paintStrength
            );

            // Normalize
            let total = 0;
            for (let c = 0; c < 4; c++) {
              total += tileData.splatmapData[splatIdx + c];
            }
            if (total > 0) {
              for (let c = 0; c < 4; c++) {
                tileData.splatmapData[splatIdx + c] /= total;
              }
            }
          }

          modified = true;
        }
      }
    }

    return modified;
  }

  /**
   * Update neighbor tile's splatmap texture after editing
   */
  private updateNeighborTileSplatmap(gridX: number, gridY: number): void {
    const key = `${gridX},${gridY}`;
    const tileData = this.editableTileData.get(key);
    const mesh = this.neighborTileMeshes.get(key);

    if (!tileData || !mesh || !mesh.material) return;

    const material = mesh.material as ShaderMaterial;
    const resolution = tileData.splatResolution;

    // Update splatmap texture
    const splatData = new Uint8Array(resolution * resolution * 4);
    for (let i = 0; i < resolution * resolution; i++) {
      splatData[i * 4 + 0] = Math.floor(tileData.splatmapData[i * 4 + 0] * 255);
      splatData[i * 4 + 1] = Math.floor(tileData.splatmapData[i * 4 + 1] * 255);
      splatData[i * 4 + 2] = Math.floor(tileData.splatmapData[i * 4 + 2] * 255);
      splatData[i * 4 + 3] = Math.floor(tileData.splatmapData[i * 4 + 3] * 255);
    }

    const splatTexture = new RawTexture(
      splatData,
      resolution,
      resolution,
      Engine.TEXTUREFORMAT_RGBA,
      this.scene,
      false,
      false,
      Texture.BILINEAR_SAMPLINGMODE
    );
    material.setTexture("uSplatMap", splatTexture);

    // Update water mask texture
    const waterData = new Uint8Array(resolution * resolution * 4);
    for (let i = 0; i < resolution * resolution; i++) {
      const value = Math.floor(tileData.waterMaskData[i] * 255);
      waterData[i * 4 + 0] = value;
      waterData[i * 4 + 1] = value;
      waterData[i * 4 + 2] = value;
      waterData[i * 4 + 3] = 255;
    }

    const waterTexture = new RawTexture(
      waterData,
      resolution,
      resolution,
      Engine.TEXTUREFORMAT_RGBA,
      this.scene,
      false,
      false,
      Texture.BILINEAR_SAMPLINGMODE
    );
    material.setTexture("uWaterMask", waterTexture);

    // Update water mesh for this tile
    const tileSize = this.heightmap?.getScale() || 64;
    this.createNeighborWaterMesh(gridX, gridY, tileSize, tileData.waterMaskData, resolution);
  }

  /**
   * Calculate normals using gradient method (consistent with TerrainMesh)
   */
  private calculateGradientNormals(mesh: Mesh, resolution: number, cellSize: number, positions: number[]): void {
    const normals: number[] = [];

    for (let z = 0; z < resolution; z++) {
      for (let x = 0; x < resolution; x++) {
        const idx = (z * resolution + x) * 3;
        const idxL = (z * resolution + Math.max(0, x - 1)) * 3;
        const idxR = (z * resolution + Math.min(resolution - 1, x + 1)) * 3;
        const idxD = (Math.max(0, z - 1) * resolution + x) * 3;
        const idxU = (Math.min(resolution - 1, z + 1) * resolution + x) * 3;

        const hL = positions[idxL + 1];
        const hR = positions[idxR + 1];
        const hD = positions[idxD + 1];
        const hU = positions[idxU + 1];

        const nx = (hL - hR) / (2 * cellSize);
        const nz = (hD - hU) / (2 * cellSize);

        const len = Math.sqrt(nx * nx + 1 + nz * nz);
        normals.push(nx / len, 1 / len, nz / len);
      }
    }

    mesh.updateVerticesData(VertexBuffer.NormalKind, normals);
  }

  /**
   * Update foliage Y positions for a neighbor tile after height changes
   */
  private updateNeighborTileFoliage(gridX: number, gridY: number): void {
    const key = `${gridX},${gridY}`;
    const foliageMeshes = this.neighborFoliageMeshes.get(key);
    const tileData = this.editableTileData.get(key);

    if (!foliageMeshes || foliageMeshes.length === 0 || !tileData) return;

    const tileSize = this.heightmap?.getScale() || 64;
    const resolution = tileData.resolution;
    const offsetX = gridX * tileSize;
    const offsetZ = gridY * tileSize;

    for (const foliageMesh of foliageMeshes) {
      const matrices = foliageMesh.thinInstanceGetWorldMatrices();
      if (!matrices || matrices.length === 0) continue;

      const instanceCount = matrices.length;
      const updatedMatrices = new Float32Array(instanceCount * 16);

      for (let i = 0; i < instanceCount; i++) {
        const matrix = matrices[i];

        // Copy all 16 elements
        for (let j = 0; j < 16; j++) {
          updatedMatrices[i * 16 + j] = matrix.m[j];
        }

        // Get world position
        const worldX = matrix.m[12];
        const worldZ = matrix.m[14];

        // Convert to local tile coords
        const localX = worldX - offsetX;
        const localZ = worldZ - offsetZ;

        // Sample height from tile heightmap
        const cellSize = tileSize / (resolution - 1);
        const hx = Math.min(Math.floor(localX / cellSize), resolution - 2);
        const hz = Math.min(Math.floor(localZ / cellSize), resolution - 2);

        // Bilinear interpolation
        const fx = (localX / cellSize) - hx;
        const fz = (localZ / cellSize) - hz;

        const h00 = tileData.heightmapData[hz * resolution + hx];
        const h10 = tileData.heightmapData[hz * resolution + hx + 1];
        const h01 = tileData.heightmapData[(hz + 1) * resolution + hx];
        const h11 = tileData.heightmapData[(hz + 1) * resolution + hx + 1];

        const height = h00 * (1 - fx) * (1 - fz) +
                      h10 * fx * (1 - fz) +
                      h01 * (1 - fx) * fz +
                      h11 * fx * fz;

        // Update Y position
        updatedMatrices[i * 16 + 13] = height;
      }

      foliageMesh.thinInstanceSetBuffer("matrix", updatedMatrices, 16, false);
      foliageMesh.thinInstanceRefreshBoundingInfo();
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

    // For water, auto-set seaLevel if not already set, then carve basin and paint shore
    if (material === "water" && modified) {
      if (this.seaLevel < -50) {
        const terrainHeight = point.y;
        const waterSurfaceOffset = this.waterDepth * 0.8;
        this.setSeaLevel(terrainHeight - waterSurfaceOffset);
      }
      this.carveWaterBasin(point.x, point.z, settings);
      this.paintShoreTexture(point.x, point.z, settings.size);
      this.terrainMesh.updateWaterMaskTexture();
    }

    if (modified) {
      this.terrainMesh.updateSplatTexture();
      this.biomeDirty = true;
      this.foliageDirty = true;
      this.onModified?.();
    }
  }

  /**
   * Smoothstep interpolation (same as GLSL smoothstep)
   */
  private smoothstep(edge0: number, edge1: number, x: number): number {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }

  /**
   * Carve terrain to create a water basin with 3-zone depth profile
   * Creates natural-looking water body with deep center, sloped banks, and shore
   *
   * Zone layout:
   * - Deep Zone (0-60%): Maximum depth, flat bottom
   * - Slope Zone (60-100%): Gradual slope from deep to water surface
   * - Shore Zone (100-140%): Gentle beach slope above water level
   */
  private carveWaterBasin(worldX: number, worldZ: number, settings: BrushSettings): void {
    if (!this.heightmap || !this.terrainMesh) return;

    const scale = this.heightmap.getScale();
    const resolution = this.heightmap.getResolution();
    const cellSize = scale / (resolution - 1);

    const centerX = worldX / cellSize;
    const centerZ = worldZ / cellSize;
    const radius = settings.size / cellSize;
    const outerRadius = radius * 1.4;  // Shore zone extends 40% beyond water

    const minX = Math.max(0, Math.floor(centerX - outerRadius));
    const maxX = Math.min(resolution - 1, Math.ceil(centerX + outerRadius));
    const minZ = Math.max(0, Math.floor(centerZ - outerRadius));
    const maxZ = Math.min(resolution - 1, Math.ceil(centerZ + outerRadius));

    let modified = false;
    const shoreHeight = 0.5;  // How much shore rises above water level

    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - centerX;
        const dz = z - centerZ;
        const distance = Math.sqrt(dx * dx + dz * dz);
        const normalizedDist = distance / radius;

        if (distance > outerRadius) continue;

        const currentHeight = this.heightmap.getHeight(x, z);
        let targetHeight: number;
        let blendStrength: number;

        if (normalizedDist < 0.6) {
          // Deep Zone: Maximum depth (flat bottom)
          targetHeight = this.seaLevel - this.waterDepth;
          blendStrength = 1.0;
        } else if (normalizedDist < 1.0) {
          // Slope Zone: Transition from deep to water surface
          const progress = (normalizedDist - 0.6) / 0.4;
          const smoothProgress = this.smoothstep(0, 1, progress);
          targetHeight = this.seaLevel - this.waterDepth * (1 - smoothProgress);
          blendStrength = 1.0 - progress * 0.3;  // Slightly weaker at edges
        } else if (normalizedDist < 1.4) {
          // Shore Zone: Gentle slope above water level
          const shoreProgress = (normalizedDist - 1.0) / 0.4;
          const smoothShoreProgress = this.smoothstep(0, 1, shoreProgress);
          targetHeight = this.seaLevel + smoothShoreProgress * shoreHeight;
          blendStrength = 1.0 - shoreProgress;  // Fade out toward outer edge
        } else {
          continue;
        }

        // Apply carving with strength factor
        const effectiveStrength = settings.strength * blendStrength * 0.03;

        if (currentHeight > targetHeight) {
          // Lower terrain toward target
          const lowerAmount = (currentHeight - targetHeight) * effectiveStrength;
          const newHeight = currentHeight - lowerAmount;
          this.heightmap.setHeight(x, z, Math.max(targetHeight, newHeight));
          modified = true;
        } else if (normalizedDist >= 1.0 && currentHeight < targetHeight) {
          // Raise shore zone slightly if below target
          const raiseAmount = (targetHeight - currentHeight) * effectiveStrength * 0.5;
          const newHeight = currentHeight + raiseAmount;
          this.heightmap.setHeight(x, z, Math.min(targetHeight, newHeight));
          modified = true;
        }
      }
    }

    if (modified) {
      // Update terrain mesh with new heights
      this.terrainMesh.updateFromHeightmap();

      // Update water system's heightmap texture for depth calculation
      const waterSystem = this.biomeDecorator?.getWaterSystem();
      if (waterSystem) {
        waterSystem.updateHeightmapTexture();
      }
    }
  }

  /**
   * Carve water basin in neighbor tile
   */
  private carveWaterBasinToNeighborTile(
    gridX: number,
    gridY: number,
    localX: number,
    localZ: number,
    settings: BrushSettings
  ): void {
    const key = `${gridX},${gridY}`;
    const tileData = this.editableTileData.get(key);
    if (!tileData) return;

    const tileSize = this.heightmap?.getScale() || 64;
    const resolution = tileData.resolution;
    const cellSize = tileSize / (resolution - 1);

    const centerX = localX / cellSize;
    const centerZ = localZ / cellSize;
    const radius = settings.size / cellSize;
    const outerRadius = radius * 1.4;

    const minX = Math.max(0, Math.floor(centerX - outerRadius));
    const maxX = Math.min(resolution - 1, Math.ceil(centerX + outerRadius));
    const minZ = Math.max(0, Math.floor(centerZ - outerRadius));
    const maxZ = Math.min(resolution - 1, Math.ceil(centerZ + outerRadius));

    const shoreHeight = 0.5;

    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - centerX;
        const dz = z - centerZ;
        const distance = Math.sqrt(dx * dx + dz * dz);
        const normalizedDist = distance / radius;

        if (distance > outerRadius) continue;

        const idx = z * resolution + x;
        const currentHeight = tileData.heightmapData[idx];
        let targetHeight: number;
        let blendStrength: number;

        if (normalizedDist < 0.6) {
          targetHeight = this.seaLevel - this.waterDepth;
          blendStrength = 1.0;
        } else if (normalizedDist < 1.0) {
          const progress = (normalizedDist - 0.6) / 0.4;
          const smoothProgress = this.smoothstep(0, 1, progress);
          targetHeight = this.seaLevel - this.waterDepth * (1 - smoothProgress);
          blendStrength = 1.0 - progress * 0.3;
        } else if (normalizedDist < 1.4) {
          const shoreProgress = (normalizedDist - 1.0) / 0.4;
          const smoothShoreProgress = this.smoothstep(0, 1, shoreProgress);
          targetHeight = this.seaLevel + smoothShoreProgress * shoreHeight;
          blendStrength = 1.0 - shoreProgress;
        } else {
          continue;
        }

        const effectiveStrength = settings.strength * blendStrength * 0.03;

        if (currentHeight > targetHeight) {
          const lowerAmount = (currentHeight - targetHeight) * effectiveStrength;
          tileData.heightmapData[idx] = Math.max(targetHeight, currentHeight - lowerAmount);
        } else if (normalizedDist >= 1.0 && currentHeight < targetHeight) {
          const raiseAmount = (targetHeight - currentHeight) * effectiveStrength * 0.5;
          tileData.heightmapData[idx] = Math.min(targetHeight, currentHeight + raiseAmount);
        }
      }
    }

    // Also paint sand texture around water in neighbor tile
    this.paintShoreTextureToNeighborTile(gridX, gridY, localX, localZ, settings.size);
  }

  /**
   * Paint sand texture around water in neighbor tile
   */
  private paintShoreTextureToNeighborTile(
    gridX: number,
    gridY: number,
    localX: number,
    localZ: number,
    waterRadius: number
  ): void {
    const key = `${gridX},${gridY}`;
    const tileData = this.editableTileData.get(key);
    if (!tileData) return;

    const tileSize = this.heightmap?.getScale() || 64;
    const resolution = tileData.splatResolution;
    const cellSize = tileSize / (resolution - 1);

    const shoreWidth = waterRadius * 0.3;
    const innerRadius = waterRadius;
    const outerRadius = waterRadius + shoreWidth;

    const centerX = localX / cellSize;
    const centerZ = localZ / cellSize;
    const innerRadiusCells = innerRadius / cellSize;
    const outerRadiusCells = outerRadius / cellSize;

    const minX = Math.max(0, Math.floor(centerX - outerRadiusCells));
    const maxX = Math.min(resolution - 1, Math.ceil(centerX + outerRadiusCells));
    const minZ = Math.max(0, Math.floor(centerZ - outerRadiusCells));
    const maxZ = Math.min(resolution - 1, Math.ceil(centerZ + outerRadiusCells));

    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - centerX;
        const dz = z - centerZ;
        const distance = Math.sqrt(dx * dx + dz * dz);

        if (distance < innerRadiusCells || distance > outerRadiusCells) continue;

        const shoreProgress = (distance - innerRadiusCells) / (outerRadiusCells - innerRadiusCells);
        const sandStrength = (1 - shoreProgress) * 0.8;

        const idx = z * resolution + x;
        const splatIdx = idx * 4;

        // Reduce other channels, increase sand (channel 3)
        for (let c = 0; c < 4; c++) {
          if (c !== 3) {
            tileData.splatmapData[splatIdx + c] *= (1 - sandStrength * 0.1);
          }
        }
        tileData.splatmapData[splatIdx + 3] = Math.min(1, tileData.splatmapData[splatIdx + 3] + sandStrength * 0.1);

        // Normalize
        let total = 0;
        for (let c = 0; c < 4; c++) total += tileData.splatmapData[splatIdx + c];
        if (total > 0) {
          for (let c = 0; c < 4; c++) tileData.splatmapData[splatIdx + c] /= total;
        }
      }
    }
  }

  /**
   * Rebuild foliage for neighbor tile based on splatmap
   * Handles all biome types: grass, pebble (dirt), rock, sandRock (sand)
   */
  private rebuildNeighborTileFoliage(gridX: number, gridY: number): void {
    const key = `${gridX},${gridY}`;
    const tileData = this.editableTileData.get(key);
    if (!tileData || !this.foliageSystem) return;

    // Dispose existing foliage
    const existingFoliage = this.neighborFoliageMeshes.get(key);
    if (existingFoliage) {
      for (const mesh of existingFoliage) {
        mesh.dispose();
      }
      this.neighborFoliageMeshes.delete(key);
    }

    const tileSize = this.heightmap?.getScale() || 64;
    const offsetX = gridX * tileSize;
    const offsetZ = gridY * tileSize;
    const resolution = tileData.splatResolution;
    const cellSize = tileSize / (resolution - 1);

    // Instance arrays for each biome type
    type FoliageInstance = { x: number; y: number; z: number; scale: number; rotation: number };
    const grassInstances: FoliageInstance[] = [];
    const pebbleInstances: FoliageInstance[] = [];  // Dirt biome
    const rockInstances: FoliageInstance[] = [];    // Rock biome
    const sandRockInstances: FoliageInstance[] = []; // Sand biome

    // Biome config thresholds (matching FoliageSystem)
    const biomeConfig = {
      grass: { channel: 0, threshold: 0.3, minScale: 0.4, maxScale: 0.8, yOffset: 0 },
      pebble: { channel: 1, threshold: 0.4, minScale: 0.1, maxScale: 0.25, yOffset: -0.02 },
      rock: { channel: 2, threshold: 0.3, minScale: 0.2, maxScale: 0.6, yOffset: -0.05 },
      sandRock: { channel: 3, threshold: 0.5, minScale: 0.15, maxScale: 0.4, yOffset: -0.03 },
    };

    // Seed random for deterministic placement
    let seed = gridX * 1000 + gridY;
    const seededRandom = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };

    for (let z = 0; z < resolution; z += 4) {
      for (let x = 0; x < resolution; x += 4) {
        const idx = z * resolution + x;
        const splatIdx = idx * 4;

        const grass = tileData.splatmapData[splatIdx + 0];
        const dirt = tileData.splatmapData[splatIdx + 1];
        const rock = tileData.splatmapData[splatIdx + 2];
        const sand = tileData.splatmapData[splatIdx + 3];
        const water = tileData.waterMaskData[idx];

        // Skip water areas
        if (water > 0.3) continue;

        // Get height at this position
        const hRes = tileData.resolution;
        const hx = Math.floor((x / (resolution - 1)) * (hRes - 1));
        const hz = Math.floor((z / (resolution - 1)) * (hRes - 1));
        const height = tileData.heightmapData[hz * hRes + hx] || 0;

        const localX = x * cellSize;
        const localZ = z * cellSize;

        // Random jitter
        const jitterX = (seededRandom() - 0.5) * cellSize * 2;
        const jitterZ = (seededRandom() - 0.5) * cellSize * 2;

        // Place grass foliage
        if (grass >= biomeConfig.grass.threshold && seededRandom() < grass) {
          const scale = biomeConfig.grass.minScale + seededRandom() * (biomeConfig.grass.maxScale - biomeConfig.grass.minScale);
          grassInstances.push({
            x: localX + jitterX + offsetX,
            y: height + biomeConfig.grass.yOffset,
            z: localZ + jitterZ + offsetZ,
            scale,
            rotation: seededRandom() * Math.PI * 2,
          });
        }

        // Place pebble foliage (dirt biome)
        if (dirt >= biomeConfig.pebble.threshold && seededRandom() < dirt * 0.5) {
          const scale = biomeConfig.pebble.minScale + seededRandom() * (biomeConfig.pebble.maxScale - biomeConfig.pebble.minScale);
          pebbleInstances.push({
            x: localX + jitterX + offsetX,
            y: height + biomeConfig.pebble.yOffset,
            z: localZ + jitterZ + offsetZ,
            scale,
            rotation: seededRandom() * Math.PI * 2,
          });
        }

        // Place rock foliage (rock biome)
        if (rock >= biomeConfig.rock.threshold && seededRandom() < rock * 0.3) {
          const scale = biomeConfig.rock.minScale + seededRandom() * (biomeConfig.rock.maxScale - biomeConfig.rock.minScale);
          rockInstances.push({
            x: localX + jitterX + offsetX,
            y: height + biomeConfig.rock.yOffset,
            z: localZ + jitterZ + offsetZ,
            scale,
            rotation: seededRandom() * Math.PI * 2,
          });
        }

        // Place sandRock foliage (sand biome)
        if (sand >= biomeConfig.sandRock.threshold && seededRandom() < sand * 0.3) {
          const scale = biomeConfig.sandRock.minScale + seededRandom() * (biomeConfig.sandRock.maxScale - biomeConfig.sandRock.minScale);
          sandRockInstances.push({
            x: localX + jitterX + offsetX,
            y: height + biomeConfig.sandRock.yOffset,
            z: localZ + jitterZ + offsetZ,
            scale,
            rotation: seededRandom() * Math.PI * 2,
          });
        }
      }
    }

    const foliageMeshes: Mesh[] = [];

    // Helper function to create foliage mesh from instances
    const createFoliageMesh = (
      instances: FoliageInstance[],
      baseMeshType: string,
      suffix: string
    ): void => {
      if (instances.length === 0) return;

      const baseMesh = this.foliageSystem!.getBaseMesh(baseMeshType);
      if (!baseMesh) return;

      const foliageMesh = new Mesh(`neighbor_foliage_${gridX}_${gridY}_${suffix}`, this.scene);

      const positions = baseMesh.getVerticesData(VertexBuffer.PositionKind);
      const normals = baseMesh.getVerticesData(VertexBuffer.NormalKind);
      const colors = baseMesh.getVerticesData(VertexBuffer.ColorKind);
      const indices = baseMesh.getIndices();

      if (positions && indices) {
        const vertexData = new VertexData();
        vertexData.positions = new Float32Array(positions);
        if (normals) vertexData.normals = new Float32Array(normals);
        if (colors) vertexData.colors = new Float32Array(colors);
        vertexData.indices = new Uint32Array(indices);
        vertexData.applyToMesh(foliageMesh);
      }

      foliageMesh.material = baseMesh.material;

      // Create instance matrices
      const matrices = new Float32Array(instances.length * 16);
      for (let i = 0; i < instances.length; i++) {
        const inst = instances[i];
        const m = Matrix.Compose(
          new Vector3(inst.scale, inst.scale, inst.scale),
          Quaternion.RotationAxis(Vector3.Up(), inst.rotation),
          new Vector3(inst.x, inst.y, inst.z)
        );
        m.copyToArray(matrices, i * 16);
      }

      foliageMesh.thinInstanceSetBuffer("matrix", matrices, 16);
      foliageMesh.isPickable = false;
      foliageMeshes.push(foliageMesh);
    };

    // Create meshes for each biome type
    createFoliageMesh(grassInstances, "grass", "grass");
    createFoliageMesh(pebbleInstances, "rock", "pebble");  // Pebbles use rock mesh
    createFoliageMesh(rockInstances, "rock", "rock");
    createFoliageMesh(sandRockInstances, "sandRock", "sandRock");

    if (foliageMeshes.length > 0) {
      this.neighborFoliageMeshes.set(key, foliageMeshes);
    }
  }

  /**
   * Ensure WaterSystem exists for shader material sharing
   */
  private ensureWaterSystem(): void {
    if (!this.biomeDecorator) return;

    const waterSystem = this.biomeDecorator.getWaterSystem();
    if (!waterSystem) {
      // Force biome decorator to build water (creates WaterSystem)
      this.biomeDecorator.rebuildAll();
    }
  }

  /**
   * Remove foliage instances in water area from neighbor tile
   */
  private removeNeighborFoliageInWaterArea(
    gridX: number,
    gridY: number,
    localX: number,
    localZ: number,
    radius: number
  ): void {
    const key = `${gridX},${gridY}`;
    const foliageMeshes = this.neighborFoliageMeshes.get(key);
    if (!foliageMeshes || foliageMeshes.length === 0) return;

    const tileSize = this.heightmap?.getScale() || 64;
    const offsetX = gridX * tileSize;
    const offsetZ = gridY * tileSize;
    const worldCenterX = localX + offsetX;
    const worldCenterZ = localZ + offsetZ;
    const radiusSq = radius * radius;

    for (const foliageMesh of foliageMeshes) {
      const matrices = foliageMesh.thinInstanceGetWorldMatrices();
      if (!matrices || matrices.length === 0) continue;

      // Filter out instances inside water area
      const filteredMatrices: Float32Array[] = [];
      for (let i = 0; i < matrices.length; i++) {
        const m = matrices[i];
        const x = m.m[12];
        const z = m.m[14];

        const dx = x - worldCenterX;
        const dz = z - worldCenterZ;
        const distSq = dx * dx + dz * dz;

        // Keep instances outside water area
        if (distSq > radiusSq) {
          const matrixData = new Float32Array(16);
          m.copyToArray(matrixData);
          filteredMatrices.push(matrixData);
        }
      }

      // Update mesh with filtered instances
      if (filteredMatrices.length > 0) {
        const newMatrices = new Float32Array(filteredMatrices.length * 16);
        for (let i = 0; i < filteredMatrices.length; i++) {
          newMatrices.set(filteredMatrices[i], i * 16);
        }
        foliageMesh.thinInstanceSetBuffer("matrix", newMatrices, 16);
      } else {
        // No instances left, hide mesh
        foliageMesh.thinInstanceSetBuffer("matrix", new Float32Array(0), 16);
      }
    }
  }

  /**
   * Automatically paint sand texture around water edges
   * Creates natural-looking beach/shore around water bodies
   */
  private paintShoreTexture(worldX: number, worldZ: number, waterRadius: number): void {
    if (!this.heightmap || !this.terrainMesh) return;

    const splatMap = this.terrainMesh.getSplatMap();
    const scale = this.heightmap.getScale();
    const resolution = splatMap.getResolution();

    // Shore width in world units
    const shoreWidth = 3.0;
    const outerRadius = waterRadius + shoreWidth;

    // Convert to splat map coordinates
    const centerSplatX = (worldX / scale) * (resolution - 1);
    const centerSplatZ = (worldZ / scale) * (resolution - 1);
    const waterRadiusSplat = (waterRadius / scale) * (resolution - 1);
    const outerRadiusSplat = (outerRadius / scale) * (resolution - 1);

    const minX = Math.max(0, Math.floor(centerSplatX - outerRadiusSplat));
    const maxX = Math.min(resolution - 1, Math.ceil(centerSplatX + outerRadiusSplat));
    const minZ = Math.max(0, Math.floor(centerSplatZ - outerRadiusSplat));
    const maxZ = Math.min(resolution - 1, Math.ceil(centerSplatZ + outerRadiusSplat));

    let modified = false;

    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - centerSplatX;
        const dz = z - centerSplatZ;
        const distance = Math.sqrt(dx * dx + dz * dz);

        // Only paint in the shore zone (between water edge and outer edge)
        if (distance >= waterRadiusSplat * 0.9 && distance <= outerRadiusSplat) {
          // Calculate falloff (stronger near water, fades outward)
          const shoreWidthSplat = outerRadiusSplat - waterRadiusSplat;
          const distFromWater = distance - waterRadiusSplat * 0.9;
          const normalizedDist = distFromWater / (shoreWidthSplat + waterRadiusSplat * 0.1);
          const sandStrength = 1.0 - this.smoothstep(0, 1, normalizedDist);

          if (sandStrength > 0.05) {
            const weights = splatMap.getWeights(x, z);

            // Increase sand (channel 3), decrease others proportionally
            const sandBoost = sandStrength * 0.15;  // Gradual blending
            const newSandWeight = Math.min(1, weights[3] + sandBoost);
            const reduction = sandBoost;

            // Reduce other channels proportionally
            const totalOther = weights[0] + weights[1] + weights[2];
            if (totalOther > 0) {
              const scale0 = weights[0] / totalOther;
              const scale1 = weights[1] / totalOther;
              const scale2 = weights[2] / totalOther;

              const newWeights: [number, number, number, number] = [
                Math.max(0, weights[0] - reduction * scale0),
                Math.max(0, weights[1] - reduction * scale1),
                Math.max(0, weights[2] - reduction * scale2),
                newSandWeight,
              ];

              // Normalize
              const sum = newWeights[0] + newWeights[1] + newWeights[2] + newWeights[3];
              if (sum > 0) {
                newWeights[0] /= sum;
                newWeights[1] /= sum;
                newWeights[2] /= sum;
                newWeights[3] /= sum;
              }

              splatMap.setWeights(x, z, newWeights);
              modified = true;
            }
          }
        }
      }
    }

    if (modified) {
      this.terrainMesh.updateSplatTexture();
    }
  }

  /**
   * Get/Set sea level
   */
  getSeaLevel(): number {
    return this.seaLevel;
  }

  setSeaLevel(level: number): void {
    this.seaLevel = level;
    // Update water system if exists
    if (this.biomeDecorator) {
      this.biomeDecorator.setWaterLevel(level);
    }
  }

  /**
   * Get/Set water depth
   */
  getWaterDepth(): number {
    return this.waterDepth;
  }

  setWaterDepth(depth: number): void {
    this.waterDepth = Math.max(0.5, depth);
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

  // Debug visibility controls
  setTerrainVisible(visible: boolean): void {
    if (this.terrainMesh) {
      const mesh = this.terrainMesh.getMesh();
      if (mesh) {
        mesh.isVisible = visible;
      }
    }
  }

  setSplatMapEnabled(enabled: boolean): void {
    if (this.terrainMesh) {
      this.terrainMesh.setSplatMapEnabled(enabled);
    }
  }

  setDebugRenderMode(mode: string): void {
    if (!this.terrainMesh) return;

    const modeMap: Record<string, number> = {
      "normal": 0,
      "splatmap_raw": 1,
      "water_mask": 2,
      "grass_weight": 3,
      "dirt_weight": 4,
      "rock_weight": 5,
      "sand_weight": 6,
      "normals": 7,
      "normals_detail": 8,
      "normals_final": 9,
      "rock_ao": 10,
      "macro_var": 11,
      "depth": 12,
      "slope": 13,
      "uv": 14,
      "diffuse": 15,
      "specular": 16,
      "ao": 17,
      "base_color": 18,
    };

    const modeValue = modeMap[mode] ?? 0;
    this.terrainMesh.setDebugMode(modeValue);
  }

  setWaterVisible(visible: boolean): void {
    if (this.biomeDecorator) {
      const waterSystem = this.biomeDecorator.getWaterSystem();
      if (waterSystem) {
        const waterMesh = waterSystem.getMesh();
        if (waterMesh) {
          waterMesh.isVisible = visible;
        }
      }
    }
  }

  setFoliageVisible(visible: boolean): void {
    // Hide foliage system meshes
    if (this.foliageSystem) {
      this.foliageSystem.setVisible(visible);
    }
    // Also hide biome decorator props
    if (this.biomeDecorator) {
      this.biomeDecorator.setVisible(visible);
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

  /**
   * Make terrain and biome data seamless for infinite tiling.
   * This processes heightmap, splat map (biome data), and water mask,
   * then regenerates all dependent systems (terrain mesh, biome decorations, foliage).
   */
  makeSeamless(): void {
    if (!this.heightmap || !this.terrainMesh) {
      console.warn("[EditorEngine] Cannot make seamless: no heightmap or terrain mesh");
      return;
    }

    console.log("[EditorEngine] Making terrain and biomes seamless...");

    const splatMap = this.terrainMesh.getSplatMap();

    // 1. Mirror water at edges - create matching water basins on opposite edges
    // This carves terrain and paints water/sand symmetrically
    this.mirrorWaterAtEdges(splatMap);

    // 2. Make splat map (biome data) seamless
    splatMap.makeSeamless();

    // 3. Make heightmap seamless
    this.heightmap.makeSeamless();

    // 4. Update terrain mesh from heightmap
    this.terrainMesh.updateFromHeightmap();
    this.terrainMesh.updateSplatTexture();
    this.terrainMesh.updateWaterMaskTexture();

    // 5. Rebuild biome decorations (water, etc.)
    if (this.biomeDecorator) {
      this.biomeDecorator.rebuildAll();
    }

    // 6. Regenerate foliage with seamless biome data
    if (this.foliageSystem) {
      this.foliageSystem.generateAll();
    }

    console.log("[EditorEngine] Seamless processing complete");
  }

  /**
   * Make seamless for specific direction only.
   * Used when connecting tiles in a specific direction.
   * @param direction Which edge to make seamless: "left", "right", "top", "bottom"
   */
  makeSeamlessDirection(direction: "left" | "right" | "top" | "bottom"): void {
    if (!this.heightmap || !this.terrainMesh) {
      console.warn("[EditorEngine] Cannot make seamless: no heightmap or terrain mesh");
      return;
    }

    const splatMap = this.terrainMesh.getSplatMap();

    // Mirror water only at the specified edge
    this.mirrorWaterAtEdge(splatMap, direction);

    // Make splat map seamless for the specified direction
    this.makeSplatSeamlessDirection(splatMap, direction);

    // Make heightmap seamless for the specified direction
    this.makeHeightmapSeamlessDirection(direction);

    // Update terrain mesh
    this.terrainMesh.updateFromHeightmap();
    this.terrainMesh.updateSplatTexture();
    this.terrainMesh.updateWaterMaskTexture();

    // Rebuild decorations
    if (this.biomeDecorator) {
      this.biomeDecorator.rebuildAll();
    }
    if (this.foliageSystem) {
      this.foliageSystem.generateAll();
    }

    console.log(`[EditorEngine] Seamless processing complete for direction: ${direction}`);
  }

  /**
   * Mirror water at a specific edge only.
   */
  private mirrorWaterAtEdge(
    splatMap: SplatMap,
    direction: "left" | "right" | "top" | "bottom"
  ): void {
    if (!this.heightmap || !this.terrainMesh) return;

    const sRes = splatMap.getResolution();
    const waterThreshold = 0.2;
    const basinRadius = 6;

    if (direction === "left" || direction === "right") {
      const checkEdge = direction === "left" ? 0 : sRes - 1;
      const mirrorEdge = direction === "left" ? sRes - 1 : 0;

      for (let sz = 0; sz < sRes; sz++) {
        const edgeWater = splatMap.getWaterWeight(checkEdge, sz);
        const oppositeWater = splatMap.getWaterWeight(mirrorEdge, sz);

        if (edgeWater > waterThreshold && oppositeWater < waterThreshold) {
          this.createWaterBasinAtEdge(splatMap, mirrorEdge, sz, basinRadius, edgeWater);
        }
      }
    } else {
      const checkEdge = direction === "top" ? 0 : sRes - 1;
      const mirrorEdge = direction === "top" ? sRes - 1 : 0;

      for (let sx = 0; sx < sRes; sx++) {
        const edgeWater = splatMap.getWaterWeight(sx, checkEdge);
        const oppositeWater = splatMap.getWaterWeight(sx, mirrorEdge);

        if (edgeWater > waterThreshold && oppositeWater < waterThreshold) {
          this.createWaterBasinAtEdge(splatMap, sx, mirrorEdge, basinRadius, edgeWater);
        }
      }
    }
  }

  /**
   * Make splat map seamless for a specific direction only.
   */
  private makeSplatSeamlessDirection(
    splatMap: SplatMap,
    direction: "left" | "right" | "top" | "bottom"
  ): void {
    const res = splatMap.getResolution();
    const data = splatMap.getData();
    const channels = 4;
    const waterMask = splatMap.getWaterMask();

    if (direction === "left" || direction === "right") {
      // Sync left-right edges
      for (let z = 0; z < res; z++) {
        const leftIdx = (z * res + 0) * channels;
        const rightIdx = (z * res + (res - 1)) * channels;

        for (let c = 0; c < channels; c++) {
          const avgVal = (data[leftIdx + c] + data[rightIdx + c]) / 2;
          data[leftIdx + c] = avgVal;
          data[rightIdx + c] = avgVal;
        }

        // Water mask
        const leftWater = waterMask[z * res + 0];
        const rightWater = waterMask[z * res + (res - 1)];
        const avgWater = (leftWater + rightWater) / 2;
        waterMask[z * res + 0] = avgWater;
        waterMask[z * res + (res - 1)] = avgWater;
      }
    } else {
      // Sync top-bottom edges
      for (let x = 0; x < res; x++) {
        const topIdx = (0 * res + x) * channels;
        const bottomIdx = ((res - 1) * res + x) * channels;

        for (let c = 0; c < channels; c++) {
          const avgVal = (data[topIdx + c] + data[bottomIdx + c]) / 2;
          data[topIdx + c] = avgVal;
          data[bottomIdx + c] = avgVal;
        }

        // Water mask
        const topWater = waterMask[0 * res + x];
        const bottomWater = waterMask[(res - 1) * res + x];
        const avgWater = (topWater + bottomWater) / 2;
        waterMask[0 * res + x] = avgWater;
        waterMask[(res - 1) * res + x] = avgWater;
      }
    }
  }

  /**
   * Make heightmap seamless for a specific direction only.
   */
  private makeHeightmapSeamlessDirection(
    direction: "left" | "right" | "top" | "bottom"
  ): void {
    if (!this.heightmap) return;

    const res = this.heightmap.getResolution();

    if (direction === "left" || direction === "right") {
      // Sync left-right edges
      for (let z = 0; z < res; z++) {
        const leftH = this.heightmap.getHeight(0, z);
        const rightH = this.heightmap.getHeight(res - 1, z);
        const avgH = (leftH + rightH) / 2;
        this.heightmap.setHeight(0, z, avgH);
        this.heightmap.setHeight(res - 1, z, avgH);
      }
    } else {
      // Sync top-bottom edges
      for (let x = 0; x < res; x++) {
        const topH = this.heightmap.getHeight(x, 0);
        const bottomH = this.heightmap.getHeight(x, res - 1);
        const avgH = (topH + bottomH) / 2;
        this.heightmap.setHeight(x, 0, avgH);
        this.heightmap.setHeight(x, res - 1, avgH);
      }
    }
  }

  /**
   * Mirror water at tile edges.
   * If water exists at one edge, create a matching water basin at the opposite edge.
   * This ensures water connects seamlessly when tiles are repeated.
   */
  private mirrorWaterAtEdges(splatMap: SplatMap): void {
    if (!this.heightmap || !this.terrainMesh) return;

    const sRes = splatMap.getResolution();
    const hRes = this.heightmap.getResolution();
    const scale = this.heightmap.getScale();
    const waterThreshold = 0.2;
    const basinRadius = 6; // Radius for the circular basin (in splat map units)

    // Find water at edges and mirror to opposite edge
    // Check left edge -> mirror to right
    for (let sz = 0; sz < sRes; sz++) {
      const leftWater = splatMap.getWaterWeight(0, sz);
      const rightWater = splatMap.getWaterWeight(sRes - 1, sz);

      if (leftWater > waterThreshold && rightWater < waterThreshold) {
        // Water on left, none on right - create basin on right
        this.createWaterBasinAtEdge(splatMap, sRes - 1, sz, basinRadius, leftWater);
      } else if (rightWater > waterThreshold && leftWater < waterThreshold) {
        // Water on right, none on left - create basin on left
        this.createWaterBasinAtEdge(splatMap, 0, sz, basinRadius, rightWater);
      }
    }

    // Check top edge -> mirror to bottom
    for (let sx = 0; sx < sRes; sx++) {
      const topWater = splatMap.getWaterWeight(sx, 0);
      const bottomWater = splatMap.getWaterWeight(sx, sRes - 1);

      if (topWater > waterThreshold && bottomWater < waterThreshold) {
        // Water on top, none on bottom - create basin on bottom
        this.createWaterBasinAtEdge(splatMap, sx, sRes - 1, basinRadius, topWater);
      } else if (bottomWater > waterThreshold && topWater < waterThreshold) {
        // Water on bottom, none on top - create basin on top
        this.createWaterBasinAtEdge(splatMap, sx, 0, basinRadius, bottomWater);
      }
    }
  }

  /**
   * Create a circular water basin at a specific edge position.
   * Carves terrain, paints water mask, and adds sand around edges.
   */
  private createWaterBasinAtEdge(
    splatMap: SplatMap,
    edgeX: number,
    edgeZ: number,
    radius: number,
    waterStrength: number
  ): void {
    if (!this.heightmap || !this.terrainMesh) return;

    const sRes = splatMap.getResolution();
    const hRes = this.heightmap.getResolution();
    const scale = this.heightmap.getScale();

    // Convert splat coords to world coords
    const worldX = (edgeX / (sRes - 1)) * scale;
    const worldZ = (edgeZ / (sRes - 1)) * scale;

    // Basin parameters
    const worldRadius = (radius / (sRes - 1)) * scale;
    const carveDepth = this.waterDepth;

    // Auto-set seaLevel if not set
    if (this.seaLevel < -50) {
      const terrainHeight = this.heightmap.getInterpolatedHeight(worldX, worldZ);
      this.setSeaLevel(terrainHeight - carveDepth * 0.8);
    }

    // Create circular basin in heightmap
    const hCenterX = (edgeX / (sRes - 1)) * (hRes - 1);
    const hCenterZ = (edgeZ / (sRes - 1)) * (hRes - 1);
    const hRadius = (radius / (sRes - 1)) * (hRes - 1);

    for (let hz = 0; hz < hRes; hz++) {
      for (let hx = 0; hx < hRes; hx++) {
        const dx = hx - hCenterX;
        const dz = hz - hCenterZ;
        const dist = Math.sqrt(dx * dx + dz * dz);

        if (dist < hRadius * 1.2) {
          const normalizedDist = dist / hRadius;
          const currentHeight = this.heightmap.getHeight(hx, hz);
          let targetHeight: number;

          if (normalizedDist < 0.6) {
            // Deep center
            targetHeight = this.seaLevel - carveDepth;
          } else if (normalizedDist < 1.0) {
            // Slope
            const t = (normalizedDist - 0.6) / 0.4;
            const smooth = t * t * (3 - 2 * t);
            targetHeight = this.seaLevel - carveDepth * (1 - smooth);
          } else {
            // Shore
            const t = (normalizedDist - 1.0) / 0.2;
            const smooth = Math.min(1, t * t * (3 - 2 * t));
            targetHeight = this.seaLevel + smooth * 0.5;
          }

          // Only carve down, don't raise
          if (currentHeight > targetHeight) {
            const blendFactor = Math.max(0, 1 - normalizedDist);
            const newHeight = currentHeight * (1 - blendFactor * 0.5) + targetHeight * blendFactor * 0.5;
            this.heightmap.setHeight(hx, hz, Math.min(currentHeight, newHeight));
          }
        }
      }
    }

    // Paint water and sand in splat map
    for (let sz = 0; sz < sRes; sz++) {
      for (let sx = 0; sx < sRes; sx++) {
        const dx = sx - edgeX;
        const dz = sz - edgeZ;
        const dist = Math.sqrt(dx * dx + dz * dz);

        if (dist < radius * 1.4) {
          const normalizedDist = dist / radius;

          if (normalizedDist < 1.0) {
            // Water area
            const waterMask = splatMap.getWaterMask();
            const idx = sz * sRes + sx;
            const waterVal = waterStrength * (1 - normalizedDist * 0.5);
            waterMask[idx] = Math.max(waterMask[idx], waterVal);
          }

          // Sand around water
          if (normalizedDist >= 0.7 && normalizedDist < 1.4) {
            const sandStrength = 1 - Math.abs(normalizedDist - 1.0) / 0.4;
            const weights = splatMap.getWeights(sx, sz);
            const newSand = Math.min(1, weights[3] + sandStrength * 0.5);
            const reduction = sandStrength * 0.3;
            const newWeights: [number, number, number, number] = [
              Math.max(0, weights[0] - reduction * 0.5),
              Math.max(0, weights[1] - reduction * 0.3),
              Math.max(0, weights[2] - reduction * 0.2),
              newSand,
            ];
            // Normalize
            const sum = newWeights[0] + newWeights[1] + newWeights[2] + newWeights[3];
            if (sum > 0) {
              newWeights[0] /= sum;
              newWeights[1] /= sum;
              newWeights[2] /= sum;
              newWeights[3] /= sum;
            }
            splatMap.setWeights(sx, sz, newWeights);
          }
        }
      }
    }
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

  // Camera animation state
  private cameraAnimation: {
    startPosition: Vector3;
    endPosition: Vector3;
    startTarget: Vector3;
    endTarget: Vector3;
    startTime: number;
    duration: number;
  } | null = null;
  private cameraAnimationObserver: any = null;

  /**
   * Focus camera on a specific grid cell and show tile boundary highlight
   * Smoothly transitions camera position while maintaining viewing direction
   */
  focusOnGridCell(gridX: number, gridY: number): void {
    const tileSize = 64;
    const centerX = gridX * tileSize + tileSize / 2;
    const centerZ = gridY * tileSize + tileSize / 2;

    // Calculate the translation offset (how much to move)
    const currentTarget = this.camera.target.clone();
    const newTarget = new Vector3(centerX, 0, centerZ);
    const offset = newTarget.subtract(currentTarget);

    // Move both position and target by the same offset (maintains viewing direction)
    const newPosition = this.camera.position.add(offset);

    // Start smooth camera transition
    this.startCameraTransition(newPosition, newTarget, 500); // 500ms duration

    // Update tile boundary highlight
    this.updateTileHighlight(gridX, gridY);
  }

  /**
   * Start a smooth camera transition - moves both position and target
   * to maintain viewing direction
   */
  private startCameraTransition(endPosition: Vector3, endTarget: Vector3, durationMs: number): void {
    this.cameraAnimation = {
      startPosition: this.camera.position.clone(),
      endPosition: endPosition,
      startTarget: this.camera.target.clone(),
      endTarget: endTarget,
      startTime: performance.now(),
      duration: durationMs,
    };

    // Setup animation update if not already running
    if (!this.cameraAnimationObserver) {
      this.cameraAnimationObserver = this.scene.onBeforeRenderObservable.add(() => {
        this.updateCameraTransition();
      });
    }
  }

  /**
   * Update camera transition animation
   */
  private updateCameraTransition(): void {
    if (!this.cameraAnimation) {
      // Remove observer when no animation
      if (this.cameraAnimationObserver) {
        this.scene.onBeforeRenderObservable.remove(this.cameraAnimationObserver);
        this.cameraAnimationObserver = null;
      }
      return;
    }

    const { startPosition, endPosition, startTarget, endTarget, startTime, duration } = this.cameraAnimation;
    const elapsed = performance.now() - startTime;
    const t = Math.min(elapsed / duration, 1);

    // Ease-out cubic for smooth deceleration
    const eased = 1 - Math.pow(1 - t, 3);

    // Interpolate both position and target (parallel movement)
    const newPosition = Vector3.Lerp(startPosition, endPosition, eased);
    const newTarget = Vector3.Lerp(startTarget, endTarget, eased);

    // Update camera using setPosition to properly update ArcRotateCamera internals
    this.camera.setPosition(newPosition);
    this.camera.setTarget(newTarget);

    // Animation complete
    if (t >= 1) {
      this.camera.setPosition(endPosition);
      this.camera.setTarget(endTarget);
      this.cameraAnimation = null;
    }
  }

  /**
   * Update tile boundary highlight mesh
   */
  private updateTileHighlight(gridX: number, gridY: number): void {
    const tileSize = 64;
    const x = gridX * tileSize;
    const z = gridY * tileSize;

    // Remove existing highlight
    if (this.tileHighlightMesh) {
      this.tileHighlightMesh.dispose();
      this.tileHighlightMesh = null;
    }

    // Create rectangle boundary using lines
    const points = [
      new Vector3(x, 0.5, z),
      new Vector3(x + tileSize, 0.5, z),
      new Vector3(x + tileSize, 0.5, z + tileSize),
      new Vector3(x, 0.5, z + tileSize),
      new Vector3(x, 0.5, z) // Close the loop
    ];

    this.tileHighlightMesh = MeshBuilder.CreateLines(
      "tileHighlight",
      { points },
      this.scene
    );
    this.tileHighlightMesh.color = new Color3(1, 0.8, 0); // Yellow/gold color
    this.tileHighlightMesh.isPickable = false;
  }

  /**
   * Clear tile boundary highlight
   */
  clearTileHighlight(): void {
    if (this.tileHighlightMesh) {
      this.tileHighlightMesh.dispose();
      this.tileHighlightMesh = null;
    }
  }

  /**
   * Move camera in WASD style (moves camera target)
   */
  moveCamera(direction: "forward" | "backward" | "left" | "right", speed: number = 2): void {
    // Get camera forward direction (projected onto XZ plane)
    const forward = this.camera.getForwardRay().direction;
    const forwardXZ = new Vector3(forward.x, 0, forward.z).normalize();
    const rightXZ = Vector3.Cross(Vector3.Up(), forwardXZ).normalize();

    let movement = Vector3.Zero();

    switch (direction) {
      case "forward":
        movement = forwardXZ.scale(speed);
        break;
      case "backward":
        movement = forwardXZ.scale(-speed);
        break;
      case "left":
        movement = rightXZ.scale(-speed);
        break;
      case "right":
        movement = rightXZ.scale(speed);
        break;
    }

    this.camera.target.addInPlace(movement);
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

    // Ensure neighbor tiles exist before entering game mode
    // This creates the world grid based on World tab settings
    if (this.neighborTileMeshes.size === 0) {
      this.updateNeighborTilePreviews();
    }

    // Disable terrain LOD FIRST so getMesh() returns the full resolution mesh
    this.terrainMesh.setLODEnabled(false);

    const mesh = this.terrainMesh.getMesh();
    if (!mesh) return;

    // Save current state
    this.savedClearColor = this.scene.clearColor.clone();

    // Hide editor elements
    if (this.gridMesh) this.gridMesh.isVisible = false;
    if (this.brushPreview) this.brushPreview.isVisible = false;

    // Detach editor camera
    this.camera.detachControl();

    // Create and enable game preview with foliage and water systems
    // Use streaming mode if streaming is enabled (more dynamic tile loading)
    const useStreaming = this.streamingEnabled && this.streamingManager !== null;
    this.gamePreview = new GamePreview(
      this.scene,
      this.heightmap,
      this.terrainMesh,
      this.foliageSystem,
      this.biomeDecorator,
      this.tileMode,
      useStreaming
    );
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

    // Re-enable terrain LOD
    if (this.terrainMesh) {
      this.terrainMesh.setLODEnabled(true);
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

  /**
   * Set tile mode for game preview: "clone" or "mirror"
   * Mirror mode creates symmetric tiles for seamless water/terrain connections
   * Clone mode uses simple tile repetition
   */
  setTileMode(mode: TileMode): void {
    this.tileMode = mode;
    // If already in game mode, exit and re-enter to apply new mode
    if (this.isGameMode) {
      this.exitGameMode();
      this.enterGameMode();
    }
  }

  getTileMode(): TileMode {
    return this.tileMode;
  }

  private handleResize = (): void => {
    this.engine.resize();
  };

  // ============================================
  // Manual Tile Management
  // ============================================

  /**
   * Get current terrain data for tile saving
   */
  getCurrentTileData(): {
    heightmapData: Float32Array;
    splatmapData: Float32Array;
    waterMaskData: Float32Array;
    resolution: number;
    size: number;
    seaLevel: number;
    waterDepth: number;
    foliageData?: Record<string, string>;
  } | null {
    if (!this.heightmap || !this.terrainMesh) return null;

    const splatMap = this.terrainMesh.getSplatMap();

    // Export foliage instance data
    const foliageData = this.foliageSystem?.exportTileData();

    return {
      heightmapData: new Float32Array(this.heightmap.getData()),
      splatmapData: new Float32Array(splatMap.getData()),
      waterMaskData: new Float32Array(splatMap.getWaterMask()),
      resolution: this.heightmap.getResolution() - 1, // Convert back to segment count
      size: this.heightmap.getScale(),
      seaLevel: this.seaLevel,
      waterDepth: this.waterDepth,
      foliageData,
    };
  }

  /**
   * Load tile data into the editor
   */
  loadTileData(
    heightmapData: Float32Array,
    splatmapData: Float32Array,
    waterMaskData: Float32Array,
    resolution: number,
    size: number,
    seaLevel: number,
    waterDepth: number,
    foliageData?: Record<string, string>
  ): void {
    // Dispose existing terrain
    if (this.terrainMesh) {
      this.terrainMesh.dispose();
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

    // Set water parameters
    this.seaLevel = seaLevel;
    this.waterDepth = waterDepth;

    // Create new heightmap with loaded data
    this.heightmap = new Heightmap(resolution, size);
    const hmData = this.heightmap.getData();
    hmData.set(heightmapData);

    // Create terrain mesh
    this.terrainMesh = new TerrainMesh(this.scene, this.heightmap);
    this.terrainMesh.create();

    // Load splat map data
    const splatMap = this.terrainMesh.getSplatMap();
    const splatData = splatMap.getData();
    splatData.set(splatmapData);
    const waterMask = splatMap.getWaterMask();
    waterMask.set(waterMaskData);

    // Update textures
    this.terrainMesh.updateSplatTexture();
    this.terrainMesh.updateWaterMaskTexture();

    // Initialize biome decorator
    this.biomeDecorator = new BiomeDecorator(this.scene, this.heightmap, this.terrainMesh);
    this.biomeDecorator.rebuildAll();

    // Initialize foliage system
    this.foliageSystem = new FoliageSystem(
      this.scene,
      this.heightmap,
      splatMap,
      size
    );

    // Load saved foliage data or generate new
    if (foliageData && Object.keys(foliageData).length > 0) {
      console.log("[EditorEngine] Importing saved foliage data");
      this.foliageSystem.importTileData(foliageData, 0, 0, true);
    } else {
      console.log("[EditorEngine] Generating new foliage");
      this.foliageSystem.generateAll();
    }

    // Initialize impostor system
    this.impostorSystem = new ImpostorSystem(this.scene);

    // Initialize prop manager
    if (this.propManager) {
      this.propManager.dispose();
    }
    this.propManager = new PropManager(this.scene, this.heightmap);
    this.propManager.setTileSize(this.heightmap.getScale());  // Set tile size for streaming grouping

    console.log("[EditorEngine] Tile data loaded");
  }

  /**
   * Apply edge data from connected tile for seamless stitching
   * @param direction The edge direction (left, right, top, bottom)
   * @param edgeHeights Height values along the edge
   * @param edgeSplats Splat values along the edge
   * @param edgeWater Water mask values along the edge
   */
  applyConnectedEdgeData(
    direction: "left" | "right" | "top" | "bottom",
    edgeHeights: Float32Array,
    edgeSplats: Float32Array,
    edgeWater: Float32Array
  ): void {
    if (!this.heightmap || !this.terrainMesh) return;

    const res = this.heightmap.getResolution();
    const splatMap = this.terrainMesh.getSplatMap();
    const splatData = splatMap.getData();
    const waterMask = splatMap.getWaterMask();
    const blendDepth = 10; // How many cells to blend into

    if (direction === "left" || direction === "right") {
      const edgeX = direction === "left" ? 0 : res - 1;
      const blendDir = direction === "left" ? 1 : -1;

      for (let z = 0; z < res; z++) {
        const targetHeight = edgeHeights[z];
        const currentHeight = this.heightmap.getHeight(edgeX, z);
        const avgHeight = (targetHeight + currentHeight) / 2;

        // Blend heights
        for (let d = 0; d < blendDepth; d++) {
          const x = edgeX + d * blendDir;
          if (x < 0 || x >= res) continue;

          const blend = 1 - d / blendDepth;
          const h = this.heightmap.getHeight(x, z);
          this.heightmap.setHeight(x, z, h * (1 - blend) + avgHeight * blend);
        }

        // Sync edge exactly
        this.heightmap.setHeight(edgeX, z, avgHeight);

        // Sync splat
        const splatIdx = (z * res + edgeX) * 4;
        for (let c = 0; c < 4; c++) {
          splatData[splatIdx + c] = (splatData[splatIdx + c] + edgeSplats[z * 4 + c]) / 2;
        }

        // Sync water
        const waterIdx = z * res + edgeX;
        waterMask[waterIdx] = (waterMask[waterIdx] + edgeWater[z]) / 2;
      }
    } else {
      const edgeZ = direction === "top" ? 0 : res - 1;
      const blendDir = direction === "top" ? 1 : -1;

      for (let x = 0; x < res; x++) {
        const targetHeight = edgeHeights[x];
        const currentHeight = this.heightmap.getHeight(x, edgeZ);
        const avgHeight = (targetHeight + currentHeight) / 2;

        // Blend heights
        for (let d = 0; d < blendDepth; d++) {
          const z = edgeZ + d * blendDir;
          if (z < 0 || z >= res) continue;

          const blend = 1 - d / blendDepth;
          const h = this.heightmap.getHeight(x, z);
          this.heightmap.setHeight(x, z, h * (1 - blend) + avgHeight * blend);
        }

        // Sync edge exactly
        this.heightmap.setHeight(x, edgeZ, avgHeight);

        // Sync splat
        const splatIdx = (edgeZ * res + x) * 4;
        for (let c = 0; c < 4; c++) {
          splatData[splatIdx + c] = (splatData[splatIdx + c] + edgeSplats[x * 4 + c]) / 2;
        }

        // Sync water
        const waterIdx = edgeZ * res + x;
        waterMask[waterIdx] = (waterMask[waterIdx] + edgeWater[x]) / 2;
      }
    }

    // Update terrain mesh
    this.terrainMesh.updateFromHeightmap();
    this.terrainMesh.updateSplatTexture();
    this.terrainMesh.updateWaterMaskTexture();

    // Rebuild decorations
    if (this.biomeDecorator) {
      this.biomeDecorator.rebuildAll();
    }
    if (this.foliageSystem) {
      this.foliageSystem.generateAll();
    }

    console.log(`[EditorEngine] Applied connected edge data for direction: ${direction}`);
  }

  // ============================================
  // World Grid Multi-Tile Rendering
  // ============================================

  /**
   * Update the world grid rendering based on ManualTileManager configuration.
   * In edit mode: shows ghost/preview tiles around the center
   * In game mode: triggers GamePreview to reload with new configuration
   */
  updateWorldGrid(): void {
    const tileManager = getManualTileManager();
    const worldConfig = tileManager.getWorldConfig();
    console.log("=== [EditorEngine] updateWorldGrid ===");
    console.log("  isGameMode:", this.isGameMode);
    console.log("  gridSize:", worldConfig.gridSize);
    console.log("  manualPlacements:", worldConfig.manualPlacements.length);

    if (this.isGameMode) {
      // In game mode, exit and re-enter to apply new configuration
      console.log("  → exitGameMode + enterGameMode");
      this.exitGameMode();
      this.enterGameMode();
      return;
    }

    // In edit mode, update neighboring tile previews
    console.log("  → updateNeighborTilePreviews (edit mode)");
    this.updateNeighborTilePreviews();
  }

  /**
   * Toggle visibility of neighboring tile previews in edit mode
   */
  setShowNeighborTiles(show: boolean): void {
    this.showNeighborTiles = show;
    for (const mesh of this.neighborTileMeshes.values()) {
      mesh.isVisible = show;
    }
  }

  /**
   * Update neighboring tile previews based on World Grid configuration
   */
  private updateNeighborTilePreviews(): void {
    console.log("[EditorEngine] updateNeighborTilePreviews called");
    if (!this.terrainMesh || !this.heightmap) {
      console.log("[EditorEngine] No terrainMesh or heightmap, skipping");
      return;
    }

    // Update default tile template with current terrain state (including water)
    this.saveDefaultTileTemplate();

    const tileManager = getManualTileManager();
    const worldConfig = tileManager.getWorldConfig();
    const size = this.heightmap.getScale();

    const gridSize = worldConfig.gridSize || 3;
    const halfGrid = Math.floor(gridSize / 2);

    console.log("[EditorEngine] World config:", {
      placements: worldConfig.manualPlacements.length,
      pool: worldConfig.infinitePool.length,
      size,
      gridSize,
      halfGrid
    });

    // Clear existing neighbor meshes
    this.clearNeighborTilePreviews();

    // Create previews for NxN grid around center (excluding center which is the active tile)
    // Build positions dynamically based on gridSize
    const positions: Array<{x: number, y: number}> = [];
    for (let x = -halfGrid; x <= halfGrid; x++) {
      for (let y = -halfGrid; y <= halfGrid; y++) {
        if (x === 0 && y === 0) continue; // Skip center (active tile)
        positions.push({ x, y });
      }
    }
    console.log(`[EditorEngine] Creating ${positions.length} neighbor tiles for ${gridSize}x${gridSize} grid`);

    for (const pos of positions) {
      // Check for manually placed tile first
      const placement = worldConfig.manualPlacements.find(p => p.gridX === pos.x && p.gridY === pos.y);

      if (placement) {
        // Manual placement - use the specified tile
        const tileData = tileManager.getTile(placement.tileId);
        console.log(`[EditorEngine] Position (${pos.x},${pos.y}): manual placement tileId=${placement.tileId}, hasData=${!!tileData}`);
        if (tileData) {
          this.createNeighborTilePreview(pos.x, pos.y, placement.tileId, size);
        } else {
          // Tile data missing - use default grass tile
          console.log(`[EditorEngine] Position (${pos.x},${pos.y}): tile data missing, using default grass`);
          this.createDefaultGrassTilePreview(pos.x, pos.y, size);
        }
      } else {
        // No manual placement - use default flat grass tile for infinite expansion
        console.log(`[EditorEngine] Position (${pos.x},${pos.y}): no placement, using default grass tile`);
        this.createDefaultGrassTilePreview(pos.x, pos.y, size);
      }
    }

    console.log("[EditorEngine] Created", this.neighborTileMeshes.size, "neighbor tile meshes");
  }

  /**
   * Get tile ID for a given grid position from placements or pool
   */
  private getTileForPosition(
    x: number,
    y: number,
    placements: TilePlacement[],
    pool: PoolTileEntry[]
  ): string | null {
    // Check manual placement first
    const placement = placements.find(p => p.gridX === x && p.gridY === y);
    if (placement) {
      return placement.tileId;
    }

    // If no manual placement, pick from enabled pool tiles
    const enabledPool = pool.filter(e => e.enabled);
    if (enabledPool.length === 0) {
      return null;
    }

    // Deterministic random selection based on position (for consistent preview)
    const seed = (x + 100) * 1000 + (y + 100);
    const totalWeight = enabledPool.reduce((sum, e) => sum + e.weight, 0);
    let random = ((seed * 9301 + 49297) % 233280) / 233280 * totalWeight;

    for (const entry of enabledPool) {
      random -= entry.weight;
      if (random <= 0) {
        return entry.tileId;
      }
    }

    return enabledPool[0]?.tileId || null;
  }

  /**
   * Create a terrain mesh for a neighboring tile (same rendering as main terrain)
   */
  private createNeighborTilePreview(gridX: number, gridY: number, tileId: string, tileSize: number): void {
    console.log(`[EditorEngine] createNeighborTilePreview START: (${gridX},${gridY}), tileId=${tileId}`);

    const tileManager = getManualTileManager();
    const tileData = tileManager.getTile(tileId);

    if (!tileData) {
      console.log(`[EditorEngine] createNeighborTilePreview: no tileData for (${gridX},${gridY})`);
      return;
    }
    if (!this.terrainMesh) {
      console.log(`[EditorEngine] createNeighborTilePreview: no terrainMesh for (${gridX},${gridY})`);
      return;
    }

    try {
      // Decode heightmap and splatmap from stored tile
      const heightmapData = this.decodeFloat32Array(tileData.heightmap);
      const splatmapData = this.decodeFloat32Array(tileData.splatmap);
      const tileResolution = tileData.resolution + 1; // +1 for vertex count

      // Apply seamless blending with center tile edges
      this.blendNeighborEdges(gridX, gridY, heightmapData, splatmapData, tileResolution);

      console.log(`[EditorEngine] Tile data: resolution=${tileData.resolution}, heightmapLength=${heightmapData.length}, tileSize=${tileSize}`);

      // Use same resolution as center tile for seamless edges
      // LOD should be handled separately via camera distance, not at mesh creation
      const actualResolution = tileResolution;
      const cellSize = tileSize / (actualResolution - 1);

      const positions: number[] = [];
      const normals: number[] = [];
      const uvs: number[] = [];
      const indices: number[] = [];

      // World offset for this tile
      const worldOffsetX = gridX * tileSize;
      const worldOffsetZ = gridY * tileSize;

      // Create vertices (same logic as TerrainMesh)
      // Apply world offset directly to vertex positions for correct shader worldPos calculation
      for (let z = 0; z < actualResolution; z++) {
        for (let x = 0; x < actualResolution; x++) {
          const idx = z * tileResolution + x;
          const height = (idx < heightmapData.length) ? heightmapData[idx] : 0;

          // Apply world offset directly to vertex positions
          positions.push(x * cellSize + worldOffsetX, height, z * cellSize + worldOffsetZ);
          uvs.push(x / (actualResolution - 1), z / (actualResolution - 1));
          normals.push(0, 1, 0); // Will be recalculated
        }
      }

      // Create indices
      for (let z = 0; z < actualResolution - 1; z++) {
        for (let x = 0; x < actualResolution - 1; x++) {
          const topLeft = z * actualResolution + x;
          const topRight = topLeft + 1;
          const bottomLeft = (z + 1) * actualResolution + x;
          const bottomRight = bottomLeft + 1;

          indices.push(topLeft, bottomLeft, topRight);
          indices.push(topRight, bottomLeft, bottomRight);
        }
      }

      console.log(`[EditorEngine] Mesh data: vertices=${positions.length / 3}, indices=${indices.length}`);

      // Create mesh
      const mesh = new Mesh(`neighbor_${gridX}_${gridY}`, this.scene);
      const vertexData = new VertexData();
      vertexData.positions = positions;
      vertexData.indices = indices;
      vertexData.uvs = uvs;

      // Use pre-set normals (0,1,0) for flat terrain
      // Note: VertexData.ComputeNormals was producing incorrect results for neighbor tiles
      // TODO: If proper normal computation is needed, investigate the issue
      vertexData.normals = normals;

      vertexData.applyToMesh(mesh, true);

      // Mesh position is (0,0,0) since world offset is already baked into vertex positions
      mesh.position.x = 0;
      mesh.position.z = 0;

      // Create full terrain shader material for neighbor tile (splatmapData already decoded above)
      const splatResolution = Math.sqrt(splatmapData.length / 4);

      // Create terrain material with the tile's splatmap data
      const material = createTerrainMaterial(this.scene, splatmapData, splatResolution);
      material.name = `neighbor_terrain_${gridX}_${gridY}`;
      material.backFaceCulling = false;

      // Set terrain size uniform to match the tile size
      material.setFloat("uTerrainSize", tileSize);

      // Create water mask texture for neighbor tile
      const waterMaskData = this.decodeFloat32Array(tileData.waterMask);
      const waterMaskResolution = Math.sqrt(waterMaskData.length);
      const waterMaskUint8 = new Uint8Array(waterMaskResolution * waterMaskResolution * 4);
      for (let i = 0; i < waterMaskResolution * waterMaskResolution; i++) {
        const value = Math.floor(waterMaskData[i] * 255);
        waterMaskUint8[i * 4] = value;      // R
        waterMaskUint8[i * 4 + 1] = value;  // G
        waterMaskUint8[i * 4 + 2] = value;  // B
        waterMaskUint8[i * 4 + 3] = 255;    // A
      }
      const waterMaskTexture = new RawTexture(
        waterMaskUint8,
        waterMaskResolution,
        waterMaskResolution,
        Engine.TEXTUREFORMAT_RGBA,
        this.scene,
        false,
        false,
        Texture.BILINEAR_SAMPLINGMODE
      );
      waterMaskTexture.name = `neighbor_waterMask_${gridX}_${gridY}`;
      material.setTexture("uWaterMask", waterMaskTexture);

      // Sync water level with center tile
      material.setFloat("uWaterLevel", this.seaLevel);

      mesh.material = material;

      console.log(`[EditorEngine] Applied full terrain shader to neighbor mesh (${gridX},${gridY}), splatRes=${splatResolution}`);

      // Store the material for cleanup (not shared, can be disposed)
      (mesh as any)._ownMaterial = true;

      mesh.isPickable = true; // Enable picking for editing
      mesh.receiveShadows = true;

      console.log(`[EditorEngine] SUCCESS: Created neighbor terrain at (${gridX},${gridY}), position=(${mesh.position.x}, ${mesh.position.z}), isVisible=${mesh.isVisible}`);

      this.neighborTileMeshes.set(`${gridX},${gridY}`, mesh);

      // Render foliage for neighbor tile if available
      this.createNeighborFoliage(gridX, gridY, tileData.foliageData, tileSize);

      // Create water mesh if tile has water
      this.createNeighborWaterMesh(gridX, gridY, tileSize, waterMaskData, waterMaskResolution);
    } catch (error) {
      console.error(`[EditorEngine] ERROR creating neighbor tile (${gridX},${gridY}):`, error);
    }
  }

  /**
   * Create foliage meshes for a neighbor tile
   */
  private createNeighborFoliage(
    gridX: number,
    gridY: number,
    foliageData: Record<string, string> | undefined,
    tileSize: number
  ): void {
    if (!foliageData || Object.keys(foliageData).length === 0) {
      console.log(`[EditorEngine] No foliage data for neighbor (${gridX},${gridY})`);
      return;
    }

    if (!this.foliageSystem) {
      console.log(`[EditorEngine] No foliageSystem available for neighbor foliage`);
      return;
    }

    const gridKey = `${gridX},${gridY}`;
    const foliageMeshes: Mesh[] = [];
    const offsetX = gridX * tileSize;
    const offsetZ = gridY * tileSize;

    let totalInstances = 0;

    for (const [typeName, base64] of Object.entries(foliageData)) {
      // Get base mesh from foliage system
      const baseMesh = this.foliageSystem.getBaseMesh(typeName);
      if (!baseMesh) {
        console.warn(`[EditorEngine] No base mesh for foliage type: ${typeName}`);
        continue;
      }

      // Decode matrices
      const matrices = this.decodeFloat32Array(base64);
      if (matrices.length === 0) continue;

      const instanceCount = matrices.length / 16;

      // Apply position offset to matrices
      for (let i = 0; i < instanceCount; i++) {
        const baseIdx = i * 16;
        matrices[baseIdx + 12] += offsetX;
        matrices[baseIdx + 14] += offsetZ;
      }

      // Create mesh with independent geometry (avoid WebGPU buffer sharing)
      const neighborMesh = new Mesh(`neighbor_foliage_${gridX}_${gridY}_${typeName}`, this.scene);

      const positions = baseMesh.getVerticesData(VertexBuffer.PositionKind);
      const normals = baseMesh.getVerticesData(VertexBuffer.NormalKind);
      const colors = baseMesh.getVerticesData(VertexBuffer.ColorKind);
      const uvs = baseMesh.getVerticesData(VertexBuffer.UVKind);
      const indices = baseMesh.getIndices();

      if (positions && indices) {
        const vertexData = new VertexData();
        vertexData.positions = new Float32Array(positions);
        if (normals) vertexData.normals = new Float32Array(normals);
        if (colors) vertexData.colors = new Float32Array(colors);
        if (uvs) vertexData.uvs = new Float32Array(uvs);
        vertexData.indices = new Uint32Array(indices);
        vertexData.applyToMesh(neighborMesh);
      }

      neighborMesh.material = baseMesh.material;
      neighborMesh.isVisible = true;
      neighborMesh.isPickable = false;

      // Set thin instances
      neighborMesh.thinInstanceSetBuffer("matrix", matrices, 16, false);
      neighborMesh.thinInstanceCount = instanceCount;
      neighborMesh.thinInstanceRefreshBoundingInfo();

      foliageMeshes.push(neighborMesh);
      totalInstances += instanceCount;
    }

    if (foliageMeshes.length > 0) {
      this.neighborFoliageMeshes.set(gridKey, foliageMeshes);
      console.log(`[EditorEngine] Created ${foliageMeshes.length} foliage meshes for neighbor (${gridX},${gridY}), total instances: ${totalInstances}`);
    }
  }

  /**
   * Blend neighbor tile edges with center tile for seamless transitions
   */
  private blendNeighborEdges(
    gridX: number,
    gridY: number,
    heightmapData: Float32Array,
    splatmapData: Float32Array,
    resolution: number
  ): void {
    if (!this.heightmap || !this.terrainMesh) return;

    const centerRes = this.heightmap.getResolution();
    const centerSplatMap = this.terrainMesh.getSplatMap();
    const centerSplatData = centerSplatMap.getData();
    const blendDepth = Math.min(10, Math.floor(resolution / 10)); // Adaptive blend depth

    // Blend RIGHT edge of neighbor with LEFT edge of center (neighbor is to the left)
    if (gridX === -1 && gridY === 0) {
      this.blendEdge(heightmapData, splatmapData, resolution, "right",
        (z) => this.heightmap!.getHeight(0, z),
        (z, c) => centerSplatData[(z * centerRes + 0) * 4 + c],
        blendDepth, centerRes
      );
    }

    // Blend LEFT edge of neighbor with RIGHT edge of center (neighbor is to the right)
    if (gridX === 1 && gridY === 0) {
      this.blendEdge(heightmapData, splatmapData, resolution, "left",
        (z) => this.heightmap!.getHeight(centerRes - 1, z),
        (z, c) => centerSplatData[(z * centerRes + (centerRes - 1)) * 4 + c],
        blendDepth, centerRes
      );
    }

    // Blend BOTTOM edge of neighbor with TOP edge of center (neighbor is above/behind)
    if (gridX === 0 && gridY === -1) {
      this.blendEdge(heightmapData, splatmapData, resolution, "bottom",
        (x) => this.heightmap!.getHeight(x, 0),
        (x, c) => centerSplatData[(0 * centerRes + x) * 4 + c],
        blendDepth, centerRes
      );
    }

    // Blend TOP edge of neighbor with BOTTOM edge of center (neighbor is below/front)
    if (gridX === 0 && gridY === 1) {
      this.blendEdge(heightmapData, splatmapData, resolution, "top",
        (x) => this.heightmap!.getHeight(x, centerRes - 1),
        (x, c) => centerSplatData[((centerRes - 1) * centerRes + x) * 4 + c],
        blendDepth, centerRes
      );
    }

    // Corner tiles: blend both edges
    if (gridX === -1 && gridY === -1) {
      // Top-left corner: blend right and bottom edges
      this.blendEdge(heightmapData, splatmapData, resolution, "right",
        (z) => this.heightmap!.getHeight(0, z),
        (z, c) => centerSplatData[(z * centerRes + 0) * 4 + c],
        blendDepth, centerRes
      );
      this.blendEdge(heightmapData, splatmapData, resolution, "bottom",
        (x) => this.heightmap!.getHeight(x, 0),
        (x, c) => centerSplatData[(0 * centerRes + x) * 4 + c],
        blendDepth, centerRes
      );
    }

    if (gridX === 1 && gridY === -1) {
      // Top-right corner: blend left and bottom edges
      this.blendEdge(heightmapData, splatmapData, resolution, "left",
        (z) => this.heightmap!.getHeight(centerRes - 1, z),
        (z, c) => centerSplatData[(z * centerRes + (centerRes - 1)) * 4 + c],
        blendDepth, centerRes
      );
      this.blendEdge(heightmapData, splatmapData, resolution, "bottom",
        (x) => this.heightmap!.getHeight(x, 0),
        (x, c) => centerSplatData[(0 * centerRes + x) * 4 + c],
        blendDepth, centerRes
      );
    }

    if (gridX === -1 && gridY === 1) {
      // Bottom-left corner: blend right and top edges
      this.blendEdge(heightmapData, splatmapData, resolution, "right",
        (z) => this.heightmap!.getHeight(0, z),
        (z, c) => centerSplatData[(z * centerRes + 0) * 4 + c],
        blendDepth, centerRes
      );
      this.blendEdge(heightmapData, splatmapData, resolution, "top",
        (x) => this.heightmap!.getHeight(x, centerRes - 1),
        (x, c) => centerSplatData[((centerRes - 1) * centerRes + x) * 4 + c],
        blendDepth, centerRes
      );
    }

    if (gridX === 1 && gridY === 1) {
      // Bottom-right corner: blend left and top edges
      this.blendEdge(heightmapData, splatmapData, resolution, "left",
        (z) => this.heightmap!.getHeight(centerRes - 1, z),
        (z, c) => centerSplatData[(z * centerRes + (centerRes - 1)) * 4 + c],
        blendDepth, centerRes
      );
      this.blendEdge(heightmapData, splatmapData, resolution, "top",
        (x) => this.heightmap!.getHeight(x, centerRes - 1),
        (x, c) => centerSplatData[((centerRes - 1) * centerRes + x) * 4 + c],
        blendDepth, centerRes
      );
    }
  }

  /**
   * Blend a single edge of neighbor tile with center tile data
   * Handles resolution differences between neighbor and center tiles
   */
  private blendEdge(
    heightmapData: Float32Array,
    splatmapData: Float32Array,
    neighborRes: number,
    edge: "left" | "right" | "top" | "bottom",
    getCenterHeight: (i: number) => number,
    getCenterSplat: (i: number, channel: number) => number,
    blendDepth: number,
    centerRes: number
  ): void {
    const isVertical = edge === "left" || edge === "right";
    const edgePos = edge === "right" || edge === "bottom" ? neighborRes - 1 : 0;
    const blendDir = edge === "right" || edge === "bottom" ? -1 : 1;

    for (let i = 0; i < neighborRes; i++) {
      // Map neighbor index to center index using normalized position (0~1)
      const t = neighborRes > 1 ? i / (neighborRes - 1) : 0;
      const floatCenterI = t * (centerRes - 1);

      // Interpolate center height at this position
      const ci0 = Math.floor(floatCenterI);
      const ci1 = Math.min(ci0 + 1, centerRes - 1);
      const frac = floatCenterI - ci0;
      const centerHeight = getCenterHeight(ci0) * (1 - frac) + getCenterHeight(ci1) * frac;

      for (let d = 0; d < blendDepth; d++) {
        const pos = edgePos + d * blendDir;
        if (pos < 0 || pos >= neighborRes) continue;

        const blend = 1 - d / blendDepth; // 1 at edge, 0 at blend depth

        // Calculate heightmap index
        const heightIdx = isVertical ? (i * neighborRes + pos) : (pos * neighborRes + i);
        if (heightIdx >= 0 && heightIdx < heightmapData.length) {
          const currentHeight = heightmapData[heightIdx];
          const avgHeight = (centerHeight + currentHeight) / 2;
          heightmapData[heightIdx] = currentHeight * (1 - blend) + avgHeight * blend;
        }

        // Calculate splatmap index (4 channels per pixel)
        const splatIdx = (isVertical ? (i * neighborRes + pos) : (pos * neighborRes + i)) * 4;
        if (splatIdx >= 0 && splatIdx + 3 < splatmapData.length) {
          for (let c = 0; c < 4; c++) {
            // Interpolate center splat at this position
            const centerSplat0 = getCenterSplat(ci0, c);
            const centerSplat1 = getCenterSplat(ci1, c);
            const centerSplat = centerSplat0 * (1 - frac) + centerSplat1 * frac;

            const currentSplat = splatmapData[splatIdx + c];
            const avgSplat = (centerSplat + currentSplat) / 2;
            splatmapData[splatIdx + c] = currentSplat * (1 - blend) + avgSplat * blend;
          }
        }
      }
    }
  }

  /**
   * Create a default tile for infinite expansion using saved template
   * Uses mirror tiling for seamless connections (same as neighbor-to-neighbor)
   */
  private createDefaultGrassTilePreview(gridX: number, gridY: number, tileSize: number): void {
    console.log(`[EditorEngine] createDefaultGrassTilePreview START: (${gridX},${gridY}), tileSize=${tileSize}`);

    if (!this.defaultTileTemplate) {
      console.log(`[EditorEngine] No default tile template, creating flat tile`);
      this.createFlatGrassTile(gridX, gridY, tileSize);
      return;
    }

    const template = this.defaultTileTemplate;
    const sourceRes = template.resolution;

    // Use same resolution as source for seamless edges
    const actualRes = sourceRes;
    const cellSize = tileSize / (actualRes - 1);

    // Use checkerboard mirror pattern for seamless tiling (same for ALL tiles)
    const mirrorX = gridX % 2 !== 0;
    const mirrorZ = gridY % 2 !== 0;

    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    // World offset for this tile
    const worldOffsetX = gridX * tileSize;
    const worldOffsetZ = gridY * tileSize;

    // Create vertices from template heightmap with mirroring
    // Apply world offset directly to vertex positions for correct shader worldPos calculation
    for (let z = 0; z < actualRes; z++) {
      for (let x = 0; x < actualRes; x++) {
        let srcX = x;
        let srcZ = z;

        if (mirrorX) srcX = (sourceRes - 1) - srcX;
        if (mirrorZ) srcZ = (sourceRes - 1) - srcZ;

        const idx = srcZ * sourceRes + srcX;
        const height = template.heightmapData[idx] || 0;

        // Apply world offset directly to vertex positions
        positions.push(x * cellSize + worldOffsetX, height, z * cellSize + worldOffsetZ);
        uvs.push(x / (actualRes - 1), z / (actualRes - 1));
        normals.push(0, 1, 0);
      }
    }

    // Create indices
    for (let z = 0; z < actualRes - 1; z++) {
      for (let x = 0; x < actualRes - 1; x++) {
        const topLeft = z * actualRes + x;
        const topRight = topLeft + 1;
        const bottomLeft = (z + 1) * actualRes + x;
        const bottomRight = bottomLeft + 1;

        indices.push(topLeft, bottomLeft, topRight);
        indices.push(topRight, bottomLeft, bottomRight);
      }
    }

    // Use Y-up normals for flat terrain (ComputeNormals produces incorrect results)
    const normalArray: number[] = [];
    for (let i = 0; i < positions.length / 3; i++) {
      normalArray.push(0, 1, 0);
    }

    // Create mesh
    const mesh = new Mesh(`default_tile_${gridX}_${gridY}`, this.scene);
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.uvs = uvs;
    vertexData.normals = normalArray;
    vertexData.applyToMesh(mesh, true);

    // Mesh position is (0,0,0) since world offset is already baked into vertex positions
    // This ensures shader worldPos (vPosition) is correct for grass patterns and macro variation
    mesh.position.x = 0;
    mesh.position.z = 0;

    // Create splatmap from template with mirroring
    const splatSourceRes = Math.round(Math.sqrt(template.splatmapData.length / 4));
    const splatTargetRes = 64;
    const splatmapData = new Float32Array(splatTargetRes * splatTargetRes * 4);

    // Initialize all to 100% grass first
    for (let i = 0; i < splatTargetRes * splatTargetRes; i++) {
      splatmapData[i * 4 + 0] = 1.0; // grass
      splatmapData[i * 4 + 1] = 0.0; // dirt
      splatmapData[i * 4 + 2] = 0.0; // rock
      splatmapData[i * 4 + 3] = 0.0; // sand
    }

    // Copy from template with mirroring (only if template has valid data)
    if (splatSourceRes > 0 && template.splatmapData.length >= splatSourceRes * splatSourceRes * 4) {
      for (let sz = 0; sz < splatTargetRes; sz++) {
        for (let sx = 0; sx < splatTargetRes; sx++) {
          let srcSX = Math.floor((sx / (splatTargetRes - 1)) * (splatSourceRes - 1));
          let srcSZ = Math.floor((sz / (splatTargetRes - 1)) * (splatSourceRes - 1));

          if (mirrorX) srcSX = (splatSourceRes - 1) - srcSX;
          if (mirrorZ) srcSZ = (splatSourceRes - 1) - srcSZ;

          // Clamp to valid range
          srcSX = Math.max(0, Math.min(splatSourceRes - 1, srcSX));
          srcSZ = Math.max(0, Math.min(splatSourceRes - 1, srcSZ));

          const srcIdx = (srcSZ * splatSourceRes + srcSX) * 4;
          const dstIdx = (sz * splatTargetRes + sx) * 4;

          // Copy values (check bounds to avoid undefined)
          if (srcIdx + 3 < template.splatmapData.length) {
            const g = template.splatmapData[srcIdx + 0];
            const d = template.splatmapData[srcIdx + 1];
            const r = template.splatmapData[srcIdx + 2];
            const s = template.splatmapData[srcIdx + 3];

            // Validate values - use default grass if NaN or invalid
            if (Number.isFinite(g) && Number.isFinite(d) && Number.isFinite(r) && Number.isFinite(s)) {
              splatmapData[dstIdx + 0] = g;
              splatmapData[dstIdx + 1] = d;
              splatmapData[dstIdx + 2] = r;
              splatmapData[dstIdx + 3] = s;
            }
            // else: keep pre-initialized 100% grass
          }
        }
      }
    }

    // Verify splatmap data integrity - check a few pixels
    let validPixelCount = 0;
    let invalidPixelCount = 0;
    for (let i = 0; i < splatTargetRes * splatTargetRes; i++) {
      const idx = i * 4;
      const sum = splatmapData[idx] + splatmapData[idx + 1] + splatmapData[idx + 2] + splatmapData[idx + 3];
      if (Number.isFinite(sum) && sum > 0.99 && sum < 1.01) {
        validPixelCount++;
      } else {
        invalidPixelCount++;
        // Fix invalid pixel with 100% grass
        splatmapData[idx + 0] = 1.0;
        splatmapData[idx + 1] = 0.0;
        splatmapData[idx + 2] = 0.0;
        splatmapData[idx + 3] = 0.0;
      }
    }
    if (invalidPixelCount > 0) {
      console.warn(`[EditorEngine] Fixed ${invalidPixelCount}/${splatTargetRes * splatTargetRes} invalid splatmap pixels for tile (${gridX},${gridY})`);
    }

    // Create terrain material
    const material = createTerrainMaterial(this.scene, splatmapData, splatTargetRes);
    material.name = `default_tile_mat_${gridX}_${gridY}`;
    material.backFaceCulling = false;
    material.setFloat("uTerrainSize", tileSize);

    // Create splatmap texture separately and explicitly set it (like TerrainMesh does)
    // This ensures the texture is properly bound to the shader
    const splatTexture = createSplatTexture(this.scene, splatmapData, splatTargetRes);
    splatTexture.name = `default_tile_splat_${gridX}_${gridY}`;
    material.setTexture("uSplatMap", splatTexture);

    // Create empty water mask
    const waterMaskData = new Uint8Array(splatTargetRes * splatTargetRes * 4);
    const waterMaskTexture = new RawTexture(
      waterMaskData,
      splatTargetRes,
      splatTargetRes,
      Engine.TEXTUREFORMAT_RGBA,
      this.scene,
      false,
      false,
      Texture.BILINEAR_SAMPLINGMODE
    );
    waterMaskTexture.name = `default_tile_water_${gridX}_${gridY}`;
    waterMaskTexture.wrapU = Texture.CLAMP_ADDRESSMODE;
    waterMaskTexture.wrapV = Texture.CLAMP_ADDRESSMODE;
    // Force immediate GPU upload
    waterMaskTexture.update(waterMaskData);
    material.setTexture("uWaterMask", waterMaskTexture);

    // Sync water level with center tile
    material.setFloat("uWaterLevel", this.seaLevel);

    mesh.material = material;
    (mesh as any)._ownMaterial = true;

    mesh.isPickable = true; // Enable picking for editing
    mesh.receiveShadows = true;
    mesh.isVisible = true;
    mesh.refreshBoundingInfo();

    console.log(`[EditorEngine] SUCCESS: Created default tile at (${gridX},${gridY}), mirror=(${mirrorX},${mirrorZ})`);

    this.neighborTileMeshes.set(`${gridX},${gridY}`, mesh);

    // Store editable data for this tile
    const key = `${gridX},${gridY}`;
    // Reconstruct heightmap data at full resolution for editing (with mirroring)
    const fullHeightmapData = new Float32Array(template.resolution * template.resolution);
    for (let z = 0; z < template.resolution; z++) {
      for (let x = 0; x < template.resolution; x++) {
        let srcX = x;
        let srcZ = z;
        if (mirrorX) srcX = (template.resolution - 1) - srcX;
        if (mirrorZ) srcZ = (template.resolution - 1) - srcZ;
        fullHeightmapData[z * template.resolution + x] = template.heightmapData[srcZ * template.resolution + srcX];
      }
    }

    // Create water mask data with mirroring
    const waterSourceRes = Math.sqrt(template.waterMaskData.length);
    const tileWaterMaskData = new Float32Array(splatTargetRes * splatTargetRes);
    for (let z = 0; z < splatTargetRes; z++) {
      for (let x = 0; x < splatTargetRes; x++) {
        let srcX = Math.floor((x / (splatTargetRes - 1)) * (waterSourceRes - 1));
        let srcZ = Math.floor((z / (splatTargetRes - 1)) * (waterSourceRes - 1));
        if (mirrorX) srcX = (waterSourceRes - 1) - srcX;
        if (mirrorZ) srcZ = (waterSourceRes - 1) - srcZ;
        const srcIdx = srcZ * waterSourceRes + srcX;
        tileWaterMaskData[z * splatTargetRes + x] = template.waterMaskData[srcIdx] || 0;
      }
    }

    this.editableTileData.set(key, {
      heightmapData: fullHeightmapData,
      splatmapData: new Float32Array(splatmapData),
      waterMaskData: tileWaterMaskData,
      resolution: template.resolution,
      splatResolution: splatTargetRes,
    });

    // Create foliage from template
    this.createDefaultTileFoliage(gridX, gridY, tileSize, mirrorX, mirrorZ);

    // Create water mesh if there's water in this tile
    this.createNeighborWaterMesh(gridX, gridY, tileSize, tileWaterMaskData, splatTargetRes);
  }

  /**
   * Fallback: Create a simple flat grass tile
   */
  private createFlatGrassTile(gridX: number, gridY: number, tileSize: number): void {
    const resolution = 33;
    const cellSize = tileSize / (resolution - 1);

    // World offset for this tile
    const worldOffsetX = gridX * tileSize;
    const worldOffsetZ = gridY * tileSize;

    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    // Apply world offset directly to vertex positions for correct shader worldPos calculation
    for (let z = 0; z < resolution; z++) {
      for (let x = 0; x < resolution; x++) {
        positions.push(x * cellSize + worldOffsetX, 0, z * cellSize + worldOffsetZ);
        uvs.push(x / (resolution - 1), z / (resolution - 1));
      }
    }

    for (let z = 0; z < resolution - 1; z++) {
      for (let x = 0; x < resolution - 1; x++) {
        const topLeft = z * resolution + x;
        indices.push(topLeft, (z + 1) * resolution + x, topLeft + 1);
        indices.push(topLeft + 1, (z + 1) * resolution + x, (z + 1) * resolution + x + 1);
      }
    }

    // Use Y-up normals for flat terrain (ComputeNormals produces incorrect results)
    const normals: number[] = [];
    for (let i = 0; i < positions.length / 3; i++) {
      normals.push(0, 1, 0);
    }

    const mesh = new Mesh(`flat_grass_${gridX}_${gridY}`, this.scene);
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.uvs = uvs;
    vertexData.normals = normals;
    vertexData.applyToMesh(mesh, true);

    // Mesh position is (0,0,0) since world offset is already baked into vertex positions
    mesh.position.x = 0;
    mesh.position.z = 0;

    const splatRes = 64;
    const splatData = new Float32Array(splatRes * splatRes * 4);
    for (let i = 0; i < splatRes * splatRes; i++) {
      splatData[i * 4] = 1.0; // grass only
    }

    const material = createTerrainMaterial(this.scene, splatData, splatRes);
    material.backFaceCulling = false;
    material.setFloat("uTerrainSize", tileSize);

    const waterMask = new Uint8Array(splatRes * splatRes * 4);
    const waterTex = new RawTexture(waterMask, splatRes, splatRes, Engine.TEXTUREFORMAT_RGBA, this.scene);
    material.setTexture("uWaterMask", waterTex);

    // Sync water level with center tile
    material.setFloat("uWaterLevel", this.seaLevel);

    mesh.material = material;
    (mesh as any)._ownMaterial = true;
    mesh.isPickable = true; // Enable picking for editing
    mesh.receiveShadows = true;

    this.neighborTileMeshes.set(`${gridX},${gridY}`, mesh);
    this.createDefaultGrassFoliage(gridX, gridY, tileSize);
  }

  /**
   * Create water mesh for neighbor tile if there's water in the water mask
   */
  private createNeighborWaterMesh(
    gridX: number,
    gridY: number,
    tileSize: number,
    waterMaskData: Float32Array,
    resolution: number
  ): void {
    const key = `${gridX},${gridY}`;

    // Dispose existing water mesh
    const existingWater = this.neighborWaterMeshes.get(key);
    if (existingWater) {
      existingWater.dispose();
      this.neighborWaterMeshes.delete(key);
    }

    // Check if there's any water in this tile
    let hasWater = false;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const cellSize = tileSize / (resolution - 1);

    for (let z = 0; z < resolution; z++) {
      for (let x = 0; x < resolution; x++) {
        const waterValue = waterMaskData[z * resolution + x];
        if (waterValue > 0.3) {
          hasWater = true;
          const worldX = x * cellSize;
          const worldZ = z * cellSize;
          minX = Math.min(minX, worldX);
          maxX = Math.max(maxX, worldX);
          minZ = Math.min(minZ, worldZ);
          maxZ = Math.max(maxZ, worldZ);
        }
      }
    }

    if (!hasWater) {
      return;
    }

    // Calculate water region with padding
    const padding = 3.0;
    const waterWidth = Math.max(maxX - minX + padding * 2, 4);
    const waterDepth = Math.max(maxZ - minZ + padding * 2, 4);
    const centerX = (minX + maxX) / 2 + gridX * tileSize;
    const centerZ = (minZ + maxZ) / 2 + gridY * tileSize;

    // Get water level from biome decorator or use default
    let waterLevel = -100;
    if (this.biomeDecorator) {
      waterLevel = this.biomeDecorator.getWaterLevel();
    }
    if (waterLevel < -50) {
      waterLevel = this.seaLevel > -50 ? this.seaLevel : 0;
    }

    // Create water plane with same subdivisions as center tile
    const waterMesh = MeshBuilder.CreateGround(
      `neighbor_water_${gridX}_${gridY}`,
      {
        width: waterWidth,
        height: waterDepth,
        subdivisions: 64, // Same as WaterShader for wave deformation
        updatable: false,
      },
      this.scene
    );

    waterMesh.position.set(centerX, waterLevel, centerZ);

    // Try to use WaterShader material from center tile's BiomeDecorator
    const waterSystem = this.biomeDecorator?.getWaterSystem();
    const shaderMaterial = waterSystem?.getMaterial();

    if (shaderMaterial) {
      // Share the same shader material (waves, colors, effects all match)
      waterMesh.material = shaderMaterial;
    } else {
      // Fallback to simple water material if no WaterSystem exists yet
      const waterMaterial = new StandardMaterial(`neighbor_water_mat_${gridX}_${gridY}`, this.scene);
      waterMaterial.diffuseColor = new Color3(0.1, 0.3, 0.5);
      waterMaterial.specularColor = new Color3(0.3, 0.3, 0.3);
      waterMaterial.alpha = 0.7;
      waterMaterial.backFaceCulling = false;
      waterMesh.material = waterMaterial;
    }

    waterMesh.isPickable = false;

    this.neighborWaterMeshes.set(key, waterMesh);
    console.log(`[EditorEngine] Created water mesh for neighbor tile (${gridX},${gridY}) at level ${waterLevel}, useShader=${!!shaderMaterial}`);
  }

  /**
   * Update neighbor tile water mesh after editing
   */
  private updateNeighborWaterMesh(gridX: number, gridY: number): void {
    const key = `${gridX},${gridY}`;
    const tileData = this.editableTileData.get(key);
    if (!tileData) return;

    const tileSize = this.heightmap?.getScale() || 64;
    this.createNeighborWaterMesh(gridX, gridY, tileSize, tileData.waterMaskData, tileData.splatResolution);
  }

  /**
   * Create foliage for default tile by copying and mirroring center tile's foliage
   */
  private createDefaultTileFoliage(
    gridX: number,
    gridY: number,
    tileSize: number,
    mirrorX: boolean,
    mirrorZ: boolean
  ): void {
    if (!this.foliageSystem) {
      console.log(`[EditorEngine] No foliageSystem for default foliage`);
      return;
    }

    const gridKey = `${gridX},${gridY}`;
    const foliageMeshes: Mesh[] = [];
    const offsetX = gridX * tileSize;
    const offsetZ = gridY * tileSize;

    // Get foliage data from center tile
    const centerFoliageData = this.foliageSystem.exportTileData();
    if (!centerFoliageData || Object.keys(centerFoliageData).length === 0) {
      console.log(`[EditorEngine] No center foliage data, creating random foliage`);
      this.createDefaultGrassFoliage(gridX, gridY, tileSize);
      return;
    }

    let totalInstances = 0;

    for (const [typeName, base64] of Object.entries(centerFoliageData)) {
      const baseMesh = this.foliageSystem.getBaseMesh(typeName);
      if (!baseMesh) continue;

      // Decode matrices from center tile
      const sourceMatrices = this.decodeFloat32Array(base64);
      if (sourceMatrices.length === 0) continue;

      const instanceCount = sourceMatrices.length / 16;
      const matrices = new Float32Array(sourceMatrices.length);

      // Copy and transform matrices with mirroring
      for (let i = 0; i < instanceCount; i++) {
        const srcIdx = i * 16;

        // Copy matrix
        for (let j = 0; j < 16; j++) {
          matrices[srcIdx + j] = sourceMatrices[srcIdx + j];
        }

        // Get position from matrix
        let x = sourceMatrices[srcIdx + 12];
        let z = sourceMatrices[srcIdx + 14];

        // Apply mirroring
        if (mirrorX) x = tileSize - x;
        if (mirrorZ) z = tileSize - z;

        // Apply offset
        matrices[srcIdx + 12] = x + offsetX;
        matrices[srcIdx + 14] = z + offsetZ;
      }

      // Create mesh
      const neighborMesh = new Mesh(`default_foliage_${gridX}_${gridY}_${typeName}`, this.scene);

      const positions = baseMesh.getVerticesData(VertexBuffer.PositionKind);
      const normals = baseMesh.getVerticesData(VertexBuffer.NormalKind);
      const colors = baseMesh.getVerticesData(VertexBuffer.ColorKind);
      const uvs = baseMesh.getVerticesData(VertexBuffer.UVKind);
      const indices = baseMesh.getIndices();

      if (positions && indices) {
        const vertexData = new VertexData();
        vertexData.positions = new Float32Array(positions);
        if (normals) vertexData.normals = new Float32Array(normals);
        if (colors) vertexData.colors = new Float32Array(colors);
        if (uvs) vertexData.uvs = new Float32Array(uvs);
        vertexData.indices = new Uint32Array(indices);
        vertexData.applyToMesh(neighborMesh);
      }

      neighborMesh.material = baseMesh.material;
      neighborMesh.isVisible = true;
      neighborMesh.isPickable = false;

      neighborMesh.thinInstanceSetBuffer("matrix", matrices, 16, false);
      neighborMesh.thinInstanceCount = instanceCount;
      neighborMesh.thinInstanceRefreshBoundingInfo();

      foliageMeshes.push(neighborMesh);
      totalInstances += instanceCount;
    }

    if (foliageMeshes.length > 0) {
      this.neighborFoliageMeshes.set(gridKey, foliageMeshes);
      console.log(`[EditorEngine] Created mirrored foliage for (${gridX},${gridY}): ${totalInstances} instances`);
    }
  }

  /**
   * Create simple random grass foliage (fallback)
   */
  private createDefaultGrassFoliage(gridX: number, gridY: number, tileSize: number): void {
    if (!this.foliageSystem) return;

    const gridKey = `${gridX},${gridY}`;
    const foliageMeshes: Mesh[] = [];
    const offsetX = gridX * tileSize;
    const offsetZ = gridY * tileSize;

    const baseMesh = this.foliageSystem.getBaseMesh("grass");
    if (!baseMesh) return;

    const instanceCount = 800;
    const matrices = new Float32Array(instanceCount * 16);

    for (let i = 0; i < instanceCount; i++) {
      const x = Math.random() * tileSize + offsetX;
      const z = Math.random() * tileSize + offsetZ;
      const scale = 0.8 + Math.random() * 0.4;
      const rotation = Math.random() * Math.PI * 2;
      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);
      const idx = i * 16;

      matrices[idx + 0] = cos * scale;
      matrices[idx + 1] = 0;
      matrices[idx + 2] = sin * scale;
      matrices[idx + 3] = 0;
      matrices[idx + 4] = 0;
      matrices[idx + 5] = scale;
      matrices[idx + 6] = 0;
      matrices[idx + 7] = 0;
      matrices[idx + 8] = -sin * scale;
      matrices[idx + 9] = 0;
      matrices[idx + 10] = cos * scale;
      matrices[idx + 11] = 0;
      matrices[idx + 12] = x;
      matrices[idx + 13] = 0;
      matrices[idx + 14] = z;
      matrices[idx + 15] = 1;
    }

    const neighborMesh = new Mesh(`default_foliage_${gridX}_${gridY}_grass`, this.scene);
    const positions = baseMesh.getVerticesData(VertexBuffer.PositionKind);
    const normals = baseMesh.getVerticesData(VertexBuffer.NormalKind);
    const colors = baseMesh.getVerticesData(VertexBuffer.ColorKind);
    const uvs = baseMesh.getVerticesData(VertexBuffer.UVKind);
    const indices = baseMesh.getIndices();

    if (positions && indices) {
      const vertexData = new VertexData();
      vertexData.positions = new Float32Array(positions);
      if (normals) vertexData.normals = new Float32Array(normals);
      if (colors) vertexData.colors = new Float32Array(colors);
      if (uvs) vertexData.uvs = new Float32Array(uvs);
      vertexData.indices = new Uint32Array(indices);
      vertexData.applyToMesh(neighborMesh);
    }

    neighborMesh.material = baseMesh.material;
    neighborMesh.isVisible = true;
    neighborMesh.isPickable = false;
    neighborMesh.thinInstanceSetBuffer("matrix", matrices, 16, false);
    neighborMesh.thinInstanceCount = instanceCount;
    neighborMesh.thinInstanceRefreshBoundingInfo();

    foliageMeshes.push(neighborMesh);
    this.neighborFoliageMeshes.set(gridKey, foliageMeshes);
  }

  /**
   * Create a mirrored copy of the current terrain for empty grid positions
   * @deprecated Use createDefaultGrassTilePreview instead
   */
  private createMirroredCurrentTilePreview(gridX: number, gridY: number, tileSize: number): void {
    console.log(`[EditorEngine] createMirroredCurrentTilePreview START: (${gridX},${gridY}), tileSize=${tileSize}`);

    if (!this.terrainMesh) {
      console.log(`[EditorEngine] createMirroredCurrentTilePreview: no terrainMesh`);
      return;
    }

    const sourceMesh = this.terrainMesh.getMesh();
    if (!sourceMesh) {
      console.log(`[EditorEngine] createMirroredCurrentTilePreview: no sourceMesh from terrainMesh.getMesh()`);
      return;
    }

    console.log(`[EditorEngine] Source mesh: name=${sourceMesh.name}, isVisible=${sourceMesh.isVisible}`);

    // Clone the current terrain mesh
    const clone = sourceMesh.clone(`mirrored_${gridX}_${gridY}`);
    if (!clone) {
      console.log(`[EditorEngine] createMirroredCurrentTilePreview: clone failed`);
      return;
    }

    // Mirror on odd coordinates for seamless tiling
    const mirrorX = gridX % 2 !== 0;
    const mirrorZ = gridY % 2 !== 0;
    const scaleX = mirrorX ? -1 : 1;
    const scaleZ = mirrorZ ? -1 : 1;
    clone.scaling = new Vector3(scaleX, 1, scaleZ);

    // Position calculation (same as GamePreview)
    const posX = mirrorX ? (gridX + 1) * tileSize : gridX * tileSize;
    const posZ = mirrorZ ? (gridY + 1) * tileSize : gridY * tileSize;
    clone.position = new Vector3(posX, 0, posZ);

    // Share material with original (same textures)
    clone.material = sourceMesh.material;

    // Ensure backface culling is off for mirrored tiles
    if (clone.material && "backFaceCulling" in clone.material) {
      (clone.material as StandardMaterial).backFaceCulling = false;
    }

    clone.isPickable = false;
    clone.receiveShadows = true;
    clone.isVisible = true; // Explicitly set visible
    clone.refreshBoundingInfo();

    console.log(`[EditorEngine] SUCCESS: Created mirrored tile at (${gridX},${gridY}), pos=(${posX},${posZ}), mirror=(${mirrorX},${mirrorZ}), isVisible=${clone.isVisible}`);

    this.neighborTileMeshes.set(`${gridX},${gridY}`, clone);
  }

  /**
   * Create a preview mesh from heightmap data
   */
  private createPreviewMeshFromHeightmap(
    name: string,
    heightmapData: Float32Array,
    sourceRes: number,
    targetRes: number,
    size: number
  ): Mesh | null {
    console.log(`[EditorEngine] createPreviewMeshFromHeightmap: name=${name}, sourceRes=${sourceRes}, targetRes=${targetRes}, size=${size}, heightmapLength=${heightmapData.length}`);

    if (!heightmapData || heightmapData.length === 0) {
      console.error(`[EditorEngine] Invalid heightmap data for ${name}`);
      return null;
    }

    const sourceResPlus1 = sourceRes + 1;
    const targetResPlus1 = targetRes + 1;

    // Sample heightmap at lower resolution
    const positions: number[] = [];
    const indices: number[] = [];
    const normals: number[] = [];
    const step = size / targetRes;
    const sampleStep = sourceRes / targetRes;

    let minHeight = Infinity, maxHeight = -Infinity;

    for (let z = 0; z <= targetRes; z++) {
      for (let x = 0; x <= targetRes; x++) {
        // Sample from original heightmap
        const srcX = Math.min(Math.floor(x * sampleStep), sourceRes);
        const srcZ = Math.min(Math.floor(z * sampleStep), sourceRes);
        const idx = srcZ * sourceResPlus1 + srcX;
        const height = (idx < heightmapData.length) ? (heightmapData[idx] || 0) : 0;

        minHeight = Math.min(minHeight, height);
        maxHeight = Math.max(maxHeight, height);

        positions.push(x * step, height, z * step);
      }
    }

    console.log(`[EditorEngine] ${name}: vertices=${positions.length / 3}, heightRange=[${minHeight.toFixed(2)}, ${maxHeight.toFixed(2)}]`);

    // Create indices
    for (let z = 0; z < targetRes; z++) {
      for (let x = 0; x < targetRes; x++) {
        const topLeft = z * targetResPlus1 + x;
        const topRight = topLeft + 1;
        const bottomLeft = (z + 1) * targetResPlus1 + x;
        const bottomRight = bottomLeft + 1;

        indices.push(topLeft, bottomLeft, topRight);
        indices.push(topRight, bottomLeft, bottomRight);
      }
    }

    console.log(`[EditorEngine] ${name}: indices=${indices.length}`);

    try {
      const mesh = new Mesh(name, this.scene);
      const vertexData = new VertexData();
      vertexData.positions = positions;
      vertexData.indices = indices;

      // Use Y-up normals for flat terrain (ComputeNormals produces incorrect results)
      for (let i = 0; i < positions.length / 3; i++) {
        normals.push(0, 1, 0);
      }
      vertexData.normals = normals;

      vertexData.applyToMesh(mesh);

      // Force update bounding info
      mesh.refreshBoundingInfo();
      const bb = mesh.getBoundingInfo().boundingBox;
      console.log(`[EditorEngine] ${name}: boundingBox min=(${bb.minimumWorld.x.toFixed(1)}, ${bb.minimumWorld.y.toFixed(1)}, ${bb.minimumWorld.z.toFixed(1)}) max=(${bb.maximumWorld.x.toFixed(1)}, ${bb.maximumWorld.y.toFixed(1)}, ${bb.maximumWorld.z.toFixed(1)})`);

      return mesh;
    } catch (error) {
      console.error(`[EditorEngine] Failed to create mesh ${name}:`, error);
      return null;
    }
  }

  /**
   * Clear all neighboring tile preview meshes
   */
  private clearNeighborTilePreviews(): void {
    // Clear terrain meshes
    for (const mesh of this.neighborTileMeshes.values()) {
      // Dispose material only if it's owned by this mesh (not shared)
      if ((mesh as any)._ownMaterial && mesh.material) {
        mesh.material.dispose();
      }
      mesh.dispose();
    }
    this.neighborTileMeshes.clear();

    // Clear foliage meshes
    for (const meshes of this.neighborFoliageMeshes.values()) {
      for (const mesh of meshes) {
        // Foliage meshes share material with base meshes, don't dispose material
        mesh.dispose();
      }
    }
    this.neighborFoliageMeshes.clear();

    // Clear water meshes (don't dispose shared shader material)
    for (const mesh of this.neighborWaterMeshes.values()) {
      // Only dispose material if it's a StandardMaterial (fallback), not shared ShaderMaterial
      if (mesh.material && mesh.material instanceof StandardMaterial) {
        mesh.material.dispose();
      }
      mesh.dispose();
    }
    this.neighborWaterMeshes.clear();
  }

  // ============================================================================
  // STREAMING CALLBACKS
  // ============================================================================

  /**
   * StreamingManager callback: Cell 로드 요청
   * 해당 Cell에 속한 Tile들을 로드
   */
  private async handleStreamingLoadCell(cellX: number, cellZ: number, lod: StreamingLOD): Promise<void> {
    if (!this.cellManager) return;

    const tile = this.cellManager.cellToTile(cellX, cellZ);
    const tileKey = this.cellManager.getTileKey(tile.gridX, tile.gridY);

    console.log(`[EditorEngine] Streaming load cell (${cellX},${cellZ}) -> tile (${tile.gridX},${tile.gridY}), LOD=${StreamingLOD[lod]}`);

    // Skip center tile (0,0) - always loaded
    if (tile.gridX === 0 && tile.gridY === 0) {
      return;
    }

    // Check if tile is already loaded
    if (this.neighborTileMeshes.has(tileKey)) {
      console.log(`[EditorEngine] Tile ${tileKey} already loaded, skipping`);
      return;
    }

    // Load tile data from ManualTileManager or create default
    // TODO: Phase 2 - implement proper tile loading
    // For now, use existing neighbor tile loading logic
    const tileSize = this.heightmap?.getScale() || 64;

    // Check if tile data exists in manual placements
    const tileManager = getManualTileManager();
    const worldConfig = await tileManager.getWorldConfig();
    const placement = worldConfig?.manualPlacements?.find(
      (p: TilePlacement) => p.gridX === tile.gridX && p.gridY === tile.gridY
    );

    if (placement) {
      // Load existing tile from manual placement
      this.createNeighborTilePreview(tile.gridX, tile.gridY, placement.tileId, tileSize);
    } else {
      // Create default tile (mirrored or flat grass)
      this.createDefaultGrassTilePreview(tile.gridX, tile.gridY, tileSize);
    }

    // Load foliage for Near LOD cells only
    if (lod === StreamingLOD.Near && this.foliageSystem) {
      this.foliageSystem.generateCell(cellX, cellZ);
    }
  }

  /**
   * StreamingManager callback: Cell 언로드 요청
   * 해당 Cell에 속한 Tile들을 언로드
   */
  private async handleStreamingUnloadCell(cellX: number, cellZ: number): Promise<void> {
    if (!this.cellManager) return;

    const tile = this.cellManager.cellToTile(cellX, cellZ);
    const tileKey = this.cellManager.getTileKey(tile.gridX, tile.gridY);

    console.log(`[EditorEngine] Streaming unload cell (${cellX},${cellZ}) -> tile (${tile.gridX},${tile.gridY})`);

    // Skip center tile (0,0) - always loaded
    if (tile.gridX === 0 && tile.gridY === 0) {
      return;
    }

    // Auto-save dirty tile before unload
    if (this.isTileDirty(tile.gridX, tile.gridY)) {
      await this.autoSaveTileBeforeUnload(tile.gridX, tile.gridY);
    }

    // Update tile loading state
    this.tileLoadingState.delete(tileKey);

    // Dispose tile mesh
    const tileMesh = this.neighborTileMeshes.get(tileKey);
    if (tileMesh) {
      if (tileMesh.material) {
        tileMesh.material.dispose();
      }
      tileMesh.dispose();
      this.neighborTileMeshes.delete(tileKey);
    }

    // Dispose foliage meshes
    const foliageMeshes = this.neighborFoliageMeshes.get(tileKey);
    if (foliageMeshes) {
      for (const mesh of foliageMeshes) {
        // Don't dispose shared material
        mesh.dispose();
      }
      this.neighborFoliageMeshes.delete(tileKey);
    }

    // Dispose water mesh
    const waterMesh = this.neighborWaterMeshes.get(tileKey);
    if (waterMesh) {
      if (waterMesh.material && waterMesh.material instanceof StandardMaterial) {
        waterMesh.material.dispose();
      }
      waterMesh.dispose();
      this.neighborWaterMeshes.delete(tileKey);
    }

    // Clear editable tile data
    this.editableTileData.delete(tileKey);

    // Unload foliage cell
    if (this.foliageSystem) {
      this.foliageSystem.unloadCell(cellX, cellZ);
    }

    // Unload props for this tile
    if (this.propManager) {
      this.propManager.unloadPropsForTile(tile.gridX, tile.gridY);
    }
  }

  /**
   * StreamingManager callback: Cell LOD 업데이트
   * Foliage 밀도 조절 등
   */
  private handleStreamingUpdateCellLOD(cellX: number, cellZ: number, lod: StreamingLOD): void {
    if (!this.cellManager) return;

    const tile = this.cellManager.cellToTile(cellX, cellZ);

    console.log(`[EditorEngine] Streaming update LOD cell (${cellX},${cellZ}) -> tile (${tile.gridX},${tile.gridY}), LOD=${StreamingLOD[lod]}`);

    // Map StreamingLOD to FoliageLOD
    const foliageLOD = this.mapToFoliageLOD(lod);
    const propLOD = this.mapToPropLOD(lod);

    // LOD-based foliage management with density control
    if (this.foliageSystem) {
      if (lod === StreamingLOD.Far) {
        // Unload foliage for Far cells (save memory)
        if (this.foliageSystem.isCellLoaded(cellX, cellZ)) {
          this.foliageSystem.unloadCell(cellX, cellZ);
        }
      } else {
        // Near/Mid: load or update density
        if (!this.foliageSystem.isCellLoaded(cellX, cellZ)) {
          this.foliageSystem.generateCell(cellX, cellZ);
        }
        // Update LOD density (Near: 100%, Mid: 50%)
        this.foliageSystem.updateCellLOD(cellX, cellZ, foliageLOD);
      }
    }

    // LOD-based prop visibility
    if (this.propManager) {
      this.propManager.updateTileLOD(tile.gridX, tile.gridY, propLOD);
    }
  }

  /**
   * Map StreamingLOD to FoliageLOD
   */
  private mapToFoliageLOD(streamingLOD: StreamingLOD): FoliageLOD {
    switch (streamingLOD) {
      case StreamingLOD.Near:
        return FoliageLOD.Near;
      case StreamingLOD.Mid:
        return FoliageLOD.Mid;
      case StreamingLOD.Far:
        return FoliageLOD.Far;
      default:
        return FoliageLOD.Near;
    }
  }

  /**
   * Map StreamingLOD to PropLOD
   */
  private mapToPropLOD(streamingLOD: StreamingLOD): PropLOD {
    switch (streamingLOD) {
      case StreamingLOD.Near:
        return PropLOD.Near;
      case StreamingLOD.Mid:
        return PropLOD.Mid;
      case StreamingLOD.Far:
        return PropLOD.Far;
      default:
        return PropLOD.Near;
    }
  }

  /**
   * Enable streaming mode (usually for game preview)
   */
  enableStreaming(): void {
    if (this.streamingManager) {
      this.streamingEnabled = true;
      this.streamingManager.setEnabled(true);
      console.log("[EditorEngine] Streaming enabled");
    }
  }

  /**
   * Disable streaming mode (return to editor mode)
   */
  disableStreaming(): void {
    if (this.streamingManager) {
      this.streamingEnabled = false;
      this.streamingManager.setEnabled(false);
      console.log("[EditorEngine] Streaming disabled");
    }
  }

  /**
   * Protect a cell from being unloaded during editing
   * Also protects adjacent cells to ensure edge syncing works
   */
  private protectCellForEditing(cellX: number, cellZ: number): void {
    if (!this.streamingManager || !this.cellManager) return;

    const key = this.cellManager.getCellKey(cellX, cellZ);

    // Skip if already protected
    if (this.editingCells.has(key)) return;

    // Protect this cell
    this.streamingManager.protectCell(cellX, cellZ);
    this.editingCells.add(key);

    // Protect adjacent cells (for edge syncing)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dz === 0) continue;
        const adjKey = this.cellManager.getCellKey(cellX + dx, cellZ + dz);
        if (!this.editingCells.has(adjKey)) {
          this.streamingManager.protectCell(cellX + dx, cellZ + dz);
          this.editingCells.add(adjKey);
        }
      }
    }
  }

  /**
   * Release edit protection for all cells (called on pointer up)
   */
  private releaseEditProtection(): void {
    if (!this.streamingManager || !this.cellManager) return;

    for (const key of this.editingCells) {
      const [x, z] = key.split('_').map(Number);
      this.streamingManager.unprotectCell(x, z);
    }
    this.editingCells.clear();
  }

  /**
   * Get streaming status
   */
  isStreamingEnabled(): boolean {
    return this.streamingEnabled;
  }

  /**
   * Get CellManager for external use
   */
  getCellManager(): CellManager | null {
    return this.cellManager;
  }

  /**
   * Get StreamingManager for external use
   */
  getStreamingManager(): StreamingManager | null {
    return this.streamingManager;
  }

  // ============================================================================
  // TILE DIRTY FLAG MANAGEMENT
  // ============================================================================

  /**
   * Mark a tile as dirty (needs saving)
   */
  private markTileDirty(gridX: number, gridY: number, type: 'heightmap' | 'splatmap' | 'foliage' | 'water'): void {
    const key = `${gridX}_${gridY}`;
    let flags = this.tileDirtyFlags.get(key);

    if (!flags) {
      flags = {
        heightmapDirty: false,
        splatmapDirty: false,
        foliageDirty: false,
        waterDirty: false,
        lastModified: Date.now(),
      };
      this.tileDirtyFlags.set(key, flags);
    }

    switch (type) {
      case 'heightmap':
        flags.heightmapDirty = true;
        break;
      case 'splatmap':
        flags.splatmapDirty = true;
        break;
      case 'foliage':
        flags.foliageDirty = true;
        break;
      case 'water':
        flags.waterDirty = true;
        break;
    }

    flags.lastModified = Date.now();
  }

  /**
   * Check if a tile has any unsaved changes
   */
  private isTileDirty(gridX: number, gridY: number): boolean {
    const key = `${gridX}_${gridY}`;
    const flags = this.tileDirtyFlags.get(key);
    if (!flags) return false;
    return flags.heightmapDirty || flags.splatmapDirty || flags.foliageDirty || flags.waterDirty;
  }

  /**
   * Clear dirty flags for a tile (after saving)
   */
  private clearTileDirtyFlags(gridX: number, gridY: number): void {
    const key = `${gridX}_${gridY}`;
    this.tileDirtyFlags.delete(key);
  }

  /**
   * Get dirty flags for a tile
   */
  getTileDirtyFlags(gridX: number, gridY: number): {
    heightmapDirty: boolean;
    splatmapDirty: boolean;
    foliageDirty: boolean;
    waterDirty: boolean;
    lastModified: number;
  } | null {
    const key = `${gridX}_${gridY}`;
    return this.tileDirtyFlags.get(key) || null;
  }

  /**
   * Get all dirty tiles
   */
  getAllDirtyTiles(): Array<{
    gridX: number;
    gridY: number;
    flags: {
      heightmapDirty: boolean;
      splatmapDirty: boolean;
      foliageDirty: boolean;
      waterDirty: boolean;
      lastModified: number;
    };
  }> {
    const result: Array<{
      gridX: number;
      gridY: number;
      flags: {
        heightmapDirty: boolean;
        splatmapDirty: boolean;
        foliageDirty: boolean;
        waterDirty: boolean;
        lastModified: number;
      };
    }> = [];

    for (const [key, flags] of this.tileDirtyFlags.entries()) {
      if (flags.heightmapDirty || flags.splatmapDirty || flags.foliageDirty || flags.waterDirty) {
        const [gridX, gridY] = key.split('_').map(Number);
        result.push({ gridX, gridY, flags });
      }
    }

    return result;
  }

  /**
   * Auto-save a dirty tile before unload
   */
  private async autoSaveTileBeforeUnload(gridX: number, gridY: number): Promise<boolean> {
    const key = `${gridX}_${gridY}`;
    const flags = this.tileDirtyFlags.get(key);

    if (!flags || !this.isTileDirty(gridX, gridY)) {
      return true; // Nothing to save
    }

    console.log(`[EditorEngine] Auto-saving dirty tile (${gridX},${gridY}) before unload...`);

    try {
      const tileData = this.editableTileData.get(key);
      if (!tileData) {
        console.warn(`[EditorEngine] No editable data for tile (${gridX},${gridY}), skipping auto-save`);
        return true;
      }

      // Get the tile manager
      const tileManager = getManualTileManager();

      // Create a tile ID for this position (or find existing)
      const tileId = `autosave_${gridX}_${gridY}_${Date.now()}`;

      // Get foliage data if available
      let foliageData: Record<string, string> | undefined;
      const foliageMeshes = this.neighborFoliageMeshes.get(key);
      if (foliageMeshes && this.foliageSystem) {
        foliageData = this.foliageSystem.exportTileData();
      }

      // Save the tile using saveTileFromCurrent
      tileManager.saveTileFromCurrent(
        `Auto-save (${gridX},${gridY})`,
        tileData.heightmapData,
        tileData.splatmapData,
        tileData.waterMaskData,
        tileData.resolution,
        this.heightmap?.getScale() || 64,
        this.seaLevel,
        this.waterDepth,
        tileId,  // existing ID
        foliageData
      );

      // Update world config to track this placement
      tileManager.setPlacement(gridX, gridY, tileId);

      // Clear dirty flags after successful save
      this.clearTileDirtyFlags(gridX, gridY);

      console.log(`[EditorEngine] Auto-saved tile (${gridX},${gridY}) as ${tileId}`);
      return true;
    } catch (error) {
      console.error(`[EditorEngine] Failed to auto-save tile (${gridX},${gridY}):`, error);
      return false;
    }
  }

  /**
   * Decode Base64 to Float32Array (utility method)
   */
  private decodeFloat32Array(base64: string): Float32Array {
    const binary = atob(base64);
    const uint8 = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      uint8[i] = binary.charCodeAt(i);
    }
    return new Float32Array(uint8.buffer);
  }

  dispose(): void {
    if (this.isGameMode) {
      this.exitGameMode();
    }
    // Clear neighbor tile previews
    this.clearNeighborTilePreviews();

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
