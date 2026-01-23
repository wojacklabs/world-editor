/**
 * CellManager - Cell과 Grid Tile 좌표 매핑
 *
 * StreamingManager는 cell 단위로 동작 (기본 64x64)
 * EditorEngine은 tile 단위로 동작 (가변 크기)
 *
 * 이 클래스는 두 좌표계 사이의 변환을 담당
 */

export interface CellManagerConfig {
  cellSize: number;   // StreamingManager cell size (64)
  tileSize: number;   // Editor tile size (64, 128, 256...)
}

export interface CellCoord {
  x: number;
  z: number;
}

export interface TileCoord {
  gridX: number;
  gridY: number;
}

export interface WorldCoord {
  worldX: number;
  worldZ: number;
}

/**
 * Cell과 Tile 간의 관계:
 *
 * Case 1: cellSize === tileSize (1:1)
 *   cell(0,0) → tile(0,0)
 *   cell(1,0) → tile(1,0)
 *
 * Case 2: cellSize < tileSize (여러 셀이 한 타일)
 *   tileSize=128, cellSize=64
 *   cell(0,0), cell(1,0), cell(0,1), cell(1,1) → tile(0,0)
 *
 * Case 3: cellSize > tileSize (한 셀이 여러 타일)
 *   tileSize=32, cellSize=64
 *   cell(0,0) → tile(0,0), tile(1,0), tile(0,1), tile(1,1)
 */
export class CellManager {
  private cellSize: number;
  private tileSize: number;
  private cellsPerTile: number;  // tileSize / cellSize (>=1이면 셀이 타일 안에, <1이면 셀이 타일을 포함)

  constructor(config: CellManagerConfig) {
    this.cellSize = config.cellSize;
    this.tileSize = config.tileSize;
    this.cellsPerTile = this.tileSize / this.cellSize;

    console.log(`[CellManager] Initialized: cellSize=${this.cellSize}, tileSize=${this.tileSize}, cellsPerTile=${this.cellsPerTile}`);
  }

  /**
   * tileSize 업데이트 (terrain 생성 후)
   */
  updateTileSize(tileSize: number): void {
    this.tileSize = tileSize;
    this.cellsPerTile = this.tileSize / this.cellSize;
    console.log(`[CellManager] Updated tileSize=${this.tileSize}, cellsPerTile=${this.cellsPerTile}`);
  }

  /**
   * World 좌표 → Cell 좌표
   */
  worldToCell(worldX: number, worldZ: number): CellCoord {
    return {
      x: Math.floor(worldX / this.cellSize),
      z: Math.floor(worldZ / this.cellSize),
    };
  }

  /**
   * World 좌표 → Tile 좌표
   */
  worldToTile(worldX: number, worldZ: number): TileCoord {
    return {
      gridX: Math.floor(worldX / this.tileSize),
      gridY: Math.floor(worldZ / this.tileSize),
    };
  }

  /**
   * Cell 좌표 → 해당 Cell이 속한 Tile 좌표
   */
  cellToTile(cellX: number, cellZ: number): TileCoord {
    if (this.cellsPerTile >= 1) {
      // 여러 셀이 하나의 타일 안에 있음
      return {
        gridX: Math.floor(cellX / this.cellsPerTile),
        gridY: Math.floor(cellZ / this.cellsPerTile),
      };
    } else {
      // 하나의 셀이 여러 타일을 포함 (첫 번째 타일 반환)
      const tilesPerCell = 1 / this.cellsPerTile;
      return {
        gridX: cellX * tilesPerCell,
        gridY: cellZ * tilesPerCell,
      };
    }
  }

  /**
   * Tile 좌표 → 해당 Tile에 포함된 모든 Cell 좌표
   */
  tileToСells(gridX: number, gridY: number): CellCoord[] {
    const cells: CellCoord[] = [];

    if (this.cellsPerTile >= 1) {
      // 타일 안에 여러 셀이 있음
      const startCellX = gridX * this.cellsPerTile;
      const startCellZ = gridY * this.cellsPerTile;

      for (let dx = 0; dx < this.cellsPerTile; dx++) {
        for (let dz = 0; dz < this.cellsPerTile; dz++) {
          cells.push({
            x: startCellX + dx,
            z: startCellZ + dz,
          });
        }
      }
    } else {
      // 하나의 셀이 여러 타일을 포함
      const cellX = Math.floor(gridX * this.cellsPerTile);
      const cellZ = Math.floor(gridY * this.cellsPerTile);
      cells.push({ x: cellX, z: cellZ });
    }

    return cells;
  }

  /**
   * Cell 좌표 → 해당 Cell이 영향을 주는 모든 Tile 좌표
   * (셀이 여러 타일을 포함하는 경우)
   */
  cellToAffectedTiles(cellX: number, cellZ: number): TileCoord[] {
    const tiles: TileCoord[] = [];

    if (this.cellsPerTile >= 1) {
      // 하나의 셀은 하나의 타일에만 속함
      tiles.push(this.cellToTile(cellX, cellZ));
    } else {
      // 하나의 셀이 여러 타일을 포함
      const tilesPerCell = Math.ceil(1 / this.cellsPerTile);
      const startTileX = cellX * tilesPerCell;
      const startTileZ = cellZ * tilesPerCell;

      for (let dx = 0; dx < tilesPerCell; dx++) {
        for (let dz = 0; dz < tilesPerCell; dz++) {
          tiles.push({
            gridX: startTileX + dx,
            gridY: startTileZ + dz,
          });
        }
      }
    }

    return tiles;
  }

  /**
   * Cell 키 생성 (Map에서 사용)
   */
  getCellKey(cellX: number, cellZ: number): string {
    return `${cellX}_${cellZ}`;
  }

  /**
   * Tile 키 생성 (Map에서 사용)
   */
  getTileKey(gridX: number, gridY: number): string {
    return `${gridX}_${gridY}`;
  }

  /**
   * Cell 중심의 World 좌표 반환
   */
  getCellCenter(cellX: number, cellZ: number): WorldCoord {
    return {
      worldX: cellX * this.cellSize + this.cellSize / 2,
      worldZ: cellZ * this.cellSize + this.cellSize / 2,
    };
  }

  /**
   * Tile 중심의 World 좌표 반환
   */
  getTileCenter(gridX: number, gridY: number): WorldCoord {
    return {
      worldX: gridX * this.tileSize + this.tileSize / 2,
      worldZ: gridY * this.tileSize + this.tileSize / 2,
    };
  }

  /**
   * 두 Cell 간의 거리 (체비셰프 거리 - 최대 좌표 차이)
   */
  getCellDistance(cell1: CellCoord, cell2: CellCoord): number {
    return Math.max(Math.abs(cell1.x - cell2.x), Math.abs(cell1.z - cell2.z));
  }

  /**
   * 특정 Cell 주변의 N 범위 내 모든 Cell 반환
   */
  getCellsInRadius(centerX: number, centerZ: number, radius: number): CellCoord[] {
    const cells: CellCoord[] = [];
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        cells.push({
          x: centerX + dx,
          z: centerZ + dz,
        });
      }
    }
    return cells;
  }

  /**
   * 특정 Cell 주변의 N 범위 내 영향받는 모든 Tile 반환
   */
  getTilesInCellRadius(centerCellX: number, centerCellZ: number, radius: number): TileCoord[] {
    const tileSet = new Set<string>();
    const tiles: TileCoord[] = [];

    const cells = this.getCellsInRadius(centerCellX, centerCellZ, radius);
    for (const cell of cells) {
      const affectedTiles = this.cellToAffectedTiles(cell.x, cell.z);
      for (const tile of affectedTiles) {
        const key = this.getTileKey(tile.gridX, tile.gridY);
        if (!tileSet.has(key)) {
          tileSet.add(key);
          tiles.push(tile);
        }
      }
    }

    return tiles;
  }

  /**
   * Getters
   */
  getCellSize(): number {
    return this.cellSize;
  }

  getTileSize(): number {
    return this.tileSize;
  }

  getCellsPerTile(): number {
    return this.cellsPerTile;
  }
}
