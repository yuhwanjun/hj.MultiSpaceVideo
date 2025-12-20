"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/**
 * Sparse Surface Mode - 초고해상도 라이브 포인트 클라우드
 * 
 * 720×1080×720 해상도를 16MB 텍스처로 구현!
 * 
 * 텍스처 레이아웃 (4096×2048):
 * ┌─────────────┬─────────────┬─────────────┬─────────────┐
 * │ Front Face  │ Back Face   │ Left Edges  │ Right Edges │  Y: 0-1079
 * │ (720×1080)  │ (720×1080)  │ (720×1080)  │ (720×1080)  │
 * ├─────────────┼─────────────┼─────────────┴─────────────┤
 * │ Top Edges   │ Bottom Edges│        (unused)           │  Y: 1080-1799
 * │ (720×720)   │ (720×720)   │                           │
 * └─────────────┴─────────────┴───────────────────────────┘
 * 
 * - Front/Back: 전체 프레임 (newest/oldest)
 * - Left/Right: X=frame, Y=pixel (세로 엣지)
 * - Top/Bottom: X=pixel, Y=frame (가로 엣지)
 */

// ============================================================================
// 설정값
// ============================================================================
const CONFIG = {
  // 고해상도 기본값 (720×1080×720)
  DEFAULT_WIDTH: 720,
  DEFAULT_HEIGHT: 1080,
  DEFAULT_FRAMES: 720,

  // 시각
  DEFAULT_SPACING: 1,
  DEFAULT_POINT_SIZE: 20,

  // 카메라
  FOV: 50,
  NEAR: 0.1,
  FAR: 10000,
  INITIAL_Z: 1200,

  // 자동 회전
  DEFAULT_AUTO_ROTATE: true,
  DEFAULT_AUTO_ROTATE_SPEED: 0.3,

  // 텍스처 (최대 720×1080×720 지원)
  TEX_WIDTH: 4096,
  TEX_HEIGHT: 2048,
};

// ============================================================================
// 텍스처 영역 정의
// ============================================================================
interface TextureRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

function getTextureRegions(width: number, height: number, frames: number) {
  return {
    // 전체 프레임 영역 (Front/Back)
    front: { x: 0, y: 0, width, height },
    back: { x: width, y: 0, width, height },
    // 세로 엣지 (Left/Right) - X=frame, Y=pixel
    left: { x: width * 2, y: 0, width: frames, height },
    right: { x: width * 2 + frames, y: 0, width: frames, height },
    // 가로 엣지 (Top/Bottom) - X=pixel, Y=frame
    top: { x: 0, y: height, width, height: frames },
    bottom: { x: width, y: height, width, height: frames },
  };
}

/**
 * 텍스처 크기 검증
 */
function validateTextureSize(
  width: number,
  height: number,
  frames: number
): { valid: boolean; requiredWidth: number; requiredHeight: number; message: string } {
  // 필요한 크기 계산
  // Row 0-height: front(width) + back(width) + left(frames) + right(frames)
  // Row height-height+frames: top(width) + bottom(width)
  const requiredWidth = Math.max(width * 2 + frames * 2, width * 2);
  const requiredHeight = height + frames;

  const valid = requiredWidth <= CONFIG.TEX_WIDTH && requiredHeight <= CONFIG.TEX_HEIGHT;

  let message = "";
  if (!valid) {
    message = `텍스처 크기 초과! 필요: ${requiredWidth}×${requiredHeight}, 최대: ${CONFIG.TEX_WIDTH}×${CONFIG.TEX_HEIGHT}`;
  }

  return { valid, requiredWidth, requiredHeight, message };
}

/**
 * 최대 지원 해상도 계산
 */
function getMaxResolution(): { maxWidth: number; maxHeight: number; maxFrames: number } {
  // 제약 조건:
  // 1. width * 2 + frames * 2 <= TEX_WIDTH  => width + frames <= TEX_WIDTH / 2
  // 2. height + frames <= TEX_HEIGHT
  // 3. 실용적인 범위 내에서 최대화

  // 720×1080×720의 경우:
  // width * 2 + frames * 2 = 720*2 + 720*2 = 2880 <= 4096 ✓
  // height + frames = 1080 + 720 = 1800 <= 2048 ✓

  return {
    maxWidth: 720,
    maxHeight: 1080,
    maxFrames: 720,
  };
}

/**
 * 표면 포인트 인덱스 생성
 * 각 포인트에 어느 면에 속하는지 정보 포함
 */
type FaceType = "front" | "back" | "top" | "bottom" | "left" | "right";

interface SurfacePoint {
  logicalFrame: number;
  pixelX: number;
  pixelY: number;
  x: number;
  y: number;
  z: number;
  face: FaceType;
}

function generateSurfacePoints(
  width: number,
  height: number,
  frames: number
): SurfacePoint[] {
  const points: SurfacePoint[] = [];
  const xHalf = (width - 1) / 2;
  const yHalf = (height - 1) / 2;
  const zHalf = (frames - 1) / 2;

  // 뒷면 (logicalFrame = 0, oldest)
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      points.push({
        logicalFrame: 0,
        pixelX: px,
        pixelY: py,
        x: px - xHalf,
        y: yHalf - py,
        z: 0 - zHalf,
        face: "back",
      });
    }
  }

  // 앞면 (logicalFrame = frames-1, newest)
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      points.push({
        logicalFrame: frames - 1,
        pixelX: px,
        pixelY: py,
        x: px - xHalf,
        y: yHalf - py,
        z: (frames - 1) - zHalf,
        face: "front",
      });
    }
  }

  // 상단 엣지 (y=0, frames 1 to frames-2)
  for (let f = 1; f < frames - 1; f++) {
    const py = 0;
    for (let px = 0; px < width; px++) {
      points.push({
        logicalFrame: f,
        pixelX: px,
        pixelY: py,
        x: px - xHalf,
        y: yHalf - py,
        z: f - zHalf,
        face: "top",
      });
    }
  }

  // 하단 엣지 (y=height-1, frames 1 to frames-2)
  for (let f = 1; f < frames - 1; f++) {
    const py = height - 1;
    for (let px = 0; px < width; px++) {
      points.push({
        logicalFrame: f,
        pixelX: px,
        pixelY: py,
        x: px - xHalf,
        y: yHalf - py,
        z: f - zHalf,
        face: "bottom",
      });
    }
  }

  // 좌측 엣지 (x=0, y=1 to height-2, frames 1 to frames-2)
  for (let f = 1; f < frames - 1; f++) {
    const px = 0;
    for (let py = 1; py < height - 1; py++) {
      points.push({
        logicalFrame: f,
        pixelX: px,
        pixelY: py,
        x: px - xHalf,
        y: yHalf - py,
        z: f - zHalf,
        face: "left",
      });
    }
  }

  // 우측 엣지 (x=width-1, y=1 to height-2, frames 1 to frames-2)
  for (let f = 1; f < frames - 1; f++) {
    const px = width - 1;
    for (let py = 1; py < height - 1; py++) {
      points.push({
        logicalFrame: f,
        pixelX: px,
        pixelY: py,
        x: px - xHalf,
        y: yHalf - py,
        z: f - zHalf,
        face: "right",
      });
    }
  }

  return points;
}

// ============================================================================
// 셰이더 (Sparse Surface Texture)
// ============================================================================
const vertexShader = `
  // 포인트 속성
  attribute float aLogicalFrame;
  attribute float aPixelX;
  attribute float aPixelY;
  attribute float aFaceType;  // 0=front, 1=back, 2=top, 3=bottom, 4=left, 5=right

  // Uniforms
  uniform float uSize;
  uniform float uZScale;
  uniform float uWriteIndex;
  uniform float uTotalFrames;
  uniform float uFrameWidth;
  uniform float uFrameHeight;
  uniform float uTexWidth;
  uniform float uTexHeight;
  
  // 텍스처 영역 오프셋
  uniform vec2 uFrontOffset;   // (0, 0)
  uniform vec2 uBackOffset;    // (width, 0)
  uniform vec2 uLeftOffset;    // (width*2, 0)
  uniform vec2 uRightOffset;   // (width*2+frames, 0)
  uniform vec2 uTopOffset;     // (0, height)
  uniform vec2 uBottomOffset;  // (width, height)
  
  uniform sampler2D uColorTex;
  
  varying vec3 vColor;
  
  void main() {
    // Z 위치 계산 (논리적 프레임 기준)
    float zHalf = (uTotalFrames - 1.0) / 2.0;
    float zPos = (aLogicalFrame - zHalf) * uZScale;
    
    vec3 pos = position;
    pos.z = zPos;
    
    // 논리적 프레임 → 물리적 프레임 변환 (Ring Buffer)
    float physicalFrame = mod(uWriteIndex + aLogicalFrame, uTotalFrames);
    
    // 텍스처 좌표 계산 (면 타입에 따라 다름)
    // WebGL1 호환성을 위해 float 비교 사용
    vec2 texCoord;
    
    if (aFaceType < 0.5) {
      // Front face (0): 최신 프레임 전체
      texCoord = (uFrontOffset + vec2(aPixelX, aPixelY) + 0.5) / vec2(uTexWidth, uTexHeight);
    }
    else if (aFaceType < 1.5) {
      // Back face (1): 가장 오래된 프레임 전체
      texCoord = (uBackOffset + vec2(aPixelX, aPixelY) + 0.5) / vec2(uTexWidth, uTexHeight);
    }
    else if (aFaceType < 2.5) {
      // Top edge (2): X=pixel, Y=physicalFrame
      texCoord = (uTopOffset + vec2(aPixelX, physicalFrame) + 0.5) / vec2(uTexWidth, uTexHeight);
    }
    else if (aFaceType < 3.5) {
      // Bottom edge (3): X=pixel, Y=physicalFrame
      texCoord = (uBottomOffset + vec2(aPixelX, physicalFrame) + 0.5) / vec2(uTexWidth, uTexHeight);
    }
    else if (aFaceType < 4.5) {
      // Left edge (4): X=physicalFrame, Y=pixel
      texCoord = (uLeftOffset + vec2(physicalFrame, aPixelY) + 0.5) / vec2(uTexWidth, uTexHeight);
    }
    else {
      // Right edge (5): X=physicalFrame, Y=pixel
      texCoord = (uRightOffset + vec2(physicalFrame, aPixelY) + 0.5) / vec2(uTexWidth, uTexHeight);
    }
    
    vec4 texColor = texture2D(uColorTex, texCoord);
    vColor = texColor.rgb;
    
    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = uSize * (300.0 / max(1.0, abs(mvPosition.z)));
  }
`;

const fragmentShader = `
  precision mediump float;
  varying vec3 vColor;
  
  void main() {
    gl_FragColor = vec4(vColor, 1.0);
  }
`;

// ============================================================================
// Face Type 인코딩
// ============================================================================
function faceTypeToNumber(face: FaceType): number {
  switch (face) {
    case "front": return 0;
    case "back": return 1;
    case "top": return 2;
    case "bottom": return 3;
    case "left": return 4;
    case "right": return 5;
  }
}

// ============================================================================
// 메인 컴포넌트
// ============================================================================
export default function SparseSurfacePage() {
  // Refs
  const mountRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const pointsRef = useRef<THREE.Points | null>(null);
  const materialRef = useRef<THREE.ShaderMaterial | null>(null);

  const hiddenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const colorTextureRef = useRef<THREE.DataTexture | null>(null);
  const colorDataRef = useRef<Uint8Array | null>(null);
  const writeIndexRef = useRef<number>(0);
  const regionsRef = useRef<ReturnType<typeof getTextureRegions> | null>(null);
  
  // 현재 활성화된 dimensions (클로저 문제 방지)
  const activeDimensionsRef = useRef<{ w: number; h: number; frames: number }>({
    w: CONFIG.DEFAULT_WIDTH,
    h: CONFIG.DEFAULT_HEIGHT,
    frames: CONFIG.DEFAULT_FRAMES,
  });

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const rafRef = useRef<number | null>(null);
  const rvfcRef = useRef<number | null>(null);
  const capturingRef = useRef<boolean>(false);
  const frameCountRef = useRef<number>(0);

  // 커스텀 자동 회전을 위한 refs
  const customRotationTimeRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);

  // State
  const [status, setStatus] = useState<string>("라이브 시작 버튼을 눌러주세요.");
  const [isCapturing, setIsCapturing] = useState<boolean>(false);
  const [showUI, setShowUI] = useState<boolean>(true);

  const [targetW, setTargetW] = useState<number>(CONFIG.DEFAULT_WIDTH);
  const [targetH, setTargetH] = useState<number>(CONFIG.DEFAULT_HEIGHT);
  const [targetFrames, setTargetFrames] = useState<number>(CONFIG.DEFAULT_FRAMES);

  const [spacing, setSpacing] = useState<number>(CONFIG.DEFAULT_SPACING);
  const [pointSize, setPointSize] = useState<number>(CONFIG.DEFAULT_POINT_SIZE);

  const [autoRotate, setAutoRotate] = useState<boolean>(CONFIG.DEFAULT_AUTO_ROTATE);
  const [autoRotateSpeed, setAutoRotateSpeed] = useState<number>(CONFIG.DEFAULT_AUTO_ROTATE_SPEED);

  const hasRVFC = useMemo(
    () =>
      typeof HTMLVideoElement !== "undefined" &&
      "requestVideoFrameCallback" in HTMLVideoElement.prototype,
    []
  );

  // 텍스처 검증
  const validation = useMemo(() => {
    return validateTextureSize(targetW, targetH, targetFrames);
  }, [targetW, targetH, targetFrames]);

  // 포인트 수 계산
  const surfacePointCount = useMemo(() => {
    const frontBack = 2 * targetW * targetH;
    const topBottom = 2 * targetW * Math.max(0, targetFrames - 2);
    const leftRight = 2 * Math.max(0, targetH - 2) * Math.max(0, targetFrames - 2);
    return frontBack + topBottom + leftRight;
  }, [targetW, targetH, targetFrames]);

  const fullVolumeCount = useMemo(
    () => targetW * targetH * targetFrames,
    [targetW, targetH, targetFrames]
  );

  // 메모리 계산
  const memoryUsage = useMemo(() => {
    const sparseBytes = CONFIG.TEX_WIDTH * CONFIG.TEX_HEIGHT * 4;
    const fullBytes = targetW * targetH * targetFrames * 4;
    return {
      sparse: (sparseBytes / 1024 / 1024).toFixed(1),
      full: (fullBytes / 1024 / 1024).toFixed(1),
      savings: ((1 - sparseBytes / fullBytes) * 100).toFixed(1),
    };
  }, [targetW, targetH, targetFrames]);

  // Three.js 초기화
  useEffect(() => {
    if (!mountRef.current) return;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mountRef.current.clientWidth, mountRef.current.clientHeight);
    mountRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0a);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(
      CONFIG.FOV,
      mountRef.current.clientWidth / mountRef.current.clientHeight,
      CONFIG.NEAR,
      CONFIG.FAR
    );
    // 초기 카메라 위치: 원형 회전 시작점 (angle=0, 정면 약간 아래)
    const initRadius = CONFIG.INITIAL_Z * 1.8;
    const initTheta = 0; // sin(0) = 0
    const initPhi = Math.PI * 0.5 + Math.PI * 0.15; // phiCenter + phiAmplitude
    const initX = initRadius * Math.sin(initPhi) * Math.sin(initTheta);
    const initY = initRadius * Math.cos(initPhi);
    const initZ = initRadius * Math.sin(initPhi) * Math.cos(initTheta);
    camera.position.set(initX, initY, initZ);
    camera.lookAt(0, 0, 0);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.autoRotate = false; // 기본 autoRotate 비활성화 (커스텀 사용)
    // 회전 제한: 뒷면이 보이지 않도록 수평 회전을 -90도 ~ +90도로 제한
    controls.minAzimuthAngle = -Math.PI / 2;
    controls.maxAzimuthAngle = Math.PI / 2;
    // 수직 회전 제한
    controls.minPolarAngle = Math.PI * 0.2; // 위쪽 제한
    controls.maxPolarAngle = Math.PI * 0.8; // 아래쪽 제한
    (controls as any)._customAutoRotate = autoRotate; // 초기 상태 설정
    controlsRef.current = controls;

    // 원형 회전 설정
    const thetaAmplitude = Math.PI / 4;  // 좌우 회전 범위 (-45° ~ +45°)
    const phiCenter = Math.PI * 0.5;     // 수직 중심 (정면)
    const phiAmplitude = Math.PI * 0.15; // 상하 회전 범위
    const cameraRadius = CONFIG.INITIAL_Z * 1.8; // 카메라 거리

    const onResize = () => {
      if (!rendererRef.current || !cameraRef.current || !mountRef.current) return;
      const w = mountRef.current.clientWidth;
      const h = mountRef.current.clientHeight;
      rendererRef.current.setSize(w, h);
      cameraRef.current.aspect = w / h;
      cameraRef.current.updateProjectionMatrix();
    };
    window.addEventListener("resize", onResize);

    let raf = 0;
    const loop = (currentTime: number) => {
      raf = requestAnimationFrame(loop);
      
      // 커스텀 자동 회전
      if (controlsRef.current && cameraRef.current) {
        const ctrl = controlsRef.current;
        const cam = cameraRef.current;
        
        if (lastTimeRef.current === 0) {
          lastTimeRef.current = currentTime;
        }
        
        const deltaTime = (currentTime - lastTimeRef.current) / 1000;
        lastTimeRef.current = currentTime;
        
        if ((ctrl as any)._customAutoRotate) {
          customRotationTimeRef.current += deltaTime;
          
          // 부드러운 원형 회전: sin/cos로 원을 그리듯 이동
          // autoRotateSpeed로 한 바퀴 도는 시간 조절 (기본 0.3 -> 약 20초)
          const cycleTime = 2 * Math.PI / (ctrl.autoRotateSpeed || 0.3);
          const angle = (customRotationTimeRef.current / cycleTime) * 2 * Math.PI;
          
          // theta: 좌우 회전 (sin)
          // phi: 상하 회전 (cos) - sin과 위상차를 두어 원형 경로 생성
          const theta = thetaAmplitude * Math.sin(angle);
          const phi = phiCenter + phiAmplitude * Math.cos(angle);
          
          // 구면 좌표를 카메라 위치로 변환
          const x = cameraRadius * Math.sin(phi) * Math.sin(theta);
          const y = cameraRadius * Math.cos(phi);
          const z = cameraRadius * Math.sin(phi) * Math.cos(theta);
          
          cam.position.set(x, y, z);
          cam.lookAt(0, 0, 0);
        }
      }
      
      controls.update();
      renderer.render(scene, camera);
    };
    loop(0);

    return () => {
      stopCapture({ skipState: true, skipStatus: true });
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      disposePoints();
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement?.parentElement) {
        renderer.domElement.parentElement.removeChild(renderer.domElement);
      }
      scene.clear();
    };
  }, []);

  // Uniform 업데이트
  useEffect(() => {
    if (materialRef.current) {
      materialRef.current.uniforms.uZScale.value = spacing;
    }
  }, [spacing]);

  useEffect(() => {
    if (materialRef.current) {
      materialRef.current.uniforms.uSize.value = pointSize;
    }
  }, [pointSize]);

  useEffect(() => {
    if (controlsRef.current) {
      // 커스텀 자동 회전 플래그 설정
      (controlsRef.current as any)._customAutoRotate = autoRotate;
      if (!autoRotate) {
        // 자동 회전 비활성화 시 시간 리셋
        customRotationTimeRef.current = 0;
      }
    }
  }, [autoRotate]);

  useEffect(() => {
    if (controlsRef.current) {
      controlsRef.current.autoRotateSpeed = autoRotateSpeed;
    }
  }, [autoRotateSpeed]);

  // 포인트 정리
  function disposePoints() {
    const scene = sceneRef.current;
    if (scene && pointsRef.current) {
      scene.remove(pointsRef.current);
      pointsRef.current.geometry.dispose();
      (pointsRef.current.material as THREE.Material).dispose();
      pointsRef.current = null;
    }
    if (materialRef.current) {
      materialRef.current.dispose();
      materialRef.current = null;
    }
    if (colorTextureRef.current) {
      colorTextureRef.current.dispose();
      colorTextureRef.current = null;
    }
    colorDataRef.current = null;
    writeIndexRef.current = 0;
    regionsRef.current = null;
  }

  // 표면 포인트 초기화
  function initSparsePoints(): boolean {
    const scene = sceneRef.current;
    const hidden = hiddenCanvasRef.current;
    if (!scene || !hidden) {
      setStatus("Three.js 초기화가 아직 완료되지 않았습니다.");
      return false;
    }

    // 텍스처 크기 검증
    const val = validateTextureSize(targetW, targetH, targetFrames);
    if (!val.valid) {
      setStatus(val.message);
      return false;
    }

    // 영역 계산
    const regions = getTextureRegions(targetW, targetH, targetFrames);

    // 표면 포인트 생성
    const surfacePoints = generateSurfacePoints(targetW, targetH, targetFrames);
    const totalPoints = surfacePoints.length;

    if (totalPoints <= 0) {
      setStatus("표면 포인트 생성 실패");
      return false;
    }

    // 버퍼 생성
    const positions = new Float32Array(totalPoints * 3);
    const logicalFrames = new Float32Array(totalPoints);
    const pixelXs = new Float32Array(totalPoints);
    const pixelYs = new Float32Array(totalPoints);
    const faceTypes = new Float32Array(totalPoints);

    for (let i = 0; i < totalPoints; i++) {
      const pt = surfacePoints[i];
      positions[i * 3] = pt.x;
      positions[i * 3 + 1] = pt.y;
      positions[i * 3 + 2] = pt.z;
      logicalFrames[i] = pt.logicalFrame;
      pixelXs[i] = pt.pixelX;
      pixelYs[i] = pt.pixelY;
      faceTypes[i] = faceTypeToNumber(pt.face);
    }

    // Hidden canvas 설정
    hidden.width = targetW;
    hidden.height = targetH;
    const ctx = hidden.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      setStatus("Canvas 컨텍스트 생성 실패");
      return false;
    }

    // 기존 포인트 정리 (refs 초기화)
    disposePoints();
    
    // refs 설정 (disposePoints 후에!)
    ctxRef.current = ctx;
    regionsRef.current = regions;
    activeDimensionsRef.current = { w: targetW, h: targetH, frames: targetFrames };

    // DataTexture 생성 (Sparse)
    const colorData = new Uint8Array(CONFIG.TEX_WIDTH * CONFIG.TEX_HEIGHT * 4);
    // 검은색으로 초기화 (alpha=255)
    for (let i = 3; i < colorData.length; i += 4) {
      colorData[i] = 255;
    }

    const colorTexture = new THREE.DataTexture(
      colorData,
      CONFIG.TEX_WIDTH,
      CONFIG.TEX_HEIGHT,
      THREE.RGBAFormat,
      THREE.UnsignedByteType
    );
    colorTexture.minFilter = THREE.NearestFilter;
    colorTexture.magFilter = THREE.NearestFilter;
    colorTexture.needsUpdate = true;

    colorDataRef.current = colorData;
    colorTextureRef.current = colorTexture;
    writeIndexRef.current = 0;

    // Geometry 생성
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("aLogicalFrame", new THREE.BufferAttribute(logicalFrames, 1));
    geometry.setAttribute("aPixelX", new THREE.BufferAttribute(pixelXs, 1));
    geometry.setAttribute("aPixelY", new THREE.BufferAttribute(pixelYs, 1));
    geometry.setAttribute("aFaceType", new THREE.BufferAttribute(faceTypes, 1));

    // Material 생성
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: false,
      depthTest: true,
      depthWrite: true,
      uniforms: {
        uSize: { value: pointSize },
        uZScale: { value: spacing },
        uWriteIndex: { value: 0 },
        uTotalFrames: { value: targetFrames },
        uFrameWidth: { value: targetW },
        uFrameHeight: { value: targetH },
        uTexWidth: { value: CONFIG.TEX_WIDTH },
        uTexHeight: { value: CONFIG.TEX_HEIGHT },
        uFrontOffset: { value: new THREE.Vector2(regions.front.x, regions.front.y) },
        uBackOffset: { value: new THREE.Vector2(regions.back.x, regions.back.y) },
        uLeftOffset: { value: new THREE.Vector2(regions.left.x, regions.left.y) },
        uRightOffset: { value: new THREE.Vector2(regions.right.x, regions.right.y) },
        uTopOffset: { value: new THREE.Vector2(regions.top.x, regions.top.y) },
        uBottomOffset: { value: new THREE.Vector2(regions.bottom.x, regions.bottom.y) },
        uColorTex: { value: colorTexture },
      },
    });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    scene.add(points);

    pointsRef.current = points;
    materialRef.current = material;

    // 카메라 리셋
    cameraRef.current?.position.set(0, 0, CONFIG.INITIAL_Z);
    controlsRef.current?.target.set(0, 0, 0);
    controlsRef.current?.update();

    frameCountRef.current = 0;
    return true;
  }

  // 프레임 처리 (Sparse Surface)
  const processFrame = () => {
    if (!capturingRef.current) return;

    const video = videoRef.current;
    const ctx = ctxRef.current;
    const colorData = colorDataRef.current;
    const colorTexture = colorTextureRef.current;
    const material = materialRef.current;
    const regions = regionsRef.current;

    if (!video || !ctx || !colorData || !colorTexture || !material || !regions) return;

    const writeIndex = writeIndexRef.current;
    const texWidth = CONFIG.TEX_WIDTH;
    
    // ref에서 dimensions 가져오기 (클로저 문제 방지)
    const { w: activeW, h: activeH, frames: activeFrames } = activeDimensionsRef.current;

    // 프레임 캡처
    ctx.drawImage(video, 0, 0, activeW, activeH);
    const imageData = ctx.getImageData(0, 0, activeW, activeH);
    const { data } = imageData;

    // 1. Front face 업데이트 (newest frame - 전체)
    for (let y = 0; y < activeH; y++) {
      for (let x = 0; x < activeW; x++) {
        const srcIdx = (y * activeW + x) * 4;
        const dstX = regions.front.x + x;
        const dstY = regions.front.y + y;
        const dstIdx = (dstY * texWidth + dstX) * 4;

        colorData[dstIdx] = data[srcIdx];
        colorData[dstIdx + 1] = data[srcIdx + 1];
        colorData[dstIdx + 2] = data[srcIdx + 2];
        colorData[dstIdx + 3] = 255;
      }
    }

    // 2. Top edge 업데이트 (y=0)
    const topY = 0;
    for (let x = 0; x < activeW; x++) {
      const srcIdx = (topY * activeW + x) * 4;
      const dstX = regions.top.x + x;
      const dstY = regions.top.y + writeIndex;
      const dstIdx = (dstY * texWidth + dstX) * 4;

      colorData[dstIdx] = data[srcIdx];
      colorData[dstIdx + 1] = data[srcIdx + 1];
      colorData[dstIdx + 2] = data[srcIdx + 2];
      colorData[dstIdx + 3] = 255;
    }

    // 3. Bottom edge 업데이트 (y=height-1)
    const bottomY = activeH - 1;
    for (let x = 0; x < activeW; x++) {
      const srcIdx = (bottomY * activeW + x) * 4;
      const dstX = regions.bottom.x + x;
      const dstY = regions.bottom.y + writeIndex;
      const dstIdx = (dstY * texWidth + dstX) * 4;

      colorData[dstIdx] = data[srcIdx];
      colorData[dstIdx + 1] = data[srcIdx + 1];
      colorData[dstIdx + 2] = data[srcIdx + 2];
      colorData[dstIdx + 3] = 255;
    }

    // 4. Left edge 업데이트 (x=0)
    const leftX = 0;
    for (let y = 0; y < activeH; y++) {
      const srcIdx = (y * activeW + leftX) * 4;
      const dstX = regions.left.x + writeIndex;
      const dstY = regions.left.y + y;
      const dstIdx = (dstY * texWidth + dstX) * 4;

      colorData[dstIdx] = data[srcIdx];
      colorData[dstIdx + 1] = data[srcIdx + 1];
      colorData[dstIdx + 2] = data[srcIdx + 2];
      colorData[dstIdx + 3] = 255;
    }

    // 5. Right edge 업데이트 (x=width-1)
    const rightX = activeW - 1;
    for (let y = 0; y < activeH; y++) {
      const srcIdx = (y * activeW + rightX) * 4;
      const dstX = regions.right.x + writeIndex;
      const dstY = regions.right.y + y;
      const dstIdx = (dstY * texWidth + dstX) * 4;

      colorData[dstIdx] = data[srcIdx];
      colorData[dstIdx + 1] = data[srcIdx + 1];
      colorData[dstIdx + 2] = data[srcIdx + 2];
      colorData[dstIdx + 3] = 255;
    }

    // 6. Back face 업데이트 - ring buffer wrap 시점마다 업데이트
    // writeIndex가 0일 때 = 새로운 cycle의 시작
    // 이 시점에서 현재 프레임을 Back에 저장하면 대략 frames 프레임 차이가 유지됨
    if (writeIndex === 0) {
    for (let y = 0; y < activeH; y++) {
      for (let x = 0; x < activeW; x++) {
        const srcIdx = (y * activeW + x) * 4;
        const dstX = regions.back.x + x;
        const dstY = regions.back.y + y;
        const dstIdx = (dstY * texWidth + dstX) * 4;

        colorData[dstIdx] = data[srcIdx];
        colorData[dstIdx + 1] = data[srcIdx + 1];
        colorData[dstIdx + 2] = data[srcIdx + 2];
        colorData[dstIdx + 3] = 255;
        }
      }
    }

    colorTexture.needsUpdate = true;
    writeIndexRef.current = (writeIndex + 1) % activeFrames;
    material.uniforms.uWriteIndex.value = writeIndexRef.current;

    frameCountRef.current += 1;
  };

  // 프레임 스케줄링
  const scheduleNextFrame = () => {
    if (!capturingRef.current) return;
    const video = videoRef.current;
    if (!video) return;

    if (hasRVFC && typeof (video as any).requestVideoFrameCallback === "function") {
      rvfcRef.current = (video as any).requestVideoFrameCallback(() => {
        processFrame();
        scheduleNextFrame();
      });
    } else {
      rafRef.current = requestAnimationFrame(() => {
        processFrame();
        scheduleNextFrame();
      });
    }
  };

  // 캡처 시작
  async function startCapture() {
    if (capturingRef.current) return;
    try {
      setStatus("웹캠 접근 요청 중...");
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: targetW }, height: { ideal: targetH } },
        audio: false,
      });
      mediaStreamRef.current = stream;

      const video = videoRef.current;
      if (!video) throw new Error("비디오 엘리먼트를 찾지 못했습니다.");
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();

      if (!initSparsePoints()) {
        throw new Error("Sparse 포인트 초기화 실패");
      }

      capturingRef.current = true;
      setIsCapturing(true);

      setStatus(
        `🚀 Sparse Surface Mode 시작!\n` +
        `해상도: ${targetW}×${targetH}×${targetFrames}\n` +
        `포인트: ${surfacePointCount.toLocaleString()} (${memoryUsage.savings}% VRAM 절감)\n` +
        `메모리: ${memoryUsage.sparse}MB (원래 ${memoryUsage.full}MB)`
      );
      scheduleNextFrame();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus(`오류: ${message}`);
      stopCapture({ skipState: true, skipStatus: true });
    }
  }

  // 캡처 중지
  function stopCapture(options: { skipState?: boolean; skipStatus?: boolean } = {}) {
    const { skipState = false, skipStatus = false } = options;
    capturingRef.current = false;
    if (!skipState) setIsCapturing(false);

    const video = videoRef.current;
    if (video) {
      if (rvfcRef.current !== null && typeof (video as any).cancelVideoFrameCallback === "function") {
        (video as any).cancelVideoFrameCallback(rvfcRef.current);
      }
      rvfcRef.current = null;

      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }

      video.pause();
      video.srcObject = null;
    } else if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    ctxRef.current = null;

    if (!skipStatus) {
      setStatus("라이브 중지됨");
    }
  }

  // UI
  return (
    <div style={{ width: "100vw", height: "100vh", background: "#0a0a0a", color: "#eee" }}>
      {/* UI 토글 */}
      <button
        onClick={() => setShowUI((prev) => !prev)}
        style={{
          position: "fixed",
          top: 10,
          right: 10,
          zIndex: 20,
          background: showUI ? "rgba(0,0,0,.7)" : "rgba(0,0,0,.0)",
          color: showUI ? "#eee" : "rgba(255,255,255,.00)",
          border: showUI ? "1px solid rgba(255,255,255,.00)" : "1px solid rgba(255,255,255,.00)",
          borderRadius: 6,
          padding: "6px 12px",
          cursor: "pointer",
          transition: "all 0.3s ease",
        }}
        onMouseEnter={(e) => {
          if (!showUI) {
            e.currentTarget.style.background = "rgba(0,0,0,.1)";
            e.currentTarget.style.color = "#eee";
            e.currentTarget.style.border = "1px solid rgba(255,255,255,.1)";
          }
        }}
        onMouseLeave={(e) => {
          if (!showUI) {
            e.currentTarget.style.background = "rgba(0,0,0,.0)";
            e.currentTarget.style.color = "rgba(255,255,255,.0)";
            e.currentTarget.style.border = "1px solid rgba(255,255,255,.0)";
          }
        }}
      >
        {showUI ? "UI 숨기기" : "UI 보이기"}
      </button>

      {/* 컨트롤 패널 */}
      {showUI && (
        <div
          style={{
            position: "fixed",
            top: 10,
            left: 10,
            zIndex: 10,
            background: "rgba(0,0,0,.85)",
            padding: "14px 16px",
            borderRadius: 12,
            display: "flex",
            flexDirection: "column",
            gap: 12,
            minWidth: 320,
            border: "1px solid rgba(255,255,255,.1)",
          }}
        >
          {/* 타이틀 */}
          <div style={{ color: "#f84", fontSize: 14, fontWeight: "bold" }}>
            ⚡ Sparse Surface Mode
          </div>

          {/* 메모리/포인트 정보 */}
          <div style={{ fontSize: 11, color: "#888", lineHeight: 1.6 }}>
            <div>
              해상도: <span style={{ color: "#4f8" }}>{targetW}×{targetH}×{targetFrames}</span>
            </div>
            <div>
              포인트: <span style={{ color: "#4f8" }}>{surfacePointCount.toLocaleString()}</span>
              {" / "}
              <span style={{ color: "#666" }}>{fullVolumeCount.toLocaleString()}</span>
              {" "}
              (<span style={{ color: "#ff0" }}>{((1 - surfacePointCount / fullVolumeCount) * 100).toFixed(1)}%</span> 절감)
            </div>
            <div>
              VRAM: <span style={{ color: "#4f8" }}>{memoryUsage.sparse}MB</span>
              {" / "}
              <span style={{ color: "#666" }}>{memoryUsage.full}MB</span>
              {" "}
              (<span style={{ color: "#ff0" }}>{memoryUsage.savings}%</span> 절감)
            </div>
            <div>
              텍스처: <span style={{ color: validation.valid ? "#4f8" : "#f44" }}>
                {validation.requiredWidth}×{validation.requiredHeight}
              </span>
              {" / "}
              <span style={{ color: "#666" }}>{CONFIG.TEX_WIDTH}×{CONFIG.TEX_HEIGHT}</span>
              {!validation.valid && <span style={{ color: "#f44" }}> ⚠️</span>}
            </div>
          </div>

          {/* 캡처 버튼 */}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={startCapture}
              disabled={isCapturing || !validation.valid}
              style={{
                flex: 1,
                padding: "10px",
                background: isCapturing || !validation.valid ? "#333" : "#2a6",
                color: "#fff",
                border: "none",
                borderRadius: 6,
                cursor: isCapturing || !validation.valid ? "not-allowed" : "pointer",
                fontWeight: "bold",
              }}
            >
              ▶ 시작
            </button>
            <button
              onClick={() => stopCapture()}
              disabled={!isCapturing}
              style={{
                flex: 1,
                padding: "10px",
                background: !isCapturing ? "#333" : "#a44",
                color: "#fff",
                border: "none",
                borderRadius: 6,
                cursor: !isCapturing ? "not-allowed" : "pointer",
                fontWeight: "bold",
              }}
            >
              ⏹ 중지
            </button>
          </div>

          {/* 설정 */}
          <div style={{ borderTop: "1px solid #333", paddingTop: 12 }}>
            <div style={{ fontSize: 11, color: "#888", marginBottom: 8 }}>해상도 (W × H × Frames)</div>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="number"
                value={targetW}
                min={8}
                step={8}
                style={{ width: 70, padding: 6, background: "#222", color: "#eee", border: "1px solid #444", borderRadius: 4, textAlign: "center" }}
                onChange={(e) => setTargetW(parseInt(e.currentTarget.value || "720", 10))}
                disabled={isCapturing}
              />
              <input
                type="number"
                value={targetH}
                min={8}
                step={8}
                style={{ width: 70, padding: 6, background: "#222", color: "#eee", border: "1px solid #444", borderRadius: 4, textAlign: "center" }}
                onChange={(e) => setTargetH(parseInt(e.currentTarget.value || "1080", 10))}
                disabled={isCapturing}
              />
              <input
                type="number"
                value={targetFrames}
                min={2}
                style={{ width: 70, padding: 6, background: "#222", color: "#eee", border: "1px solid #444", borderRadius: 4, textAlign: "center" }}
                onChange={(e) => setTargetFrames(parseInt(e.currentTarget.value || "720", 10))}
                disabled={isCapturing}
              />
            </div>
            {!validation.valid && (
              <div style={{ color: "#f44", fontSize: 10, marginTop: 6 }}>
                {validation.message}
              </div>
            )}
          </div>

          {/* 비주얼 */}
          <div style={{ borderTop: "1px solid #333", paddingTop: 12 }}>
            <label style={{ fontSize: 11, color: "#888" }}>
              Spacing: {spacing.toFixed(1)}
            </label>
            <input
              type="range"
              min={0.1}
              max={3}
              step={0.1}
              value={spacing}
              onChange={(e) => setSpacing(parseFloat(e.currentTarget.value))}
              style={{ width: "100%" }}
            />

            <label style={{ fontSize: 11, color: "#888", marginTop: 8, display: "block" }}>
              Point Size: {pointSize.toFixed(1)}
            </label>
            <input
              type="range"
              min={0.5}
              max={30}
              step={0.5}
              value={pointSize}
              onChange={(e) => setPointSize(parseFloat(e.currentTarget.value))}
              style={{ width: "100%" }}
            />
          </div>

          {/* 자동 회전 */}
          <div style={{ borderTop: "1px solid #333", paddingTop: 12 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
              <input
                type="checkbox"
                checked={autoRotate}
                onChange={(e) => setAutoRotate(e.currentTarget.checked)}
              />
              자동 회전
            </label>
            {autoRotate && (
              <>
                <label style={{ fontSize: 11, color: "#888", marginTop: 8, display: "block" }}>
                  속도: {autoRotateSpeed.toFixed(1)}
                </label>
                <input
                  type="range"
                  min={0.1}
                  max={3}
                  step={0.1}
                  value={autoRotateSpeed}
                  onChange={(e) => setAutoRotateSpeed(parseFloat(e.currentTarget.value))}
                  style={{ width: "100%" }}
                />
              </>
            )}
          </div>
        </div>
      )}

      {/* 상태 */}
      {showUI && (
        <div
          style={{
            position: "fixed",
            bottom: 10,
            left: 10,
            right: 10,
            zIndex: 10,
            background: "rgba(0,0,0,.7)",
            padding: "10px 14px",
            borderRadius: 8,
            fontSize: 12,
            whiteSpace: "pre-wrap",
            lineHeight: 1.5,
          }}
        >
          {status}
        </div>
      )}

      {/* Hidden */}
      <canvas ref={hiddenCanvasRef} style={{ display: "none" }} />
      <video ref={videoRef} muted playsInline style={{ display: "none" }} />

      {/* Three.js */}
      <div ref={mountRef} style={{ position: "absolute", inset: 0 }} />
    </div>
  );
}

