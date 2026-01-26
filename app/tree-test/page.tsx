"use client";

import { useEffect, useRef, useState } from "react";
import * as BABYLON from "@babylonjs/core";
import { ProceduralAsset, DEFAULT_ASSET_PARAMS } from "@/lib/editor/props/ProceduralAsset";

export default function TreeTestPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<BABYLON.Engine | null>(null);
  const sceneRef = useRef<BABYLON.Scene | null>(null);
  const treeRef = useRef<BABYLON.Mesh | null>(null);

  const [seed, setSeed] = useState(42);
  const [autoRotate, setAutoRotate] = useState(true);
  const [wireframe, setWireframe] = useState(false);

  useEffect(() => {
    if (!canvasRef.current) return;

    const engine = new BABYLON.Engine(canvasRef.current, true);
    engineRef.current = engine;

    const scene = new BABYLON.Scene(engine);
    sceneRef.current = scene;
    scene.clearColor = new BABYLON.Color4(0.1, 0.1, 0.12, 1);

    // Camera - close up view
    const camera = new BABYLON.ArcRotateCamera(
      "camera",
      Math.PI / 4,
      Math.PI / 3,
      3,
      new BABYLON.Vector3(0, 0.8, 0),
      scene
    );
    camera.attachControl(canvasRef.current, true);
    camera.minZ = 0.01;
    camera.wheelPrecision = 50;
    camera.lowerRadiusLimit = 0.5;
    camera.upperRadiusLimit = 10;

    // Lights
    const hemi = new BABYLON.HemisphericLight("hemi", new BABYLON.Vector3(0, 1, 0), scene);
    hemi.intensity = 0.6;

    const dir = new BABYLON.DirectionalLight("dir", new BABYLON.Vector3(-1, -2, -1), scene);
    dir.intensity = 0.8;

    // Ground for reference
    const ground = BABYLON.MeshBuilder.CreateGround("ground", { width: 5, height: 5 }, scene);
    const groundMat = new BABYLON.StandardMaterial("groundMat", scene);
    groundMat.diffuseColor = new BABYLON.Color3(0.2, 0.25, 0.15);
    ground.material = groundMat;

    // Grid helper
    const gridLines: BABYLON.Mesh[] = [];
    for (let i = -2; i <= 2; i++) {
      const lineX = BABYLON.MeshBuilder.CreateLines(`gridX${i}`, {
        points: [new BABYLON.Vector3(i, 0.01, -2.5), new BABYLON.Vector3(i, 0.01, 2.5)]
      }, scene);
      lineX.color = new BABYLON.Color3(0.3, 0.3, 0.3);
      gridLines.push(lineX);

      const lineZ = BABYLON.MeshBuilder.CreateLines(`gridZ${i}`, {
        points: [new BABYLON.Vector3(-2.5, 0.01, i), new BABYLON.Vector3(2.5, 0.01, i)]
      }, scene);
      lineZ.color = new BABYLON.Color3(0.3, 0.3, 0.3);
      gridLines.push(lineZ);
    }

    // Render loop
    engine.runRenderLoop(() => {
      if (autoRotate && treeRef.current) {
        treeRef.current.rotation.y += 0.005;
      }
      scene.render();
    });

    window.addEventListener("resize", () => engine.resize());

    return () => {
      engine.dispose();
    };
  }, []);

  // Generate tree when seed changes
  useEffect(() => {
    if (!sceneRef.current) return;

    // Dispose old tree
    if (treeRef.current) {
      treeRef.current.dispose();
      treeRef.current = null;
    }

    // Generate new tree
    const params = {
      ...DEFAULT_ASSET_PARAMS.tree,
      seed,
      size: 1.0,
    };

    const asset = new ProceduralAsset(sceneRef.current, params);
    const mesh = asset.generate();

    if (mesh) {
      mesh.position.y = 0;
      treeRef.current = mesh;

      // Apply wireframe if enabled
      if (mesh.material) {
        (mesh.material as BABYLON.StandardMaterial).wireframe = wireframe;
      }
    }
  }, [seed, wireframe]);

  const randomizeSeed = () => {
    setSeed(Math.floor(Math.random() * 10000));
  };

  const cycleVariation = (delta: number) => {
    // Cycle through variation seeds (42, 1042, 2042, ...)
    const variations = [42, 1042, 2042, 3042, 4042, 5042, 6042, 7042];
    const currentIdx = variations.indexOf(seed);
    if (currentIdx >= 0) {
      const newIdx = (currentIdx + delta + variations.length) % variations.length;
      setSeed(variations[newIdx]);
    } else {
      setSeed(variations[0]);
    }
  };

  return (
    <div className="w-full h-screen bg-zinc-900 flex">
      {/* Controls */}
      <div className="w-64 p-4 bg-zinc-950 border-r border-zinc-800 flex flex-col gap-4">
        <h1 className="text-lg font-bold text-zinc-100">Tree Test</h1>

        <div className="space-y-2">
          <label className="text-xs text-zinc-400">Seed</label>
          <div className="flex gap-2">
            <input
              type="number"
              value={seed}
              onChange={(e) => setSeed(parseInt(e.target.value) || 0)}
              className="flex-1 px-2 py-1 bg-zinc-800 text-zinc-100 rounded text-sm"
            />
            <button
              onClick={randomizeSeed}
              className="px-3 py-1 bg-zinc-700 text-zinc-100 rounded text-sm hover:bg-zinc-600"
            >
              Random
            </button>
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-xs text-zinc-400">Variation Presets</label>
          <div className="flex gap-2">
            <button
              onClick={() => cycleVariation(-1)}
              className="px-3 py-1 bg-zinc-700 text-zinc-100 rounded text-sm hover:bg-zinc-600"
            >
              ← Prev
            </button>
            <button
              onClick={() => cycleVariation(1)}
              className="px-3 py-1 bg-zinc-700 text-zinc-100 rounded text-sm hover:bg-zinc-600"
            >
              Next →
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="autoRotate"
            checked={autoRotate}
            onChange={(e) => setAutoRotate(e.target.checked)}
            className="rounded"
          />
          <label htmlFor="autoRotate" className="text-sm text-zinc-300">Auto Rotate</label>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="wireframe"
            checked={wireframe}
            onChange={(e) => setWireframe(e.target.checked)}
            className="rounded"
          />
          <label htmlFor="wireframe" className="text-sm text-zinc-300">Wireframe</label>
        </div>

        <div className="mt-auto text-xs text-zinc-500 space-y-1">
          <p>Mouse: Rotate camera</p>
          <p>Scroll: Zoom in/out</p>
          <p>Current seed: {seed}</p>
        </div>
      </div>

      {/* Canvas */}
      <div className="flex-1 relative">
        <canvas ref={canvasRef} className="w-full h-full" />
      </div>
    </div>
  );
}
