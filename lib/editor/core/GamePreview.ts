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
} from "@babylonjs/core";
import { Heightmap } from "../terrain/Heightmap";

export class GamePreview {
  private scene: Scene;
  private heightmap: Heightmap;
  private camera: FreeCamera | null = null;
  private tileClones: Mesh[] = [];
  private originalMesh: Mesh | null = null;

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

  constructor(scene: Scene, heightmap: Heightmap) {
    this.scene = scene;
    this.heightmap = heightmap;
  }

  enable(terrainMesh: Mesh): void {
    this.originalMesh = terrainMesh;

    // Create 3x3 tile grid
    this.createTileGrid();

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

    // Remove clones
    for (const clone of this.tileClones) {
      clone.dispose();
    }
    this.tileClones = [];

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

  private createTileGrid(): void {
    if (!this.originalMesh) return;

    const size = this.heightmap.getScale();

    // Refresh original mesh bounding info
    this.originalMesh.refreshBoundingInfo();

    // Create 3x3 grid (-1 to 1 in both directions)
    for (let x = -1; x <= 1; x++) {
      for (let z = -1; z <= 1; z++) {
        if (x === 0 && z === 0) continue; // Skip center (original)

        const clone = this.originalMesh.clone(`tile_${x}_${z}`);
        if (clone) {
          clone.position.x = x * size;
          clone.position.z = z * size;

          // Ensure clone has correct material and bounding info
          clone.material = this.originalMesh.material;
          clone.refreshBoundingInfo();

          // Disable frustum culling to ensure visibility
          clone.alwaysSelectAsActiveMesh = true;

          this.tileClones.push(clone);
        }
      }
    }

    // Also disable frustum culling on original
    this.originalMesh.alwaysSelectAsActiveMesh = true;
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
}
