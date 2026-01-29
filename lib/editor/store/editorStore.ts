import { create } from "zustand";
import type {
  EditorState,
  ToolType,
  HeightmapTool,
  BrushSettings,
  MaterialType,
  ProceduralAssetType,
  ProceduralAssetSettings,
  PendingAsset,
  DebugVisibility,
  DebugRenderMode,
  WaterType,
  WeatherState,
  WeatherPreset,
} from "../types/EditorTypes";
import { DEFAULT_EDITOR_STATE, DEFAULT_ASSET_SETTINGS, DEFAULT_WEATHER_STATE } from "../types/EditorTypes";

interface EditorStore extends EditorState {
  // Tool actions
  setActiveTool: (tool: ToolType) => void;
  setActiveHeightmapTool: (tool: HeightmapTool) => void;

  // Brush actions
  setBrushSettings: (settings: Partial<BrushSettings>) => void;
  setBrushSize: (size: number) => void;
  setBrushStrength: (strength: number) => void;

  // Material actions
  setSelectedMaterial: (material: MaterialType) => void;

  // Asset actions
  setSelectedAssetType: (type: ProceduralAssetType) => void;
  setAssetSettings: (settings: Partial<ProceduralAssetSettings>) => void;
  randomizeAssetSeed: () => void;
  setAssetSize: (size: number) => void;

  // Prop instance actions
  setSelectedPropInstance: (id: string | null) => void;

  // View actions
  toggleGrid: () => void;
  toggleWireframe: () => void;

  // Debug visibility actions
  toggleDebugVisibility: (key: keyof DebugVisibility) => void;
  setDebugVisibility: (visibility: Partial<DebugVisibility>) => void;
  setDebugRenderMode: (mode: DebugRenderMode) => void;

  // Water type
  setWaterType: (type: WaterType) => void;
  setWaterFlowAngle: (angle: number) => void;

  // Placement mode
  setPendingAsset: (asset: PendingAsset | null) => void;
  clearPendingAsset: () => void;

  // Weather actions
  setTimeOfDay: (time: number) => void;
  setWeatherPreset: (preset: WeatherPreset) => void;
  setCloudCoverage: (coverage: number) => void;
  setPrecipitationIntensity: (intensity: number) => void;
  setWindSpeed: (speed: number) => void;
  setWindDirection: (direction: number) => void;
  setFogDensity: (density: number) => void;
  updateWeather: (weather: Partial<WeatherState>) => void;

  // Project state
  setModified: (modified: boolean) => void;
  resetState: () => void;
}

export const useEditorStore = create<EditorStore>((set) => ({
  ...DEFAULT_EDITOR_STATE,

  setActiveTool: (tool) =>
    set({ activeTool: tool, selectedPropInstance: null }),

  setActiveHeightmapTool: (tool) => set({ activeHeightmapTool: tool }),

  setBrushSettings: (settings) =>
    set((state) => ({
      brushSettings: { ...state.brushSettings, ...settings },
    })),

  setBrushSize: (size) =>
    set((state) => ({
      brushSettings: { ...state.brushSettings, size: Math.max(1, Math.min(50, size)) },
    })),

  setBrushStrength: (strength) =>
    set((state) => ({
      brushSettings: {
        ...state.brushSettings,
        strength: Math.max(0.01, Math.min(1, strength)),
      },
    })),

  setSelectedMaterial: (material) => set({ selectedMaterial: material }),

  setSelectedAssetType: (type) =>
    set((state) => ({
      selectedAssetType: type,
      assetSettings: {
        ...state.assetSettings,
        type,
        // Keep same seed when switching types to preserve preview
      },
    })),

  setAssetSettings: (settings) =>
    set((state) => ({
      assetSettings: { ...state.assetSettings, ...settings },
    })),

  randomizeAssetSeed: () =>
    set((state) => ({
      assetSettings: {
        ...state.assetSettings,
        seed: Math.random() * 10000,
      },
    })),

  setAssetSize: (size) =>
    set((state) => ({
      assetSettings: {
        ...state.assetSettings,
        size: Math.max(0.1, Math.min(10, size)),
      },
    })),

  setSelectedPropInstance: (id) => set({ selectedPropInstance: id }),

  toggleGrid: () => set((state) => ({ showGrid: !state.showGrid })),

  toggleWireframe: () => set((state) => ({ showWireframe: !state.showWireframe })),

  toggleDebugVisibility: (key) =>
    set((state) => ({
      debugVisibility: {
        ...state.debugVisibility,
        [key]: !state.debugVisibility[key],
      },
    })),

  setDebugVisibility: (visibility) =>
    set((state) => ({
      debugVisibility: { ...state.debugVisibility, ...visibility },
    })),

  setDebugRenderMode: (mode) => set({ debugRenderMode: mode }),

  setWaterType: (type) => set({ waterType: type }),
  setWaterFlowAngle: (angle) => set({ waterFlowAngle: Math.max(0, Math.min(360, angle)) }),

  setPendingAsset: (asset) => set({ pendingAsset: asset }),
  clearPendingAsset: () => set({ pendingAsset: null }),

  // Weather actions
  setTimeOfDay: (time) =>
    set((state) => ({
      weather: { ...state.weather, timeOfDay: Math.max(0, Math.min(24, time)) },
    })),

  setWeatherPreset: (preset) =>
    set((state) => ({
      weather: { ...state.weather, weatherPreset: preset },
    })),

  setCloudCoverage: (coverage) =>
    set((state) => ({
      weather: { ...state.weather, cloudCoverage: Math.max(0, Math.min(1, coverage)) },
    })),

  setPrecipitationIntensity: (intensity) =>
    set((state) => ({
      weather: { ...state.weather, precipitationIntensity: Math.max(0, Math.min(1, intensity)) },
    })),

  setWindSpeed: (speed) =>
    set((state) => ({
      weather: { ...state.weather, windSpeed: Math.max(0, Math.min(1, speed)) },
    })),

  setWindDirection: (direction) =>
    set((state) => ({
      weather: { ...state.weather, windDirection: Math.max(0, Math.min(360, direction)) },
    })),

  setFogDensity: (density) =>
    set((state) => ({
      weather: { ...state.weather, fogDensity: Math.max(0, Math.min(0.1, density)) },
    })),

  updateWeather: (weather) =>
    set((state) => ({
      weather: { ...state.weather, ...weather },
    })),

  setModified: (modified) => set({ isModified: modified }),

  resetState: () => set(DEFAULT_EDITOR_STATE),
}));
