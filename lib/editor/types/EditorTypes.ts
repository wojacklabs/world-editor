import type { Vector3 } from "@babylonjs/core";

// Tool types
export type ToolType = "select" | "heightmap" | "biome" | "props";
export type HeightmapTool = "raise" | "lower" | "flatten" | "smooth";
export type MaterialType = "grass" | "dirt" | "rock" | "sand" | "water";
export type BiomeType = "grass" | "dirt" | "rock" | "sand" | "water";

// Procedural asset types
export type ProceduralAssetType = "rock" | "tree" | "bush" | "grass_clump";

export interface ProceduralAssetSettings {
  type: ProceduralAssetType;
  seed: number;
  size: number;
  sizeVariation: number;
  noiseScale: number;
  noiseAmplitude: number;
}

// Brush settings
export interface BrushSettings {
  size: number;
  strength: number;
  falloff: number; // 0-1, how quickly the effect diminishes at edges
}

// Heightmap data
export interface HeightmapData {
  resolution: number; // Number of vertices per side (e.g., 129 for 128 segments)
  scale: number; // World units size
  data: Float32Array; // Height values
  minHeight: number;
  maxHeight: number;
}

// Splat map for material blending
export interface SplatMapData {
  resolution: number;
  data: Float32Array; // RGBA channels for 4 materials
}

// Prop instance
export interface PropInstance {
  id: string;
  type: PropType;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
}

export type PropType = "tree_01" | "tree_02" | "rock_01" | "rock_02" | "ruin_01";

export interface PropDefinition {
  type: PropType;
  name: string;
  modelPath: string;
  thumbnail: string;
  category: "vegetation" | "rock" | "structure";
  defaultScale: { x: number; y: number; z: number };
}

// Material slot for terrain
export interface MaterialSlot {
  channel: 0 | 1 | 2 | 3;
  type: MaterialType;
  diffuseTexture: string;
  normalTexture?: string;
  tiling: number;
}

// Project file format
export interface WorldEditorProject {
  version: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  terrain: {
    size: number;
    resolution: number;
    heightmap: string; // Base64 encoded
    splatmap: string; // Base64 encoded
  };
  materials: {
    slots: MaterialSlot[];
  };
  props: PropInstance[];
  settings: {
    seamlessTiling: boolean;
    waterLevel: number;
  };
}

// Pending asset to place
export interface PendingAsset {
  type: "library" | "procedural";
  glbPath?: string;
  name: string;
  assetType?: ProceduralAssetType;
}

// Editor state
export interface EditorState {
  activeTool: ToolType;
  activeHeightmapTool: HeightmapTool;
  brushSettings: BrushSettings;
  selectedMaterial: MaterialType;
  selectedAssetType: ProceduralAssetType;
  assetSettings: ProceduralAssetSettings;
  selectedPropInstance: string | null;
  isModified: boolean;
  showGrid: boolean;
  showWireframe: boolean;
  // Placement mode
  pendingAsset: PendingAsset | null;
}

// Default values
export const DEFAULT_BRUSH_SETTINGS: BrushSettings = {
  size: 5,
  strength: 0.5,
  falloff: 0.5,
};

export const DEFAULT_ASSET_SETTINGS: ProceduralAssetSettings = {
  type: "rock",
  seed: Math.random() * 10000,
  size: 1.0,
  sizeVariation: 0.3,
  noiseScale: 3.0,
  noiseAmplitude: 0.2,
};

export const DEFAULT_EDITOR_STATE: EditorState = {
  activeTool: "heightmap",
  activeHeightmapTool: "raise",
  brushSettings: DEFAULT_BRUSH_SETTINGS,
  selectedMaterial: "grass",
  selectedAssetType: "rock",
  assetSettings: DEFAULT_ASSET_SETTINGS,
  selectedPropInstance: null,
  isModified: false,
  showGrid: true,
  showWireframe: false,
  pendingAsset: null,
};

export const PROP_DEFINITIONS: PropDefinition[] = [
  {
    type: "tree_01",
    name: "Pine Tree",
    modelPath: "/editor/models/props/tree_01.glb",
    thumbnail: "/editor/thumbnails/tree_01.png",
    category: "vegetation",
    defaultScale: { x: 1, y: 1, z: 1 },
  },
  {
    type: "tree_02",
    name: "Oak Tree",
    modelPath: "/editor/models/props/tree_02.glb",
    thumbnail: "/editor/thumbnails/tree_02.png",
    category: "vegetation",
    defaultScale: { x: 1, y: 1, z: 1 },
  },
  {
    type: "rock_01",
    name: "Boulder",
    modelPath: "/editor/models/props/rock_01.glb",
    thumbnail: "/editor/thumbnails/rock_01.png",
    category: "rock",
    defaultScale: { x: 1, y: 1, z: 1 },
  },
  {
    type: "rock_02",
    name: "Rock Cluster",
    modelPath: "/editor/models/props/rock_02.glb",
    thumbnail: "/editor/thumbnails/rock_02.png",
    category: "rock",
    defaultScale: { x: 1, y: 1, z: 1 },
  },
  {
    type: "ruin_01",
    name: "Stone Ruins",
    modelPath: "/editor/models/props/ruin_01.glb",
    thumbnail: "/editor/thumbnails/ruin_01.png",
    category: "structure",
    defaultScale: { x: 1, y: 1, z: 1 },
  },
];

export const MATERIAL_COLORS: Record<MaterialType, string> = {
  grass: "#4a7c23",
  dirt: "#8b6914",
  rock: "#6b6b6b",
  sand: "#c2a366",
  water: "#2d6a8f",
};
