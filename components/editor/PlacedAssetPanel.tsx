"use client";

import { PlacedAsset } from "@/app/page";

interface PlacedAssetPanelProps {
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

export default function PlacedAssetPanel({
  assets,
  selectedAssetId,
  onSelectAsset,
  onUpdateAsset,
  onDeleteAsset,
  onRandomizeRotation,
}: PlacedAssetPanelProps) {
  const selectedAsset = assets.find((a) => a.id === selectedAssetId);

  if (assets.length === 0) {
    return null;
  }

  return (
    <div className="w-56 bg-zinc-950 border-t border-zinc-800/50 flex flex-col max-h-80">
      {/* Header */}
      <div className="px-4 py-2.5 flex items-center justify-between">
        <span className="text-[11px] font-medium text-zinc-500 uppercase tracking-wide">
          Objects ({assets.length})
        </span>
        {selectedAssetId && (
          <button
            onClick={() => onSelectAsset(null)}
            className="text-[10px] text-zinc-600 hover:text-zinc-400"
          >
            Deselect
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Asset List */}
        <div className="px-2 pb-2 space-y-px">
          {assets.map((asset) => (
            <button
              key={asset.id}
              onClick={() => onSelectAsset(asset.id === selectedAssetId ? null : asset.id)}
              className={`w-full px-3 py-2 text-left rounded transition-all flex items-center gap-2 ${
                selectedAssetId === asset.id
                  ? "bg-zinc-800 text-zinc-200"
                  : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-400"
              }`}
            >
              <span className={`w-1 h-1 rounded-full ${selectedAssetId === asset.id ? "bg-zinc-400" : "bg-zinc-700"}`} />
              <span className="text-xs truncate flex-1">{asset.name}</span>
              {selectedAssetId === asset.id && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteAsset(asset.id);
                  }}
                  className="text-zinc-500 hover:text-zinc-300 text-[10px]"
                >
                  Del
                </button>
              )}
            </button>
          ))}
        </div>

        {/* Selected Asset Controls */}
        {selectedAsset && (
          <div className="px-4 py-3 border-t border-zinc-800/50 space-y-4">
            {/* Position */}
            <div>
              <span className="text-[10px] text-zinc-600 uppercase tracking-wide">Position</span>
              <div className="grid grid-cols-3 gap-1 mt-1.5">
                {(["x", "y", "z"] as const).map((axis) => (
                  <div key={axis} className="relative">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[9px] text-zinc-600 uppercase">
                      {axis}
                    </span>
                    <input
                      type="number"
                      step="0.5"
                      value={selectedAsset.position[axis].toFixed(1)}
                      onChange={(e) =>
                        onUpdateAsset(selectedAsset.id, {
                          position: {
                            ...selectedAsset.position,
                            [axis]: parseFloat(e.target.value) || 0,
                          },
                        })
                      }
                      className="w-full pl-5 pr-1 py-1.5 text-[11px] bg-zinc-900 border border-zinc-800 rounded text-zinc-300 text-right focus:border-zinc-700 focus:outline-none"
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* Rotation */}
            <div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-600 uppercase tracking-wide">Rotation</span>
                <button
                  onClick={() => onRandomizeRotation(selectedAsset.id)}
                  className="text-[10px] text-zinc-600 hover:text-zinc-400"
                >
                  Random
                </button>
              </div>
              <div className="grid grid-cols-3 gap-1 mt-1.5">
                {(["x", "y", "z"] as const).map((axis) => (
                  <div key={axis} className="relative">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[9px] text-zinc-600 uppercase">
                      {axis}
                    </span>
                    <input
                      type="number"
                      step="15"
                      value={selectedAsset.rotation[axis].toFixed(0)}
                      onChange={(e) =>
                        onUpdateAsset(selectedAsset.id, {
                          rotation: {
                            ...selectedAsset.rotation,
                            [axis]: parseFloat(e.target.value) || 0,
                          },
                        })
                      }
                      className="w-full pl-5 pr-1 py-1.5 text-[11px] bg-zinc-900 border border-zinc-800 rounded text-zinc-300 text-right focus:border-zinc-700 focus:outline-none"
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* Scale */}
            <div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-600 uppercase tracking-wide">Scale</span>
                <button
                  onClick={() => onUpdateAsset(selectedAsset.id, { scale: { x: 1, y: 1, z: 1 } })}
                  className="text-[10px] text-zinc-600 hover:text-zinc-400"
                >
                  Reset
                </button>
              </div>
              <div className="mt-1.5">
                <div className="flex justify-between text-[10px] mb-1">
                  <span className="text-zinc-600">Uniform</span>
                  <span className="text-zinc-500 tabular-nums">{selectedAsset.scale.x.toFixed(1)}x</span>
                </div>
                <input
                  type="range"
                  min="0.1"
                  max="5"
                  step="0.1"
                  value={selectedAsset.scale.x}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    onUpdateAsset(selectedAsset.id, { scale: { x: val, y: val, z: val } });
                  }}
                  className="w-full h-1 bg-zinc-800 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-zinc-400 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer hover:[&::-webkit-slider-thumb]:bg-zinc-300"
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
