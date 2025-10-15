# World Editor

A web-based 3D terrain editor for creating game worlds with heightmap editing, texture painting, and prop placement.

## Features

- **Heightmap Editing** - Raise, lower, flatten, and smooth terrain
- **Texture Painting** - Paint materials on terrain surface
- **Prop Placement** - Place 3D assets from library or AI-generated models
- **Infinite Terrain Preview** - Test seamless tiling in game mode
- **Multiple Export Formats** - JSON project files and GLB meshes

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## Controls

| Action | Control |
|--------|---------|
| Rotate view | Drag |
| Zoom | Cmd + Scroll |
| Pan | Shift + Drag |
| Brush size | `[` / `]` |
| Tools | `1` Select, `2` Heightmap, `3` Paint, `4` Props |
| Height brushes | `Q` Raise, `W` Lower, `E` Flatten, `R` Smooth |
| Toggle grid | `G` |
| Toggle wireframe | `F` |
| Play mode | `P` or Play button |

## Export Formats

### JSON Project (Recommended)

Contains complete world data including heightmap, props, and settings. Use this for games that need runtime terrain collision.

### GLB Mesh

Exports terrain geometry only. Use for static environments without heightmap access.

## Integration Guide

See [docs/EXPORT_GUIDE.md](docs/EXPORT_GUIDE.md) for detailed integration instructions with:

- Babylon.js implementation examples
- Three.js implementation examples
- Infinite terrain setup
- Coordinate system reference
- Troubleshooting tips

## Project Structure

```
world-editor/
├── app/                    # Next.js app router
├── components/editor/      # Editor UI components
├── lib/editor/
│   ├── core/              # EditorEngine, GamePreview
│   ├── terrain/           # Heightmap, TerrainMesh, SplatMap
│   ├── assets/            # Asset library management
│   └── store/             # Zustand state management
├── docs/                  # Documentation
└── public/                # Static assets
```

## Tech Stack

- Next.js 15 (App Router)
- Babylon.js 7+ (3D rendering)
- Zustand (State management)
- TypeScript
- Tailwind CSS
