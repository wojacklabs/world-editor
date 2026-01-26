/**
 * WorldLoader Package
 *
 * Independent library for loading world editor data
 * Can be used in any Babylon.js or Three.js project
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
  TileConnections,
  WorldSettings,
  WorldMetadata,
} from "./types";

// Types - Serialized (Storage)
export type { SerializedTileData, SerializedWorldProject } from "./types";

// Types - Configuration
export type {
  WorldGridConfig,
  PoolTileEntry,
  TilePlacement,
  MaterialSlot,
  PropInstance,
} from "./types";

// Types - Load Options
export type { LoadOptions, LoadResult } from "./types";

// Types - Terrain Rendering
export type { TerrainRenderData, TerrainRendererOptions } from "./types";

// Types - Foliage Rendering
export type { FoliageRendererOptions } from "./types";

// Classes
export { DataCodec } from "./DataCodec";
export { WorldLoader } from "./WorldLoader";
export { TerrainRenderer } from "./TerrainRenderer";
export { FoliageRenderer } from "./FoliageRenderer";
