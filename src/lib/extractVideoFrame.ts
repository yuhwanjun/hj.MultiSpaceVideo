export async function captureVideoFrameAsImage(
  videoUrl: string,
  frameNumber: number,
  width: number,
  height: number,
  options?: {
    pixelate?: number; // e.g., 8 -> downscale to 1/8 then upscale (blocky)
    mimeType?: string; // e.g., 'image/webp', 'image/jpeg'
    quality?: number; // 0..1 for lossy formats
  }
): Promise<HTMLImageElement> {
  if (typeof window === "undefined") {
    throw new Error("captureVideoFrameAsImage must be called in the browser.");
  }

  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.preload = "auto";
  video.src = videoUrl;
  video.muted = true;

  await waitForEvent(video, "loadedmetadata");

  const assumedFps = 30; // Fallback FPS when exact FPS is not available in browsers
  const targetTime = clamp(frameNumber / assumedFps, 0, Number.isFinite(video.duration) ? video.duration : Infinity);

  // Some browsers require data availability before seeking reliably
  if (video.readyState < 2) {
    // HAVE_CURRENT_DATA
    await Promise.race([
      waitForEvent(video, "loadeddata"),
      waitForEvent(video, "canplay"),
    ]);
  }

  await seekVideo(video, targetTime);

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(width));
  canvas.height = Math.max(1, Math.floor(height));
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Failed to get 2D canvas context");
  }

  // Letterbox to fit within the requested width/height while preserving aspect ratio
  const sourceW = video.videoWidth || 1;
  const sourceH = video.videoHeight || 1;
  const targetW = canvas.width;
  const targetH = canvas.height;
  const sourceAspect = sourceW / sourceH;
  const targetAspect = targetW / targetH;

  let drawW = targetW;
  let drawH = targetH;
  if (sourceAspect > targetAspect) {
    drawW = targetW;
    drawH = Math.round(targetW / sourceAspect);
  } else {
    drawH = targetH;
    drawW = Math.round(targetH * sourceAspect);
  }
  const dx = Math.round((targetW - drawW) / 2);
  const dy = Math.round((targetH - drawH) / 2);

  // Optional background fill for letterboxing
  context.fillStyle = "#000";
  context.fillRect(0, 0, targetW, targetH);

  const pixelate = Math.max(1, Math.floor(options?.pixelate ?? 8));
  if (pixelate > 1) {
    // Draw to a tiny buffer, then scale up with smoothing disabled to produce a pixelated look
    const pxCanvas = document.createElement("canvas");
    const pxW = Math.max(1, Math.floor(drawW / pixelate));
    const pxH = Math.max(1, Math.floor(drawH / pixelate));
    pxCanvas.width = pxW;
    pxCanvas.height = pxH;
    const pxCtx = pxCanvas.getContext("2d");
    if (!pxCtx) throw new Error("Failed to get 2D context for pixelation buffer");
    pxCtx.imageSmoothingEnabled = true; // quality downscale
    pxCtx.drawImage(video, 0, 0, sourceW, sourceH, 0, 0, pxW, pxH);

    context.imageSmoothingEnabled = false; // blocky upscale
    context.drawImage(pxCanvas, 0, 0, pxW, pxH, dx, dy, drawW, drawH);
  } else {
    context.drawImage(video, 0, 0, sourceW, sourceH, dx, dy, drawW, drawH);
  }

  const mimeType = options?.mimeType ?? "image/webp";
  const quality = typeof options?.quality === "number" ? options!.quality : 0.2;
  const blob = await canvasToBlob(canvas, mimeType, quality);
  const objectUrl = URL.createObjectURL(blob);

  try {
    const image = await loadImage(objectUrl);
    // Ensure the returned element reflects requested dimensions
    image.width = targetW;
    image.height = targetH;
    return image;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(max)) return Math.max(min, value);
  return Math.min(max, Math.max(min, value));
}

async function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
  if (Math.abs(video.currentTime - time) < 1e-4) {
    if (video.readyState >= 2) return; // already can draw current frame
  }

  return new Promise<void>((resolve, reject) => {
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Failed to seek video"));
    };
    const cleanup = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };

    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    try {
      video.currentTime = time;
    } catch {
      cleanup();
      reject(new Error("Unknown error while seeking"));
    }
  });
}

function waitForEvent<T extends Event>(target: EventTarget, type: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onType = (e: Event) => {
      cleanup();
      resolve(e as T);
    };
    const onError = () => {
      cleanup();
      reject(new Error(`${type} wait failed`));
    };
    const cleanup = () => {
      target.removeEventListener(type, onType as EventListener);
      target.removeEventListener("error", onError as EventListener);
    };
    target.addEventListener(type, onType as EventListener, { once: true });
    target.addEventListener("error", onError as EventListener, { once: true });
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Canvas toBlob returned null"));
    }, type, quality);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load generated image"));
    img.src = src;
  });
}


