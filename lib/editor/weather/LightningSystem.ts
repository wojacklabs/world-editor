import {
  Scene,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Observer,
  HemisphericLight,
} from "@babylonjs/core";

interface LightningConfig {
  flashIntensity: number;
  flashDuration: number;  // milliseconds
  minInterval: number;    // seconds
  maxInterval: number;    // seconds
  ambientBoost: number;
}

const DEFAULT_CONFIG: LightningConfig = {
  flashIntensity: 0.9,
  flashDuration: 120,
  minInterval: 4,
  maxInterval: 12,
  ambientBoost: 1.5,
};

export class LightningSystem {
  private scene: Scene;
  private config: LightningConfig;
  private renderObserver: Observer<Scene> | null = null;

  // Flash overlay
  private flashPlane: Mesh | null = null;
  private flashMaterial: StandardMaterial | null = null;

  // State
  private enabled: boolean = false;
  private isFlashing: boolean = false;
  private nextStrikeTime: number = 0;
  private baseAmbientIntensity: number = 0.4;

  // Reference to scene light for ambient boost
  private hemisphericLight: HemisphericLight | null = null;

  constructor(scene: Scene, config: Partial<LightningConfig> = {}) {
    this.scene = scene;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  init(): void {
    this.findHemisphericLight();
    this.createFlashOverlay();

    // Register update loop
    this.renderObserver = this.scene.onBeforeRenderObservable.add(() => {
      this.update();
    });
  }

  private findHemisphericLight(): void {
    for (const light of this.scene.lights) {
      if (light instanceof HemisphericLight) {
        this.hemisphericLight = light;
        this.baseAmbientIntensity = light.intensity;
        break;
      }
    }
  }

  private createFlashOverlay(): void {
    // Create full-screen quad for flash effect
    // Position it close to camera and make it always face camera
    this.flashPlane = MeshBuilder.CreatePlane(
      "lightningFlash",
      { size: 100 },
      this.scene
    );

    this.flashMaterial = new StandardMaterial("lightningFlashMat", this.scene);
    this.flashMaterial.emissiveColor = new Color3(0.9, 0.92, 1.0);
    this.flashMaterial.disableLighting = true;
    this.flashMaterial.alpha = 0;
    this.flashMaterial.backFaceCulling = false;

    this.flashPlane.material = this.flashMaterial;
    this.flashPlane.isPickable = false;
    this.flashPlane.renderingGroupId = 3; // Render on top

    // Follow camera
    this.scene.onBeforeRenderObservable.add(() => {
      if (this.flashPlane && this.scene.activeCamera) {
        const camera = this.scene.activeCamera;
        // Position plane in front of camera
        const forward = camera.getForwardRay().direction;
        this.flashPlane.position = camera.position.add(forward.scale(5));
        this.flashPlane.lookAt(camera.position);
      }
    });

    this.flashPlane.setEnabled(false);
  }

  private update(): void {
    if (!this.enabled) return;

    const now = performance.now();

    // Check if it's time for a lightning strike
    if (!this.isFlashing && now >= this.nextStrikeTime) {
      this.triggerFlash();
    }
  }

  private triggerFlash(): void {
    if (this.isFlashing) return;
    this.isFlashing = true;

    // Multiple quick flashes for realism
    const flashSequence = [
      { delay: 0, intensity: 1.0 },
      { delay: 50, intensity: 0.3 },
      { delay: 100, intensity: 0.8 },
      { delay: 180, intensity: 0.2 },
    ];

    flashSequence.forEach((flash, index) => {
      setTimeout(() => {
        this.doFlash(flash.intensity);
      }, flash.delay);
    });

    // Schedule end of flash
    setTimeout(() => {
      this.endFlash();
    }, this.config.flashDuration + 200);

    // Schedule next strike
    this.scheduleNextStrike();
  }

  private doFlash(intensityMultiplier: number): void {
    const intensity = this.config.flashIntensity * intensityMultiplier;

    // Flash overlay
    if (this.flashPlane && this.flashMaterial) {
      this.flashPlane.setEnabled(true);
      this.flashMaterial.alpha = intensity * 0.4;
    }

    // Boost ambient light
    if (this.hemisphericLight) {
      this.hemisphericLight.intensity = this.baseAmbientIntensity + this.config.ambientBoost * intensityMultiplier;
    }
  }

  private endFlash(): void {
    // Fade out flash overlay
    if (this.flashPlane && this.flashMaterial) {
      this.flashMaterial.alpha = 0;
      this.flashPlane.setEnabled(false);
    }

    // Reset ambient light
    if (this.hemisphericLight) {
      this.hemisphericLight.intensity = this.baseAmbientIntensity;
    }

    this.isFlashing = false;
  }

  private scheduleNextStrike(): void {
    const interval = this.config.minInterval +
      Math.random() * (this.config.maxInterval - this.config.minInterval);
    this.nextStrikeTime = performance.now() + interval * 1000;
  }

  // Public setters
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) {
      this.scheduleNextStrike();
    } else {
      this.endFlash();
    }
  }

  setBaseAmbientIntensity(intensity: number): void {
    this.baseAmbientIntensity = intensity;
  }

  setIntensity(intensity: number): void {
    this.config.flashIntensity = Math.max(0, Math.min(1, intensity));
  }

  setInterval(min: number, max: number): void {
    this.config.minInterval = Math.max(1, min);
    this.config.maxInterval = Math.max(min + 1, max);
  }

  // Trigger a manual flash (for testing or dramatic moments)
  triggerManualFlash(): void {
    if (!this.isFlashing) {
      this.triggerFlash();
    }
  }

  dispose(): void {
    if (this.renderObserver) {
      this.scene.onBeforeRenderObservable.remove(this.renderObserver);
      this.renderObserver = null;
    }

    if (this.flashPlane) {
      this.flashPlane.dispose();
      this.flashPlane = null;
    }

    if (this.flashMaterial) {
      this.flashMaterial.dispose();
      this.flashMaterial = null;
    }
  }
}
