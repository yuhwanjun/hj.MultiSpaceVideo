"use client";

import { Canvas } from "@react-three/fiber";
import { useWebcamTexture } from "@/hooks/useWebcamTexture";
import { OrbitControls } from "@react-three/drei";
import AtlasTilePreview from "@/components/AtlasTilePreview";

export default function Page() {
  // useWebcamTexture 파라미터
  // - width/height: 캡처 타겟 해상도(픽셀)
  // - fps: 초당 프레임 목표값
  const { previewRef } = useWebcamTexture({
    width: 128,
    height: 128,
    fps: 15,
    horizontalFlip: true,
  });
  return (
    <main className="min-h-screen w-full bg-[#0b0d12] text-white">
      <div className="fixed inset-0 top-[52px]">
        <Canvas
          camera={{ fov: 75, near: 0.1, far: 1000 }}
          className="w-full h-full"
        >
          {/* 아틀라스 훅 + 컴포넌트: 128타일, 16x그리드, depth=128, index=0 타일에 저장/표시 */}
          <AtlasTilePreview
            tile={128}
            grid={16}
            depth={1}
            index={2}
            planeSize={8}
            fps={30}
          />
          {/* 아틀라스 렌더링 위치*/}
          {/* <mesh position={[0, 0, 1]}>
            <planeGeometry args={[2, 2]} />
            <meshBasicMaterial map={atlasRT.texture} toneMapped={false} />
          </mesh> */}
          {/* OrbitControls
              - enableDamping: 마우스 이동에 관성 효과
              - dampingFactor: 감쇠 강도 */}
          <OrbitControls enableDamping dampingFactor={0.05} />
        </Canvas>
      </div>
      {/* 우하단 고정 웹캠 프리뷰: 훅의 previewRef를 DOM <video>에 연결 */}
      <video ref={previewRef} className="webcam-preview" />
    </main>
  );
}
