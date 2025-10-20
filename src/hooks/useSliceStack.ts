import { useEffect, useMemo, useRef, useState } from "react";
import { WebcamSampler } from "@/lib/WebcamSampler";

export type SlicePixels = Uint8ClampedArray; // RGBA flat array

export type SliceStackOptions = {
  cols: number;
  rows: number;
  intervalMs: number;
  maxSlices: number;
};

/**
 * useSliceStack
 * - WebcamSampler를 사용해 일정 시간 간격으로 샘플을 채집하고, 슬라이스 배열로 관리합니다.
 */
export function useSliceStack(options: SliceStackOptions) {
  const { cols, rows, intervalMs, maxSlices } = options;
  const samplerRef = useRef<WebcamSampler | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slices, setSlices] = useState<SlicePixels[]>([]);

  // sampler 초기화/시작
  useEffect(() => {
    const sampler = new WebcamSampler(cols, rows);
    samplerRef.current = sampler;
    sampler
      .start()
      .then(() => setReady(true))
      .catch((e) => setError((e as Error)?.message ?? "Webcam start failed"));
    return () => {
      sampler.stop();
      samplerRef.current = null;
    };
  }, []);

  // cols/rows 변경 반영
  useEffect(() => {
    samplerRef.current?.resize(cols, rows);
  }, [cols, rows]);

  // 주기적 샘플링
  useEffect(() => {
    if (!ready) return;
    let raf: number | null = null;
    let timer: number | null = null;

    const tick = () => {
      const data = samplerRef.current?.sample();
      if (data) {
        setSlices((prev) => {
          const copy = data.slice(0) as Uint8ClampedArray;
          // 용량이 가득 차지 않았다면 맨 앞에 추가
          if (prev.length < maxSlices) return [copy, ...prev];
          // 가득 찼다면 가장 오래된(맨 뒤) 항목을 덮어쓰고, 새 프레임을 맨 앞으로 이동
          const next = prev.slice();
          next.pop();
          next.unshift(copy);
          return next;
        });
      }
      timer = window.setTimeout(() => {
        raf = requestAnimationFrame(tick);
      }, intervalMs);
    };

    tick();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
    };
  }, [ready, intervalMs, maxSlices]);

  return { slices, ready, error } as const;
}
