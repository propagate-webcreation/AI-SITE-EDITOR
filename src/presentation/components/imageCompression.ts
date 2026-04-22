"use client";

const MAX_LONG_EDGE = 2048;
const JPEG_QUALITY = 0.85;
// この値を超える画像だけリサイズの対象にする。小さい元画像を無理に再エンコードして
// かえってサイズを増やすのを避けるための足切り。
const TARGET_BYTES = 3 * 1024 * 1024;

/**
 * 画像を canvas で縮小・JPEG 再エンコードする。
 *
 * Vercel Function の request body 上限が 4.5 MB のため、Mac の Retina スクリーンショットや
 * iPhone 写真 (10 MB 以上になりがち) をそのまま送ると関数本体に届く前に 413 で叩き返される。
 * AI への参考画像としての用途では長辺 2048px もあれば十分なので、submit 前にここで軽量化する。
 *
 * 元ファイルが既に小さい / 圧縮で逆にサイズが増える場合は元ファイルを返す。
 * createImageBitmap が失敗する形式 (Chrome on macOS の HEIC など) は throw する。
 */
export async function compressImageForUpload(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  if (file.size <= TARGET_BYTES) return file;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(
      `${file.name}: ブラウザがこの画像形式 (${file.type || "unknown"}) を扱えません。JPEG / PNG に変換してから添付してください。`,
    );
  }

  try {
    const longEdge = Math.max(bitmap.width, bitmap.height);
    const scale = longEdge > MAX_LONG_EDGE ? MAX_LONG_EDGE / longEdge : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const blob = await drawAndEncode(bitmap, width, height, JPEG_QUALITY);
    if (blob.size >= file.size) return file;

    const baseName = file.name.replace(/\.[^.]+$/, "") || "image";
    return new File([blob], `${baseName}.jpg`, { type: "image/jpeg" });
  } finally {
    bitmap.close?.();
  }
}

async function drawAndEncode(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  quality: number,
): Promise<Blob> {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("OffscreenCanvas の 2d context が取得できません");
    ctx.drawImage(bitmap, 0, 0, width, height);
    return canvas.convertToBlob({ type: "image/jpeg", quality });
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas の 2d context が取得できません");
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("canvas.toBlob が失敗しました"))),
      "image/jpeg",
      quality,
    );
  });
}
