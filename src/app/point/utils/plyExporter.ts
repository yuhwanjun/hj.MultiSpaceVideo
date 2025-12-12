/**
 * PLY 포인트 클라우드 내보내기 유틸리티
 * 
 * 포인트 클라우드 데이터를 PLY (Polygon File Format) 형식으로 변환합니다.
 * PLY는 MeshLab, CloudCompare, Blender 등 대부분의 3D 소프트웨어에서 지원됩니다.
 * 
 * @module utils/plyExporter
 */

import { PLY_EXPORT_CONFIG } from "../config";
import {
  calcHalf,
  calcActualFrameIndex,
  calcZPosition,
  calcColorDataIndex,
  calcTotalPoints,
  calcPixelIndex,
} from "./math";

/**
 * PLY 내보내기에 필요한 데이터
 */
export interface PLYExportData {
  /** 색상 데이터 배열 (RGBA, Uint8Array) */
  colorData: Uint8Array;
  /** 이미지 너비 */
  width: number;
  /** 이미지 높이 */
  height: number;
  /** 프레임 수 */
  frames: number;
  /** 프레임 간 Z 간격 */
  spacing: number;
  /** Ring buffer 현재 쓰기 위치 */
  writeIndex: number;
}

/**
 * PLY 내보내기 결과
 */
export interface PLYExportResult {
  /** 성공 여부 */
  success: boolean;
  /** 총 포인트 수 */
  totalPoints?: number;
  /** 파일 크기 (bytes) */
  fileSize?: number;
  /** 에러 메시지 (실패 시) */
  error?: string;
}

/**
 * ASCII PLY 헤더 생성
 * 
 * @description
 * PLY 파일의 ASCII 형식 헤더를 생성합니다.
 * 헤더에는 포맷 정보, 정점 수, 속성(x, y, z, r, g, b) 정의가 포함됩니다.
 * 
 * @param totalPoints - 총 포인트 수
 * @returns PLY ASCII 헤더 문자열
 */
export function createPLYHeaderASCII(totalPoints: number): string {
  return [
    "ply",
    "format ascii 1.0",
    `element vertex ${totalPoints}`,
    "property float x",
    "property float y",
    "property float z",
    "property uchar red",
    "property uchar green",
    "property uchar blue",
    "end_header",
  ].join("\n") + "\n";
}

/**
 * Binary PLY 헤더 생성
 * 
 * @description
 * PLY 파일의 Binary (little endian) 형식 헤더를 생성합니다.
 * Binary 형식은 ASCII보다 파일 크기가 작고 로딩이 빠릅니다.
 * 
 * @param totalPoints - 총 포인트 수
 * @returns PLY Binary 헤더 문자열
 */
export function createPLYHeaderBinary(totalPoints: number): string {
  return [
    "ply",
    "format binary_little_endian 1.0",
    `element vertex ${totalPoints}`,
    "property float x",
    "property float y",
    "property float z",
    "property uchar red",
    "property uchar green",
    "property uchar blue",
    "end_header",
  ].join("\n") + "\n";
}

/**
 * ASCII PLY 데이터 생성
 * 
 * @description
 * 포인트 클라우드 데이터를 ASCII PLY 형식의 문자열로 변환합니다.
 * Ring buffer를 고려하여 올바른 시간 순서로 데이터를 정렬합니다.
 * 
 * 형식: "x y z r g b" (각 줄에 하나의 포인트)
 * 
 * @param data - PLY 내보내기 데이터
 * @returns PLY 파일 전체 내용 (헤더 + 데이터)
 * 
 * @example
 * const plyContent = createPLYDataASCII({
 *   colorData: new Uint8Array([...]),
 *   width: 128,
 *   height: 72,
 *   frames: 60,
 *   spacing: 2,
 *   writeIndex: 30
 * });
 */
export function createPLYDataASCII(data: PLYExportData): string {
  const { colorData, width, height, frames, spacing, writeIndex } = data;
  const pixelsPerFrame = width * height;
  const totalPoints = calcTotalPoints(width, height, frames);

  const xHalf = calcHalf(width);
  const yHalf = calcHalf(height);

  // 헤더 생성
  const header = createPLYHeaderASCII(totalPoints);

  // 포인트 데이터 생성
  const lines: string[] = [];

  for (let logicalFrame = 0; logicalFrame < frames; logicalFrame++) {
    // Ring buffer에서 실제 프레임 인덱스 계산
    const actualFrame = calcActualFrameIndex(logicalFrame, writeIndex, frames);
    // Z 위치 계산 (spacing 적용)
    const zPos = calcZPosition(logicalFrame, frames, spacing);

    for (let y = 0; y < height; y++) {
      const yPos = yHalf - y; // Y 좌표 반전

      for (let x = 0; x < width; x++) {
        const xPos = x - xHalf;

        // 색상 데이터 읽기
        const pixelIdx = calcPixelIndex(x, y, width);
        const colorIdx = calcColorDataIndex(actualFrame, pixelIdx, pixelsPerFrame);

        const r = colorData[colorIdx];
        const g = colorData[colorIdx + 1];
        const b = colorData[colorIdx + 2];

        // "x y z r g b" 형식으로 추가
        lines.push(`${xPos} ${yPos} ${zPos} ${r} ${g} ${b}`);
      }
    }
  }

  return header + lines.join("\n");
}

/**
 * Binary PLY 데이터 생성
 * 
 * @description
 * 포인트 클라우드 데이터를 Binary PLY 형식으로 변환합니다.
 * ASCII 형식보다 파일 크기가 약 60% 작고 로딩이 빠릅니다.
 * 
 * 바이너리 구조 (포인트당 15 bytes):
 * - x: float32 (4 bytes, little endian)
 * - y: float32 (4 bytes, little endian)
 * - z: float32 (4 bytes, little endian)
 * - r: uint8 (1 byte)
 * - g: uint8 (1 byte)
 * - b: uint8 (1 byte)
 * 
 * @param data - PLY 내보내기 데이터
 * @returns Binary PLY 데이터 (Uint8Array)
 * 
 * @example
 * const plyBinary = createPLYDataBinary({
 *   colorData: new Uint8Array([...]),
 *   width: 128,
 *   height: 72,
 *   frames: 60,
 *   spacing: 2,
 *   writeIndex: 30
 * });
 */
export function createPLYDataBinary(data: PLYExportData): Uint8Array {
  const { colorData, width, height, frames, spacing, writeIndex } = data;
  const pixelsPerFrame = width * height;
  const totalPoints = calcTotalPoints(width, height, frames);

  const xHalf = calcHalf(width);
  const yHalf = calcHalf(height);

  // 헤더 생성
  const header = createPLYHeaderBinary(totalPoints);
  const headerBytes = new TextEncoder().encode(header);

  // 데이터 버퍼 생성
  const dataBuffer = new ArrayBuffer(totalPoints * PLY_EXPORT_CONFIG.BYTES_PER_POINT);
  const dataView = new DataView(dataBuffer);

  let offset = 0;

  for (let logicalFrame = 0; logicalFrame < frames; logicalFrame++) {
    const actualFrame = calcActualFrameIndex(logicalFrame, writeIndex, frames);
    const zPos = calcZPosition(logicalFrame, frames, spacing);

    for (let y = 0; y < height; y++) {
      const yPos = yHalf - y;

      for (let x = 0; x < width; x++) {
        const xPos = x - xHalf;

        const pixelIdx = calcPixelIndex(x, y, width);
        const colorIdx = calcColorDataIndex(actualFrame, pixelIdx, pixelsPerFrame);

        // Float32 좌표값 (little endian)
        dataView.setFloat32(offset, xPos, true);
        offset += 4;
        dataView.setFloat32(offset, yPos, true);
        offset += 4;
        dataView.setFloat32(offset, zPos, true);
        offset += 4;

        // RGB 값
        dataView.setUint8(offset++, colorData[colorIdx]);
        dataView.setUint8(offset++, colorData[colorIdx + 1]);
        dataView.setUint8(offset++, colorData[colorIdx + 2]);
      }
    }
  }

  // 헤더 + 데이터 합치기
  const combined = new Uint8Array(headerBytes.length + dataBuffer.byteLength);
  combined.set(headerBytes, 0);
  combined.set(new Uint8Array(dataBuffer), headerBytes.length);

  return combined;
}

/**
 * 파일 크기를 읽기 쉬운 형식으로 변환
 * 
 * @description
 * 바이트 단위의 파일 크기를 KB, MB 등 읽기 쉬운 형식으로 변환합니다.
 * 
 * @param bytes - 바이트 단위 크기
 * @returns 포맷된 문자열 (예: "8.23 MB")
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`;
  } else {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
}


