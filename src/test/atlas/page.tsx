"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { useWebcamTexture } from "@/hooks/useWebcamTexture";
import { useVideoAtlas } from "@/hooks/useVideoAtlas";

type BlendMode = "alpha" | "add";

function AtlasScene() {
  // ------- Params -------
  const TILE = 128; // 한 프레임 해상도
  const DEPTH = 128; // 최대 프레임 수
  const GRID = 16; // 16x8 타일 = 128 프레임
  const ATLAS = TILE * GRID; // 2048
  const MAX_INST = 40; // 최대 슬라이스 렌더 수

  const { camera, gl, size } = useThree();
  const { videoTexture: videoTex, previewRef } = useWebcamTexture({
    width: TILE,
    height: TILE,
    fps: 15,
  });
  // const [slices, setSlices] = useState<number>(16);
  // const [blend, setBlend] = useState<BlendMode>("alpha");
  // const [gamma, setGamma] = useState<number>(1.0);

  // Renderer 초기화
  useEffect(() => {
    gl.setPixelRatio(1);
    gl.setClearColor(0x0b0d12, 1);
    camera.position.set(0, 0, 5);
  }, [gl, camera]);

  // 비디오 → 아틀라스 타일링 유틸 훅 사용
  const { atlasRT, blitScene, blitCam, blitMat, headRef, blitToAtlas } =
    useVideoAtlas(videoTex ?? null, {
      tile: TILE,
      grid: GRID,
      depth: DEPTH,
      pixelRatio1: true,
    });

  // Instanced planes
  // 인스턴스 메쉬 참조(각 슬라이스를 얇은 평면으로 배치)
  const instancedRef = useRef<THREE.InstancedMesh | null>(null);
  // 한 장의 평면 지오메트리(1×1)를 재사용
  const baseGeo = useMemo(() => new THREE.PlaneGeometry(1, 1, 1, 1), []);
  // 과거 프레임을 담은 아틀라스/현재 비디오 텍스처를 샘플링하는 셰이더 머티리얼
  const sliceMat = useMemo(
    () =>
      new THREE.RawShaderMaterial({
        uniforms: {
          atlas: { value: atlasRT.texture },
          srcVideo: { value: videoTex },
          slices: { value: 1 },
          depth: { value: DEPTH },
          grid: { value: GRID },
          tile: { value: TILE },
          head: { value: -1 },
          gamma: { value: 1.0 },
          alphaMul: { value: 0.08 },
        },
        vertexShader: `
      precision highp float;
      uniform mat4 projectionMatrix, modelViewMatrix;
      uniform int slices;
      attribute vec3 position; attribute vec2 uv; attribute mat4 instanceMatrix;
      varying vec2 vUV; varying float vSliceT; varying float vZ;
      void main(){ float z = instanceMatrix[3].z; vZ = z; vSliceT = z + 0.5; vUV = uv; gl_Position = projectionMatrix * modelViewMatrix * (instanceMatrix * vec4(position,1.0)); }
    `,
        fragmentShader: `
      precision highp float;
      uniform sampler2D atlas; uniform sampler2D srcVideo; uniform int slices, depth, grid; uniform float gamma, alphaMul; uniform int head; varying vec2 vUV; varying float vSliceT; varying float vZ;
      vec2 atlasUV(vec2 uv, float layer){ float L = floor(layer + 0.5); float gx = mod(L, float(grid)); float gy = floor(L / float(grid)); vec2 base = vec2(gx, gy) / float(grid); vec2 step = vec2(1.0) / float(grid); return base + uv * step; }
      void main(){ if (head < 0){ gl_FragColor = vec4(0.0); return; }
        float sliceIndex = vSliceT * float(slices - 1);
        vec3 col;
        // z가 0에 가까우면(맨 앞 슬라이스) 비디오를 라이브로 샘플
        if (abs(vZ) < 0.0001) {
          col = texture2D(srcVideo, vec2(vUV.x, 1.0 - vUV.y)).rgb;
        } else {
          // 깊이에 따라 과거 레이어로 이동
          float offset = floor(sliceIndex + 0.5);
          float layer = mod(float(head) - offset + float(depth), float(depth));
          col = texture2D(atlas, atlasUV(vUV, layer)).rgb;
        }
        col = pow(col, vec3(1.0/max(gamma,0.001)));
        float a = 1.0 - (sliceIndex * 0.1); a = max(a, 0.3);
        gl_FragColor = vec4(col, a);
      }
    `,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.NormalBlending,
        side: THREE.DoubleSide,
      }),
    [atlasRT.texture, videoTex]
  );

  // 비디오 텍스처가 준비되면 유니폼에 연결 보장
  useEffect(() => {
    if (!sliceMat) return;
    (sliceMat.uniforms.srcVideo as any).value = videoTex;
  }, [sliceMat, videoTex]);

  // Layout instance positions along Z
  const tmpMat = useMemo(() => new THREE.Matrix4(), []);
  const slicePositionsRef = useRef<number[]>([0]);
  const currentSlicesRef = useRef<number>(1);
  const layoutInstances = () => {
    const inst = instancedRef.current;
    if (!inst) return;
    inst.count = currentSlicesRef.current;
    for (let i = 0; i < currentSlicesRef.current; i++) {
      tmpMat.identity().setPosition(0, 0, slicePositionsRef.current[i] ?? 0);
      inst.setMatrixAt(i, tmpMat);
    }
    inst.instanceMatrix.needsUpdate = true;
    (sliceMat.uniforms.slices as any).value = currentSlicesRef.current;
  };

  // // UI handlers
  // useEffect(() => {
  //   const elSlices = document.getElementById(
  //     "slices"
  //   ) as HTMLInputElement | null;
  //   const elSlicesVal = document.getElementById(
  //     "slicesVal"
  //   ) as HTMLElement | null;
  //   const elBlend = document.getElementById(
  //     "blend"
  //   ) as HTMLSelectElement | null;
  //   const elGamma = document.getElementById("gamma") as HTMLInputElement | null;
  //   const elGammaVal = document.getElementById(
  //     "gammaVal"
  //   ) as HTMLElement | null;
  //   if (!elSlices || !elBlend || !elGamma || !elSlicesVal || !elGammaVal)
  //     return;
  //   const onSlices = () => {
  //     const v = parseInt(elSlices.value, 10);
  //     elSlicesVal.textContent = String(v);
  //     setSlices(v);
  //     currentSlicesRef.current = Math.min(v, MAX_INST);
  //     layoutInstances();
  //   };
  //   const onBlend = () => {
  //     const v = (elBlend.value as BlendMode) || "alpha";
  //     setBlend(v);
  //     if (v === "add") {
  //       sliceMat.blending = THREE.AdditiveBlending;
  //       sliceMat.transparent = true;
  //       sliceMat.depthWrite = false;
  //       sliceMat.needsUpdate = true;
  //     } else {
  //       sliceMat.blending = THREE.NormalBlending;
  //       sliceMat.transparent = false;
  //       sliceMat.depthWrite = true;
  //       sliceMat.needsUpdate = true;
  //     }
  //   };
  //   const onGamma = () => {
  //     const g = parseFloat(elGamma.value);
  //     elGammaVal.textContent = g.toFixed(2);
  //     setGamma(g);
  //     (sliceMat.uniforms.gamma as any).value = g;
  //   };
  //   elSlices.addEventListener("input", onSlices);
  //   elBlend.addEventListener("change", onBlend);
  //   elGamma.addEventListener("input", onGamma);
  //   onSlices();
  //   onBlend();
  //   onGamma();
  //   return () => {
  //     elSlices.removeEventListener("input", onSlices);
  //     elBlend.removeEventListener("change", onBlend);
  //     elGamma.removeEventListener("input", onGamma);
  //   };
  // }, [sliceMat]);

  // Blit helper는 훅이 제공; R3F 뷰포트 복원만 적절히 수행

  // Frame loop: 일정 주기마다 아틀라스에 새 프레임 기록 + 슬라이스 전단 삽입
  const lastRef = useRef<number>(0);
  const frameCountRef = useRef<number>(0);
  useFrame(() => {
    if (videoTex && (videoTex.image as HTMLVideoElement).readyState >= 2) {
      const now = performance.now();
      if (now - lastRef.current > 33) {
        frameCountRef.current++;
        lastRef.current = now;
        if (
          frameCountRef.current >= 40 &&
          currentSlicesRef.current < MAX_INST
        ) {
          const idx = (headRef.current + 1 + DEPTH) % DEPTH;
          blitToAtlas(idx);
          headRef.current = idx;
          (sliceMat.uniforms.head as any).value = headRef.current;
          // push new slice to front (z=0), move others back
          slicePositionsRef.current = [
            0,
            ...slicePositionsRef.current.map((z) => z - 0.1),
          ].slice(0, MAX_INST);
          currentSlicesRef.current = Math.min(
            currentSlicesRef.current + 1,
            MAX_INST
          );
          layoutInstances();
          frameCountRef.current = 0;
        }
      }
    }
  });

  // 훅의 previewRef를 DOM 비디오에 반영 (선택적 동기화)
  useEffect(() => {
    const dom = document.getElementById(
      "webcam-preview"
    ) as HTMLVideoElement | null;
    if (!dom || !previewRef.current) return;
    dom.srcObject =
      (previewRef.current as HTMLVideoElement & { srcObject?: MediaStream })
        .srcObject ?? null;
  }, [previewRef]);

  return (
    <group>
      {/* 인스턴스드 평면 메쉬(geometry, material, count)를 args로 지정 */}
      <instancedMesh ref={instancedRef} args={[baseGeo, sliceMat, MAX_INST]} />
      <OrbitControls enableDamping dampingFactor={0.05} />
    </group>
  );
}

export default function Page() {
  return (
    <main className="min-h-screen w-full bg-[#0b0d12] text-white">
      <div className="fixed inset-0 top-[52px]">
        <Canvas
          camera={{ fov: 75, near: 0.1, far: 1000 }}
          className="w-full h-full"
        >
          <AtlasScene />
        </Canvas>
      </div>
    </main>
  );
}
