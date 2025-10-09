import {
  Scene,
  Mesh,
  ArcRotateCamera,
  Vector3,
  HemisphericLight,
  Color3,
  Color4,
} from "@babylonjs/core";
import { ProceduralAsset, AssetParams, AssetType, DEFAULT_ASSET_PARAMS } from "./ProceduralAsset";

/**
 * AssetGenerator - Creates procedural assets with a preview scene
 * Used in the editor UI for asset creation and customization
 */
export class AssetGenerator {
  private scene: Scene;
  private currentAsset: ProceduralAsset | null = null;
  private currentMesh: Mesh | null = null;
  private params: AssetParams;
  private onUpdate: ((params: AssetParams) => void) | null = null;

  constructor(scene: Scene, type: AssetType = "rock") {
    this.scene = scene;
    this.params = { ...DEFAULT_ASSET_PARAMS[type] };
  }

  // Generate/regenerate the asset
  generate(): Mesh | null {
    if (this.currentAsset) {
      this.currentAsset.dispose();
    }

    this.currentAsset = new ProceduralAsset(this.scene, this.params);
    this.currentMesh = this.currentAsset.generate();

    this.onUpdate?.(this.params);

    return this.currentMesh;
  }

  // Randomize seed (dice button)
  randomize(): Mesh | null {
    this.params.seed = Math.random() * 10000;
    return this.generate();
  }

  // Set asset type
  setType(type: AssetType): Mesh | null {
    // Keep some params, reset type-specific ones
    const currentSize = this.params.size;
    this.params = { ...DEFAULT_ASSET_PARAMS[type] };
    this.params.size = currentSize; // Keep user-set size
    this.params.seed = Math.random() * 10000;
    return this.generate();
  }

  // Set size
  setSize(size: number): Mesh | null {
    this.params.size = Math.max(0.1, Math.min(10, size));
    return this.generate();
  }

  // Set size variation
  setSizeVariation(variation: number): Mesh | null {
    this.params.sizeVariation = Math.max(0, Math.min(1, variation));
    return this.generate();
  }

  // Set noise scale
  setNoiseScale(scale: number): Mesh | null {
    this.params.noiseScale = Math.max(0.5, Math.min(10, scale));
    return this.generate();
  }

  // Set noise amplitude
  setNoiseAmplitude(amplitude: number): Mesh | null {
    this.params.noiseAmplitude = Math.max(0, Math.min(0.5, amplitude));
    return this.generate();
  }

  // Set base color
  setColorBase(color: Color3): Mesh | null {
    this.params.colorBase = color;
    return this.generate();
  }

  // Set detail color
  setColorDetail(color: Color3): Mesh | null {
    this.params.colorDetail = color;
    return this.generate();
  }

  // Get current params
  getParams(): AssetParams {
    return { ...this.params };
  }

  // Set all params at once
  setParams(params: Partial<AssetParams>): Mesh | null {
    this.params = { ...this.params, ...params };
    return this.generate();
  }

  // Set update callback
  setOnUpdate(callback: (params: AssetParams) => void): void {
    this.onUpdate = callback;
  }

  // Get current mesh
  getMesh(): Mesh | null {
    return this.currentMesh;
  }

  dispose(): void {
    if (this.currentAsset) {
      this.currentAsset.dispose();
      this.currentAsset = null;
      this.currentMesh = null;
    }
  }
}

/**
 * Create a mini preview scene for the asset generator UI
 */
export function createPreviewScene(
  canvas: HTMLCanvasElement
): { scene: Scene; camera: ArcRotateCamera; dispose: () => void } {
  const engine = new (BABYLON as any).Engine(canvas, true, {
    preserveDrawingBuffer: true,
    stencil: true,
  });

  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.15, 0.15, 0.18, 1);

  // Camera
  const camera = new ArcRotateCamera(
    "previewCamera",
    -Math.PI / 4,
    Math.PI / 3,
    5,
    Vector3.Zero(),
    scene
  );
  camera.attachControl(canvas, true);
  camera.lowerRadiusLimit = 1;
  camera.upperRadiusLimit = 15;
  camera.wheelPrecision = 50;

  // Lighting
  const hemiLight = new HemisphericLight("hemiLight", new Vector3(0, 1, 0), scene);
  hemiLight.intensity = 0.6;
  hemiLight.groundColor = new Color3(0.3, 0.3, 0.35);

  // Render loop
  engine.runRenderLoop(() => {
    scene.render();
  });

  // Resize handler
  const handleResize = () => engine.resize();
  window.addEventListener("resize", handleResize);

  const dispose = () => {
    window.removeEventListener("resize", handleResize);
    scene.dispose();
    engine.dispose();
  };

  return { scene, camera, dispose };
}

import * as BABYLON from "@babylonjs/core";
