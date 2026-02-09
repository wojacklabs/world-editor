import * as THREE from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";

export type KoreanStructureType =
  | "hanok_giwa"
  | "hanok_choga"
  | "wall_fence_segment"
  | "jangdokdae_set"
  | "doghouse";

export type HanokPlanPreset =
  | "auto"
  | "linear"
  | "l_shape"
  | "u_shape"
  | "courtyard";

export interface StructureDimensions {
  lengthM: number;
  widthM: number;
  heightM: number;
  baySizeM?: number;
  planPreset?: HanokPlanPreset;
}

interface NormalizedDimensions {
  lengthM: number;
  widthM: number;
  heightM: number;
  baySizeM: number;
}

type PlanCell = "ondol" | "daecheong" | "kitchen" | "storage";
type HanokWingRole = "main" | "auxiliary";

interface HanokLinearOptions {
  wingRole?: HanokWingRole;
  includeKitchen?: boolean;
  includeChimney?: boolean;
  includeFrontMaru?: boolean;
  includeRearWindows?: boolean;
}

const COLORS = {
  foundation: new THREE.Color(0.40, 0.37, 0.33),
  wall: new THREE.Color(0.84, 0.80, 0.71),
  wallMud: new THREE.Color(0.71, 0.63, 0.52),
  woodDark: new THREE.Color(0.36, 0.25, 0.16),
  woodMid: new THREE.Color(0.46, 0.33, 0.22),
  paper: new THREE.Color(0.95, 0.92, 0.85),
  giwaRoof: new THREE.Color(0.22, 0.24, 0.27),
  giwaTile: new THREE.Color(0.30, 0.32, 0.36),
  chogaRoof: new THREE.Color(0.69, 0.58, 0.39),
  chogaBundle: new THREE.Color(0.76, 0.66, 0.45),
  firebox: new THREE.Color(0.12, 0.10, 0.08),
  chimney: new THREE.Color(0.52, 0.47, 0.40),
  jarBrown: new THREE.Color(0.22, 0.15, 0.11),
  jarLid: new THREE.Color(0.17, 0.12, 0.09),
  fenceWall: new THREE.Color(0.70, 0.62, 0.52),
  fenceCap: new THREE.Color(0.39, 0.30, 0.22),
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function seeded01(seed: number): number {
  const s = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function ensureGeometryForMerge(geometry: THREE.BufferGeometry): void {
  const keep = new Set(["position", "normal", "uv", "color"]);
  for (const name of Object.keys(geometry.attributes)) {
    if (!keep.has(name)) {
      geometry.deleteAttribute(name);
    }
  }

  const position = geometry.getAttribute("position");
  if (!position || position.count === 0) return;

  if (!geometry.getAttribute("normal")) {
    geometry.computeVertexNormals();
  }

  const uv = geometry.getAttribute("uv");
  if (!uv || uv.itemSize !== 2) {
    geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(position.count * 2), 2));
  }

  const color = geometry.getAttribute("color");
  if (!color || color.itemSize !== 4) {
    const colors = new Float32Array(position.count * 4);
    if (color && color.itemSize >= 3) {
      const source = color.array as ArrayLike<number>;
      for (let i = 0; i < position.count; i++) {
        colors[i * 4] = source[i * color.itemSize] ?? 1;
        colors[i * 4 + 1] = source[i * color.itemSize + 1] ?? 1;
        colors[i * 4 + 2] = source[i * color.itemSize + 2] ?? 1;
        colors[i * 4 + 3] = color.itemSize > 3 ? (source[i * color.itemSize + 3] ?? 1) : 1;
      }
    } else {
      for (let i = 0; i < position.count; i++) {
        colors[i * 4] = 1;
        colors[i * 4 + 1] = 1;
        colors[i * 4 + 2] = 1;
        colors[i * 4 + 3] = 1;
      }
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 4));
  }
}

function tintGeometry(
  geometry: THREE.BufferGeometry,
  color: THREE.Color,
  alpha: number = 1
): THREE.BufferGeometry {
  ensureGeometryForMerge(geometry);
  const position = geometry.getAttribute("position");
  if (!position) return geometry;

  const colors = new Float32Array(position.count * 4);
  for (let i = 0; i < position.count; i++) {
    colors[i * 4] = color.r;
    colors[i * 4 + 1] = color.g;
    colors[i * 4 + 2] = color.b;
    colors[i * 4 + 3] = alpha;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 4));
  return geometry;
}

function createBox(
  width: number,
  height: number,
  depth: number,
  position: THREE.Vector3,
  color: THREE.Color,
  rotation: THREE.Euler = new THREE.Euler()
): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  if (rotation.x !== 0) geometry.rotateX(rotation.x);
  if (rotation.y !== 0) geometry.rotateY(rotation.y);
  if (rotation.z !== 0) geometry.rotateZ(rotation.z);
  geometry.translate(position.x, position.y, position.z);
  return tintGeometry(geometry, color);
}

function createCylinder(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  radialSegments: number,
  position: THREE.Vector3,
  color: THREE.Color,
  rotation: THREE.Euler = new THREE.Euler(),
  openEnded: boolean = false
): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(
    radiusTop,
    radiusBottom,
    height,
    radialSegments,
    1,
    openEnded
  );
  if (rotation.x !== 0) geometry.rotateX(rotation.x);
  if (rotation.y !== 0) geometry.rotateY(rotation.y);
  if (rotation.z !== 0) geometry.rotateZ(rotation.z);
  geometry.translate(position.x, position.y, position.z);
  return tintGeometry(geometry, color);
}

function createSphere(
  radius: number,
  widthSegments: number,
  heightSegments: number,
  position: THREE.Vector3,
  color: THREE.Color
): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(radius, widthSegments, heightSegments);
  geometry.translate(position.x, position.y, position.z);
  return tintGeometry(geometry, color);
}

function createQuad(
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  d: THREE.Vector3,
  color: THREE.Color
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array([
    a.x, a.y, a.z,
    b.x, b.y, b.z,
    c.x, c.y, c.z,
    a.x, a.y, a.z,
    c.x, c.y, c.z,
    d.x, d.y, d.z,
  ]);
  const uvs = new Float32Array([
    0, 1,
    1, 1,
    1, 0,
    0, 1,
    1, 0,
    0, 0,
  ]);
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  return tintGeometry(geometry, color);
}

function createTriangle(
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  color: THREE.Color
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array([
    a.x, a.y, a.z,
    b.x, b.y, b.z,
    c.x, c.y, c.z,
  ]);
  const uvs = new Float32Array([
    0, 0,
    1, 0,
    0.5, 1,
  ]);
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  return tintGeometry(geometry, color);
}

function mergeGeometries(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (geometries.length === 0) {
    return new THREE.BoxGeometry(0.01, 0.01, 0.01);
  }

  const prepared = geometries
    .map((geometry) => (geometry.index ? geometry.toNonIndexed() : geometry))
    .filter((geometry) => {
      ensureGeometryForMerge(geometry);
      const position = geometry.getAttribute("position");
      return Boolean(position && position.count > 0);
    });

  if (prepared.length === 0) {
    return new THREE.BoxGeometry(0.01, 0.01, 0.01);
  }

  const merged = BufferGeometryUtils.mergeGeometries(prepared, false);
  if (!merged) {
    return new THREE.BoxGeometry(0.01, 0.01, 0.01);
  }

  merged.computeVertexNormals();
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

function normalizeHouseDimensions(input: StructureDimensions): NormalizedDimensions {
  const baySizeM = clamp(input.baySizeM ?? 2.4, 1.8, 3.2);
  const xBays = Math.max(3, Math.round(clamp(input.lengthM, baySizeM * 2, 40) / baySizeM));
  const zBays = Math.max(2, Math.round(clamp(input.widthM, baySizeM * 1.5, 30) / baySizeM));
  return {
    lengthM: xBays * baySizeM,
    widthM: zBays * baySizeM,
    heightM: clamp(input.heightM, 2.0, 4.5),
    baySizeM,
  };
}

function buildPlanGrid(
  xBays: number,
  zBays: number,
  seed: number,
  wingRole: HanokWingRole
): PlanCell[][] {
  const grid: PlanCell[][] = Array.from({ length: xBays }, () =>
    Array<PlanCell>(zBays).fill("ondol")
  );

  if (wingRole === "main") {
    grid[0][0] = "kitchen";
  } else {
    grid[0][0] = "storage";
  }

  const daeSpan = wingRole === "main" && xBays >= 6 ? 2 : 1;
  const daeStart = clamp(Math.floor((xBays - daeSpan) / 2), 1, xBays - daeSpan - 1);
  const daeDepth = wingRole === "main" && zBays >= 3 ? 2 : 1;
  for (let x = daeStart; x < daeStart + daeSpan; x++) {
    for (let z = 0; z < daeDepth; z++) {
      grid[x][z] = "daecheong";
    }
  }

  if (wingRole === "main" && xBays >= 4) {
    grid[xBays - 1][0] = "storage";
  }

  if (xBays >= 5 && zBays >= 3) {
    const extraX = 1 + Math.floor(seeded01(seed + 19.7) * Math.max(1, xBays - 3));
    grid[extraX][zBays - 1] = "storage";
  }

  if (wingRole === "auxiliary" && xBays >= 3) {
    grid[xBays - 1][zBays - 1] = "storage";
  }

  return grid;
}

function isStructureType(cell: PlanCell): boolean {
  return cell === "ondol" || cell === "storage" || cell === "kitchen";
}

function pushGiwaRoof(
  geometries: THREE.BufferGeometry[],
  length: number,
  width: number,
  foundationHeight: number,
  wallHeight: number,
  baySize: number,
  seed: number,
  wingRole: HanokWingRole
): void {
  const isMainWing = wingRole === "main";
  const eave = isMainWing
    ? clamp(0.78 + baySize * 0.08, 0.75, 1.28)
    : clamp(0.62 + baySize * 0.06, 0.55, 1.02);
  const roofLength = length + eave * 2;
  const roofSpan = width + eave * 2;
  const roofBaseY = foundationHeight + wallHeight + 0.02;
  const roofRise = wallHeight * (isMainWing ? 0.72 : 0.60) + seeded01(seed + 4.4) * 0.18;
  const slopeAngle = Math.atan2(roofRise, roofSpan * 0.5);

  const ridgeLeft = new THREE.Vector3(-roofLength * 0.5, roofBaseY + roofRise, 0);
  const ridgeRight = new THREE.Vector3(roofLength * 0.5, roofBaseY + roofRise, 0);
  const frontLeft = new THREE.Vector3(-roofLength * 0.5, roofBaseY, -roofSpan * 0.5);
  const frontRight = new THREE.Vector3(roofLength * 0.5, roofBaseY, -roofSpan * 0.5);
  const backLeft = new THREE.Vector3(-roofLength * 0.5, roofBaseY, roofSpan * 0.5);
  const backRight = new THREE.Vector3(roofLength * 0.5, roofBaseY, roofSpan * 0.5);

  geometries.push(createQuad(ridgeLeft, ridgeRight, frontRight, frontLeft, COLORS.giwaRoof));
  geometries.push(createQuad(ridgeLeft, ridgeRight, backRight, backLeft, COLORS.giwaRoof));
  geometries.push(createTriangle(frontLeft, ridgeLeft, backLeft, COLORS.giwaRoof));
  geometries.push(createTriangle(frontRight, ridgeRight, backRight, COLORS.giwaRoof));

  const tileRows = Math.max(8, Math.round((roofSpan * 0.5) / (isMainWing ? 0.16 : 0.20)));
  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < tileRows; i++) {
      const t = (i + 0.45) / tileRows;
      const eaveLift = Math.pow(1 - t, 1.45);
      const y = roofBaseY + roofRise * (1 - t) + eaveLift * 0.12;
      const z = side * (roofSpan * 0.5 * t);
      const pitch = (side < 0 ? -1 : 1) * slopeAngle * (0.76 + t * 0.3);
      const tileThickness = 0.042 + eaveLift * 0.016;
      geometries.push(
        createBox(
          roofLength * 0.987,
          tileThickness,
          0.115,
          new THREE.Vector3(0, y, z),
          COLORS.giwaTile,
          new THREE.Euler(pitch, 0, 0)
        )
      );
    }
  }

  geometries.push(
    createCylinder(
      isMainWing ? 0.11 : 0.09,
      isMainWing ? 0.11 : 0.09,
      roofLength * 1.01,
      12,
      new THREE.Vector3(0, roofBaseY + roofRise + 0.05, 0),
      COLORS.giwaTile,
      new THREE.Euler(0, 0, Math.PI * 0.5)
    )
  );

  const eaveRodRadius = isMainWing ? 0.045 : 0.036;
  geometries.push(
    createCylinder(
      eaveRodRadius,
      eaveRodRadius,
      roofLength * 0.985,
      10,
      new THREE.Vector3(0, roofBaseY + 0.02, -roofSpan * 0.5),
      COLORS.giwaTile,
      new THREE.Euler(0, 0, Math.PI * 0.5)
    )
  );
  geometries.push(
    createCylinder(
      eaveRodRadius,
      eaveRodRadius,
      roofLength * 0.985,
      10,
      new THREE.Vector3(0, roofBaseY + 0.02, roofSpan * 0.5),
      COLORS.giwaTile,
      new THREE.Euler(0, 0, Math.PI * 0.5)
    )
  );
}

function pushChogaRoof(
  geometries: THREE.BufferGeometry[],
  length: number,
  width: number,
  foundationHeight: number,
  wallHeight: number,
  baySize: number,
  seed: number,
  wingRole: HanokWingRole
): void {
  const isMainWing = wingRole === "main";
  const eave = isMainWing
    ? clamp(0.66 + baySize * 0.07, 0.60, 1.04)
    : clamp(0.56 + baySize * 0.06, 0.50, 0.90);
  const roofLength = length + eave * 2;
  const roofSpan = width + eave * 2;
  const roofBaseY = foundationHeight + wallHeight + 0.02;
  const roofRise = wallHeight * (isMainWing ? 0.94 : 0.82) + seeded01(seed + 5.1) * 0.20;
  const slopeAngle = Math.atan2(roofRise, roofSpan * 0.5);

  const ridgeLeft = new THREE.Vector3(-roofLength * 0.5, roofBaseY + roofRise, 0);
  const ridgeRight = new THREE.Vector3(roofLength * 0.5, roofBaseY + roofRise, 0);
  const frontLeft = new THREE.Vector3(-roofLength * 0.5, roofBaseY, -roofSpan * 0.5);
  const frontRight = new THREE.Vector3(roofLength * 0.5, roofBaseY, -roofSpan * 0.5);
  const backLeft = new THREE.Vector3(-roofLength * 0.5, roofBaseY, roofSpan * 0.5);
  const backRight = new THREE.Vector3(roofLength * 0.5, roofBaseY, roofSpan * 0.5);

  geometries.push(createQuad(ridgeLeft, ridgeRight, frontRight, frontLeft, COLORS.chogaRoof));
  geometries.push(createQuad(ridgeLeft, ridgeRight, backRight, backLeft, COLORS.chogaRoof));
  geometries.push(createTriangle(frontLeft, ridgeLeft, backLeft, COLORS.chogaRoof));
  geometries.push(createTriangle(frontRight, ridgeRight, backRight, COLORS.chogaRoof));

  const bundleRows = Math.max(10, Math.round((roofSpan * 0.5) / 0.15));
  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < bundleRows; i++) {
      const t = (i + 0.5) / bundleRows;
      const profile = 1 - Math.pow(t, 0.82);
      const sag = Math.sin(t * Math.PI) * 0.06;
      const y = roofBaseY + roofRise * profile - sag * 0.38;
      const z = side * (roofSpan * 0.5 * t);
      const tint = 0.83 + seeded01(seed + i * 7.1 + side * 3.7) * 0.22;
      const straw = new THREE.Color(
        COLORS.chogaRoof.r * tint,
        COLORS.chogaRoof.g * tint,
        COLORS.chogaRoof.b * tint
      );
      const depth = 0.14 + (1 - t) * 0.05;
      geometries.push(
        createBox(
          roofLength * 0.984,
          0.068,
          depth,
          new THREE.Vector3(0, y, z),
          straw,
          new THREE.Euler((side < 0 ? -1 : 1) * slopeAngle * (0.78 + t * 0.28), 0, 0)
        )
      );
    }
  }

  geometries.push(
    createCylinder(
      isMainWing ? 0.12 : 0.10,
      isMainWing ? 0.12 : 0.10,
      roofLength * 0.99,
      14,
      new THREE.Vector3(0, roofBaseY + roofRise + 0.05, 0),
      COLORS.chogaBundle,
      new THREE.Euler(0, 0, Math.PI * 0.5)
    )
  );

  geometries.push(
    createCylinder(
      0.08,
      0.08,
      roofLength * 0.96,
      10,
      new THREE.Vector3(0, roofBaseY + 0.03, -roofSpan * 0.5),
      COLORS.chogaBundle,
      new THREE.Euler(0, 0, Math.PI * 0.5)
    )
  );
  geometries.push(
    createCylinder(
      0.08,
      0.08,
      roofLength * 0.96,
      10,
      new THREE.Vector3(0, roofBaseY + 0.03, roofSpan * 0.5),
      COLORS.chogaBundle,
      new THREE.Euler(0, 0, Math.PI * 0.5)
    )
  );

  const ropeCount = Math.max(2, Math.floor(length / (baySize * 1.45)) + 1);
  const ropeSpacing = roofLength / ropeCount;
  for (let i = 0; i < ropeCount; i++) {
    const x = -roofLength * 0.5 + (i + 0.5) * ropeSpacing;
    for (let side = -1; side <= 1; side += 2) {
      const ropeDepth = 0.09;
      const t = 0.60;
      const profile = 1 - Math.pow(t, 0.82);
      const sag = Math.sin(t * Math.PI) * 0.06;
      const z = side * (roofSpan * 0.5 * t);
      const y = roofBaseY + roofRise * profile - sag * 0.38;
      const pitch = (side < 0 ? -1 : 1) * slopeAngle * (0.78 + t * 0.28);
      geometries.push(
        createBox(
          ropeSpacing * 0.62,
          0.024,
          ropeDepth,
          new THREE.Vector3(x, y + 0.016, z),
          COLORS.woodMid,
          new THREE.Euler(pitch, 0, 0)
        )
      );
    }
  }
}

function generateHanokLinearHouseGeometry(
  style: "giwa" | "choga",
  dimensions: StructureDimensions,
  seed: number,
  options: HanokLinearOptions = {}
): THREE.BufferGeometry {
  const normalized = normalizeHouseDimensions(dimensions);
  const baySize = normalized.baySizeM;
  const xBays = Math.max(3, Math.round(normalized.lengthM / baySize));
  const zBays = Math.max(2, Math.round(normalized.widthM / baySize));
  const length = normalized.lengthM;
  const width = normalized.widthM;
  const wallHeight = normalized.heightM;

  const wingRole = options.wingRole ?? "main";
  const includeKitchen = options.includeKitchen ?? wingRole === "main";
  const includeChimney = options.includeChimney ?? includeKitchen;
  const includeFrontMaru = options.includeFrontMaru ?? wingRole === "main";
  const includeRearWindows = options.includeRearWindows ?? true;

  const plan = buildPlanGrid(xBays, zBays, seed, includeKitchen ? "main" : "auxiliary");
  const geometries: THREE.BufferGeometry[] = [];

  const foundationHeight = style === "giwa" ? 0.5 : 0.34;
  const wallThickness = style === "giwa" ? 0.17 : 0.15;
  const floorHeight = 0.11;
  const wallBaseY = foundationHeight + wallHeight * 0.5;
  const floorY = foundationHeight + floorHeight * 0.5;

  // Foundation + floor base
  geometries.push(
    createBox(
      length + 0.6,
      foundationHeight,
      width + 0.6,
      new THREE.Vector3(0, foundationHeight * 0.5, 0),
      COLORS.foundation
    )
  );

  geometries.push(
    createBox(
      length,
      floorHeight,
      width,
      new THREE.Vector3(0, floorY, 0),
      COLORS.woodMid
    )
  );

  // Daecheong floor areas
  for (let x = 0; x < xBays; x++) {
    for (let z = 0; z < zBays; z++) {
      if (plan[x][z] !== "daecheong") continue;
      const centerX = -length * 0.5 + (x + 0.5) * baySize;
      const centerZ = -width * 0.5 + (z + 0.5) * baySize;
      geometries.push(
        createBox(
          baySize * 0.92,
          0.09,
          baySize * 0.92,
          new THREE.Vector3(centerX, foundationHeight + 0.12, centerZ),
          COLORS.woodDark
        )
      );
    }
  }

  // Front toe maru strip (exclude kitchen side)
  const maruDepth = clamp(baySize * 0.46, 0.9, 1.4);
  const maruStartX = -length * 0.5 + baySize * 0.72;
  const maruEndX = length * 0.5 - baySize * 0.18;
  const maruLength = Math.max(0, maruEndX - maruStartX);

  if (includeFrontMaru && maruLength > baySize * 0.75) {
    const maruCenterX = (maruStartX + maruEndX) * 0.5;
    const maruCenterZ = -width * 0.5 - maruDepth * 0.5 - wallThickness * 0.15;

    geometries.push(
      createBox(
        maruLength,
        0.12,
        maruDepth,
        new THREE.Vector3(maruCenterX, foundationHeight + 0.12, maruCenterZ),
        COLORS.woodDark
      )
    );

    const supportCount = Math.max(2, Math.floor(maruLength / baySize) + 1);
    for (let i = 0; i < supportCount; i++) {
      const t = supportCount === 1 ? 0.5 : i / (supportCount - 1);
      const x = maruStartX + maruLength * t;
      geometries.push(
        createBox(
          0.10,
          foundationHeight,
          0.10,
          new THREE.Vector3(x, foundationHeight * 0.5, maruCenterZ),
          COLORS.woodMid
        )
      );
    }
  }

  // Outer walls and paper doors/windows
  const frontZ = -width * 0.5 + wallThickness * 0.5;
  const backZ = width * 0.5 - wallThickness * 0.5;
  const leftX = -length * 0.5 + wallThickness * 0.5;
  const rightX = length * 0.5 - wallThickness * 0.5;

  for (let x = 0; x < xBays; x++) {
    const cx = -length * 0.5 + (x + 0.5) * baySize;
    const frontCell = plan[x][0];

    if (frontCell === "kitchen") {
      geometries.push(
        createBox(
          baySize * 0.94,
          wallHeight,
          wallThickness,
          new THREE.Vector3(cx, wallBaseY, frontZ),
          style === "giwa" ? COLORS.wall : COLORS.wallMud
        )
      );
    } else {
      const openingWidth = baySize * 0.62;
      const sideWidth = Math.max(0.08, (baySize * 0.94 - openingWidth) * 0.5);
      const sillHeight = 0.46;
      const transomHeight = 0.34;
      const openingHeight = Math.max(0.8, wallHeight - sillHeight - transomHeight);

      geometries.push(
        createBox(
          sideWidth,
          wallHeight,
          wallThickness,
          new THREE.Vector3(cx - openingWidth * 0.5 - sideWidth * 0.5, wallBaseY, frontZ),
          style === "giwa" ? COLORS.wall : COLORS.wallMud
        )
      );
      geometries.push(
        createBox(
          sideWidth,
          wallHeight,
          wallThickness,
          new THREE.Vector3(cx + openingWidth * 0.5 + sideWidth * 0.5, wallBaseY, frontZ),
          style === "giwa" ? COLORS.wall : COLORS.wallMud
        )
      );
      geometries.push(
        createBox(
          openingWidth,
          sillHeight,
          wallThickness,
          new THREE.Vector3(cx, foundationHeight + sillHeight * 0.5, frontZ),
          style === "giwa" ? COLORS.wall : COLORS.wallMud
        )
      );
      geometries.push(
        createBox(
          openingWidth,
          transomHeight,
          wallThickness,
          new THREE.Vector3(cx, foundationHeight + wallHeight - transomHeight * 0.5, frontZ),
          style === "giwa" ? COLORS.wall : COLORS.wallMud
        )
      );

      // Wooden frame + paper panel
      const frameThickness = 0.05;
      const panelY = foundationHeight + sillHeight + openingHeight * 0.5;
      geometries.push(
        createBox(
          openingWidth + frameThickness * 2,
          frameThickness,
          wallThickness * 0.75,
          new THREE.Vector3(cx, panelY + openingHeight * 0.5, frontZ),
          COLORS.woodDark
        )
      );
      geometries.push(
        createBox(
          openingWidth + frameThickness * 2,
          frameThickness,
          wallThickness * 0.75,
          new THREE.Vector3(cx, panelY - openingHeight * 0.5, frontZ),
          COLORS.woodDark
        )
      );
      geometries.push(
        createBox(
          frameThickness,
          openingHeight,
          wallThickness * 0.75,
          new THREE.Vector3(cx - openingWidth * 0.5, panelY, frontZ),
          COLORS.woodDark
        )
      );
      geometries.push(
        createBox(
          frameThickness,
          openingHeight,
          wallThickness * 0.75,
          new THREE.Vector3(cx + openingWidth * 0.5, panelY, frontZ),
          COLORS.woodDark
        )
      );
      geometries.push(
        createBox(
          openingWidth * 0.88,
          openingHeight * 0.88,
          wallThickness * 0.24,
          new THREE.Vector3(cx, panelY, frontZ),
          COLORS.paper
        )
      );
    }

    geometries.push(
      createBox(
        baySize * 0.94,
        wallHeight,
        wallThickness,
        new THREE.Vector3(cx, wallBaseY, backZ),
        style === "giwa" ? COLORS.wall : COLORS.wallMud
      )
    );

    const addRearWindow = includeRearWindows && seeded01(seed + x * 1.73 + 19.0) > 0.56;
    if (addRearWindow) {
      const rearWindowWidth = baySize * 0.42;
      const rearWindowHeight = wallHeight * 0.34;
      const rearWindowY = foundationHeight + wallHeight * 0.62;
      geometries.push(
        createBox(
          rearWindowWidth,
          rearWindowHeight,
          wallThickness * 0.24,
          new THREE.Vector3(cx, rearWindowY, backZ),
          COLORS.paper
        )
      );
      geometries.push(
        createBox(
          rearWindowWidth + 0.05,
          0.04,
          wallThickness * 0.75,
          new THREE.Vector3(cx, rearWindowY + rearWindowHeight * 0.5, backZ),
          COLORS.woodDark
        )
      );
      geometries.push(
        createBox(
          rearWindowWidth + 0.05,
          0.04,
          wallThickness * 0.75,
          new THREE.Vector3(cx, rearWindowY - rearWindowHeight * 0.5, backZ),
          COLORS.woodDark
        )
      );
    }
  }

  for (let z = 0; z < zBays; z++) {
    const cz = -width * 0.5 + (z + 0.5) * baySize;
    const leftCell = plan[0][z];

    if (z === 0 && leftCell === "kitchen" && includeKitchen) {
      const openingWidth = baySize * 0.52;
      const sideWidth = Math.max(0.08, (baySize * 0.94 - openingWidth) * 0.5);
      const sillHeight = 0.38;
      const openingHeight = wallHeight - sillHeight - 0.22;

      geometries.push(
        createBox(
          wallThickness,
          wallHeight,
          sideWidth,
          new THREE.Vector3(leftX, wallBaseY, cz - openingWidth * 0.5 - sideWidth * 0.5),
          style === "giwa" ? COLORS.wall : COLORS.wallMud
        )
      );
      geometries.push(
        createBox(
          wallThickness,
          wallHeight,
          sideWidth,
          new THREE.Vector3(leftX, wallBaseY, cz + openingWidth * 0.5 + sideWidth * 0.5),
          style === "giwa" ? COLORS.wall : COLORS.wallMud
        )
      );
      geometries.push(
        createBox(
          wallThickness,
          sillHeight,
          openingWidth,
          new THREE.Vector3(leftX, foundationHeight + sillHeight * 0.5, cz),
          style === "giwa" ? COLORS.wall : COLORS.wallMud
        )
      );
      geometries.push(
        createBox(
          wallThickness * 0.24,
          openingHeight * 0.86,
          openingWidth * 0.86,
          new THREE.Vector3(leftX, foundationHeight + sillHeight + openingHeight * 0.5, cz),
          COLORS.paper
        )
      );
    } else {
      geometries.push(
        createBox(
          wallThickness,
          wallHeight,
          baySize * 0.94,
          new THREE.Vector3(leftX, wallBaseY, cz),
          style === "giwa" ? COLORS.wall : COLORS.wallMud
        )
      );
    }

    geometries.push(
      createBox(
        wallThickness,
        wallHeight,
        baySize * 0.94,
        new THREE.Vector3(rightX, wallBaseY, cz),
        style === "giwa" ? COLORS.wall : COLORS.wallMud
      )
    );
  }

  // Perimeter posts
  const postSize = wallThickness * 1.32;
  for (let x = 0; x <= xBays; x++) {
    const px = -length * 0.5 + x * baySize;
    geometries.push(
      createBox(
        postSize,
        wallHeight,
        postSize,
        new THREE.Vector3(px, wallBaseY, frontZ),
        COLORS.woodDark
      )
    );
    geometries.push(
      createBox(
        postSize,
        wallHeight,
        postSize,
        new THREE.Vector3(px, wallBaseY, backZ),
        COLORS.woodDark
      )
    );
  }

  for (let z = 1; z < zBays; z++) {
    const pz = -width * 0.5 + z * baySize;
    geometries.push(
      createBox(
        postSize,
        wallHeight,
        postSize,
        new THREE.Vector3(leftX, wallBaseY, pz),
        COLORS.woodDark
      )
    );
    geometries.push(
      createBox(
        postSize,
        wallHeight,
        postSize,
        new THREE.Vector3(rightX, wallBaseY, pz),
        COLORS.woodDark
      )
    );
  }

  // Interior partitions based on module transitions
  for (let x = 1; x < xBays; x++) {
    const px = -length * 0.5 + x * baySize;
    for (let z = 0; z < zBays; z++) {
      const leftCell = plan[x - 1][z];
      const rightCell = plan[x][z];
      if (leftCell === rightCell) continue;

      const cz = -width * 0.5 + (z + 0.5) * baySize;
      const isOpenBoundary = leftCell === "daecheong" || rightCell === "daecheong";
      const partitionHeight = isOpenBoundary ? wallHeight * 0.58 : wallHeight * 0.88;
      const color = (isStructureType(leftCell) && isStructureType(rightCell)) ? COLORS.wallMud : COLORS.woodDark;

      geometries.push(
        createBox(
          wallThickness,
          partitionHeight,
          baySize * 0.92,
          new THREE.Vector3(px, foundationHeight + partitionHeight * 0.5, cz),
          color
        )
      );
    }
  }

  for (let z = 1; z < zBays; z++) {
    const pz = -width * 0.5 + z * baySize;
    for (let x = 0; x < xBays; x++) {
      const frontCell = plan[x][z - 1];
      const backCell = plan[x][z];
      if (frontCell === backCell) continue;

      const cx = -length * 0.5 + (x + 0.5) * baySize;
      const isOpenBoundary = frontCell === "daecheong" || backCell === "daecheong";
      const partitionHeight = isOpenBoundary ? wallHeight * 0.56 : wallHeight * 0.86;
      const color = (isStructureType(frontCell) && isStructureType(backCell)) ? COLORS.wallMud : COLORS.woodDark;

      geometries.push(
        createBox(
          baySize * 0.92,
          partitionHeight,
          wallThickness,
          new THREE.Vector3(cx, foundationHeight + partitionHeight * 0.5, pz),
          color
        )
      );
    }
  }

  if (includeKitchen) {
    // Kitchen hearth + stove body
    const kitchenX = -length * 0.5 + baySize * 0.5;
    const kitchenZ = -width * 0.5 + baySize * 0.5;
    geometries.push(
      createBox(
        baySize * 0.44,
        0.58,
        baySize * 0.34,
        new THREE.Vector3(kitchenX - baySize * 0.18, foundationHeight + 0.29, kitchenZ + baySize * 0.03),
        COLORS.foundation
      )
    );
    geometries.push(
      createBox(
        baySize * 0.18,
        0.23,
        baySize * 0.16,
        new THREE.Vector3(kitchenX - baySize * 0.36, foundationHeight + 0.11, kitchenZ + baySize * 0.10),
        COLORS.firebox
      )
    );

    if (includeChimney) {
      const chimneyHeight = style === "giwa" ? wallHeight * 0.95 : wallHeight * 0.82;
      geometries.push(
        createBox(
          0.36,
          chimneyHeight,
          0.36,
          new THREE.Vector3(-length * 0.5 - 0.32, foundationHeight + chimneyHeight * 0.5, kitchenZ + baySize * 0.18),
          COLORS.chimney
        )
      );
    }
  }

  if (style === "giwa") {
    pushGiwaRoof(geometries, length, width, foundationHeight, wallHeight, baySize, seed, wingRole);
  } else {
    pushChogaRoof(geometries, length, width, foundationHeight, wallHeight, baySize, seed, wingRole);
  }

  return mergeGeometries(geometries);
}

function resolvePlanPreset(
  requested: HanokPlanPreset,
  xBays: number,
  zBays: number,
  seed: number
): Exclude<HanokPlanPreset, "auto"> {
  const canUseL = xBays >= 4 && zBays >= 3;
  const canUseU = xBays >= 5 && zBays >= 4;
  const canUseCourtyard = xBays >= 7 && zBays >= 7;

  if (requested !== "auto") {
    if (requested === "courtyard" && !canUseCourtyard) {
      return canUseU ? "u_shape" : canUseL ? "l_shape" : "linear";
    }
    if (requested === "u_shape" && !canUseU) {
      return canUseL ? "l_shape" : "linear";
    }
    if (requested === "l_shape" && !canUseL) {
      return "linear";
    }
    return requested;
  }

  const area = xBays * zBays;
  const roll = seeded01(seed + area * 0.73);
  if (canUseCourtyard && area >= 64 && roll > 0.7) return "courtyard";
  if (canUseU && area >= 36 && roll > 0.45) return "u_shape";
  if (canUseL && area >= 20 && roll > 0.2) return "l_shape";
  return "linear";
}

function generateCompoundHanokHouseGeometry(
  style: "giwa" | "choga",
  dimensions: StructureDimensions,
  seed: number,
  preset: Exclude<HanokPlanPreset, "auto" | "linear">
): THREE.BufferGeometry {
  const normalized = normalizeHouseDimensions(dimensions);
  const baySize = normalized.baySizeM;
  const xBays = Math.max(3, Math.round(normalized.lengthM / baySize));
  const zBays = Math.max(2, Math.round(normalized.widthM / baySize));
  const wallHeight = normalized.heightM;

  const wings: THREE.BufferGeometry[] = [];
  const pushWing = (
    lengthBays: number,
    widthBays: number,
    centerX: number,
    centerZ: number,
    rotationY: number,
    wingSeed: number,
    wingRole: HanokWingRole
  ): void => {
    const wingGeometry = generateHanokLinearHouseGeometry(
      style,
      {
        lengthM: Math.max(3, lengthBays) * baySize,
        widthM: Math.max(2, widthBays) * baySize,
        heightM: wallHeight,
        baySizeM: baySize,
        planPreset: "linear",
      },
      wingSeed,
      {
        wingRole,
        includeKitchen: wingRole === "main",
        includeChimney: wingRole === "main",
        includeFrontMaru: wingRole === "main",
        includeRearWindows: true,
      }
    );
    wingGeometry.rotateY(rotationY);
    wingGeometry.translate(centerX, 0, centerZ);
    wings.push(wingGeometry);
  };

  if (preset === "l_shape") {
    const frontDepthBays = Math.max(2, Math.round(zBays * 0.56));
    const sideLengthBays = Math.max(3, Math.round(xBays * 0.58));

    const frontCenterZ = -((zBays - frontDepthBays) * baySize * 0.5);
    const sideCenterX = -((xBays - sideLengthBays) * baySize * 0.5);

    pushWing(xBays, frontDepthBays, 0, frontCenterZ, 0, seed + 11.3, "main");
    pushWing(sideLengthBays, zBays, sideCenterX, 0, 0, seed + 23.9, "auxiliary");
  } else if (preset === "u_shape") {
    const sideWidthBays = Math.max(2, Math.round(xBays * 0.30));
    const sideLengthBays = Math.max(3, Math.round(zBays * 0.78));
    const rearDepthBays = Math.max(2, Math.round(zBays * 0.34));

    const rearCenterZ = (zBays - rearDepthBays) * baySize * 0.5;
    pushWing(xBays, rearDepthBays, 0, rearCenterZ, 0, seed + 13.2, "main");

    const sideCenterZ = -((zBays - sideLengthBays) * baySize * 0.5);
    const sideOffsetX = (xBays - sideWidthBays) * baySize * 0.5;
    pushWing(
      sideLengthBays,
      sideWidthBays,
      -sideOffsetX,
      sideCenterZ,
      Math.PI * 0.5,
      seed + 31.8,
      "auxiliary"
    );
    pushWing(
      sideLengthBays,
      sideWidthBays,
      sideOffsetX,
      sideCenterZ,
      Math.PI * 0.5,
      seed + 47.1,
      "auxiliary"
    );
  } else {
    const ringBays = Math.max(2, Math.round(Math.min(xBays, zBays) * 0.28));
    const innerXBays = xBays - ringBays * 2;
    const innerZBays = zBays - ringBays * 2;

    if (innerXBays < 2 || innerZBays < 2) {
      return generateCompoundHanokHouseGeometry(style, dimensions, seed, "u_shape");
    }

    const frontCenterZ = -((zBays - ringBays) * baySize * 0.5);
    const backCenterZ = (zBays - ringBays) * baySize * 0.5;
    const sideOffsetX = (xBays - ringBays) * baySize * 0.5;

    pushWing(xBays, ringBays, 0, frontCenterZ, 0, seed + 17.9, "auxiliary");
    pushWing(xBays, ringBays, 0, backCenterZ, 0, seed + 29.4, "main");
    pushWing(innerZBays, ringBays, -sideOffsetX, 0, Math.PI * 0.5, seed + 41.7, "auxiliary");
    pushWing(innerZBays, ringBays, sideOffsetX, 0, Math.PI * 0.5, seed + 53.8, "auxiliary");
  }

  const merged = mergeGeometries(wings);
  const orientation = Math.floor(seeded01(seed + 61.3) * 4);
  if (orientation > 0) {
    merged.rotateY((Math.PI * 0.5) * orientation);
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
  }
  return merged;
}

export function generateHanokHouseGeometry(
  style: "giwa" | "choga",
  dimensions: StructureDimensions,
  seed: number
): THREE.BufferGeometry {
  const normalized = normalizeHouseDimensions(dimensions);
  const baySize = normalized.baySizeM;
  const xBays = Math.max(3, Math.round(normalized.lengthM / baySize));
  const zBays = Math.max(2, Math.round(normalized.widthM / baySize));

  const requestedPreset = dimensions.planPreset ?? "auto";
  const resolvedPreset = resolvePlanPreset(requestedPreset, xBays, zBays, seed);

  if (resolvedPreset === "linear") {
    return generateHanokLinearHouseGeometry(style, dimensions, seed);
  }

  return generateCompoundHanokHouseGeometry(style, dimensions, seed, resolvedPreset);
}

export function generateFenceSegmentGeometry(
  dimensions: StructureDimensions,
  seed: number
): THREE.BufferGeometry {
  const lengthM = clamp(dimensions.lengthM, 2.0, 30.0);
  const widthM = clamp(dimensions.widthM, 0.25, 1.5);
  const heightM = clamp(dimensions.heightM, 0.9, 3.2);
  const segmentLength = 1.2;
  const segments = Math.max(2, Math.round(lengthM / segmentLength));
  const actualLength = segments * segmentLength;

  const geometries: THREE.BufferGeometry[] = [];

  const postWidth = Math.max(0.12, widthM * 0.45);
  const panelHeight = heightM * 0.72;

  for (let i = 0; i <= segments; i++) {
    const x = -actualLength * 0.5 + i * segmentLength;
    geometries.push(
      createBox(
        postWidth,
        heightM,
        widthM,
        new THREE.Vector3(x, heightM * 0.5, 0),
        COLORS.fenceCap
      )
    );
  }

  for (let i = 0; i < segments; i++) {
    const x = -actualLength * 0.5 + (i + 0.5) * segmentLength;
    const jitter = (seeded01(seed + i * 3.1) - 0.5) * 0.04;
    geometries.push(
      createBox(
        segmentLength * 0.92,
        panelHeight,
        widthM * 0.82,
        new THREE.Vector3(x, panelHeight * 0.5 + 0.08 + jitter, 0),
        COLORS.fenceWall
      )
    );

    geometries.push(
      createBox(
        segmentLength * 0.94,
        0.10,
        widthM,
        new THREE.Vector3(x, panelHeight + 0.12, 0),
        COLORS.fenceCap
      )
    );
  }

  return mergeGeometries(geometries);
}

function pushJar(
  geometries: THREE.BufferGeometry[],
  position: THREE.Vector3,
  radius: number,
  height: number,
  hueJitter: number
): void {
  const jarTint = 0.86 + hueJitter * 0.2;
  const jarColor = new THREE.Color(
    COLORS.jarBrown.r * jarTint,
    COLORS.jarBrown.g * jarTint,
    COLORS.jarBrown.b * jarTint
  );

  geometries.push(
    createCylinder(
      radius * 0.82,
      radius,
      height * 0.62,
      14,
      new THREE.Vector3(position.x, position.y + height * 0.31, position.z),
      jarColor
    )
  );

  geometries.push(
    createSphere(
      radius * 0.88,
      14,
      10,
      new THREE.Vector3(position.x, position.y + height * 0.57, position.z),
      jarColor
    )
  );

  geometries.push(
    createCylinder(
      radius * 0.46,
      radius * 0.54,
      height * 0.14,
      12,
      new THREE.Vector3(position.x, position.y + height * 0.90, position.z),
      jarColor
    )
  );

  geometries.push(
    createCylinder(
      radius * 0.60,
      radius * 0.66,
      height * 0.09,
      12,
      new THREE.Vector3(position.x, position.y + height * 0.99, position.z),
      COLORS.jarLid
    )
  );
}

export function generateJangdokdaeGeometry(
  dimensions: StructureDimensions,
  seed: number
): THREE.BufferGeometry {
  const lengthM = clamp(dimensions.lengthM, 1.4, 14.0);
  const widthM = clamp(dimensions.widthM, 1.0, 10.0);
  const heightM = clamp(dimensions.heightM, 0.3, 2.0);

  const geometries: THREE.BufferGeometry[] = [];

  const baseHeight = clamp(heightM * 0.26, 0.12, 0.42);
  geometries.push(
    createBox(
      lengthM,
      baseHeight,
      widthM,
      new THREE.Vector3(0, baseHeight * 0.5, 0),
      COLORS.foundation
    )
  );

  const jarRows = Math.max(1, Math.floor(widthM / 1.2));
  const jarCols = Math.max(2, Math.floor(lengthM / 1.25));
  const spacingX = lengthM / Math.max(1, jarCols);
  const spacingZ = widthM / Math.max(1, jarRows);

  for (let row = 0; row < jarRows; row++) {
    for (let col = 0; col < jarCols; col++) {
      const px = -lengthM * 0.5 + spacingX * (col + 0.5);
      const pz = -widthM * 0.5 + spacingZ * (row + 0.5);
      const jitter = seeded01(seed + row * 7.7 + col * 13.1);
      const radius = 0.19 + jitter * 0.08;
      const jarHeight = 0.46 + jitter * 0.25;

      pushJar(
        geometries,
        new THREE.Vector3(px, baseHeight, pz),
        radius,
        jarHeight,
        jitter
      );
    }
  }

  return mergeGeometries(geometries);
}

export function generateDoghouseGeometry(
  dimensions: StructureDimensions,
  seed: number
): THREE.BufferGeometry {
  const lengthM = clamp(dimensions.lengthM, 0.9, 4.0);
  const widthM = clamp(dimensions.widthM, 0.8, 3.2);
  const heightM = clamp(dimensions.heightM, 0.9, 2.8);

  const geometries: THREE.BufferGeometry[] = [];

  const bodyHeight = heightM * 0.58;
  const roofRise = heightM * 0.42;
  const eave = 0.10;

  geometries.push(
    createBox(
      lengthM,
      0.08,
      widthM,
      new THREE.Vector3(0, 0.04, 0),
      COLORS.woodDark
    )
  );

  geometries.push(
    createBox(
      lengthM,
      bodyHeight,
      widthM,
      new THREE.Vector3(0, bodyHeight * 0.5 + 0.08, 0),
      COLORS.woodMid
    )
  );

  const frontZ = -widthM * 0.5 + 0.01;
  const doorWidth = lengthM * 0.32;
  const doorHeight = bodyHeight * 0.62;
  const doorY = 0.08 + doorHeight * 0.5;

  geometries.push(
    createBox(
      doorWidth + 0.08,
      0.06,
      0.06,
      new THREE.Vector3(0, doorY + doorHeight * 0.5, frontZ),
      COLORS.woodDark
    )
  );
  geometries.push(
    createBox(
      0.05,
      doorHeight,
      0.06,
      new THREE.Vector3(-doorWidth * 0.5, doorY, frontZ),
      COLORS.woodDark
    )
  );
  geometries.push(
    createBox(
      0.05,
      doorHeight,
      0.06,
      new THREE.Vector3(doorWidth * 0.5, doorY, frontZ),
      COLORS.woodDark
    )
  );
  geometries.push(
    createBox(
      doorWidth * 0.84,
      doorHeight * 0.84,
      0.05,
      new THREE.Vector3(0, doorY, frontZ),
      COLORS.firebox
    )
  );

  const roofBaseY = 0.08 + bodyHeight;
  const roofLength = lengthM + eave * 2;
  const roofSpan = widthM + eave * 2;

  const ridgeLeft = new THREE.Vector3(-roofLength * 0.5, roofBaseY + roofRise, 0);
  const ridgeRight = new THREE.Vector3(roofLength * 0.5, roofBaseY + roofRise, 0);
  const frontLeft = new THREE.Vector3(-roofLength * 0.5, roofBaseY, -roofSpan * 0.5);
  const frontRight = new THREE.Vector3(roofLength * 0.5, roofBaseY, -roofSpan * 0.5);
  const backLeft = new THREE.Vector3(-roofLength * 0.5, roofBaseY, roofSpan * 0.5);
  const backRight = new THREE.Vector3(roofLength * 0.5, roofBaseY, roofSpan * 0.5);

  geometries.push(createQuad(ridgeLeft, ridgeRight, frontRight, frontLeft, COLORS.giwaTile));
  geometries.push(createQuad(ridgeLeft, ridgeRight, backRight, backLeft, COLORS.giwaTile));
  geometries.push(createTriangle(frontLeft, ridgeLeft, backLeft, COLORS.woodDark));
  geometries.push(createTriangle(frontRight, ridgeRight, backRight, COLORS.woodDark));

  const ridgeTint = 0.90 + seeded01(seed + 17.2) * 0.15;
  geometries.push(
    createCylinder(
      0.05,
      0.05,
      roofLength * 0.98,
      10,
      new THREE.Vector3(0, roofBaseY + roofRise + 0.03, 0),
      new THREE.Color(COLORS.giwaTile.r * ridgeTint, COLORS.giwaTile.g * ridgeTint, COLORS.giwaTile.b * ridgeTint),
      new THREE.Euler(0, 0, Math.PI * 0.5)
    )
  );

  return mergeGeometries(geometries);
}
