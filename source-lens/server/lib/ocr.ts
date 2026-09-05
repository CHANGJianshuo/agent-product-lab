import { createWorker, OEM, type Worker } from "tesseract.js";

let workerPromise: Promise<Worker> | null = null;

function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker(["chi_sim", "eng"], OEM.LSTM_ONLY, {
      logger: () => undefined,
    }).catch((error) => {
      workerPromise = null;
      throw error;
    });
  }
  return workerPromise;
}

function parseDataUrl(value: string): Buffer {
  const match = value.match(/^data:image\/(?:png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error("仅支持 PNG、JPEG 或 WebP 图片");
  const buffer = Buffer.from(match[1], "base64");
  if (!buffer.length || buffer.length > 8 * 1024 * 1024) throw new Error("图片需小于 8 MB");
  return buffer;
}

export async function extractTextFromImage(imageDataUrl: string): Promise<string> {
  const image = parseDataUrl(imageDataUrl);
  const worker = await getWorker();
  const result = await worker.recognize(image);
  return result.data.text.replace(/\r\n?/g, "\n").trim();
}
