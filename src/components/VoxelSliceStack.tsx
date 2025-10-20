"use client";

import { useMemo } from "react";
import { Instances, Instance } from "@react-three/drei";
import type { SlicePixels } from "@/hooks/useSliceStack";

export type VoxelSliceStackProps = {
  slices: SlicePixels[];
  cols: number;
  rows: number;
  boxSize?: number; // 개별 박스 크기
  sliceGap?: number; // 슬라이스 사이 간격 (Z축)
};

/**
 * VoxelSliceStack
 * - 슬라이스 이미지 배열을 받아 픽셀별로 컬러가 있는 voxel(박스) 인스턴스를 생성합니다.
 */
export function VoxelSliceStack({
  slices,
  cols,
  rows,
  boxSize = 0.9,
  sliceGap = 1.2,
}: VoxelSliceStackProps) {
  // 인스턴스 데이터 구성: 위치(x,y,z)와 색상
  const instances = useMemo(() => {
    const voxels: { x: number; y: number; z: number; color: string }[] = [];
    const halfX = (cols - 1) / 2;
    const halfY = (rows - 1) / 2;

    for (let s = 0; s < slices.length; s++) {
      const data = slices[s];
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const idx = (j * cols + i) * 4;
          const r = data[idx + 0];
          const g = data[idx + 1];
          const b = data[idx + 2];
          // 16진수 색상 문자열로 변환
          const color = `#${r.toString(16).padStart(2, "0")}${g
            .toString(16)
            .padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
          const x = i - halfX;
          const y = halfY - j;
          const z = -s * sliceGap;
          voxels.push({ x, y, z, color });
        }
      }
    }
    return voxels;
  }, [slices, cols, rows, sliceGap]);

  return (
    <Instances limit={instances.length} range={instances.length}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial />
      {instances.map((v, idx) => (
        <Instance
          key={idx}
          position={[v.x, v.y, v.z]}
          scale={[boxSize, boxSize, boxSize]}
          color={v.color}
        />
      ))}
    </Instances>
  );
}

export default VoxelSliceStack;
