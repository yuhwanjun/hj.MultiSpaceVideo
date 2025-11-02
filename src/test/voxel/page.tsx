"use client";

import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

// -------------------------------------------------------------
// VoxelVideo.tsx
// Next.js (App Router) client component to turn a video into a 3D volume
// and explore it via volume ray-marching (WebGL2) or instanced voxels fallback.
// -------------------------------------------------------------

const DEBUG_LOG = true;

// UI helpers
function LabeledRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-4 py-1">
      <div className="w-40 text-sm text-neutral-500">{label}</div>
      <div className="flex-1">{children}</div>
    </div>
  );
}

// GLSL: volume raymarcher (WebGL2 required)
const volumeVertex = /* glsl */ `
precision highp float;

in vec3 position;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

out vec3 vWorldPos;

void main(){
  vec4 worldPos = modelViewMatrix * vec4(position, 1.0);
  vWorldPos = position * 0.5 + 0.5; // object space cube [-1,1] -> [0,1]
  gl_Position = projectionMatrix * worldPos;
}
`;

const volumeFragment = /* glsl */ `
precision highp float;
precision highp sampler3D;

// uniforms
uniform highp sampler3D uVolume;
uniform vec3 uDims;           // (width, height, depth)
uniform float uSteps;         // ray-march steps
uniform float uBrightness;    // overall brightness
uniform float uAlpha;         // alpha multiplier
uniform float uThreshold;     // density threshold
uniform vec3 uSlice;          // slice ratios [0..1] for x,y,z clipping
uniform bool uEnableSlicing;  // toggle slicing

in vec3 vWorldPos; // in [0,1] after mapping
out vec4 outColor;

// Ray-box intersection for unit cube [0,1]
bool intersectAABB(vec3 ro, vec3 rd, out float t0, out float t1){
  vec3 invD = 1.0 / rd;
  vec3 tNear = (vec3(0.0) - ro) * invD;
  vec3 tFar  = (vec3(1.0) - ro) * invD;
  vec3 tmin = min(tNear, tFar);
  vec3 tmax = max(tNear, tFar);
  t0 = max(max(tmin.x, tmin.y), tmin.z);
  t1 = min(min(tmax.x, tmax.y), tmax.z);
  return t1 > max(t0, 0.0);
}

void main(){
  // camera ray in object space: reconstruct from gl_FragCoord is heavy.
  // Simpler: approximate with ray from front to back since we're drawing a cube.
  // Use vWorldPos as entry hint and eye direction from view space z.
  // We'll compute ro/rd in texture space where cube is [0,1]^3.

  // Eye direction in object space cannot be derived directly here; trick: march along view dir z.
  // Instead, we compute the ray from front face along vec3(0,0,1) or -1 depending which face is front.
  // For correctness, render backfaces only and start from them (set material side=BackSide in JS).

  vec3 ro = vWorldPos;
  vec3 rd = normalize(vec3(0.0, 0.0, -1.0));

  float t0, t1;
  if(!intersectAABB(ro, rd, t0, t1)){
    outColor = vec4(0.0);
    return;
  }

  float dt = (t1 - t0) / uSteps;
  vec3 p = ro + rd * (t0 + dt * 0.5);

  vec4 acc = vec4(0.0);

  for (float i = 0.0; i < 2048.0; i += 1.0) {
    if (i >= uSteps) break;

    // Optional axis-aligned slicing
    if(uEnableSlicing){
      if(p.x < uSlice.x || p.y < uSlice.y || p.z < uSlice.z){
        // skip accumulation until after slice plane
      } else {
        vec3 c = texture(uVolume, p).rgb;
        float d = max(max(c.r, c.g), c.b); // use max channel as density
        if(d > uThreshold){
          vec3 col = c * uBrightness;
          float a = clamp(d * uAlpha, 0.0, 1.0);
          // pre-multiplied alpha style compositing
          acc.rgb = acc.rgb + (1.0 - acc.a) * col * a;
          acc.a   = acc.a   + (1.0 - acc.a) * a;
          if(acc.a > 0.98) break;
        }
      }
    } else {
      vec3 c = texture(uVolume, p).rgb;
      float d = max(max(c.r, c.g), c.b);
      if(d > uThreshold){
        vec3 col = c * uBrightness;
        float a = clamp(d * uAlpha, 0.0, 1.0);
        acc.rgb = acc.rgb + (1.0 - acc.a) * col * a;
        acc.a   = acc.a   + (1.0 - acc.a) * a;
        if(acc.a > 0.98) break;
      }
    }

    p += rd * dt;
  }

  outColor = acc;
}
`;

// Utility: extract frames from a <video> into a Uint8Array volume (RGB)
async function videoToVolume(
  file: File,
  targetW: number,
  targetH: number,
  maxFrames: number,
  frameStep: number
): Promise<{ data: Uint8Array; dims: [number, number, number] }> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.src = url;
  video.crossOrigin = "anonymous";
  video.muted = true;
  await video.play().catch(() => {});
  video.pause();

  await new Promise<void>((resolve) => {
    if (video.readyState >= 2) resolve();
    else video.addEventListener("loadeddata", () => resolve(), { once: true });
  });

  const duration = video.duration;
  const totalFramesEst = Math.floor((duration * 30) / frameStep); // assume ~30fps when exact FPS unknown
  const frames = Math.min(maxFrames, Math.max(1, totalFramesEst));

  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

  const data = new Uint8Array(targetW * targetH * frames * 3);

  for (let i = 0; i < frames; i++) {
    const t = Math.min(duration, (i * frameStep) / 30); // rough map: step in 1/30s units
    video.currentTime = t;
    await new Promise<void>((r) =>
      video.addEventListener("seeked", () => r(), { once: true })
    );

    ctx.drawImage(video, 0, 0, targetW, targetH);
    const img = ctx.getImageData(0, 0, targetW, targetH).data;

    // pack RGB slice at depth i
    const sliceOffset = i * targetW * targetH * 3;
    for (let p = 0, q = 0; p < img.length; p += 4, q += 3) {
      data[sliceOffset + q + 0] = img[p + 0];
      data[sliceOffset + q + 1] = img[p + 1];
      data[sliceOffset + q + 2] = img[p + 2];
    }
  }

  URL.revokeObjectURL(url);
  return { data, dims: [targetW, targetH, frames] };
}

// Convert Uint8 RGB -> THREE.Data3DTexture (requires WebGL2)
function makeData3DTexture(data: Uint8Array, w: number, h: number, d: number) {
  // THREE.Data3DTexture expects data length = w*h*d*channels; here channels=3
  const tex = new THREE.Data3DTexture(data, w, h, d);
  tex.format = THREE.RGBFormat;
  tex.type = THREE.UnsignedByteType;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

// Build instanced voxels from volume (thresholded)
function buildInstancedVoxels(
  volume: Uint8Array,
  w: number,
  h: number,
  d: number,
  maxInstances = 120000,
  threshold = 24
) {
  if (DEBUG_LOG) {
    console.log("[VoxelVideo] buildInstancedVoxels:start", { w, h, d, maxInstances, threshold });
  }
  const offsets: number[] = [];
  const colors: number[] = [];

  for (let z = 0; z < d; z++) {
    const sliceOffset = z * w * h * 3;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = sliceOffset + (y * w + x) * 3;
        const r = volume[idx + 0];
        const g = volume[idx + 1];
        const b = volume[idx + 2];
        const v = Math.max(r, g, b);
        if (v > threshold) {
          offsets.push(
            x / w - 0.5 + 0.5 / w,
            y / h - 0.5 + 0.5 / h,
            z / d - 0.5 + 0.5 / d
          );
          colors.push(r / 255, g / 255, b / 255);
        }
        if (offsets.length / 3 >= maxInstances) break;
      }
      if (offsets.length / 3 >= maxInstances) break;
    }
    if (offsets.length / 3 >= maxInstances) break;
  }

  const count = offsets.length / 3;
  if (DEBUG_LOG) {
    console.log("[VoxelVideo] buildInstancedVoxels:counts", { count });
  }
  if (count === 0) {
    if (DEBUG_LOG) {
      console.log("[VoxelVideo] buildInstancedVoxels:empty", { threshold });
    }
    return null;
  }

  const geom = new THREE.BoxGeometry(1 / w, 1 / h, 1 / d);
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
  const mesh = new THREE.InstancedMesh(geom, mat, count);

  const dummy = new THREE.Object3D();
  const colorArray = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const ox = offsets[i * 3 + 0];
    const oy = offsets[i * 3 + 1];
    const oz = offsets[i * 3 + 2];
    const cr = colors[i * 3 + 0];
    const cg = colors[i * 3 + 1];
    const cb = colors[i * 3 + 2];

    dummy.position.set(ox, oy, oz);
    dummy.scale.set(0.9, 0.9, 0.9);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);

    const ci = i * 3;
    colorArray[ci + 0] = cr;
    colorArray[ci + 1] = cg;
    colorArray[ci + 2] = cb;
  }

  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor = new THREE.InstancedBufferAttribute(colorArray, 3);
  mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false;

  if (DEBUG_LOG) {
    console.log("[VoxelVideo] buildInstancedVoxels:meshReady", { count });
  }

  return mesh;
}

export default function VoxelVideo() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const volumeTexRef = useRef<THREE.Data3DTexture | null>(null);
  const cubeRef = useRef<THREE.Mesh | null>(null);
  const fallbackMeshRef = useRef<THREE.Mesh | null>(null);

  const [webgl2, setWebgl2] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [dims, setDims] = useState<[number, number, number] | null>(null);

  // UI states
  const [targetW, setTargetW] = useState(96);
  const [targetH, setTargetH] = useState(96);
  const [maxFrames, setMaxFrames] = useState(128);
  const [frameStep, setFrameStep] = useState(2); // sample every ~2 frames

  const [steps, setSteps] = useState(256);
  const [brightness, setBrightness] = useState(1.0);
  const [alphaMul, setAlphaMul] = useState(1.0);
  const [threshold, setThreshold] = useState(0.08);
  const [slicing, setSlicing] = useState(false);
  const [sliceX, setSliceX] = useState(0.0);
  const [sliceY, setSliceY] = useState(0.0);
  const [sliceZ, setSliceZ] = useState(0.0);

  const [mode, setMode] = useState<"volume" | "voxels">("volume");

  useEffect(() => {
    // Mount Three.js scene
    const container = mountRef.current!;
    const canvas = document.createElement("canvas");
    if (DEBUG_LOG) {
      console.log("[VoxelVideo] init:mountEffect", { containerSize: { w: container.clientWidth, h: container.clientHeight } });
    }
    const webgl2Context = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
    const renderer = new THREE.WebGLRenderer({
      canvas,
      context: webgl2Context ?? undefined,
      antialias: true,
      alpha: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    setWebgl2(Boolean(webgl2Context));
    if (DEBUG_LOG) {
      console.log("[VoxelVideo] init:webglContext", { webgl2: Boolean(webgl2Context) });
    }

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(
      50,
      container.clientWidth / container.clientHeight,
      0.01,
      100
    );
    camera.position.set(1.5, 1.2, 1.5);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    scene.add(new THREE.AmbientLight(0xffffff, 0.9));

    // Unit cube which will hold the volume material; render back faces for entry points
    const cube = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ wireframe: true, color: 0x888888 })
    );
    scene.add(cube);
    cubeRef.current = cube;

    // Axes helper
    scene.add(new THREE.AxesHelper(1.2));

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;
    controlsRef.current = controls;

    let frame = 0;
    const onResize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      if (DEBUG_LOG) {
        console.log("[VoxelVideo] resize", { w, h });
      }
    };
    window.addEventListener("resize", onResize);

    const loop = () => {
      if (DEBUG_LOG && frame < 5) {
        console.log("[VoxelVideo] renderLoop", { frame });
        if (fallbackMeshRef.current) {
          const mesh = fallbackMeshRef.current as THREE.InstancedMesh<THREE.BufferGeometry, THREE.Material>;
          const attrs = mesh.geometry?.attributes ?? {};
          const attrInfo = Object.fromEntries(
            Object.entries(attrs).map(([key, value]) => [
              key,
              value
                ? {
                    itemSize: value.itemSize,
                    count: value.count,
                    isInterleaved: (value as any).isInterleavedBufferAttribute ?? false,
                    isInstanced: (value as any).isInstancedBufferAttribute ?? false,
                  }
                : null,
            ])
          );
          console.log("[VoxelVideo] renderLoop:fallbackAttrs", {
            attrInfo,
            count: mesh.count,
            instanceMatrixCount: mesh.instanceMatrix?.count,
          });
        }
      }
      controls.update();
      try {
        renderer.render(scene, camera);
      } catch (err) {
        console.error("[VoxelVideo] renderLoop:error", err, {
          fallbackMesh: fallbackMeshRef.current,
          fallbackGeometry: fallbackMeshRef.current?.geometry,
          fallbackAttributes: fallbackMeshRef.current?.geometry?.attributes,
        });
        throw err;
      }
      frame += 1;
      requestAnimationFrame(loop);
    };
    loop();

    return () => {
      if (DEBUG_LOG) {
        console.log("[VoxelVideo] cleanup");
      }
      window.removeEventListener("resize", onResize);
      renderer.dispose();
      container.removeChild(renderer.domElement);
    };
  }, []);

  // Build / update volume material when texture or params change
  useEffect(() => {
    if (!rendererRef.current || !sceneRef.current || !cubeRef.current) return;
    const cube = cubeRef.current;

    if (mode === "volume" && webgl2 && volumeTexRef.current && dims) {
      if (DEBUG_LOG) {
        console.log("[VoxelVideo] effect:buildVolumeMaterial", { dims, webgl2, mode });
      }
      const mat = new THREE.RawShaderMaterial({
        vertexShader: volumeVertex,
        fragmentShader: volumeFragment,
        side: THREE.BackSide, // render back faces for entry points
        transparent: true,
        depthTest: true,
        depthWrite: false,
        glslVersion: THREE.GLSL3,
        uniforms: {
          uVolume: { value: volumeTexRef.current },
          uDims: { value: new THREE.Vector3(dims[0], dims[1], dims[2]) },
          uSteps: { value: steps },
          uBrightness: { value: brightness },
          uAlpha: { value: alphaMul },
          uThreshold: { value: threshold },
          uSlice: { value: new THREE.Vector3(sliceX, sliceY, sliceZ) },
          uEnableSlicing: { value: slicing },
        },
      });
      const previousMaterial = cube.material as THREE.Material | undefined;
      cube.material = mat;
      previousMaterial?.dispose();

      // remove fallback if present
      if (fallbackMeshRef.current) {
        if (DEBUG_LOG) {
          console.log("[VoxelVideo] effect:removeFallbackMesh");
        }
        sceneRef.current!.remove(fallbackMeshRef.current);
        fallbackMeshRef.current.geometry.dispose();
        (fallbackMeshRef.current.material as THREE.Material).dispose();
        fallbackMeshRef.current = null;
      }
    } else if (mode === "voxels" && volumeTexRef.current && dims) {
      // Build a thresholded instanced voxel mesh
      // NOTE: This recreates on each param change; in production, memoize & diff.
      if (fallbackMeshRef.current) {
        if (DEBUG_LOG) {
          console.log("[VoxelVideo] effect:clearExistingFallback");
        }
        sceneRef.current!.remove(fallbackMeshRef.current);
        fallbackMeshRef.current.geometry.dispose();
        (fallbackMeshRef.current.material as THREE.Material).dispose();
        fallbackMeshRef.current = null;
      }
      const tex = volumeTexRef.current;
      // Access underlying data from Data3DTexture is not stored; we need retained buffer.
      // For demo, store it on (tex as any)._data when creating; we will rely on that.
      const raw: Uint8Array | undefined = (tex as any)._data;
      if (raw) {
        const mesh = buildInstancedVoxels(
          raw,
          dims[0],
          dims[1],
          dims[2],
          120000,
          Math.floor(threshold * 255)
        );
        if (mesh) {
          if (DEBUG_LOG) {
            console.log("[VoxelVideo] effect:addFallbackMesh", { instanceCount: (mesh as any).count });
          }
          mesh.position.set(0, 0, 0);
          sceneRef.current!.add(mesh);
          fallbackMeshRef.current = mesh;
          // show cube wireframe as boundary
          const previousMaterial = cube.material as THREE.Material | undefined;
          cube.material = new THREE.MeshBasicMaterial({
            wireframe: true,
            color: 0x666666,
          });
          cube.renderOrder = -1;
          previousMaterial?.dispose();
        }
      } else if (DEBUG_LOG) {
        console.log("[VoxelVideo] effect:noRawVolumeData");
      }
    }
  }, [
    webgl2,
    mode,
    steps,
    brightness,
    alphaMul,
    threshold,
    slicing,
    sliceX,
    sliceY,
    sliceZ,
    dims,
  ]);

  // Handle file upload
  const onFile = async (file?: File) => {
    if (!file) return;
    setLoading(true);
    try {
      const { data, dims } = await videoToVolume(
        file,
        targetW,
        targetH,
        maxFrames,
        frameStep
      );
      const [w, h, d] = dims;
      const tex = makeData3DTexture(data, w, h, d);
      (tex as any)._data = data; // retain raw for fallback voxel build
      volumeTexRef.current = tex;
      setDims(dims);

      // trigger material build
      if (mode === "volume" && webgl2) {
        setMode("volume");
      } else {
        setMode("voxels");
      }
    } catch (e) {
      console.error(e);
      alert(
        "Failed to build volume from video. Try smaller resolution or fewer frames."
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-full h-full grid grid-cols-1 md:grid-cols-12 gap-4 p-4">
      <div
        ref={mountRef}
        className="col-span-1 md:col-span-9 w-full h-[60vh] md:h-[80vh] rounded-2xl bg-neutral-950/50 border border-neutral-800"
      />

      <div className="col-span-1 md:col-span-3 p-4 rounded-2xl border border-neutral-800 bg-neutral-900/40 backdrop-blur-sm">
        <h2 className="text-lg font-semibold mb-2">
          3D 비주얼라이저 (Video → Volume)
        </h2>
        <p className="text-sm text-neutral-400 mb-4">
          영상의 프레임을 Z축으로 쌓아 3D 볼륨으로 변환합니다. 회전·절단·광량을
          조절해 새로운 시점을 탐색하세요.
        </p>

        <LabeledRow label="비디오 업로드">
          <input
            type="file"
            accept="video/*"
            onChange={(e) => onFile(e.target.files?.[0])}
          />
        </LabeledRow>

        <div className="h-px bg-neutral-800 my-2" />
        <div className="text-xs text-neutral-500 mb-2">
          사전 변환 파라미터 (리샘플링)
        </div>
        <LabeledRow label={`가로 해상도 (${targetW})`}>
          <input
            type="range"
            min={32}
            max={192}
            value={targetW}
            onChange={(e) => setTargetW(parseInt(e.target.value))}
          />
        </LabeledRow>
        <LabeledRow label={`세로 해상도 (${targetH})`}>
          <input
            type="range"
            min={32}
            max={192}
            value={targetH}
            onChange={(e) => setTargetH(parseInt(e.target.value))}
          />
        </LabeledRow>
        <LabeledRow label={`프레임 수 (${maxFrames})`}>
          <input
            type="range"
            min={16}
            max={256}
            value={maxFrames}
            onChange={(e) => setMaxFrames(parseInt(e.target.value))}
          />
        </LabeledRow>
        <LabeledRow label={`프레임 스텝 (${frameStep})`}>
          <input
            type="range"
            min={1}
            max={8}
            value={frameStep}
            onChange={(e) => setFrameStep(parseInt(e.target.value))}
          />
        </LabeledRow>

        <div className="h-px bg-neutral-800 my-2" />
        <div className="text-xs text-neutral-500 mb-2">표현 모드</div>
        <LabeledRow label="모드">
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as any)}
            className="bg-neutral-800 text-neutral-100 px-2 py-1 rounded-md"
          >
            <option value="volume">볼륨(레이마칭)</option>
            <option value="voxels">복셀(인스턴스)</option>
          </select>
        </LabeledRow>

        {mode === "volume" && (
          <>
            <LabeledRow label={`샘플 스텝 (${steps})`}>
              <input
                type="range"
                min={64}
                max={768}
                value={steps}
                onChange={(e) => setSteps(parseInt(e.target.value))}
              />
            </LabeledRow>
            <LabeledRow label={`밝기 (${brightness.toFixed(2)})`}>
              <input
                type="range"
                min={0.2}
                max={3}
                step={0.01}
                value={brightness}
                onChange={(e) => setBrightness(parseFloat(e.target.value))}
              />
            </LabeledRow>
            <LabeledRow label={`알파 (${alphaMul.toFixed(2)})`}>
              <input
                type="range"
                min={0.2}
                max={3}
                step={0.01}
                value={alphaMul}
                onChange={(e) => setAlphaMul(parseFloat(e.target.value))}
              />
            </LabeledRow>
            <LabeledRow label={`임계값 (${threshold.toFixed(2)})`}>
              <input
                type="range"
                min={0}
                max={0.6}
                step={0.01}
                value={threshold}
                onChange={(e) => setThreshold(parseFloat(e.target.value))}
              />
            </LabeledRow>
            <LabeledRow label="슬라이싱 활성화">
              <input
                type="checkbox"
                checked={slicing}
                onChange={(e) => setSlicing(e.target.checked)}
              />
            </LabeledRow>
            {slicing && (
              <>
                <LabeledRow label={`Slice X (${sliceX.toFixed(2)})`}>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.001}
                    value={sliceX}
                    onChange={(e) => setSliceX(parseFloat(e.target.value))}
                  />
                </LabeledRow>
                <LabeledRow label={`Slice Y (${sliceY.toFixed(2)})`}>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.001}
                    value={sliceY}
                    onChange={(e) => setSliceY(parseFloat(e.target.value))}
                  />
                </LabeledRow>
                <LabeledRow label={`Slice Z (${sliceZ.toFixed(2)})`}>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.001}
                    value={sliceZ}
                    onChange={(e) => setSliceZ(parseFloat(e.target.value))}
                  />
                </LabeledRow>
              </>
            )}
          </>
        )}

        {mode === "voxels" && (
          <>
            <div className="text-xs text-neutral-500">
              복셀 모드는 WebGL1에서도 동작하지만 많은 인스턴스는 성능에 영향을
              줍니다.
            </div>
          </>
        )}

        <div className="mt-3 text-xs text-neutral-500">
          {loading
            ? "변환 중… (해상도·프레임 수를 낮추면 빨라집니다)"
            : dims
            ? `볼륨 크기: ${dims[0]}×${dims[1]}×${dims[2]}`
            : "준비됨"}
          <br />
          {webgl2 === false && (
            <span className="text-amber-400">
              WebGL2 미지원: 레이마칭 대신 복셀 모드를 사용하세요.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
