/**
 * Screenshot post-processing in the service worker: black boxes over sensitive fields and over
 * frames from origins outside the grant, then JPEG at the largest scale and quality that fits the
 * Gateway's 1.5 MiB limit. The image exists only in memory for the duration of the command; it is
 * never stored by the extension.
 */
import { MAX_SCREENSHOT_BYTES } from '../page-driver';

/** A rectangle in image pixels (of the captured image, before any downscale). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  close?(): void;
}

export interface ImageCodec<I extends DecodedImage = DecodedImage> {
  /** Decodes Chrome's captured image (base64 PNG). */
  decode(base64: string): Promise<I>;
  /** Draws the image at `scale`, fills `redact` (image pixels at scale 1) in black, encodes JPEG. */
  encode(image: I, options: { scale: number; quality: number; redact: Rect[] }): Promise<Uint8Array>;
}

/** Tried in order until one fits: full size first, then lower quality, then smaller. */
export const SCREENSHOT_STEPS: ReadonlyArray<{ scale: number; quality: number }> = [
  { scale: 1, quality: 0.8 },
  { scale: 1, quality: 0.6 },
  { scale: 0.75, quality: 0.6 },
  { scale: 0.5, quality: 0.6 },
  { scale: 0.5, quality: 0.4 },
  { scale: 0.35, quality: 0.4 },
  { scale: 0.25, quality: 0.3 },
];

/** The first encoding within `maxBytes`, or null when even the smallest step is too large. */
export async function fitScreenshot<I extends DecodedImage>(codec: ImageCodec<I>, image: I, redact: Rect[], maxBytes = MAX_SCREENSHOT_BYTES): Promise<Uint8Array | null> {
  for (const step of SCREENSHOT_STEPS) {
    const bytes = await codec.encode(image, { ...step, redact });
    if (bytes.length > 0 && bytes.length <= maxBytes) return bytes;
  }
  return null;
}

/** CSS-pixel quad lists (`DOM.getContentQuads`) to image-pixel rectangles, padded a little and clipped to the image. */
export function quadsToRects(quads: number[][], pixelRatio: number, size: { width: number; height: number }, pad = 2): Rect[] {
  const rects: Rect[] = [];
  for (const quad of quads) {
    if (quad.length < 8) continue;
    const xs = [quad[0], quad[2], quad[4], quad[6]] as number[];
    const ys = [quad[1], quad[3], quad[5], quad[7]] as number[];
    const left = Math.max(0, Math.floor((Math.min(...xs) - pad) * pixelRatio));
    const top = Math.max(0, Math.floor((Math.min(...ys) - pad) * pixelRatio));
    const right = Math.min(size.width, Math.ceil((Math.max(...xs) + pad) * pixelRatio));
    const bottom = Math.min(size.height, Math.ceil((Math.max(...ys) + pad) * pixelRatio));
    if (right > left && bottom > top) rects.push({ x: left, y: top, width: right - left, height: bottom - top });
  }
  return rects;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

/** The real codec: `createImageBitmap` and `OffscreenCanvas`, both available in the MV3 service worker. */
export const offscreenCodec: ImageCodec<ImageBitmap> = {
  async decode(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  },
  async encode(image, { scale, quality, redact }) {
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2d context');
    context.drawImage(image, 0, 0, width, height);
    context.fillStyle = '#000';
    for (const rect of redact) context.fillRect(rect.x * scale, rect.y * scale, Math.ceil(rect.width * scale), Math.ceil(rect.height * scale));
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    return new Uint8Array(await blob.arrayBuffer());
  },
};
