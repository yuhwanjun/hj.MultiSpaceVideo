import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

export type UseVideoAtlasOptions = {
  // tile: 아틀라스에서 한 타일(한 프레임)의 가로/세로 픽셀 크기
  tile: number;
  // grid: 아틀라스를 구성하는 타일의 가로 개수(세로는 depth/grid로 계산)
  grid: number;
  // depth: 최대 저장 프레임 수(타일 총 개수)
  depth: number;
  // pixelRatio1: 렌더러 픽셀 비율 1 고정 여부(true 권장, 아틀라스 샘플 정확)
  pixelRatio1?: boolean;
  // restoreViewport: blit 후 원래 뷰포트를 자동 복원할지 여부(기본 true)
  restoreViewport?: boolean;
};

export type UseVideoAtlasResult = {
  // 아틀라스 렌더타겟(여기에 과거 프레임 타일링 저장)
  atlasRT: THREE.WebGLRenderTarget;
  // 비디오를 아틀라스 타일로 복사하는 풀스크린 씬/카메라/머티리얼
  blitScene: THREE.Scene;
  blitCam: THREE.OrthographicCamera;
  blitMat: THREE.ShaderMaterial;
  // head: 최신 프레임의 인덱스(0..depth-1)
  headRef: React.RefObject<number>;
  // 지정 인덱스 타일 위치에 현재 비디오 프레임 복사
  blitToAtlas: (gl: THREE.WebGLRenderer, idx: number) => void;
};

/**
 * useVideoAtlas
 * - 비디오 텍스처(입력)를 받아 아틀라스 렌더타겟에 타일로 복사하는 유틸을 제공합니다.
 * - R3F의 useThree().gl과 결합해 사용하세요.
 */
export function useVideoAtlas(
  videoTex: THREE.Texture | null,
  opts: UseVideoAtlasOptions
): UseVideoAtlasResult {
  const { tile, grid, pixelRatio1 = true, restoreViewport = true } = opts;

  // 아틀라스 전체 픽셀 크기 = tile * grid (정사각형 아틀라스 가정)
  const ATLAS = tile * grid;

  // 아틀라스 렌더타겟 생성: 과거 프레임을 타일로 저장
  const atlasRT = useMemo(() => {
    const rt = new THREE.WebGLRenderTarget(ATLAS, ATLAS, {
      depthBuffer: false,
      stencilBuffer: false,
    });
    rt.texture.minFilter = THREE.NearestFilter; // 타일 경계/블리딩 최소화
    rt.texture.magFilter = THREE.NearestFilter;
    rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    return rt;
  }, [ATLAS]);

  // 비디오 텍스처 → 타일 복사용 머티리얼/씬/카메라
  // 성능 최적화:
  // - 머티리얼/셰이더는 재사용하고, 유니폼 값만 갱신하여 재컴파일 방지
  const blitMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        // 성능: 재사용 가능한 유니폼 객체를 준비하고 값만 교체
        uniforms: {
          src: { value: null as THREE.Texture | null }, // 비디오 텍스처
          uSrcSize: { value: new THREE.Vector2(1, 1) }, // 비디오 원본 픽셀 크기
          uTargetAspect: { value: 1.0 }, // 타겟 아틀라스 타일 종횡비(1.0 = 정사각)
        },
        vertexShader: `
          varying vec2 vUV;
          void main(){
            vUV = uv;
            gl_Position = vec4(position.xy, 0.0, 1.0);
          }
        `,
        fragmentShader: `
          precision highp float;
          uniform sampler2D src;
          uniform vec2 uSrcSize;
          uniform float uTargetAspect;
          varying vec2 vUV;
          void main(){
            // 원본 비디오 종횡비(가로/세로)
            float srcAspect = uSrcSize.x / max(uSrcSize.y, 1.0);
            // 타겟은 정사각형(1.0). 종횡비를 보존하도록 letterbox/pillarbox 적용
            vec2 uv = vUV;
            if (srcAspect > uTargetAspect) {
              // 원본이 더 가로로 긴 경우: 세로를 축소(상하 레터박스)
              float scale = uTargetAspect / srcAspect; // < 1
              uv.y = (uv.y - 0.5) * scale + 0.5;
            } else if (srcAspect < uTargetAspect) {
              // 원본이 더 세로로 긴 경우: 가로를 축소(좌우 필러박스)
              float scale = srcAspect / uTargetAspect; // < 1
              uv.x = (uv.x - 0.5) * scale + 0.5;
            }
            gl_FragColor = texture2D(src, uv);
          }
        `,
      }),
    []
  );
  // 유니폼 텍스처만 교체(재컴파일 회피)
  useEffect(() => {
    // 비디오 텍스처 연결
    (blitMat.uniforms.src as { value: THREE.Texture | null }).value = videoTex;
    // 원본 비디오 실제 픽셀 크기(종횡비 보존용)
    const vid = videoTex?.image as HTMLVideoElement | undefined;
    if (vid && vid.videoWidth && vid.videoHeight) {
      (blitMat.uniforms.uSrcSize as { value: THREE.Vector2 }).value.set(
        vid.videoWidth,
        vid.videoHeight
      );
    }
  }, [blitMat, videoTex]);
  const blitScene = useMemo(() => new THREE.Scene(), []);
  const blitCam = useMemo(
    () => new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
    []
  );

  // 풀스크린 사각형 추가/정리
  useEffect(() => {
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blitMat);
    blitScene.add(quad);
    return () => {
      blitScene.remove(quad);
      quad.geometry.dispose();
      (quad.material as THREE.ShaderMaterial).dispose();
    };
  }, [blitScene, blitMat]);

  // 최신 프레임 인덱스
  const headRef = useRef<number>(-1);

  // 지정 타일 인덱스(idx)의 위치를 계산해 비디오를 복사
  const blitToAtlas = (gl: THREE.WebGLRenderer, idx: number) => {
    const col = idx % grid; // 가로 타일 인덱스
    const row = (idx / grid) | 0; // 세로 타일 인덱스
    const x = col * tile; // 픽셀 좌표 X
    const y = row * tile; // 픽셀 좌표 Y
    // 성능 최적화:
    // - 현재 픽셀 비율이 이미 1이면 setPixelRatio 호출 생략
    const prevPR = gl.getPixelRatio();
    if (pixelRatio1 && prevPR !== 1) gl.setPixelRatio(1);
    // - autoClear 비활성화 상태라도 영향 없도록 기본 렌더패스만 수행
    gl.setRenderTarget(atlasRT);
    gl.setViewport(x, y, tile, tile);
    gl.render(blitScene, blitCam); // 비디오 → 해당 타일에 복사
    gl.setRenderTarget(null);
    if (pixelRatio1 && prevPR !== 1) gl.setPixelRatio(prevPR);
    // 선택적으로 뷰포트 복원(외부에서 다시 그릴 때 화면 전체가 보이도록)
    if (restoreViewport) {
      const w = gl.domElement.width;
      const h = gl.domElement.height;
      gl.setViewport(0, 0, w, h);
    }
  };

  return { atlasRT, blitScene, blitCam, blitMat, headRef, blitToAtlas };
}
