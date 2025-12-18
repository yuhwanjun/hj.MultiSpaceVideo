/**
 * Point Cloud 페이지 설정 파일
 * 
 * 이 파일은 포인트 클라우드 시각화의 모든 조정 가능한 설정값을 관리합니다.
 * 각 설정은 기본값과 범위를 정의하며, UI 슬라이더와 연동됩니다.
 */

// ============================================================================
// 샘플링 설정 (Sampling Configuration)
// 웹캠에서 캡처하는 영상의 해상도와 프레임 수를 결정합니다.
// ============================================================================
export const SAMPLING_CONFIG = {
  /**
   * 캡처 너비 (픽셀)
   * - 높을수록 더 세밀한 포인트 클라우드 생성
   * - 성능에 직접적인 영향 (포인트 수 = width × height × frames)
   * @default 128
   * @range 8 ~ 512 (8 단위)
   */
  DEFAULT_WIDTH: 144,
  MIN_WIDTH: 8,
  STEP_WIDTH: 8,

  /**
   * 캡처 높이 (픽셀)
   * - 16:9 비율 권장 (예: 128×72, 256×144)
   * @default 72
   * @range 8 ~ 512 (8 단위)
   */
  DEFAULT_HEIGHT: 255,
  MIN_HEIGHT: 8,
  STEP_HEIGHT: 8,

  /**
   * 저장할 프레임 수 (시간 축 깊이)
   * - 높을수록 더 긴 시간의 데이터를 볼륨으로 표현
   * - 메모리 사용량에 영향
   * @default 60
   * @range 2 ~ 300
   */
  DEFAULT_FRAMES: 60,
  MIN_FRAMES: 2,
  STEP_FRAMES: 1,
} as const;

// ============================================================================
// 시각적 설정 (Visual Configuration)
// 포인트 클라우드의 렌더링 스타일을 결정합니다.
// ============================================================================
export const VISUAL_CONFIG = {
  /**
   * 프레임 간 Z축 간격 (Spacing)
   * - 값이 클수록 볼륨이 깊어지고 프레임 간 간격이 넓어짐
   * - 값이 작으면 납작하게 보임
   * @default 2
   * @range 0.1 ~ 10 (0.1 단위)
   */
  DEFAULT_SPACING: 2,
  MIN_SPACING: 0.1,
  MAX_SPACING: 10,
  STEP_SPACING: 0.1,

  /**
   * 포인트 크기 (Point Size)
   * - 각 점의 화면상 크기
   * - sizeAttenuation이 true면 거리에 따라 자동 조절됨
   * @default 0.8
   * @range 0.1 ~ 20 (0.1 단위)
   */
  DEFAULT_POINT_SIZE: 0.8,
  MIN_POINT_SIZE: 0.1,
  MAX_POINT_SIZE: 20,
  STEP_POINT_SIZE: 0.1,

  /**
   * 불투명도 (Opacity)
   * - 1.0이면 완전 불투명, 0에 가까울수록 투명
   * - 투명도 사용 시 렌더링 순서 이슈가 발생할 수 있음
   * @default 1.0
   * @range 0.05 ~ 1.0 (0.05 단위)
   */
  DEFAULT_OPACITY: 1.0,
  MIN_OPACITY: 0.05,
  MAX_OPACITY: 1.0,
  STEP_OPACITY: 0.05,

  /**
   * 크기 감쇠 (Size Attenuation)
   * - true: 카메라에서 멀수록 점이 작아짐 (원근감)
   * - false: 모든 점이 동일한 크기
   * @default true
   */
  DEFAULT_SIZE_ATTENUATION: true,

  /**
   * 크기 감쇠 기준 거리
   * - sizeAttenuation 계산에 사용되는 기준 거리
   * @default 300
   */
  SIZE_ATTENUATION_FACTOR: 300,
} as const;

// ============================================================================
// 마우스 인터랙션 설정 (Mouse Interaction Configuration)
// 마우스에 의한 포인트 반발/Fluid 효과를 제어합니다.
// 
// 🔵 구 형태 (Spherical) 인터랙션:
// - 마우스 위치를 중심으로 한 3D 구 형태의 영향 범위
// - XYZ 모든 방향으로 방사형 반발력 적용
// - 기존 원기둥(Cylinder) 형태와 달리 Z축 깊이도 고려
// ============================================================================
export const MOUSE_CONFIG = {
  /**
   * 마우스 효과 활성화 여부
   * - true: 마우스 근처 포인트들이 구 형태로 밀려남
   * @default true
   */
  DEFAULT_ENABLED: true,

  /**
   * 마우스 영향 반경 (구의 반지름)
   * - 마우스 위치를 중심으로 이 반경 내의 3D 공간에 있는 포인트들에 효과 적용
   * - 값이 클수록 더 넓은 구 형태 영역에 영향
   * - 3D 거리 기준: sqrt(dx² + dy² + dz²) < radius
   * @default 50
   * @range 10 ~ 200 (5 단위)
   */
  DEFAULT_RADIUS: 50,
  MIN_RADIUS: 10,
  MAX_RADIUS: 200,
  STEP_RADIUS: 5,

  /**
   * 마우스 반발 강도
   * - 포인트가 마우스 중심에서 방사형으로 밀려나는 힘의 세기
   * - 값이 클수록 더 멀리 밀려남
   * - 3D 방향 벡터를 따라 균일하게 적용됨
   * @default 30
   * @range 5 ~ 100 (1 단위)
   */
  DEFAULT_STRENGTH: 30,
  MIN_STRENGTH: 5,
  MAX_STRENGTH: 100,
  STEP_STRENGTH: 1,

  /**
   * Fluid 노이즈 스케일
   * - Simplex 노이즈의 공간 주파수
   * - 값이 작을수록 더 부드러운 흐름
   * - 3D 좌표를 입력으로 사용하여 입체적인 왜곡 생성
   * @default 0.05
   */
  NOISE_SCALE: 0.05,

  /**
   * Fluid 노이즈 시간 속도
   * - 노이즈 애니메이션 속도
   * - 시간에 따라 유체처럼 흐르는 효과 생성
   * @default 0.5
   */
  NOISE_TIME_SPEED: 0.5,
} as const;

// ============================================================================
// 랜덤 움직임 설정 (Jitter/Wiggle Configuration)
// 각 포인트가 개별적으로 랜덤하게 움직이는 효과를 제어합니다.
// Simplex Noise 기반으로 자연스럽고 유기적인 움직임을 생성합니다.
// ============================================================================
export const JITTER_CONFIG = {
  /**
   * 랜덤 움직임 활성화 여부
   * - true: 각 포인트가 노이즈 기반으로 움직임
   * @default false
   */
  DEFAULT_ENABLED: false,

  /**
   * 움직임 강도 (Amplitude)
   * - 포인트가 원래 위치에서 벗어나는 최대 거리
   * - 값이 클수록 더 큰 움직임
   * @default 2.0
   * @range 0.1 ~ 20 (0.1 단위)
   */
  DEFAULT_AMPLITUDE: 2.0,
  MIN_AMPLITUDE: 0.1,
  MAX_AMPLITUDE: 20,
  STEP_AMPLITUDE: 0.1,

  /**
   * 움직임 속도 (Speed)
   * - 노이즈 애니메이션 속도
   * - 값이 클수록 더 빠르게 움직임
   * @default 1.0
   * @range 0.1 ~ 5 (0.1 단위)
   */
  DEFAULT_SPEED: 1.0,
  MIN_SPEED: 0.1,
  MAX_SPEED: 5,
  STEP_SPEED: 0.1,

  /**
   * 노이즈 스케일 (Frequency)
   * - 공간적 주파수 - 값이 작을수록 더 부드럽고 큰 패턴
   * - 값이 클수록 더 세밀하고 개별적인 움직임
   * @default 0.1
   * @range 0.01 ~ 1 (0.01 단위)
   */
  DEFAULT_SCALE: 0.1,
  MIN_SCALE: 0.01,
  MAX_SCALE: 1,
  STEP_SCALE: 0.01,
} as const;

// ============================================================================
// 카메라 설정 (Camera Configuration)
// Three.js 카메라의 초기 설정값입니다.
// ============================================================================
export const CAMERA_CONFIG = {
  /**
   * 시야각 (Field of View)
   * - 값이 클수록 넓은 시야
   * @default 50
   */
  FOV: 50,

  /**
   * 가까운 클리핑 평면
   * - 이 거리보다 가까운 객체는 렌더링되지 않음
   * @default 0.1
   */
  NEAR: 0.1,

  /**
   * 먼 클리핑 평면
   * - 이 거리보다 먼 객체는 렌더링되지 않음
   * @default 2000
   */
  FAR: 2000,

  /**
   * 초기 카메라 Z 위치
   * - 포인트 클라우드로부터의 초기 거리
   * @default 180
   */
  INITIAL_Z: 180,

  /**
   * 자동 회전 활성화 여부
   * @default false
   */
  DEFAULT_AUTO_ROTATE: false,

  /**
   * 자동 회전 속도
   * - 양수: 시계 방향, 음수: 반시계 방향
   * - 값이 클수록 빠르게 회전
   * @default 1.0
   * @range 0.1 ~ 10 (0.1 단위)
   */
  DEFAULT_AUTO_ROTATE_SPEED: 1.0,
  MIN_AUTO_ROTATE_SPEED: 0.1,
  MAX_AUTO_ROTATE_SPEED: 10,
  STEP_AUTO_ROTATE_SPEED: 0.1,
} as const;

// ============================================================================
// 렌더러 설정 (Renderer Configuration)
// Three.js WebGL 렌더러 설정입니다.
// ============================================================================
export const RENDERER_CONFIG = {
  /**
   * 안티앨리어싱 활성화
   * - true: 부드러운 가장자리 (성능 영향)
   * @default true
   */
  ANTIALIAS: true,

  /**
   * 드로잉 버퍼 보존
   * - true: 캔버스 스크린샷 캡처 가능
   * @default true
   */
  PRESERVE_DRAWING_BUFFER: true,

  /**
   * 최대 픽셀 비율
   * - 레티나 디스플레이 등에서 성능과 품질 균형
   * @default 2
   */
  MAX_PIXEL_RATIO: 2,

  /**
   * 배경색
   * - 씬의 배경색 (hex)
   * @default 0x111111
   */
  BACKGROUND_COLOR: 0x111111,
} as const;

// ============================================================================
// 슬라이스 설정 (Slice Configuration)
// XYZ 축 슬라이싱의 초기값입니다.
// ============================================================================
export const SLICE_CONFIG = {
  /**
   * X축 슬라이스 기본 범위
   * - 실제 범위는 샘플링 해상도에 따라 동적으로 결정됨
   * - 144px 너비 기준: (144-1)/2 ≈ 72
   */
  DEFAULT_X_MIN: -72 as number,
  DEFAULT_X_MAX: 72 as number,

  /**
   * Y축 슬라이스 기본 범위
   * - 255px 높이 기준: (255-1)/2 ≈ 127
   */
  DEFAULT_Y_MIN: -127 as number,
  DEFAULT_Y_MAX: 127 as number,

  /**
   * Z축 슬라이스 기본 범위
   * - spacing을 곱한 값으로 표시됨
   */
  DEFAULT_Z_MIN: -60 as number,
  DEFAULT_Z_MAX: 60 as number,

  /**
   * Z 슬라이스 조절 단위
   */
  Z_STEP: 0.5,
};

// ============================================================================
// PLY 내보내기 설정 (PLY Export Configuration)
// 포인트 클라우드 파일 저장 관련 설정입니다.
// ============================================================================
export const PLY_EXPORT_CONFIG = {
  /**
   * 기본 ASCII PLY 파일명
   */
  DEFAULT_ASCII_FILENAME: "pointcloud.ply",

  /**
   * 기본 Binary PLY 파일명
   */
  DEFAULT_BINARY_FILENAME: "pointcloud_binary.ply",

  /**
   * 기본 스크린샷 파일명
   */
  DEFAULT_SCREENSHOT_FILENAME: "screenshot.png",

  /**
   * PLY 포인트당 바이트 수 (Binary)
   * - 3 floats (x,y,z) = 12 bytes + 3 bytes (RGB) = 15 bytes
   */
  BYTES_PER_POINT: 15,
} as const;

// ============================================================================
// 타입 정의 (Type Definitions)
// 설정값들의 타입을 정의합니다.
// ============================================================================

/** 샘플링 설정 타입 */
export interface SamplingSettings {
  width: number;
  height: number;
  frames: number;
}

/** 시각적 설정 타입 */
export interface VisualSettings {
  spacing: number;
  pointSize: number;
  opacity: number;
  sizeAttenuation: boolean;
}

/** 마우스 인터랙션 설정 타입 */
export interface MouseSettings {
  enabled: boolean;
  radius: number;
  strength: number;
}

/** 슬라이스 범위 타입 */
export interface SliceRange {
  min: number;
  max: number;
}

/** 전체 슬라이스 설정 타입 */
export interface SliceSettings {
  x: SliceRange;
  y: SliceRange;
  z: SliceRange;
}

// ============================================================================
// 기본값 객체 (Default Values)
// 컴포넌트에서 쉽게 사용할 수 있는 기본값 객체입니다.
// ============================================================================

/** 기본 샘플링 설정 */
export const DEFAULT_SAMPLING: SamplingSettings = {
  width: SAMPLING_CONFIG.DEFAULT_WIDTH,
  height: SAMPLING_CONFIG.DEFAULT_HEIGHT,
  frames: SAMPLING_CONFIG.DEFAULT_FRAMES,
};

/** 기본 시각적 설정 */
export const DEFAULT_VISUAL: VisualSettings = {
  spacing: VISUAL_CONFIG.DEFAULT_SPACING,
  pointSize: VISUAL_CONFIG.DEFAULT_POINT_SIZE,
  opacity: VISUAL_CONFIG.DEFAULT_OPACITY,
  sizeAttenuation: VISUAL_CONFIG.DEFAULT_SIZE_ATTENUATION,
};

/** 기본 마우스 설정 */
export const DEFAULT_MOUSE: MouseSettings = {
  enabled: MOUSE_CONFIG.DEFAULT_ENABLED,
  radius: MOUSE_CONFIG.DEFAULT_RADIUS,
  strength: MOUSE_CONFIG.DEFAULT_STRENGTH,
};

/** 기본 슬라이스 설정 */
export const DEFAULT_SLICE: SliceSettings = {
  x: { min: SLICE_CONFIG.DEFAULT_X_MIN, max: SLICE_CONFIG.DEFAULT_X_MAX },
  y: { min: SLICE_CONFIG.DEFAULT_Y_MIN, max: SLICE_CONFIG.DEFAULT_Y_MAX },
  z: { min: SLICE_CONFIG.DEFAULT_Z_MIN, max: SLICE_CONFIG.DEFAULT_Z_MAX },
};

