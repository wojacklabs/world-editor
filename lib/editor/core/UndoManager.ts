/**
 * Undo/Redo manager for terrain editing operations.
 * Stores snapshots of heightmap, splatmap, and water mask data.
 */

interface Snapshot {
  heightmap: Float32Array;
  splatmap: Float32Array;
  waterMask: Float32Array;
}

export class UndoManager {
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private maxHistory: number;

  constructor(maxHistory: number = 20) {
    this.maxHistory = maxHistory;
  }

  /**
   * Push a snapshot onto the undo stack (clears redo stack).
   * Call this BEFORE the user starts editing.
   */
  pushSnapshot(heightmap: Float32Array, splatmap: Float32Array, waterMask: Float32Array): void {
    this.undoStack.push({
      heightmap: new Float32Array(heightmap),
      splatmap: new Float32Array(splatmap),
      waterMask: new Float32Array(waterMask),
    });
    // Trim oldest entries
    while (this.undoStack.length > this.maxHistory) {
      this.undoStack.shift();
    }
    // Any new edit invalidates redo history
    this.redoStack.length = 0;
  }

  /**
   * Pop the most recent undo snapshot.
   * Caller must push current state onto redo before restoring.
   */
  undo(currentHeightmap: Float32Array, currentSplatmap: Float32Array, currentWaterMask: Float32Array): Snapshot | null {
    const snapshot = this.undoStack.pop();
    if (!snapshot) return null;

    // Save current state to redo stack
    this.redoStack.push({
      heightmap: new Float32Array(currentHeightmap),
      splatmap: new Float32Array(currentSplatmap),
      waterMask: new Float32Array(currentWaterMask),
    });

    return snapshot;
  }

  /**
   * Pop the most recent redo snapshot.
   * Caller must push current state onto undo before restoring.
   */
  redo(currentHeightmap: Float32Array, currentSplatmap: Float32Array, currentWaterMask: Float32Array): Snapshot | null {
    const snapshot = this.redoStack.pop();
    if (!snapshot) return null;

    // Save current state to undo stack
    this.undoStack.push({
      heightmap: new Float32Array(currentHeightmap),
      splatmap: new Float32Array(currentSplatmap),
      waterMask: new Float32Array(currentWaterMask),
    });

    return snapshot;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
