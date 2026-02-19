/**
 * WorldLoader Types
 *
 * Independent type definitions for loading world data
 * Compatible with existing JSON export format
 */

// ============================================
// Tile Connections
// ============================================

export interface TileConnections {
  left?: string;
  right?: string;
  top?: string;
  bottom?: string;
}

// ============================================
// Decoded Data (Runtime Usage)
// ============================================

/**
 * Decoded tile data ready for use in Three.js
 */
export interface DecodedTileData {
  id: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  resolution: number;
  size: number;

  // Decoded Float32Arrays
  heightmap: Float32Array;
  splatmap: Float32Array;
  waterMask: Float32Array;

  seaLevel: number;
  waterDepth: number;

  // Foliage: type -> decoded 4x4 matrices
  foliage: Map<string, Float32Array>;

  connections: TileConnections;
}

/**
 * Decoded world project
 */
export interface DecodedWorldProject {
  version: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  rendering: DecodedRenderingConfig;

  mainTile: DecodedTileData | null;
  tiles: Map<string, DecodedTileData>;

  worldGrid: WorldGridConfig | null;

  materials: MaterialSlot[];
  settings: WorldSettings;
  weather: WeatherData | null;

  /** User-placed GLB assets */
  props: PropInstance[];
  /** Procedural props (tree, rock, bush, grass_clump) */
  proceduralProps: ProceduralPropInstance[];
  /** Point lights */
  pointLights: SerializedPointLight[];
}

// ============================================
// Serialized Data (JSON Storage)
// ============================================

/**
 * Serialized tile data (Base64 encoded)
 * Compatible with existing ManualTileManager format
 */
export interface SerializedTileData {
  id: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  resolution: number;
  size: number;
  heightmap: string; // Base64
  splatmap: string; // Base64
  waterMask: string; // Base64
  seaLevel: number;
  waterDepth: number;
  foliageData?: Record<string, string>; // type -> Base64 matrices
  connections: TileConnections;
}

/**
 * Serialized world project
 * Compatible with existing exportWorldProject format
 */
export interface SerializedWorldProject {
  version: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  rendering: SerializedRenderingConfig;

  // Single tile export format
  terrain?: {
    size: number;
    resolution: number;
    heightmap: string;
    splatmap: string;
    waterMask?: string;
    seaLevel?: number;
  };

  // Full world export format
  mainTile?: {
    terrain: {
      size: number;
      resolution: number;
      heightmap: string;
      splatmap: string;
      waterMask: string;
    };
    foliage: Record<string, string>;
  };

  tiles?: SerializedTileData[];

  worldGrid?: WorldGridConfig;

  materials: {
    slots: MaterialSlot[];
  };

  settings: {
    seamlessTiling: boolean;
    waterLevel: number;
    waterDepth?: number;
    dispStrength?: number;
    waterType?: "lake" | "river";
    waterFlowAngle?: number;
  };

  weather?: WeatherData;

  foliage?: Record<string, string>;
  props?: PropInstance[];
  proceduralProps?: ProceduralPropInstance[];
  pointLights?: SerializedPointLight[];
}

// ============================================
// Rendering Profile (v2.0.0)
// ============================================

export interface RenderingTextureUrls {
  grass: string;
  dirt: string;
  rock: string;
  sand: string;
  leafAtlas: string;
}

export interface SerializedRenderingConfig {
  leafAtlas: string;
  foliageProfileVersion: string;
  proceduralProfileVersion: string;
  textureUrls: RenderingTextureUrls;
}

export interface DecodedRenderingConfig {
  leafAtlas: string;
  foliageProfileVersion: string;
  proceduralProfileVersion: string;
  textureUrls: RenderingTextureUrls;
}

// ============================================
// Weather Data
// ============================================

export type WeatherPreset = "clear" | "cloudy" | "rainy" | "stormy" | "snowy";

export interface WeatherData {
  timeOfDay: number;              // 0-24 hours
  weatherPreset: WeatherPreset;
  cloudCoverage: number;          // 0-1
  precipitationIntensity: number; // 0-1
  windSpeed: number;              // 0-1
  windDirection: number;          // 0-360 degrees
  fogDensity: number;             // 0-1
}

// ============================================
// World Configuration
// ============================================

export interface WorldGridConfig {
  infinitePool: PoolTileEntry[];
  manualPlacements: TilePlacement[];
  gridSize: number;
}

export interface PoolTileEntry {
  tileId: string;
  weight: number;
  enabled: boolean;
}

export interface TilePlacement {
  gridX: number;
  gridY: number;
  tileId: string;
}

export interface WorldSettings {
  seamlessTiling: boolean;
  waterLevel: number;
  waterDepth: number;
  dispStrength?: number;
  waterType?: "lake" | "river";
  waterFlowAngle?: number;
}

// ============================================
// Materials & Props
// ============================================

export interface MaterialSlot {
  channel: 0 | 1 | 2 | 3;
  name: string;
}

export interface PropInstance {
  id: string;
  name: string;
  glbPath?: string;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
}

export type HanokPlanPreset =
  | "auto"
  | "linear"
  | "l_shape"
  | "u_shape"
  | "courtyard";

/**
 * Procedural prop instance (tree, rock, bush, grass_clump)
 * Generated by PropManager using ProceduralAsset
 */
export interface ProceduralPropInstance {
  id: string;
  assetType:
    | "rock"
    | "tree"
    | "bush"
    | "grass_clump"
    | "hanok_giwa"
    | "hanok_choga"
    | "wall_fence_segment"
    | "jangdokdae_set"
    | "doghouse";
  params: {
    type: string;
    seed: number;
    size: number;
    sizeVariation: number;
    noiseScale: number;
    noiseAmplitude: number;
    length?: number;
    width?: number;
    height?: number;
    baySize?: number;
    planPreset?: HanokPlanPreset;
    colorBase: { r: number; g: number; b: number };
    colorDetail: { r: number; g: number; b: number };
  };
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
}

// ============================================
// Point Lights
// ============================================

export interface SerializedPointLight {
  id: string;
  position: { x: number; y: number; z: number };
  color: { r: number; g: number; b: number };
  intensity: number;
  range: number;
}

// ============================================
// Load Options & Results
// ============================================

export interface LoadOptions {
  /** Validate JSON schema before decoding */
  validateSchema?: boolean;
  /** Skip foliage data (faster load) */
  skipFoliage?: boolean;
  /** Only load specific tile IDs */
  tileFilter?: string[];
}

export interface LoadResult<T> {
  success: boolean;
  data: T | null;
  errors: string[];
  warnings: string[];
}

// ============================================
// Metadata (Quick Extract)
// ============================================

export interface WorldMetadata {
  version?: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  resolution: number;
  size: number;
  tileCount?: number;
}

// ============================================
// Terrain Rendering
// ============================================

/**
 * Data required for terrain rendering
 * Can be extracted from DecodedTileData
 */
export interface TerrainRenderData {
  /** Heightmap data (resolution+1 x resolution+1) */
  heightmap: Float32Array;
  /** Heightmap resolution (e.g., 256 means 257x257 vertices) */
  resolution: number;

  /** Splatmap data (resolution x resolution x 4 RGBA channels) */
  splatmap: Float32Array;

  /** Water mask data (resolution x resolution) */
  waterMask: Float32Array;

  /** Terrain size in world units */
  size: number;

  /** Sea level height */
  seaLevel: number;
}

/**
 * Options for TerrainRenderer
 */
export interface TerrainRendererOptions {
  /** Enable LOD system (default: true) */
  lodEnabled?: boolean;
  /** Use shader material (default: true) */
  useShader?: boolean;
  /** Initial wireframe mode (default: false) */
  wireframe?: boolean;
  /** Displacement strength (default: 0.3) */
  dispStrength?: number;
  /** Biome texture URLs (optional - uses solid colors if not provided) */
  textures?: TerrainTextureUrls;
}

/**
 * URLs for terrain biome textures
 */
export interface TerrainTextureUrls {
  /** Grass texture (R channel) */
  grass?: string;
  /** Dirt texture (G channel) */
  dirt?: string;
  /** Rock texture (B channel) */
  rock?: string;
  /** Sand texture (A channel) */
  sand?: string;
  /** Texture tiling scale (default: 16) */
  tileScale?: number;
}

// ============================================
// Foliage Rendering
// ============================================

/**
 * Options for FoliageRenderer
 */
export interface FoliageRendererOptions {
  /** Chunk size in world units (default: 16) */
  chunkSize?: number;
  /** Maximum instances per chunk (default: 5000) */
  maxInstancesPerChunk?: number;
  /** Enable LOD culling (default: true) */
  lodEnabled?: boolean;
  /** LOD distances: { near, mid, far } */
  lodDistances?: { near: number; mid: number; far: number };
  /** Rendering profile information from world export */
  renderingProfile?: {
    foliageProfileVersion: string;
    proceduralProfileVersion: string;
  };
  /** Optional texture overrides */
  textureUrls?: Partial<RenderingTextureUrls>;
}
