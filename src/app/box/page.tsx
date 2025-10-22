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

  const [status, setStatus] = useState<string>("비디오를 선택해 주세요.");
  const [objURL, setObjURL] = useState<string | null>(null);

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
    camera.position.set(0, 0, 180);
    cameraRef.current = camera;

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controlsRef.current = controls;

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

    // Animation loop
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      controls.update();
      renderer.render(scene, camera);
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);

      // dispose three objects
      if (pointsRef.current) {
        pointsRef.current.geometry.dispose();
        (pointsRef.current.material as THREE.Material).dispose();
        scene.remove(pointsRef.current);
        pointsRef.current = null;
      }

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

  function revokeObjURL() {
    if (objURL) URL.revokeObjectURL(objURL);
    setObjURL(null);
  }

  async function waitVideoFrame(video: HTMLVideoElement) {
    if (hasRVFC) {
      await new Promise<void>(resolve => {
        video.requestVideoFrameCallback(() => resolve());
      });
      return;
    }
    await new Promise<void>(resolve => {
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
  }

  async function sampleVideoToBuffers({
    targetW,
    targetH,
    targetFrames,
  }: {
    targetW: number;
    targetH: number;
    targetFrames: number;
  }) {
    const video = videoRef.current!;
    const hidden = hiddenCanvasRef.current!;
    const ctx = hidden.getContext("2d", { willReadFrequently: true })!;

    await video.play().catch(() => {});
    await new Promise(r => setTimeout(r, 50));
    video.pause();

    const duration = video.duration;
    if (!isFinite(duration) || duration <= 0) throw new Error("비디오 duration을 읽지 못했습니다.");

    hidden.width = targetW;
    hidden.height = targetH;

    const totalPoints = targetW * targetH * targetFrames;
    const positions = new Float32Array(totalPoints * 3);
    const colors = new Float32Array(totalPoints * 3);

    const dt = duration / Math.max(1, targetFrames - 1);

    let i = 0;
    for (let f = 0; f < targetFrames; f++) {
      const t = Math.min(dt * f, duration - 1e-4);
      video.currentTime = t;

      await waitVideoFrame(video);

      ctx.drawImage(video, 0, 0, targetW, targetH);
      const { data } = ctx.getImageData(0, 0, targetW, targetH); // RGBA

      const sx = 1; // x scale unit
      const sy = 1; // y scale unit
      // z는 기본 단위 1로 저장하고, 실제 간격은 shader uniform(uZScale)로 제어

      for (let y = 0; y < targetH; y++) {
        const yVal = ((targetH - 1) / 2) - y;
        for (let x = 0; x < targetW; x++) {
          const p = (y * targetW + x) * 4;
          const r = data[p] / 255;
          const g = data[p + 1] / 255;
          const b = data[p + 2] / 255;

          const idx = i * 3;

          positions[idx] = (x - (targetW - 1) / 2) * sx;
          positions[idx + 1] = yVal * sy;
          positions[idx + 2] = (f - (targetFrames - 1) / 2); // z 기본단위 1

          colors[idx] = r;
          colors[idx + 1] = g;
          colors[idx + 2] = b;

          i++;
        }
      }
      append(`프레임 ${f + 1}/${targetFrames} 캡처 (t=${t.toFixed(2)}s)`);
    }

    // Update extents for slicers
    extentsRef.current.xMinAll = - (targetW - 1) / 2;
    extentsRef.current.xMaxAll =   (targetW - 1) / 2;
    extentsRef.current.yMinAll = - (targetH - 1) / 2;
    extentsRef.current.yMaxAll =   (targetH - 1) / 2;
    extentsRef.current.zMinBase = - (targetFrames - 1) / 2; // spacing 적용 전
    extentsRef.current.zMaxBase =   (targetFrames - 1) / 2;

    setXMin(extentsRef.current.xMinAll);
    setXMax(extentsRef.current.xMaxAll);
    setYMin(extentsRef.current.yMinAll);
    setYMax(extentsRef.current.yMaxAll);
    setZMin(extentsRef.current.zMinBase * spacing);
    setZMax(extentsRef.current.zMaxBase * spacing);

    return { positions, colors };
  }

  function visualize(buffers: { positions: Float32Array; colors: Float32Array }) {
    const scene = sceneRef.current!;
    const camera = cameraRef.current!;

    if (pointsRef.current) {
      scene.remove(pointsRef.current);
      pointsRef.current.geometry.dispose();
      (pointsRef.current.material as THREE.Material).dispose();
      pointsRef.current = null;
      materialRef.current = null;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(buffers.positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(buffers.colors, 3));

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

    camera.position.set(0, 0, 180);
    controlsRef.current?.target.set(0, 0, 0);
    controlsRef.current?.update();
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
          <input
            type="file"
            accept="video/*"
            onChange={(e) => {
              revokeObjURL();
              const f = e.currentTarget.files?.[0];
              if (!f) return;
              const url = URL.createObjectURL(f);
              setObjURL(url);
              if (videoRef.current) {
                videoRef.current.src = url;
                videoRef.current.load();
              }
              setStatus("비디오 로드 완료. 샘플링을 실행하세요.");
            }}
          />

          <label>W×H</label>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              type="number"
              value={targetW}
              min={8}
              step={8}
              style={{ width: 70 }}
              onChange={(e) => setTargetW(parseInt(e.currentTarget.value || "128", 10))}
            />
            <input
              type="number"
              value={targetH}
              min={8}
              step={8}
              style={{ width: 70 }}
              onChange={(e) => setTargetH(parseInt(e.currentTarget.value || "72", 10))}
            />
          </div>

          <label>Frames</label>
          <input
            type="number"
            value={targetFrames}
            min={2}
            step={1}
            style={{ width: 70 }}
            onChange={(e) => setTargetFrames(parseInt(e.currentTarget.value || "60", 10))}
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

          <button
            onClick={async () => {
              try {
                if (!videoRef.current?.src) {
                  log("먼저 비디오를 선택해 주세요.");
                  return;
                }
                log(`샘플링 시작: ${targetW}×${targetH}, ${targetFrames} frames`);
                const buffers = await sampleVideoToBuffers({ targetW, targetH, targetFrames });
                visualize(buffers);
                append("시각화 완료.");
              } catch (err: unknown) {
                append("에러: " + (err instanceof Error ? err.message : String(err)));
              }
            }}
            style={{ gridColumn: "1 / -1" }}
          >
            샘플링 & 렌더
          </button>

          <button
            onClick={() => {
              const scene = sceneRef.current;
              if (scene && pointsRef.current) {
                scene.remove(pointsRef.current);
                pointsRef.current.geometry.dispose();
                (pointsRef.current.material as THREE.Material).dispose();
                pointsRef.current = null;
                materialRef.current = null;
              }
              setStatus("초기화됨.");
            }}
          >
            초기화
          </button>
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
