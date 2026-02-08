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
import { DEFAULT_EDITOR_STATE } from "../types/EditorTypes";

const ASSET_DIMENSION_PRESETS: Record<
  ProceduralAssetType,
  { length: number; width: number; height: number; baySize: number }
> = {
  rock: { length: 2, width: 2, height: 2, baySize: 2.4 },
  tree: { length: 2, width: 2, height: 4, baySize: 2.4 },
  bush: { length: 1.5, width: 1.5, height: 1.2, baySize: 2.4 },
  grass_clump: { length: 1, width: 1, height: 0.6, baySize: 2.4 },
  hanok_giwa: { length: 10, width: 6, height: 2.6, baySize: 2.4 },
  hanok_choga: { length: 9, width: 5.4, height: 2.4, baySize: 2.2 },
  wall_fence_segment: { length: 6, width: 0.45, height: 1.6, baySize: 2.4 },
  jangdokdae_set: { length: 3.2, width: 2.2, height: 0.8, baySize: 2.4 },
  doghouse: { length: 1.7, width: 1.2, height: 1.3, baySize: 2.4 },
};

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
  setAssetLength: (length: number) => void;
  setAssetWidth: (width: number) => void;
  setAssetHeight: (height: number) => void;

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
        length: ASSET_DIMENSION_PRESETS[type].length,
        width: ASSET_DIMENSION_PRESETS[type].width,
        height: ASSET_DIMENSION_PRESETS[type].height,
        baySize: ASSET_DIMENSION_PRESETS[type].baySize,
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

  setAssetLength: (length) =>
    set((state) => ({
      assetSettings: {
        ...state.assetSettings,
        length: Math.max(0.5, Math.min(40, length)),
      },
    })),

  setAssetWidth: (width) =>
    set((state) => ({
      assetSettings: {
        ...state.assetSettings,
        width: Math.max(0.4, Math.min(30, width)),
      },
    })),

  setAssetHeight: (height) =>
    set((state) => ({
      assetSettings: {
        ...state.assetSettings,
        height: Math.max(0.4, Math.min(8, height)),
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
