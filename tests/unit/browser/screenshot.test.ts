import { bytesToBase64, fitScreenshot, quadsToRects, SCREENSHOT_STEPS, type ImageCodec } from '@/browser/adapters/cdp/screenshot';
import { MAX_SCREENSHOT_BYTES } from '@/browser/adapters/page-driver';

function codec(size: (scale: number, quality: number) => number) {
  const steps: Array<[number, number]> = [];
  const value: ImageCodec = {
    decode: async () => ({ width: 2000, height: 1000 }),
    encode: async (_image, { scale, quality }) => {
      steps.push([scale, quality]);
      return new Uint8Array(size(scale, quality));
    },
  };
  return { value, steps };
}

describe('screenshot sizing', () => {
  it('keeps the first encoding that fits the 1.5 MiB limit', async () => {
    const c = codec(() => 1_000_000);
    const bytes = await fitScreenshot(c.value, { width: 2000, height: 1000 }, []);
    expect(bytes?.length).toBe(1_000_000);
    expect(c.steps).toEqual([[1, 0.8]]);
  });

  it('lowers quality before size, and stops at the first fit', async () => {
    const c = codec((scale, quality) => Math.round(5_000_000 * scale * scale * quality));
    const bytes = await fitScreenshot(c.value, { width: 2000, height: 1000 }, []);
    expect(bytes?.length).toBeLessThanOrEqual(MAX_SCREENSHOT_BYTES);
    expect(c.steps).toEqual([
      [1, 0.8],
      [1, 0.6],
      [0.75, 0.6],
      [0.5, 0.6],
    ]);
  });

  it('gives up after the smallest step instead of sending too much', async () => {
    const c = codec(() => MAX_SCREENSHOT_BYTES + 1);
    await expect(fitScreenshot(c.value, { width: 2000, height: 1000 }, [])).resolves.toBeNull();
    expect(c.steps).toHaveLength(SCREENSHOT_STEPS.length);
  });

  it('accepts exactly the limit', async () => {
    const c = codec(() => MAX_SCREENSHOT_BYTES);
    await expect(fitScreenshot(c.value, { width: 1, height: 1 }, [])).resolves.toHaveLength(MAX_SCREENSHOT_BYTES);
  });

  it('turns CSS quads into padded image rectangles clipped to the image', () => {
    expect(quadsToRects([[10, 10, 50, 10, 50, 30, 10, 30]], 2, { width: 1000, height: 1000 })).toEqual([{ x: 16, y: 16, width: 88, height: 48 }]);
    expect(quadsToRects([[-20, -20, 5, -20, 5, 5, -20, 5]], 1, { width: 100, height: 100 })).toEqual([{ x: 0, y: 0, width: 7, height: 7 }]);
    expect(quadsToRects([[500, 500, 600, 500, 600, 600, 500, 600]], 1, { width: 100, height: 100 })).toEqual([]);
    expect(quadsToRects([[1, 2, 3]], 1, { width: 100, height: 100 })).toEqual([]);
  });

  it('encodes bytes as base64, in chunks for large images', () => {
    expect(bytesToBase64(new Uint8Array([0xff, 0xd8, 0xff]))).toBe('/9j/');
    const large = new Uint8Array(100_000).fill(65);
    expect(atob(bytesToBase64(large))).toHaveLength(100_000);
  });
});
