/**
 * 파일 다운로드 유틸리티
 * 
 * 브라우저에서 파일을 다운로드하는 헬퍼 함수들입니다.
 * Blob 기반 다운로드와 Data URL 기반 다운로드를 지원합니다.
 * 
 * @module utils/fileDownload
 */

/**
 * Blob 데이터를 파일로 다운로드
 * 
 * @description
 * Blob 객체를 생성하고 임시 URL을 통해 파일 다운로드를 트리거합니다.
 * 다운로드 완료 후 URL을 자동으로 해제합니다.
 * 
 * 지원 형식:
 * - 텍스트 파일 (text/plain)
 * - 바이너리 파일 (application/octet-stream)
 * - 이미지 파일 (image/png, image/jpeg 등)
 * 
 * @param data - 다운로드할 데이터 (문자열 또는 ArrayBuffer/Uint8Array)
 * @param filename - 저장될 파일명
 * @param mimeType - MIME 타입 (기본값: "application/octet-stream")
 * 
 * @example
 * // 텍스트 파일 다운로드
 * downloadBlob("Hello, World!", "hello.txt", "text/plain");
 * 
 * // 바이너리 파일 다운로드
 * downloadBlob(uint8Array, "data.bin", "application/octet-stream");
 */
export function downloadBlob(
  data: string | ArrayBuffer | Uint8Array,
  filename: string,
  mimeType: string = "application/octet-stream"
): void {
  // Blob 생성
  const blob = new Blob([data], { type: mimeType });
  
  // 임시 URL 생성
  const url = URL.createObjectURL(blob);
  
  // 다운로드 트리거
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  
  // DOM에 추가 후 클릭 (일부 브라우저 호환성)
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  
  // URL 해제 (메모리 정리)
  URL.revokeObjectURL(url);
}

/**
 * Data URL을 파일로 다운로드
 * 
 * @description
 * Base64 인코딩된 Data URL을 파일로 다운로드합니다.
 * 주로 Canvas의 toDataURL() 결과를 저장할 때 사용됩니다.
 * 
 * @param dataUrl - Data URL 문자열 (예: "data:image/png;base64,...")
 * @param filename - 저장될 파일명
 * 
 * @example
 * const dataUrl = canvas.toDataURL("image/png");
 * downloadDataUrl(dataUrl, "screenshot.png");
 */
export function downloadDataUrl(dataUrl: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = dataUrl;
  anchor.download = filename;
  
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

/**
 * ASCII PLY 파일 다운로드
 * 
 * @description
 * PLY 포인트 클라우드를 ASCII 텍스트 형식으로 다운로드합니다.
 * 
 * @param content - PLY 파일 내용 (문자열)
 * @param filename - 파일명 (기본값: "pointcloud.ply")
 */
export function downloadPLYAscii(
  content: string,
  filename: string = "pointcloud.ply"
): void {
  downloadBlob(content, filename, "text/plain");
}

/**
 * Binary PLY 파일 다운로드
 * 
 * @description
 * PLY 포인트 클라우드를 Binary 형식으로 다운로드합니다.
 * ASCII보다 파일 크기가 작고 로딩이 빠릅니다.
 * 
 * @param data - PLY 바이너리 데이터 (Uint8Array)
 * @param filename - 파일명 (기본값: "pointcloud_binary.ply")
 */
export function downloadPLYBinary(
  data: Uint8Array,
  filename: string = "pointcloud_binary.ply"
): void {
  downloadBlob(data, filename, "application/octet-stream");
}

/**
 * PNG 스크린샷 다운로드
 * 
 * @description
 * Canvas에서 추출한 Data URL을 PNG 파일로 다운로드합니다.
 * 
 * @param dataUrl - PNG Data URL
 * @param filename - 파일명 (기본값: "screenshot.png")
 */
export function downloadPNG(
  dataUrl: string,
  filename: string = "screenshot.png"
): void {
  downloadDataUrl(dataUrl, filename);
}

/**
 * Three.js 렌더러에서 스크린샷 캡처 및 다운로드
 * 
 * @description
 * WebGL 렌더러의 현재 화면을 PNG로 캡처하고 다운로드합니다.
 * preserveDrawingBuffer가 활성화되어 있어야 합니다.
 * 
 * @param canvas - WebGL Canvas 엘리먼트
 * @param filename - 파일명 (기본값: "screenshot.png")
 * @returns 성공 여부
 * 
 * @example
 * const success = captureAndDownloadCanvas(renderer.domElement, "my-capture.png");
 */
export function captureAndDownloadCanvas(
  canvas: HTMLCanvasElement,
  filename: string = "screenshot.png"
): boolean {
  try {
    const dataUrl = canvas.toDataURL("image/png");
    downloadPNG(dataUrl, filename);
    return true;
  } catch (error) {
    console.error("Canvas 캡처 실패:", error);
    return false;
  }
}


