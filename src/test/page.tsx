"use client";

import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { useControls } from "leva";
import { useSliceStack } from "@/hooks/useSliceStack";
import VolumeAtlas3D from "@/components/VolumeAtlas3D";

/**
 * 페이지 구성
 * - 좌측 상단: 현재 그리드/슬라이스 수/상태 표시
 * - 중앙: Three.js Canvas에 박스(보xel)로 구성된 슬라이스 스택 렌더링
 * - Leva 패널로 해상도/간격/최대 슬라이스를 조절
 */
export default function Page() {
  // 해상도(cols/rows), 샘플링 간격(intervalMs), 최대 슬라이스(maxSlices)
  const { cols, rows, intervalMs, maxSlices } = useControls("capture", {
    cols: { value: 100, min: 8, max: 128, step: 1 },
    rows: { value: 100, min: 8, max: 128, step: 1 },
    intervalMs: { value: 250, min: 33, max: 2000, step: 1 },
    maxSlices: { value: 1, min: 1, max: 100, step: 1 },
  });

  // 지정한 간격으로 웹캠 프레임을 캡처하여 슬라이스 스택을 만든다.
  const { slices, ready, error } = useSliceStack({
    cols,
    rows,
    intervalMs,
    maxSlices,
  });

  return (
    <main className="min-h-screen w-full bg-black text-white">
      <div className="fixed left-3 top-3 z-20 text-xs opacity-80 space-y-1 pointer-events-none">
        <div>
          Grid: {cols} × {rows}
        </div>
        <div>
          Slices: {slices.length} / {maxSlices}
        </div>
        {!ready && !error ? <div>Starting webcam…</div> : null}
        {error ? <div className="text-red-400">{error}</div> : null}
      </div>

      <div className="h-[100vh] w-full">
        <Canvas camera={{ position: [0, 0, 30], fov: 60 }}>
          <color attach="background" args={["#000000"]} />
          {/* <ambientLight intensity={0.6} /> */}
          {/* <directionalLight position={[10, 10, 10]} intensity={1.1} />
          <directionalLight position={[-10, -10, -5]} intensity={0.4} /> */}

          {/* 슬라이스 스택을 3D 텍스처(sampler3D)로 합쳐 각 레이어 평면에 샘플링 */}
          <VolumeAtlas3D slices={slices} cols={cols} rows={rows} />

          <OrbitControls enableDamping />
        </Canvas>
      </div>
    </main>
  );
}
