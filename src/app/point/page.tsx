"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

// ============================================================================
// 설정값 임포트
// - 모든 기본값, 범위, 고정 상수들이 정의되어 있음
// - UI 슬라이더와 연동되는 설정값들의 단일 진실 공급원 (Single Source of Truth)
// ============================================================================
import {
  SAMPLING_CONFIG, // 샘플링 해상도 및 프레임 수 설정
  VISUAL_CONFIG, // 포인트 크기, 투명도, 간격 등 시각적 설정
  MOUSE_CONFIG, // 마우스 인터랙션/Fluid 효과 설정
  JITTER_CONFIG, // 랜덤 움직임 (Jitter/Wiggle) 설정
  CAMERA_CONFIG, // 카메라 FOV, 클리핑, 초기 위치 설정
  RENDERER_CONFIG, // WebGL 렌더러 설정
  SLICE_CONFIG, // XYZ 슬라이스 기본 범위
  PLY_EXPORT_CONFIG, // PLY 파일 내보내기 설정
} from "./config";

// ============================================================================
// 셰이더 임포트
// - vertexShader: 위치 계산, 색상 샘플링, 마우스 인터랙션, 슬라이싱
// - fragmentShader: 최종 색상 출력, 마스킹 적용
// ============================================================================
import { vertexShader, fragmentShader } from "./shaders";

// ============================================================================
// 유틸리티 함수 임포트
// - clamp: 값을 범위 내로 제한
// - calcTotalPoints: 총 포인트 수 계산 (width × height × frames)
// - createPLYDataASCII/Binary: PLY 파일 데이터 생성
// - downloadPLYAscii/Binary: 파일 다운로드 트리거
// - captureAndDownloadCanvas: 스크린샷 캡처
// ============================================================================
import {
  clamp,
  calcTotalPoints,
  createPLYDataASCII,
  createPLYDataBinary,
  downloadPLYAscii,
  downloadPLYBinary,
  captureAndDownloadCanvas,
  formatFileSize,
} from "./utils";

/**
 * Point Cloud 최적화 페이지
 *
 * 웹캠 영상을 실시간으로 3D 포인트 클라우드로 시각화합니다.
 *
 * 최적화 기술:
 * 1. Ring Buffer - 프레임 데이터 시프트 없이 인덱스만 이동 (O(n) → O(1))
 * 2. DataTexture - GPU에서 직접 색상 샘플링, CPU-GPU 전송 최소화
 * 3. Simplex Noise - 셰이더 내 Fluid 효과로 자연스러운 움직임
 *
 * @module PointPage
 */
export default function PointPage() {
  // ==========================================================================
  // Three.js 오브젝트 참조 (Refs)
  // - DOM 마운트, 렌더러, 씬, 카메라, 컨트롤, 포인트 오브젝트
  // ==========================================================================
  const mountRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | THREE.OrthographicCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const pointsRef = useRef<THREE.Points | null>(null);
  const materialRef = useRef<THREE.ShaderMaterial | null>(null);

  // ==========================================================================
  // 비디오 캡처용 DOM 참조
  // - hiddenCanvas: 비디오 프레임을 이미지 데이터로 추출
  // - video: 웹캠 스트림 재생
  // ==========================================================================
  const hiddenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // ==========================================================================
  // UI 상태 (State)
  // ==========================================================================
  const [status, setStatus] = useState<string>("웹캠 시작 버튼을 눌러 주세요.");
  const [isCapturing, setIsCapturing] = useState<boolean>(false);
  const [showUI, setShowUI] = useState<boolean>(true);

  // ==========================================================================
  // 카메라 설정 (직교/퍼스펙티브, 위치, 줌)
  // ==========================================================================
  const [useOrthographic, setUseOrthographic] = useState<boolean>(false);
  const [cameraPosition, setCameraPosition] = useState<{
    x: number;
    y: number;
    z: number;
  }>({ x: 0, y: 0, z: CAMERA_CONFIG.INITIAL_Z });
  const [cameraZoom, setCameraZoom] = useState<number>(1);
  const [autoRotate, setAutoRotate] = useState<boolean>(
    CAMERA_CONFIG.DEFAULT_AUTO_ROTATE
  );
  const [autoRotateSpeed, setAutoRotateSpeed] = useState<number>(
    CAMERA_CONFIG.DEFAULT_AUTO_ROTATE_SPEED
  );

  // ==========================================================================
  // 샘플링 설정 (config.ts의 SAMPLING_CONFIG 기본값 사용)
  // - targetW/H: 캡처 해상도 (낮을수록 성능 향상)
  // - targetFrames: 시간 축 깊이 (Ring buffer 크기)
  // ==========================================================================
  const [targetW, setTargetW] = useState<number>(SAMPLING_CONFIG.DEFAULT_WIDTH);
  const [targetH, setTargetH] = useState<number>(
    SAMPLING_CONFIG.DEFAULT_HEIGHT
  );
  const [targetFrames, setTargetFrames] = useState<number>(
    SAMPLING_CONFIG.DEFAULT_FRAMES
  );

  // ==========================================================================
  // 시각적 설정 (config.ts의 VISUAL_CONFIG 기본값 사용)
  // - spacing: 프레임 간 Z 간격
  // - pointSize: 포인트 렌더링 크기
  // - opacity: 투명도
  // - sizeAttenuation: 거리에 따른 크기 감쇠
  // ==========================================================================
  const [spacing, setSpacing] = useState<number>(VISUAL_CONFIG.DEFAULT_SPACING);
  const [pointSize, setPointSize] = useState<number>(
    VISUAL_CONFIG.DEFAULT_POINT_SIZE
  );
  const [opacity, setOpacity] = useState<number>(VISUAL_CONFIG.DEFAULT_OPACITY);
  const [sizeAttenuation, setSizeAttenuation] = useState<boolean>(
    VISUAL_CONFIG.DEFAULT_SIZE_ATTENUATION
  );

  // ==========================================================================
  // 슬라이스 범위 (config.ts의 SLICE_CONFIG 기본값 사용)
  // - 특정 XYZ 범위의 포인트만 표시
  // ==========================================================================
  const [xMin, setXMin] = useState<number>(SLICE_CONFIG.DEFAULT_X_MIN);
  const [xMax, setXMax] = useState<number>(SLICE_CONFIG.DEFAULT_X_MAX);
  const [yMin, setYMin] = useState<number>(SLICE_CONFIG.DEFAULT_Y_MIN);
  const [yMax, setYMax] = useState<number>(SLICE_CONFIG.DEFAULT_Y_MAX);
  const [zMin, setZMin] = useState<number>(SLICE_CONFIG.DEFAULT_Z_MIN);
  const [zMax, setZMax] = useState<number>(SLICE_CONFIG.DEFAULT_Z_MAX);

  // ==========================================================================
  // 마우스 인터랙션 설정 (config.ts의 MOUSE_CONFIG 기본값 사용)
  // - mouseEnabled: 효과 활성화 여부
  // - mouseRadius: 영향 반경
  // - mouseStrength: 반발 강도
  // ==========================================================================
  const [mouseEnabled, setMouseEnabled] = useState<boolean>(
    MOUSE_CONFIG.DEFAULT_ENABLED
  );
  const [mouseRadius, setMouseRadius] = useState<number>(
    MOUSE_CONFIG.DEFAULT_RADIUS
  );
  const [mouseStrength, setMouseStrength] = useState<number>(
    MOUSE_CONFIG.DEFAULT_STRENGTH
  );

  // ==========================================================================
  // 랜덤 움직임 설정 (config.ts의 JITTER_CONFIG 기본값 사용)
  // - jitterEnabled: 랜덤 움직임 활성화 여부
  // - jitterAmplitude: 움직임 강도 (최대 거리)
  // - jitterSpeed: 움직임 속도
  // - jitterScale: 노이즈 공간 스케일 (주파수)
  // ==========================================================================
  const [jitterEnabled, setJitterEnabled] = useState<boolean>(
    JITTER_CONFIG.DEFAULT_ENABLED
  );
  const [jitterAmplitude, setJitterAmplitude] = useState<number>(
    JITTER_CONFIG.DEFAULT_AMPLITUDE
  );
  const [jitterSpeed, setJitterSpeed] = useState<number>(
    JITTER_CONFIG.DEFAULT_SPEED
  );
  const [jitterScale, setJitterScale] = useState<number>(
    JITTER_CONFIG.DEFAULT_SCALE
  );

  // ==========================================================================
  // 마우스 추적 참조 (Three.js 오브젝트)
  // ==========================================================================
  const mousePos3DRef = useRef<THREE.Vector3>(new THREE.Vector3(0, 0, 0));
  const mousePosScreenRef = useRef<THREE.Vector2>(new THREE.Vector2(0, 0));
  const raycasterRef = useRef<THREE.Raycaster>(new THREE.Raycaster());
  const timeRef = useRef<number>(0);

  // ==========================================================================
  // 슬라이스 범위 Extents (동적으로 업데이트됨)
  // - 샘플링 해상도에 따라 실제 범위가 결정됨
  // ==========================================================================
  const extentsRef = useRef({
    xMinAll: SLICE_CONFIG.DEFAULT_X_MIN,
    xMaxAll: SLICE_CONFIG.DEFAULT_X_MAX,
    yMinAll: SLICE_CONFIG.DEFAULT_Y_MIN,
    yMaxAll: SLICE_CONFIG.DEFAULT_Y_MAX,
    zMinBase: -30,
    zMaxBase: 30,
  });

  // 직교 카메라 크기 참조 (퍼스펙티브 ↔ 직교 전환 시 보존)
  const orthoSizeRef = useRef<number>(200);
  const initialCameraModeRef = useRef<boolean>(false);

  // ==========================================================================
  // 최적화 핵심: Ring Buffer + DataTexture
  // - colorTexture: GPU에서 직접 샘플링하는 색상 텍스처
  // - colorData: CPU 측 색상 데이터 (프레임 업데이트용)
  // - writeIndex: Ring buffer 현재 쓰기 위치
  // ==========================================================================
  const colorTextureRef = useRef<THREE.DataTexture | null>(null);
  const colorDataRef = useRef<Uint8Array | null>(null);
  const writeIndexRef = useRef<number>(0);

  // ==========================================================================
  // 웹캠 캡처 관련 참조
  // ==========================================================================
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const rafRef = useRef<number | null>(null);
  const rvfcRef = useRef<number | null>(null);
  const capturingRef = useRef<boolean>(false);
  const frameCountRef = useRef<number>(0);

  // ==========================================================================
  // requestVideoFrameCallback 지원 여부 확인
  // - 지원 시 비디오 프레임과 동기화된 캡처 가능
  // ==========================================================================
  const hasRVFC = useMemo(
    () =>
      typeof HTMLVideoElement !== "undefined" &&
      "requestVideoFrameCallback" in HTMLVideoElement.prototype,
    []
  );

  // ==========================================================================
  // 카메라 위치/줌 상태 동기화 콜백
  // ==========================================================================
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
    setCameraZoom((prev) => (Math.abs(prev - currentZoom) < 1e-4 ? prev : currentZoom));
  }, []);

  // ==========================================================================
  // 카메라 타입 전환 (퍼스펙티브 ↔ 직교)
  // ==========================================================================
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
          CAMERA_CONFIG.NEAR,
          CAMERA_CONFIG.FAR * 4
        );
        if (previous instanceof THREE.OrthographicCamera) {
          orthoCam.zoom = previous.zoom;
        }
        camera = orthoCam;
      } else {
        let fov: number = CAMERA_CONFIG.FOV;
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
          CAMERA_CONFIG.NEAR,
          CAMERA_CONFIG.FAR
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
        camera.position.set(0, 0, CAMERA_CONFIG.INITIAL_Z);
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
        currentControls.enableDamping = true;
        currentControls.target.copy(target);
        currentControls.update();
      } else {
        const controls = new OrbitControls(
          camera,
          rendererRef.current.domElement
        );
        controls.enableDamping = true;
        controls.addEventListener("change", updateCameraPositionState);
        controlsRef.current = controls;
      }
      updateCameraPositionState();
    },
    [updateCameraPositionState]
  );

  // ==========================================================================
  // 카메라 프리셋 위치 이동
  // ==========================================================================
  const moveCameraTo = useCallback(
    (dir: "front" | "back" | "left" | "right" | "top" | "bottom") => {
      const d = CAMERA_CONFIG.INITIAL_Z;
      let x = 0,
        y = 0,
        z = 0;
      switch (dir) {
        case "front":
          z = d;
          break;
        case "back":
          z = -d;
          break;
        case "left":
          x = -d;
          break;
        case "right":
          x = d;
          break;
        case "top":
          y = d;
          break;
        case "bottom":
          y = -d;
          break;
      }
      setCameraPosition({ x, y, z });
      const controls = controlsRef.current;
      if (controls) {
        controls.target.set(0, 0, 0);
        controls.update();
      }
    },
    []
  );

  // ==========================================================================
  // 카메라 위치 축별 설정
  // ==========================================================================
  const setCameraPositionAxis = useCallback(
    (axis: "x" | "y" | "z", value: number) => {
      setCameraPosition((prev) => {
        if (prev[axis] === value) return prev;
        return { ...prev, [axis]: value };
      });
    },
    []
  );

  // ==========================================================================
  // Three.js 씬 초기화 (마운트 시 1회 실행)
  // ==========================================================================
  useEffect(() => {
    if (!mountRef.current) return;

    // 렌더러 생성 (config 값 사용)
    const renderer = new THREE.WebGLRenderer({
      antialias: RENDERER_CONFIG.ANTIALIAS,
      preserveDrawingBuffer: RENDERER_CONFIG.PRESERVE_DRAWING_BUFFER,
    });
    renderer.setPixelRatio(
      Math.min(window.devicePixelRatio, RENDERER_CONFIG.MAX_PIXEL_RATIO)
    );
    renderer.setSize(
      mountRef.current.clientWidth,
      mountRef.current.clientHeight
    );
    mountRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // 씬 생성
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(RENDERER_CONFIG.BACKGROUND_COLOR);
    sceneRef.current = scene;

    // 카메라 + 컨트롤 생성 (configureCamera 사용)
    configureCamera(initialCameraModeRef.current);

    // 리사이즈 핸들러 (직교/퍼스펙티브 모두 지원)
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

    // 마우스 이동 핸들러 - 3D 위치 계산
    const onMouseMove = (event: MouseEvent) => {
      if (!mountRef.current || !cameraRef.current) return;

      const rect = mountRef.current.getBoundingClientRect();
      // NDC 좌표 계산 (-1 ~ 1)
      const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      mousePosScreenRef.current.set(x, y);

      // Raycaster로 3D 공간에서의 마우스 위치 계산
      raycasterRef.current.setFromCamera(
        mousePosScreenRef.current,
        cameraRef.current
      );

      // Z=0 평면과의 교차점 계산
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
      const intersect = new THREE.Vector3();
      raycasterRef.current.ray.intersectPlane(plane, intersect);

      if (intersect) {
        mousePos3DRef.current.copy(intersect);
      }

      // 셰이더 uniform 업데이트
      if (materialRef.current) {
        materialRef.current.uniforms.uMousePos.value.copy(
          mousePos3DRef.current
        );
        materialRef.current.uniforms.uMouseScreen.value.copy(
          mousePosScreenRef.current
        );
      }
    };

    mountRef.current.addEventListener("mousemove", onMouseMove);
    const currentMount = mountRef.current;

    // 애니메이션 루프
    let raf = 0;
    const startTime = performance.now();
    const loop = () => {
      raf = requestAnimationFrame(loop);
      controlsRef.current?.update();

      // 시간 업데이트 (Fluid 노이즈 애니메이션용)
      timeRef.current = (performance.now() - startTime) / 1000;
      if (materialRef.current) {
        materialRef.current.uniforms.uTime.value = timeRef.current;
      }

      const camera = cameraRef.current;
      if (camera) {
        renderer.render(scene, camera);
      }
    };
    loop();

    // 클린업
    return () => {
      stopCapture({ skipState: true, skipStatus: true });
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      currentMount?.removeEventListener("mousemove", onMouseMove);
      disposePoints();
      const controls = controlsRef.current;
      if (controls) {
        controls.removeEventListener("change", updateCameraPositionState);
        controls.dispose();
      }
      renderer.dispose();
      if (renderer.domElement && renderer.domElement.parentElement) {
        renderer.domElement.parentElement.removeChild(renderer.domElement);
      }
      scene.clear();
      sceneRef.current = null;
      cameraRef.current = null;
      rendererRef.current = null;
      controlsRef.current = null;
    };
  }, [configureCamera, updateCameraPositionState]);

  // ==========================================================================
  // Uniform 업데이트 Effects
  // - 각 설정값 변경 시 셰이더 uniform 동기화
  // ==========================================================================

  useEffect(() => {
    if (!materialRef.current) return;
    materialRef.current.uniforms.uZScale.value = spacing;
    materialRef.current.needsUpdate = true;
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
      materialRef.current.transparent = opacity < 1.0;
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
    if (materialRef.current) {
      materialRef.current.uniforms.uMouseEnabled.value = mouseEnabled;
      materialRef.current.needsUpdate = true;
    }
  }, [mouseEnabled]);

  useEffect(() => {
    if (materialRef.current) {
      materialRef.current.uniforms.uMouseRadius.value = mouseRadius;
      materialRef.current.needsUpdate = true;
    }
  }, [mouseRadius]);

  useEffect(() => {
    if (materialRef.current) {
      materialRef.current.uniforms.uMouseStrength.value = mouseStrength;
      materialRef.current.needsUpdate = true;
    }
  }, [mouseStrength]);

  // Jitter effect uniforms
  useEffect(() => {
    if (materialRef.current) {
      materialRef.current.uniforms.uJitterEnabled.value = jitterEnabled;
      materialRef.current.needsUpdate = true;
    }
  }, [jitterEnabled]);

  useEffect(() => {
    if (materialRef.current) {
      materialRef.current.uniforms.uJitterAmplitude.value = jitterAmplitude;
      materialRef.current.needsUpdate = true;
    }
  }, [jitterAmplitude]);

  useEffect(() => {
    if (materialRef.current) {
      materialRef.current.uniforms.uJitterSpeed.value = jitterSpeed;
      materialRef.current.needsUpdate = true;
    }
  }, [jitterSpeed]);

  useEffect(() => {
    if (materialRef.current) {
      materialRef.current.uniforms.uJitterScale.value = jitterScale;
      materialRef.current.needsUpdate = true;
    }
  }, [jitterScale]);

  // ==========================================================================
  // 카메라 관련 Effects
  // ==========================================================================

  // 카메라 타입 변경 (퍼스펙티브 ↔ 직교)
  useEffect(() => {
    if (!rendererRef.current) return;
    configureCamera(useOrthographic);
  }, [configureCamera, useOrthographic]);

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

  // 카메라 줌 동기화
  useEffect(() => {
    const camera = cameraRef.current;
    if (!camera) return;
    const z = Math.max(0.01, cameraZoom);
    if (Math.abs(camera.zoom - z) < 1e-4) return;
    camera.zoom = z;
    camera.updateProjectionMatrix();
    controlsRef.current?.update();
  }, [cameraZoom]);

  // 자동 회전 설정
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    controls.autoRotate = autoRotate;
  }, [autoRotate]);

  // 자동 회전 속도 설정
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    controls.autoRotateSpeed = autoRotateSpeed;
  }, [autoRotateSpeed]);

  // ==========================================================================
  // 상태 로깅 헬퍼
  // ==========================================================================
  function log(msg: string) {
    setStatus(msg);
  }

  function append(msg: string) {
    setStatus((prev) => (prev ? prev + "\n" + msg : msg));
  }

  // ==========================================================================
  // 포인트 클라우드 정리
  // - 리소스 해제 (geometry, material, texture)
  // ==========================================================================
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
  }

  // ==========================================================================
  // 라이브 포인트 클라우드 초기화
  // - Geometry, Material, DataTexture 생성
  // - Ring buffer 초기화
  // ==========================================================================
  function initLivePoints(): boolean {
    const scene = sceneRef.current;
    const hidden = hiddenCanvasRef.current;
    if (!scene || !hidden) {
      setStatus("Three.js 초기화가 아직 완료되지 않았습니다.");
      return false;
    }

    const pixelsPerFrame = targetW * targetH;
    const totalPoints = calcTotalPoints(targetW, targetH, targetFrames);
    if (totalPoints <= 0) {
      setStatus("타깃 해상도/프레임 수가 올바르지 않습니다.");
      return false;
    }

    // 포지션 및 인덱스 배열 생성
    const positions = new Float32Array(totalPoints * 3);
    const frameIndices = new Float32Array(totalPoints);
    const pixelIndices = new Float32Array(totalPoints);

    const xHalf = (targetW - 1) / 2;
    const yHalf = (targetH - 1) / 2;
    const zHalf = (targetFrames - 1) / 2;

    let i = 0;
    for (let f = 0; f < targetFrames; f++) {
      const zVal = f - zHalf;
      for (let y = 0; y < targetH; y++) {
        const yVal = yHalf - y;
        for (let x = 0; x < targetW; x++) {
          const idx = i * 3;
          positions[idx] = x - xHalf;
          positions[idx + 1] = yVal;
          positions[idx + 2] = zVal;
          frameIndices[i] = f;
          pixelIndices[i] = y * targetW + x;
          i++;
        }
      }
    }

    // Hidden canvas 설정
    hidden.width = targetW;
    hidden.height = targetH;
    const ctx = hidden.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      setStatus("Canvas 컨텍스트를 생성하지 못했습니다.");
      return false;
    }
    ctxRef.current = ctx;

    disposePoints();

    // DataTexture 생성 (Ring buffer 색상 저장)
    // 텍스처 레이아웃: (width, height * frames) - WebGL MAX_TEXTURE_SIZE 제한 고려
    // 기존 (pixelsPerFrame, frames) 방식은 해상도가 높을 때 제한 초과
    const texWidth = targetW;
    const texHeight = targetH * targetFrames;
    const colorData = new Uint8Array(texWidth * texHeight * 4);
    colorData.fill(0);

    const colorTexture = new THREE.DataTexture(
      colorData,
      texWidth,
      texHeight,
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
    geometry.setAttribute(
      "aFrameIndex",
      new THREE.BufferAttribute(frameIndices, 1)
    );
    geometry.setAttribute(
      "aPixelIndex",
      new THREE.BufferAttribute(pixelIndices, 1)
    );

    // Material 생성 (분리된 셰이더 사용)
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: opacity < 1.0,
      depthTest: true,
      depthWrite: opacity >= 1.0,
      uniforms: {
        uSize: { value: pointSize },
        uAttenuate: { value: sizeAttenuation },
        uOpacity: { value: opacity },
        uZScale: { value: spacing },
        uXRange: { value: new THREE.Vector2(xMin, xMax) },
        uYRange: { value: new THREE.Vector2(yMin, yMax) },
        uZRange: { value: new THREE.Vector2(zMin, zMax) },
        uWriteIndex: { value: 0 },
        uTotalFrames: { value: targetFrames },
        uPixelsPerFrame: { value: pixelsPerFrame },
        // 새로운 텍스처 레이아웃을 위한 uniform
        uTexWidth: { value: targetW },
        uTexHeight: { value: targetH },
        uColorTex: { value: colorTexture },
        uMouseEnabled: { value: mouseEnabled },
        uMousePos: { value: new THREE.Vector3(0, 0, 0) },
        uMouseScreen: { value: new THREE.Vector2(0, 0) },
        uMouseRadius: { value: mouseRadius },
        uMouseStrength: { value: mouseStrength },
        uTime: { value: 0 },
        // Jitter (랜덤 움직임) uniforms
        uJitterEnabled: { value: jitterEnabled },
        uJitterAmplitude: { value: jitterAmplitude },
        uJitterSpeed: { value: jitterSpeed },
        uJitterScale: { value: jitterScale },
      },
    });

    // Points 오브젝트 생성 및 씬에 추가
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    scene.add(points);

    pointsRef.current = points;
    materialRef.current = material;

    // Extents 업데이트 (슬라이서 범위)
    extentsRef.current.xMinAll = -xHalf;
    extentsRef.current.xMaxAll = xHalf;
    extentsRef.current.yMinAll = -yHalf;
    extentsRef.current.yMaxAll = yHalf;
    extentsRef.current.zMinBase = -zHalf;
    extentsRef.current.zMaxBase = zHalf;

    // 슬라이스 범위 초기화
    setXMin(-xHalf);
    setXMax(xHalf);
    setYMin(-yHalf);
    setYMax(yHalf);
    setZMin(-zHalf * spacing);
    setZMax(zHalf * spacing);

    // 카메라 위치 리셋
    cameraRef.current?.position.set(0, 0, CAMERA_CONFIG.INITIAL_Z);
    controlsRef.current?.target.set(0, 0, 0);
    controlsRef.current?.update();

    frameCountRef.current = 0;
    return true;
  }

  // ==========================================================================
  // 프레임 처리 (Ring Buffer 업데이트)
  // - 웹캠에서 프레임 캡처
  // - 색상 데이터를 Ring buffer의 현재 위치에 기록
  // - O(pixelsPerFrame) 복잡도 (전체 복사 없음)
  // ==========================================================================
  const processFrame = () => {
    if (!capturingRef.current) return;

    const video = videoRef.current;
    const ctx = ctxRef.current;
    const colorData = colorDataRef.current;
    const colorTexture = colorTextureRef.current;
    const material = materialRef.current;

    if (!video || !ctx || !colorData || !colorTexture || !material) return;

    const writeIndex = writeIndexRef.current;

    // 비디오 프레임 캡처
    ctx.drawImage(video, 0, 0, targetW, targetH);
    const { data } = ctx.getImageData(0, 0, targetW, targetH);

    // 새로운 텍스처 레이아웃: (width, height * frames)
    // writeIndex번째 프레임은 Y 좌표 (writeIndex * targetH) ~ ((writeIndex + 1) * targetH - 1) 영역에 저장
    const frameYOffset = writeIndex * targetH;
    for (let y = 0; y < targetH; y++) {
      for (let x = 0; x < targetW; x++) {
        const srcBase = (y * targetW + x) * 4;
        const dstBase = ((frameYOffset + y) * targetW + x) * 4;
        colorData[dstBase] = data[srcBase]; // R
        colorData[dstBase + 1] = data[srcBase + 1]; // G
        colorData[dstBase + 2] = data[srcBase + 2]; // B
        colorData[dstBase + 3] = 255; // A
      }
    }

    // GPU 텍스처 업데이트
    colorTexture.needsUpdate = true;

    // Ring buffer 인덱스 순환
    writeIndexRef.current = (writeIndex + 1) % targetFrames;

    // 셰이더에 writeIndex 전달
    material.uniforms.uWriteIndex.value = writeIndexRef.current;

    frameCountRef.current += 1;
    if (frameCountRef.current % 30 === 0) {
      setStatus(`라이브 업데이트 중... (${frameCountRef.current} frames)`);
    }
  };

  // ==========================================================================
  // 다음 프레임 스케줄링
  // - requestVideoFrameCallback 지원 시 비디오와 동기화
  // - 미지원 시 requestAnimationFrame 폴백
  // ==========================================================================
  const scheduleNextFrame = () => {
    if (!capturingRef.current) return;
    const video = videoRef.current;
    if (!video) return;

    if (
      hasRVFC &&
      typeof (
        video as HTMLVideoElement & {
          requestVideoFrameCallback?: (callback: () => void) => number;
        }
      ).requestVideoFrameCallback === "function"
    ) {
      rvfcRef.current = (
        video as HTMLVideoElement & {
          requestVideoFrameCallback: (callback: () => void) => number;
        }
      ).requestVideoFrameCallback(() => {
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

  // ==========================================================================
  // 캡처 시작
  // - 웹캠 스트림 획득
  // - 포인트 클라우드 초기화
  // - 프레임 캡처 루프 시작
  // ==========================================================================
  async function startCapture() {
    if (capturingRef.current) return;
    try {
      log("웹캠 접근을 요청하는 중...");
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

      if (!initLivePoints()) {
        throw new Error("포인트 클라우드 초기화에 실패했습니다.");
      }

      capturingRef.current = true;
      setIsCapturing(true);
      setStatus("라이브 캡처가 시작되었습니다. (Point Cloud 최적화 버전)");
      scheduleNextFrame();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus(`오류 발생: ${message}`);
      stopCapture({ skipState: true, skipStatus: true });
    }
  }

  // ==========================================================================
  // 캡처 중지
  // - 프레임 캡처 루프 중단
  // - 웹캠 스트림 해제
  // ==========================================================================
  function stopCapture(
    options: { skipState?: boolean; skipStatus?: boolean } = {}
  ) {
    const { skipState = false, skipStatus = false } = options;
    capturingRef.current = false;
    if (!skipState) setIsCapturing(false);

    const video = videoRef.current;
    if (video) {
      if (
        rvfcRef.current !== null &&
        typeof (
          video as HTMLVideoElement & {
            cancelVideoFrameCallback?: (handle: number) => void;
          }
        ).cancelVideoFrameCallback === "function"
      ) {
        (
          video as HTMLVideoElement & {
            cancelVideoFrameCallback: (handle: number) => void;
          }
        ).cancelVideoFrameCallback(rvfcRef.current);
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

    rvfcRef.current = null;

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    ctxRef.current = null;

    if (!skipStatus) {
      append("라이브 캡처가 중지되었습니다.");
    }
  }

  // ==========================================================================
  // Spacing 변경 시 Z 슬라이스 범위 자동 조정
  // ==========================================================================
  useEffect(() => {
    const { zMinBase, zMaxBase } = extentsRef.current;
    const minLegal = zMinBase * spacing;
    const maxLegal = zMaxBase * spacing;
    setZMin((prev) => (prev < minLegal ? minLegal : prev));
    setZMax((prev) => (prev > maxLegal ? maxLegal : prev));
  }, [spacing]);

  // ==========================================================================
  // PLY 저장 함수들 (utils 모듈 사용)
  // ==========================================================================

  /**
   * ASCII PLY 파일 저장
   * - 텍스트 형식으로 어떤 에디터로도 열 수 있음
   * - 파일 크기가 큼
   */
  function savePLY(filename = PLY_EXPORT_CONFIG.DEFAULT_ASCII_FILENAME) {
    const colorData = colorDataRef.current;
    if (!colorData || !pointsRef.current) {
      setStatus("저장할 포인트 클라우드 데이터가 없습니다.");
      return;
    }

    const plyContent = createPLYDataASCII({
      colorData,
      width: targetW,
      height: targetH,
      frames: targetFrames,
      spacing,
      writeIndex: writeIndexRef.current,
    });

    downloadPLYAscii(plyContent, filename);

    const totalPoints = calcTotalPoints(targetW, targetH, targetFrames);
    append(`PLY 파일 저장 완료: ${totalPoints.toLocaleString()} 포인트`);
  }

  /**
   * Binary PLY 파일 저장
   * - 파일 크기가 ASCII 대비 약 60% 작음
   * - 로딩 속도가 빠름
   */
  function savePLYBinary(filename = PLY_EXPORT_CONFIG.DEFAULT_BINARY_FILENAME) {
    const colorData = colorDataRef.current;
    if (!colorData || !pointsRef.current) {
      setStatus("저장할 포인트 클라우드 데이터가 없습니다.");
      return;
    }

    const plyBinary = createPLYDataBinary({
      colorData,
      width: targetW,
      height: targetH,
      frames: targetFrames,
      spacing,
      writeIndex: writeIndexRef.current,
    });

    downloadPLYBinary(plyBinary, filename);

    const totalPoints = calcTotalPoints(targetW, targetH, targetFrames);
    const fileSize = formatFileSize(plyBinary.length);
    append(
      `Binary PLY 저장 완료: ${totalPoints.toLocaleString()} 포인트 (${fileSize})`
    );
  }

  /**
   * PNG 스크린샷 저장
   */
  function saveCanvasPNG(
    filename = PLY_EXPORT_CONFIG.DEFAULT_SCREENSHOT_FILENAME
  ) {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;

    if (!renderer) return;

    // 강제 렌더링 후 캡처
    if (scene && camera) {
      renderer.render(scene, camera);
    }

    if (captureAndDownloadCanvas(renderer.domElement, filename)) {
      append("PNG 스크린샷 저장 완료");
    } else {
      append("스크린샷 저장 실패");
    }
  }

  // ==========================================================================
  // UI 렌더링
  // ==========================================================================
  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        background: "#111",
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
          background: "rgba(0,0,0,.6)",
          color: "#eee",
          border: "1px solid rgba(255,255,255,.25)",
          borderRadius: 6,
          padding: "6px 10px",
          cursor: "pointer",
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
            background: "rgba(0,0,0,.5)",
            padding: "10px 12px",
            borderRadius: 8,
            display: "grid",
            gridTemplateColumns: "auto 1fr auto",
            gap: 8,
            alignItems: "center",
            maxHeight: "90vh",
            overflowY: "auto",
          }}
        >
          {/* 버전 표시 */}
          <div
            style={{
              gridColumn: "1 / -1",
              color: "#4f4",
              fontSize: 11,
              marginBottom: 4,
            }}
          >
            🚀 Point Cloud 최적화 버전 (Ring Buffer + DataTexture)
          </div>

          {/* 캡처 컨트롤 */}
          <div style={{ display: "flex", gap: 8, gridColumn: "1 / -1" }}>
            <button onClick={startCapture} disabled={isCapturing}>
              라이브 시작
            </button>
            <button onClick={() => stopCapture()} disabled={!isCapturing}>
              라이브 중지
            </button>
            <button
              onClick={() => {
                disposePoints();
                setStatus("포인트 클라우드를 초기화했습니다.");
              }}
              disabled={isCapturing}
            >
              포인트 초기화
            </button>
          </div>

          {/* 샘플링 설정 */}
          <label>W×H</label>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              type="number"
              value={targetW}
              min={SAMPLING_CONFIG.MIN_WIDTH}
              step={SAMPLING_CONFIG.STEP_WIDTH}
              style={{ width: 70 }}
              onChange={(e) =>
                setTargetW(
                  parseInt(
                    e.currentTarget.value ||
                      String(SAMPLING_CONFIG.DEFAULT_WIDTH),
                    10
                  )
                )
              }
              disabled={isCapturing}
            />
            <input
              type="number"
              value={targetH}
              min={SAMPLING_CONFIG.MIN_HEIGHT}
              step={SAMPLING_CONFIG.STEP_HEIGHT}
              style={{ width: 70 }}
              onChange={(e) =>
                setTargetH(
                  parseInt(
                    e.currentTarget.value ||
                      String(SAMPLING_CONFIG.DEFAULT_HEIGHT),
                    10
                  )
                )
              }
              disabled={isCapturing}
            />
          </div>
          <span />

          <label>Frames</label>
          <input
            type="number"
            value={targetFrames}
            min={SAMPLING_CONFIG.MIN_FRAMES}
            step={SAMPLING_CONFIG.STEP_FRAMES}
            style={{ width: 70 }}
            onChange={(e) =>
              setTargetFrames(
                parseInt(
                  e.currentTarget.value ||
                    String(SAMPLING_CONFIG.DEFAULT_FRAMES),
                  10
                )
              )
            }
            disabled={isCapturing}
          />
          <span />

          {/* 카메라 설정 */}
          <div
            style={{
              gridColumn: "1 / -1",
              borderTop: "1px solid rgba(255,255,255,0.2)",
              paddingTop: 8,
              marginTop: 4,
            }}
          >
            <div style={{ color: "#8af", fontSize: 11, marginBottom: 6 }}>
              📷 카메라 설정
            </div>
          </div>

          <label>카메라</label>
          <button
            onClick={() => setUseOrthographic((prev) => !prev)}
            style={{
              gridColumn: "2 / -1",
              background: "rgba(0,0,0,.6)",
              color: "#eee",
              border: "1px solid rgba(255,255,255,.25)",
              borderRadius: 6,
              padding: "6px 10px",
              cursor: "pointer",
              textAlign: "left",
            }}
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
            <button
              onClick={() => moveCameraTo("front")}
              style={{
                background: "rgba(0,0,0,.6)",
                color: "#eee",
                border: "1px solid rgba(255,255,255,.25)",
                borderRadius: 6,
                padding: "6px 10px",
                cursor: "pointer",
              }}
            >
              Front
            </button>
            <button
              onClick={() => moveCameraTo("back")}
              style={{
                background: "rgba(0,0,0,.6)",
                color: "#eee",
                border: "1px solid rgba(255,255,255,.25)",
                borderRadius: 6,
                padding: "6px 10px",
                cursor: "pointer",
              }}
            >
              Back
            </button>
            <button
              onClick={() => moveCameraTo("left")}
              style={{
                background: "rgba(0,0,0,.6)",
                color: "#eee",
                border: "1px solid rgba(255,255,255,.25)",
                borderRadius: 6,
                padding: "6px 10px",
                cursor: "pointer",
              }}
            >
              Left
            </button>
            <button
              onClick={() => moveCameraTo("right")}
              style={{
                background: "rgba(0,0,0,.6)",
                color: "#eee",
                border: "1px solid rgba(255,255,255,.25)",
                borderRadius: 6,
                padding: "6px 10px",
                cursor: "pointer",
              }}
            >
              Right
            </button>
            <button
              onClick={() => moveCameraTo("top")}
              style={{
                background: "rgba(0,0,0,.6)",
                color: "#eee",
                border: "1px solid rgba(255,255,255,.25)",
                borderRadius: 6,
                padding: "6px 10px",
                cursor: "pointer",
              }}
            >
              Top
            </button>
            <button
              onClick={() => moveCameraTo("bottom")}
              style={{
                background: "rgba(0,0,0,.6)",
                color: "#eee",
                border: "1px solid rgba(255,255,255,.25)",
                borderRadius: 6,
                padding: "6px 10px",
                cursor: "pointer",
              }}
            >
              Bottom
            </button>
          </div>

          <label>카메라 X</label>
          <input
            type="range"
            min={-500}
            max={500}
            step={1}
            value={cameraPosition.x}
            onChange={(e) =>
              setCameraPositionAxis("x", parseFloat(e.currentTarget.value))
            }
          />
          <input
            type="number"
            min={-500}
            max={500}
            step={1}
            value={Math.round(cameraPosition.x)}
            onChange={(e) => {
              const v = parseFloat(e.currentTarget.value);
              if (!Number.isNaN(v)) {
                setCameraPositionAxis("x", clamp(v, -500, 500));
              }
            }}
            style={{ width: 60 }}
          />

          <label>카메라 Y</label>
          <input
            type="range"
            min={-500}
            max={500}
            step={1}
            value={cameraPosition.y}
            onChange={(e) =>
              setCameraPositionAxis("y", parseFloat(e.currentTarget.value))
            }
          />
          <input
            type="number"
            min={-500}
            max={500}
            step={1}
            value={Math.round(cameraPosition.y)}
            onChange={(e) => {
              const v = parseFloat(e.currentTarget.value);
              if (!Number.isNaN(v)) {
                setCameraPositionAxis("y", clamp(v, -500, 500));
              }
            }}
            style={{ width: 60 }}
          />

          <label>카메라 Z</label>
          <input
            type="range"
            min={-500}
            max={500}
            step={1}
            value={cameraPosition.z}
            onChange={(e) =>
              setCameraPositionAxis("z", parseFloat(e.currentTarget.value))
            }
          />
          <input
            type="number"
            min={-500}
            max={500}
            step={1}
            value={Math.round(cameraPosition.z)}
            onChange={(e) => {
              const v = parseFloat(e.currentTarget.value);
              if (!Number.isNaN(v)) {
                setCameraPositionAxis("z", clamp(v, -500, 500));
              }
            }}
            style={{ width: 60 }}
          />

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

          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={autoRotate}
              onChange={(e) => setAutoRotate(e.currentTarget.checked)}
            />
            자동 회전
          </label>
          <input
            type="range"
            min={CAMERA_CONFIG.MIN_AUTO_ROTATE_SPEED}
            max={CAMERA_CONFIG.MAX_AUTO_ROTATE_SPEED}
            step={CAMERA_CONFIG.STEP_AUTO_ROTATE_SPEED}
            value={autoRotateSpeed}
            onChange={(e) => setAutoRotateSpeed(parseFloat(e.currentTarget.value))}
            disabled={!autoRotate}
          />
          <span style={{ opacity: autoRotate ? 0.8 : 0.4 }}>
            {autoRotateSpeed.toFixed(1)}
          </span>

          {/* 시각적 설정 */}
          <label>Spacing (z)</label>
          <input
            type="range"
            min={VISUAL_CONFIG.MIN_SPACING}
            max={VISUAL_CONFIG.MAX_SPACING}
            step={VISUAL_CONFIG.STEP_SPACING}
            value={spacing}
            onChange={(e) => setSpacing(parseFloat(e.currentTarget.value))}
          />
          <span style={{ opacity: 0.8 }}>{spacing.toFixed(1)}</span>

          <label>Point Size</label>
          <input
            type="range"
            min={VISUAL_CONFIG.MIN_POINT_SIZE}
            max={VISUAL_CONFIG.MAX_POINT_SIZE}
            step={VISUAL_CONFIG.STEP_POINT_SIZE}
            value={pointSize}
            onChange={(e) => setPointSize(parseFloat(e.currentTarget.value))}
          />
          <span style={{ opacity: 0.8 }}>{pointSize.toFixed(1)}</span>

          <label>Opacity</label>
          <input
            type="range"
            min={VISUAL_CONFIG.MIN_OPACITY}
            max={VISUAL_CONFIG.MAX_OPACITY}
            step={VISUAL_CONFIG.STEP_OPACITY}
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

          {/* 슬라이스 컨트롤 */}
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
              step={SLICE_CONFIG.Z_STEP}
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
              step={SLICE_CONFIG.Z_STEP}
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

          {/* 마우스 인터랙션 설정 */}
          <div
            style={{
              gridColumn: "1 / -1",
              borderTop: "1px solid rgba(255,255,255,0.2)",
              paddingTop: 8,
              marginTop: 4,
            }}
          >
            <div style={{ color: "#f8a", fontSize: 11, marginBottom: 6 }}>
              🌊 마우스 인터랙션 / Fluid 효과
            </div>
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={mouseEnabled}
              onChange={(e) => setMouseEnabled(e.currentTarget.checked)}
            />
            효과 활성화
          </label>
          <span />
          <span />

          <label>반경</label>
          <input
            type="range"
            min={MOUSE_CONFIG.MIN_RADIUS}
            max={MOUSE_CONFIG.MAX_RADIUS}
            step={MOUSE_CONFIG.STEP_RADIUS}
            value={mouseRadius}
            onChange={(e) => setMouseRadius(parseFloat(e.currentTarget.value))}
            disabled={!mouseEnabled}
          />
          <span style={{ opacity: mouseEnabled ? 0.8 : 0.4 }}>
            {mouseRadius.toFixed(0)}
          </span>

          <label>강도</label>
          <input
            type="range"
            min={MOUSE_CONFIG.MIN_STRENGTH}
            max={MOUSE_CONFIG.MAX_STRENGTH}
            step={MOUSE_CONFIG.STEP_STRENGTH}
            value={mouseStrength}
            onChange={(e) =>
              setMouseStrength(parseFloat(e.currentTarget.value))
            }
            disabled={!mouseEnabled}
          />
          <span style={{ opacity: mouseEnabled ? 0.8 : 0.4 }}>
            {mouseStrength.toFixed(0)}
          </span>

          {/* 랜덤 움직임 (Jitter) 설정 */}
          <div
            style={{
              gridColumn: "1 / -1",
              borderTop: "1px solid rgba(255,255,255,0.2)",
              paddingTop: 8,
              marginTop: 4,
            }}
          >
            <div style={{ color: "#af8", fontSize: 11, marginBottom: 6 }}>
              ✨ 랜덤 움직임 (Jitter)
            </div>
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={jitterEnabled}
              onChange={(e) => setJitterEnabled(e.currentTarget.checked)}
            />
            효과 활성화
          </label>
          <span />
          <span />

          <label>강도</label>
          <input
            type="range"
            min={JITTER_CONFIG.MIN_AMPLITUDE}
            max={JITTER_CONFIG.MAX_AMPLITUDE}
            step={JITTER_CONFIG.STEP_AMPLITUDE}
            value={jitterAmplitude}
            onChange={(e) =>
              setJitterAmplitude(parseFloat(e.currentTarget.value))
            }
            disabled={!jitterEnabled}
          />
          <span style={{ opacity: jitterEnabled ? 0.8 : 0.4 }}>
            {jitterAmplitude.toFixed(1)}
          </span>

          <label>속도</label>
          <input
            type="range"
            min={JITTER_CONFIG.MIN_SPEED}
            max={JITTER_CONFIG.MAX_SPEED}
            step={JITTER_CONFIG.STEP_SPEED}
            value={jitterSpeed}
            onChange={(e) => setJitterSpeed(parseFloat(e.currentTarget.value))}
            disabled={!jitterEnabled}
          />
          <span style={{ opacity: jitterEnabled ? 0.8 : 0.4 }}>
            {jitterSpeed.toFixed(1)}
          </span>

          <label>스케일</label>
          <input
            type="range"
            min={JITTER_CONFIG.MIN_SCALE}
            max={JITTER_CONFIG.MAX_SCALE}
            step={JITTER_CONFIG.STEP_SCALE}
            value={jitterScale}
            onChange={(e) => setJitterScale(parseFloat(e.currentTarget.value))}
            disabled={!jitterEnabled}
          />
          <span style={{ opacity: jitterEnabled ? 0.8 : 0.4 }}>
            {jitterScale.toFixed(2)}
          </span>

          {/* 저장 버튼들 */}
          <div
            style={{
              gridColumn: "1 / -1",
              borderTop: "1px solid rgba(255,255,255,0.2)",
              paddingTop: 8,
              marginTop: 4,
            }}
          >
            <div style={{ color: "#8cf", fontSize: 11, marginBottom: 6 }}>
              💾 포인트 클라우드 저장
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button
                onClick={() => savePLY()}
                disabled={!colorDataRef.current}
                style={{
                  background: colorDataRef.current
                    ? "rgba(40,100,40,.8)"
                    : "rgba(60,60,60,.5)",
                  color: "#eee",
                  border: "1px solid rgba(255,255,255,.25)",
                  borderRadius: 6,
                  padding: "6px 12px",
                  cursor: colorDataRef.current ? "pointer" : "not-allowed",
                }}
              >
                PLY (ASCII)
              </button>
              <button
                onClick={() => savePLYBinary()}
                disabled={!colorDataRef.current}
                style={{
                  background: colorDataRef.current
                    ? "rgba(40,80,120,.8)"
                    : "rgba(60,60,60,.5)",
                  color: "#eee",
                  border: "1px solid rgba(255,255,255,.25)",
                  borderRadius: 6,
                  padding: "6px 12px",
                  cursor: colorDataRef.current ? "pointer" : "not-allowed",
                }}
              >
                PLY (Binary)
              </button>
              <button
                onClick={() => saveCanvasPNG()}
                style={{
                  background: "rgba(80,60,100,.8)",
                  color: "#eee",
                  border: "1px solid rgba(255,255,255,.25)",
                  borderRadius: 6,
                  padding: "6px 12px",
                  cursor: "pointer",
                }}
              >
                PNG 캡처
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

      {/* Hidden 캡처용 엘리먼트 */}
      <canvas ref={hiddenCanvasRef} style={{ display: "none" }} />
      <video ref={videoRef} muted playsInline style={{ display: "none" }} />

      {/* Three.js 마운트 포인트 */}
      <div ref={mountRef} style={{ position: "absolute", inset: 0 }} />
    </div>
  );
}
