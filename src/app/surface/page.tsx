"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/**
 * Surface Mode - 라이브 전용 가벼운 포인트 클라우드
 * 
 * 큐브의 6면(표면)만 렌더링하여 성능을 대폭 향상시킵니다.
 * 
 * 텍스처 레이아웃: 2D 타일 그리드
 * - 프레임을 cols × rows 그리드로 배치
 * - 텍스처 크기: (W × cols, H × rows)
 * - 고해상도 + 많은 프레임 지원 가능
 */

// ============================================================================
// 설정값 (간소화)
// ============================================================================
const CONFIG = {
  // 샘플링
  DEFAULT_WIDTH: 144,
  DEFAULT_HEIGHT: 255,
  DEFAULT_FRAMES: 120,  // 이제 120프레임 가능!

  // 시각
  DEFAULT_SPACING: 1,
  DEFAULT_POINT_SIZE: 20,

  // 카메라
  FOV: 50,
  NEAR: 0.1,
  FAR: 4000,
  INITIAL_Z: 300,

  // 자동 회전
  DEFAULT_AUTO_ROTATE: true,
  DEFAULT_AUTO_ROTATE_SPEED: 0.5,

  // 텍스처 제한
  MAX_TEXTURE_SIZE: 16384,
};

/**
 * 타일 그리드 레이아웃 계산
 * 프레임들을 가로 방향으로 최대한 배치 (가로 우선)
 */
function calcTileLayout(
  frames: number,
  frameWidth: number,
  maxTextureSize: number = CONFIG.MAX_TEXTURE_SIZE
): { cols: number; rows: number } {
  // 가로 방향으로 최대한 배치
  const maxCols = Math.floor(maxTextureSize / frameWidth);
  const cols = Math.min(frames, maxCols);
  const rows = Math.ceil(frames / cols);
  
  return { cols, rows };
}

/**
 * 텍스처 크기 계산 및 검증
 */
function calcTextureSize(
  width: number,
  height: number,
  frames: number,
  maxSize: number = CONFIG.MAX_TEXTURE_SIZE
): { texWidth: number; texHeight: number; cols: number; rows: number; valid: boolean } {
  const { cols, rows } = calcTileLayout(frames, width, maxSize);
  const texWidth = width * cols;
  const texHeight = height * rows;
  const valid = texWidth <= maxSize && texHeight <= maxSize;
  
  return { texWidth, texHeight, cols, rows, valid };
}

/**
 * 표면 포인트 인덱스 생성
 * 큐브의 6면에 해당하는 포인트만 생성
 */
function generateSurfaceIndices(
  width: number,
  height: number,
  frames: number
): { logicalFrame: number; pixelIdx: number; x: number; y: number; z: number }[] {
  const points: { logicalFrame: number; pixelIdx: number; x: number; y: number; z: number }[] = [];
  const xHalf = (width - 1) / 2;
  const yHalf = (height - 1) / 2;
  const zHalf = (frames - 1) / 2;

  // 뒷면 (논리적 프레임 0) & 앞면 (논리적 프레임 frames-1)
  for (const logicalF of [0, frames - 1]) {
    const zVal = logicalF - zHalf;
    for (let y = 0; y < height; y++) {
      const yVal = yHalf - y;
      for (let x = 0; x < width; x++) {
        const xVal = x - xHalf;
        points.push({
          logicalFrame: logicalF,
          pixelIdx: y * width + x,
          x: xVal,
          y: yVal,
          z: zVal,
        });
      }
    }
  }

  // 상단 (y=0) & 하단 (y=height-1) - 앞뒤 제외
  for (const y of [0, height - 1]) {
    const yVal = yHalf - y;
    for (let logicalF = 1; logicalF < frames - 1; logicalF++) {
      const zVal = logicalF - zHalf;
      for (let x = 0; x < width; x++) {
        const xVal = x - xHalf;
        points.push({
          logicalFrame: logicalF,
          pixelIdx: y * width + x,
          x: xVal,
          y: yVal,
          z: zVal,
        });
      }
    }
  }

  // 좌측 (x=0) & 우측 (x=width-1) - 앞뒤/상하 제외
  for (const x of [0, width - 1]) {
    const xVal = x - xHalf;
    for (let logicalF = 1; logicalF < frames - 1; logicalF++) {
      const zVal = logicalF - zHalf;
      for (let y = 1; y < height - 1; y++) {
        const yVal = yHalf - y;
        points.push({
          logicalFrame: logicalF,
          pixelIdx: y * width + x,
          x: xVal,
          y: yVal,
          z: zVal,
        });
      }
    }
  }

  return points;
}

// ============================================================================
// 셰이더 (2D 타일 그리드 레이아웃)
// ============================================================================
const vertexShader = `
  attribute float aLogicalFrame;
  attribute float aPixelIndex;
  
  uniform float uSize;
  uniform float uZScale;
  uniform float uWriteIndex;
  uniform float uTotalFrames;
  uniform float uFrameWidth;   // 단일 프레임 너비
  uniform float uFrameHeight;  // 단일 프레임 높이
  uniform float uTileCols;     // 타일 그리드 열 수
  uniform float uTileRows;     // 타일 그리드 행 수
  uniform float uTexWidth;     // 전체 텍스처 너비
  uniform float uTexHeight;    // 전체 텍스처 높이
  uniform sampler2D uColorTex;
  
  varying vec3 vColor;
  
  void main() {
    // 논리적 프레임 인덱스 기반 Z 위치 (고정)
    float zHalf = (uTotalFrames - 1.0) / 2.0;
    float zPos = (aLogicalFrame - zHalf) * uZScale;
    
    vec3 pos = position;
    pos.z = zPos;
    
    // 논리적 프레임 → 물리적 프레임 변환 (Ring Buffer)
    float physicalFrame = mod(uWriteIndex + aLogicalFrame, uTotalFrames);
    
    // 물리적 프레임 → 타일 좌표 (col, row)
    float tileCol = mod(physicalFrame, uTileCols);
    float tileRow = floor(physicalFrame / uTileCols);
    
    // 픽셀 좌표 (프레임 내)
    float pixelX = mod(aPixelIndex, uFrameWidth);
    float pixelY = floor(aPixelIndex / uFrameWidth);
    
    // 전체 텍스처에서의 UV 계산
    float texU = (tileCol * uFrameWidth + pixelX + 0.5) / uTexWidth;
    float texV = (tileRow * uFrameHeight + pixelY + 0.5) / uTexHeight;
    
    vec4 texColor = texture2D(uColorTex, vec2(texU, texV));
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
// 메인 컴포넌트
// ============================================================================
export default function SurfacePage() {
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
  const surfacePointsRef = useRef<ReturnType<typeof generateSurfaceIndices>>([]);
  const tileLayoutRef = useRef<{ cols: number; rows: number }>({ cols: 1, rows: 1 });

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const rafRef = useRef<number | null>(null);
  const rvfcRef = useRef<number | null>(null);
  const capturingRef = useRef<boolean>(false);
  const frameCountRef = useRef<number>(0);

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

  // 텍스처 레이아웃 계산
  const textureInfo = useMemo(() => {
    return calcTextureSize(targetW, targetH, targetFrames);
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
    camera.position.set(0, 0, CONFIG.INITIAL_Z);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.autoRotate = autoRotate;
    controls.autoRotateSpeed = autoRotateSpeed;
    controlsRef.current = controls;

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
    const loop = () => {
      raf = requestAnimationFrame(loop);
      controls.update();
      renderer.render(scene, camera);
    };
    loop();

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
      controlsRef.current.autoRotate = autoRotate;
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
    surfacePointsRef.current = [];
  }

  // 표면 포인트 초기화
  function initSurfacePoints(): boolean {
    const scene = sceneRef.current;
    const hidden = hiddenCanvasRef.current;
    if (!scene || !hidden) {
      setStatus("Three.js 초기화가 아직 완료되지 않았습니다.");
      return false;
    }

    // 텍스처 크기 검증
    const texInfo = calcTextureSize(targetW, targetH, targetFrames);
    if (!texInfo.valid) {
      setStatus(`텍스처 크기 초과! (${texInfo.texWidth}×${texInfo.texHeight} > ${CONFIG.MAX_TEXTURE_SIZE})`);
      return false;
    }

    tileLayoutRef.current = { cols: texInfo.cols, rows: texInfo.rows };

    // 표면 포인트 생성
    const surfacePoints = generateSurfaceIndices(targetW, targetH, targetFrames);
    surfacePointsRef.current = surfacePoints;
    const totalPoints = surfacePoints.length;

    if (totalPoints <= 0) {
      setStatus("표면 포인트 생성 실패");
      return false;
    }

    // 포지션 및 인덱스 배열 생성
    const positions = new Float32Array(totalPoints * 3);
    const logicalFrames = new Float32Array(totalPoints);
    const pixelIndices = new Float32Array(totalPoints);

    for (let i = 0; i < totalPoints; i++) {
      const pt = surfacePoints[i];
      positions[i * 3] = pt.x;
      positions[i * 3 + 1] = pt.y;
      positions[i * 3 + 2] = pt.z;
      logicalFrames[i] = pt.logicalFrame;
      pixelIndices[i] = pt.pixelIdx;
    }

    // Hidden canvas 설정
    hidden.width = targetW;
    hidden.height = targetH;
    const ctx = hidden.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      setStatus("Canvas 컨텍스트 생성 실패");
      return false;
    }
    ctxRef.current = ctx;

    disposePoints();

    // DataTexture 생성 (2D 타일 그리드)
    const colorData = new Uint8Array(texInfo.texWidth * texInfo.texHeight * 4);
    colorData.fill(0);

    const colorTexture = new THREE.DataTexture(
      colorData,
      texInfo.texWidth,
      texInfo.texHeight,
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
    geometry.setAttribute("aPixelIndex", new THREE.BufferAttribute(pixelIndices, 1));

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
        uTileCols: { value: texInfo.cols },
        uTileRows: { value: texInfo.rows },
        uTexWidth: { value: texInfo.texWidth },
        uTexHeight: { value: texInfo.texHeight },
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

  // 프레임 처리 (2D 타일 그리드 레이아웃)
  const processFrame = () => {
    if (!capturingRef.current) return;

    const video = videoRef.current;
    const ctx = ctxRef.current;
    const colorData = colorDataRef.current;
    const colorTexture = colorTextureRef.current;
    const material = materialRef.current;

    if (!video || !ctx || !colorData || !colorTexture || !material) return;

    const writeIndex = writeIndexRef.current;
    const { cols } = tileLayoutRef.current;
    const texWidth = material.uniforms.uTexWidth.value;

    // 타일 좌표 계산
    const tileCol = writeIndex % cols;
    const tileRow = Math.floor(writeIndex / cols);

    ctx.drawImage(video, 0, 0, targetW, targetH);
    const { data } = ctx.getImageData(0, 0, targetW, targetH);

    // 타일 위치에 프레임 데이터 저장
    const tileStartX = tileCol * targetW;
    const tileStartY = tileRow * targetH;

    for (let y = 0; y < targetH; y++) {
      for (let x = 0; x < targetW; x++) {
        const srcBase = (y * targetW + x) * 4;
        const dstX = tileStartX + x;
        const dstY = tileStartY + y;
        const dstBase = (dstY * texWidth + dstX) * 4;
        
        colorData[dstBase] = data[srcBase];
        colorData[dstBase + 1] = data[srcBase + 1];
        colorData[dstBase + 2] = data[srcBase + 2];
        colorData[dstBase + 3] = 255;
      }
    }

    colorTexture.needsUpdate = true;
    writeIndexRef.current = (writeIndex + 1) % targetFrames;
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

      if (!initSurfacePoints()) {
        throw new Error("표면 포인트 초기화 실패");
      }

      capturingRef.current = true;
      setIsCapturing(true);
      
      const texInfo = calcTextureSize(targetW, targetH, targetFrames);
      setStatus(
        `🚀 Surface Mode 시작!\n` +
        `포인트: ${surfacePointCount.toLocaleString()} (${((1 - surfacePointCount / fullVolumeCount) * 100).toFixed(0)}% 절감)\n` +
        `텍스처: ${texInfo.texWidth}×${texInfo.texHeight} (${texInfo.cols}×${texInfo.rows} 타일)`
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
          background: "rgba(0,0,0,.7)",
          color: "#eee",
          border: "1px solid rgba(255,255,255,.2)",
          borderRadius: 6,
          padding: "6px 12px",
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
            background: "rgba(0,0,0,.7)",
            padding: "12px 14px",
            borderRadius: 10,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            minWidth: 300,
          }}
        >
          {/* 타이틀 */}
          <div style={{ color: "#4f8", fontSize: 13, fontWeight: "bold" }}>
            🎯 Surface Mode (2D Tile Grid)
          </div>

          {/* 포인트/텍스처 정보 */}
          <div style={{ fontSize: 11, color: "#888", lineHeight: 1.5 }}>
            표면: <span style={{ color: "#4f8" }}>{surfacePointCount.toLocaleString()}</span> pts
            {" "}(<span style={{ color: "#ff0" }}>{((1 - surfacePointCount / fullVolumeCount) * 100).toFixed(0)}%</span> 절감)
            <br />
            텍스처: <span style={{ color: textureInfo.valid ? "#4f8" : "#f44" }}>
              {textureInfo.texWidth}×{textureInfo.texHeight}
            </span>
            {" "}({textureInfo.cols}×{textureInfo.rows} 타일)
            {!textureInfo.valid && <span style={{ color: "#f44" }}> ⚠️ 초과!</span>}
          </div>

          {/* 캡처 버튼 */}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={startCapture}
              disabled={isCapturing || !textureInfo.valid}
              style={{
                flex: 1,
                padding: "8px",
                background: isCapturing || !textureInfo.valid ? "#333" : "#2a6",
                color: "#fff",
                border: "none",
                borderRadius: 6,
                cursor: isCapturing || !textureInfo.valid ? "not-allowed" : "pointer",
              }}
            >
              ▶ 시작
            </button>
            <button
              onClick={() => stopCapture()}
              disabled={!isCapturing}
              style={{
                flex: 1,
                padding: "8px",
                background: !isCapturing ? "#333" : "#a44",
                color: "#fff",
                border: "none",
                borderRadius: 6,
                cursor: !isCapturing ? "not-allowed" : "pointer",
              }}
            >
              ⏹ 중지
            </button>
          </div>

          {/* 설정 */}
          <div style={{ borderTop: "1px solid #333", paddingTop: 10 }}>
            <div style={{ fontSize: 11, color: "#888", marginBottom: 6 }}>해상도 (W × H × Frames)</div>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="number"
                value={targetW}
                min={8}
                step={8}
                style={{ width: 60, padding: 4, background: "#222", color: "#eee", border: "1px solid #444", borderRadius: 4 }}
                onChange={(e) => setTargetW(parseInt(e.currentTarget.value || "144", 10))}
                disabled={isCapturing}
              />
              <input
                type="number"
                value={targetH}
                min={8}
                step={8}
                style={{ width: 60, padding: 4, background: "#222", color: "#eee", border: "1px solid #444", borderRadius: 4 }}
                onChange={(e) => setTargetH(parseInt(e.currentTarget.value || "255", 10))}
                disabled={isCapturing}
              />
              <input
                type="number"
                value={targetFrames}
                min={2}
                style={{ width: 60, padding: 4, background: "#222", color: "#eee", border: "1px solid #444", borderRadius: 4 }}
                onChange={(e) => setTargetFrames(parseInt(e.currentTarget.value || "120", 10))}
                disabled={isCapturing}
              />
            </div>
          </div>

          {/* 비주얼 */}
          <div style={{ borderTop: "1px solid #333", paddingTop: 10 }}>
            <label style={{ fontSize: 11, color: "#888" }}>
              Spacing: {spacing.toFixed(1)}
            </label>
            <input
              type="range"
              min={0.1}
              max={5}
              step={0.1}
              value={spacing}
              onChange={(e) => setSpacing(parseFloat(e.currentTarget.value))}
              style={{ width: "100%" }}
            />

            <label style={{ fontSize: 11, color: "#888", marginTop: 6, display: "block" }}>
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
          <div style={{ borderTop: "1px solid #333", paddingTop: 10 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
              <input
                type="checkbox"
                checked={autoRotate}
                onChange={(e) => setAutoRotate(e.currentTarget.checked)}
              />
              자동 회전
            </label>
            {autoRotate && (
              <>
                <label style={{ fontSize: 11, color: "#888", marginTop: 6, display: "block" }}>
                  속도: {autoRotateSpeed.toFixed(1)}
                </label>
                <input
                  type="range"
                  min={0.1}
                  max={5}
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
            background: "rgba(0,0,0,.6)",
            padding: "8px 12px",
            borderRadius: 8,
            fontSize: 12,
            whiteSpace: "pre-wrap",
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
