"use client";

import { useEditorStore } from "@/lib/editor/store/editorStore";
import type { EditorEngine } from "@/lib/editor/core/EditorEngine";
import type { ToolType } from "@/lib/editor/types/EditorTypes";

interface EditorToolbarProps {
  engine: EditorEngine | null;
  isGameMode: boolean;
  leftPanelVisible: boolean;
  rightPanelVisible: boolean;
  onNewProject: () => void;
  onSave: () => void;
  onExportGLB: () => void;
  onExportHeightmap: () => void;
  onToggleGameMode: () => void;
  onToggleLeftPanel: () => void;
  onToggleRightPanel: () => void;
  onOpenAIChat?: () => void;
  onOpenLibrary?: () => void;
}

export default function EditorToolbar({
  engine,
  isGameMode,
  leftPanelVisible,
  rightPanelVisible,
  onNewProject,
  onSave,
  onExportGLB,
  onExportHeightmap,
  onToggleGameMode,
  onToggleLeftPanel,
  onToggleRightPanel,
  onOpenAIChat,
  onOpenLibrary,
}: EditorToolbarProps) {
  const { isModified, activeTool } = useEditorStore();

  const TOOL_LABEL: Record<ToolType, string> = {
    select: "Select",
    heightmap: "Terrain",
    biome: "Biome",
    props: "Props",
    environment: "Environment",
  };

  const buttonBase = "px-3 py-1.5 text-[12px] rounded-md transition-all";
  const buttonDefault = `${buttonBase} text-slate-300 hover:text-white hover:bg-slate-800/70`;
  const buttonDisabled = "opacity-40 pointer-events-none";

  return (
    <header className="h-14 editor-surface border-0 border-b border-slate-700/40 flex items-center px-2.5 sm:px-3.5 gap-1.5 sm:gap-2">
      <div className="flex items-center gap-2 min-w-0">
        <span className="hidden md:block text-[14px] font-semibold tracking-tight text-slate-100">World Editor</span>
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800/80 text-slate-300 whitespace-nowrap border border-slate-700/60">
          {TOOL_LABEL[activeTool]}
        </span>
      </div>

      <div className="hidden lg:flex items-center gap-1 bg-slate-900/70 border border-slate-700/60 rounded-xl p-0.5">
        <button
          onClick={onToggleLeftPanel}
          disabled={isGameMode}
          className={`px-2.5 py-1.5 text-[11px] rounded-md transition-all ${
            leftPanelVisible ? "bg-slate-700/80 text-slate-100" : "text-slate-400 hover:text-slate-200"
          } ${isGameMode ? buttonDisabled : ""}`}
        >
          Tools
        </button>
        <button
          onClick={onToggleRightPanel}
          disabled={isGameMode}
          className={`px-2.5 py-1.5 text-[11px] rounded-md transition-all ${
            rightPanelVisible ? "bg-slate-700/80 text-slate-100" : "text-slate-400 hover:text-slate-200"
          } ${isGameMode ? buttonDisabled : ""}`}
        >
          Inspector
        </button>
      </div>

      <div className="hidden lg:block w-px h-5 bg-slate-700/70" />

      <div className="flex items-center gap-1">
        <button
          onClick={onNewProject}
          disabled={isGameMode}
          className={`hidden sm:inline-flex ${buttonDefault} ${isGameMode ? buttonDisabled : ""}`}
        >
          New
        </button>
        <button
          onClick={onSave}
          disabled={isGameMode}
          className={`${buttonDefault} ${isGameMode ? buttonDisabled : ""} flex items-center gap-1.5`}
        >
          Save
          {isModified && <span className="w-1.5 h-1.5 rounded-full bg-amber-300" />}
        </button>
      </div>

      <div className="hidden xl:flex items-center gap-1">
        <button
          onClick={onOpenAIChat}
          disabled={isGameMode}
          className={`${buttonDefault} ${isGameMode ? buttonDisabled : ""}`}
        >
          Generate
        </button>
        <button
          onClick={onOpenLibrary}
          disabled={isGameMode}
          className={`${buttonDefault} ${isGameMode ? buttonDisabled : ""}`}
        >
          Library
        </button>
      </div>

      <div className="flex-1" />

      <div className="hidden xl:flex items-center gap-1">
        <button
          onClick={onExportGLB}
          disabled={isGameMode}
          className={`${buttonDefault} ${isGameMode ? buttonDisabled : ""}`}
        >
          GLB
        </button>
        <button
          onClick={onExportHeightmap}
          disabled={isGameMode}
          className={`${buttonDefault} ${isGameMode ? buttonDisabled : ""}`}
        >
          PNG
        </button>
      </div>

      <button
        onClick={() => engine?.focusOnTerrain()}
        disabled={isGameMode}
        className={`hidden md:inline-flex ${buttonDefault} ${isGameMode ? buttonDisabled : ""}`}
      >
        Focus
      </button>

      <button
        onClick={onToggleGameMode}
        className={`px-3 sm:px-4 py-1.5 text-[12px] rounded-md transition-all border ${
          isGameMode
            ? "bg-sky-200 text-slate-950 border-sky-100 hover:bg-sky-100"
            : "bg-slate-800 text-slate-100 border-slate-700 hover:bg-slate-700"
        }`}
      >
        {isGameMode ? "Exit" : "Play"}
      </button>
    </header>
  );
}
