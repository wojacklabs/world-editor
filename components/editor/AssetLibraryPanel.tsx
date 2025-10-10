"use client";

import { useState, useEffect } from "react";
import {
  getAssetLibrary,
  SavedAsset,
} from "@/lib/editor/assets/AssetLibrary";
import { useEditorStore } from "@/lib/editor/store/editorStore";

interface AssetLibraryPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onAssetSelect?: (asset: SavedAsset) => void;
  onAssetDelete?: (id: string) => void;
}

type FilterType = "all" | "rock" | "tree" | "bush" | "grass_clump" | "custom";

export default function AssetLibraryPanel({
  isOpen,
  onClose,
  onAssetSelect,
  onAssetDelete,
}: AssetLibraryPanelProps) {
  const [assets, setAssets] = useState<SavedAsset[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState<FilterType>("all");
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);

  const library = getAssetLibrary();
  const { setPendingAsset } = useEditorStore();

  useEffect(() => {
    if (isOpen) {
      loadAssets();
    }
  }, [isOpen]);

  const loadAssets = () => {
    let result = library.getAllAssets();

    if (filterType !== "all") {
      result = result.filter((a) => a.type === filterType);
    }

    if (searchQuery.trim()) {
      result = library.searchAssets(searchQuery);
      if (filterType !== "all") {
        result = result.filter((a) => a.type === filterType);
      }
    }

    setAssets(result);
  };

  useEffect(() => {
    loadAssets();
  }, [searchQuery, filterType]);

  const handleDelete = (id: string) => {
    if (confirm("Delete this asset?")) {
      library.deleteAsset(id);
      loadAssets();
      onAssetDelete?.(id);
      if (selectedAssetId === id) {
        setSelectedAssetId(null);
      }
    }
  };

  const handlePlaceAsset = (asset: SavedAsset) => {
    setPendingAsset({
      type: "library",
      glbPath: asset.glbPath,
      name: asset.name,
    });
    onClose();
  };

  const handleExport = () => {
    const json = library.exportLibrary();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `asset_library_${new Date().toISOString().split("T")[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        try {
          const text = await file.text();
          library.importLibrary(text, true);
          loadAssets();
        } catch {
          alert("Invalid file format");
        }
      }
    };
    input.click();
  };

  const getTypeLabel = (type: string): string => {
    const labels: Record<string, string> = {
      rock: "Rock",
      tree: "Tree",
      bush: "Bush",
      grass_clump: "Grass",
      custom: "Generated",
    };
    return labels[type] || type;
  };

  if (!isOpen) return null;

  const selectedAsset = assets.find((a) => a.id === selectedAssetId);

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="w-[640px] max-h-[75vh] bg-zinc-950 rounded-xl border border-zinc-800/50 flex flex-col shadow-2xl">
        {/* Header */}
        <header className="px-5 py-4 border-b border-zinc-800/50 flex justify-between items-center">
          <div>
            <h2 className="text-sm font-medium text-zinc-200">Asset Library</h2>
            <p className="text-[11px] text-zinc-600 mt-0.5">{assets.length} assets</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleImport}
              className="px-3 py-1.5 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              Import
            </button>
            <button
              onClick={handleExport}
              className="px-3 py-1.5 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              Export
            </button>
            <button
              onClick={onClose}
              className="w-7 h-7 flex items-center justify-center text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </header>

        {/* Search & Filter */}
        <div className="px-5 py-3 border-b border-zinc-800/50 space-y-3">
          <div className="relative">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search..."
              className="w-full px-3 py-2 pl-9 bg-zinc-900 border border-zinc-800 rounded-lg text-sm text-zinc-300 placeholder-zinc-600 focus:border-zinc-700 focus:outline-none"
            />
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
          </div>
          <div className="flex gap-1">
            {(["all", "custom", "rock", "tree", "bush", "grass_clump"] as FilterType[]).map((type) => (
              <button
                key={type}
                onClick={() => setFilterType(type)}
                className={`px-3 py-1.5 text-[11px] rounded-md transition-all ${
                  filterType === type
                    ? "bg-zinc-800 text-zinc-200"
                    : "text-zinc-500 hover:text-zinc-400"
                }`}
              >
                {type === "all" ? "All" : type === "custom" ? "Generated" : getTypeLabel(type)}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Asset Grid */}
          <div className="flex-1 overflow-y-auto p-4">
            {assets.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-zinc-600">
                <p className="text-xs">No assets found</p>
                <p className="text-[10px] mt-1">Generate assets using the toolbar</p>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {assets.map((asset) => (
                  <button
                    key={asset.id}
                    onClick={() => setSelectedAssetId(asset.id === selectedAssetId ? null : asset.id)}
                    className={`p-3 rounded-lg text-left transition-all ${
                      selectedAssetId === asset.id
                        ? "bg-zinc-800 ring-1 ring-zinc-700"
                        : "bg-zinc-900/50 hover:bg-zinc-900"
                    }`}
                  >
                    <div className="aspect-square bg-zinc-800 rounded-md mb-2 flex items-center justify-center overflow-hidden">
                      {asset.thumbnail ? (
                        <img src={asset.thumbnail} alt={asset.name} className="w-full h-full object-cover" />
                      ) : (
                        <span className="text-[10px] text-zinc-600">{getTypeLabel(asset.type)}</span>
                      )}
                    </div>
                    <div className="text-xs text-zinc-300 truncate">{asset.name}</div>
                    <div className="text-[10px] text-zinc-600 mt-0.5">
                      {asset.type === "custom" ? "Generated" : getTypeLabel(asset.type)}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Selected Asset Details */}
          {selectedAsset && (
            <div className="w-48 border-l border-zinc-800/50 p-4 flex flex-col">
              <div className="flex-1">
                <div className="aspect-square bg-zinc-900 rounded-lg mb-3 flex items-center justify-center overflow-hidden">
                  {selectedAsset.thumbnail ? (
                    <img src={selectedAsset.thumbnail} alt={selectedAsset.name} className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-xs text-zinc-600">{getTypeLabel(selectedAsset.type)}</span>
                  )}
                </div>

                <h3 className="text-xs text-zinc-200 font-medium">{selectedAsset.name}</h3>
                <p className="text-[10px] text-zinc-600 mt-0.5">
                  {selectedAsset.type === "custom" ? "Generated" : getTypeLabel(selectedAsset.type)}
                </p>

                {selectedAsset.description && (
                  <p className="text-[10px] text-zinc-500 mt-2 line-clamp-3">{selectedAsset.description}</p>
                )}

                {selectedAsset.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {selectedAsset.tags.map((tag) => (
                      <span
                        key={tag}
                        className="px-1.5 py-0.5 bg-zinc-900 text-zinc-500 rounded text-[9px]"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}

                <div className="mt-3 text-[9px] text-zinc-700">
                  {new Date(selectedAsset.createdAt).toLocaleDateString()}
                </div>
              </div>

              <div className="space-y-2 pt-3 border-t border-zinc-800/50">
                <button
                  onClick={() => handlePlaceAsset(selectedAsset)}
                  className="w-full py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-xs transition-colors"
                >
                  Place in Scene
                </button>
                <button
                  onClick={() => handleDelete(selectedAsset.id)}
                  className="w-full py-1.5 text-[11px] text-zinc-600 hover:text-zinc-400 transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
