"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { useThree, useFrame } from "@react-three/fiber";
import { useWebcamTexture } from "@/hooks/useWebcamTexture";
import { useVideoAtlas } from "@/hooks/useVideoAtlas";

export type AtlasTilePreviewProps = {
  // tile: 아틀라스의 한 타일(한 프레임) 픽셀 크기 (가로=세로)
  tile: number;
  // grid: 가로 타일 개수 (세로는 depth/grid 로 유도)
  grid: number;
  // depth: 최대 저장 프레임 수 (타일 총 개수)
  depth: number;
  // index: 이 컴포넌트가 갱신/표시할 타일 인덱스(0..depth-1)
  index: number;
  // planeSize: 화면에서 평면(출력 메쉬) 한 변의 길이 (기본 2)
  planeSize?: number;
  // fps: 웹캠 목표 프레임 (기본 15)
  fps?: number;
  // horizontalFlip: true면 좌우 반전(셀피 미러)
  horizontalFlip?: boolean;
};

/**
 * AtlasTilePreview
 * - 웹캠 비디오를 받아 useVideoAtlas로 아틀라스 텍스처에
 *   지정 인덱스(index) 타일에 매 프레임 저장(blit)합니다.
 * - 저장된 해당 타일 부분만 잘라서 평면 메쉬로 표시합니다.
 */
export default function AtlasTilePreview({
  tile,
  grid,
  depth,
  index,
  planeSize = 2,
  fps = 15,
  horizontalFlip = false,
}: AtlasTilePreviewProps) {
  // 1) 웹캠 비디오 텍스처 생성 (getUserMedia → THREE.VideoTexture)
  const { videoTexture } = useWebcamTexture({
    width: tile,
    height: tile,
    fps,
    horizontalFlip,
  });

  // 2) 비디오 → 아틀라스에 타일로 저장하는 유틸 세트
  const { atlasRT, blitToAtlas } = useVideoAtlas(videoTexture ?? null, {
    tile,
    grid,
    depth,
    pixelRatio1: true,
  });

  // 3) R3F 렌더러(gl) 핸들: blit 시 필요
  const { gl } = useThree();

  // 4) 매 프레임, 현재 비디오 프레임을 지정 인덱스 타일에 복사
  useFrame(() => {
    const vid = videoTexture?.image as HTMLVideoElement | undefined;
    if (!videoTexture || !vid || vid.readyState < 2) return;
    blitToAtlas(gl, index);
    gl.setViewport(0, 0, gl.domElement.width, gl.domElement.height);
  });

  // 5) 표시용 텍스처: 아틀라스 전체 중 특정 타일만 보이게 offset/repeat 설정
  //    clone을 써서 서로 다른 미리보기 컴포넌트가 상태를 덮어쓰지 않도록 분리
  const displayTex = useMemo(() => atlasRT.texture, [atlasRT.texture]);
  useEffect(() => {
    // 타일 그리드 정보로 UV 잘라내기
    const rows = Math.ceil(depth / grid);
    const col = index % grid;
    const row = (index / grid) | 0; // 0부터 시작 (아래쪽부터 위로)
    displayTex.repeat.set(1 / grid, 1 / rows);
    // 텍스처 UV는 위쪽이 1.0이므로, 위에서부터 타일을 계산해 정확히 정사각 타일만 보이게 함
    displayTex.offset.set(col / grid, 1 - (row + 1) / rows);
    // 픽셀 선명도 향상(경계 블리딩 방지)
    displayTex.minFilter = THREE.NearestFilter;
    displayTex.magFilter = THREE.NearestFilter;
    displayTex.generateMipmaps = false;
    displayTex.needsUpdate = true;
  }, [displayTex, grid, depth, index]);

  // 6) 평면 메쉬로 해당 타일 영역만 표시
  return (
    <mesh position={[0, 0, -1]}>
      {/* planeGeometry args: [width, height] (장면 단위) */}
      <planeGeometry args={[planeSize, planeSize]} />
      {/* meshBasicMaterial: 단순 표시용, 톤매핑 비활성화 */}
      <meshBasicMaterial map={displayTex} toneMapped={false} />
    </mesh>
  );
}
