import assert from 'node:assert/strict';
import { test } from 'node:test';

let drawCalls = 0;

globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') return {};
    let currentImage = null;
    return {
      width: 0,
      height: 0,
      getContext: () => ({
        clearRect() {},
        drawImage(img) {
          drawCalls += 1;
          currentImage = img;
        },
        getImageData(_x, _y, w, h) {
          const bytes = currentImage?._bytesBySize?.[`${w}x${h}`] || new Uint8Array(w * h);
          const data = new Uint8ClampedArray(w * h * 4);
          for (let i = 0, p = 0; i < bytes.length; i += 1, p += 4) {
            data[p] = bytes[i];
            data[p + 1] = bytes[i];
            data[p + 2] = bytes[i];
            data[p + 3] = 255;
          }
          return { data };
        },
      }),
    };
  },
};

const { readImageByteData, readOverlayData } = await import('../js/overlay-data.js');

test('overlay pixel cache keeps decoded data for multiple sizes of the same image', () => {
  drawCalls = 0;
  const img = {
    complete: true,
    naturalWidth: 4,
    _bytesBySize: {
      '2x2': Uint8Array.from([1, 2, 3, 4]),
      '4x1': Uint8Array.from([5, 6, 7, 8]),
    },
  };

  const firstSmall = readImageByteData(img, 2, 2);
  const firstWide = readImageByteData(img, 4, 1);
  const secondSmall = readImageByteData(img, 2, 2);
  const secondWideRgba = readOverlayData(img, 4, 1);
  const secondWide = readImageByteData(img, 4, 1);

  assert.deepEqual([...firstSmall], [1, 2, 3, 4]);
  assert.deepEqual([...firstWide], [5, 6, 7, 8]);
  assert.equal(secondSmall, firstSmall);
  assert.equal(secondWide, firstWide);
  assert.equal(secondWideRgba.length, 16);
  assert.equal(drawCalls, 2);
});
