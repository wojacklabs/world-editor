"use client";

import { useEditorStore } from "@/lib/editor/store/editorStore";

interface PropertiesPanelProps {
  onMakeSeamless: () => void;
  dispStrength: number;
  onDispStrengthChange: (value: number) => void;
  terrainResolution: number;
  onTerrainResolutionChange: (value: number) => void;
}

const RESOLUTION_OPTIONS = [128, 256, 512, 1024, 2048, 4096];

export default function PropertiesPanel({
  onMakeSeamless,
  dispStrength,
  onDispStrengthChange,
  terrainResolution,
  onTerrainResolutionChange,
}: PropertiesPanelProps) {
  const {
    activeTool,
    brushSettings,
    setBrushSize,
    setBrushStrength,
    setBrushSettings,
    showGrid,
    showWireframe,
    toggleGrid,
    toggleWireframe,
  } = useEditorStore();

  return (
    <div className="w-56 bg-zinc-950 border-l border-zinc-800/50 flex flex-col">
      {/* Brush Settings - only show for relevant tools */}
      {(activeTool === "heightmap" || activeTool === "biome") && (
        <section className="p-4">
          <h3 className="text-[11px] font-medium text-zinc-500 uppercase tracking-wide mb-4">
            Brush
          </h3>

          <div className="space-y-5">
            {/* Size */}
            <div>
              <div className="flex justify-between items-baseline mb-2">
                <span className="text-xs text-zinc-400">Size</span>
                <span className="text-xs text-zinc-300 tabular-nums">{brushSettings.size}</span>
              </div>
              <input
                type="range"
                min="1"
                max="50"
                step="1"
                value={brushSettings.size}
                onChange={(e) => setBrushSize(parseFloat(e.target.value))}
                className="w-full h-1 bg-zinc-800 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-zinc-300 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer hover:[&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:transition-colors"
              />
            </div>

            {/* Strength */}
            <div>
              <div className="flex justify-between items-baseline mb-2">
                <span className="text-xs text-zinc-400">Strength</span>
                <span className="text-xs text-zinc-300 tabular-nums">{Math.round(brushSettings.strength * 100)}%</span>
              </div>
              <input
                type="range"
                min="0.01"
                max="1"
                step="0.01"
                value={brushSettings.strength}
                onChange={(e) => setBrushStrength(parseFloat(e.target.value))}
                className="w-full h-1 bg-zinc-800 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-zinc-300 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer hover:[&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:transition-colors"
              />
            </div>

            {/* Falloff */}
            <div>
              <div className="flex justify-between items-baseline mb-2">
                <span className="text-xs text-zinc-400">Falloff</span>
                <span className="text-xs text-zinc-300 tabular-nums">{Math.round(brushSettings.falloff * 100)}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={brushSettings.falloff}
                onChange={(e) => setBrushSettings({ falloff: parseFloat(e.target.value) })}
                className="w-full h-1 bg-zinc-800 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-zinc-300 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer hover:[&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:transition-colors"
              />
            </div>
          </div>
        </section>
      )}

      {/* Divider */}
      {(activeTool === "heightmap" || activeTool === "biome") && (
        <div className="mx-4 h-px bg-zinc-800/50" />
      )}

      {/* View */}
      <section className="p-4">
        <h3 className="text-[11px] font-medium text-zinc-500 uppercase tracking-wide mb-3">
          View
        </h3>

        <div className="flex gap-2">
          <button
            onClick={toggleGrid}
            className={`flex-1 py-2 text-xs rounded transition-all ${
              showGrid
                ? "bg-zinc-800 text-zinc-200"
                : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50"
            }`}
          >
            Grid
          </button>
          <button
            onClick={toggleWireframe}
            className={`flex-1 py-2 text-xs rounded transition-all ${
              showWireframe
                ? "bg-zinc-800 text-zinc-200"
                : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50"
            }`}
          >
            Wire
          </button>
        </div>
      </section>

      <div className="mx-4 h-px bg-zinc-800/50" />

      {/* Terrain */}
      <section className="p-4">
        <h3 className="text-[11px] font-medium text-zinc-500 uppercase tracking-wide mb-3">
          Terrain
        </h3>

        <div className="space-y-3">
          <div className="flex justify-between text-xs">
            <span className="text-zinc-500">Size</span>
            <span className="text-zinc-400">64 × 64</span>
          </div>
          <div>
            <div className="flex justify-between items-baseline mb-2">
              <span className="text-xs text-zinc-500">Resolution</span>
              <span className="text-xs text-zinc-400">{terrainResolution + 1} × {terrainResolution + 1}</span>
            </div>
            <select
              value={terrainResolution}
              onChange={(e) => onTerrainResolutionChange(parseInt(e.target.value))}
              className="w-full py-1.5 px-2 text-xs bg-zinc-900 border border-zinc-800 rounded text-zinc-300 cursor-pointer hover:border-zinc-700 transition-colors focus:outline-none focus:border-zinc-600"
            >
              {RESOLUTION_OPTIONS.map((res) => (
                <option key={res} value={res}>
                  {res} ({res + 1}×{res + 1} vertices)
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-[10px] text-zinc-600">
              Higher = more detail, slower
            </p>
          </div>
        </div>

        <button
          onClick={onMakeSeamless}
          className="w-full mt-4 py-2 text-xs text-zinc-400 border border-zinc-800 rounded hover:border-zinc-700 hover:text-zinc-300 transition-colors"
        >
          Make Seamless
        </button>
      </section>

      <div className="mx-4 h-px bg-zinc-800/50" />

      {/* Rock Displacement */}
      <section className="p-4">
        <h3 className="text-[11px] font-medium text-zinc-500 uppercase tracking-wide mb-4">
          Rock Displacement
        </h3>

        <div>
          <div className="flex justify-between items-baseline mb-2">
            <span className="text-xs text-zinc-400">Strength</span>
            <span className="text-xs text-zinc-300 tabular-nums">{dispStrength.toFixed(2)}</span>
          </div>
          <input
            type="range"
            min="0"
            max="2"
            step="0.05"
            value={dispStrength}
            onChange={(e) => onDispStrengthChange(parseFloat(e.target.value))}
            className="w-full h-1 bg-zinc-800 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-zinc-300 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer hover:[&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:transition-colors"
          />
        </div>
      </section>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Shortcuts - minimal footer */}
      <section className="p-4 border-t border-zinc-800/50">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] text-zinc-600">
          <span>[ ]</span><span>Brush size</span>
          <span>G</span><span>Grid</span>
          <span>F</span><span>Wireframe</span>
          <span>H</span><span>Focus</span>
        </div>
      </section>
    </div>
  );
}
