/**
 * PNG 像素的唯一解法。
 *
 * **接上哪个功能**：一切「屏幕上真的是这个样子」的判据——主题的真像素验收
 * （`verify-native-theme-pixels.ts`）与真输入通道的画面证据（`e2e/native-input`）。
 *
 * **在全局逻辑中负责什么**：把 RGBA8 的 PNG 解成可按坐标问的像素面，别的什么
 * 都不做。判什么是纸、什么是墨、两张图差在哪，都是调用方的事——这里只负责
 * 「那个像素是什么颜色」这一个问题有且只有一个答案。
 *
 * **为什么不装依赖**：证据链上的解码器必须自己可读。多一层依赖就多一处可能
 * 骗过自己的地方；而 RGBA8 + 五种 filter 就是下面这些行。
 *
 * 只认 color type 6（RGBA8，8 bit）——SDK 与 GDI+ 的截图都是这一种。换了格式
 * 应当报错而不是猜一个值出来。
 */

import { inflateSync } from "node:zlib";

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface Surface {
  readonly width: number;
  readonly height: number;
  /** 越界返回 undefined，而不是夹取——夹取会让一条问错的判据看起来通过。 */
  at(x: number, y: number): Rgb | undefined;
}

/** 两色在 RGB 立方体里的欧氏距离。0 是同色，441.7 是黑白两端。 */
export const distance = (a: Rgb, b: Rgb): number => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);

export const hex = (color: Rgb): string =>
  [color.r, color.g, color.b].map((v) => v.toString(16).padStart(2, "0")).join("");

const paethPredictor = (left: number, up: number, upLeft: number): number => {
  const estimate = left + up - upLeft;
  const dLeft = Math.abs(estimate - left);
  const dUp = Math.abs(estimate - up);
  const dUpLeft = Math.abs(estimate - upLeft);
  if (dLeft <= dUp && dLeft <= dUpLeft) return left;
  return dUp <= dUpLeft ? up : upLeft;
};

/**
 * 解一张 RGBA8 的 PNG。
 *
 * 逐扫描线还原：每行第一个字节是 filter 类型，其余是被预测过的字节。上一行
 * 在第一行时按规范当全 0，所以不需要为它开特例。
 */
export function decodePng(png: Buffer): Surface {
  if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) {
    throw new Error("not a PNG (signature mismatch)");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  const idat: Buffer[] = [];
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
      interlace = data.readUInt8(12);
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (colorType !== 6) throw new Error(`colour type ${colorType}, expected 6 (RGBA8)`);
  if (bitDepth !== 8) throw new Error(`bit depth ${bitDepth}, expected 8`);
  if (interlace !== 0) throw new Error("interlaced PNG is not supported");
  if (width === 0 || height === 0) throw new Error("PNG declares an empty image");

  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < height * (stride + 1)) {
    throw new Error(`PNG data is short: ${raw.length} bytes for ${height} rows of ${stride}`);
  }
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const source = y * (stride + 1) + 1;
    const target = y * stride;
    for (let index = 0; index < stride; index += 1) {
      const encoded = raw[source + index] ?? 0;
      const left = index >= bytesPerPixel ? (pixels[target + index - bytesPerPixel] ?? 0) : 0;
      const up = y > 0 ? (pixels[target - stride + index] ?? 0) : 0;
      const upLeft =
        y > 0 && index >= bytesPerPixel
          ? (pixels[target - stride + index - bytesPerPixel] ?? 0)
          : 0;
      const predictor =
        filter === 1
          ? left
          : filter === 2
            ? up
            : filter === 3
              ? (left + up) >> 1
              : filter === 4
                ? paethPredictor(left, up, upLeft)
                : 0;
      pixels[target + index] = (encoded + predictor) & 0xff;
    }
  }
  return {
    width,
    height,
    at(x: number, y: number): Rgb | undefined {
      if (x < 0 || y < 0 || x >= width || y >= height) return undefined;
      const base = y * stride + x * bytesPerPixel;
      return { r: pixels[base] ?? 0, g: pixels[base + 1] ?? 0, b: pixels[base + 2] ?? 0 };
    },
  };
}
