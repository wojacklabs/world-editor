import * as THREE from "three";
import { disposeMesh } from "../../shared/rendering/threeHelpers";

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
  private scene: any;
  private config: LightningConfig;

  // Flash overlay
  private flashPlane: THREE.Mesh | null = null;
  private flashMaterial: THREE.MeshBasicMaterial | null = null;

  // State
  private enabled: boolean = false;
  private isFlashing: boolean = false;
  private nextStrikeTime: number = 0;
  private baseAmbientIntensity: number = 0.4;

  // Stored camera reference for positioning
  private camera: THREE.Camera | null = null;

  // Reference to scene light for ambient boost
  private hemisphericLight: THREE.HemisphereLight | null = null;

  constructor(scene: any, config: Partial<LightningConfig> = {}) {
    this.scene = scene;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  init(): void {
    this.findHemisphericLight();
    this.createFlashOverlay();
  }

  private findHemisphericLight(): void {
    this.scene.traverse((child: THREE.Object3D) => {
      if (child instanceof THREE.HemisphereLight && !this.hemisphericLight) {
        this.hemisphericLight = child;
        this.baseAmbientIntensity = child.intensity;
      }
    });
  }

  private createFlashOverlay(): void {
    // Create full-screen quad for flash effect
    const geo = new THREE.PlaneGeometry(100, 100);

    this.flashMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0.9, 0.92, 1.0),
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    });

    this.flashPlane = new THREE.Mesh(geo, this.flashMaterial);
    this.flashPlane.raycast = () => {};
    this.flashPlane.renderOrder = 9999; // Render on top
    this.flashPlane.visible = false;

    this.scene.add(this.flashPlane);
  }

  /** Set camera reference for flash positioning */
  setCamera(camera: THREE.Camera | null): void {
    this.camera = camera;
  }

  /** Call each frame */
  update(): void {
    if (!this.enabled) return;

    // Position flash plane in front of camera
    if (this.flashPlane && this.camera) {
      const forward = new THREE.Vector3(0, 0, -1);
      forward.applyQuaternion(this.camera.quaternion);
      this.flashPlane.position.copy(this.camera.position).addScaledVector(forward, 5);
      this.flashPlane.lookAt(this.camera.position);
    }

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

    flashSequence.forEach((flash) => {
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
      this.flashPlane.visible = true;
      this.flashMaterial.opacity = intensity * 0.4;
    }

    // Boost ambient light
    if (this.hemisphericLight) {
      this.hemisphericLight.intensity = this.baseAmbientIntensity + this.config.ambientBoost * intensityMultiplier;
    }
  }

  private endFlash(): void {
    // Fade out flash overlay
    if (this.flashPlane && this.flashMaterial) {
      this.flashMaterial.opacity = 0;
      this.flashPlane.visible = false;
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
    if (this.flashPlane) {
      disposeMesh(this.scene, this.flashPlane);
      this.flashPlane = null;
    }

    this.flashMaterial = null;
  }
}
