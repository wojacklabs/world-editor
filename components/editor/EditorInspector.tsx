"use client";

import { useState } from "react";
import type { PlacedAsset } from "@/app/page";
import TilePanel from "./TilePanel";
import PlacedAssetPanel from "./PlacedAssetPanel";

interface EditorInspectorProps {
  // Tile panel props
  onSaveTile: (name: string, existingId?: string) => void;
  onLoadTile: (tileId: string) => void;
  onCreateNewTile: (name: string) => void;
  activeTileId: string | null;
  isDirty: boolean;
  dispStrength: number;
  onDispStrengthChange: (value: number) => void;
  terrainResolution: number;
  onTerrainResolutionChange: (value: number) => void;
  terrainSize: number;
  onTerrainSizeChange: (value: number) => void;

  // Object panel props
  assets: PlacedAsset[];
  selectedAssetId: string | null;
  onSelectAsset: (id: string | null) => void;
  onUpdateAsset: (
    id: string,
    updates: Partial<Pick<PlacedAsset, "position" | "rotation" | "scale">>
  ) => void;
  onDeleteAsset: (id: string) => void;
  onRandomizeRotation: (id: string) => void;
}

type InspectorTab = "world" | "objects";

export default function EditorInspector({
  onSaveTile,
  onLoadTile,
  onCreateNewTile,
  activeTileId,
  isDirty,
  dispStrength,
  onDispStrengthChange,
  terrainResolution,
  onTerrainResolutionChange,
  terrainSize,
  onTerrainSizeChange,
  assets,
  selectedAssetId,
  onSelectAsset,
  onUpdateAsset,
  onDeleteAsset,
  onRandomizeRotation,
}: EditorInspectorProps) {
  const [preferredTab, setPreferredTab] = useState<InspectorTab>("world");
  const activeTab: InspectorTab = selectedAssetId ? "objects" : preferredTab;

  return (
    <aside className="w-72 bg-zinc-950 border-l border-zinc-800/60 flex flex-col min-w-0">
      <header className="h-12 border-b border-zinc-800/60 px-2 flex items-center gap-1">
        <button
          onClick={() => setPreferredTab("world")}
          className={`flex-1 py-2 text-[11px] rounded-md transition-all ${
            activeTab === "world"
              ? "bg-zinc-800 text-zinc-200"
              : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900"
          }`}
        >
          World
          {isDirty && <span className="ml-1 text-amber-300">•</span>}
        </button>
        <button
          onClick={() => setPreferredTab("objects")}
          className={`flex-1 py-2 text-[11px] rounded-md transition-all ${
            activeTab === "objects"
              ? "bg-zinc-800 text-zinc-200"
              : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900"
          }`}
        >
          Objects ({assets.length})
        </button>
      </header>

      <div className="flex-1 min-h-0">
        {activeTab === "world" ? (
          <TilePanel
            variant="embedded"
            onSaveTile={onSaveTile}
            onLoadTile={onLoadTile}
            onCreateNewTile={onCreateNewTile}
            activeTileId={activeTileId}
            isDirty={isDirty}
            dispStrength={dispStrength}
            onDispStrengthChange={onDispStrengthChange}
            terrainResolution={terrainResolution}
            onTerrainResolutionChange={onTerrainResolutionChange}
            terrainSize={terrainSize}
            onTerrainSizeChange={onTerrainSizeChange}
          />
        ) : (
          <PlacedAssetPanel
            variant="embedded"
            assets={assets}
            selectedAssetId={selectedAssetId}
            onSelectAsset={onSelectAsset}
            onUpdateAsset={onUpdateAsset}
            onDeleteAsset={onDeleteAsset}
            onRandomizeRotation={onRandomizeRotation}
          />
        )}
      </div>
    </aside>
  );
}
