import {
  Scene,
  Vector3,
  Color3,
  Color4,
  ShaderMaterial,
  DirectionalLight,
  HemisphericLight,
  Observer,
} from "@babylonjs/core";
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
  private scene: Scene;
  private skyShader: ProceduralSkyShader | null = null;
  private cloudSystem: CloudSystem | null = null;
  private precipitationSystem: PrecipitationSystem | null = null;
  private lightningSystem: LightningSystem | null = null;
  private renderObserver: Observer<Scene> | null = null;

  // Current state
  private state: WeatherState;
  private isGameMode: boolean = false;

  // Computed values (derived from state)
  private sunDirection: Vector3 = new Vector3(0.5, 0.8, 0.3).normalize();
  private sunColor: Color3 = new Color3(1.0, 0.95, 0.85);
  private ambientIntensity: number = 0.4;
  private fogColor: Color3 = new Color3(0.6, 0.75, 0.9);
  private fogDensity: number = 0.008;
  private nightFactor: number = 0;

  // References to external systems for synchronization
  private terrainMaterial: ShaderMaterial | null = null;
  private waterMaterial: ShaderMaterial | null = null;
  private foliageSystem: FoliageSystem | null = null;
  private directionalLight: DirectionalLight | null = null;
  private hemisphericLight: HemisphericLight | null = null;

  // Dirty flag for batched updates
  private shadersDirty: boolean = true;

  constructor(scene: Scene, initialState?: Partial<WeatherState>) {
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

    // Register update loop
    this.renderObserver = this.scene.onBeforeRenderObservable.add(() => {
      this.update();
    });
  }

  private findSceneLights(): void {
    for (const light of this.scene.lights) {
      if (light instanceof DirectionalLight && !this.directionalLight) {
        this.directionalLight = light;
      } else if (light instanceof HemisphericLight && !this.hemisphericLight) {
        this.hemisphericLight = light;
      }
    }
  }

  private update(): void {
    if (this.shadersDirty) {
      this.recalculateDerivedValues();
      this.syncAllShaders();
      this.shadersDirty = false;
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
  setTerrainMaterial(material: ShaderMaterial | null): void {
    this.terrainMaterial = material;
    this.shadersDirty = true;
  }

  setWaterMaterial(material: ShaderMaterial | null): void {
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

    this.sunDirection = new Vector3(
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
    const baseFogDensity = this.isGameMode ? 0.015 : 0.008;
    this.fogDensity = this.state.fogDensity * preset.fogDensityMultiplier;
    if (this.nightFactor > 0) {
      this.fogDensity *= 1 + this.nightFactor * 0.5;
    }
  }

  private calculateSunColor(time: number): Color3 {
    const sunriseStart = 5, sunriseEnd = 7;
    const sunsetStart = 17, sunsetEnd = 19;

    let warmth = 0;
    if (time >= sunriseStart && time <= sunriseEnd) {
      warmth = 1 - (time - sunriseStart) / (sunriseEnd - sunriseStart);
    } else if (time >= sunsetStart && time <= sunsetEnd) {
      warmth = (time - sunsetStart) / (sunsetEnd - sunsetStart);
    }

    const dayColor = new Color3(1.0, 0.95, 0.85);
    const warmColor = new Color3(1.0, 0.6, 0.3);
    const nightColor = new Color3(0.3, 0.35, 0.5);

    let color = Color3.Lerp(dayColor, warmColor, warmth);
    color = Color3.Lerp(color, nightColor, this.nightFactor);

    // Weather affects sun color
    const preset = WEATHER_PRESETS[this.state.weatherPreset];
    const gray = new Color3(0.7, 0.7, 0.7);
    color = Color3.Lerp(color, gray, (1 - preset.sunIntensityMultiplier) * 0.5);

    return color;
  }

  private calculateFogColor(): Color3 {
    const dayFog = new Color3(0.7, 0.8, 0.9);
    const sunsetFog = new Color3(0.9, 0.7, 0.6);
    const nightFog = new Color3(0.1, 0.12, 0.18);

    // Calculate warmth for sunrise/sunset
    const time = this.state.timeOfDay;
    let warmth = 0;
    if ((time >= 5 && time <= 7) || (time >= 17 && time <= 19)) {
      warmth = 1 - Math.abs(time - (time < 12 ? 6 : 18));
    }

    let fogColor = Color3.Lerp(dayFog, sunsetFog, warmth);
    fogColor = Color3.Lerp(fogColor, nightFog, this.nightFactor);

    // Weather makes fog grayer
    const preset = WEATHER_PRESETS[this.state.weatherPreset];
    const grayFog = new Color3(0.5, 0.55, 0.6);
    fogColor = Color3.Lerp(fogColor, grayFog, this.state.cloudCoverage * 0.5);

    return fogColor;
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
    if (this.terrainMaterial) {
      this.terrainMaterial.setVector3("uSunDirection", this.sunDirection);
      this.terrainMaterial.setColor3("uSunColor", this.sunColor);
      this.terrainMaterial.setFloat("uAmbientIntensity", this.ambientIntensity);
      this.terrainMaterial.setColor3("uFogColor", this.fogColor);
      this.terrainMaterial.setFloat("uFogDensity", this.fogDensity);
    }

    // Update water shader
    if (this.waterMaterial) {
      this.waterMaterial.setVector3("uSunDirection", this.sunDirection);
      this.waterMaterial.setColor3("uSunColor", this.sunColor);
      this.waterMaterial.setColor3("uFogColor", this.fogColor);
      this.waterMaterial.setFloat("uFogDensity", this.fogDensity);
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
      this.directionalLight.direction = this.sunDirection.negate();
      this.directionalLight.diffuse = this.sunColor;
      this.directionalLight.intensity = 0.6 * preset.sunIntensityMultiplier * (1 - this.nightFactor * 0.8);
    }

    if (this.hemisphericLight) {
      this.hemisphericLight.intensity = this.ambientIntensity;
      // Adjust ground color for night
      const groundBrightness = 0.3 - this.nightFactor * 0.2;
      this.hemisphericLight.groundColor = new Color3(groundBrightness, groundBrightness, groundBrightness + 0.05);
    }
  }

  private updateSceneSettings(): void {
    // Update clear color to match sky horizon
    const horizonColor = this.skyShader?.getHorizonColor() || this.fogColor;
    this.scene.clearColor = new Color4(
      horizonColor.r,
      horizonColor.g,
      horizonColor.b,
      1.0
    );

    // Update scene fog (for built-in fog mode)
    if (this.isGameMode) {
      this.scene.fogMode = Scene.FOGMODE_EXP2;
      this.scene.fogDensity = this.fogDensity;
      this.scene.fogColor = this.fogColor;
    }
  }

  // Public getters
  getState(): WeatherState {
    return { ...this.state };
  }

  getSunDirection(): Vector3 {
    return this.sunDirection.clone();
  }

  getSunColor(): Color3 {
    return this.sunColor.clone();
  }

  getFogColor(): Color3 {
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

  getSkyHorizonColor(): Color3 {
    return this.skyShader?.getHorizonColor() || this.fogColor;
  }

  getSkyZenithColor(): Color3 {
    return this.skyShader?.getZenithColor() || new Color3(0.35, 0.55, 0.9);
  }

  getWindDirection(): Vector3 {
    const rad = (this.state.windDirection * Math.PI) / 180;
    return new Vector3(Math.cos(rad), 0, Math.sin(rad));
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
    if (this.renderObserver) {
      this.scene.onBeforeRenderObservable.remove(this.renderObserver);
      this.renderObserver = null;
    }

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
