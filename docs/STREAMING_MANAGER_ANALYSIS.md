# StreamingManager Implementation Analysis

> 분석 일자: 2026-01-23
> 상태: 분석 완료, 구현 대기

## 개요

타일 기반 월드 스트리밍 시스템 구현을 위한 breaking changes 분석 문서.

## 아키텍처 결정

### TerrainMesh LOD: Option A (분리 유지) ✓

```
StreamingManager: 타일 로드/언로드 관리
TerrainMesh LOD: 개별 타일의 시각적 품질 (4-level)
```

**이유:**
- 기존 LOD 시스템 작동 중 - 리팩토링 불필요
- 역할 명확히 분리 - 각 시스템 독립적 최적화 가능
- 위험도 낮음 - 검증된 코드 건드리지 않음

### Thin Instance: Option A (셀별 별도 메시) 권장

**현재 문제:**
- 부분 업데이트 불가 - 전체 버퍼 재업로드 필요
- 셀 하나 변경해도 전체 재생성

**권장:**
```
셀 (0,0) → grass_mesh_0_0, rock_mesh_0_0, ...
셀 (1,0) → grass_mesh_1_0, rock_mesh_1_0, ...
```

---

## Breaking Changes 상세

### 🔴 Critical (HIGH)

#### 1. 브러시 편집 시스템
- **파일:** `EditorEngine.ts` (applyBrush, applyBrushToNeighborTile)
- **문제:** 언로드된 타일 편집 시 크래시
- **해결:** 편집 전 로드 상태 체크, dirty 타일 언로드 방지

#### 2. 엣지 동기화
- **파일:** `EditorEngine.ts` (syncTileEdges, syncTwoEdgesSmooth)
- **문제:** neighbor 언로드 상태에서 sync 시도
- **해결:** 모든 neighbor 로드 확인 후 동기화

#### 3. 폴리지 확장
- **파일:** `GamePreview.ts` (extendFoliage)
- **문제:** 타일 로드 전 폴리지 확장 시도
- **해결:** 모든 셀 로드 await 후 확장

### 🟡 Major (MEDIUM)

#### 4. Water System
- **파일:** `EditorEngine.ts` (neighborWaterMeshes), `WaterShader.ts`
- **문제:** heightmap 텍스처 동기화 필요
- **해결:** 타일 로드 시 waterSystem.updateHeightmapTexture() 호출

#### 5. Props
- **파일:** `PropManager.ts`
- **문제:** 현재 타일 인식 없음, 전역 리스트
- **해결:** 타일별 그룹화, 로드/언로드 시 함께 처리

#### 6. Collision Proxy
- **파일:** `CollisionProxy.ts`
- **문제:** 전체 터레인 가정
- **해결:** 타일 로드/언로드 시 재빌드

#### 7. Material 공유
- **파일:** `EditorEngine.ts`, `TerrainMesh.ts`
- **문제:** neighbor 타일 동일 material → LOD 전환 시 영향
- **해결:** 타일별 material 인스턴스 분리

#### 8. editableTileData 라이프사이클
- **파일:** `EditorEngine.ts`
- **문제:** 언로드 시 미저장 데이터 손실
- **해결:** 언로드 전 auto-save 또는 dirty 체크

#### 9. Camera Focus
- **파일:** `EditorEngine.ts` (focusOnGridCell)
- **문제:** 셀 로드 대기 필요
- **해결:** async/await 패턴으로 변경

### 🟢 Low

#### 10. ImpostorSystem
- 원거리 전용, 스트리밍과 겹침 적음
- 선택적 통합

#### 11. Debug 메시
- 언로드 대상에서 제외 필요
- 태그 기반 필터링

#### 12. Grid UI / Lighting
- 영향 없음

---

## 수정 필요 파일

| 파일 | 예상 변경량 | 우선순위 |
|------|------------|----------|
| EditorEngine.ts | 1000-1500줄 | 1 |
| FoliageSystem.ts | 200-300줄 | 2 |
| GamePreview.ts | 100-200줄 | 3 |
| BiomeDecorator.ts | 100-150줄 | 4 |
| PropManager.ts | 100-150줄 | 5 |
| CollisionProxy.ts | 50-100줄 | 6 |
| ManualTileManager.ts | 50-100줄 | 7 |
| WaterShader.ts | 30-50줄 | 8 |

**수정 안해도 되는 파일:**
- TerrainMesh.ts (기존 4-level LOD 유지)
- TerrainShader.ts
- Heightmap.ts
- SplatMap.ts

---

## 구현 단계

### Phase 1: Core Integration (2-3일)
- StreamingManager 콜백 연동 (onLoadCell, onUnloadCell)
- 기본 타일 dispose on unload

### Phase 2: Tile Lifecycle (1-2일)
- editableTileData 라이프사이클 관리
- per-tile dirty flag
- auto-save before unload

### Phase 3: FoliageSystem (2-3일)
- 청크→셀 매핑
- 셀별 thin instance 버퍼
- getChunksInCell(), unloadChunk()

### Phase 4: BiomeDecorator (1일)
- 셀별 rebuild

### Phase 5: Water/Props/Collision (2일)
- Water heightmap sync
- Props 타일 그룹화
- Collision proxy rebuild

### Phase 6: Input Protection (1일)
- 편집 중 타일 언로드 방지
- neighbor mesh preservation

### Phase 7: GamePreview & UI (1-2일)
- async tile creation
- Loading states

### Phase 8: Testing (2-3일)
- 타일 로드/언로드 사이클
- 브러시 편집
- 게임 모드 전환

---

## 총 예상 작업량

- **파일 수:** ~10개
- **코드 변경:** ~2000-2500줄
- **예상 기간:** 3-4주

---

## 참고: Thin Instance 메모리 계산

```
셀당 ~5,000 인스턴스 × 16 floats × 4 bytes = 320KB
9셀 total = 2.88MB
1셀 언로드 → 8셀 2.56MB 재업로드 + GPU 동기화
```

GamePreview 9x 확장 시:
```
Original: ~5,000 instances
Extended: ~45,000 instances (288KB per mesh ≈ 2.8MB total)
전체 폴리지 타입 합계: ~288MB
```

---

## 관련 코드 위치

### EditorEngine.ts
- `neighborTileMeshes`: line 89
- `neighborFoliageMeshes`: line 90
- `editableTileData`: line 96
- `syncTileEdges()`: line 501
- `applyBrush()`: line 1047
- `focusOnGridCell()`: line 2727

### FoliageSystem.ts
- Chunk size: 16 (line 328)
- `generateChunk()`: line 1015
- `thinInstanceSetBuffer`: line 1078

### GamePreview.ts
- `extendFoliageMirrored()`: line 562
- `originalFoliageMatrices`: line 41

### TerrainMesh.ts
- 4-level LOD: line 125-163
- `switchLOD()`: line 316

---

## 결론

StreamingManager 구현은 가능하지만 상당한 통합 작업 필요.
Option A (TerrainMesh LOD 분리 유지)가 가장 안전한 접근법.
단기적으로는 다른 우선순위 작업 먼저 진행 후 추후 구현 권장.
