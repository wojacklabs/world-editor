"use client";

import { useEditorStore } from "@/lib/editor/store/editorStore";
import type { EditorEngine } from "@/lib/editor/core/EditorEngine";

interface EditorToolbarProps {
  engine: EditorEngine | null;
  isGameMode: boolean;
  onNewProject: () => void;
  onSave: () => void;
  onExportGLB: () => void;
  onExportHeightmap: () => void;
  onExportWorldProject?: () => void;
  onToggleGameMode: () => void;
  onOpenAIChat?: () => void;
  onOpenLibrary?: () => void;
}

export default function EditorToolbar({
  engine,
  isGameMode,
  onNewProject,
  onSave,
  onExportGLB,
  onExportHeightmap,
  onExportWorldProject,
  onToggleGameMode,
  onOpenAIChat,
  onOpenLibrary,
}: EditorToolbarProps) {
  const { isModified } = useEditorStore();

  const buttonBase = "px-3 py-1.5 text-[13px] rounded transition-all";
  const buttonDefault = `${buttonBase} text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50`;
  const buttonDisabled = "opacity-40 pointer-events-none";

  return (
    <header className="h-11 bg-zinc-950 border-b border-zinc-800/50 flex items-center px-3 gap-1">
      {/* Logo / Title */}
      <div className="flex items-center gap-2 mr-4">
        <span className="text-sm font-medium text-zinc-300">World Editor</span>
      </div>

      {/* Divider */}
      <div className="w-px h-5 bg-zinc-800 mx-1" />

      {/* File */}
      <button
        onClick={onNewProject}
        disabled={isGameMode}
        className={`${buttonDefault} ${isGameMode ? buttonDisabled : ""}`}
      >
        New
      </button>
      <button
        onClick={onSave}
        disabled={isGameMode}
        className={`${buttonDefault} ${isGameMode ? buttonDisabled : ""} flex items-center gap-1.5`}
      >
        Save
        {isModified && (
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-400" />
        )}
      </button>

      <div className="w-px h-5 bg-zinc-800 mx-1" />

      {/* Export */}
      <span className="text-[11px] text-zinc-600 mx-1">Export</span>
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
      <button
        onClick={onExportWorldProject}
        disabled={isGameMode}
        className={`${buttonDefault} ${isGameMode ? buttonDisabled : ""}`}
        title="Export World Project JSON"
      >
        World
      </button>

      <div className="w-px h-5 bg-zinc-800 mx-1" />

      {/* Assets */}
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

      {/* Spacer */}
      <div className="flex-1" />

      {/* Game mode hint */}
      {isGameMode && (
        <span className="text-[11px] text-zinc-500 mr-3">
          WASD Move / Mouse Look / Space Jump
        </span>
      )}

      {/* Play */}
      <button
        onClick={onToggleGameMode}
        className={`px-4 py-1.5 text-[13px] rounded transition-all ${
          isGameMode
            ? "bg-zinc-200 text-zinc-900 hover:bg-white"
            : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-white"
        }`}
      >
        {isGameMode ? "Exit" : "Play"}
      </button>

      {/* Focus */}
      <button
        onClick={() => engine?.focusOnTerrain()}
        disabled={isGameMode}
        className={`${buttonDefault} ml-1 ${isGameMode ? buttonDisabled : ""}`}
      >
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v4m0 12v4M2 12h4m12 0h4" />
        </svg>
      </button>
    </header>
  );
}
