import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from "three-mesh-bvh";
import { disposeMesh } from "../../shared/rendering/threeHelpers";

// Extend Three.js prototypes for BVH-accelerated raycasting
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;
import type {
  BrushSettings,
  HanokPlanPreset,
  HeightmapTool,
  MaterialType,
  ProceduralAssetType,
  WaterType,
  WeatherPreset,
  WeatherState,
} from "../types/EditorTypes";
import { Heightmap } from "../terrain/Heightmap";
import { TerrainMesh } from "../terrain/TerrainMesh";
import { BiomeDecorator } from "../terrain/BiomeDecorator";
import { GamePreview } from "./GamePreview";
import { PropManager } from "../props/PropManager";
import type { SerializedProceduralPropInstance } from "../props/PropManager";
import { FoliageSystem } from "../foliage/FoliageSystem";
import { ImpostorSystem } from "../foliage/ImpostorSystem";
import { initializeKTX2Support } from "./KTX2Setup";
import { StreamingManager } from "../streaming/StreamingManager";
import { AssetContainerPool } from "../streaming/AssetContainerPool";
import { SkyWeatherSystem } from "../weather/SkyWeatherSystem";
import { UndoManager } from "./UndoManager";
import { LightManager } from "../lighting/LightManager";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { VolumetricFogPass } from "../weather/VolumetricFogPass";

export class EditorEngine {
  private canvas: HTMLCanvasElement;
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private controls: OrbitControls | null = null;
  private gridMesh: THREE.GridHelper | null = null;
  private resizeObserver: ResizeObserver | null = null;

  // Terrain
  private heightmap: Heightmap | null = null;
  private terrainMesh: TerrainMesh | null = null;

  // Brush preview
  private brushPreview: THREE.Mesh | null = null;

  // Props
  private propManager: PropManager | null = null;

  // Biome decorations
  private biomeDecorator: BiomeDecorator | null = null;
  private biomeDirty = false;

  // Water system
  private seaLevel: number = -100;  // Default below terrain, set properly when water is activated
  private waterDepth: number = 2.0;  // How deep water carves into terrain
  private waterType: WaterType = "lake";
  private waterFlowAngle: number = 0;  // degrees 0-360
  private waterDirectionIndicator: THREE.Mesh | null = null;

  // Foliage system (Thin Instance based)
  private foliageSystem: FoliageSystem | null = null;
  private foliageDirty = false;
  private windTextureWired = false;
  private propsDirty = false;

  // Impostor system (Billboard LOD)
  private impostorSystem: ImpostorSystem | null = null;

  // Streaming system
  private streamingManager: StreamingManager | null = null;
  private assetPool: AssetContainerPool | null = null;

  // Game preview
  private gamePreview: GamePreview | null = null;
  private isGameMode = false;
  private savedClearColor: THREE.Color | null = null;
  private gamePointerBlocker: ((e: PointerEvent) => void) | null = null;

  // Sky and weather system
  private skyWeatherSystem: SkyWeatherSystem | null = null;

  // Undo/Redo
  private undoManager = new UndoManager(20);
  private snapshotPushedForStroke = false;

  // Multi-tile grid
  private currentGridX: number = 0;
  private currentGridZ: number = 0;
  private neighborMeshes: Map<string, THREE.Mesh> = new Map(); // "gridX_gridZ" -> mesh

  // Multi-light system
  private lightManager = new LightManager();

  // Post-processing
  private composer: EffectComposer | null = null;
  private renderPass: RenderPass | null = null;
  private volumetricFogPass: VolumetricFogPass | null = null;

  // Callbacks
  private onModified: (() => void) | null = null;
  private onGameModeChange: ((isGameMode: boolean) => void) | null = null;

  // State
  private isInitialized = false;
  private isPointerDown = false;
  private currentPickPoint: THREE.Vector3 | null = null;
  private currentPickHit: boolean = false;
  private lastPointerX: number = 0;
  private lastPointerY: number = 0;

  // Raycasting
  private raycaster: THREE.Raycaster = new THREE.Raycaster();
  private readonly _ndcVec = new THREE.Vector2();

  // Prop selection highlight
  private selectionHelper: THREE.Box3Helper | null = null;

  // Render loop
  private animationFrameId: number = 0;
  private lastFrameTime: number = 0;
  private frameCount: number = 0;
  private fps: number = 0;
  private fpsAccumulator: number = 0;

  // Camera animation state
  private cameraAnimation: {
    startPosition: THREE.Vector3;
    endPosition: THREE.Vector3;
    startTarget: THREE.Vector3;
    endTarget: THREE.Vector3;
    startTime: number;
    duration: number;
  } | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  async init(): Promise<void> {
    // Initialize KTX2 texture support
    await initializeKTX2Support();

    // Create WebGL renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      stencil: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(this.canvas.clientWidth, this.canvas.clientHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ReinhardToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    // Enable shadow mapping
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    console.log("[EditorEngine] Using WebGL renderer with PCFSoftShadowMap");

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0.08, 0.08, 0.1);
    // Scene fog for PBR materials (CSM tree/bush). Matches custom shader fog (color=0.6,0.75,0.9 density=0.008).
    this.scene.fog = new THREE.FogExp2(new THREE.Color(0.6, 0.75, 0.9), 0.008);

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
    this.lastFrameTime = performance.now();
    const animate = () => {
      this.animationFrameId = requestAnimationFrame(animate);
      const now = performance.now();
      const time = (now / 1000) - startTime;

      // FPS calculation
      this.frameCount++;
      this.fpsAccumulator += now - this.lastFrameTime;
      this.lastFrameTime = now;
      if (this.fpsAccumulator >= 1000) {
        this.fps = this.frameCount;
        this.frameCount = 0;
        this.fpsAccumulator -= 1000;
      }

      // Update terrain shader uniforms for water effects + LOD
      if (this.terrainMesh) {
        const material = this.terrainMesh.getMaterial() as THREE.ShaderMaterial | null;
        if (material && material.uniforms) {
          material.uniforms.uWaterLevel.value = this.seaLevel;
          material.uniforms.uTime.value = time;
        }
        this.terrainMesh.updateLOD(this.isGameMode && this.gamePreview ? this.gamePreview.getCamera()! : this.camera);
      }

      // Update foliage in editor mode (visibility culling + LOD + wind animation)
      if (this.foliageSystem && !this.isGameMode) {
        const cameraPos = this.camera.position;
        this.foliageSystem.updateVisibility(cameraPos);
        this.foliageSystem.updateCameraPosition(cameraPos);
        this.foliageSystem.updateTime(performance.now() / 1000);
      }

      // Update prop wind animation
      if (this.propManager) {
        this.propManager.update(this.camera);
      }

      // Update point lights
      this.lightManager.updateCamera(this.camera.position);
      this.lightManager.update();
      // Apply light uniforms to terrain material
      if (this.terrainMesh) {
        const terrainMat = this.terrainMesh.getMaterial() as THREE.ShaderMaterial | null;
        if (terrainMat) this.lightManager.applyToMaterial(terrainMat);
      }

      // Update water animation
      const waterSystem = this.biomeDecorator?.getWaterSystem();
      if (waterSystem) {
        waterSystem.update(performance.now() / 1000);

        // Wire wind texture from foliage to water (once)
        if (!this.windTextureWired && this.foliageSystem) {
          const windTex = this.foliageSystem.getWindNoiseTexture();
          if (windTex) {
            waterSystem.setWindTexture(windTex);
            this.windTextureWired = true;
          }
        }
      }

      // Game mode: update GamePreview and render with its camera
      if (this.isGameMode && this.gamePreview) {
        const deltaTime = 1 / 60; // Approximate delta
        this.gamePreview.update(deltaTime);

        // Update sky weather AFTER camera moves (so sky sphere follows game camera)
        if (this.skyWeatherSystem) {
          this.skyWeatherSystem.update();
        }

        const gameCamera = this.gamePreview.getCamera();

        // Sync volumetric fog with weather and camera
        if (this.volumetricFogPass && this.skyWeatherSystem) {
          const cam = gameCamera || this.camera;
          this.volumetricFogPass.updateCamera(cam);
          this.volumetricFogPass.syncWeather(
            this.skyWeatherSystem.getFogColor(),
            this.skyWeatherSystem.getFogDensity(),
            this.skyWeatherSystem.getSunDirection(),
            this.skyWeatherSystem.getSunColor()
          );
        }

        if (gameCamera && this.composer && this.renderPass) {
          this.renderPass.camera = gameCamera;
          this.composer.render();
        } else if (gameCamera) {
          this.renderer.render(this.scene, gameCamera);
        }
      } else {
        // Editor mode: update OrbitControls and render with editor camera
        this.controls?.update();

        // Update sky weather after camera update
        if (this.skyWeatherSystem) {
          this.skyWeatherSystem.update();
        }

        // Sync volumetric fog with weather and camera
        if (this.volumetricFogPass && this.skyWeatherSystem) {
          this.volumetricFogPass.updateCamera(this.camera);
          this.volumetricFogPass.syncWeather(
            this.skyWeatherSystem.getFogColor(),
            this.skyWeatherSystem.getFogDensity(),
            this.skyWeatherSystem.getSunDirection(),
            this.skyWeatherSystem.getSunColor()
          );
        }

        if (this.composer && this.renderPass) {
          this.renderPass.camera = this.camera;
          this.composer.render();
        } else {
          this.renderer.render(this.scene, this.camera);
        }
      }
    };
    animate();
    console.log("[EditorEngine] Render loop started");

    // Handle resize using ResizeObserver on parent element (canvas has inline styles)
    this.resizeObserver = new ResizeObserver(() => {
      this.handleResize();
    });
    const parent = this.canvas.parentElement;
    if (parent) {
      this.resizeObserver.observe(parent);
    }
    window.addEventListener("resize", this.handleResize);

    // Initialize streaming infrastructure (disabled by default in editor)
    this.assetPool = new AssetContainerPool(this.scene, 50);
    this.streamingManager = new StreamingManager(this.scene, {
      cellSize: 64,
      nearRadius: 1,
      midRadius: 2,
      farRadius: 3,
    });

    // Initialize sky and weather system
    this.skyWeatherSystem = new SkyWeatherSystem(this.scene);
    this.skyWeatherSystem.init();
    // Set editor camera for sky sphere positioning
    this.skyWeatherSystem.setCamera(this.camera);
    // Connect terrain material for shader sync
    if (this.terrainMesh) {
      const material = this.terrainMesh.getMaterial() as THREE.ShaderMaterial | null;
      if (material) {
        this.skyWeatherSystem.setTerrainMaterial(material);
      }
    }
    // Connect foliage system
    if (this.foliageSystem) {
      this.skyWeatherSystem.setFoliageSystem(this.foliageSystem);
    }
    // Connect prop manager
    if (this.propManager) {
      this.skyWeatherSystem.setPropManager(this.propManager);
    }
    // Connect water system (BiomeDecorator manages water)
    if (this.biomeDecorator) {
      const waterSystem = this.biomeDecorator.getWaterSystem();
      if (waterSystem) {
        const waterMaterial = waterSystem.getMaterial();
        if (waterMaterial) {
          this.skyWeatherSystem.setWaterMaterial(waterMaterial);
        }
      }
    }
    console.log("[EditorEngine] Sky weather system initialized");

    // Setup post-processing pipeline
    this.setupPostProcessing();

    this.isInitialized = true;
  }

  private setupCamera(): void {
    this.camera = new THREE.PerspectiveCamera(
      45,
      this.canvas.clientWidth / this.canvas.clientHeight,
      0.1,
      2000
    );
    this.camera.position.set(32 + 70, 50, 32 + 70); // Approximate ArcRotateCamera alpha=-PI/4, beta=PI/3, radius=100

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.target.set(32, 0, 32);
    this.controls.minDistance = 10;
    this.controls.maxDistance = 300;
    this.controls.minPolarAngle = 0.1;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.1;
    this.controls.enablePan = true;
    this.controls.panSpeed = 1.0;
    this.controls.update();
  }

  private setupLighting(): void {
    // Hemisphere light for non-PBR shaders (terrain, grass, rock use custom lighting)
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x4d4d59, 0.6);
    this.scene.add(hemiLight);

    // Ambient light for PBR materials (CSM tree/bush) — uniform fill from all directions
    const ambLight = new THREE.AmbientLight(0xffffff, 3.5);
    this.scene.add(ambLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 4.5);
    dirLight.position.set(0.5, 1, 0.5);

    // Shadow configuration
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.bias = -0.0005;
    dirLight.shadow.normalBias = 0.02;

    // Shadow camera frustum (covers terrain area)
    const shadowSize = 80;
    dirLight.shadow.camera.left = -shadowSize;
    dirLight.shadow.camera.right = shadowSize;
    dirLight.shadow.camera.top = shadowSize;
    dirLight.shadow.camera.bottom = -shadowSize;
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 200;

    dirLight.target.position.set(32, 0, 32);
    this.scene.add(dirLight);
    this.scene.add(dirLight.target);
  }

  private setupPostProcessing(): void {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;

    // Create render target with depth texture for volumetric fog
    const renderTarget = new THREE.WebGLRenderTarget(width, height, {
      depthTexture: new THREE.DepthTexture(width, height),
      depthBuffer: true,
      // MSAA disabled: too expensive with 4096 alpha-tested grass meshes
    });
    if (renderTarget.depthTexture) {
      renderTarget.depthTexture.format = THREE.DepthFormat;
      renderTarget.depthTexture.type = THREE.UnsignedIntType;
    }

    this.composer = new EffectComposer(this.renderer, renderTarget);

    // 1. Render pass
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    // 2. SSAO pass (disabled: leaf card geometry causes dark rectangular artifacts regardless of material type)
    // const ssaoPass = new SSAOPass(this.scene, this.camera, width, height);
    // ssaoPass.kernelRadius = 8;
    // ssaoPass.minDistance = 0.001;
    // ssaoPass.maxDistance = 0.1;
    // ssaoPass.output = SSAOPass.OUTPUT.Default;
    // this.composer.addPass(ssaoPass);

    // 3. Volumetric fog pass (after SSAO, before Bloom)
    this.volumetricFogPass = new VolumetricFogPass(
      this.camera,
      new THREE.Vector2(width, height)
    );
    this.volumetricFogPass.fogDensity = 0.015;
    this.volumetricFogPass.fogHeightFalloff = 0.08;
    this.volumetricFogPass.fogBaseHeight = 0.0;
    this.volumetricFogPass.godRayIntensity = 0.25;
    this.volumetricFogPass.steps = 16;
    this.composer.addPass(this.volumetricFogPass);

    // 4. Bloom pass (subtle)
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(width, height),
      0.3,   // strength
      0.4,   // radius
      0.85   // threshold
    );
    this.composer.addPass(bloomPass);

    // 5. Output pass (tone mapping + color space)
    const outputPass = new OutputPass();
    this.composer.addPass(outputPass);

    // OutputPass handles tone mapping, so disable on renderer
    this.renderer.toneMapping = THREE.NoToneMapping;

    console.log("[EditorEngine] Post-processing pipeline initialized (SSAO + VolumetricFog + Bloom)");
  }

  private setupGrid(): void {
    this.gridMesh = new THREE.GridHelper(256, 256, 0x666673, 0x4d4d59);
    // majorUnitFrequency=8 -> minor divisions with 256 total
    // mainColor=Color3(0.3,0.3,0.35)=#4d4d59, lineColor=Color3(0.4,0.4,0.45)=#666673
    this.gridMesh.position.set(32, -0.01, 32);
    this.scene.add(this.gridMesh);
  }

  private setupInputHandlers(): void {
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("keydown", this.onKeyDown);
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (this.isGameMode) return;
    if (event.button === 0) {
      this.isPointerDown = true;
      this.snapshotPushedForStroke = false;
    }
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (this.isGameMode) return;
    if (event.button === 0) {
      this.isPointerDown = false;
      // Rebuild biome decorations if dirty
      if (this.biomeDirty && this.biomeDecorator) {
        this.biomeDecorator.rebuildAll();
        this.biomeDirty = false;
        this.windTextureWired = false;
      }
      // Rebuild foliage if dirty
      if (this.foliageDirty && this.foliageSystem) {
        this.foliageSystem.generateAll();
        this.foliageDirty = false;
      }
      // Update prop heights to match terrain
      if (this.propsDirty && this.propManager) {
        this.propManager.updateAllHeights();
        this.propManager.rebuildDirtyGroups();
        this.propsDirty = false;
      }
    }
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (this.isGameMode) return;
    this.handlePointerMove(event);
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (this.isGameMode) return;
    this.handleKeyDown(event);
  };

  private handlePointerMove(event: PointerEvent): void {
    // Double-check game mode (safety guard)
    if (this.isGameMode) return;

    const rect = this.canvas.getBoundingClientRect();
    const currentX = event.clientX - rect.left;
    const currentY = event.clientY - rect.top;

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

    // Convert to NDC (-1 to +1)
    const ndcX = (currentX / this.canvas.clientWidth) * 2 - 1;
    const ndcY = -(currentY / this.canvas.clientHeight) * 2 + 1;

    // Raycast to terrain (uses cached mesh reference + BVH acceleration)
    this._ndcVec.set(ndcX, ndcY);
    this.raycaster.setFromCamera(this._ndcVec, this.camera);

    const activeMesh = this.terrainMesh?.getMesh() as THREE.Mesh | null;
    const intersections = activeMesh
      ? this.raycaster.intersectObject(activeMesh, false)
      : [];

    if (intersections.length > 0) {
      this.currentPickHit = true;
      this.currentPickPoint = intersections[0].point.clone();

      // Update brush preview position
      if (this.brushPreview) {
        this.brushPreview.position.set(
          intersections[0].point.x,
          intersections[0].point.y + 0.1,
          intersections[0].point.z
        );
        this.brushPreview.visible = true;
      }
    } else {
      this.currentPickHit = false;
      this.currentPickPoint = null;
      if (this.brushPreview) {
        this.brushPreview.visible = false;
      }
    }
  }

  private handleKeyDown(event: KeyboardEvent): void {
    void event;
    // Bracket keys for brush size - handled by React
  }

  private createBrushPreview(): void {
    const geometry = new THREE.CircleGeometry(2.5, 32);
    geometry.rotateX(-Math.PI / 2); // Lay flat on XZ plane

    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0.3, 0.7, 1),
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    this.brushPreview = new THREE.Mesh(geometry, material);
    this.brushPreview.visible = false;
    this.scene.add(this.brushPreview);
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
    this.propManager.setTileSize(size);
    this.propManager.setCamera(this.camera);
    this.propManager.setLightManager(this.lightManager);

    // Connect prop manager to weather system for fog/sun sync
    if (this.skyWeatherSystem) {
      this.skyWeatherSystem.setPropManager(this.propManager);
    }

    // Update grid and camera to match terrain size
    if (this.gridMesh) {
      const gridScale = Math.max(256, size * 4);
      // Remove old grid and create new one with correct size
      this.scene.remove(this.gridMesh);
      this.gridMesh = new THREE.GridHelper(gridScale, gridScale, 0x666673, 0x4d4d59);
      this.gridMesh.position.set(size / 2, -0.01, size / 2);
      this.scene.add(this.gridMesh);
    }
    this.focusOnTerrain();
  }

  /**
   * Save current terrain state as default tile template for infinite expansion
   */

  // Brush application
  applyBrush(
    tool: HeightmapTool,
    settings: BrushSettings,
    deltaTime: number
  ): void {
    if (!this.isPointerDown || !this.currentPickHit) return;
    if (!this.currentPickPoint || !this.heightmap || !this.terrainMesh) return;

    const point = this.currentPickPoint;

    // Save undo snapshot before first modification in this stroke
    if (!this.snapshotPushedForStroke) {
      const splatMap = this.terrainMesh.getSplatMap();
      this.undoManager.pushSnapshot(
        this.heightmap.getData(),
        splatMap.getData(),
        splatMap.getWaterMask()
      );
      this.snapshotPushedForStroke = true;
    }

    const modified = this.heightmap.applyBrush(
      point.x,
      point.z,
      tool,
      settings,
      deltaTime
    );

    if (modified) {
      this.terrainMesh.updateFromHeightmapRegion(point.x, point.z, settings.size);
      this.foliageDirty = true;
      this.biomeDirty = true;
      this.propsDirty = true;
      this.onModified?.();
    }
  }

  // Prop placement and preview
  createPropPreview(
    type: ProceduralAssetType,
    size: number,
    seed?: number,
    customSettings?: {
      length?: number;
      width?: number;
      height?: number;
      baySize?: number;
      planPreset?: HanokPlanPreset;
    }
  ): void {
    if (!this.propManager) return;
    this.propManager.createPreview(type, size, seed, customSettings);
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
    settings?: {
      size?: number;
      seed?: number;
      length?: number;
      width?: number;
      height?: number;
      baySize?: number;
      planPreset?: HanokPlanPreset;
    }
  ): string | null {
    if (!this.propManager) return null;
    return this.propManager.placeProp(propType, x, z, settings);
  }

  removeProp(instanceId: string): void {
    if (this.propManager) {
      this.propManager.removeProp(instanceId);
    }
  }

  pickProp(clientX: number, clientY: number): import("../props/PropManager").PropInstance | null {
    if (!this.propManager) return null;
    const point = this.pickTerrain(clientX, clientY);
    if (!point) return null;
    return this.propManager.getInstanceAtPosition(point.x, point.z, 2.0);
  }

  updatePropTransform(id: string, updates: {
    position?: THREE.Vector3;
    rotation?: THREE.Vector3;
    scale?: THREE.Vector3;
  }): boolean {
    return this.propManager?.updatePropTransform(id, updates) ?? false;
  }

  highlightProp(id: string | null): void {
    if (this.selectionHelper) {
      this.scene.remove(this.selectionHelper);
      this.selectionHelper.geometry?.dispose();
      (this.selectionHelper.material as THREE.Material)?.dispose();
      this.selectionHelper = null;
    }
    if (!id || !this.propManager) return;
    const inst = this.propManager.getInstance(id);
    if (!inst) return;

    const s = inst.params.size;
    const size = new THREE.Vector3(
      s * inst.scale.x * 2,
      s * inst.scale.y * 2,
      s * inst.scale.z * 2
    );
    const box = new THREE.Box3().setFromCenterAndSize(inst.position, size);
    this.selectionHelper = new THREE.Box3Helper(box, new THREE.Color(0x00aaff));
    this.scene.add(this.selectionHelper);
  }

  getPropManager(): PropManager | null {
    return this.propManager;
  }

  /**
   * Get which tile grid position a world point is on
   */
  applyPaintBrush(
    material: MaterialType,
    settings: BrushSettings
  ): void {
    if (!this.isPointerDown || !this.currentPickHit) return;
    if (!this.currentPickPoint || !this.heightmap || !this.terrainMesh) return;

    const point = this.currentPickPoint;
    const splatMap = this.terrainMesh.getSplatMap();

    // Save undo snapshot before first modification in this stroke
    if (!this.snapshotPushedForStroke) {
      this.undoManager.pushSnapshot(
        this.heightmap.getData(),
        splatMap.getData(),
        splatMap.getWaterMask()
      );
      this.snapshotPushedForStroke = true;
    }

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
    if (!this.isPointerDown || !this.currentPickHit) return;
    if (!this.currentPickPoint || !this.heightmap || !this.terrainMesh) return;

    const point = this.currentPickPoint;
    const splatMap = this.terrainMesh.getSplatMap();

    // Save undo snapshot before first modification in this stroke
    if (!this.snapshotPushedForStroke) {
      this.undoManager.pushSnapshot(
        this.heightmap.getData(),
        splatMap.getData(),
        splatMap.getWaterMask()
      );
      this.snapshotPushedForStroke = true;
    }

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
      this.propsDirty = true;
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
      this.terrainMesh.updateFromHeightmapRegion(
        worldX,
        worldZ,
        outerRadius * cellSize
      );

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

  setWaterReflections(enabled: boolean): void {
    const waterSystem = this.biomeDecorator?.getWaterSystem();
    if (waterSystem) {
      waterSystem.setReflectionEnabled(enabled);
    }
  }

  /**
   * Set water type (river or lake)
   */
  setWaterType(type: WaterType): void {
    this.waterType = type;
    const angleRadians = (this.waterFlowAngle * Math.PI) / 180;
    if (this.biomeDecorator) {
      this.biomeDecorator.setWaterType(type, angleRadians);
    }
    this.updateWaterDirectionIndicator();
  }

  getWaterType(): WaterType {
    return this.waterType;
  }

  /**
   * Set water flow direction angle (degrees 0-360)
   * Only meaningful for river type
   */
  setWaterFlowAngle(angleDegrees: number): void {
    this.waterFlowAngle = angleDegrees;
    const angleRadians = (angleDegrees * Math.PI) / 180;
    if (this.biomeDecorator) {
      this.biomeDecorator.setWaveAngle(angleRadians);
    }
    this.updateWaterDirectionIndicator();
  }

  getWaterFlowAngle(): number {
    return this.waterFlowAngle;
  }

  // ==================== Weather System Methods ====================

  /**
   * Update time of day (0-24 hours)
   */
  setTimeOfDay(time: number): void {
    if (this.skyWeatherSystem) {
      this.skyWeatherSystem.setTimeOfDay(time);
    }
  }

  /**
   * Set weather preset (clear, cloudy, rainy, stormy, snowy)
   */
  setWeatherPreset(preset: WeatherPreset): void {
    if (this.skyWeatherSystem) {
      this.skyWeatherSystem.setWeatherPreset(preset);
    }
  }

  /**
   * Set cloud coverage (0-1)
   */
  setCloudCoverage(coverage: number): void {
    if (this.skyWeatherSystem) {
      this.skyWeatherSystem.setCloudCoverage(coverage);
    }
  }

  /**
   * Set wind speed (0-1)
   */
  setWindSpeed(speed: number): void {
    if (this.skyWeatherSystem) {
      this.skyWeatherSystem.setWindSpeed(speed);
    }
  }

  /**
   * Set wind direction (0-360 degrees)
   */
  setWindDirection(direction: number): void {
    if (this.skyWeatherSystem) {
      this.skyWeatherSystem.setWindDirection(direction);
    }
  }

  /**
   * Set fog density (0-0.1)
   */
  setWeatherFogDensity(density: number): void {
    if (this.skyWeatherSystem) {
      this.skyWeatherSystem.setFogDensity(density);
    }
  }

  /**
   * Update full weather state
   */
  updateWeatherState(state: Partial<WeatherState>): void {
    if (this.skyWeatherSystem) {
      this.skyWeatherSystem.updateState(state);
    }
  }

  /**
   * Get current weather state
   */
  getWeatherState(): WeatherState | null {
    return this.skyWeatherSystem?.getState() || null;
  }

  /**
   * Get sky weather system instance
   */
  getSkyWeatherSystem(): SkyWeatherSystem | null {
    return this.skyWeatherSystem;
  }

  /**
   * Create or update the water direction indicator (arrow triangle)
   * Only visible when waterType is "river"
   */
  private updateWaterDirectionIndicator(): void {
    // Don't show indicator in game mode
    if (this.isGameMode) {
      if (this.waterDirectionIndicator) {
        this.waterDirectionIndicator.visible = false;
      }
      return;
    }

    if (this.waterType !== "river") {
      // Hide indicator for lake type
      if (this.waterDirectionIndicator) {
        this.waterDirectionIndicator.visible = false;
      }
      return;
    }

    // Create indicator if it doesn't exist
    if (!this.waterDirectionIndicator) {
      const geometry = new THREE.CircleGeometry(2, 3); // 3 segments = triangle
      geometry.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(0.2, 0.6, 1.0),
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      this.waterDirectionIndicator = new THREE.Mesh(geometry, mat);
      this.scene.add(this.waterDirectionIndicator);
    }

    // Position at water level
    const waterSystem = this.biomeDecorator?.getWaterSystem();
    const waterMesh = waterSystem?.getMesh();
    if (waterMesh) {
      this.waterDirectionIndicator.position.x = waterMesh.position.x;
      this.waterDirectionIndicator.position.y = waterMesh.position.y + 0.15;
      this.waterDirectionIndicator.position.z = waterMesh.position.z;
    } else if (this.heightmap) {
      const size = this.heightmap.getScale();
      this.waterDirectionIndicator.position.x = size / 2;
      this.waterDirectionIndicator.position.y = this.seaLevel + 0.15;
      this.waterDirectionIndicator.position.z = size / 2;
    }

    // Rotate to match flow direction (Y-axis rotation on the flat disc)
    const angleRadians = (this.waterFlowAngle * Math.PI) / 180;
    this.waterDirectionIndicator.rotation.y = angleRadians;
    this.waterDirectionIndicator.visible = true;
  }

  /**
   * Dispose the direction indicator
   */
  private disposeWaterDirectionIndicator(): void {
    if (this.waterDirectionIndicator) {
      disposeMesh(this.scene, this.waterDirectionIndicator);
      this.waterDirectionIndicator = null;
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

  /**
   * Export foliage data for saving
   * Returns type -> Base64 encoded matrices
   */
  exportFoliageData(): Record<string, string> | null {
    if (!this.foliageSystem) return null;
    return this.foliageSystem.exportTileData();
  }

  /**
   * Export procedural props data for saving
   */
  exportProceduralProps(): SerializedProceduralPropInstance[] | null {
    if (!this.propManager) return null;
    return this.propManager.exportInstances();
  }

  /**
   * Import procedural props data from save
   */
  importProceduralProps(data: SerializedProceduralPropInstance[]): void {
    if (!this.propManager) return;
    this.propManager.importInstances(data);
  }

  updateBrushPreview(size: number): void {
    if (this.brushPreview) {
      const scale = size / 5;
      this.brushPreview.scale.set(scale, scale, scale);
    }
  }

  setGridVisible(visible: boolean): void {
    if (this.gridMesh) {
      this.gridMesh.visible = visible;
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
        mesh.visible = visible;
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
          waterMesh.visible = visible;
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
  getScene(): THREE.Scene {
    return this.scene;
  }

  getRenderer(): THREE.WebGLRenderer {
    return this.renderer;
  }

  /**
   * Undo the last terrain edit operation
   */
  applyUndo(): boolean {
    if (!this.heightmap || !this.terrainMesh) return false;
    const splatMap = this.terrainMesh.getSplatMap();

    const snapshot = this.undoManager.undo(
      this.heightmap.getData(),
      splatMap.getData(),
      splatMap.getWaterMask()
    );
    if (!snapshot) return false;

    this.restoreSnapshot(snapshot.heightmap, snapshot.splatmap, snapshot.waterMask);
    return true;
  }

  /**
   * Redo a previously undone terrain edit operation
   */
  applyRedo(): boolean {
    if (!this.heightmap || !this.terrainMesh) return false;
    const splatMap = this.terrainMesh.getSplatMap();

    const snapshot = this.undoManager.redo(
      this.heightmap.getData(),
      splatMap.getData(),
      splatMap.getWaterMask()
    );
    if (!snapshot) return false;

    this.restoreSnapshot(snapshot.heightmap, snapshot.splatmap, snapshot.waterMask);
    return true;
  }

  /**
   * Restore terrain state from a snapshot
   */
  private restoreSnapshot(heightmap: Float32Array, splatmap: Float32Array, waterMask: Float32Array): void {
    if (!this.heightmap || !this.terrainMesh) return;

    // Restore heightmap
    this.heightmap.getData().set(heightmap);
    this.terrainMesh.updateFromHeightmap();

    // Restore splatmap and water mask
    const splatMap = this.terrainMesh.getSplatMap();
    const srcSplatRes = Math.round(Math.sqrt(splatmap.length / 4));
    splatMap.loadFromData(splatmap, waterMask, srcSplatRes);
    this.terrainMesh.updateSplatTexture();
    this.terrainMesh.updateWaterMaskTexture();

    // Rebuild dependent systems
    if (this.foliageSystem) {
      this.foliageSystem.generateAll();
    }
    if (this.biomeDecorator) {
      this.biomeDecorator.rebuildAll();
    }
    if (this.propManager) {
      this.propManager.updateAllHeights();
      this.propManager.rebuildDirtyGroups();
    }

    this.onModified?.();
  }

  get canUndo(): boolean {
    return this.undoManager.canUndo;
  }

  get canRedo(): boolean {
    return this.undoManager.canRedo;
  }

  // ==================== Multi-Tile Grid Methods ====================

  /**
   * Get current editing tile grid coordinates
   */
  getCurrentGridPosition(): { gridX: number; gridZ: number } {
    return { gridX: this.currentGridX, gridZ: this.currentGridZ };
  }

  /**
   * Set current tile grid position
   */
  setCurrentGridPosition(gridX: number, gridZ: number): void {
    this.currentGridX = gridX;
    this.currentGridZ = gridZ;
  }

  /**
   * Load a read-only neighbor tile mesh at the given grid position.
   * Creates a simple terrain mesh offset by (gridX * tileSize, gridZ * tileSize).
   */
  loadNeighborTile(
    gridX: number,
    gridZ: number,
    heightmapData: Float32Array,
    resolution: number,
    tileSize: number
  ): void {
    const key = `${gridX}_${gridZ}`;

    // Skip if already loaded
    if (this.neighborMeshes.has(key)) return;

    // Create a simplified mesh (lower resolution for performance)
    const step = Math.max(1, Math.floor(resolution / 64)); // Max 64x64 for neighbors
    const segments = Math.floor(resolution / step);
    const geometry = new THREE.PlaneGeometry(tileSize, tileSize, segments, segments);
    geometry.rotateX(-Math.PI / 2);

    // Apply heightmap to vertices
    const pos = geometry.getAttribute("position");
    const res = resolution + 1;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      // Map from geometry space (-tileSize/2..tileSize/2) to heightmap space (0..resolution)
      const hx = Math.round(((x + tileSize / 2) / tileSize) * (res - 1));
      const hz = Math.round(((z + tileSize / 2) / tileSize) * (res - 1));
      const idx = Math.min(res - 1, Math.max(0, hz)) * res + Math.min(res - 1, Math.max(0, hx));
      pos.setY(i, heightmapData[idx] || 0);
    }
    pos.needsUpdate = true;
    geometry.computeVertexNormals();

    // Simple semi-transparent material to distinguish from editable tile
    const material = new THREE.MeshLambertMaterial({
      color: 0x556655,
      transparent: true,
      opacity: 0.6,
    });

    const mesh = new THREE.Mesh(geometry, material);
    // Offset: relative to current tile's position
    const offsetX = (gridX - this.currentGridX) * tileSize + tileSize / 2;
    const offsetZ = (gridZ - this.currentGridZ) * tileSize + tileSize / 2;
    mesh.position.set(offsetX, 0, offsetZ);
    mesh.receiveShadow = true;
    mesh.name = `neighbor_${key}`;

    this.scene.add(mesh);
    this.neighborMeshes.set(key, mesh);
  }

  /**
   * Unload all neighbor tile meshes
   */
  unloadAllNeighborTiles(): void {
    for (const [, mesh] of this.neighborMeshes) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.neighborMeshes.clear();
  }

  /**
   * Unload a specific neighbor tile mesh
   */
  unloadNeighborTile(gridX: number, gridZ: number): void {
    const key = `${gridX}_${gridZ}`;
    const mesh = this.neighborMeshes.get(key);
    if (mesh) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      this.neighborMeshes.delete(key);
    }
  }

  // ==================== Light Manager Methods ====================

  /**
   * Get the light manager for adding/removing point lights
   */
  getLightManager(): LightManager {
    return this.lightManager;
  }

  /**
   * Add a point light at a world position
   */
  addPointLight(id: string, x: number, y: number, z: number, color: THREE.Color, intensity: number, range: number): void {
    this.lightManager.setLight(id, new THREE.Vector3(x, y, z), color, intensity, range);
  }

  /**
   * Remove a point light
   */
  removePointLight(id: string): void {
    this.lightManager.removeLight(id);
  }

  /**
   * Get renderer performance stats (FPS, draw calls, triangles)
   */
  getStats(): { fps: number; drawCalls: number; triangles: number } {
    const info = this.renderer.info.render;
    return {
      fps: this.fps,
      drawCalls: info.calls,
      triangles: info.triangles,
    };
  }

  getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }

  /**
   * Raycast to terrain mesh and return the intersection point.
   * Used by WorldEditor.tsx for prop placement and asset placement.
   */
  pickTerrain(clientX: number, clientY: number): THREE.Vector3 | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / this.canvas.clientWidth) * 2 - 1;
    const ndcY = -((clientY - rect.top) / this.canvas.clientHeight) * 2 + 1;

    this._ndcVec.set(ndcX, ndcY);
    this.raycaster.setFromCamera(this._ndcVec, this.camera);

    const activeMesh = this.terrainMesh?.getMesh() as THREE.Mesh | null;
    if (!activeMesh) return null;

    const intersections = this.raycaster.intersectObject(activeMesh, false);
    if (intersections.length > 0) {
      return intersections[0].point.clone();
    }
    return null;
  }

  focusOnTerrain(): void {
    if (this.heightmap && this.controls) {
      const size = this.heightmap.getScale();
      this.controls.target.set(size / 2, 0, size / 2);
      // Approximate radius = size * 1.5 -> set camera distance
      const dir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target).normalize();
      this.camera.position.copy(this.controls.target).add(dir.multiplyScalar(size * 1.5));
      this.controls.update();
    }
  }

  /**
   * Focus camera on a specific grid cell and show tile boundary highlight
   * Smoothly transitions camera position while maintaining viewing direction
   */
  /**
   * Move camera in WASD style (moves camera target)
   */
  moveCamera(direction: "forward" | "backward" | "left" | "right", speed: number = 2): void {
    // Get camera forward direction (projected onto XZ plane)
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();

    const right = new THREE.Vector3();
    right.crossVectors(new THREE.Vector3(0, 1, 0), forward).normalize();

    let movement = new THREE.Vector3();

    switch (direction) {
      case "forward":
        movement = forward.multiplyScalar(speed);
        break;
      case "backward":
        movement = forward.multiplyScalar(-speed);
        break;
      case "left":
        movement = right.multiplyScalar(-speed);
        break;
      case "right":
        movement = right.multiplyScalar(speed);
        break;
    }

    if (this.controls) {
      this.controls.target.add(movement);
    }
    this.camera.position.add(movement);
  }

  // Control camera wheel zoom
  setCameraWheelEnabled(enabled: boolean): void {
    if (this.controls) {
      this.controls.enableZoom = enabled;
    }
  }

  // Manual camera zoom using raw deltaY from wheel event
  zoomCamera(deltaY: number): void {
    if (!this.controls) return;
    const minDist = this.controls.minDistance;
    const maxDist = this.controls.maxDistance;

    const dist = this.camera.position.distanceTo(this.controls.target);
    const zoomAmount = deltaY * 0.002 * dist;

    const dir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target).normalize();
    const newDist = Math.max(minDist, Math.min(maxDist, dist + zoomAmount));
    this.camera.position.copy(this.controls.target).add(dir.multiplyScalar(newDist));
  }

  setTopView(): void {
    if (!this.controls) return;
    const dist = this.camera.position.distanceTo(this.controls.target);
    const target = this.controls.target.clone();
    this.camera.position.set(target.x, target.y + dist, target.z + 0.01);
    this.controls.update();
  }

  // Game Preview Mode
  enterGameMode(): void {
    if (this.isGameMode || !this.heightmap || !this.terrainMesh) return;

    // Set game mode flag FIRST to prevent race conditions with event handlers
    this.isGameMode = true;

    // Disable terrain LOD FIRST so getMesh() returns the full resolution mesh
    this.terrainMesh.setLODEnabled(false);

    const mesh = this.terrainMesh.getMesh();
    if (!mesh) {
      this.isGameMode = false;
      return;
    }

    // Save current state
    this.savedClearColor = (this.scene.background as THREE.Color)?.clone() || null;

    // Remove all editor elements from scene (not just hide)
    if (this.gridMesh) this.scene.remove(this.gridMesh);
    if (this.brushPreview) this.scene.remove(this.brushPreview);
    if (this.waterDirectionIndicator) this.scene.remove(this.waterDirectionIndicator);
    if (this.propManager) this.propManager.setPreviewVisible(false);

    // Disable and dispose editor controls to prevent pointer capture conflicts
    if (this.controls) {
      this.controls.enabled = false;
      this.controls.dispose();
      this.controls = null;
    }

    // Block any remaining OrbitControls pointer events (dispose may not fully clean up)
    this.gamePointerBlocker = (e: PointerEvent) => {
      // Let PointerLockControls handle clicks, block OrbitControls
      e.stopPropagation();
    };
    this.canvas.addEventListener("pointerdown", this.gamePointerBlocker, { capture: true });

    // Create and enable game preview with foliage and water systems
    this.gamePreview = new GamePreview(
      this.scene,
      this.heightmap,
      this.terrainMesh,
      this.foliageSystem,
      this.biomeDecorator,
      this.skyWeatherSystem
    );
    this.gamePreview.enable(mesh);

    this.onGameModeChange?.(true);

    // Trigger resize after DOM settles (sidebar hidden)
    setTimeout(() => this.handleResize(), 100);
  }

  exitGameMode(): void {
    if (!this.isGameMode) return;

    // Set game mode flag FIRST
    this.isGameMode = false;

    // Disable game preview
    if (this.gamePreview) {
      this.gamePreview.disable();
      this.gamePreview = null;
    }

    // Remove pointer blocker
    if (this.gamePointerBlocker) {
      this.canvas.removeEventListener("pointerdown", this.gamePointerBlocker, { capture: true });
      this.gamePointerBlocker = null;
    }

    // Re-enable terrain LOD and ensure mesh is visible
    if (this.terrainMesh) {
      this.terrainMesh.setLODEnabled(true);
      const mesh = this.terrainMesh.getMesh();
      if (mesh) {
        mesh.visible = true;
      }
    }

    // Reset foliage chunk visibility (game mode culls distant chunks)
    if (this.foliageSystem) {
      this.foliageSystem.resetAllChunkVisibility();
    }

    // Recreate editor controls (dispose removed all event listeners)
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.target.set(32, 0, 32);
    this.controls.minDistance = 10;
    this.controls.maxDistance = 300;
    this.controls.minPolarAngle = 0.1;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.1;
    this.controls.enablePan = true;
    this.controls.panSpeed = 1.0;
    this.controls.update();

    // Restore clear color
    if (this.savedClearColor) {
      this.scene.background = this.savedClearColor;
    }

    // Add editor elements back to scene
    if (this.gridMesh) {
      this.scene.add(this.gridMesh);
      this.gridMesh.visible = true;
    }
    if (this.brushPreview) {
      this.scene.add(this.brushPreview);
      this.brushPreview.visible = false; // Start hidden, will show on mouse move
    }
    // Restore direction indicator if river type
    if (this.waterDirectionIndicator) {
      this.scene.add(this.waterDirectionIndicator);
      this.waterDirectionIndicator.visible = this.waterType === "river";
    }

    // Restore editor camera for sky sphere positioning
    if (this.skyWeatherSystem) {
      this.skyWeatherSystem.setCamera(this.camera);
    }

    this.onGameModeChange?.(false);

    // Trigger resize after DOM settles (sidebar shown)
    setTimeout(() => this.handleResize(), 100);
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
  private handleResize = (): void => {
    // Use parent element size since canvas has inline styles from setSize
    const parent = this.canvas.parentElement;
    const width = parent?.clientWidth || this.canvas.clientWidth;
    const height = parent?.clientHeight || this.canvas.clientHeight;
    this.renderer.setSize(width, height, false);
    // Force canvas to fill parent (setSize adds inline styles)
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";

    // Update editor camera
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    // Update game camera if in game mode
    if (this.isGameMode && this.gamePreview) {
      const gameCamera = this.gamePreview.getCamera();
      if (gameCamera) {
        gameCamera.aspect = width / height;
        gameCamera.updateProjectionMatrix();
      }
    }

    // Update post-processing composer size
    if (this.composer) {
      this.composer.setSize(width, height);
    }
    if (this.volumetricFogPass) {
      this.volumetricFogPass.setSize(width, height);
    }
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

    // Load splat map data (resample if saved resolution differs from current splatmap)
    const splatMap = this.terrainMesh.getSplatMap();
    const srcSplatRes = Math.round(Math.sqrt(splatmapData.length / 4));
    splatMap.loadFromData(splatmapData, waterMaskData, srcSplatRes);

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
    this.propManager.setLightManager(this.lightManager);

    // Connect prop manager to weather system for fog/sun sync
    if (this.skyWeatherSystem) {
      this.skyWeatherSystem.setPropManager(this.propManager);
    }

    console.log("[EditorEngine] Tile data loaded");
  }

  /**
   * Apply edge data from connected tile for seamless stitching
   * @param direction The edge direction (left, right, top, bottom)
   * @param edgeHeights Height values along the edge
   * @param edgeSplats Splat values along the edge
   * @param edgeWater Water mask values along the edge
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

    this.highlightProp(null);

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
    if (this.volumetricFogPass) {
      this.volumetricFogPass.dispose();
      this.volumetricFogPass = null;
    }
    if (this.composer) {
      this.composer.dispose();
      this.composer = null;
      this.renderPass = null;
    }
    if (this.skyWeatherSystem) {
      this.skyWeatherSystem.dispose();
      this.skyWeatherSystem = null;
    }
    this.unloadAllNeighborTiles();
    this.disposeWaterDirectionIndicator();
    if (this.brushPreview) {
      disposeMesh(this.scene, this.brushPreview);
      this.brushPreview = null;
    }
    if (this.gridMesh) {
      this.scene.remove(this.gridMesh);
      this.gridMesh = null;
    }
    if (this.terrainMesh) {
      this.terrainMesh.dispose();
      this.terrainMesh = null;
    }
    this.heightmap = null;

    // Remove event listeners
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("resize", this.handleResize);
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.gamePointerBlocker) {
      this.canvas.removeEventListener("pointerdown", this.gamePointerBlocker, { capture: true });
      this.gamePointerBlocker = null;
    }

    // Stop render loop
    cancelAnimationFrame(this.animationFrameId);

    // Dispose renderer
    this.renderer.dispose();
  }
}
