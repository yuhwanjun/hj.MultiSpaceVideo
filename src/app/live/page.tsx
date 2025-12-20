"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/**
 * Next.js + three.js + canvas 포팅 버전 (App Router)
 * - 파일 경로: app/page.tsx
 * - 비디오를 선택 → W×H, 프레임 수로 샘플링 → Float32Array 누적 → THREE.Points로 시각화
 * - UI로 프레임 간 간격(spacing), 점 크기(size), 불투명도(opacity) 조절 가능
 */
export default function Page() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const pointsRef = useRef<THREE.Points | null>(null);
  const materialRef = useRef<THREE.ShaderMaterial | null>(null);

  // Hidden 2D canvas + video for sampling
  const hiddenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [status, setStatus] = useState<string>("웹캠 시작 버튼을 눌러 주세요.");
  const [isCapturing, setIsCapturing] = useState<boolean>(false);

  // Sampling controls
  const [targetW, setTargetW] = useState<number>(128);
  const [targetH, setTargetH] = useState<number>(72);
  const [targetFrames, setTargetFrames] = useState<number>(60);

  // Visual controls
  const [spacing, setSpacing] = useState<number>(2);        // 프레임 간 z 간격 (기본 2)
  const [pointSize, setPointSize] = useState<number>(0.8);  // 포인트 크기 (shader uniform)
  const [opacity, setOpacity] = useState<number>(1.0);      // 포인트 불투명도
  const [sizeAttenuation, setSizeAttenuation] = useState<boolean>(true);
  const [showUI, setShowUI] = useState<boolean>(true);
  const [autoRotate, setAutoRotate] = useState<boolean>(true);
  const [autoRotateSpeed, setAutoRotateSpeed] = useState<number>(0.3);
  const [cameraZoom, setCameraZoom] = useState<number>(1.5); // 줌 레벨 (1.0 = 기본, 높을수록 멀리)

  // Slice ranges (object space; z range uses spacing-applied units)
  const [xMin, setXMin] = useState<number>(-64);
  const [xMax, setXMax] = useState<number>(64);
  const [yMin, setYMin] = useState<number>(-36);
  const [yMax, setYMax] = useState<number>(36);
  const [zMin, setZMin] = useState<number>(-60);
  const [zMax, setZMax] = useState<number>(60);

  // Extents to clamp slicers (stored once, derived during sampling)
  const extentsRef = useRef({
    xMinAll: -64,
    xMaxAll: 64,
    yMinAll: -36,
    yMaxAll: 36,
    zMinBase: -30, // spacing 적용 전 기본 프레임 범위
    zMaxBase: 30,
  });
  const positionsRef = useRef<Float32Array | null>(null);
  const colorsRef = useRef<Float32Array | null>(null);
  const colorAttrRef = useRef<THREE.BufferAttribute | null>(null);
  const sliceStrideRef = useRef<number>(0);
  const frameCountRef = useRef<number>(0);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const rafRef = useRef<number | null>(null);
  const rvfcRef = useRef<number | null>(null);
  const capturingRef = useRef<boolean>(false);
  
  // 자동 회전을 위한 refs
  const customRotationTimeRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const cameraZoomRef = useRef<number>(1.5);

  const hasRVFC = useMemo(
    () => typeof HTMLVideoElement !== "undefined" && "requestVideoFrameCallback" in HTMLVideoElement.prototype,
    []
  );

  useEffect(() => {
    if (!mountRef.current) return;

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mountRef.current.clientWidth, mountRef.current.clientHeight);
    mountRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111111);
    sceneRef.current = scene;

    // Camera
    const camera = new THREE.PerspectiveCamera(
      50,
      mountRef.current.clientWidth / mountRef.current.clientHeight,
      0.1,
      2000
    );
    // 초기 카메라 위치: 원형 회전 시작점
    const initRadius = 180 * 1.5;
    const initPhi = Math.PI * 0.5 + Math.PI * 0.15;
    camera.position.set(0, initRadius * Math.cos(initPhi), initRadius * Math.sin(initPhi));
    camera.lookAt(0, 0, 0);
    cameraRef.current = camera;

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    // 회전 제한: 뒷면이 보이지 않도록
    controls.minAzimuthAngle = -Math.PI / 2;
    controls.maxAzimuthAngle = Math.PI / 2;
    controls.minPolarAngle = Math.PI * 0.2;
    controls.maxPolarAngle = Math.PI * 0.8;
    (controls as any)._customAutoRotate = true; // 초기 상태
    controlsRef.current = controls;

    // 원형 회전 설정
    const thetaAmplitude = Math.PI / 4;  // 좌우 회전 범위
    const phiCenter = Math.PI * 0.5;     // 수직 중심
    const phiAmplitude = Math.PI * 0.15; // 상하 회전 범위
    const baseCameraDistance = 180;      // 기본 카메라 거리

    // Resize handler
    const onResize = () => {
      if (!rendererRef.current || !cameraRef.current || !mountRef.current) return;
      const w = mountRef.current.clientWidth;
      const h = mountRef.current.clientHeight;
      rendererRef.current.setSize(w, h);
      cameraRef.current.aspect = w / h;
      cameraRef.current.updateProjectionMatrix();
    };
    window.addEventListener("resize", onResize);

    // Animation loop with custom rotation
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
          
          // 부드러운 원형 회전
          const cycleTime = 2 * Math.PI / (ctrl.autoRotateSpeed || 0.3);
          const angle = (customRotationTimeRef.current / cycleTime) * 2 * Math.PI;
          const cameraRadius = baseCameraDistance * cameraZoomRef.current;
          
          const theta = thetaAmplitude * Math.sin(angle);
          const phi = phiCenter + phiAmplitude * Math.cos(angle);
          
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

      // dispose three objects
      disposePoints();

      controls.dispose();
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
  }, []);

  // Reflect visual controls to the existing material/points immediately
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
      materialRef.current.transparent = opacity < 1.0 || materialRef.current.transparent; // 투명도 필요 시 활성화
      materialRef.current.needsUpdate = true;
    }
  }, [opacity]);

  useEffect(() => {
    if (materialRef.current) {
      materialRef.current.uniforms.uAttenuate.value = sizeAttenuation;
      materialRef.current.needsUpdate = true;
    }
  }, [sizeAttenuation]);

  // 자동 회전 상태 업데이트
  useEffect(() => {
    if (controlsRef.current) {
      (controlsRef.current as any)._customAutoRotate = autoRotate;
      if (!autoRotate) {
        customRotationTimeRef.current = 0;
      }
    }
  }, [autoRotate]);

  useEffect(() => {
    if (controlsRef.current) {
      controlsRef.current.autoRotateSpeed = autoRotateSpeed;
    }
  }, [autoRotateSpeed]);

  // 줌 레벨 업데이트
  useEffect(() => {
    cameraZoomRef.current = cameraZoom;
  }, [cameraZoom]);

  // Slice uniform updates
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

  // Helpers
  function log(msg: string) {
    setStatus(msg);
  }
  function append(msg: string) {
    setStatus(prev => (prev ? prev + "\n" + msg : msg));
  }

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
    positionsRef.current = null;
    colorsRef.current = null;
    colorAttrRef.current = null;
    sliceStrideRef.current = 0;
  }

  function initLivePoints() {
    const scene = sceneRef.current;
    const hidden = hiddenCanvasRef.current;
    if (!scene || !hidden) {
      setStatus("Three.js 초기화가 아직 완료되지 않았습니다.");
      return false;
    }

    const totalPixels = targetW * targetH;
    const totalPoints = totalPixels * targetFrames;
    if (totalPoints <= 0) {
      setStatus("타깃 해상도/프레임 수가 올바르지 않습니다.");
      return false;
    }

    const positions = new Float32Array(totalPoints * 3);
    const colors = new Float32Array(totalPoints * 3);

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
          colors[idx] = 0;
          colors[idx + 1] = 0;
          colors[idx + 2] = 0;
          i++;
        }
      }
    }

    hidden.width = targetW;
    hidden.height = targetH;
    const ctx = hidden.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      setStatus("Canvas 컨텍스트를 생성하지 못했습니다.");
      return false;
    }
    ctxRef.current = ctx;

    disposePoints();

    const geometry = new THREE.BufferGeometry();
    const positionAttr = new THREE.BufferAttribute(positions, 3);
    const colorAttr = new THREE.BufferAttribute(colors, 3);
    geometry.setAttribute("position", positionAttr);
    geometry.setAttribute("color", colorAttr);

    const vertexShader = `
      attribute vec3 color;
      varying vec3 vColor;
      varying float vMask;
      uniform float uSize;
      uniform bool  uAttenuate;
      uniform float uZScale;
      uniform vec2  uXRange;
      uniform vec2  uYRange;
      uniform vec2  uZRange;
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
          size = uSize * (300.0 / -mvPosition.z);
        }
        gl_PointSize = size;
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
      },
    });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    scene.add(points);

    pointsRef.current = points;
    materialRef.current = material;
    positionsRef.current = positions;
    colorsRef.current = colors;
    colorAttrRef.current = colorAttr;
    sliceStrideRef.current = totalPixels * 3;

    extentsRef.current.xMinAll = -xHalf;
    extentsRef.current.xMaxAll = xHalf;
    extentsRef.current.yMinAll = -yHalf;
    extentsRef.current.yMaxAll = yHalf;
    extentsRef.current.zMinBase = -zHalf;
    extentsRef.current.zMaxBase = zHalf;

    setXMin(-xHalf);
    setXMax(xHalf);
    setYMin(-yHalf);
    setYMax(yHalf);
    setZMin(-zHalf * spacing);
    setZMax(zHalf * spacing);

    cameraRef.current?.position.set(0, 0, 180);
    controlsRef.current?.target.set(0, 0, 0);
    controlsRef.current?.update();

    frameCountRef.current = 0;
    return true;
  }

  const processFrame = () => {
    if (!capturingRef.current) return;
    const video = videoRef.current;
    const ctx = ctxRef.current;
    const colors = colorsRef.current;
    const colorAttr = colorAttrRef.current;
    const sliceStride = sliceStrideRef.current;
    if (!video || !ctx || !colors || !colorAttr || sliceStride === 0) return;

    ctx.drawImage(video, 0, 0, targetW, targetH);
    const { data } = ctx.getImageData(0, 0, targetW, targetH);
    const pixelCount = targetW * targetH;

    if (targetFrames > 1) {
      colors.copyWithin(0, sliceStride);
    }

    let offset = colors.length - sliceStride;
    for (let p = 0; p < pixelCount; p++) {
      const base = p * 4;
      colors[offset++] = data[base] / 255;
      colors[offset++] = data[base + 1] / 255;
      colors[offset++] = data[base + 2] / 255;
    }

    colorAttr.needsUpdate = true;
    frameCountRef.current += 1;
    if (frameCountRef.current % 30 === 0) {
      setStatus(`라이브 업데이트 중... (${frameCountRef.current} frames)`);
    }
  };

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
      setStatus("라이브 캡처가 시작되었습니다.");
      scheduleNextFrame();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus(`오류 발생: ${message}`);
      stopCapture({ skipState: true, skipStatus: true });
    }
  }

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

    rvfcRef.current = null;

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }

    ctxRef.current = null;

    if (!skipStatus) {
      append("라이브 캡처가 중지되었습니다.");
    }
  }

  // spacing 변경 시 slicer 범위를 유효 범위에 맞게 자동 조정
  useEffect(() => {
    const { zMinBase, zMaxBase } = extentsRef.current;
    const minLegal = zMinBase * spacing;
    const maxLegal = zMaxBase * spacing;
    setZMin(prev => (prev < minLegal ? minLegal : prev));
    setZMax(prev => (prev > maxLegal ? maxLegal : prev));
  }, [spacing]);

  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

  return (
    <div style={{ width: "100vw", height: "100vh", background: "#111", color: "#eee" }}>
      <button
        onClick={() => setShowUI(prev => !prev)}
        style={{
          position: "fixed",
          top: 10,
          right: 10,
          zIndex: 20,
          background: showUI ? "rgba(0,0,0,.6)" : "rgba(0,0,0,0)",
          color: showUI ? "#eee" : "rgba(255,255,255,0)",
          border: showUI ? "1px solid rgba(255,255,255,.25)" : "1px solid rgba(255,255,255,0)",
          borderRadius: 6,
          padding: "6px 10px",
          cursor: "pointer",
          transition: "all 0.3s ease",
        }}
        onMouseEnter={(e) => {
          if (!showUI) {
            e.currentTarget.style.background = "rgba(0,0,0,.3)";
            e.currentTarget.style.color = "#eee";
            e.currentTarget.style.border = "1px solid rgba(255,255,255,.15)";
          }
        }}
        onMouseLeave={(e) => {
          if (!showUI) {
            e.currentTarget.style.background = "rgba(0,0,0,0)";
            e.currentTarget.style.color = "rgba(255,255,255,0)";
            e.currentTarget.style.border = "1px solid rgba(255,255,255,0)";
          }
        }}
      >
        {showUI ? "UI 숨기기" : "UI 보이기"}
      </button>

      {/* UI Panel */}
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

          <label>W×H</label>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              type="number"
              value={targetW}
              min={8}
              step={8}
              style={{ width: 70 }}
              onChange={(e) => setTargetW(parseInt(e.currentTarget.value || "128", 10))}
              disabled={isCapturing}
            />
            <input
              type="number"
              value={targetH}
              min={8}
              step={8}
              style={{ width: 70 }}
              onChange={(e) => setTargetH(parseInt(e.currentTarget.value || "72", 10))}
              disabled={isCapturing}
            />
          </div>
          <span />

          <label>Frames</label>
          <input
            type="number"
            value={targetFrames}
            min={2}
            step={1}
            style={{ width: 70 }}
            onChange={(e) => setTargetFrames(parseInt(e.currentTarget.value || "60", 10))}
            disabled={isCapturing}
          />
          <span />

          {/* Visual controls */}
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
            max={5}
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

          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={autoRotate}
              onChange={(e) => setAutoRotate(e.currentTarget.checked)}
            />
            자동 회전
          </label>
          <span />
          <span />

          {autoRotate && (
            <>
              <label>회전 속도</label>
              <input
                type="range"
                min={0.1}
                max={2}
                step={0.1}
                value={autoRotateSpeed}
                onChange={(e) => setAutoRotateSpeed(parseFloat(e.currentTarget.value))}
              />
              <span style={{ opacity: 0.8 }}>{autoRotateSpeed.toFixed(1)}</span>

              <label>줌</label>
              <input
                type="range"
                min={0.5}
                max={3}
                step={0.1}
                value={cameraZoom}
                onChange={(e) => setCameraZoom(parseFloat(e.currentTarget.value))}
              />
              <span style={{ opacity: 0.8 }}>{cameraZoom.toFixed(1)}</span>
            </>
          )}

          <label>X slice</label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <input
              type="range"
              min={extentsRef.current.xMinAll}
              max={extentsRef.current.xMaxAll}
              step={1}
              value={xMin}
              onChange={(e) =>
                setXMin(
                  clamp(parseFloat(e.currentTarget.value), extentsRef.current.xMinAll, xMax)
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
                  clamp(parseFloat(e.currentTarget.value), xMin, extentsRef.current.xMaxAll)
                )
              }
            />
          </div>
          <span style={{ opacity: 0.8 }}>
            {xMin.toFixed(0)} ~ {xMax.toFixed(0)}
          </span>

          <label>Y slice</label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <input
              type="range"
              min={extentsRef.current.yMinAll}
              max={extentsRef.current.yMaxAll}
              step={1}
              value={yMin}
              onChange={(e) =>
                setYMin(
                  clamp(parseFloat(e.currentTarget.value), extentsRef.current.yMinAll, yMax)
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
                  clamp(parseFloat(e.currentTarget.value), yMin, extentsRef.current.yMaxAll)
                )
              }
            />
          </div>
          <span style={{ opacity: 0.8 }}>
            {yMin.toFixed(0)} ~ {yMax.toFixed(0)}
          </span>

          <label>Z slice</label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
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
        </div>
      )}

      {/* Status Log */}
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

      {/* Hidden sampling canvas & video */}
      <canvas ref={hiddenCanvasRef} style={{ display: "none" }} />
      <video ref={videoRef} muted playsInline style={{ display: "none" }} />

      {/* Three mount */}
      <div ref={mountRef} style={{ position: "absolute", inset: 0 }} />
    </div>
  );
}
