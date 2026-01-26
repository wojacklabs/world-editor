/**
 * WorldLoader - Independent world data loader
 *
 * Features:
 * - No Babylon.js runtime dependency
 * - Browser/Node.js compatible
 * - JSON parsing + data decoding only (no rendering)
 * - Compatible with existing JSON export format
 */

import { DataCodec } from "./DataCodec";
import type {
  SerializedTileData,
  SerializedWorldProject,
  DecodedTileData,
  DecodedWorldProject,
  LoadOptions,
  LoadResult,
  WorldMetadata,
  TileConnections,
} from "./types";

export class WorldLoader {
  // ============================================
  // Main Load Methods
  // ============================================

  /**
   * Load a single tile from JSON string
   */
  static loadTile(
    json: string,
    options: LoadOptions = {}
  ): LoadResult<DecodedTileData> {
    const errors: string[] = [];
    const warnings: string[] = [];

    const parsed = DataCodec.parseJSON<SerializedTileData>(json);
    if (!parsed) {
      return {
        success: false,
        data: null,
        errors: ["Invalid JSON format"],
        warnings,
      };
    }

    // Schema validation
    if (options.validateSchema) {
      const schemaErrors = this.validateTileSchema(parsed);
      if (schemaErrors.length > 0) {
        return { success: false, data: null, errors: schemaErrors, warnings };
      }
    }

    try {
      const decoded = this.decodeTile(parsed, options);
      return { success: true, data: decoded, errors, warnings };
    } catch (e) {
      return {
        success: false,
        data: null,
        errors: [`Decode error: ${e}`],
        warnings,
      };
    }
  }

  /**
   * Load a full world project from JSON string
   */
  static loadWorld(
    json: string,
    options: LoadOptions = {}
  ): LoadResult<DecodedWorldProject> {
    const errors: string[] = [];
    const warnings: string[] = [];

    const parsed = DataCodec.parseJSON<SerializedWorldProject>(json);
    if (!parsed) {
      return {
        success: false,
        data: null,
        errors: ["Invalid JSON format"],
        warnings,
      };
    }

    // Schema validation
    if (options.validateSchema) {
      const schemaErrors = this.validateWorldSchema(parsed);
      if (schemaErrors.length > 0) {
        return { success: false, data: null, errors: schemaErrors, warnings };
      }
    }

    try {
      const decoded = this.decodeWorld(parsed, options);
      return { success: true, data: decoded, errors, warnings };
    } catch (e) {
      return {
        success: false,
        data: null,
        errors: [`Decode error: ${e}`],
        warnings,
      };
    }
  }

  /**
   * Load world from File object (browser only)
   * For Node.js, read the file yourself and use loadWorld() directly
   */
  static async loadWorldFromFile(
    file: File,
    options: LoadOptions = {}
  ): Promise<LoadResult<DecodedWorldProject>> {
    try {
      const json = await file.text();
      return this.loadWorld(json, options);
    } catch (e) {
      return {
        success: false,
        data: null,
        errors: [`File read error: ${e}`],
        warnings: [],
      };
    }
  }

  /**
   * Load a specific tile by ID from world JSON
   */
  static loadTileById(
    worldJson: string,
    tileId: string,
    options: LoadOptions = {}
  ): LoadResult<DecodedTileData> {
    const worldResult = this.loadWorld(worldJson, {
      ...options,
      tileFilter: [tileId],
    });

    if (!worldResult.success || !worldResult.data) {
      return {
        success: false,
        data: null,
        errors: worldResult.errors,
        warnings: worldResult.warnings,
      };
    }

    const tile = worldResult.data.tiles.get(tileId);
    if (!tile) {
      return {
        success: false,
        data: null,
        errors: [`Tile "${tileId}" not found`],
        warnings: [],
      };
    }

    return { success: true, data: tile, errors: [], warnings: [] };
  }

  // ============================================
  // Quick Extract Methods (No Full Decode)
  // ============================================

  /**
   * Extract only heightmap data (fast preview)
   */
  static extractHeightmap(tileJson: string): Float32Array | null {
    const parsed = DataCodec.parseJSON<SerializedTileData>(tileJson);
    if (!parsed?.heightmap) return null;
    return DataCodec.decodeHeightmap(parsed.heightmap);
  }

  /**
   * Extract metadata without full decode
   */
  static extractMetadata(json: string): WorldMetadata | null {
    const parsed = DataCodec.parseJSON<
      SerializedWorldProject | SerializedTileData
    >(json);
    if (!parsed) return null;

    // WorldProject format
    if ("version" in parsed) {
      return {
        version: parsed.version,
        name: parsed.name,
        createdAt: parsed.createdAt,
        modifiedAt: parsed.modifiedAt,
        resolution:
          parsed.terrain?.resolution ??
          parsed.mainTile?.terrain?.resolution ??
          0,
        size: parsed.terrain?.size ?? parsed.mainTile?.terrain?.size ?? 0,
        tileCount: parsed.tiles?.length ?? 0,
      };
    }

    // TileData format
    return {
      name: parsed.name,
      createdAt: parsed.createdAt,
      modifiedAt: parsed.modifiedAt,
      resolution: parsed.resolution,
      size: parsed.size,
    };
  }

  // ============================================
  // Private: Decode Methods
  // ============================================

  private static decodeTile(
    data: SerializedTileData,
    options: LoadOptions
  ): DecodedTileData {
    // Decode foliage
    const foliage = new Map<string, Float32Array>();
    if (!options.skipFoliage && data.foliageData) {
      for (const [type, base64] of Object.entries(data.foliageData)) {
        foliage.set(type, DataCodec.decodeFoliageInstances(base64));
      }
    }

    return {
      id: data.id,
      name: data.name,
      createdAt: data.createdAt,
      modifiedAt: data.modifiedAt,
      resolution: data.resolution,
      size: data.size,
      heightmap: DataCodec.decodeHeightmap(data.heightmap),
      splatmap: DataCodec.decodeFloat32Array(data.splatmap),
      waterMask: DataCodec.decodeFloat32Array(data.waterMask),
      seaLevel: data.seaLevel,
      waterDepth: data.waterDepth,
      foliage,
      connections: { ...data.connections },
    };
  }

  private static decodeWorld(
    data: SerializedWorldProject,
    options: LoadOptions
  ): DecodedWorldProject {
    const tiles = new Map<string, DecodedTileData>();

    // Tile filter
    const tileFilter = options.tileFilter ? new Set(options.tileFilter) : null;

    // Decode tiles array
    if (data.tiles) {
      for (const tileData of data.tiles) {
        if (tileFilter && !tileFilter.has(tileData.id)) continue;
        tiles.set(tileData.id, this.decodeTile(tileData, options));
      }
    }

    // Decode mainTile
    let mainTile: DecodedTileData | null = null;

    if (data.mainTile) {
      // Full world export format
      const mainFoliage = new Map<string, Float32Array>();
      if (!options.skipFoliage && data.mainTile.foliage) {
        for (const [type, base64] of Object.entries(data.mainTile.foliage)) {
          mainFoliage.set(type, DataCodec.decodeFoliageInstances(base64));
        }
      }

      mainTile = {
        id: "main",
        name: data.name,
        createdAt: data.createdAt,
        modifiedAt: data.modifiedAt,
        resolution: data.mainTile.terrain.resolution,
        size: data.mainTile.terrain.size,
        heightmap: DataCodec.decodeHeightmap(data.mainTile.terrain.heightmap),
        splatmap: DataCodec.decodeFloat32Array(data.mainTile.terrain.splatmap),
        waterMask: DataCodec.decodeFloat32Array(
          data.mainTile.terrain.waterMask
        ),
        seaLevel: data.settings.waterLevel,
        waterDepth: data.settings.waterDepth ?? 2.0,
        foliage: mainFoliage,
        connections: {},
      };
    } else if (data.terrain) {
      // Single tile export format
      const foliage = new Map<string, Float32Array>();
      if (!options.skipFoliage && data.foliage) {
        for (const [type, base64] of Object.entries(data.foliage)) {
          foliage.set(type, DataCodec.decodeFoliageInstances(base64));
        }
      }

      // Handle optional waterMask
      const resolution = data.terrain.resolution;
      const res = resolution + 1;
      const waterMask = data.terrain.waterMask
        ? DataCodec.decodeFloat32Array(data.terrain.waterMask)
        : new Float32Array(res * res);

      mainTile = {
        id: "main",
        name: data.name,
        createdAt: data.createdAt,
        modifiedAt: data.modifiedAt,
        resolution: data.terrain.resolution,
        size: data.terrain.size,
        heightmap: DataCodec.decodeHeightmap(data.terrain.heightmap),
        splatmap: DataCodec.decodeFloat32Array(data.terrain.splatmap),
        waterMask,
        seaLevel: data.settings.waterLevel,
        waterDepth: data.settings.waterDepth ?? 2.0,
        foliage,
        connections: {},
      };
    }

    return {
      version: data.version,
      name: data.name,
      createdAt: data.createdAt,
      modifiedAt: data.modifiedAt,
      mainTile,
      tiles,
      worldGrid: data.worldGrid ? { ...data.worldGrid } : null,
      materials: data.materials?.slots ?? [],
      settings: {
        seamlessTiling: data.settings.seamlessTiling,
        waterLevel: data.settings.waterLevel,
        waterDepth: data.settings.waterDepth ?? 2.0,
      },
    };
  }

  // ============================================
  // Private: Validation Methods
  // ============================================

  private static validateTileSchema(data: SerializedTileData): string[] {
    const errors: string[] = [];

    if (!data.id) errors.push("Missing required field: id");
    if (!data.name) errors.push("Missing required field: name");
    if (!data.heightmap) errors.push("Missing required field: heightmap");
    if (!data.splatmap) errors.push("Missing required field: splatmap");
    if (typeof data.resolution !== "number")
      errors.push("Invalid or missing: resolution");
    if (typeof data.size !== "number") errors.push("Invalid or missing: size");

    return errors;
  }

  private static validateWorldSchema(data: SerializedWorldProject): string[] {
    const errors: string[] = [];

    if (!data.version) errors.push("Missing required field: version");
    if (!data.name) errors.push("Missing required field: name");

    if (
      !data.terrain &&
      !data.mainTile &&
      (!data.tiles || data.tiles.length === 0)
    ) {
      errors.push("No terrain data found (terrain, mainTile, or tiles)");
    }

    return errors;
  }
}
