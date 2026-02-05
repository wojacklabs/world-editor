import * as THREE from "three";
import { ProceduralSkyShader } from "./ProceduralSkyShader";
import { CloudSystem } from "./CloudSystem";
import { PrecipitationSystem, type PrecipitationType } from "./PrecipitationSystem";
import { LightningSystem } from "./LightningSystem";
import type { WeatherState, WeatherPreset } from "../types/EditorTypes";
import type { FoliageSystem } from "../foliage/FoliageSystem";

// Weather preset configurations
interface WeatherConfig {
  cloudCoverage: number;
  fogDensityMultiplier: number;
  precipitationIntensity: number;
  windSpeedMultiplier: number;
  ambientMultiplier: number;
  sunIntensityMultiplier: number;
}

const WEATHER_PRESETS: Record<WeatherPreset, WeatherConfig> = {
  clear: {
    cloudCoverage: 0.2,
    fogDensityMultiplier: 1.0,
    precipitationIntensity: 0,
    windSpeedMultiplier: 0.5,
    ambientMultiplier: 1.0,
    sunIntensityMultiplier: 1.0,
  },
  cloudy: {
    cloudCoverage: 0.6,
    fogDensityMultiplier: 1.3,
    precipitationIntensity: 0,
    windSpeedMultiplier: 0.8,
    ambientMultiplier: 0.85,
    sunIntensityMultiplier: 0.7,
  },
  rainy: {
    cloudCoverage: 0.85,
    fogDensityMultiplier: 2.0,
    precipitationIntensity: 0.7,
    windSpeedMultiplier: 1.2,
    ambientMultiplier: 0.6,
    sunIntensityMultiplier: 0.4,
  },
  stormy: {
    cloudCoverage: 0.95,
    fogDensityMultiplier: 2.5,
    precipitationIntensity: 1.0,
    windSpeedMultiplier: 2.0,
    ambientMultiplier: 0.4,
    sunIntensityMultiplier: 0.2,
  },
  snowy: {
    cloudCoverage: 0.75,
    fogDensityMultiplier: 1.8,
    precipitationIntensity: 0.6,
    windSpeedMultiplier: 0.6,
    ambientMultiplier: 0.8,
    sunIntensityMultiplier: 0.5,
  },
};

export class SkyWeatherSystem {
  private scene: any;
  private skyShader: ProceduralSkyShader | null = null;
  private cloudSystem: CloudSystem | null = null;
  private precipitationSystem: PrecipitationSystem | null = null;
  private lightningSystem: LightningSystem | null = null;

  // Current state
  private state: WeatherState;
  private isGameMode: boolean = false;

  // Computed values (derived from state)
  private sunDirection: THREE.Vector3 = new THREE.Vector3(0.5, 0.8, 0.3).normalize();
  private sunColor: THREE.Color = new THREE.Color(1.0, 0.95, 0.85);
  private ambientIntensity: number = 0.4;
  private fogColor: THREE.Color = new THREE.Color(0.6, 0.75, 0.9);
  private fogDensity: number = 0.008;
  private nightFactor: number = 0;

  // References to external systems for synchronization
  // TODO: Restore THREE.ShaderMaterial type after EditorEngine migration
  private terrainMaterial: any = null;
  private waterMaterial: any = null;
  private foliageSystem: FoliageSystem | null = null;
  private directionalLight: THREE.DirectionalLight | null = null;
  private hemisphericLight: THREE.HemisphereLight | null = null;

  // Stored camera reference
  private camera: THREE.Camera | null = null;

  // Dirty flag for batched updates
  private shadersDirty: boolean = true;

  constructor(scene: any, initialState?: Partial<WeatherState>) {
    this.scene = scene;
    this.state = {
      timeOfDay: 12,
      weatherPreset: "clear",
      cloudCoverage: 0.3,
      precipitationIntensity: 0,
      windSpeed: 0.2,
      windDirection: 45,
      fogDensity: 0.008,
      ...initialState,
    };
  }

  init(): void {
    // Create procedural sky (includes integrated procedural clouds)
    this.skyShader = new ProceduralSkyShader(this.scene);
    this.skyShader.init();

    // Legacy cloud system - kept for compatibility but disabled
    // Clouds are now rendered as part of the sky shader
    this.cloudSystem = new CloudSystem(this.scene);
    this.cloudSystem.init();
    this.cloudSystem.setEnabled(false);

    // Create precipitation system
    this.precipitationSystem = new PrecipitationSystem(this.scene);
    this.precipitationSystem.init();

    // Create lightning system
    this.lightningSystem = new LightningSystem(this.scene);
    this.lightningSystem.init();

    // Find existing lights
    this.findSceneLights();

    // Calculate initial values
    this.recalculateDerivedValues();
    this.syncAllShaders();
  }

  private findSceneLights(): void {
    this.scene.traverse((child: THREE.Object3D) => {
      if (child instanceof THREE.DirectionalLight && !this.directionalLight) {
        this.directionalLight = child;
      } else if (child instanceof THREE.HemisphereLight && !this.hemisphericLight) {
        this.hemisphericLight = child;
      }
    });
  }

  /** Set camera reference for subsystems */
  setCamera(camera: THREE.Camera | null): void {
    this.camera = camera;
    if (this.precipitationSystem) {
      this.precipitationSystem.setCamera(camera);
    }
    if (this.lightningSystem) {
      this.lightningSystem.setCamera(camera);
    }
  }

  /** Call each frame from the render loop */
  update(): void {
    if (this.shadersDirty) {
      this.recalculateDerivedValues();
      this.syncAllShaders();
      this.shadersDirty = false;
    }

    // Update subsystems each frame
    if (this.skyShader) {
      this.skyShader.update();
    }
    if (this.cloudSystem) {
      this.cloudSystem.update(this.camera ?? undefined);
    }
    if (this.precipitationSystem) {
      this.precipitationSystem.update();
    }
    if (this.lightningSystem) {
      this.lightningSystem.update();
    }
  }

  // State setters
  setTimeOfDay(time: number): void {
    this.state.timeOfDay = Math.max(0, Math.min(24, time));
    this.shadersDirty = true;
  }

  setWeatherPreset(preset: WeatherPreset): void {
    this.state.weatherPreset = preset;
    const config = WEATHER_PRESETS[preset];
    this.state.cloudCoverage = config.cloudCoverage;
    this.state.precipitationIntensity = config.precipitationIntensity;
    this.shadersDirty = true;
  }

  setCloudCoverage(coverage: number): void {
    this.state.cloudCoverage = Math.max(0, Math.min(1, coverage));
    this.shadersDirty = true;
  }

  setPrecipitationIntensity(intensity: number): void {
    this.state.precipitationIntensity = Math.max(0, Math.min(1, intensity));
    this.shadersDirty = true;
  }

  setWindSpeed(speed: number): void {
    this.state.windSpeed = Math.max(0, Math.min(1, speed));
    this.shadersDirty = true;
  }

  setWindDirection(direction: number): void {
    this.state.windDirection = Math.max(0, Math.min(360, direction));
    this.shadersDirty = true;
  }

  setFogDensity(density: number): void {
    this.state.fogDensity = Math.max(0, Math.min(0.1, density));
    this.shadersDirty = true;
  }

  updateState(partialState: Partial<WeatherState>): void {
    Object.assign(this.state, partialState);
    this.shadersDirty = true;
  }

  // Register external systems for synchronization
  // TODO: Restore THREE.ShaderMaterial type after EditorEngine migration
  setTerrainMaterial(material: any): void {
    this.terrainMaterial = material;
    this.shadersDirty = true;
  }

  setWaterMaterial(material: any): void {
    this.waterMaterial = material;
    this.shadersDirty = true;
  }

  setFoliageSystem(system: FoliageSystem | null): void {
    this.foliageSystem = system;
    this.shadersDirty = true;
  }

  setGameMode(enabled: boolean): void {
    this.isGameMode = enabled;
    this.shadersDirty = true;
  }

  // Calculate all derived values from state
  private recalculateDerivedValues(): void {
    const time = this.state.timeOfDay;
    const preset = WEATHER_PRESETS[this.state.weatherPreset];

    // Calculate sun position from time of day
    // Sun rises at 6, peaks at 12, sets at 18
    const hourAngle = (time - 12) * (Math.PI / 12);
    const elevation = Math.cos(hourAngle) * 0.8;
    const azimuth = Math.sin(hourAngle);

    this.sunDirection.set(
      azimuth * 0.5,
      Math.max(elevation, -0.3),
      0.3
    ).normalize();

    // Calculate night factor (0 = day, 1 = night)
    // Night starts at 20 and ends at 5
    if (time < 5 || time > 20) {
      const nightProgress = time < 12 ? (5 - time) / 5 : (time - 20) / 4;
      this.nightFactor = Math.min(1, Math.max(0, nightProgress));
    } else if (time < 7 || time > 18) {
      // Twilight
      const twilightProgress = time < 12 ? (7 - time) / 2 : (time - 18) / 2;
      this.nightFactor = Math.min(0.5, Math.max(0, twilightProgress));
    } else {
      this.nightFactor = 0;
    }

    // Calculate sun color based on time
    this.sunColor = this.calculateSunColor(time);

    // Calculate ambient intensity
    const dayFactor = Math.max(0, Math.cos(hourAngle));
    this.ambientIntensity = (0.2 + dayFactor * 0.4) * preset.ambientMultiplier;

    // Calculate fog color (matches horizon)
    this.fogColor = this.calculateFogColor();

    // Calculate fog density
    this.fogDensity = this.state.fogDensity * preset.fogDensityMultiplier;
    if (this.nightFactor > 0) {
      this.fogDensity *= 1 + this.nightFactor * 0.5;
    }
  }

  private calculateSunColor(time: number): THREE.Color {
    const sunriseStart = 5, sunriseEnd = 7;
    const sunsetStart = 17, sunsetEnd = 19;

    let warmth = 0;
    if (time >= sunriseStart && time <= sunriseEnd) {
      warmth = 1 - (time - sunriseStart) / (sunriseEnd - sunriseStart);
    } else if (time >= sunsetStart && time <= sunsetEnd) {
      warmth = (time - sunsetStart) / (sunsetEnd - sunsetStart);
    }

    const dayColor = new THREE.Color(1.0, 0.95, 0.85);
    const warmColor = new THREE.Color(1.0, 0.6, 0.3);
    const nightColor = new THREE.Color(0.3, 0.35, 0.5);

    const color = dayColor.clone().lerp(warmColor, warmth);
    color.lerp(nightColor, this.nightFactor);

    // Weather affects sun color
    const preset = WEATHER_PRESETS[this.state.weatherPreset];
    const gray = new THREE.Color(0.7, 0.7, 0.7);
    color.lerp(gray, (1 - preset.sunIntensityMultiplier) * 0.5);

    return color;
  }

  private calculateFogColor(): THREE.Color {
    const dayFog = new THREE.Color(0.7, 0.8, 0.9);
    const sunsetFog = new THREE.Color(0.9, 0.7, 0.6);
    const nightFog = new THREE.Color(0.1, 0.12, 0.18);

    // Calculate warmth for sunrise/sunset
    const time = this.state.timeOfDay;
    let warmth = 0;
    if ((time >= 5 && time <= 7) || (time >= 17 && time <= 19)) {
      warmth = 1 - Math.abs(time - (time < 12 ? 6 : 18));
    }

    const fogColor = dayFog.clone().lerp(sunsetFog, warmth);
    fogColor.lerp(nightFog, this.nightFactor);

    // Weather makes fog grayer
    const grayFog = new THREE.Color(0.5, 0.55, 0.6);
    fogColor.lerp(grayFog, this.state.cloudCoverage * 0.5);

    return fogColor;
  }

  /**
   * Sync uniforms to an external material (Babylon.js or Three.js).
   * TODO: Remove Babylon.js path after EditorEngine migration.
   */
  private syncExternalMaterial(material: any, uniforms: Record<string, any>): void {
    if (material.uniforms) {
      // Three.js ShaderMaterial
      for (const [key, val] of Object.entries(uniforms)) {
        const u = material.uniforms[key];
        if (!u) continue;
        if (typeof val === "number") {
          u.value = val;
        } else if (val && typeof val.clone === "function") {
          u.value.copy(val);
        }
      }
    } else if (typeof material.setFloat === "function") {
      // Babylon.js ShaderMaterial
      for (const [key, val] of Object.entries(uniforms)) {
        if (typeof val === "number") {
          material.setFloat(key, val);
        } else if (val && val.z !== undefined && val.y !== undefined && val.x !== undefined && val.w === undefined) {
          if (typeof material.setVector3 === "function") material.setVector3(key, val);
        } else if (val && val.r !== undefined) {
          if (typeof material.setColor3 === "function") material.setColor3(key, val);
        }
      }
    }
  }

  // Synchronize all shaders with current values
  private syncAllShaders(): void {
    // Update sky shader (now includes procedural clouds)
    if (this.skyShader) {
      this.skyShader.setSunDirection(this.sunDirection);
      this.skyShader.setSunColor(this.sunColor);
      this.skyShader.setTimeOfDay(this.state.timeOfDay);
      this.skyShader.setCloudCoverage(this.state.cloudCoverage);
      this.skyShader.setNightFactor(this.nightFactor);
      // Lower haze on clear days, more haze with cloud coverage
      this.skyShader.setHazeIntensity(0.1 + this.state.cloudCoverage * 0.4);
      this.skyShader.setWindSpeed(this.state.windSpeed);
      this.skyShader.setWindDirection(this.state.windDirection);
      // Pass precipitation intensity for rain/snow cloud effects
      this.skyShader.setPrecipitationIntensity(this.state.precipitationIntensity);
    }

    // Update terrain shader
    // TODO: Switch to Three.js uniform access after EditorEngine migration
    if (this.terrainMaterial) {
      this.syncExternalMaterial(this.terrainMaterial, {
        uSunDirection: this.sunDirection,
        uSunColor: this.sunColor,
        uAmbientIntensity: this.ambientIntensity,
        uFogColor: this.fogColor,
        uFogDensity: this.fogDensity,
      });
    }

    // Update water shader
    // TODO: Switch to Three.js uniform access after EditorEngine migration
    if (this.waterMaterial) {
      this.syncExternalMaterial(this.waterMaterial, {
        uSunDirection: this.sunDirection,
        uSunColor: this.sunColor,
        uFogColor: this.fogColor,
        uFogDensity: this.fogDensity,
      });
    }

    // Update foliage system
    if (this.foliageSystem) {
      this.foliageSystem.syncFogSettings(
        this.fogColor,
        this.fogDensity,
        5.0,
        0.1
      );
      // Update sun direction on foliage
      this.foliageSystem.syncSunDirection(this.sunDirection, this.sunColor);
    }

    // Cloud system is now integrated into sky shader - disable ground-based clouds
    if (this.cloudSystem) {
      this.cloudSystem.setEnabled(false);
    }

    // Update precipitation system
    if (this.precipitationSystem) {
      const preset = WEATHER_PRESETS[this.state.weatherPreset];
      const precipType: PrecipitationType =
        this.state.weatherPreset === "snowy" ? "snow" :
        (this.state.weatherPreset === "rainy" || this.state.weatherPreset === "stormy") ? "rain" : "none";

      this.precipitationSystem.setType(precipType);
      this.precipitationSystem.setIntensity(preset.precipitationIntensity);
      this.precipitationSystem.setWindDirection(this.getWindDirection());
      this.precipitationSystem.setWindSpeed(this.state.windSpeed * preset.windSpeedMultiplier);
    }

    // Update lightning system
    if (this.lightningSystem) {
      this.lightningSystem.setEnabled(this.state.weatherPreset === "stormy");
      this.lightningSystem.setBaseAmbientIntensity(this.ambientIntensity);
    }

    // Update scene lights
    this.updateSceneLights();

    // Update scene clear color and fog
    this.updateSceneSettings();
  }

  private updateSceneLights(): void {
    const preset = WEATHER_PRESETS[this.state.weatherPreset];

    if (this.directionalLight) {
      // Three.js DirectionalLight: position is where the light comes FROM, it shines toward (0,0,0) by default
      const negDir = this.sunDirection.clone().negate();
      this.directionalLight.position.copy(negDir);
      this.directionalLight.color.copy(this.sunColor);
      this.directionalLight.intensity = 0.6 * preset.sunIntensityMultiplier * (1 - this.nightFactor * 0.8);
    }

    if (this.hemisphericLight) {
      this.hemisphericLight.intensity = this.ambientIntensity;
      // Adjust ground color for night
      const groundBrightness = 0.3 - this.nightFactor * 0.2;
      this.hemisphericLight.groundColor.setRGB(
        groundBrightness,
        groundBrightness,
        groundBrightness + 0.05
      );
    }
  }

  private updateSceneSettings(): void {
    // Update clear color to match sky horizon
    const horizonColor = this.skyShader?.getHorizonColor() || this.fogColor;
    if (this.scene.background instanceof THREE.Color) {
      this.scene.background.copy(horizonColor);
    } else {
      this.scene.background = horizonColor.clone();
    }

    // Update scene fog (for built-in fog mode)
    if (this.isGameMode) {
      if (this.scene.fog instanceof THREE.FogExp2) {
        this.scene.fog.color.copy(this.fogColor);
        this.scene.fog.density = this.fogDensity;
      } else {
        this.scene.fog = new THREE.FogExp2(this.fogColor, this.fogDensity);
      }
    }
  }

  // Public getters
  getState(): WeatherState {
    return { ...this.state };
  }

  getSunDirection(): any {
    return this.sunDirection.clone();
  }

  getSunColor(): any {
    return this.sunColor.clone();
  }

  getFogColor(): any {
    return this.fogColor.clone();
  }

  getFogDensity(): number {
    return this.fogDensity;
  }

  getAmbientIntensity(): number {
    return this.ambientIntensity;
  }

  getNightFactor(): number {
    return this.nightFactor;
  }

  getSkyHorizonColor(): any {
    return this.skyShader?.getHorizonColor() || this.fogColor;
  }

  getSkyZenithColor(): any {
    return this.skyShader?.getZenithColor() || new THREE.Color(0.35, 0.55, 0.9);
  }

  getWindDirection(): THREE.Vector3 {
    const rad = (this.state.windDirection * Math.PI) / 180;
    return new THREE.Vector3(Math.cos(rad), 0, Math.sin(rad));
  }

  getWindSpeed(): number {
    const preset = WEATHER_PRESETS[this.state.weatherPreset];
    return this.state.windSpeed * preset.windSpeedMultiplier;
  }

  // For lightning system
  setTemporaryAmbient(intensity: number): void {
    if (this.hemisphericLight) {
      this.hemisphericLight.intensity = intensity;
    }
    // Reset after a short delay
    setTimeout(() => {
      if (this.hemisphericLight) {
        this.hemisphericLight.intensity = this.ambientIntensity;
      }
    }, 150);
  }

  dispose(): void {
    if (this.skyShader) {
      this.skyShader.dispose();
      this.skyShader = null;
    }

    if (this.cloudSystem) {
      this.cloudSystem.dispose();
      this.cloudSystem = null;
    }

    if (this.precipitationSystem) {
      this.precipitationSystem.dispose();
      this.precipitationSystem = null;
    }

    if (this.lightningSystem) {
      this.lightningSystem.dispose();
      this.lightningSystem = null;
    }

    this.terrainMaterial = null;
    this.waterMaterial = null;
    this.foliageSystem = null;
  }
}
