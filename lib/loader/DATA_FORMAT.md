# World Editor Data Format Specification

Version: 1.0.0

## Overview

This document describes the JSON data format used by the World Editor for saving and loading terrain data. The format is designed to be:

- **Portable**: Can be loaded by any Babylon.js or Three.js project
- **Compact**: Uses Base64 encoding for binary data
- **Versioned**: Supports backward compatibility

## File Formats

### 1. Single Tile Export (`WorldProject`)

Used when exporting a single terrain tile.

```json
{
  "version": "1.0.0",
  "name": "My Terrain",
  "createdAt": "2024-01-15T10:30:00.000Z",
  "modifiedAt": "2024-01-15T12:45:00.000Z",

  "terrain": {
    "size": 64,
    "resolution": 256,
    "heightmap": "<Base64 encoded Float32Array>",
    "splatmap": "<Base64 encoded Float32Array>",
    "waterMask": "<Base64 encoded Float32Array>"
  },

  "foliage": {
    "grass_v0": "<Base64 encoded Float32Array>",
    "grass_v1": "<Base64 encoded Float32Array>",
    "rock_v0": "<Base64 encoded Float32Array>"
  },

  "props": [],

  "materials": {
    "slots": [
      { "name": "grass", "channel": 0 },
      { "name": "dirt", "channel": 1 },
      { "name": "rock", "channel": 2 },
      { "name": "sand", "channel": 3 }
    ]
  },

  "settings": {
    "seamlessTiling": true,
    "waterLevel": -100,
    "waterDepth": 2.0
  }
}
```

### 2. Full World Export

Used when exporting multiple tiles with world grid configuration.

```json
{
  "version": "1.0.0",
  "name": "My World",
  "createdAt": "...",
  "modifiedAt": "...",

  "mainTile": {
    "terrain": { ... },
    "foliage": { ... }
  },

  "tiles": [
    {
      "id": "tile_123456_abc",
      "name": "Forest Tile",
      "terrain": { ... },
      "foliage": { ... }
    }
  ],

  "worldGrid": {
    "infinitePool": [
      { "tileId": "tile_123456_abc", "weight": 50, "enabled": true }
    ],
    "manualPlacements": [
      { "gridX": 0, "gridY": 0, "tileId": "tile_123456_abc" }
    ],
    "gridSize": 5
  },

  "materials": { ... },
  "settings": { ... }
}
```

## Data Structures

### Heightmap

- **Type**: Float32Array
- **Size**: `(resolution + 1) * (resolution + 1)` elements
- **Values**: Height in world units (typically -10 to +50)
- **Layout**: Row-major, starting from top-left corner

```
Example for resolution=4 (5x5 vertices):
[h00, h01, h02, h03, h04,  // Row 0 (Z=0)
 h10, h11, h12, h13, h14,  // Row 1 (Z=1)
 h20, h21, h22, h23, h24,  // Row 2 (Z=2)
 h30, h31, h32, h33, h34,  // Row 3 (Z=3)
 h40, h41, h42, h43, h44]  // Row 4 (Z=4)
```

### Splatmap

- **Type**: Float32Array
- **Size**: `resolution * resolution * 4` elements (RGBA)
- **Values**: 0.0 to 1.0 (material blend weights)
- **Layout**: Row-major, RGBA interleaved

```
Channels:
  R (channel 0): Grass weight
  G (channel 1): Dirt weight
  B (channel 2): Rock weight
  A (channel 3): Sand weight

Example for resolution=2 (2x2 pixels):
[r00, g00, b00, a00,  // Pixel (0,0)
 r01, g01, b01, a01,  // Pixel (1,0)
 r10, g10, b10, a10,  // Pixel (0,1)
 r11, g11, b11, a11]  // Pixel (1,1)
```

### Water Mask

- **Type**: Float32Array
- **Size**: `resolution * resolution` elements
- **Values**: 0.0 (no water) to 1.0 (full water)
- **Layout**: Row-major

### Foliage Data

Each foliage type is stored as a buffer of 4x4 transformation matrices.

- **Type**: Float32Array
- **Size**: `instanceCount * 16` elements
- **Layout**: Column-major 4x4 matrices

```
Single instance (16 floats):
[m00, m10, m20, m30,  // Column 0
 m01, m11, m21, m31,  // Column 1
 m02, m12, m22, m32,  // Column 2
 m03, m13, m23, m33]  // Column 3 (translation in m03, m13, m23)

World position extraction:
  X = matrix[12]  // m03
  Y = matrix[13]  // m13
  Z = matrix[14]  // m23
```

## Base64 Encoding

All binary data is encoded using standard Base64 (RFC 4648).

### Encoding (JavaScript)

```javascript
function encodeFloat32Array(arr) {
  const uint8 = new Uint8Array(arr.buffer);
  let binary = "";
  for (let i = 0; i < uint8.length; i++) {
    binary += String.fromCharCode(uint8[i]);
  }
  return btoa(binary);
}
```

### Decoding (JavaScript)

```javascript
function decodeFloat32Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Float32Array(bytes.buffer);
}
```

## Coordinate System

```
      +Y (up)
       |
       |
       +------ +X (right)
      /
     /
   +Z (forward/down in top view)

Origin: Center of terrain (0, 0, 0)
Terrain bounds: [-size/2, size/2] on X and Z axes
```

## Version History

### 1.0.0 (Current)

- Initial release
- Supports: heightmap, splatmap, waterMask, foliage
- Base64 encoding for all binary data

## Usage with WorldLoader

```typescript
import { WorldLoader, TerrainRenderer, FoliageRenderer } from "@world-editor/loader";

// Load JSON file
const json = await fetch("terrain.json").then(r => r.text());
const result = WorldLoader.loadWorld(json);

if (result.success) {
  const world = result.data;
  const tile = world.mainTile;

  // Access decoded data
  console.log("Heightmap size:", tile.heightmap.length);
  console.log("Resolution:", tile.resolution);
  console.log("Foliage types:", tile.foliage.size);

  // Render terrain
  const terrain = new TerrainRenderer(scene);
  terrain.create({
    heightmap: tile.heightmap,
    resolution: tile.resolution,
    splatmap: tile.splatmap,
    waterMask: tile.waterMask,
    size: tile.size,
    seaLevel: tile.seaLevel,
  });

  // Render foliage
  const foliage = new FoliageRenderer(scene);
  foliage.loadTile(tile.foliage);
}
```

## File Size Estimates

| Resolution | Heightmap | Splatmap | Typical Total |
|------------|-----------|----------|---------------|
| 64         | 17 KB     | 64 KB    | ~100 KB       |
| 128        | 66 KB     | 256 KB   | ~400 KB       |
| 256        | 262 KB    | 1 MB     | ~1.5 MB       |
| 512        | 1 MB      | 4 MB     | ~6 MB         |

Note: Foliage data size varies based on instance count.
