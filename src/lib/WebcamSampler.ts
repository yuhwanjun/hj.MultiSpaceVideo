/**
 * WebcamSampler
 * - 브라우저의 웹캠을 켜고, 내부 캔버스에 축소된 이미지(픽셀화)를 그린 다음 RGBA 배열을 뽑아줍니다.
 * - 사용자는 cols(가로 픽셀 수), rows(세로 픽셀 수)를 정할 수 있습니다.
 */
export class WebcamSampler {
  private video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private context: CanvasRenderingContext2D | null;
  private stream: MediaStream | null = null;

  constructor(private cols: number, private rows: number) {
    // 비디오/캔버스 DOM 요소를 내부적으로 만들어 관리합니다.
    this.video = document.createElement("video");
    this.video.playsInline = true; // iOS 등에서 전체화면 방지
    this.video.muted = true; // 마이크는 쓰지 않습니다.

    this.canvas = document.createElement("canvas");
    this.canvas.width = cols;
    this.canvas.height = rows;
    this.context = this.canvas.getContext("2d", { willReadFrequently: true });
  }

  /**
   * 웹캠을 시작합니다. (권한 팝업 허용 필요)
   */
  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user" },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
  }

  /**
   * 웹캠을 종료하고 리소스를 정리합니다.
   */
  stop(): void {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }

  /**
   * 현재 웹캠 프레임을 cols×rows 크기로 축소해 캔버스에 그리고,
   * RGBA 평면 배열(Uint8ClampedArray)을 반환합니다.
   */
  sample(): Uint8ClampedArray | null {
    if (!this.context) return null;
    try {
      this.context.drawImage(this.video, 0, 0, this.cols, this.rows);
      return this.context.getImageData(0, 0, this.cols, this.rows).data;
    } catch {
      return null;
    }
  }

  /**
   * 그리드 해상도를 바꿉니다. (다음 샘플부터 반영)
   */
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.canvas.width = cols;
    this.canvas.height = rows;
  }
}
