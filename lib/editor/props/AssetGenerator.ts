import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { ProceduralAsset, AssetParams, AssetType, DEFAULT_ASSET_PARAMS } from "./ProceduralAsset";

/**
 * AssetGenerator - Creates procedural assets with a preview scene
 * Used in the editor UI for asset creation and customization
 */
export class AssetGenerator {
  private scene: THREE.Scene;
  private currentAsset: ProceduralAsset | null = null;
  private currentMesh: THREE.Mesh | null = null;
  private params: AssetParams;
  private onUpdate: ((params: AssetParams) => void) | null = null;

  constructor(scene: THREE.Scene, type: AssetType = "rock") {
    this.scene = scene;
    this.params = { ...DEFAULT_ASSET_PARAMS[type] };
  }

  // Generate/regenerate the asset
  generate(): THREE.Mesh {
    if (this.currentAsset) {
      this.currentAsset.dispose();
    }

    this.currentAsset = new ProceduralAsset(this.scene, this.params);
    this.currentMesh = this.currentAsset.generate();

    this.onUpdate?.(this.params);

    return this.currentMesh;
  }

  // Randomize seed (dice button)
  randomize(): THREE.Mesh {
    this.params.seed = Math.random() * 10000;
    return this.generate();
  }

  // Set asset type
  setType(type: AssetType): THREE.Mesh {
    // Keep some params, reset type-specific ones
    const currentSize = this.params.size;
    this.params = { ...DEFAULT_ASSET_PARAMS[type] };
    this.params.size = currentSize; // Keep user-set size
    this.params.seed = Math.random() * 10000;
    return this.generate();
  }

  // Set size
  setSize(size: number): THREE.Mesh {
    this.params.size = Math.max(0.1, Math.min(10, size));
    return this.generate();
  }

  // Set size variation
  setSizeVariation(variation: number): THREE.Mesh {
    this.params.sizeVariation = Math.max(0, Math.min(1, variation));
    return this.generate();
  }

  // Set noise scale
  setNoiseScale(scale: number): THREE.Mesh {
    this.params.noiseScale = Math.max(0.5, Math.min(10, scale));
    return this.generate();
  }

  // Set noise amplitude
  setNoiseAmplitude(amplitude: number): THREE.Mesh {
    this.params.noiseAmplitude = Math.max(0, Math.min(0.5, amplitude));
    return this.generate();
  }

  // Set base color
  setColorBase(color: THREE.Color): THREE.Mesh {
    this.params.colorBase = color;
    return this.generate();
  }

  // Set detail color
  setColorDetail(color: THREE.Color): THREE.Mesh {
    this.params.colorDetail = color;
    return this.generate();
  }

  // Get current params
  getParams(): AssetParams {
    return { ...this.params };
  }

  // Set all params at once
  setParams(params: Partial<AssetParams>): THREE.Mesh {
    this.params = { ...this.params, ...params };
    return this.generate();
  }

  // Set update callback
  setOnUpdate(callback: (params: AssetParams) => void): void {
    this.onUpdate = callback;
  }

  // Get current mesh
  getMesh(): THREE.Mesh | null {
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
): { scene: THREE.Scene; camera: THREE.PerspectiveCamera; dispose: () => void } {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(canvas.clientWidth, canvas.clientHeight);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0.15, 0.15, 0.18);

  // Camera
  const camera = new THREE.PerspectiveCamera(
    50,
    canvas.clientWidth / canvas.clientHeight,
    0.1,
    100
  );
  camera.position.set(3, 3, 3);
  camera.lookAt(0, 0, 0);

  // OrbitControls
  const controls = new OrbitControls(camera, canvas);
  controls.minDistance = 1;
  controls.maxDistance = 15;

  // Lighting
  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x4d4d59, 0.6);
  scene.add(hemiLight);

  // Render loop
  let animFrameId = 0;
  const animate = () => {
    animFrameId = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  };
  animate();

  // Resize handler
  const handleResize = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  window.addEventListener("resize", handleResize);

  const dispose = () => {
    window.removeEventListener("resize", handleResize);
    cancelAnimationFrame(animFrameId);
    controls.dispose();
    renderer.dispose();
  };

  return { scene, camera, dispose };
}
