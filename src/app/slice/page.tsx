"use client";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { useEffect, useState } from "react";
import VideoFramePlane from "@/components/VideoFramePlane";

type CaptureParams = {
  file: File;
  frame: number;
  width: number;
  height: number;
}

export function Controls({ onCapture, loading }: { onCapture: (params: CaptureParams) => void; loading: boolean; }) {
    const [file, setFile] = useState<File | null>(null);
    const [frame, setFrame] = useState<number>(10);
    const [width, setWidth] = useState<number>(128);
    const [height, setHeight] = useState<number>(128);
    const [error, setError] = useState<string>("");
  
    const handleClick = () => {
      setError("");
      if (!file) {
        setError("비디오 파일을 선택하세요.");
        return;
      }
      onCapture({ file, frame, width, height });
    };

    return (
        <div className="fixed top-4 left-4 z-10 bg-black/60 backdrop-blur-md border border-white/10 rounded-md p-4 max-w-[520px]">
            <div className="space-y-3">
            <div className="flex items-center gap-2">
                <label className="w-24 text-sm text-gray-200">비디오 파일</label>
                <input
                type="file"
                accept="video/*"
                className="flex-1 text-sm file:mr-3 file:rounded file:border-0 file:bg-white/10 file:text-white file:px-3 file:py-1.5 file:hover:bg-white/20"
                onChange={(e) => setFile(e.target.files && e.target.files[0] ? e.target.files[0] : null)}
                />
            </div>
            <div className="grid grid-cols-4 gap-2">
                <div className="flex items-center gap-2">
                <label className="w-16 text-sm text-gray-200">프레임</label>
                <input
                    type="number"
                    className="w-full rounded bg-white/10 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-white/20"
                    value={frame}
                    min={0}
                    onChange={(e) => setFrame(Number.isNaN(Number(e.target.value)) ? 0 : parseInt(e.target.value || "0", 10))}
                />
                </div>
                <div className="flex items-center gap-2">
                <label className="w-12 text-sm text-gray-200">W</label>
                <input
                    type="number"
                    className="w-full rounded bg-white/10 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-white/20"
                    value={width}
                    min={1}
                    onChange={(e) => setWidth(Number.isNaN(Number(e.target.value)) ? 1 : parseInt(e.target.value || "1", 10))}
                />
                </div>
                <div className="flex items-center gap-2">
                <label className="w-12 text-sm text-gray-200">H</label>
                <input
                    type="number"
                    className="w-full rounded bg-white/10 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-white/20"
                    value={height}
                    min={1}
                    onChange={(e) => setHeight(Number.isNaN(Number(e.target.value)) ? 1 : parseInt(e.target.value || "1", 10))}
                />
                </div>

            </div>
            <div className="flex items-center justify-between gap-3">
                <button
                onClick={handleClick}
                disabled={loading}
                className="px-4 py-2 rounded bg-white/20 hover:bg-white/30 text-sm disabled:opacity-60"
                >
                {loading ? "캡처 중..." : "프레임 캡처"}
                </button>
                {error && <span className="text-xs text-red-300">{error}</span>}
            </div>
            </div>
        </div>
    )
}

export default function Page() {
  const [file, setFile] = useState<File | null>(null);
  const [frame, setFrame] = useState<number>(1);
  const [width, setWidth] = useState<number>(64);
  const [height, setHeight] = useState<number>(64);
  const [loading, setLoading] = useState<boolean>(false);

  useEffect(() => {
    console.log(frame);
  }, [frame]);

  const handleCapture = ({ file, frame, width, height }: CaptureParams) => {
    setLoading(true);
    setFile(file);
    setFrame(frame);
    setWidth(width);
    setHeight(height);
    setTimeout(() => setLoading(false), 0);
  };
  
  return (
    <main className="min-h-screen w-full inset-0 text-white">
      <Controls onCapture={handleCapture} loading={loading} />
      <div className="fixed inset-0">
        <Canvas
          camera={{ fov: 75, near: 0.1, far: 1000 }}
        >
          {Array.from({ length: frame }).map((_, i) => {
            const idx = i + 1;
            return (
              <VideoFramePlane
                key={idx}
                position={[0, 0, idx * 0.1]}
                file={file || undefined}
                frame={frame+i}
                width={width}
                height={height}
              />
            )
          })}
          <OrbitControls enableDamping />
        </Canvas>
      </div>
    </main>
  );
}
