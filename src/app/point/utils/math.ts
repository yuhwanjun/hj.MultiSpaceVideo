/**
 * 수학 유틸리티 함수들
 * 
 * 포인트 클라우드 계산에 사용되는 수학 관련 헬퍼 함수들입니다.
 * 
 * @module utils/math
 */

/**
 * 값을 지정된 범위 내로 제한 (Clamp)
 * 
 * @description
 * 주어진 값이 최소값보다 작으면 최소값을, 최대값보다 크면 최대값을 반환합니다.
 * 슬라이더 값 조절, 좌표 범위 제한 등에 사용됩니다.
 * 
 * @param value - 제한할 값
 * @param min - 최소값
 * @param max - 최대값
 * @returns 범위 내로 제한된 값
 * 
 * @example
 * clamp(150, 0, 100);  // 100
 * clamp(-10, 0, 100);  // 0
 * clamp(50, 0, 100);   // 50
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * 포인트 클라우드의 중심 오프셋 계산
 * 
 * @description
 * 해상도(width, height)나 프레임 수에서 중심점 오프셋을 계산합니다.
 * 포인트들을 원점 중심으로 배치하기 위해 사용됩니다.
 * 
 * @param size - 크기 (너비, 높이, 또는 프레임 수)
 * @returns 중심 오프셋 값 ((size - 1) / 2)
 * 
 * @example
 * calcHalf(128);  // 63.5
 * calcHalf(72);   // 35.5
 * calcHalf(60);   // 29.5
 */
export function calcHalf(size: number): number {
  return (size - 1) / 2;
}

/**
 * 3D 포인트 좌표 계산
 * 
 * @description
 * 픽셀 좌표(x, y)와 프레임 인덱스(f)를 3D 월드 좌표로 변환합니다.
 * 중심을 원점(0, 0, 0)으로 하여 좌표를 계산합니다.
 * 
 * @param x - 픽셀 X 좌표 (0 ~ width-1)
 * @param y - 픽셀 Y 좌표 (0 ~ height-1)
 * @param f - 프레임 인덱스 (0 ~ frames-1)
 * @param width - 이미지 너비
 * @param height - 이미지 높이
 * @param frames - 전체 프레임 수
 * @returns 3D 좌표 { x, y, z }
 * 
 * @example
 * calcPoint3D(64, 36, 30, 128, 72, 60);
 * // { x: 0.5, y: -0.5, z: 0.5 }
 */
export function calcPoint3D(
  x: number,
  y: number,
  f: number,
  width: number,
  height: number,
  frames: number
): { x: number; y: number; z: number } {
  const xHalf = calcHalf(width);
  const yHalf = calcHalf(height);
  const zHalf = calcHalf(frames);
  
  return {
    x: x - xHalf,
    y: yHalf - y,  // Y는 위아래 반전 (이미지 좌표계 → 3D 좌표계)
    z: f - zHalf,
  };
}

/**
 * Ring Buffer에서 실제 프레임 인덱스 계산
 * 
 * @description
 * Ring buffer의 writeIndex를 고려하여 논리적 프레임 순서에서
 * 실제 데이터가 저장된 인덱스를 계산합니다.
 * 
 * @param logicalFrame - 논리적 프레임 순서 (0 = 가장 오래된)
 * @param writeIndex - Ring buffer의 현재 쓰기 위치
 * @param totalFrames - 전체 프레임 수
 * @returns 실제 데이터 인덱스
 * 
 * @example
 * // writeIndex가 30이고 totalFrames가 60일 때
 * calcActualFrameIndex(0, 30, 60);   // 30 (가장 오래된 프레임)
 * calcActualFrameIndex(29, 30, 60);  // 59
 * calcActualFrameIndex(30, 30, 60);  // 0
 * calcActualFrameIndex(59, 30, 60);  // 29 (최신 프레임)
 */
export function calcActualFrameIndex(
  logicalFrame: number,
  writeIndex: number,
  totalFrames: number
): number {
  return (writeIndex + logicalFrame) % totalFrames;
}

/**
 * Z 위치 계산 (spacing 적용)
 * 
 * @description
 * 프레임 인덱스를 실제 Z 좌표로 변환합니다.
 * spacing 값에 따라 프레임 간 간격이 결정됩니다.
 * 
 * @param frameIndex - 논리적 프레임 인덱스 (0 ~ frames-1)
 * @param totalFrames - 전체 프레임 수
 * @param spacing - 프레임 간 Z 간격
 * @returns Z 좌표값
 * 
 * @example
 * // 60 프레임, spacing 2일 때
 * calcZPosition(0, 60, 2);   // -59 (가장 뒤)
 * calcZPosition(30, 60, 2);  // 1
 * calcZPosition(59, 60, 2);  // 59 (가장 앞)
 */
export function calcZPosition(
  frameIndex: number,
  totalFrames: number,
  spacing: number
): number {
  const zHalf = calcHalf(totalFrames);
  return (frameIndex - zHalf) * spacing;
}

/**
 * 색상 데이터 인덱스 계산 (새 텍스처 레이아웃)
 * 
 * @description
 * Ring buffer 기반 색상 텍스처에서 특정 픽셀의 색상 데이터 인덱스를 계산합니다.
 * 텍스처 레이아웃: (width, height * frames)
 * RGBA 형식이므로 4를 곱합니다.
 * 
 * @param frameIndex - 프레임 인덱스
 * @param pixelIndex - 프레임 내 픽셀 인덱스 (y * width + x)
 * @param width - 텍스처 너비 (= 캡처 너비)
 * @param height - 단일 프레임 높이 (= 캡처 높이)
 * @returns 색상 데이터 배열의 시작 인덱스
 * 
 * @example
 * // 144x255 해상도에서 프레임 5, 픽셀 (10, 20)의 인덱스
 * calcColorDataIndex(5, 20 * 144 + 10, 144, 255);
 */
export function calcColorDataIndex(
  frameIndex: number,
  pixelIndex: number,
  width: number,
  height?: number
): number {
  // 하위 호환성: height가 없으면 기존 방식 사용 (pixelsPerFrame으로 해석)
  if (height === undefined) {
    // 기존 방식: (frameIndex * pixelsPerFrame + pixelIndex) * 4
    return (frameIndex * width + pixelIndex) * 4;
  }
  
  // 새 텍스처 레이아웃: (width, height * frames)
  // pixelIndex = y * width + x
  const x = pixelIndex % width;
  const y = Math.floor(pixelIndex / width);
  
  // 텍스처 좌표: (x, frameIndex * height + y)
  // 1D 인덱스: ((frameIndex * height + y) * width + x) * 4
  return ((frameIndex * height + y) * width + x) * 4;
}

/**
 * 총 포인트 수 계산
 * 
 * @description
 * 포인트 클라우드의 전체 포인트 개수를 계산합니다.
 * width × height × frames
 * 
 * @param width - 이미지 너비
 * @param height - 이미지 높이
 * @param frames - 프레임 수
 * @returns 총 포인트 수
 * 
 * @example
 * calcTotalPoints(128, 72, 60);  // 552,960
 */
export function calcTotalPoints(
  width: number,
  height: number,
  frames: number
): number {
  return width * height * frames;
}

/**
 * 픽셀 인덱스 계산
 * 
 * @description
 * 2D 픽셀 좌표를 1D 인덱스로 변환합니다.
 * 행 우선(row-major) 순서를 사용합니다.
 * 
 * @param x - X 좌표
 * @param y - Y 좌표
 * @param width - 이미지 너비
 * @returns 1D 픽셀 인덱스
 * 
 * @example
 * calcPixelIndex(10, 5, 128);  // 5 * 128 + 10 = 650
 */
export function calcPixelIndex(x: number, y: number, width: number): number {
  return y * width + x;
}


