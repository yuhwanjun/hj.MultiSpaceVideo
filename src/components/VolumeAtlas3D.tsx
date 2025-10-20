"use client";

import { useEffect, useMemo } from "react";
import {
  Data3DTexture,
  LinearFilter,
  NearestFilter,
  ClampToEdgeWrapping,
  RGBAFormat,
  UnsignedByteType,
  DoubleSide,
  GLSL3,
} from "three";
import { useThree } from "@react-three/fiber";
import type { SlicePixels } from "@/hooks/useSliceStack";

export type VolumeAtlas3DProps = {
  slices: SlicePixels[];
  cols: number;
  rows: number;
  sliceGap?: number; // 슬라이스 간 Z 간격
};

/**
 * VolumeAtlas3D
 * - webcam 슬라이스 배열을 3D 텍스처(Data3DTexture)로 합쳐 sampler3D로 샘플링합니다.
 * - 각 슬라이스 위치에 얇은 평면(mesh)을 배치하고, 해당 z 레이어를 텍스처에서 읽어 색을 표시합니다.
 */
export default function VolumeAtlas3D({
  slices,
  cols,
  rows,
  sliceGap = 1.2,
}: VolumeAtlas3DProps) {
  const depth = slices.length;

  // 3D 텍스처 데이터 만들기: [width * height * depth * 4]
  const tex3D = useMemo(() => {
    if (depth === 0) return null;
    const data = new Uint8Array(cols * rows * depth * 4);
    // 최신 슬라이스가 앞에 있으므로, z=0을 최신으로 맞춥니다.
    for (let z = 0; z < depth; z++) {
      const src = slices[z];
      const dstOffset = z * cols * rows * 4;
      data.set(src, dstOffset);
    }
    const tex = new Data3DTexture(data, cols, rows, depth);
    tex.format = RGBAFormat;
    tex.type = UnsignedByteType;
    // 픽셀 느낌을 살리기 위해 최근접 필터 사용
    tex.minFilter = NearestFilter;
    tex.magFilter = NearestFilter;
    tex.wrapS = ClampToEdgeWrapping;
    tex.wrapT = ClampToEdgeWrapping;
    tex.wrapR = ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.unpackAlignment = 1; // 안전한 행 정렬
    tex.needsUpdate = true;
    return tex;
  }, [slices, cols, rows, depth]);

  // WebGL2가 필요합니다. (sampler3D)
  const { gl } = useThree();
  useEffect(() => {
    const isWebGL2 = !!gl.capabilities.isWebGL2;
    if (!isWebGL2) {
      // eslint-disable-next-line no-console
      console.warn(
        "WebGL2가 필요합니다. 브라우저가 지원하지 않을 수 있습니다."
      );
    }
  }, [gl]);

  if (!tex3D || depth === 0) return null;

  // 각 레이어(z)에 해당하는 얇은 평면을 렌더링합니다.
  return (
    <group>
      {Array.from({ length: depth }).map((_, k) => {
        // k번째 레이어의 정규화된 z (0..1 사이 중앙 샘플)
        const layerZ = (k + 0.5) / depth;
        return (
          <mesh key={k} position={[0, 0, -k * sliceGap]}>
            {/* 평면 크기를 cols×rows로 설정하여 그리드와 스케일을 맞춥니다. */}
            <planeGeometry args={[cols, rows, 1, 1]} />
            <shaderMaterial
              uniforms={{
                uTex3D: { value: tex3D },
                uLayerZ: { value: layerZ },
              }}
              vertexShader={`
                out vec2 vUv;
                void main() {
                  vUv = uv;
                  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
              `}
              fragmentShader={`
                precision highp float;
                precision highp sampler3D;
                uniform sampler3D uTex3D;
                uniform float uLayerZ;
                in vec2 vUv;
                out vec4 outColor;
                void main() {
                  // vUv.y는 위아래가 반전되므로 1.0 - vUv.y 사용
                  vec3 p = vec3(vUv.x, 1.0 - vUv.y, uLayerZ);
                  vec4 c = texture(uTex3D, p);
                  // 완전 불투명으로 강제
                  outColor = vec4(c.rgb, 1.0);
                }
              `}
              glslVersion={GLSL3}
              depthWrite
              depthTest
              transparent={false}
              side={DoubleSide}
            />
          </mesh>
        );
      })}
    </group>
  );
}
