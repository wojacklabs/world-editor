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
  ShaderMaterial,
  PickingInfo,
  IKeyboardEvent,
} from "@babylonjs/core";
import { GridMaterial } from "@babylonjs/materials";
import type { BrushSettings, ToolType, HeightmapTool, MaterialType } from "../types/EditorTypes";
import { Heightmap } from "../terrain/Heightmap";
import { TerrainMesh } from "../terrain/TerrainMesh";
import { SplatMap } from "../terrain/SplatMap";
import { BiomeDecorator } from "../terrain/BiomeDecorator";
import { GamePreview, TileMode } from "./GamePreview";
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
  private streamingEnabled = false;  // Disabled by default for editor mode

  // Game preview
  private gamePreview: GamePreview | null = null;
  private isGameMode = false;
  private savedClearColor: Color4 | null = null;
  private tileMode: TileMode = "mirror"; // Default to mirror mode

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
      // Update terrain shader uniforms for water effects
      if (this.terrainMesh) {
        const material = this.terrainMesh.getMaterial() as ShaderMaterial | null;
        if (material && material.setFloat) {
          const time = (performance.now() / 1000) - startTime;
          material.setFloat("uWaterLevel", this.seaLevel);
          material.setFloat("uTime", time);
        }
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
      // Terrain height change affects foliage placement
      this.foliageDirty = true;
      this.biomeDirty = true;
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

    // For water, auto-set seaLevel if not already set, then carve basin and paint shore
    if (material === "water" && modified) {
      // Auto-set seaLevel to slightly below terrain height so water pools in carved area
      if (this.seaLevel < -50) {
        const terrainHeight = point.y;
        // Set water level below surface so it sits in the carved basin
        const waterSurfaceOffset = this.waterDepth * 0.8; // Water level well below surface
        this.setSeaLevel(terrainHeight - waterSurfaceOffset);
        console.log(`[EditorEngine] Auto-set seaLevel to ${terrainHeight - waterSurfaceOffset} (terrain: ${terrainHeight})`);
      }
      this.carveWaterBasin(point.x, point.z, settings);
      this.paintShoreTexture(point.x, point.z, settings.size);
      // Update water mask texture for shader
      this.terrainMesh.updateWaterMaskTexture();
    }

    if (modified) {
      this.terrainMesh.updateSplatTexture();
      this.biomeDirty = true; // Mark for decoration rebuild on pointer up
      this.foliageDirty = true; // Mark foliage for rebuild on pointer up
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

    // Create and enable game preview with foliage and water systems
    this.gamePreview = new GamePreview(
      this.scene,
      this.heightmap,
      this.terrainMesh,
      this.foliageSystem,
      this.biomeDecorator,
      this.tileMode
    );
    this.gamePreview.enable(mesh);

    // Enable debug visualization for tile boundaries
    this.gamePreview.setDebugEnabled(true);

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
  } | null {
    if (!this.heightmap || !this.terrainMesh) return null;

    const splatMap = this.terrainMesh.getSplatMap();

    return {
      heightmapData: new Float32Array(this.heightmap.getData()),
      splatmapData: new Float32Array(splatMap.getData()),
      waterMaskData: new Float32Array(splatMap.getWaterMask()),
      resolution: this.heightmap.getResolution() - 1, // Convert back to segment count
      size: this.heightmap.getScale(),
      seaLevel: this.seaLevel,
      waterDepth: this.waterDepth,
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
    waterDepth: number
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
    this.foliageSystem.generateAll();

    // Initialize impostor system
    this.impostorSystem = new ImpostorSystem(this.scene);

    // Initialize prop manager
    if (this.propManager) {
      this.propManager.dispose();
    }
    this.propManager = new PropManager(this.scene, this.heightmap);

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
