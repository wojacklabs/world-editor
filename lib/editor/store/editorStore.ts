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
} from "../types/EditorTypes";
import { DEFAULT_EDITOR_STATE, DEFAULT_ASSET_SETTINGS } from "../types/EditorTypes";

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

  // Placement mode
  setPendingAsset: (asset: PendingAsset | null) => void;
  clearPendingAsset: () => void;

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

  setPendingAsset: (asset) => set({ pendingAsset: asset }),
  clearPendingAsset: () => set({ pendingAsset: null }),

  setModified: (modified) => set({ isModified: modified }),

  resetState: () => set(DEFAULT_EDITOR_STATE),
}));
