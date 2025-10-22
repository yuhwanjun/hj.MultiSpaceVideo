"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/**
 * Next.js + three.js + canvas 포팅 버전 (App Router)
 * - 파일 경로: app/page.tsx 로 사용하세요.
 * - 페이지에서 비디오를 선택하면 지정 해상도(WxH)와 프레임 수만큼 샘플링하여 Float32Array에 누적하고
 *   THREE.Points로 3D로 시각화합니다.
 */
export default function Page() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const pointsRef = useRef<THREE.Points | null>(null);

  // Hidden 2D canvas + video for sampling
  const hiddenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [status, setStatus] = useState<string>("비디오를 선택해 주세요.");
  const [objURL, setObjURL] = useState<string | null>(null);

  // UI controls state
  const [targetW, setTargetW] = useState<number>(128);
  const [targetH, setTargetH] = useState<number>(72);
  const [targetFrames, setTargetFrames] = useState<number>(60);

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

      const sx = 1;
      const sy = 1;
      const sz = 2; // frame spacing

      for (let y = 0; y < targetH; y++) {
        for (let x = 0; x < targetW; x++) {
          const p = (y * targetW + x) * 4;
          const r = data[p] / 255;
          const g = data[p + 1] / 255;
          const b = data[p + 2] / 255;

          const idx = i * 3;

          positions[idx] = (x - (targetW - 1) / 2) * sx;
          positions[idx + 1] = (y - (targetH - 1) / 2) * sy;
          positions[idx + 2] = (f - (targetFrames - 1) / 2) * sz;

          colors[idx] = r;
          colors[idx + 1] = g;
          colors[idx + 2] = b;

          i++;
        }
      }
      append(`프레임 ${f + 1}/${targetFrames} 캡처 (t=${t.toFixed(2)}s)`);
    }

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
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(buffers.positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(buffers.colors, 3));

    const material = new THREE.PointsMaterial({
      size: 2,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 1.0,
    });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    scene.add(points);
    pointsRef.current = points;

    camera.position.set(0, 0, 180);
    controlsRef.current?.target.set(0, 0, 0);
    controlsRef.current?.update();
  }

  return (
    <div style={{ width: "100vw", height: "100vh", background: "#111", color: "#eee" }}>
      {/* UI Panel */}
      <div
        style={{
          position: "fixed",
          top: 10,
          left: 10,
          zIndex: 10,
          background: "rgba(0,0,0,.5)",
          padding: "10px 12px",
          borderRadius: 8,
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
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

        <label>Frames</label>
        <input
          type="number"
          value={targetFrames}
          min={2}
          step={1}
          style={{ width: 70 }}
          onChange={(e) => setTargetFrames(parseInt(e.currentTarget.value || "60", 10))}
        />

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
            } catch (err) {
              append("에러: " + err?.message ?? String(err));
            }
          }}
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
            }
            setStatus("초기화됨.");
          }}
        >
          초기화
        </button>
      </div>

      {/* Status Log */}
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

      {/* Hidden sampling canvas & video */}
      <canvas ref={hiddenCanvasRef} style={{ display: "none" }} />
      <video ref={videoRef} muted playsInline style={{ display: "none" }} />

      {/* Three mount */}
      <div ref={mountRef} style={{ position: "absolute", inset: 0 }} />
    </div>
  );
}
