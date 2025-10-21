"use client";
import { useEffect, useState } from "react";
import { Texture, DoubleSide, NearestFilter, SRGBColorSpace } from "three";
import type { Side } from "three";
import type { ThreeElements } from "@react-three/fiber";
import { captureVideoFrameAsImage } from "@/lib/extractVideoFrame";

export type VideoFramePlaneProps = {
  file?: File;
  videoUrl?: string;
  frame: number;
  width: number; // capture width in pixels
  height: number; // capture height in pixels
  planeWidth?: number; // world units
  planeHeight?: number; // world units
  side?: Side;
  pixelate?: number; // 8 = 강한 픽셀화, 1 = 원본
  mimeType?: string; // 'image/webp' | 'image/jpeg'
  quality?: number; // 0..1
} & ThreeElements["mesh"];

export default function VideoFramePlane({
  file,
  videoUrl,
  frame = 10,
  width = 64,
  height = 64,
  planeWidth = 10,
  planeHeight = 10,
  side = DoubleSide,
  pixelate = 8,
  mimeType = "image/webp",
  quality = 0.2,
  ...meshProps
}: VideoFramePlaneProps) {
  const [texture, setTexture] = useState<Texture | null>(null);

  useEffect(() => {
    let isActive = true;
    const objectUrl = file ? URL.createObjectURL(file) : (videoUrl as string);

    const load = async () => {
      if (!file && !videoUrl) return;
      try {
        const src = file ? URL.createObjectURL(file) : (videoUrl as string);
        const img = await captureVideoFrameAsImage(src, frame, width, height, { pixelate, mimeType, quality });
        if (!isActive) return;
        if (texture) texture.dispose();
        const tex = new Texture(img);
        tex.flipY = false;
        // 픽셀화 유지: Nearest 필터 사용
        tex.minFilter = NearestFilter;
        tex.magFilter = NearestFilter;
        // color space to display sRGB images correctly (fallback if property exists)
        if ("colorSpace" in tex) {
          (tex as unknown as { colorSpace?: unknown }).colorSpace = SRGBColorSpace as unknown;
        }
        tex.needsUpdate = true;
        setTexture(tex);
      } finally {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      }
    };

    load();

    return () => {
      isActive = false;
      if (texture) texture.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, videoUrl, frame, width, height]);

  return (
    <mesh {...meshProps}>
      <planeGeometry args={[planeWidth, planeHeight]} />
      <meshBasicMaterial key={frame} map={texture || undefined} side={side} />
    </mesh>
  );
}
