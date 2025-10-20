"use client";

import { Canvas, useThree } from "@react-three/fiber";
// import { useWebcamTexture } from "@/hooks/useWebcamTexture";
import {
  OrbitControls,
  OrthographicCamera as DreiOrthographicCamera,
  PerspectiveCamera as DreiPerspectiveCamera,
} from "@react-three/drei";
import {
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  useCallback,
  useEffect,
} from "react";
import type { ChangeEvent } from "react";
import type {
  Camera,
  InstancedMesh,
  MeshStandardMaterial,
  OrthographicCamera,
  PerspectiveCamera,
} from "three";
import {
  LinearFilter,
  Matrix4,
  SRGBColorSpace,
  VideoTexture,
  InstancedBufferAttribute,
  Color,
  Vector2,
} from "three";
import type { OrbitControls as OrbitControlsImpl } from "three/examples/jsm/controls/OrbitControls";

const GRID_SIZE_X = 100;
const GRID_SIZE_Y = 100;
const GRID_SIZE_Z = 1;
const GRID_SPACING = 1;
const MAX_GRID_AXIS = Math.max(GRID_SIZE_X, GRID_SIZE_Y, GRID_SIZE_Z);
const CAMERA_DISTANCE = MAX_GRID_AXIS * GRID_SPACING * 1.2;
const DEFAULT_ZOOM = Math.max(10, MAX_GRID_AXIS * 0.8);

type ViewMode = "iso" | "+x" | "+y" | "+z";
type ProjectionMode = "orthographic" | "perspective";

const VIEW_CONFIG: Record<
  ViewMode,
  { position: [number, number, number]; up: [number, number, number] }
> = {
  iso: {
    position: [CAMERA_DISTANCE, CAMERA_DISTANCE, CAMERA_DISTANCE],
    up: [0, 1, 0],
  },
  "+x": {
    position: [CAMERA_DISTANCE, 0, 0],
    up: [0, 1, 0],
  },
  "+y": {
    position: [0, CAMERA_DISTANCE, 0],
    up: [0, 0, 1],
  },
  "+z": {
    position: [0, 0, CAMERA_DISTANCE],
    up: [0, 1, 0],
  },
};

const VIEW_OPTIONS: Array<{ id: ViewMode; label: string }> = [
  { id: "iso", label: "등각" },
  { id: "+x", label: "+X 정면" },
  { id: "+y", label: "+Y 정면" },
  { id: "+z", label: "+Z 정면" },
];

const PERSPECTIVE_DEFAULT_POSITION: [number, number, number] = [
  CAMERA_DISTANCE,
  CAMERA_DISTANCE,
  CAMERA_DISTANCE,
];

type VisibleCounts = {
  x: number;
  y: number;
  z: number;
};

type VoxelData = {
  position: [number, number, number];
  index: [number, number, number];
};

type VoxelGridProps = {
  visibleCounts: VisibleCounts;
  planeIndex: number;
  videoTexture: VideoTexture | null;
};

function VoxelGrid({
  visibleCounts,
  planeIndex,
  videoTexture,
}: VoxelGridProps) {
  const meshRef = useRef<InstancedMesh | null>(null);
  const materialRef = useRef<MeshStandardMaterial | null>(null);
  const baseColor = useMemo(() => new Color("#38bdf8"), []);
  const voxels = useMemo<VoxelData[]>(() => {
    const data: VoxelData[] = [];
    const offsetX = (GRID_SIZE_X - 1) / 2;
    const offsetY = (GRID_SIZE_Y - 1) / 2;
    const offsetZ = (GRID_SIZE_Z - 1) / 2;
    for (let x = 0; x < GRID_SIZE_X; x += 1) {
      for (let y = 0; y < GRID_SIZE_Y; y += 1) {
        for (let z = 0; z < GRID_SIZE_Z; z += 1) {
          data.push({
            position: [
              (x - offsetX) * GRID_SPACING,
              (y - offsetY) * GRID_SPACING,
              (z - offsetZ) * GRID_SPACING,
            ],
            index: [x, y, z],
          });
        }
      }
    }
    return data;
  }, []);

  const indexAttribute = useMemo(() => {
    const array = new Float32Array(voxels.length * 3);
    voxels.forEach(({ index: [ix, iy, iz] }, instanceIndex) => {
      const cursor = instanceIndex * 3;
      array[cursor] = ix;
      array[cursor + 1] = iy;
      array[cursor + 2] = iz;
    });
    return array;
  }, [voxels]);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    mesh.geometry.setAttribute(
      "instanceIndex",
      new InstancedBufferAttribute(indexAttribute, 3)
    );
  }, [indexAttribute]);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const matrix = new Matrix4();
    voxels.forEach(
      ({ position: [px, py, pz], index: [ix, iy, iz] }, instanceIndex) => {
        const isVisible =
          ix < visibleCounts.x && iy < visibleCounts.y && iz < visibleCounts.z;
        matrix.identity();
        if (isVisible) {
          matrix.setPosition(px, py, pz);
        } else {
          matrix.makeScale(0, 0, 0);
        }
        mesh.setMatrixAt(instanceIndex, matrix);
      }
    );
    mesh.instanceMatrix.needsUpdate = true;
  }, [voxels, visibleCounts]);

  useLayoutEffect(() => {
    const material = materialRef.current;
    if (!material) return;

    material.onBeforeCompile = (shader) => {
      shader.uniforms.baseColor = { value: baseColor.clone() };
      shader.uniforms.activePlane = { value: planeIndex };
      shader.uniforms.videoFrame = { value: videoTexture };
      shader.uniforms.hasVideo = { value: videoTexture ? 1 : 0 };
      shader.uniforms.gridSize = { value: new Vector2(GRID_SIZE_X, GRID_SIZE_Y) };

      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
attribute vec3 instanceIndex;
uniform float activePlane;
uniform vec2 gridSize;
uniform float hasVideo;
varying float vSliceFactor;
varying vec2 vSliceUV;
`
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
vSliceFactor = hasVideo > 0.5 ? step(abs(instanceIndex.z - activePlane), 0.49) : 0.0;
vSliceUV = (instanceIndex.xy + 0.5) / gridSize;
`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
uniform sampler2D videoFrame;
uniform vec3 baseColor;
uniform float hasVideo;
varying float vSliceFactor;
varying vec2 vSliceUV;
`
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
vec3 finalColor = baseColor;
if (hasVideo > 0.5 && vSliceFactor > 0.5) {
  vec4 texColor = texture2D(videoFrame, vSliceUV);
  finalColor = texColor.rgb;
}
diffuseColor.rgb = finalColor;
`
        );

      material.userData.shader = shader;
    };

    material.needsUpdate = true;

    return () => {
      material.onBeforeCompile = undefined;
      delete material.userData.shader;
    };
  }, [baseColor]);

  useEffect(() => {
    const shader = materialRef.current?.userData.shader;
    if (!shader) return;

    shader.uniforms.activePlane.value = planeIndex;
    shader.uniforms.hasVideo.value = videoTexture ? 1 : 0;
    shader.uniforms.videoFrame.value = videoTexture;
    shader.uniforms.baseColor.value.copy(baseColor);
    shader.uniforms.gridSize.value.set(GRID_SIZE_X, GRID_SIZE_Y);
    if (videoTexture) {
      videoTexture.needsUpdate = true;
    }
  }, [baseColor, planeIndex, videoTexture]);

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, voxels.length]}
      castShadow
      receiveShadow
    >
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial ref={materialRef} color="#38bdf8" />
    </instancedMesh>
  );
}

type ViewButtonGroupProps = {
  value: ViewMode;
  onChange: (mode: ViewMode) => void;
};

function ViewButtonGroup({ value, onChange }: ViewButtonGroupProps) {
  return (
    <div className="space-y-2 text-slate-200">
      <span className="text-[11px] uppercase tracking-wide text-slate-400">
        카메라 뷰
      </span>
      <div className="grid grid-cols-2 gap-2">
        {VIEW_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(option.id)}
            className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${
              value === option.id
                ? "bg-sky-400 text-black"
                : "bg-slate-800/70 text-slate-200 hover:bg-slate-700/80"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

type ProjectionToggleProps = {
  value: ProjectionMode;
  onToggle: () => void;
};

function ProjectionToggle({ value, onToggle }: ProjectionToggleProps) {
  const isOrthographic = value === "orthographic";
  return (
    <div className="space-y-2 text-slate-200">
      <span className="text-[11px] uppercase tracking-wide text-slate-400">
        투영 방식
      </span>
      <button
        type="button"
        onClick={onToggle}
        className={`w-full rounded-md px-2 py-1 text-xs font-medium transition-colors ${
          isOrthographic
            ? "bg-sky-400 text-black"
            : "bg-slate-800/70 text-slate-200 hover:bg-slate-700/80"
        }`}
      >
        {isOrthographic ? "오쏘그래픽" : "퍼스펙티브"}
      </button>
    </div>
  );
}

function CameraRig({
  view,
  projection,
}: {
  view: ViewMode;
  projection: ProjectionMode;
}) {
  const camera = useThree((state) => state.camera as Camera);
  const controls = useThree(
    (state) => state.controls as OrbitControlsImpl | undefined
  );

  useEffect(() => {
    const config = VIEW_CONFIG[view];
    camera.position.set(...config.position);
    camera.up.set(...config.up);
    if ((camera as OrthographicCamera).isOrthographicCamera) {
      const ortho = camera as OrthographicCamera;
      ortho.zoom = DEFAULT_ZOOM;
      ortho.updateProjectionMatrix();
    } else if ((camera as PerspectiveCamera).isPerspectiveCamera) {
      const persp = camera as PerspectiveCamera;
      persp.fov = 50;
      persp.updateProjectionMatrix();
    }
    controls?.target.set(0, 0, 0);
    controls?.update();
  }, [camera, controls, view, projection]);

  return null;
}

type AxisSliderProps = {
  axis: "X" | "Y" | "Z";
  value: number;
  max: number;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
};

function AxisSlider({ axis, value, max, onChange }: AxisSliderProps) {
  return (
    <label className="flex flex-col gap-2 text-slate-200">
      <span className="flex items-center justify-between text-[11px] uppercase tracking-wide text-slate-400">
        <span>{axis}-Axis</span>
        <span>{value}</span>
      </span>
      <input
        type="range"
        min={0}
        max={max}
        step={1}
        value={value}
        onChange={onChange}
        className="h-1 w-full cursor-pointer appearance-none rounded-full bg-slate-700 accent-sky-400"
      />
    </label>
  );
}

export default function Page() {
  // useWebcamTexture 파라미터
  // - width/height: 캡처 타겟 해상도(픽셀)
  // - fps: 초당 프레임 목표값
  const [projectionMode, setProjectionMode] =
    useState<ProjectionMode>("orthographic");
  const [viewMode, setViewMode] = useState<ViewMode>("iso");
  const [visibleCounts, setVisibleCounts] = useState<VisibleCounts>({
    x: GRID_SIZE_X,
    y: GRID_SIZE_Y,
    z: GRID_SIZE_Z,
  });
  const [planeIndex, setPlaneIndex] = useState<number>(
    Math.floor(GRID_SIZE_Z / 2)
  );
  const [videoSource, setVideoSource] = useState<string | null>(null);
  const [videoTexture, setVideoTexture] = useState<VideoTexture | null>(null);
  const [videoDuration, setVideoDuration] = useState<number>(0);
  const [assumedFps, setAssumedFps] = useState<number>(30);
  const [selectedTime, setSelectedTime] = useState<number>(0);
  const objectUrlRef = useRef<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const handleSliderChange = useCallback(
    (axis: keyof VisibleCounts) => (event: ChangeEvent<HTMLInputElement>) => {
      const value = Number(event.target.value);
      const limits: Record<keyof VisibleCounts, number> = {
        x: GRID_SIZE_X,
        y: GRID_SIZE_Y,
        z: GRID_SIZE_Z,
      };
      const clamped = Math.min(Math.max(value, 0), limits[axis]);
      setVisibleCounts((prev) => ({ ...prev, [axis]: clamped }));
    },
    []
  );

  const toggleProjection = useCallback(() => {
    setProjectionMode((prev) =>
      prev === "orthographic" ? "perspective" : "orthographic"
    );
  }, []);

  const handleVideoSelect = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
      }
      const url = URL.createObjectURL(file);
      objectUrlRef.current = url;
      setVideoSource(url);
      setVideoDuration(0);
      setSelectedTime(0);
    },
    []
  );

  const handleFpsChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const value = Number(event.target.value);
    if (!Number.isFinite(value) || value <= 0) return;
    setAssumedFps(value);
  }, []);

  const handleFrameChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const value = Number(event.target.value);
    setSelectedTime(value);
  }, []);

  const handlePlaneChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const next = Number(event.target.value);
    const clamped = Math.min(Math.max(next, 0), Math.max(GRID_SIZE_Z - 1, 0));
    setPlaneIndex(clamped);
  }, []);

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoSource) return;
    video.pause();
    video.crossOrigin = "anonymous";
    video.loop = false;
    video.muted = true;
    video.playsInline = true;
    video.src = videoSource;
    video.load();
  }, [videoSource]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleLoadedMetadata = () => {
      setVideoDuration(video.duration || 0);
      setSelectedTime(0);
      video.pause();
    };

    video.addEventListener("loadedmetadata", handleLoadedMetadata);
    return () => {
      video.removeEventListener("loadedmetadata", handleLoadedMetadata);
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoSource) return;

    const texture = new VideoTexture(video);
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = false;
    texture.colorSpace = SRGBColorSpace;
    setVideoTexture(texture);

    return () => {
      texture.dispose();
      setVideoTexture(null);
    };
  }, [videoSource]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoSource || !videoDuration) return;

    const duration = video.duration || videoDuration;
    if (!Number.isFinite(duration) || duration <= 0) return;

    const clamped = Math.min(Math.max(selectedTime, 0), duration);
    const threshold = 1 / Math.max(assumedFps, 1);

    if (Math.abs(video.currentTime - clamped) < threshold * 0.25) {
      if (videoTexture) {
        videoTexture.needsUpdate = true;
      }
      return;
    }

    let cancelled = false;

    const handleSeeked = () => {
      if (cancelled) return;
      video.pause();
      if (videoTexture) {
        videoTexture.needsUpdate = true;
      }
    };

    video.pause();
    video.addEventListener("seeked", handleSeeked, { once: true });
    video.currentTime = clamped;

    return () => {
      cancelled = true;
      video.removeEventListener("seeked", handleSeeked);
    };
  }, [assumedFps, selectedTime, videoDuration, videoSource, videoTexture]);

  //   const { previewRef } = useWebcamTexture({
  //     width: 128,
  //     height: 128,
  //     fps: 15,
  //     horizontalFlip: true,
  //   });
  return (
    <main className="min-h-screen w-full text-white">
      <div className="fixed inset-0">
        <Canvas
          camera={{
            position: PERSPECTIVE_DEFAULT_POSITION,
            fov: 50,
            near: 0.1,
            far: 2000,
          }}
          className="w-full h-full"
        >
          {projectionMode === "orthographic" ? (
            <DreiOrthographicCamera
              key="ortho-camera"
              makeDefault
              position={VIEW_CONFIG[viewMode].position}
              zoom={DEFAULT_ZOOM}
              near={0.1}
              far={2000}
            />
          ) : (
            <DreiPerspectiveCamera
              key="persp-camera"
              makeDefault
              position={PERSPECTIVE_DEFAULT_POSITION}
              fov={50}
              near={0.1}
              far={2000}
            />
          )}
          <CameraRig view={viewMode} projection={projectionMode} />
          <ambientLight intensity={1} />
          <VoxelGrid
            visibleCounts={visibleCounts}
            planeIndex={planeIndex}
            videoTexture={videoTexture}
          />
          <color attach="background" args={["#000000"]} />
          <OrbitControls makeDefault enableDamping dampingFactor={0.05} />
        </Canvas>
        <div className="absolute top-6 left-6 w-60 space-y-4 rounded-lg bg-black/60 p-4 text-sm">
          <div className="space-y-3 text-slate-200">
            <label className="flex flex-col gap-2">
              <span className="text-[11px] uppercase tracking-wide text-slate-400">
                영상 파일
              </span>
              <input
                type="file"
                accept="video/*"
                onChange={handleVideoSelect}
                className="text-xs text-slate-200"
              />
            </label>
            <label className="flex flex-col gap-2">
              <span className="text-[11px] uppercase tracking-wide text-slate-400">
                FPS 가정값
              </span>
              <input
                type="number"
                min={1}
                max={240}
                step={1}
                value={assumedFps}
                onChange={handleFpsChange}
                className="rounded-md bg-slate-800/70 px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-sky-400"
              />
            </label>
            <label className="flex flex-col gap-2">
              <span className="flex items-center justify-between text-[11px] uppercase tracking-wide text-slate-400">
                <span>프레임 선택</span>
                <span>
                  {videoDuration
                    ? `${Math.round(selectedTime * assumedFps)}/${Math.max(
                        1,
                        Math.round(videoDuration * assumedFps)
                      )}f`
                    : "--"}
                </span>
              </span>
              <input
                type="range"
                min={0}
                max={videoDuration || 0}
                step={videoDuration ? Math.max(1 / assumedFps, 0.01) : 1}
                value={Math.min(selectedTime, videoDuration || 0)}
                onChange={handleFrameChange}
                disabled={!videoDuration}
                className="h-1 w-full cursor-pointer appearance-none rounded-full bg-slate-700 accent-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
              />
              {videoDuration ? (
                <span className="text-right text-[10px] text-slate-400">
                  {selectedTime.toFixed(2)}s / {videoDuration.toFixed(2)}s
                </span>
              ) : null}
            </label>
            <label className="flex flex-col gap-2">
              <span className="flex items-center justify-between text-[11px] uppercase tracking-wide text-slate-400">
                <span>표시 Z 레벨</span>
                <span>{planeIndex + 1}</span>
              </span>
              <input
                type="range"
                min={0}
                max={Math.max(GRID_SIZE_Z - 1, 0)}
                step={1}
                value={planeIndex}
                onChange={handlePlaneChange}
                disabled={GRID_SIZE_Z <= 1}
                className="h-1 w-full cursor-pointer appearance-none rounded-full bg-slate-700 accent-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
              />
            </label>
            <div className="h-px w-full bg-white/10" />
          </div>
          <ProjectionToggle
            value={projectionMode}
            onToggle={toggleProjection}
          />
          <ViewButtonGroup value={viewMode} onChange={setViewMode} />
          <div className="h-px w-full bg-white/10" />
          <AxisSlider
            axis="X"
            value={visibleCounts.x}
            max={GRID_SIZE_X}
            onChange={handleSliderChange("x")}
          />
          <AxisSlider
            axis="Y"
            value={visibleCounts.y}
            max={GRID_SIZE_Y}
            onChange={handleSliderChange("y")}
          />
          <AxisSlider
            axis="Z"
            value={visibleCounts.z}
            max={GRID_SIZE_Z}
            onChange={handleSliderChange("z")}
          />
        </div>
      </div>
      <video
        ref={videoRef}
        className="hidden"
        playsInline
        muted
        preload="auto"
      />
      {/* <video ref={previewRef} className="webcam-preview" /> */}
    </main>
  );
}
