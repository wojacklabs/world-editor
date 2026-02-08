"use client";

import { useEditorStore } from "@/lib/editor/store/editorStore";
import type {
  ToolType,
  HeightmapTool,
  BiomeType,
  ProceduralAssetType,
  WaterType,
} from "@/lib/editor/types/EditorTypes";
import WeatherPanel from "./WeatherPanel";

const TOOL_ITEMS: { id: ToolType; label: string; description: string; key: string }[] = [
  { id: "select", label: "Select", description: "오브젝트 선택/정리", key: "1" },
  { id: "heightmap", label: "Terrain", description: "지형 높이 조형", key: "2" },
  { id: "biome", label: "Biome", description: "재질/수면 페인팅", key: "3" },
  { id: "props", label: "Props", description: "프롭 배치", key: "4" },
  { id: "environment", label: "Environment", description: "시간/날씨", key: "5" },
];

const HEIGHTMAP_TOOLS: { id: HeightmapTool; label: string; key: string }[] = [
  { id: "raise", label: "Raise", key: "Q" },
  { id: "lower", label: "Lower", key: "T" },
  { id: "flatten", label: "Flatten", key: "E" },
  { id: "smooth", label: "Smooth", key: "R" },
];

const BIOMES: { id: BiomeType; label: string; color: string }[] = [
  { id: "grass", label: "Grass", color: "#4a7c23" },
  { id: "dirt", label: "Dirt", color: "#8b6914" },
  { id: "rock", label: "Rock", color: "#6b6b6b" },
  { id: "sand", label: "Sand", color: "#c2a366" },
  { id: "water", label: "Water", color: "#2d6a8f" },
];

const PROP_TYPES: { id: ProceduralAssetType; label: string }[] = [
  { id: "rock", label: "Rock" },
  { id: "tree", label: "Tree" },
  { id: "bush", label: "Bush" },
  { id: "grass_clump", label: "Grass" },
];

function SliderField({
  label,
  value,
  valueText,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  valueText: string;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <div className="flex items-center justify-between text-[12px] mb-2">
        <span className="text-slate-400">{label}</span>
        <span className="text-slate-200 tabular-nums">{valueText}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-1.5 bg-slate-800/90 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:bg-slate-200 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:shadow-[0_0_0_2px_rgba(15,23,42,0.9)] hover:[&::-webkit-slider-thumb]:bg-white"
      />
    </label>
  );
}

function PanelSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl bg-slate-900/55 border border-slate-700/40 shadow-[inset_0_1px_0_rgba(148,163,184,0.06)] overflow-hidden">
      <header className="px-4 py-3 border-b border-slate-700/35">
        <h3 className="text-[12px] font-semibold tracking-tight text-slate-200">{title}</h3>
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export default function EditorSidebar() {
  const {
    activeTool,
    activeHeightmapTool,
    selectedMaterial,
    selectedAssetType,
    brushSettings,
    assetSettings,
    waterType,
    waterFlowAngle,
    pendingAsset,
    setActiveTool,
    setActiveHeightmapTool,
    setSelectedMaterial,
    setSelectedAssetType,
    setBrushSize,
    setBrushStrength,
    setAssetSize,
    setWaterType,
    setWaterFlowAngle,
    randomizeAssetSeed,
    clearPendingAsset,
  } = useEditorStore();

  const activeToolMeta = TOOL_ITEMS.find((tool) => tool.id === activeTool);

  return (
    <aside className="w-[304px] h-full min-h-0 editor-surface border-0 border-r border-slate-700/40 flex flex-col shrink-0">
      <header className="px-4 py-4 border-b border-slate-700/40">
        <h2 className="text-[15px] font-semibold tracking-tight text-slate-100">Tools</h2>
        <p className="text-[12px] text-slate-400 mt-1">작업 모드를 선택하고 즉시 캔버스에서 편집하세요.</p>
      </header>

      <div className="p-2.5 border-b border-slate-700/40 space-y-1.5">
        {TOOL_ITEMS.map((tool) => (
          <button
            key={tool.id}
            onClick={() => setActiveTool(tool.id)}
            className={`w-full px-3.5 py-2.5 rounded-xl flex items-center gap-2.5 transition-all border ${
              activeTool === tool.id
                ? "bg-sky-300/12 border-sky-300/35 text-slate-100 shadow-[0_8px_20px_rgba(14,116,144,0.15)]"
                : "bg-slate-900/30 border-transparent text-slate-400 hover:text-slate-100 hover:bg-slate-800/55 hover:border-slate-700/55"
            }`}
          >
            <span className={`w-5 text-[11px] ${activeTool === tool.id ? "text-sky-200" : "text-slate-500"}`}>
              {tool.key}
            </span>
            <span className="flex-1 text-left min-w-0">
              <span className="block text-[13px] leading-tight">{tool.label}</span>
            </span>
          </button>
        ))}
        {activeToolMeta && (
          <p className="px-1 text-[12px] text-slate-500">{activeToolMeta.description}</p>
        )}
      </div>

      {pendingAsset && (
        <div className="mx-3.5 mt-3 px-3.5 py-3 rounded-xl bg-sky-300/12 border border-sky-300/28">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="w-2 h-2 rounded-full bg-sky-300 animate-pulse" />
              <span className="text-[12px] text-sky-100 truncate">Place: {pendingAsset.name}</span>
            </div>
            <button
              onClick={clearPendingAsset}
              className="text-[12px] text-slate-300 hover:text-white"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-3.5 space-y-3.5">
        {activeTool === "heightmap" && (
          <>
            <PanelSection title="Brush Mode">
              <div className="grid grid-cols-2 gap-1.5">
                {HEIGHTMAP_TOOLS.map((tool) => (
                  <button
                    key={tool.id}
                    onClick={() => setActiveHeightmapTool(tool.id)}
                    className={`py-2 text-[12px] rounded-lg border transition-all ${
                      activeHeightmapTool === tool.id
                        ? "bg-slate-700/80 border-slate-600 text-slate-100"
                        : "bg-slate-900/45 border-slate-700/50 text-slate-400 hover:text-slate-200 hover:border-slate-600"
                    }`}
                  >
                    {tool.label}
                    <span className="ml-1 text-[11px] text-slate-500">{tool.key}</span>
                  </button>
                ))}
              </div>
            </PanelSection>
            <PanelSection title="Brush">
              <div className="space-y-3.5">
                <SliderField
                  label="Size"
                  value={brushSettings.size}
                  valueText={`${brushSettings.size}`}
                  min={1}
                  max={50}
                  onChange={setBrushSize}
                />
                <SliderField
                  label="Strength"
                  value={brushSettings.strength}
                  valueText={`${Math.round(brushSettings.strength * 100)}%`}
                  min={0.05}
                  max={1}
                  step={0.05}
                  onChange={setBrushStrength}
                />
              </div>
            </PanelSection>
          </>
        )}

        {activeTool === "biome" && (
          <>
            <PanelSection title="Material">
              <div className="space-y-1.5">
                {BIOMES.map((biome) => (
                  <button
                    key={biome.id}
                    onClick={() => setSelectedMaterial(biome.id)}
                    className={`w-full px-3 py-2 rounded-lg flex items-center gap-2.5 transition-all border ${
                      selectedMaterial === biome.id
                        ? "bg-slate-700/75 border-slate-600 text-slate-100"
                        : "bg-slate-900/45 border-slate-700/50 text-slate-400 hover:text-slate-200 hover:border-slate-600"
                    }`}
                  >
                    <span className="w-3 h-3 rounded" style={{ backgroundColor: biome.color }} />
                    <span className="text-[12px]">{biome.label}</span>
                  </button>
                ))}
              </div>
            </PanelSection>

            <PanelSection title="Brush">
              <SliderField
                label="Size"
                value={brushSettings.size}
                valueText={`${brushSettings.size}`}
                min={1}
                max={50}
                onChange={setBrushSize}
              />
            </PanelSection>

            {selectedMaterial === "water" && (
              <PanelSection title="Water">
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-1.5">
                    {(["lake", "river"] as WaterType[]).map((type) => (
                      <button
                        key={type}
                        onClick={() => setWaterType(type)}
                        className={`py-2 text-[12px] rounded-lg border transition-all ${
                          waterType === type
                            ? "bg-slate-700/80 border-slate-600 text-slate-100"
                            : "bg-slate-900/45 border-slate-700/50 text-slate-400 hover:text-slate-200 hover:border-slate-600"
                        }`}
                      >
                        {type === "lake" ? "Lake" : "River"}
                      </button>
                    ))}
                  </div>
                  {waterType === "river" && (
                    <SliderField
                      label="Direction"
                      value={waterFlowAngle}
                      valueText={`${Math.round(waterFlowAngle)}°`}
                      min={0}
                      max={360}
                      step={5}
                      onChange={setWaterFlowAngle}
                    />
                  )}
                </div>
              </PanelSection>
            )}
          </>
        )}

        {activeTool === "props" && (
          <>
            <PanelSection title="Asset">
              <div className="grid grid-cols-2 gap-1.5">
                {PROP_TYPES.map((type) => (
                  <button
                    key={type.id}
                    onClick={() => {
                      setSelectedAssetType(type.id);
                      clearPendingAsset();
                    }}
                    className={`py-2 text-[12px] rounded-lg border transition-all ${
                      selectedAssetType === type.id
                        ? "bg-slate-700/80 border-slate-600 text-slate-100"
                        : "bg-slate-900/45 border-slate-700/50 text-slate-400 hover:text-slate-200 hover:border-slate-600"
                    }`}
                  >
                    {type.label}
                  </button>
                ))}
              </div>
            </PanelSection>

            <PanelSection title="Placement">
              <div className="space-y-3.5">
                <SliderField
                  label="Scale"
                  value={assetSettings.size}
                  valueText={`${assetSettings.size.toFixed(1)}x`}
                  min={0.2}
                  max={5}
                  step={0.1}
                  onChange={setAssetSize}
                />
                <button
                  onClick={randomizeAssetSeed}
                  className="w-full py-2 text-[12px] rounded-lg border border-slate-700/50 bg-slate-900/45 text-slate-300 hover:text-white hover:border-slate-600"
                >
                  Randomize Seed (Shift+R)
                </button>
              </div>
            </PanelSection>
          </>
        )}

        {activeTool === "select" && (
          <PanelSection title="Selection">
            <p className="text-[12px] text-slate-300">오브젝트를 선택해서 우측 패널에서 수정하세요.</p>
            <p className="text-[12px] text-slate-500 mt-2">Delete: 제거 / Esc: 선택 해제</p>
          </PanelSection>
        )}

        {activeTool === "environment" && (
          <PanelSection title="Environment">
            <WeatherPanel />
          </PanelSection>
        )}
      </div>
    </aside>
  );
}
