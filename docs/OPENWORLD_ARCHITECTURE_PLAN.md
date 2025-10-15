# 오픈월드 RPG 아키텍처 개선 계획

## 개요

Babylon.js 기반 world-editor를 엔터프라이즈 레벨의 오픈월드 RPG 에디터로 개선하기 위한 단계별 구현 계획입니다.

**핵심 원칙**: 셀 스트리밍 + 레이어 분리 + LOD/밀도 예산 + 텍스처 압축

---

## Phase 1: 성능 기반 (즉시)

### 1.1 Thin Instance 도입
- **목표**: 식생/프롭 드로우 콜 대폭 감소
- **현재**: 개별 Mesh 생성 (1000개 풀 = 1000 드로우 콜)
- **개선**: Thin Instance 사용 (1000개 풀 = 1 드로우 콜)
- **파일**: `lib/editor/terrain/FoliageSystem.ts` (신규)
- **작업**:
  - [ ] FoliageSystem 클래스 생성
  - [ ] Thin Instance 기반 풀/나무/돌 배치
  - [ ] 청크(패치) 단위 메쉬 분할 (32x32 단위)
  - [ ] BiomeDecorator와 통합

### 1.2 KTX2 텍스처 압축
- **목표**: VRAM 50-75% 절감, 로딩 시간 단축
- **현재**: JPG 직접 로드 (비압축 → GPU 메모리 낭비)
- **개선**: KTX2(Basis Universal) GPU 압축 텍스처
- **작업**:
  - [ ] @babylonjs/core KTX2 로더 활성화
  - [ ] 기존 텍스처를 KTX2로 변환 (toktx 사용)
  - [ ] TerrainShader.ts 텍스처 로딩 수정
  - [ ] Near/Mid/Far 해상도 차등 적용

### 1.3 청크 기반 식생 컬링
- **목표**: 화면 밖 식생 렌더링 방지
- **현재**: 전체 식생 항상 렌더링
- **개선**: 청크 단위 가시성 체크
- **작업**:
  - [ ] FoliageChunk 클래스 (32x32 영역)
  - [ ] 프러스텀 컬링 적용
  - [ ] 거리 기반 밀도 조절

---

## Phase 2: 스트리밍 인프라 (단기)

### 2.1 TerrainTileManager 활성화
- **목표**: 타일 기반 지형 시스템 완성
- **현재**: TerrainTile/TileManager 존재하나 미연결
- **개선**: EditorEngine과 완전 통합
- **작업**:
  - [ ] TerrainTileManager를 EditorEngine에 연결
  - [ ] 단일 TerrainMesh → 타일 그리드 전환
  - [ ] 타일 경계 Seam 처리 검증
  - [ ] 타일별 독립 SplatMap

### 2.2 AssetContainer 기반 로딩
- **목표**: 깔끔한 로드/언로드 관리
- **현재**: 직접 씬에 추가/제거
- **개선**: AssetContainer 단위 관리
- **작업**:
  - [ ] loadAssetContainerAsync 래퍼 함수
  - [ ] 레이어별 컨테이너 분리 (terrain/props/foliage)
  - [ ] 컨테이너 풀링 시스템

### 2.3 Near/Mid/Far 스트리밍 링
- **목표**: 카메라 주변만 고품질 로드
- **현재**: 전체 월드 메모리 상주
- **개선**: 거리 기반 로드/언로드
- **셀 스펙**:
  - 셀 크기: 64x64 (현재) → 확장 가능
  - Near: 3x3 셀 (풀 디테일)
  - Mid: 5x5 셀 (중간 LOD)
  - Far: 7x7 셀 (최소 LOD)
- **작업**:
  - [ ] StreamingManager 클래스 생성
  - [ ] 카메라 위치 기반 셀 로드 큐
  - [ ] 비동기 로딩 + 우선순위

---

## Phase 3: 품질 향상 (중기)

### 3.1 바이옴 마스크 확장
- **목표**: 더 정교한 지형 블렌딩
- **현재**: SplatMap RGBA (Grass/Dirt/Rock/Sand)
- **개선**: 다중 마스크 채널
- **마스크 구조**:
  ```
  biomeMask (RGBA): grassland/forest/rocky/desert
  slopeMask (R): 경사도 (0-1)
  wetnessMask (R): 습도 (강/호수/해안)
  roadMask (R): 도로/길
  ```
- **작업**:
  - [ ] SplatMap 확장 (2번째 텍스처 추가)
  - [ ] 셰이더 마스크 샘플링 추가
  - [ ] 에디터 UI에 마스크 브러시 추가

### 3.2 경사 트리플래너 매핑
- **목표**: 절벽 UV 스트레칭 제거
- **현재**: 전면 UV 매핑
- **개선**: 경사 임계값 이상만 트리플래너
- **작업**:
  - [ ] 셰이더에 트리플래너 함수 추가
  - [ ] 경사도 기반 블렌딩 (threshold: 0.7)
  - [ ] 성능 프로파일링

### 3.3 매크로 변조 시스템
- **목표**: 대규모 타일 반복 완전 제거
- **현재**: UV 노이즈만 적용
- **개선**: 매크로 컬러/노멀 변조
- **작업**:
  - [ ] 매크로 컬러맵 (저해상도, 월드 스케일)
  - [ ] 매크로 노멀 변조
  - [ ] 디테일 노멀과 블렌딩

### 3.4 Impostor 시스템 (빌보드)
- **목표**: 원거리 나무 성능 최적화
- **현재**: 모든 거리에서 3D 메쉬
- **개선**: Far 거리에서 빌보드 전환
- **작업**:
  - [ ] 나무별 빌보드 텍스처 생성
  - [ ] 거리 기반 자동 전환
  - [ ] 전환 시 페이드 블렌딩

---

## Phase 4: 게임플레이 통합 (장기)

### 4.1 NavMesh 통합
- **목표**: AI 길찾기 지원
- **라이브러리**: recast-navigation
- **작업**:
  - [ ] NavMesh 생성 파이프라인
  - [ ] 타일별 NavMesh 청크
  - [ ] 런타임 쿼리 API

### 4.2 Collision Proxy
- **목표**: 물리 연산 최적화
- **현재**: 풀 메쉬로 충돌 검사
- **개선**: 저폴리 충돌 전용 메쉬
- **작업**:
  - [ ] 지형 충돌 프록시 생성
  - [ ] 프롭별 간소화 충돌체
  - [ ] 충돌 레이어 분리

### 4.3 레이어 우선순위 로딩
- **목표**: 체감 로딩 품질 향상
- **로딩 순서**:
  1. Terrain (지형)
  2. Collision/Nav (충돌/길찾기)
  3. Structures (큰 구조물)
  4. Props (소품)
  5. Foliage (식생)
  6. Gameplay (트리거/NPC)
- **작업**:
  - [ ] 레이어별 로딩 큐
  - [ ] 우선순위 스케줄러
  - [ ] 로딩 진행률 UI

---

## 파일 구조 변경 계획

```
lib/editor/
├── core/
│   ├── EditorEngine.ts          # 기존 (수정)
│   ├── StreamingManager.ts      # 신규 - 셀 스트리밍
│   └── AssetContainerPool.ts    # 신규 - 컨테이너 풀링
│
├── terrain/
│   ├── TerrainTileManager.ts    # 기존 (활성화)
│   ├── TerrainTile.ts           # 기존 (수정)
│   ├── TerrainShader.ts         # 기존 (트리플래너 추가)
│   ├── SplatMap.ts              # 기존 (마스크 확장)
│   └── MacroVariation.ts        # 신규 - 매크로 변조
│
├── foliage/                     # 신규 폴더
│   ├── FoliageSystem.ts         # 식생 총괄
│   ├── FoliageChunk.ts          # 청크 단위 관리
│   ├── ThinInstancePool.ts      # Thin Instance 풀
│   └── ImpostorSystem.ts        # 빌보드 시스템
│
├── streaming/                   # 신규 폴더
│   ├── CellManager.ts           # 셀 그리드 관리
│   ├── LoadingQueue.ts          # 비동기 로딩 큐
│   └── LayerLoader.ts           # 레이어별 로더
│
└── physics/                     # 신규 폴더
    ├── CollisionProxy.ts        # 충돌 프록시
    └── NavMeshBuilder.ts        # NavMesh 생성
```

---

## 텍스처 파이프라인 변경

### 현재
```
source.jpg → Texture() → GPU (비압축)
```

### 개선
```
source.png → toktx (KTX2) → texture.ktx2 → GPU (압축)

해상도 정책:
- Near: 2048x2048
- Mid: 1024x1024  
- Far: 512x512
```

### 변환 명령어
```bash
# KTX2 변환 (Basis Universal)
toktx --t2 --bcmp rock_diff.ktx2 rock_diff.png
toktx --t2 --bcmp --normal_mode rock_nor.ktx2 rock_nor.png
```

---

## 성능 목표

| 지표 | 현재 | Phase 1 후 | Phase 2 후 |
|------|------|-----------|-----------|
| 드로우 콜 (식생 1만개) | ~10,000 | ~100 | ~50 |
| VRAM 사용량 | ~500MB | ~200MB | ~150MB |
| 프레임 시간 | ~20ms | ~12ms | ~8ms |
| 로딩 시간 | 전체 로드 | 점진적 | 스트리밍 |

---

## 구현 순서

### 즉시 (Phase 1)
1. FoliageSystem + Thin Instance
2. KTX2 텍스처 변환
3. 청크 기반 컬링

### 1-2주 (Phase 2)
4. TerrainTileManager 연결
5. AssetContainer 도입
6. 스트리밍 링 기본 구현

### 2-4주 (Phase 3)
7. 바이옴 마스크 확장
8. 트리플래너 매핑
9. 매크로 변조
10. Impostor 시스템

### 1-2개월 (Phase 4)
11. NavMesh 통합
12. Collision Proxy
13. 레이어 우선순위 로딩

---

## 참고 자료

- [Babylon.js Thin Instances](https://doc.babylonjs.com/features/featuresDeepDive/mesh/copies/thinInstances)
- [Babylon.js KTX2 Textures](https://doc.babylonjs.com/features/featuresDeepDive/materials/using/ktx2Compression)
- [Babylon.js AssetContainer](https://doc.babylonjs.com/features/featuresDeepDive/importers/assetContainers)
- [Babylon.js TerrainMaterial](https://doc.babylonjs.com/toolsAndResources/assetLibraries/materialsLibrary/terrainMat)
