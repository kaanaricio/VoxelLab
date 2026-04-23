// ONNX Runtime + SlimSAM mask decoder session and inference.

import { ORT_MODULE_URL, ORT_WASM_BASE_URL } from './dependencies.js';

const DECODER_URL =
  'https://huggingface.co/xenova/slimsam-77-uniform/resolve/main/onnx/mask_decoder.onnx';

let _ort = null;
let _session = null;
let _sessionLoading = null;

export async function slimsamEnsureDecoderSession() {
  if (_session) return _session;
  if (_sessionLoading) return _sessionLoading;

  _sessionLoading = (async () => {
    try {
      if (!_ort) {
        _ort = await import(ORT_MODULE_URL);
        _ort.env.wasm.wasmPaths = ORT_WASM_BASE_URL;
      }

      console.log('[slimsam] loading decoder ONNX model ...');
      _session = await _ort.InferenceSession.create(DECODER_URL, {
        executionProviders: ['wasm'],
      });
      console.log('[slimsam] decoder model loaded');
      return _session;
    } catch (e) {
      console.error('[slimsam] failed to load ONNX decoder:', e);
      _session = null;
      return null;
    } finally {
      _sessionLoading = null;
    }
  })();

  return _sessionLoading;
}

export function slimsamGetOrt() {
  return _ort;
}

/**
 * @returns {Promise<{mask: Uint8Array, width: number, height: number} | null>}
 */
export async function slimsamRunDecoder(session, embedBuf, meta, sliceIdx, clickX, clickY) {
  const ort = _ort;
  if (!ort || !session) return null;

  const { embed_dim, embed_h, embed_w, width, height } = meta;
  const floatsPerSlice = embed_dim * embed_h * embed_w;
  const offset = sliceIdx * floatsPerSlice;

  const sliceEmbed = new Float32Array(floatsPerSlice);
  sliceEmbed.set(embedBuf.subarray(offset, offset + floatsPerSlice));

  const Tensor = ort.Tensor;
  const imageEmbeddings = new Tensor('float32', sliceEmbed, [1, embed_dim, embed_h, embed_w]);

  const scaleX = 1024 / width;
  const scaleY = 1024 / height;
  const normX = clickX * scaleX;
  const normY = clickY * scaleY;

  const pointCoords = new Tensor(
    'float32',
    new Float32Array([normX, normY, 0, 0]),
    [1, 2, 2],
  );

  const pointLabels = new Tensor(
    'float32',
    new Float32Array([1, -1]),
    [1, 2],
  );

  const hasMaskInput = new Tensor('float32', new Float32Array([0]), [1]);

  const maskInput = new Tensor(
    'float32',
    new Float32Array(256 * 256),
    [1, 1, 256, 256],
  );

  const origImSize = new Tensor(
    'float32',
    new Float32Array([height, width]),
    [2],
  );

  const feeds = {
    image_embeddings: imageEmbeddings,
    point_coords: pointCoords,
    point_labels: pointLabels,
    mask_input: maskInput,
    has_mask_input: hasMaskInput,
    orig_im_size: origImSize,
  };

  const results = await session.run(feeds);

  let masksData, masksShape;

  if (results.masks) {
    masksData = results.masks.data;
    masksShape = results.masks.dims;
  } else if (results.output_masks) {
    masksData = results.output_masks.data;
    masksShape = results.output_masks.dims;
  } else {
    for (const key of Object.keys(results)) {
      const t = results[key];
      if (t.dims && t.dims.length === 4) {
        masksData = t.data;
        masksShape = t.dims;
        break;
      }
    }
  }

  if (!masksData) {
    console.warn('[slimsam] decoder produced no recognizable mask output');
    return null;
  }

  let bestIdx = 0;
  const iou = results.iou_predictions || results.iou_pred;
  if (iou && iou.data) {
    let bestScore = -Infinity;
    for (let i = 0; i < iou.data.length; i++) {
      if (iou.data[i] > bestScore) {
        bestScore = iou.data[i];
        bestIdx = i;
      }
    }
  }

  const maskH = masksShape[2];
  const maskW = masksShape[3];
  const maskSize = maskH * maskW;
  const rawMask = masksData.slice(bestIdx * maskSize, (bestIdx + 1) * maskSize);

  let binaryMask;
  if (maskH === height && maskW === width) {
    binaryMask = new Uint8Array(maskSize);
    for (let i = 0; i < maskSize; i++) {
      binaryMask[i] = rawMask[i] > 0 ? 255 : 0;
    }
  } else {
    binaryMask = new Uint8Array(width * height);
    for (let row = 0; row < height; row++) {
      const srcRow = Math.min(Math.floor(row * maskH / height), maskH - 1);
      for (let col = 0; col < width; col++) {
        const srcCol = Math.min(Math.floor(col * maskW / width), maskW - 1);
        binaryMask[row * width + col] =
          rawMask[srcRow * maskW + srcCol] > 0 ? 255 : 0;
      }
    }
  }

  return { mask: binaryMask, width, height };
}
