/**
 * WorldLoader Package
 *
 * Independent library for loading world editor data
 * Can be used in any Three.js project
 *
 * @example
 * ```typescript
 * import { WorldLoader, DecodedWorldProject } from "@world-editor/loader";
 *
 * const result = WorldLoader.loadWorld(jsonString);
 * if (result.success) {
 *   const world: DecodedWorldProject = result.data!;
 *   // Use world.mainTile.heightmap, etc.
 * }
 * ```
 */

// Types - Decoded (Runtime)
export type {
  DecodedTileData,
  DecodedWorldProject,
  DecodedRenderingConfig,
  TileConnections,
  WorldSettings,
  WorldMetadata,
  WeatherData,
  WeatherPreset,
} from "./types";

// Types - Serialized (Storage)
export type {
  SerializedTileData,
  SerializedWorldProject,
  SerializedRenderingConfig,
  RenderingTextureUrls,
} from "./types";

// Types - Configuration
export type {
  WorldGridConfig,
  PoolTileEntry,
  TilePlacement,
  MaterialSlot,
  PropInstance,
  ProceduralPropInstance,
} from "./types";

// Types - Load Options
export type { LoadOptions, LoadResult } from "./types";

// Types - Terrain Rendering
export type {
  TerrainRenderData,
  TerrainRendererOptions,
  TerrainTextureUrls,
} from "./types";

// Types - Foliage Rendering
export type { FoliageRendererOptions } from "./types";

// Classes
export { DataCodec } from "./DataCodec";
export { WorldLoader } from "./WorldLoader";
export { TerrainRenderer } from "./TerrainRenderer";
export { FoliageRenderer } from "./FoliageRenderer";
export { SkyWeatherRenderer } from "./SkyWeatherRenderer";
export type { SkyWeatherOptions } from "./SkyWeatherRenderer";
export { WaterRenderer } from "./WaterRenderer";
export type { WaterConfig } from "./WaterRenderer";
export { ProceduralPropsRenderer } from "./ProceduralPropsRenderer";
export type { ProceduralPropsRendererOptions } from "./ProceduralPropsRenderer";
export { GLBPropsRenderer } from "./GLBPropsRenderer";
export type { GLBPropsRendererOptions } from "./GLBPropsRenderer";
export { ProceduralAssetGenerator } from "./ProceduralAssetGenerator";
export type { GeneratorParams } from "./ProceduralAssetGenerator";

// Interactive Water (WebGPU Compute Shader) - temporarily excluded pending Three.js WebGPU compute support
