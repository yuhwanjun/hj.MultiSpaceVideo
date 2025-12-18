/**
 * Point Cloud Vertex Shader
 * 
 * 포인트 클라우드의 위치, 색상, 마우스 인터랙션을 처리하는 버텍스 셰이더입니다.
 * 
 * 주요 기능:
 * 1. Ring Buffer 기반 프레임 위치 계산 - 시간순 정렬된 Z 위치 결정
 * 2. 텍스처 기반 색상 샘플링 - DataTexture에서 RGB 값 읽기
 * 3. 🔵 구 형태(Spherical) 마우스 인터랙션 - 3D 방사형 반발력, Fluid 효과
 * 4. 슬라이스 마스킹 - XYZ 범위 밖 포인트 제거
 * 5. 크기 감쇠 - 거리에 따른 포인트 크기 조절
 * 
 * 마우스 인터랙션 특징:
 * - 마우스 위치를 중심으로 한 3D 구 형태 영향 범위
 * - XYZ 모든 축으로 방사형 반발력 적용
 * - Simplex Noise 기반 3D 회전 왜곡으로 유체 느낌 구현
 */

import { VISUAL_CONFIG, MOUSE_CONFIG, JITTER_CONFIG } from "../config";

/**
 * Vertex Shader 소스 코드
 * 
 * Uniforms:
 * - uSize: 기본 포인트 크기
 * - uAttenuate: 크기 감쇠 활성화 여부
 * - uZScale: 프레임 간 Z축 간격 (spacing)
 * - uXRange, uYRange, uZRange: 슬라이스 범위 (vec2: min, max)
 * - uWriteIndex: Ring buffer의 현재 쓰기 위치
 * - uTotalFrames: 전체 프레임 수
 * - uPixelsPerFrame: 프레임당 픽셀 수 (width × height)
 * - uColorTex: 색상 데이터 텍스처 (DataTexture)
 * - uMouseEnabled: 마우스 효과 활성화 여부
 * - uMousePos: 마우스 3D 위치
 * - uMouseScreen: 마우스 스크린 좌표 (NDC)
 * - uMouseRadius: 마우스 영향 반경
 * - uMouseStrength: 마우스 반발 강도
 * - uTime: 경과 시간 (초) - 애니메이션용
 * 
 * Attributes:
 * - position: 기본 포인트 위치 (vec3)
 * - aFrameIndex: 포인트가 속한 프레임 인덱스
 * - aPixelIndex: 프레임 내 픽셀 인덱스
 * 
 * Varyings:
 * - vColor: Fragment shader로 전달되는 색상
 * - vMask: 슬라이스 마스킹 값 (0 또는 1)
 */
export const vertexShader = `
  // ============================================================================
  // Attributes - 각 포인트별 고유 데이터
  // ============================================================================
  attribute float aFrameIndex;  // 이 포인트가 속한 프레임 번호 (0 ~ totalFrames-1)
  attribute float aPixelIndex;  // 프레임 내 픽셀 위치 (0 ~ pixelsPerFrame-1)
  
  // ============================================================================
  // Uniforms - 전역 설정값
  // ============================================================================
  
  // 렌더링 설정
  uniform float uSize;           // 포인트 기본 크기
  uniform bool  uAttenuate;      // 거리에 따른 크기 감쇠 여부
  uniform float uZScale;         // Z축 스케일 (프레임 간 간격)
  
  // 슬라이스 범위 (x: min, y: max)
  uniform vec2  uXRange;         // X축 표시 범위
  uniform vec2  uYRange;         // Y축 표시 범위
  uniform vec2  uZRange;         // Z축 표시 범위
  
  // Ring Buffer 관련
  uniform float uWriteIndex;     // 현재 쓰기 위치 (가장 오래된 프레임)
  uniform float uTotalFrames;    // 전체 프레임 수
  uniform float uPixelsPerFrame; // 프레임당 픽셀 수
  
  // 텍스처 레이아웃: (width, height * frames)
  uniform float uTexWidth;       // 텍스처 너비 (= 캡처 너비)
  uniform float uTexHeight;      // 텍스처 높이 (= 캡처 높이, 단일 프레임)
  
  // 색상 텍스처
  uniform sampler2D uColorTex;   // 색상 데이터 (width=texWidth, height=texHeight*frames)
  
  // 마우스 인터랙션 설정
  uniform bool uMouseEnabled;    // 효과 활성화 여부
  uniform vec3 uMousePos;        // 마우스 3D 월드 좌표
  uniform vec2 uMouseScreen;     // 마우스 스크린 좌표 (NDC: -1~1)
  uniform float uMouseRadius;    // 영향 반경
  uniform float uMouseStrength;  // 반발 강도
  uniform float uTime;           // 경과 시간 (초)
  
  // 랜덤 움직임 (Jitter) 설정
  uniform bool uJitterEnabled;   // 랜덤 움직임 활성화 여부
  uniform float uJitterAmplitude; // 움직임 강도 (최대 거리)
  uniform float uJitterSpeed;    // 움직임 속도
  uniform float uJitterScale;    // 노이즈 공간 스케일
  
  // ============================================================================
  // Varyings - Fragment shader로 전달할 값
  // ============================================================================
  varying vec3 vColor;           // 포인트 색상 (RGB)
  varying float vMask;           // 슬라이스 마스크 (0: 숨김, 1: 표시)
  
  // ============================================================================
  // Simplex Noise 함수들
  // Fluid 효과를 위한 3D Simplex Noise 구현
  // 출처: https://github.com/ashima/webgl-noise
  // ============================================================================
  
  vec3 mod289(vec3 x) { 
    return x - floor(x * (1.0 / 289.0)) * 289.0; 
  }
  
  vec4 mod289(vec4 x) { 
    return x - floor(x * (1.0 / 289.0)) * 289.0; 
  }
  
  vec4 permute(vec4 x) { 
    return mod289(((x*34.0)+1.0)*x); 
  }
  
  vec4 taylorInvSqrt(vec4 r) { 
    return 1.79284291400159 - 0.85373472095314 * r; 
  }
  
  /**
   * 3D Simplex Noise
   * @param v - 3D 입력 좌표
   * @returns -1 ~ 1 사이의 노이즈 값
   */
  float snoise(vec3 v) {
    const vec2 C = vec2(1.0/6.0, 1.0/3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    
    // First corner
    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    
    // Other corners
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    
    // Permutations
    i = mod289(i);
    vec4 p = permute(permute(permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
      + i.y + vec4(0.0, i1.y, i2.y, 1.0))
      + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    
    // Gradients
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ *ns.x + ns.yyyy;
    vec4 y = y_ *ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0)*2.0 + 1.0;
    vec4 s1 = floor(b1)*2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    
    // Normalise gradients
    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
    p0 *= norm.x;
    p1 *= norm.y;
    p2 *= norm.z;
    p3 *= norm.w;
    
    // Mix final noise value
    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
  }
  
  // ============================================================================
  // Main Vertex Shader
  // ============================================================================
  void main() {
    // ------------------------------------------------------------------------
    // 1. Ring Buffer를 고려한 Z 위치 계산
    // ------------------------------------------------------------------------
    // Ring buffer에서 writeIndex는 가장 오래된 프레임을 가리킴
    // 따라서 프레임 순서를 재정렬하여 시간순으로 배치
    float adjustedFrame = mod(aFrameIndex - uWriteIndex + uTotalFrames, uTotalFrames);
    float zHalf = (uTotalFrames - 1.0) / 2.0;
    float zPos = (adjustedFrame - zHalf) * uZScale;
    
    // 기본 위치 설정
    vec3 pos = position;
    pos.z = zPos;
    
    // ------------------------------------------------------------------------
    // 2. 랜덤 움직임 (Jitter/Wiggle) 효과
    // ------------------------------------------------------------------------
    if (uJitterEnabled) {
      // 각 포인트별 고유한 시드값 생성 (위치 기반)
      vec3 seed = pos * uJitterScale;
      
      // 시간에 따라 변화하는 3D 노이즈 오프셋 계산
      // 각 축에 다른 오프셋을 주어 독립적인 움직임 생성
      float noiseX = snoise(vec3(seed.x, seed.y + 100.0, uTime * uJitterSpeed));
      float noiseY = snoise(vec3(seed.x + 200.0, seed.y, uTime * uJitterSpeed * 1.1));
      float noiseZ = snoise(vec3(seed.x + 300.0, seed.y + 400.0, uTime * uJitterSpeed * 0.9));
      
      // 노이즈 값 (-1~1)에 amplitude를 곱해서 최종 오프셋 계산
      pos.x += noiseX * uJitterAmplitude;
      pos.y += noiseY * uJitterAmplitude;
      pos.z += noiseZ * uJitterAmplitude * 0.5; // Z축은 절반 강도
    }
    
    // ------------------------------------------------------------------------
    // 3. 마우스 인터랙션 / Fluid 효과 (구 형태 - Spherical)
    // ------------------------------------------------------------------------
    if (uMouseEnabled) {
      // 마우스와의 3D 거리 계산 (구 형태 영향 범위)
      vec3 diff3D = pos - uMousePos;
      float dist = length(diff3D);
      
      // 영향 반경 내의 포인트들에만 효과 적용 (구 형태)
      if (dist < uMouseRadius && dist > 0.001) {
        // Smoothstep으로 부드러운 감쇠 곡선 생성
        float falloff = 1.0 - smoothstep(0.0, uMouseRadius, dist);
        falloff = falloff * falloff; // 더 급격한 감쇠를 위해 제곱
        
        // 3D 반발 방향 계산 (마우스 중심에서 방사형으로 멀어지는 방향)
        vec3 repelDir3D = normalize(diff3D);
        
        // Simplex Noise로 Fluid 느낌 추가
        float noiseScale = ${MOUSE_CONFIG.NOISE_SCALE};
        float noise = snoise(vec3(pos * noiseScale + uTime * ${MOUSE_CONFIG.NOISE_TIME_SPEED}));
        
        // 3D 반발력 적용 (구 형태로 밀어냄)
        float repelAmount = uMouseStrength * falloff;
        vec3 repelOffset = repelDir3D * repelAmount;
        
        // 노이즈 기반 3D 회전/왜곡 효과 (Fluid feel)
        float angleXY = noise * 0.5 * falloff;
        float angleXZ = noise * 0.3 * falloff;
        
        // XY 평면 회전
        float cosXY = cos(angleXY);
        float sinXY = sin(angleXY);
        vec3 rotated = diff3D;
        rotated.x = diff3D.x * cosXY - diff3D.y * sinXY;
        rotated.y = diff3D.x * sinXY + diff3D.y * cosXY;
        
        // XZ 평면 회전 (추가적인 3D 왜곡)
        float cosXZ = cos(angleXZ);
        float sinXZ = sin(angleXZ);
        float tempX = rotated.x;
        rotated.x = tempX * cosXZ - rotated.z * sinXZ;
        rotated.z = tempX * sinXZ + rotated.z * cosXZ;
        
        // 최종 위치 = 마우스 위치 + 회전된 차이 벡터 + 반발력
        pos = uMousePos + rotated + repelOffset;
      }
    }
    
    // ------------------------------------------------------------------------
    // 3. 텍스처에서 색상 읽기
    // ------------------------------------------------------------------------
    // 새로운 텍스처 레이아웃: (width, height * frames)
    // aPixelIndex = y * width + x 형태로 저장됨
    float pixelX = mod(aPixelIndex, uTexWidth);
    float pixelY = floor(aPixelIndex / uTexWidth);
    
    // UV 좌표 계산 (0.5 오프셋으로 텍셀 중앙 샘플링)
    float texU = (pixelX + 0.5) / uTexWidth;
    float texV = (aFrameIndex * uTexHeight + pixelY + 0.5) / (uTexHeight * uTotalFrames);
    vec4 texColor = texture2D(uColorTex, vec2(texU, texV));
    vColor = texColor.rgb;
    
    // ------------------------------------------------------------------------
    // 4. 슬라이스 마스킹
    // ------------------------------------------------------------------------
    // 효과 적용 전 원래 위치 기준으로 마스킹 체크
    vec3 originalPos = position;
    originalPos.z = zPos;
    
    // step 함수로 범위 체크 (범위 내면 1, 아니면 0)
    float inside = step(uXRange.x, originalPos.x) * step(originalPos.x, uXRange.y)
                 * step(uYRange.x, originalPos.y) * step(originalPos.y, uYRange.y)
                 * step(uZRange.x, originalPos.z) * step(originalPos.z, uZRange.y);
    vMask = inside;
    
    // ------------------------------------------------------------------------
    // 5. 최종 위치 및 크기 계산
    // ------------------------------------------------------------------------
    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    
    // 포인트 크기 계산
    float size = uSize;
    if (uAttenuate) {
      // 거리에 따른 크기 감쇠 (원근감)
      size = uSize * (${VISUAL_CONFIG.SIZE_ATTENUATION_FACTOR}.0 / -mvPosition.z);
    }
    gl_PointSize = size;
  }
`;

export default vertexShader;

