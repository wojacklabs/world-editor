import { MeshData } from "./CustomMeshBuilder";

/**
 * Saved procedural asset definition
 */
export interface SavedAsset {
  id: string;
  name: string;
  description: string;
  type: "rock" | "tree" | "bush" | "grass_clump" | "custom";
  createdAt: string;
  modifiedAt: string;
  params: AssetParams;
  thumbnail?: string;  // Base64 encoded preview image
  tags: string[];
  meshData?: MeshData; // Custom mesh data from Claude Code
  glbPath?: string; // Local path to GLB file (e.g., "/assets/model.glb")
}

export interface AssetParams {
  type: string;
  seed: number;
  size: number;
  sizeVariation: number;
  noiseScale: number;
  noiseAmplitude: number;
  colorBase: { r: number; g: number; b: number };
  colorDetail: { r: number; g: number; b: number };
  // Type-specific params
  customParams?: Record<string, number | string | boolean>;
}

/**
 * Chat message for asset creation
 */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  assetPreview?: string;  // ID of generated asset preview
}

/**
 * Asset Library - manages saved procedural assets
 */
export class AssetLibrary {
  private static STORAGE_KEY = "world_editor_asset_library";
  private assets: Map<string, SavedAsset> = new Map();

  constructor() {
    this.loadFromStorage();
  }

  /**
   * Save a new asset to the library
   */
  saveAsset(asset: Omit<SavedAsset, "id" | "createdAt" | "modifiedAt">): SavedAsset {
    const id = this.generateId();
    const now = new Date().toISOString();

    const savedAsset: SavedAsset = {
      ...asset,
      id,
      createdAt: now,
      modifiedAt: now,
    };

    this.assets.set(id, savedAsset);
    this.saveToStorage();

    return savedAsset;
  }

  /**
   * Update an existing asset
   */
  updateAsset(id: string, updates: Partial<SavedAsset>): SavedAsset | null {
    const existing = this.assets.get(id);
    if (!existing) return null;

    const updated: SavedAsset = {
      ...existing,
      ...updates,
      id,  // Prevent ID change
      createdAt: existing.createdAt,  // Prevent creation date change
      modifiedAt: new Date().toISOString(),
    };

    this.assets.set(id, updated);
    this.saveToStorage();

    return updated;
  }

  /**
   * Delete an asset from the library
   */
  deleteAsset(id: string): boolean {
    const deleted = this.assets.delete(id);
    if (deleted) {
      this.saveToStorage();
    }
    return deleted;
  }

  /**
   * Get an asset by ID
   */
  getAsset(id: string): SavedAsset | null {
    return this.assets.get(id) || null;
  }

  /**
   * Get all assets
   */
  getAllAssets(): SavedAsset[] {
    return Array.from(this.assets.values()).sort(
      (a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime()
    );
  }

  /**
   * Search assets by name or tag
   */
  searchAssets(query: string): SavedAsset[] {
    const lowerQuery = query.toLowerCase();
    return this.getAllAssets().filter(
      (asset) =>
        asset.name.toLowerCase().includes(lowerQuery) ||
        asset.description.toLowerCase().includes(lowerQuery) ||
        asset.tags.some((tag) => tag.toLowerCase().includes(lowerQuery))
    );
  }

  /**
   * Get assets by type
   */
  getAssetsByType(type: SavedAsset["type"]): SavedAsset[] {
    return this.getAllAssets().filter((asset) => asset.type === type);
  }

  /**
   * Export library to JSON string
   */
  exportLibrary(): string {
    return JSON.stringify(Array.from(this.assets.values()), null, 2);
  }

  /**
   * Import library from JSON string
   */
  importLibrary(jsonString: string, merge: boolean = true): void {
    try {
      const imported: SavedAsset[] = JSON.parse(jsonString);

      if (!merge) {
        this.assets.clear();
      }

      for (const asset of imported) {
        if (asset.id && asset.name && asset.params) {
          // Generate new ID if merging and ID exists
          if (merge && this.assets.has(asset.id)) {
            asset.id = this.generateId();
          }
          this.assets.set(asset.id, asset);
        }
      }

      this.saveToStorage();
    } catch (e) {
      console.error("Failed to import asset library:", e);
      throw new Error("Invalid library format");
    }
  }

  /**
   * Load from localStorage
   */
  private loadFromStorage(): void {
    if (typeof window === "undefined") return;

    try {
      const stored = localStorage.getItem(AssetLibrary.STORAGE_KEY);
      if (stored) {
        const parsed: SavedAsset[] = JSON.parse(stored);
        for (const asset of parsed) {
          this.assets.set(asset.id, asset);
        }
      }
    } catch (e) {
      console.error("Failed to load asset library:", e);
    }
  }

  /**
   * Save to localStorage
   */
  private saveToStorage(): void {
    if (typeof window === "undefined") return;

    try {
      const data = JSON.stringify(Array.from(this.assets.values()));
      localStorage.setItem(AssetLibrary.STORAGE_KEY, data);
    } catch (e) {
      console.error("Failed to save asset library:", e);
    }
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return `asset_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get default params for asset type
   */
  static getDefaultParams(type: SavedAsset["type"]): AssetParams {
    const defaults: Record<SavedAsset["type"], Partial<AssetParams>> = {
      rock: {
        colorBase: { r: 0.4, g: 0.4, b: 0.42 },
        colorDetail: { r: 0.5, g: 0.5, b: 0.52 },
        noiseScale: 3.0,
        noiseAmplitude: 0.25,
      },
      tree: {
        colorBase: { r: 0.25, g: 0.5, b: 0.15 },
        colorDetail: { r: 0.35, g: 0.6, b: 0.2 },
        noiseScale: 2.0,
        noiseAmplitude: 0.15,
      },
      bush: {
        colorBase: { r: 0.2, g: 0.45, b: 0.12 },
        colorDetail: { r: 0.3, g: 0.55, b: 0.18 },
        noiseScale: 2.5,
        noiseAmplitude: 0.2,
      },
      grass_clump: {
        colorBase: { r: 0.28, g: 0.5, b: 0.15 },
        colorDetail: { r: 0.35, g: 0.6, b: 0.2 },
        noiseScale: 1.5,
        noiseAmplitude: 0.1,
      },
      custom: {
        colorBase: { r: 0.5, g: 0.5, b: 0.5 },
        colorDetail: { r: 0.6, g: 0.6, b: 0.6 },
        noiseScale: 2.0,
        noiseAmplitude: 0.2,
      },
    };

    return {
      type,
      seed: Math.random() * 10000,
      size: 1.0,
      sizeVariation: 0.3,
      noiseScale: defaults[type].noiseScale || 2.0,
      noiseAmplitude: defaults[type].noiseAmplitude || 0.2,
      colorBase: defaults[type].colorBase || { r: 0.5, g: 0.5, b: 0.5 },
      colorDetail: defaults[type].colorDetail || { r: 0.6, g: 0.6, b: 0.6 },
    };
  }
}

// Singleton instance
let libraryInstance: AssetLibrary | null = null;

export function getAssetLibrary(): AssetLibrary {
  if (!libraryInstance) {
    libraryInstance = new AssetLibrary();
  }
  return libraryInstance;
}
