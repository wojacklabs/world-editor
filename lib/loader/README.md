# World Editor Loader

World Editor에서 export한 JSON 데이터를 게임에서 렌더링하기 위한 라이브러리입니다.

## 설치

```bash
npm install @world-editor/loader
```

또는 소스 복사:
```
lib/loader/ → your-project/src/world/loader/
```

## v2.0.0 포맷 주의사항

- Loader는 `version: "2.0.0"` 월드만 로드합니다.
- Export JSON에는 `rendering` 섹션이 **필수**입니다.
- `rendering.textureUrls`의 `grass`, `dirt`, `rock`, `sand`, `leafAtlas` 키가 모두 있어야 합니다.

## 필수 텍스처 파일

다음 텍스처 파일들을 `public/textures/` 폴더에 복사해야 합니다:

| 파일명 | 용도 |
|--------|------|
| `grass_diff.(ktx2/jpg/png)` | 지형 잔디 biome |
| `dirt_diffuse.(ktx2/jpg/png)` | 지형 흙 biome + 나무 껍질 |
| `rock_diff.(ktx2/jpg/png)` | 지형 바위 biome + 바위 에셋 |
| `leaf_atlas.(png/ktx2)` | tree/bush leaf card 알파 컷아웃 |
| `rock_arm.jpg` | (선택) 바위 AO/Roughness/Metallic |
| `rock_nor.jpg` | (선택) 바위 노멀맵 |
| `waterbump.png` | 물 표면 범프맵 |

## 기본 사용법

```typescript
import {
  WorldLoader,
  TerrainRenderer,
  FoliageRenderer,
  ProceduralPropsRenderer,
  SkyWeatherRenderer,
  WaterRenderer,
} from '@world-editor/loader';

// 1. JSON 로드
const response = await fetch('./world.json');
const json = await response.text();
const result = WorldLoader.loadWorld(json);

if (!result.success || !result.data) {
  console.error('Failed to load world:', result.errors);
  return;
}

const worldData = result.data;
const tile = worldData.mainTile;
```

## 렌더러 상세

### 1. TerrainRenderer - 지형

하이트맵 기반 지형 메쉬를 생성합니다. biome 텍스처와 splatmap을 사용하여 다양한 지형 표현이 가능합니다.

```typescript
import { TerrainRenderer } from '@world-editor/loader';

// 지형 렌더러 생성
const terrainRenderer = new TerrainRenderer(scene, {
  lodEnabled: true,      // LOD 활성화
  useShader: true,       // 커스텀 셰이더 사용 (권장)
  textures: {
    grass: './textures/grass_diff.jpg',
    dirt: './textures/dirt_diffuse.jpg',
    rock: './textures/rock_diff.jpg',
    tileScale: 16,       // 텍스처 타일링 스케일
  },
});

// 지형 생성
terrainRenderer.create({
  heightmap: tile.heightmap,      // base64 인코딩된 높이맵
  resolution: tile.resolution,    // 높이맵 해상도 (예: 257)
  size: tile.size,                // 월드 사이즈 (예: 256)
  minHeight: tile.minHeight,      // 최소 높이
  maxHeight: tile.maxHeight,      // 최대 높이
  splatmap: tile.splatmap,        // base64 인코딩된 스플랫맵
});

// Fog 설정 (scene fog와 동기화)
terrainRenderer.setFog(scene.fogColor, scene.fogDensity);

// 물리 충돌용 메쉬 가져오기
const terrainMesh = terrainRenderer.getMesh();
```

**옵션:**

| 옵션 | 타입 | 기본값 | 설명 |
|------|------|--------|------|
| `lodEnabled` | boolean | true | LOD 활성화 |
| `useShader` | boolean | true | 커스텀 셰이더 사용 |
| `textures.grass` | string | - | 잔디 텍스처 경로 |
| `textures.dirt` | string | - | 흙 텍스처 경로 |
| `textures.rock` | string | - | 바위 텍스처 경로 |
| `textures.tileScale` | number | 16 | 텍스처 타일링 |

---

### 2. FoliageRenderer - 잔디/식생

InstancedMesh를 사용하여 대량의 잔디를 효율적으로 렌더링합니다.

```typescript
import { FoliageRenderer } from '@world-editor/loader';

const foliageRenderer = new FoliageRenderer(scene, {
  chunkSize: 16,              // 청크 크기
  maxInstancesPerChunk: 5000, // 청크당 최대 인스턴스
  renderingProfile: {
    foliageProfileVersion: worldData.rendering.foliageProfileVersion,
    proceduralProfileVersion: worldData.rendering.proceduralProfileVersion,
  },
  textureUrls: worldData.rendering.textureUrls,
  lodDistances: {
    near: 100,   // 풀 디테일 거리
    mid: 200,    // 중간 LOD 거리
    far: 450,    // 최대 가시 거리
  },
});

// 잔디/바위 foliage 데이터 로드 (mainTile 기준)
foliageRenderer.loadTile(worldData.mainTile!.foliage);

// 커스텀 설정
foliageRenderer.setSunDirection(new Vector3(-0.5, 0.8, -0.3));
foliageRenderer.setFog(new Color3(0.55, 0.7, 0.9), 0.008);
foliageRenderer.setWindStrength(0.15);

// 통계 확인
console.log(foliageRenderer.getStats());
// { totalInstances: 50000, chunkCount: 256, ... }
```

**포함된 기능:**
- 바람 애니메이션
- 거리 기반 LOD (크기 축소)
- exp2 fog
- vertex color 기반 라이팅

---

### 3. ProceduralPropsRenderer - 프로시저럴 에셋

에디터에서 생성한 바위, 나무, 덤불, 잔디 덩어리를 렌더링합니다.

```typescript
import { ProceduralPropsRenderer } from '@world-editor/loader';

const propsRenderer = new ProceduralPropsRenderer(scene, {
  useInstancing: false,  // false: 개별 메쉬 (품질↑), true: 인스턴싱 (성능↑)
  lodDistances: {
    near: 100,
    mid: 200,
    far: 450,
  },
  windAngle: Math.PI / 4,   // 바람 방향 (라디안)
  windStrength: 0.5,        // 바람 세기 (0~1)
  renderingProfile: worldData.rendering.proceduralProfileVersion,
  textureUrls: {
    rock: worldData.rendering.textureUrls.rock,
    dirt: worldData.rendering.textureUrls.dirt,
    leafAtlas: worldData.rendering.textureUrls.leafAtlas,
  },
});

// Props 로드
propsRenderer.loadProps(worldData.proceduralProps);

// 바람 설정 변경
propsRenderer.setWind(45, 0.5);  // 각도(도), 세기

// 가시성 토글
propsRenderer.setVisible(true);

// 통계
console.log('Props count:', propsRenderer.getPropCount());
```

**에셋 타입별 특징:**

| 타입 | 텍스처 | 바람 | 설명 |
|------|--------|------|------|
| `rock` | rock_diff.jpg (triplanar) | 없음 | 바위 에셋, edge smoothing |
| `tree` | dirt_diffuse + leaf_atlas | O | 나무, bark + leaf card |
| `bush` | leaf_atlas (+ twig bark) | O | 덤불, leaf card 클러스터 |
| `grass_clump` | dirt_diffuse.jpg (bark) | O | 잔디 덩어리 |

---

### 4. SkyWeatherRenderer - 하늘/날씨

동적 하늘과 날씨 효과를 렌더링합니다.

```typescript
import { SkyWeatherRenderer } from '@world-editor/loader';

const skyRenderer = new SkyWeatherRenderer(scene, {
  timeOfDay: 0.3,           // 시간 (0~1, 0.25=일출, 0.5=정오, 0.75=일몰)
  weatherIntensity: 0.0,    // 날씨 강도 (0=맑음, 1=폭풍)
  cloudCoverage: 0.3,       // 구름 양 (0~1)
  windSpeed: 0.5,           // 구름 이동 속도
});

// 날씨 데이터 적용
if (worldData.weather) {
  skyRenderer.setTimeOfDay(worldData.weather.timeOfDay);
  skyRenderer.setWeatherIntensity(worldData.weather.intensity);
}

// 실시간 업데이트 (게임 루프에서)
skyRenderer.update(deltaTime);

// Scene fog 색상과 동기화
scene.fogColor = skyRenderer.getFogColor();
```

---

### 5. WaterRenderer - 물

반사/굴절 효과가 있는 물 표면을 렌더링합니다.

```typescript
import { WaterRenderer } from '@world-editor/loader';

const waterRenderer = new WaterRenderer(scene, {
  waterLevel: tile.seaLevel ?? 10,  // 수면 높이
  size: tile.size,                   // 물 평면 크기
  subdivisions: 64,                  // 메쉬 세분화
  bumpTexture: './textures/waterbump.png',
});

// 물 속성 조정
waterRenderer.setWaterColor(new Color3(0.1, 0.3, 0.5));
waterRenderer.setWindForce(1.0);
waterRenderer.setWaveHeight(0.4);
```

---

## 전체 예제

```typescript
import * as THREE from 'three';
import {
  WorldLoader,
  TerrainRenderer,
  FoliageRenderer,
  ProceduralPropsRenderer,
  SkyWeatherRenderer,
} from '@world-editor/loader';

class Game {
  private scene: THREE.Scene;
  private terrainRenderer: TerrainRenderer | null = null;
  private foliageRenderer: FoliageRenderer | null = null;
  private propsRenderer: ProceduralPropsRenderer | null = null;
  private skyRenderer: SkyWeatherRenderer | null = null;

  async loadWorld(jsonPath: string): Promise<void> {
    // 1. JSON 파싱
    const response = await fetch(jsonPath);
    const json = await response.text();
    const result = WorldLoader.loadWorld(json);

    if (!result.success || !result.data) {
      throw new Error(`Failed to load world: ${result.errors.join(", ")}`);
    }

    const worldData = result.data;
    const tile = worldData.mainTile;

    // 2. 하늘 렌더러
    this.skyRenderer = new SkyWeatherRenderer(this.scene, {
      timeOfDay: worldData.weather?.timeOfDay ?? 0.3,
      weatherIntensity: worldData.weather?.intensity ?? 0,
    });

    // 4. 지형 렌더러
    this.terrainRenderer = new TerrainRenderer(this.scene, {
      useShader: true,
      textures: {
        grass: './textures/grass_diff.jpg',
        dirt: './textures/dirt_diffuse.jpg',
        rock: './textures/rock_diff.jpg',
        tileScale: 16,
      },
    });

    this.terrainRenderer.create({
      heightmap: tile.heightmap,
      resolution: tile.resolution,
      size: tile.size,
      minHeight: tile.minHeight,
      maxHeight: tile.maxHeight,
      splatmap: tile.splatmap,
    });

    this.terrainRenderer.setFog(new THREE.Color(0.55, 0.7, 0.9), 0.008);

    // 5. 잔디/바위 foliage 렌더러
    if (worldData.mainTile?.foliage) {
      this.foliageRenderer = new FoliageRenderer(this.scene, {
        renderingProfile: {
          foliageProfileVersion: worldData.rendering.foliageProfileVersion,
          proceduralProfileVersion: worldData.rendering.proceduralProfileVersion,
        },
        textureUrls: worldData.rendering.textureUrls,
        lodDistances: { near: 100, mid: 200, far: 450 },
      });
      this.foliageRenderer.loadTile(worldData.mainTile.foliage);
      this.foliageRenderer.setFog(new THREE.Color(0.55, 0.7, 0.9), 0.008);
    }

    // 6. 프로시저럴 Props 렌더러
    if (worldData.proceduralProps?.length > 0) {
      this.propsRenderer = new ProceduralPropsRenderer(this.scene, {
        useInstancing: false,
        renderingProfile: worldData.rendering.proceduralProfileVersion,
        textureUrls: {
          rock: worldData.rendering.textureUrls.rock,
          dirt: worldData.rendering.textureUrls.dirt,
          leafAtlas: worldData.rendering.textureUrls.leafAtlas,
        },
      });
      this.propsRenderer.loadProps(worldData.proceduralProps);
    }

    console.log('World loaded successfully!');
  }

  update(deltaTime: number): void {
    // 하늘 업데이트 (시간 경과 등)
    this.skyRenderer?.update(deltaTime);
  }

  dispose(): void {
    this.terrainRenderer?.dispose();
    this.foliageRenderer?.dispose();
    this.propsRenderer?.dispose();
    this.skyRenderer?.dispose();
  }
}
```

---

## JSON 데이터 구조

WorldLoader가 파싱하는 JSON 구조:

```typescript
interface WorldData {
  mainTile: {
    heightmap: string;      // base64
    splatmap: string;       // base64
    resolution: number;     // 257
    size: number;           // 256
    minHeight: number;
    maxHeight: number;
    seaLevel?: number;
  };
  foliage?: {
    grass?: { matrices: string };  // base64 Float32Array
    rock?: { matrices: string };
    tree?: { matrices: string };
    flower?: { matrices: string };
    bush?: { matrices: string };
  };
  proceduralProps?: ProceduralPropInstance[];
  props?: PropInstance[];           // GLB props
  weather?: {
    timeOfDay: number;
    intensity: number;
    fogDensity: number;
  };
}

interface ProceduralPropInstance {
  id: string;
  assetType: 'rock' | 'tree' | 'bush' | 'grass_clump';
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
  params: {
    seed: number;
    sizeVariation: number;
    noiseScale: number;
    noiseAmplitude: number;
    colorBase: { r: number; g: number; b: number };
    colorDetail: { r: number; g: number; b: number };
  };
}
```

---

## 성능 최적화 팁

1. **LOD 거리 조정**: 저사양에서는 `lodDistances.far`를 줄이세요
2. **인스턴싱 사용**: Props가 많으면 `useInstancing: true`
3. **청크 크기**: 넓은 맵에서는 `chunkSize`를 늘리세요 (16→32)
4. **Fog 활용**: fog로 먼 거리 오브젝트를 자연스럽게 페이드

---

## 에디터와의 일치

Loader는 에디터와 동일한 셰이더/텍스처를 사용하여 WYSIWYG를 보장합니다:

- **Fog**: exp2 fog, density 0.008
- **바위 텍스처**: triplanar rock_diff.jpg, 70% 블렌딩
- **나무 껍질**: triplanar dirt_diffuse.jpg, 40% 블렌딩
- **바람**: 동일한 노이즈 함수와 파라미터
- **라이팅**: half-Lambert diffuse, rim lighting, SSS

---

## 라이센스

MIT
