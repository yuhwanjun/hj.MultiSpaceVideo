import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

export type UseWebcamTextureOptions = {
  // width: 카메라 캡처 타겟 가로 해상도(픽셀)
  width?: number;
  // height: 카메라 캡처 타겟 세로 해상도(픽셀)
  height?: number;
  // fps: 초당 프레임 목표치(브라우저/디바이스에 따라 보장되지 않을 수 있음)
  fps?: number;
  // horizontalFlip: true면 좌우 반전(셀피 미러 효과)
  horizontalFlip?: boolean;
};

/**
 * useWebcamTexture
 * - getUserMedia로 웹캠 스트림을 받아 THREE.VideoTexture를 생성/관리합니다.
 * - 옵션으로 타겟 해상도와 fps를 지정할 수 있습니다.
 * - DOM <video> 미리보기 연결을 위한 ref를 제공합니다.
 */
export function useWebcamTexture(options: UseWebcamTextureOptions = {}) {
  // 인자 기본값: 저해상도/저FPS로 리소스 사용을 최소화
  const {
    width = 128,
    height = 128,
    fps = 15,
    horizontalFlip = false,
  } = options;
  // videoTexture: THREE에서 머티리얼 map으로 바로 연결 가능한 텍스처
  const [videoTexture, setVideoTexture] = useState<THREE.VideoTexture | null>(
    null
  );
  // status: UI에 연결할 수 있는 현재 상태 문자열(권한, 에러 등)
  const [status, setStatus] = useState<string>("웹캠 초기화 중…");
  // previewRef: DOM <video>와 동일 스트림을 공유하고 싶을 때 연결
  const previewRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    // 내부용 비디오 엘리먼트: getUserMedia 스트림을 붙여 THREE.VideoTexture의 소스로 사용
    const video = document.createElement("video");
    (async () => {
      try {
        // getUserMedia 제약 조건
        // - video.width/height: 브라우저가 근사치로 맞추며, 디바이스에 따라 다를 수 있음
        // - frameRate: 이상적인 목표(ideal)와 최대(max) 제약을 동일하게 설정해 요청
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width, height, frameRate: { ideal: fps, max: fps } },
          audio: false,
        });
        video.srcObject = stream;
        video.muted = true; // 오디오 사용 안 함(사운드 차단)
        video.playsInline = true; // iOS 사파리 등에서 인라인 재생
        await video.play();
        // THREE.VideoTexture 생성: 머티리얼 map에 바로 주입 가능
        const tex = new THREE.VideoTexture(video);
        // 필터: 실사 영상을 좀 더 부드럽게 보이도록 Linear 사용
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        // 좌우 반전 여부에 따라 래핑/오프셋/리핏 설정
        if (horizontalFlip) {
          tex.wrapS = THREE.RepeatWrapping; // 음수 repeat 허용
          tex.wrapT = THREE.ClampToEdgeWrapping;
          tex.repeat.x = -1; // 좌우 뒤집기
          tex.offset.x = 1; // 뒤집힌 좌표 보정
        } else {
          tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
          tex.repeat.x = 1;
          tex.offset.x = 0;
        }
        setVideoTexture(tex);
        setStatus("웹캠 연결 성공!");
      } catch (e) {
        setStatus(`웹캠 접근 실패: ${(e as Error).message}`);
      }
    })();
    return () => {
      // 언마운트 시 트랙 정리로 카메라 자원 해제
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [width, height, fps, horizontalFlip]);

  // previewRef가 있으면 동일 스트림 연결
  useEffect(() => {
    if (!videoTexture || !previewRef.current) return;
    const v = videoTexture.image as HTMLVideoElement;
    const dest = previewRef.current as HTMLVideoElement & {
      srcObject?: MediaStream;
    };
    dest.srcObject = (
      v as HTMLVideoElement & { srcObject?: MediaStream }
    ).srcObject;
    dest.muted = true; // DOM 미리보기도 무음
    dest.playsInline = true; // 인라인 재생
    dest.autoplay = true; // 자동 재생
    // DOM 미리보기도 좌우 반전 동기화
    dest.style.transform = horizontalFlip ? "scaleX(-1)" : "";
  }, [videoTexture, horizontalFlip]);

  // horizontalFlip 변경 시 텍스처 설정 업데이트
  useEffect(() => {
    if (!videoTexture) return;
    if (horizontalFlip) {
      videoTexture.wrapS = THREE.RepeatWrapping;
      videoTexture.repeat.x = -1;
      videoTexture.offset.x = 1;
    } else {
      videoTexture.wrapS = THREE.ClampToEdgeWrapping;
      videoTexture.repeat.x = 1;
      videoTexture.offset.x = 0;
    }
    videoTexture.needsUpdate = true;
  }, [videoTexture, horizontalFlip]);

  // 반환
  // - videoTexture: THREE 머티리얼에 map으로 연결
  // - status: 현재 상태 문자열(UI 표시용)
  // - previewRef: DOM <video>에 연결하면 동일 스트림 미리보기 활성화
  return { videoTexture, status, previewRef } as const;
}
