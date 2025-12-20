"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/**
 * Box Mode - 비디오 파일 기반 포인트 클라우드 시각화
 *
 * 비디오를 선택 → W×H, 프레임 수로 샘플링 → Float32Array 누적 → THREE.Points로 시각화
 * X/Y/Z 슬라이싱, 카메라 프리셋, PNG 저장 기능 제공
 */

// ============================================================================
// 설정값
// ============================================================================
const CONFIG = {
  // 샘플링 기본값
  DEFAULT_WIDTH: 180,
  DEFAULT_HEIGHT: 180,
  DEFAULT_FRAMES: 180,

  // 시각 기본값
  DEFAULT_SPACING: 1,
  DEFAULT_POINT_SIZE: 3.6,
  DEFAULT_OPACITY: 1,
  DEFAULT_SIZE_ATTENUATION: true,

  // 카메라
  FOV: 50,
  NEAR: 0.1,
  FAR: 2000,
  ORTHO_NEAR: 0.001,
  ORTHO_FAR: 8000,
  INITIAL_Z: 180,
  CAMERA_DISTANCE: 200,
  CAMERA_RANGE: 1500,

  // 슬라이스 기본값
  DEFAULT_X_RANGE: { min: -64, max: 64 },
  DEFAULT_Y_RANGE: { min: -36, max: 36 },
  DEFAULT_Z_RANGE: { min: -60, max: 60 },

  // 관람자 애니메이션
  ANIMATION_DURATION: 8000, // ms (더 천천히)
  ZOOM_START: 1.2, // 직교 카메라용 줌 시작 (약간 확대)
  ZOOM_END: 0.6, // 직교 카메라용 줌 종료 (축소해서 전체 보기)
  ZOOM_END_FRONT: 1.1, // Front 애니메이션 전용 줌 종료
};

// ============================================================================
// 유틸리티 함수
// ============================================================================
const clamp = (v: number, min: number, max: number) =>
  Math.max(min, Math.min(max, v));

const hasRVFC = () =>
  typeof HTMLVideoElement !== "undefined" &&
  "requestVideoFrameCallback" in HTMLVideoElement.prototype;

// 파일 크기 포맷
const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

// ============================================================================
// PLY 내보내기 함수
// ============================================================================

/** ASCII PLY 헤더 생성 */
const createPLYHeaderASCII = (totalPoints: number): string => {
  return (
    [
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
    ].join("\n") + "\n"
  );
};

/** Binary PLY 헤더 생성 */
const createPLYHeaderBinary = (totalPoints: number): string => {
  return (
    [
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
    ].join("\n") + "\n"
  );
};

/** ASCII PLY 데이터 생성 (positions, colors Float32Array 사용) */
const createPLYDataASCII = (
  positions: Float32Array,
  colors: Float32Array,
  spacing: number
): string => {
  const totalPoints = positions.length / 3;
  const header = createPLYHeaderASCII(totalPoints);
  const lines: string[] = [];

  for (let i = 0; i < totalPoints; i++) {
    const idx = i * 3;
    const x = positions[idx];
    const y = positions[idx + 1];
    const z = positions[idx + 2] * spacing; // spacing 적용
    const r = Math.round(colors[idx] * 255);
    const g = Math.round(colors[idx + 1] * 255);
    const b = Math.round(colors[idx + 2] * 255);
    lines.push(`${x} ${y} ${z} ${r} ${g} ${b}`);
  }

  return header + lines.join("\n");
};

/** Binary PLY 데이터 생성 */
const createPLYDataBinary = (
  positions: Float32Array,
  colors: Float32Array,
  spacing: number
): Uint8Array => {
  const totalPoints = positions.length / 3;
  const header = createPLYHeaderBinary(totalPoints);
  const headerBytes = new TextEncoder().encode(header);

  const bytesPerPoint = 15; // 3 floats (12 bytes) + 3 bytes RGB
  const dataBuffer = new ArrayBuffer(totalPoints * bytesPerPoint);
  const dataView = new DataView(dataBuffer);

  let offset = 0;
  for (let i = 0; i < totalPoints; i++) {
    const idx = i * 3;
    const x = positions[idx];
    const y = positions[idx + 1];
    const z = positions[idx + 2] * spacing;

    dataView.setFloat32(offset, x, true);
    offset += 4;
    dataView.setFloat32(offset, y, true);
    offset += 4;
    dataView.setFloat32(offset, z, true);
    offset += 4;
    dataView.setUint8(offset++, Math.round(colors[idx] * 255));
    dataView.setUint8(offset++, Math.round(colors[idx + 1] * 255));
    dataView.setUint8(offset++, Math.round(colors[idx + 2] * 255));
  }

  const combined = new Uint8Array(headerBytes.length + dataBuffer.byteLength);
  combined.set(headerBytes, 0);
  combined.set(new Uint8Array(dataBuffer), headerBytes.length);

  return combined;
};

/** 파일 다운로드 */
const downloadBlob = (
  data: string | Uint8Array,
  filename: string,
  mimeType: string = "application/octet-stream"
): void => {
  const blob = new Blob([data], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
};

// Easing 함수
const easeInOutCubic = (t: number): number => {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};

const lerp = (start: number, end: number, t: number): number => {
  return start + (end - start) * t;
};

// ============================================================================
// 셰이더
// ============================================================================
const vertexShader = `
  attribute vec3 color;
  varying vec3 vColor;
  varying float vMask;
  
  uniform float uSize;
  uniform bool uAttenuate;
  uniform float uZScale;
  uniform vec2 uXRange;
  uniform vec2 uYRange;
  uniform vec2 uZRange;
  
  void main() {
    vec3 pos = position;
    pos.z *= uZScale;
    vColor = color;
    
    float inside = step(uXRange.x, pos.x) * step(pos.x, uXRange.y)
                 * step(uYRange.x, pos.y) * step(pos.y, uYRange.y)
                 * step(uZRange.x, pos.z) * step(pos.z, uZRange.y);
    vMask = inside;
    
    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    
    float size = uSize;
    if (uAttenuate) {
      float denom = max(1.0, abs(mvPosition.z));
      size = uSize * (300.0 / denom);
    }
    gl_PointSize = max(0.1, size);
  }
`;

const fragmentShader = `
  precision mediump float;
  varying vec3 vColor;
  varying float vMask;
  uniform float uOpacity;
  
  void main() {
    if (vMask < 0.5) discard;
    gl_FragColor = vec4(vColor, uOpacity);
  }
`;

// ============================================================================
// 타입 정의
// ============================================================================
interface CameraPosition {
  x: number;
  y: number;
  z: number;
}

interface Extents {
  xMinAll: number;
  xMaxAll: number;
  yMinAll: number;
  yMaxAll: number;
  zMinBase: number;
  zMaxBase: number;
}

interface SampleBuffers {
  positions: Float32Array;
  colors: Float32Array;
}

type CameraDirection = "front" | "back" | "left" | "right" | "top" | "bottom";

type ViewerAnimationType = "front" | "side" | "top" | "orbit" | null;

interface ViewerAnimation {
  type: ViewerAnimationType;
  startTime: number;
  duration: number;
  startValues: {
    zMin: number;
    zMax: number;
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
    zoom: number;
    pointSize: number;
  };
  targetValues: {
    zMin: number;
    zMax: number;
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
    zoom: number;
    pointSize: number;
  };
}

// ============================================================================
// 메인 컴포넌트
// ============================================================================
export default function BoxPage() {
  // === Refs ===
  const mountRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<
    THREE.PerspectiveCamera | THREE.OrthographicCamera | null
  >(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const pointsRef = useRef<THREE.Points | null>(null);
  const materialRef = useRef<THREE.ShaderMaterial | null>(null);

  const hiddenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const extentsRef = useRef<Extents>({
    xMinAll: CONFIG.DEFAULT_X_RANGE.min,
    xMaxAll: CONFIG.DEFAULT_X_RANGE.max,
    yMinAll: CONFIG.DEFAULT_Y_RANGE.min,
    yMaxAll: CONFIG.DEFAULT_Y_RANGE.max,
    zMinBase: -30,
    zMaxBase: 30,
  });
  const orthoSizeRef = useRef<number>(200);
  const initialCameraModeRef = useRef<boolean>(true);

  // 관람자 애니메이션 Refs
  const viewerAnimationRef = useRef<ViewerAnimation | null>(null);
  const viewerAnimationRafRef = useRef<number | null>(null);

  // PLY 내보내기용 버퍼 Refs
  const positionsRef = useRef<Float32Array | null>(null);
  const colorsRef = useRef<Float32Array | null>(null);

  // === State ===
  const [status, setStatus] = useState<string>("비디오 로딩 중...");
  const [showUI, setShowUI] = useState<boolean>(true);

  // 샘플링 설정
  const [targetW, setTargetW] = useState<number>(CONFIG.DEFAULT_WIDTH);
  const [targetH, setTargetH] = useState<number>(CONFIG.DEFAULT_HEIGHT);
  const [targetFrames, setTargetFrames] = useState<number>(
    CONFIG.DEFAULT_FRAMES
  );

  // 시각 설정
  const [spacing, setSpacing] = useState<number>(CONFIG.DEFAULT_SPACING);
  const [pointSize, setPointSize] = useState<number>(CONFIG.DEFAULT_POINT_SIZE);
  const [opacity, setOpacity] = useState<number>(CONFIG.DEFAULT_OPACITY);
  const [sizeAttenuation, setSizeAttenuation] = useState<boolean>(
    CONFIG.DEFAULT_SIZE_ATTENUATION
  );

  // 카메라 설정
  const [useOrthographic, setUseOrthographic] = useState<boolean>(true);
  const [cameraPosition, setCameraPosition] = useState<CameraPosition>({
    x: 0,
    y: 0,
    z: CONFIG.INITIAL_Z,
  });
  const [cameraZoom, setCameraZoom] = useState<number>(1);

  // 슬라이스 설정
  const [xMin, setXMin] = useState<number>(CONFIG.DEFAULT_X_RANGE.min);
  const [xMax, setXMax] = useState<number>(CONFIG.DEFAULT_X_RANGE.max);
  const [yMin, setYMin] = useState<number>(CONFIG.DEFAULT_Y_RANGE.min);
  const [yMax, setYMax] = useState<number>(CONFIG.DEFAULT_Y_RANGE.max);
  const [zMin, setZMin] = useState<number>(CONFIG.DEFAULT_Z_RANGE.min);
  const [zMax, setZMax] = useState<number>(CONFIG.DEFAULT_Z_RANGE.max);

  // 관람자 모드 설정
  const [isViewerAnimating, setIsViewerAnimating] = useState<boolean>(false);
  const [controlsLocked, setControlsLocked] = useState<boolean>(false);
  const [activeViewerMode, setActiveViewerMode] =
    useState<ViewerAnimationType>(null);

  // === Memoized Values ===
  const rvfcSupported = useMemo(() => hasRVFC(), []);

  const totalPoints = useMemo(
    () => targetW * targetH * targetFrames,
    [targetW, targetH, targetFrames]
  );

  // === Callbacks ===
  const updateCameraPositionState = useCallback(() => {
    const camera = cameraRef.current;
    if (!camera) return;

    const { x, y, z } = camera.position;
    setCameraPosition((prev) => {
      if (
        Math.abs(prev.x - x) < 1e-4 &&
        Math.abs(prev.y - y) < 1e-4 &&
        Math.abs(prev.z - z) < 1e-4
      ) {
        return prev;
      }
      return { x, y, z };
    });

    const currentZoom = camera.zoom;
    setCameraZoom((prev) =>
      Math.abs(prev - currentZoom) < 1e-4 ? prev : currentZoom
    );
  }, []);

  const configureCamera = useCallback(
    (useOrtho: boolean) => {
      if (!mountRef.current || !rendererRef.current) return;

      const width = mountRef.current.clientWidth || 1;
      const height = mountRef.current.clientHeight || 1;
      const aspect = width / Math.max(height, 1e-6);
      const previous = cameraRef.current;

      let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;

      if (useOrtho) {
        let frustumHeight = orthoSizeRef.current;
        if (previous instanceof THREE.PerspectiveCamera) {
          const distance = previous.position.length();
          const fovRad = THREE.MathUtils.degToRad(previous.fov);
          frustumHeight =
            (2 * distance * Math.tan(fovRad / 2)) /
            Math.max(previous.zoom, 1e-3);
        } else if (previous instanceof THREE.OrthographicCamera) {
          frustumHeight = previous.top - previous.bottom;
        }
        orthoSizeRef.current = frustumHeight;
        const frustumWidth = frustumHeight * aspect;
        const orthoCam = new THREE.OrthographicCamera(
          -frustumWidth / 2,
          frustumWidth / 2,
          frustumHeight / 2,
          -frustumHeight / 2,
          CONFIG.ORTHO_NEAR,
          CONFIG.ORTHO_FAR
        );
        if (previous instanceof THREE.OrthographicCamera) {
          orthoCam.zoom = previous.zoom;
        }
        camera = orthoCam;
      } else {
        let fov = CONFIG.FOV;
        if (previous instanceof THREE.OrthographicCamera) {
          const distance = previous.position.length();
          const heightUsed =
            (previous.top - previous.bottom) / Math.max(previous.zoom, 1e-3);
          if (distance > 1e-3) {
            fov = THREE.MathUtils.radToDeg(
              2 * Math.atan((heightUsed * 0.5) / distance)
            );
          }
        } else if (previous instanceof THREE.PerspectiveCamera) {
          fov = previous.fov;
        }
        const perspectiveCam = new THREE.PerspectiveCamera(
          fov,
          aspect,
          CONFIG.NEAR,
          CONFIG.FAR
        );
        if (previous instanceof THREE.PerspectiveCamera) {
          perspectiveCam.zoom = previous.zoom;
        }
        camera = perspectiveCam;
      }

      if (previous) {
        camera.position.copy(previous.position);
        camera.quaternion.copy(previous.quaternion);
        camera.up.copy(previous.up);
      } else {
        camera.position.set(0, 0, CONFIG.INITIAL_Z);
      }

      if (camera instanceof THREE.PerspectiveCamera) {
        const distance = camera.position.length();
        orthoSizeRef.current =
          (2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) /
          Math.max(camera.zoom, 1e-3);
      } else if (camera instanceof THREE.OrthographicCamera) {
        orthoSizeRef.current = camera.top - camera.bottom;
      }

      camera.updateProjectionMatrix();
      cameraRef.current = camera;

      const currentControls = controlsRef.current;
      if (currentControls) {
        const target = currentControls.target.clone();
        currentControls.object = camera;
        currentControls.enableDamping = false;
        currentControls.dampingFactor = 0;
        currentControls.target.copy(target);
        currentControls.update();
      } else {
        const controls = new OrbitControls(
          camera,
          rendererRef.current.domElement
        );
        controls.enableDamping = false;
        controls.dampingFactor = 0;
        controls.addEventListener("change", updateCameraPositionState);
        controlsRef.current = controls;
      }
      updateCameraPositionState();
    },
    [updateCameraPositionState]
  );

  const moveCameraTo = useCallback((dir: CameraDirection) => {
    const d = CONFIG.CAMERA_DISTANCE;
    const positions: Record<CameraDirection, CameraPosition> = {
      front: { x: 0, y: 0, z: d },
      back: { x: 0, y: 0, z: -d },
      left: { x: -d, y: 0, z: 0 },
      right: { x: d, y: 0, z: 0 },
      top: { x: 0, y: d, z: 0 },
      bottom: { x: 0, y: -d, z: 0 },
    };

    setCameraPosition(positions[dir]);
    controlsRef.current?.target.set(0, 0, 0);
    controlsRef.current?.update();
  }, []);

  const setCameraPositionAxis = useCallback(
    (axis: keyof CameraPosition, value: number) => {
      setCameraPosition((prev) => {
        if (prev[axis] === value) return prev;
        return { ...prev, [axis]: value };
      });
    },
    []
  );

  // === Helper Functions ===
  const log = (msg: string) => setStatus(msg);
  const append = (msg: string) =>
    setStatus((prev) => (prev ? `${prev}\n${msg}` : msg));

  const saveCanvasAsPNG = (filename = "capture.png") => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const canvas = renderer.domElement as HTMLCanvasElement;
    const url = canvas.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const waitVideoFrame = async (video: HTMLVideoElement) => {
    if (rvfcSupported) {
      await new Promise<void>((resolve) => {
        video.requestVideoFrameCallback(() => resolve());
      });
      return;
    }
    await new Promise<void>((resolve) => {
      const onTimeUpdate = () => {
        video.removeEventListener("timeupdate", onTimeUpdate);
        resolve();
      };
      video.addEventListener("timeupdate", onTimeUpdate, { once: true });
      setTimeout(() => {
        video.removeEventListener("timeupdate", onTimeUpdate);
        resolve();
      }, 60);
    });
  };

  const sampleVideoToBuffers = async (): Promise<SampleBuffers> => {
    const video = videoRef.current!;
    const hidden = hiddenCanvasRef.current!;
    const ctx = hidden.getContext("2d", { willReadFrequently: true })!;

    await video.play().catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    video.pause();

    const duration = video.duration;
    if (!isFinite(duration) || duration <= 0) {
      throw new Error("비디오 duration을 읽지 못했습니다.");
    }

    hidden.width = targetW;
    hidden.height = targetH;

    const positions = new Float32Array(totalPoints * 3);
    const colors = new Float32Array(totalPoints * 3);
    const dt = duration / Math.max(1, targetFrames - 1);

    let i = 0;
    for (let f = 0; f < targetFrames; f++) {
      const t = Math.min(dt * f, duration - 1e-4);
      video.currentTime = t;
      await waitVideoFrame(video);

      ctx.drawImage(video, 0, 0, targetW, targetH);
      const { data } = ctx.getImageData(0, 0, targetW, targetH);

      for (let y = 0; y < targetH; y++) {
        const yVal = (targetH - 1) / 2 - y;
        for (let x = 0; x < targetW; x++) {
          const p = (y * targetW + x) * 4;
          const idx = i * 3;

          positions[idx] = x - (targetW - 1) / 2;
          positions[idx + 1] = yVal;
          positions[idx + 2] = f - (targetFrames - 1) / 2;

          colors[idx] = data[p] / 255;
          colors[idx + 1] = data[p + 1] / 255;
          colors[idx + 2] = data[p + 2] / 255;

          i++;
        }
      }
      append(`프레임 ${f + 1}/${targetFrames} 캡처 (t=${t.toFixed(2)}s)`);
    }

    // Update extents
    extentsRef.current = {
      xMinAll: -(targetW - 1) / 2,
      xMaxAll: (targetW - 1) / 2,
      yMinAll: -(targetH - 1) / 2,
      yMaxAll: (targetH - 1) / 2,
      zMinBase: -(targetFrames - 1) / 2,
      zMaxBase: (targetFrames - 1) / 2,
    };

    setXMin(extentsRef.current.xMinAll);
    setXMax(extentsRef.current.xMaxAll);
    setYMin(extentsRef.current.yMinAll);
    setYMax(extentsRef.current.yMaxAll);
    setZMin(extentsRef.current.zMinBase * spacing);
    setZMax(extentsRef.current.zMaxBase * spacing);

    return { positions, colors };
  };

  const visualize = (buffers: SampleBuffers) => {
    const scene = sceneRef.current!;
    const camera = cameraRef.current!;

    // Dispose previous
    if (pointsRef.current) {
      scene.remove(pointsRef.current);
      pointsRef.current.geometry.dispose();
      (pointsRef.current.material as THREE.Material).dispose();
      pointsRef.current = null;
      materialRef.current = null;
    }

    // PLY 내보내기용 버퍼 저장
    positionsRef.current = buffers.positions;
    colorsRef.current = buffers.colors;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(buffers.positions, 3)
    );
    geometry.setAttribute(
      "color",
      new THREE.BufferAttribute(buffers.colors, 3)
    );

    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthTest: true,
      depthWrite: true,
      alphaTest: 0.001,
      uniforms: {
        uSize: { value: pointSize },
        uAttenuate: { value: sizeAttenuation },
        uOpacity: { value: opacity },
        uZScale: { value: spacing },
        uXRange: { value: new THREE.Vector2(xMin, xMax) },
        uYRange: { value: new THREE.Vector2(yMin, yMax) },
        uZRange: { value: new THREE.Vector2(zMin, zMax) },
      },
    });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    scene.add(points);

    pointsRef.current = points;
    materialRef.current = material;

    camera.position.set(0, 0, CONFIG.INITIAL_Z);
    controlsRef.current?.target.set(0, 0, 0);
    controlsRef.current?.update();
    updateCameraPositionState();
  };

  const disposePoints = () => {
    const scene = sceneRef.current;
    if (scene && pointsRef.current) {
      scene.remove(pointsRef.current);
      pointsRef.current.geometry.dispose();
      (pointsRef.current.material as THREE.Material).dispose();
      pointsRef.current = null;
      materialRef.current = null;
    }
    // PLY 내보내기용 버퍼도 정리
    positionsRef.current = null;
    colorsRef.current = null;
    setStatus("초기화됨.");
  };

  // === PLY 저장 함수 ===
  const savePLYAscii = (filename = "pointcloud.ply") => {
    const positions = positionsRef.current;
    const colors = colorsRef.current;
    if (!positions || !colors) {
      setStatus("저장할 포인트 클라우드 데이터가 없습니다.");
      return;
    }

    const plyContent = createPLYDataASCII(positions, colors, spacing);
    downloadBlob(plyContent, filename, "text/plain");

    const totalPoints = positions.length / 3;
    append(`PLY (ASCII) 저장 완료: ${totalPoints.toLocaleString()} 포인트`);
  };

  const savePLYBinary = (filename = "pointcloud_binary.ply") => {
    const positions = positionsRef.current;
    const colors = colorsRef.current;
    if (!positions || !colors) {
      setStatus("저장할 포인트 클라우드 데이터가 없습니다.");
      return;
    }

    const plyBinary = createPLYDataBinary(positions, colors, spacing);
    downloadBlob(plyBinary, filename, "application/octet-stream");

    const totalPoints = positions.length / 3;
    const fileSize = formatFileSize(plyBinary.length);
    append(
      `PLY (Binary) 저장 완료: ${totalPoints.toLocaleString()} 포인트 (${fileSize})`
    );
  };

  // === 관람자 애니메이션 함수 ===
  const stopViewerAnimation = useCallback(() => {
    if (viewerAnimationRafRef.current !== null) {
      cancelAnimationFrame(viewerAnimationRafRef.current);
      viewerAnimationRafRef.current = null;
    }
    viewerAnimationRef.current = null;
    setIsViewerAnimating(false);
    setActiveViewerMode(null);

    // 컨트롤 복원
    if (controlsRef.current) {
      controlsRef.current.enabled = true;
    }
    setControlsLocked(false);
  }, []);

  const runViewerAnimationLoop = useCallback(() => {
    const animation = viewerAnimationRef.current;
    if (!animation) return;

    const now = performance.now();
    const elapsed = now - animation.startTime;
    const progress = Math.min(elapsed / animation.duration, 1);
    // 이징 없이 선형 보간 사용
    const t = progress;

    // 슬라이스 값 보간
    const newZMin = lerp(
      animation.startValues.zMin,
      animation.targetValues.zMin,
      t
    );
    const newZMax = lerp(
      animation.startValues.zMax,
      animation.targetValues.zMax,
      t
    );
    const newXMin = lerp(
      animation.startValues.xMin,
      animation.targetValues.xMin,
      t
    );
    const newXMax = lerp(
      animation.startValues.xMax,
      animation.targetValues.xMax,
      t
    );
    const newYMin = lerp(
      animation.startValues.yMin,
      animation.targetValues.yMin,
      t
    );
    const newYMax = lerp(
      animation.startValues.yMax,
      animation.targetValues.yMax,
      t
    );

    // 줌 값 보간
    const newZoom = lerp(
      animation.startValues.zoom,
      animation.targetValues.zoom,
      t
    );

    // 포인트 사이즈 보간
    const newPointSize = lerp(
      animation.startValues.pointSize,
      animation.targetValues.pointSize,
      t
    );

    setZMin(newZMin);
    setZMax(newZMax);
    setXMin(newXMin);
    setXMax(newXMax);
    setYMin(newYMin);
    setYMax(newYMax);
    setCameraZoom(newZoom);
    setPointSize(newPointSize);

    if (progress < 1) {
      viewerAnimationRafRef.current = requestAnimationFrame(
        runViewerAnimationLoop
      );
    } else {
      // 애니메이션 완료 - 자동으로 자유 모드로 복귀
      viewerAnimationRef.current = null;
      setIsViewerAnimating(false);
      setActiveViewerMode(null);

      // 컨트롤 복원
      if (controlsRef.current) {
        controlsRef.current.enabled = true;
      }
      setControlsLocked(false);
    }
  }, []);

  const startViewerAnimation = useCallback(
    (type: ViewerAnimationType) => {
      if (!materialRef.current || !pointsRef.current) {
        setStatus("먼저 비디오를 샘플링해주세요.");
        return;
      }

      // 기존 애니메이션 중지
      stopViewerAnimation();

      const { zMinBase, zMaxBase, xMinAll, xMaxAll, yMinAll, yMaxAll } =
        extentsRef.current;
      const zMinFull = zMinBase * spacing;
      const zMaxFull = zMaxBase * spacing;

      // 직교 카메라로 전환
      setUseOrthographic(true);

      // 컨트롤 비활성화 및 카메라 이동
      if (controlsRef.current) {
        controlsRef.current.enabled = false;
      }
      setControlsLocked(true);
      setActiveViewerMode(type);

      let animation: ViewerAnimation;

      switch (type) {
        case "front":
          // 카메라를 프론트로 이동 (z=200)
          setCameraPosition({ x: 0, y: 0, z: 200 });
          controlsRef.current?.target.set(0, 0, 0);

          // Z 슬라이스가 뒤에서 앞으로 점점 나타남 (zMax가 점점 증가)
          animation = {
            type,
            startTime: performance.now(),
            duration: CONFIG.ANIMATION_DURATION,
            startValues: {
              zMin: zMinFull,
              zMax: zMinFull, // 처음엔 아무것도 안보임
              xMin: xMinAll,
              xMax: xMaxAll,
              yMin: yMinAll,
              yMax: yMaxAll,
              zoom: 1, // 고정
              pointSize: 6, // 시작 포인트 사이즈
            },
            targetValues: {
              zMin: zMinFull,
              zMax: zMaxFull, // 전체가 보임
              xMin: xMinAll,
              xMax: xMaxAll,
              yMin: yMinAll,
              yMax: yMaxAll,
              zoom: 1, // 고정 (시작과 동일)
              pointSize: 2.6, // 종료 포인트 사이즈
            },
          };
          break;

        case "side":
          // Side 전용 설정: spacing 1, zoom 0.95 고정, pointSize 6 -> 2.3
          setSpacing(1);

          // 카메라를 오른쪽으로 이동
          setCameraPosition({ x: CONFIG.CAMERA_DISTANCE, y: 0, z: 0 });
          controlsRef.current?.target.set(0, 0, 0);

          // X 슬라이스가 왼쪽에서 오른쪽으로 점점 나타남
          // spacing 1 사용
          const sideZMinFull = zMinBase * 1;
          const sideZMaxFull = zMaxBase * 1;

          animation = {
            type,
            startTime: performance.now(),
            duration: CONFIG.ANIMATION_DURATION,
            startValues: {
              zMin: sideZMinFull,
              zMax: sideZMaxFull,
              xMin: xMinAll,
              xMax: xMinAll, // 처음엔 아무것도 안보임
              yMin: yMinAll,
              yMax: yMaxAll,
              zoom: 0.95, // 고정
              pointSize: 6, // 시작 포인트 사이즈
            },
            targetValues: {
              zMin: sideZMinFull,
              zMax: sideZMaxFull,
              xMin: xMinAll,
              xMax: xMaxAll, // 전체가 보임
              yMin: yMinAll,
              yMax: yMaxAll,
              zoom: 0.95, // 고정 (시작과 동일)
              pointSize: 2.3, // 종료 포인트 사이즈
            },
          };
          break;

        case "top":
          // 카메라를 위로 이동
          setCameraPosition({ x: 0, y: CONFIG.CAMERA_DISTANCE, z: 0 });
          controlsRef.current?.target.set(0, 0, 0);

          // Y 슬라이스가 아래에서 위로 점점 나타남
          animation = {
            type,
            startTime: performance.now(),
            duration: CONFIG.ANIMATION_DURATION,
            startValues: {
              zMin: zMinFull,
              zMax: zMaxFull,
              xMin: xMinAll,
              xMax: xMaxAll,
              yMin: yMinAll,
              yMax: yMinAll, // 처음엔 아무것도 안보임
              zoom: 1, // 고정
              pointSize: CONFIG.DEFAULT_POINT_SIZE, // 고정
            },
            targetValues: {
              zMin: zMinFull,
              zMax: zMaxFull,
              xMin: xMinAll,
              xMax: xMaxAll,
              yMin: yMinAll,
              yMax: yMaxAll, // 전체가 보임
              zoom: 1, // 고정 (시작과 동일)
              pointSize: CONFIG.DEFAULT_POINT_SIZE, // 고정 (시작과 동일)
            },
          };
          break;

        default:
          return;
      }

      viewerAnimationRef.current = animation;
      setIsViewerAnimating(true);
      runViewerAnimationLoop();
    },
    [spacing, stopViewerAnimation, runViewerAnimationLoop]
  );

  // === Effects ===
  // Three.js 초기화
  useEffect(() => {
    if (!mountRef.current) return;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(
      mountRef.current.clientWidth,
      mountRef.current.clientHeight
    );
    renderer.setClearColor(0x000000, 0);
    mountRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    scene.background = null;
    sceneRef.current = scene;

    configureCamera(initialCameraModeRef.current);

    const onResize = () => {
      if (!rendererRef.current || !cameraRef.current || !mountRef.current)
        return;
      const w = mountRef.current.clientWidth;
      const h = mountRef.current.clientHeight;
      rendererRef.current.setSize(w, h);
      const aspect = w / Math.max(h, 1);

      if (cameraRef.current instanceof THREE.PerspectiveCamera) {
        cameraRef.current.aspect = aspect;
      } else if (cameraRef.current instanceof THREE.OrthographicCamera) {
        const frustumHeight = orthoSizeRef.current;
        const frustumWidth = frustumHeight * aspect;
        cameraRef.current.left = -frustumWidth / 2;
        cameraRef.current.right = frustumWidth / 2;
        cameraRef.current.top = frustumHeight / 2;
        cameraRef.current.bottom = -frustumHeight / 2;
      }
      cameraRef.current.updateProjectionMatrix();
    };
    window.addEventListener("resize", onResize);

    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      controlsRef.current?.update();
      const camera = cameraRef.current;
      if (camera) {
        renderer.render(scene, camera);
      }
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);

      if (pointsRef.current) {
        pointsRef.current.geometry.dispose();
        (pointsRef.current.material as THREE.Material).dispose();
        scene.remove(pointsRef.current);
        pointsRef.current = null;
      }

      const controls = controlsRef.current;
      if (controls) {
        controls.removeEventListener("change", updateCameraPositionState);
        controls.dispose();
      }
      renderer.dispose();

      if (renderer.domElement?.parentElement) {
        renderer.domElement.parentElement.removeChild(renderer.domElement);
      }

      scene.clear();
      sceneRef.current = null;
      cameraRef.current = null;
      rendererRef.current = null;
      controlsRef.current = null;
    };
  }, [configureCamera, updateCameraPositionState]);

  // 비디오 자동 로드 (zelda.mp4)
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.src = "/zelda.mp4";
      videoRef.current.load();
      setStatus("비디오 로드 완료. 샘플링을 실행하세요.");
    }
  }, []);

  // 카메라 위치 동기화
  useEffect(() => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;

    if (
      Math.abs(camera.position.x - cameraPosition.x) < 1e-4 &&
      Math.abs(camera.position.y - cameraPosition.y) < 1e-4 &&
      Math.abs(camera.position.z - cameraPosition.z) < 1e-4
    ) {
      return;
    }

    camera.position.set(cameraPosition.x, cameraPosition.y, cameraPosition.z);
    camera.lookAt(controls.target);
    controls.update();
  }, [cameraPosition]);

  // 줌 동기화
  useEffect(() => {
    const camera = cameraRef.current;
    if (!camera) return;
    const z = Math.max(0.01, cameraZoom);
    if (Math.abs(camera.zoom - z) < 1e-4) return;
    camera.zoom = z;
    camera.updateProjectionMatrix();
    controlsRef.current?.update();
  }, [cameraZoom]);

  // Uniform 업데이트
  useEffect(() => {
    if (materialRef.current) {
      materialRef.current.uniforms.uZScale.value = spacing;
      materialRef.current.needsUpdate = true;
    }
  }, [spacing]);

  useEffect(() => {
    if (materialRef.current) {
      materialRef.current.uniforms.uSize.value = pointSize;
      materialRef.current.needsUpdate = true;
    }
  }, [pointSize]);

  useEffect(() => {
    if (materialRef.current) {
      materialRef.current.uniforms.uOpacity.value = opacity;
      materialRef.current.transparent = true;
      materialRef.current.depthWrite = true;
      materialRef.current.needsUpdate = true;
    }
  }, [opacity]);

  useEffect(() => {
    if (materialRef.current) {
      materialRef.current.uniforms.uAttenuate.value = sizeAttenuation;
      materialRef.current.needsUpdate = true;
    }
  }, [sizeAttenuation]);

  useEffect(() => {
    if (materialRef.current) {
      materialRef.current.uniforms.uXRange.value.set(xMin, xMax);
      materialRef.current.needsUpdate = true;
    }
  }, [xMin, xMax]);

  useEffect(() => {
    if (materialRef.current) {
      materialRef.current.uniforms.uYRange.value.set(yMin, yMax);
      materialRef.current.needsUpdate = true;
    }
  }, [yMin, yMax]);

  useEffect(() => {
    if (materialRef.current) {
      materialRef.current.uniforms.uZRange.value.set(zMin, zMax);
      materialRef.current.needsUpdate = true;
    }
  }, [zMin, zMax]);

  useEffect(() => {
    if (rendererRef.current) {
      configureCamera(useOrthographic);
    }
  }, [configureCamera, useOrthographic]);

  // Spacing 변경 시 Z 슬라이스 범위 조정
  useEffect(() => {
    const { zMinBase, zMaxBase } = extentsRef.current;
    const minLegal = zMinBase * spacing;
    const maxLegal = zMaxBase * spacing;
    setZMin((prev) => (prev < minLegal ? minLegal : prev));
    setZMax((prev) => (prev > maxLegal ? maxLegal : prev));
  }, [spacing]);

  // === UI Styles ===
  const buttonStyle = {
    background: "rgba(0,0,0,.6)",
    color: "#eee",
    border: "1px solid rgba(255,255,255,.25)",
    borderRadius: 6,
    padding: "6px 10px",
    cursor: "pointer",
  };

  // === Render ===
  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        background: "transparent",
        color: "#eee",
      }}
    >
      {/* UI 토글 버튼 */}
      <button
        onClick={() => setShowUI((prev) => !prev)}
        style={{
          position: "fixed",
          top: 10,
          right: 10,
          zIndex: 20,
          background: showUI ? "rgba(0,0,0,.6)" : "transparent",
          color: showUI ? "#eee" : "transparent",
          border: showUI
            ? "1px solid rgba(255,255,255,.25)"
            : "1px solid transparent",
          borderRadius: 6,
          padding: "6px 10px",
          cursor: "pointer",
        }}
      >
        {showUI ? "UI 숨기기" : "UI 보이기"}
      </button>

      {/* 관람자 컨트롤 버튼 (항상 표시, 중앙 하단) */}
      <div
        style={{
          position: "fixed",
          bottom: 20,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 30,
          display: "flex",
          gap: 8,
        }}
      >
        <button
          onClick={() => startViewerAnimation("front")}
          disabled={isViewerAnimating}
          style={{
            padding: "12px 20px",
            fontSize: 14,
            fontWeight: "bold",
            background:
              isViewerAnimating && activeViewerMode === "front"
                ? "#2a7"
                : "rgba(0,0,0,.7)",
            color: "#fff",
            border:
              isViewerAnimating && activeViewerMode === "front"
                ? "2px solid #4f9"
                : "2px solid rgba(255,255,255,.3)",
            borderRadius: 10,
            cursor: isViewerAnimating ? "not-allowed" : "pointer",
            opacity:
              isViewerAnimating && activeViewerMode !== "front" ? 0.5 : 1,
            transition: "all 0.2s ease",
            boxShadow:
              isViewerAnimating && activeViewerMode === "front"
                ? "0 0 20px rgba(68, 255, 153, 0.4)"
                : "0 4px 12px rgba(0,0,0,.4)",
          }}
        >
          Front
        </button>
        <button
          onClick={() => startViewerAnimation("side")}
          disabled={isViewerAnimating}
          style={{
            padding: "12px 20px",
            fontSize: 14,
            fontWeight: "bold",
            background:
              isViewerAnimating && activeViewerMode === "side"
                ? "#27a"
                : "rgba(0,0,0,.7)",
            color: "#fff",
            border:
              isViewerAnimating && activeViewerMode === "side"
                ? "2px solid #4af"
                : "2px solid rgba(255,255,255,.3)",
            borderRadius: 10,
            cursor: isViewerAnimating ? "not-allowed" : "pointer",
            opacity: isViewerAnimating && activeViewerMode !== "side" ? 0.5 : 1,
            transition: "all 0.2s ease",
            boxShadow:
              isViewerAnimating && activeViewerMode === "side"
                ? "0 0 20px rgba(68, 170, 255, 0.4)"
                : "0 4px 12px rgba(0,0,0,.4)",
          }}
        >
          Side
        </button>
        <button
          onClick={() => startViewerAnimation("top")}
          disabled={isViewerAnimating}
          style={{
            padding: "12px 20px",
            fontSize: 14,
            fontWeight: "bold",
            background:
              isViewerAnimating && activeViewerMode === "top"
                ? "#a72"
                : "rgba(0,0,0,.7)",
            color: "#fff",
            border:
              isViewerAnimating && activeViewerMode === "top"
                ? "2px solid #fa4"
                : "2px solid rgba(255,255,255,.3)",
            borderRadius: 10,
            cursor: isViewerAnimating ? "not-allowed" : "pointer",
            opacity: isViewerAnimating && activeViewerMode !== "top" ? 0.5 : 1,
            transition: "all 0.2s ease",
            boxShadow:
              isViewerAnimating && activeViewerMode === "top"
                ? "0 0 20px rgba(255, 170, 68, 0.4)"
                : "0 4px 12px rgba(0,0,0,.4)",
          }}
        >
          Top
        </button>
      </div>

      {/* 컨트롤 패널 */}
      {showUI && (
        <div
          style={{
            position: "fixed",
            top: 10,
            left: 10,
            zIndex: 10,
            background: "rgba(0,0,0,.5)",
            padding: "10px 12px",
            borderRadius: 8,
            display: "grid",
            gridTemplateColumns: "auto 1fr auto",
            gap: 8,
            alignItems: "center",
          }}
        >
          {/* 고정 비디오: zelda.mp4 */}
          <div style={{ gridColumn: "1 / -1", color: "#8cf", fontSize: 11 }}>
            🎬 zelda.mp4
          </div>

          {/* 해상도 설정 */}
          <label>W×H</label>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              type="number"
              value={targetW}
              min={8}
              step={8}
              style={{ width: 70 }}
              onChange={(e) =>
                setTargetW(parseInt(e.currentTarget.value || "128", 10))
              }
            />
            <input
              type="number"
              value={targetH}
              min={8}
              step={8}
              style={{ width: 70 }}
              onChange={(e) =>
                setTargetH(parseInt(e.currentTarget.value || "72", 10))
              }
            />
          </div>

          <label>Frames</label>
          <input
            type="number"
            value={targetFrames}
            min={2}
            step={1}
            style={{ width: 70 }}
            onChange={(e) =>
              setTargetFrames(parseInt(e.currentTarget.value || "60", 10))
            }
          />
          <span />

          {/* 카메라 설정 */}
          <label>카메라</label>
          <button
            onClick={() => setUseOrthographic((prev) => !prev)}
            style={{ ...buttonStyle, gridColumn: "2 / -1", textAlign: "left" }}
          >
            {useOrthographic ? "직교 (Orthographic)" : "원근 (Perspective)"}
          </button>

          <span />
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 6,
              gridColumn: "2 / -1",
            }}
          >
            {(
              [
                "front",
                "back",
                "left",
                "right",
                "top",
                "bottom",
              ] as CameraDirection[]
            ).map((dir) => (
              <button
                key={dir}
                onClick={() => moveCameraTo(dir)}
                style={buttonStyle}
              >
                {dir.charAt(0).toUpperCase() + dir.slice(1)}
              </button>
            ))}
          </div>

          {/* 카메라 위치 슬라이더 */}
          {(["x", "y", "z"] as const).map((axis) => (
            <React.Fragment key={axis}>
              <label>카메라 {axis.toUpperCase()}</label>
              <input
                type="range"
                min={-CONFIG.CAMERA_RANGE}
                max={CONFIG.CAMERA_RANGE}
                step={1}
                value={cameraPosition[axis]}
                onChange={(e) =>
                  setCameraPositionAxis(axis, parseFloat(e.currentTarget.value))
                }
              />
              <input
                type="number"
                min={-CONFIG.CAMERA_RANGE}
                max={CONFIG.CAMERA_RANGE}
                step={1}
                value={cameraPosition[axis]}
                onChange={(e) => {
                  const v = parseFloat(e.currentTarget.value);
                  if (!Number.isNaN(v)) {
                    setCameraPositionAxis(
                      axis,
                      clamp(v, -CONFIG.CAMERA_RANGE, CONFIG.CAMERA_RANGE)
                    );
                  }
                }}
                style={{ width: 70 }}
              />
            </React.Fragment>
          ))}

          <label>Zoom</label>
          <input
            type="range"
            min={0.1}
            max={10}
            step={0.05}
            value={cameraZoom}
            onChange={(e) => setCameraZoom(parseFloat(e.currentTarget.value))}
          />
          <span style={{ opacity: 0.8 }}>{cameraZoom.toFixed(2)}</span>

          {/* 비주얼 설정 */}
          <label>Spacing (z)</label>
          <input
            type="range"
            min={0.1}
            max={10}
            step={0.1}
            value={spacing}
            onChange={(e) => setSpacing(parseFloat(e.currentTarget.value))}
          />
          <span style={{ opacity: 0.8 }}>{spacing.toFixed(1)}</span>

          <label>Point Size</label>
          <input
            type="range"
            min={0.1}
            max={20}
            step={0.1}
            value={pointSize}
            onChange={(e) => setPointSize(parseFloat(e.currentTarget.value))}
          />
          <span style={{ opacity: 0.8 }}>{pointSize.toFixed(1)}</span>

          <label>Opacity</label>
          <input
            type="range"
            min={0.05}
            max={1}
            step={0.05}
            value={opacity}
            onChange={(e) => setOpacity(parseFloat(e.currentTarget.value))}
          />
          <span style={{ opacity: 0.8 }}>{opacity.toFixed(2)}</span>

          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={sizeAttenuation}
              onChange={(e) => setSizeAttenuation(e.currentTarget.checked)}
            />
            sizeAttenuation
          </label>
          <span />
          <span />

          {/* 슬라이스 설정 */}
          <label>X slice</label>
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}
          >
            <input
              type="range"
              min={extentsRef.current.xMinAll}
              max={extentsRef.current.xMaxAll}
              step={1}
              value={xMin}
              onChange={(e) =>
                setXMin(
                  clamp(
                    parseFloat(e.currentTarget.value),
                    extentsRef.current.xMinAll,
                    xMax
                  )
                )
              }
            />
            <input
              type="range"
              min={extentsRef.current.xMinAll}
              max={extentsRef.current.xMaxAll}
              step={1}
              value={xMax}
              onChange={(e) =>
                setXMax(
                  clamp(
                    parseFloat(e.currentTarget.value),
                    xMin,
                    extentsRef.current.xMaxAll
                  )
                )
              }
            />
          </div>
          <span style={{ opacity: 0.8 }}>
            {xMin.toFixed(0)} ~ {xMax.toFixed(0)}
          </span>

          <label>Y slice</label>
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}
          >
            <input
              type="range"
              min={extentsRef.current.yMinAll}
              max={extentsRef.current.yMaxAll}
              step={1}
              value={yMin}
              onChange={(e) =>
                setYMin(
                  clamp(
                    parseFloat(e.currentTarget.value),
                    extentsRef.current.yMinAll,
                    yMax
                  )
                )
              }
            />
            <input
              type="range"
              min={extentsRef.current.yMinAll}
              max={extentsRef.current.yMaxAll}
              step={1}
              value={yMax}
              onChange={(e) =>
                setYMax(
                  clamp(
                    parseFloat(e.currentTarget.value),
                    yMin,
                    extentsRef.current.yMaxAll
                  )
                )
              }
            />
          </div>
          <span style={{ opacity: 0.8 }}>
            {yMin.toFixed(0)} ~ {yMax.toFixed(0)}
          </span>

          <label>Z slice</label>
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}
          >
            <input
              type="range"
              min={extentsRef.current.zMinBase * spacing}
              max={extentsRef.current.zMaxBase * spacing}
              step={0.5}
              value={zMin}
              onChange={(e) =>
                setZMin(
                  clamp(
                    parseFloat(e.currentTarget.value),
                    extentsRef.current.zMinBase * spacing,
                    zMax
                  )
                )
              }
            />
            <input
              type="range"
              min={extentsRef.current.zMinBase * spacing}
              max={extentsRef.current.zMaxBase * spacing}
              step={0.5}
              value={zMax}
              onChange={(e) =>
                setZMax(
                  clamp(
                    parseFloat(e.currentTarget.value),
                    zMin,
                    extentsRef.current.zMaxBase * spacing
                  )
                )
              }
            />
          </div>
          <span style={{ opacity: 0.8 }}>
            {zMin.toFixed(1)} ~ {zMax.toFixed(1)}
          </span>

          {/* 액션 버튼 */}
          <button
            onClick={async () => {
              try {
                if (!videoRef.current?.src) {
                  log("먼저 비디오를 선택해 주세요.");
                  return;
                }
                log(
                  `샘플링 시작: ${targetW}×${targetH}, ${targetFrames} frames`
                );
                const buffers = await sampleVideoToBuffers();
                visualize(buffers);
                append("시각화 완료.");
              } catch (err: unknown) {
                append(
                  "에러: " + (err instanceof Error ? err.message : String(err))
                );
              }
            }}
            style={{ gridColumn: "1 / -1" }}
          >
            샘플링 & 렌더
          </button>

          <button onClick={disposePoints}>초기화</button>

          <button
            onClick={() => saveCanvasAsPNG("capture.png")}
            style={{ gridColumn: "1 / -1" }}
          >
            PNG로 저장
          </button>

          {/* PLY 저장 버튼 */}
          <div
            style={{
              gridColumn: "1 / -1",
              borderTop: "1px solid rgba(255,255,255,0.2)",
              paddingTop: 8,
              marginTop: 4,
            }}
          >
            <div style={{ color: "#8cf", fontSize: 11, marginBottom: 6 }}>
              💾 포인트 클라우드 저장 (PLY)
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                onClick={() => savePLYAscii()}
                disabled={!positionsRef.current}
                style={{
                  flex: 1,
                  background: positionsRef.current
                    ? "rgba(40,100,40,.8)"
                    : "rgba(60,60,60,.5)",
                  color: "#eee",
                  border: "1px solid rgba(255,255,255,.25)",
                  borderRadius: 6,
                  padding: "6px 12px",
                  cursor: positionsRef.current ? "pointer" : "not-allowed",
                }}
              >
                PLY (ASCII)
              </button>
              <button
                onClick={() => savePLYBinary()}
                disabled={!positionsRef.current}
                style={{
                  flex: 1,
                  background: positionsRef.current
                    ? "rgba(40,80,120,.8)"
                    : "rgba(60,60,60,.5)",
                  color: "#eee",
                  border: "1px solid rgba(255,255,255,.25)",
                  borderRadius: 6,
                  padding: "6px 12px",
                  cursor: positionsRef.current ? "pointer" : "not-allowed",
                }}
              >
                PLY (Binary)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 상태 로그 */}
      {showUI && (
        <pre
          style={{
            position: "fixed",
            bottom: 10,
            left: 10,
            right: 10,
            zIndex: 10,
            background: "rgba(0,0,0,.4)",
            padding: "8px 10px",
            borderRadius: 8,
            fontSize: 12,
            whiteSpace: "pre-wrap",
            maxHeight: "28vh",
            overflow: "auto",
          }}
        >
          {status}
        </pre>
      )}

      {/* Hidden 요소 */}
      <canvas ref={hiddenCanvasRef} style={{ display: "none" }} />
      <video ref={videoRef} muted playsInline style={{ display: "none" }} />

      {/* Three.js 마운트 */}
      <div ref={mountRef} style={{ position: "absolute", inset: 0 }} />
    </div>
  );
}

// React import for Fragment
import React from "react";
