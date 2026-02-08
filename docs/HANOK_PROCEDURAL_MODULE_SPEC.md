# 한옥(기와집/초가집) Procedural Modular Spec v1

## 1) 목적

Three.js 기반 월드 에디터에서 한국 전통 가옥(기와집, 초가집)을 통짜 모델이 아닌 모듈 조합형 procedural 구조물로 생성한다.

- 입력: 길이/너비/높이, 집 유형, 평면 성향
- 출력: 생활 구조가 반영된 가변형 한옥 본채 메시 + 독립 소품 배치 포인트
- 핵심 원칙: `건물 본체(구조)`와 `꾸밈 오브젝트(담벼락/장독대/개집)`를 분리한다.

---

## 2) 범위와 비범위

### 범위

- 기와집/초가집 본채 procedural 생성
- 온돌-부엌(아궁이)-굴뚝 연계 규칙 반영
- 대청/툇마루/창호(문풍지 계열) 반영
- 지붕 유형별 생성 규칙 반영

### 비범위 (v1 제외)

- 시대별 완전 고증(조선 전기/후기 세부 분기)
- 지역 방언식 명칭 UI 지원
- 실내 가구 자동 풀 세팅

---

## 3) 핵심 도메인 모델

건물은 메시 조각이 아니라 `생활 기능 모듈`의 연결 그래프로 정의한다.

```ts
export type HouseType = "giwa" | "choga";
export type PlanArchetype = "single_row" | "l_shape" | "u_shape" | "courtyard";

export type ModuleType =
  | "ondol_room"       // 온돌방
  | "daecheong"        // 대청마루
  | "kitchen_agungi"   // 부엌 + 아궁이
  | "storage_room"     // 고방/창고
  | "toe_maru"         // 툇마루
  | "main_gate_unit"   // 대문간
  | "chimney"          // 굴뚝
  | "wall_bay"         // 벽체 칸
  | "door_bay"         // 창호 칸
  | "roof_segment";    // 지붕 세그먼트

export interface HouseDimensions {
  lengthM: number;     // X
  widthM: number;      // Z
  wallHeightM: number; // 처마 아래 벽 높이
}

export interface HouseConfig {
  houseType: HouseType;
  archetype: PlanArchetype;
  dimensions: HouseDimensions;
  baySizeM: number; // 기본 칸 모듈. 기본값 2.4m 권장
  story: 1;         // v1은 단층
  seed: number;
}
```

---

## 4) 파라미터 정규화 규칙

입력 치수를 바로 쓰지 않고 `칸(bay)` 격자로 정규화한다.

1. `xBays = round(lengthM / baySizeM)`
2. `zBays = round(widthM / baySizeM)`
3. 최소 크기 강제
- `xBays >= 3`
- `zBays >= 2`
4. 높이 제한
- `wallHeightM: 2.0 ~ 3.2`
5. 지붕 높이 비율
- 기와집: `roofRise = wallHeight * 0.55 ~ 0.85`
- 초가집: `roofRise = wallHeight * 0.65 ~ 1.05`

---

## 5) 필수 생활 구조 규칙 (고정 제약)

### 5.1 온돌-부엌-굴뚝 연계

- `kitchen_agungi`는 최소 1개 `ondol_room`과 변을 공유해야 한다.
- `chimney`는 `kitchen_agungi`에서 시작하는 연도 경로의 외벽 끝점에 생성한다.
- 연도 경로 길이는 최소 1 bay 이상 확보한다.

### 5.2 대청/툇마루 결합

- `daecheong`은 내부 중심 또는 중심 인접 칸에 배치한다.
- `toe_maru`는 온돌방 전면 외곽 edge를 따라 연속 배치한다.
- 대청과 툇마루 사이에는 최소 1개 출입 가능한 `door_bay`를 둔다.

### 5.3 창호(문풍지 계열) 규칙

- 외기에 면하는 `ondol_room`에는 최소 1개 `door_bay` 또는 창호 칸을 둔다.
- 창호는 `solid_lower_panel + lattice_upper_panel + paper_layer` 구조를 기본으로 한다.
- 단열형 옵션일 때 `paper_layer`를 이중 처리(맹장지 계열 표현)한다.

---

## 6) 유형별 생성 프로파일

## 6.1 기와집 (`houseType = "giwa"`)

- 기본 지붕: `paljak` 우선, 대체로 `matbae` 허용
- 처마 오버행: `0.7m ~ 1.2m`
- 기단(기초) 높이: `0.35m ~ 0.65m`
- 외벽 질감: 회벽/목재 혼합
- 추천 평면: `single_row`, `l_shape`, `courtyard`

## 6.2 초가집 (`houseType = "choga"`)

- 기본 지붕: 초가 우진각 계열 또는 단순 맞배형 초가
- 용마름(능선부) 별도 생성
- 처마 오버행: `0.55m ~ 0.9m`
- 기단 높이: `0.2m ~ 0.45m`
- 외벽 질감: 흙벽 + 목재 골조 노출 비율 높음
- 추천 평면: `single_row`, `l_shape`

---

## 7) 모듈 카탈로그 (v1)

모든 모듈은 `(bayX, bayZ, sockets[])`를 가진다.

### 필수 모듈

1. `ondol_room`
- 기본 크기: `1x1`, `2x1`
- 소켓: `door`, `wall`, `flue_in`

2. `kitchen_agungi`
- 기본 크기: `1x1`
- 소켓: `door`, `flue_out`, `service_yard`

3. `daecheong`
- 기본 크기: `1x1`, `2x1`
- 소켓: `door`, `open_side`

4. `toe_maru`
- 기본 크기: `1xN edge strip`
- 소켓: `room_front`, `outer_edge`

5. `storage_room`
- 기본 크기: `1x1`
- 소켓: `door`, `wall`

6. `chimney`
- 기본 크기: `0.5x0.5` (월드미터 기반)
- 소켓: `flue_terminal`

---

## 8) 평면 생성 알고리즘

```text
1) 입력 파라미터 정규화 (meter -> bay grid)
2) archetype에 맞는 footprint 생성
3) 필수 모듈 배치:
   - kitchen_agungi
   - ondol_room >= 1
   - daecheong >= 1
4) 제약 충족 검사:
   - kitchen 인접 ondol
   - flue path 외벽 연결
   - toe_maru 연결성
5) 비필수 모듈 배치:
   - storage_room
   - main_gate_unit (옵션)
6) 벽체/창호 베이 분배
7) 지붕 세그먼트 생성 및 병합
8) 메시 빌드 + 재질 할당 + 콜라이더 생성
9) 배치 포인트(장독대/담벼락/개집 후보) 출력
```

---

## 9) 지붕 생성 규칙

### 공통

- 지붕은 footprint 외곽선을 따라 segment 단위로 생성
- 능선/마루는 profile curve 기반 스윕
- 처마 끝선은 벽선보다 외측 오프셋

### 기와집

- 기와 타일을 전부 개별 메시로 생성하지 않고 strip instancing 사용
- 용마루/추녀마루는 별도 segment
- 팔작일 때 박공면과 사면의 접합 seam 보정

### 초가집

- 초가 표면은 fiber normal 맵 기반 쉐이딩 + 저밀도 실루엣 지오메트리
- 용마름은 별도 메쉬 띠
- 이엉 결 방향은 처마에서 마루 방향으로 정렬

---

## 10) 창호/문 디테일 규칙

`door_bay` 생성 시 아래 타입 중 하나를 배정한다.

- `single_hinged_paper_door`
- `double_hinged_paper_door`
- `sliding_misegi_paper_door`

구조 계층:

1. frame (wood)
2. lattice (wood)
3. lower_panel (wood, optional)
4. paper_layer (hanji look)

재질 파라미터 예시:

```ts
paper: {
  baseColor: "#f3f0e6";
  roughness: 0.92;
  translucency: 0.35;
}
wood: {
  baseColor: "#6b4a2f";
  roughness: 0.78;
}
```

---

## 11) 독립 배치 오브젝트 분리 스펙

아래 항목은 건물 생성기에서 직접 합치지 않고 독립 procedural asset으로 관리한다.

1. `wall_fence_segment` (담벼락)
2. `jangdokdae_set` (장독대)
3. `doghouse` (개집)

건물 생성기는 `recommendedPlacementAnchors`만 반환한다.

```ts
export interface PlacementAnchor {
  type: "service_yard" | "rear_yard" | "gate_side" | "wall_line";
  position: [number, number, number];
  normal: [number, number, number];
  radiusM: number;
}
```

권장 배치:

- 장독대: `service_yard` 또는 `rear_yard`에 우선 배치
- 담벼락: `wall_line` anchor를 연결한 spline 생성
- 개집: 출입 동선을 막지 않는 `gate_side` 외곽

---

## 12) 엔진 통합 제안 (현재 코드베이스 기준)

기존 `rock/tree/bush/grass_clump` 중심 procedural 생성과 분리된 구조물 전용 경로를 추가한다.

1. 신규 타입 추가
- 파일: `lib/editor/props/ProceduralAsset.ts`
- `AssetType` 확장 후보:
  - `hanok_giwa`
  - `hanok_choga`
  - `wall_fence_segment`
  - `jangdokdae_set`
  - `doghouse`

2. 생성기 분리
- 파일: `lib/editor/props/HanokGenerator.ts` (신규)
- 책임:
  - bay grid 생성
  - 모듈 배치/검증
  - 지붕 생성
  - anchor 출력

3. 로더 동기화
- 파일: `lib/loader/ProceduralAssetGenerator.ts`
- 에디터와 동일 규칙으로 런타임 메시 재생성 가능해야 함

---

## 13) 검증 체크리스트

- [ ] `kitchen_agungi` 없는 집이 생성되지 않는다.
- [ ] `ondol_room` 없는 집이 생성되지 않는다.
- [ ] 아궁이-굴뚝 경로가 외벽으로 닫힌다.
- [ ] 대청/툇마루 동선이 끊기지 않는다.
- [ ] 창호가 없는 외기 면 방이 생성되지 않는다.
- [ ] 담벼락/장독대/개집이 건물 본체 메시에 병합되지 않는다.
- [ ] 동일 seed에서 동일 결과가 나온다.
- [ ] seed만 바꾸면 합리적인 변형이 발생한다.

---

## 14) v1 구현 우선순위

1. `single_row` + 기와집/초가집 기본형
2. 온돌-부엌-굴뚝 제약 구현
3. 대청/툇마루 연결 구현
4. 지붕 타입 분기(기와/초가)
5. 독립 소품 anchor 출력
6. `l_shape` 확장

---

## 15) 참고 개념 키워드 (조사 근거)

- 안채/사랑채/행랑채/문간채의 채 분화
- 온돌(구들)-아궁이-굴뚝 연계
- 대청마루/툇마루의 통풍·동선 기능
- 장지/미세기/창호지 기반 창호 구조
- 기와집(팔작/맞배)과 초가(이엉/용마름) 지붕 체계

