const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const ort = require('onnxruntime-node');

const router = express.Router();

// ---------------------------------------------------------------
// Local background removal — runs entirely on our own server via
// onnxruntime-node, using a small (~4.7MB) U2Net-portable model. No
// Hugging Face, no API key, no rate limit — this is our own compute.
// The model file is downloaded once (on first request) from a public,
// permanent GitHub release asset and cached on disk after that.
// ---------------------------------------------------------------
const MODEL_DIR = path.join(__dirname, '..', 'models');
const MODEL_PATH = path.join(MODEL_DIR, 'u2netp.onnx');
const MODEL_URL = 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx';
const MODEL_INPUT_SIZE = 320; // u2netp expects a 320x320 input
// Standard ImageNet normalization stats — what u2netp was trained with.
const NORM_MEAN = [0.485, 0.456, 0.406];
const NORM_STD = [0.229, 0.224, 0.225];

let sessionPromise = null;

// Compares average mask value in the center region of the frame vs. the four
// corners — used to auto-detect whether a mask's foreground/background
// polarity needs flipping (see usage below).
function centerVsCornerAvg(bytes, size) {
  const cStart = Math.floor(size * 0.35);
  const cEnd = Math.floor(size * 0.65);
  let centerSum = 0, centerCount = 0;
  for (let y = cStart; y < cEnd; y++) {
    for (let x = cStart; x < cEnd; x++) {
      centerSum += bytes[y * size + x];
      centerCount++;
    }
  }
  const cornerSize = Math.floor(size * 0.15);
  const corners = [[0, 0], [size - cornerSize, 0], [0, size - cornerSize], [size - cornerSize, size - cornerSize]];
  let cornerSum = 0, cornerCount = 0;
  corners.forEach(([cx, cy]) => {
    for (let y = cy; y < cy + cornerSize; y++) {
      for (let x = cx; x < cx + cornerSize; x++) {
        cornerSum += bytes[y * size + x];
        cornerCount++;
      }
    }
  });
  return { centerAvg: centerSum / centerCount, cornerAvg: cornerSum / cornerCount };
}

async function ensureModelDownloaded() {
  if (fs.existsSync(MODEL_PATH)) return;
  if (!fs.existsSync(MODEL_DIR)) fs.mkdirSync(MODEL_DIR, { recursive: true });
  console.log('Downloading background-removal model (first run only, ~4.7MB)...');
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`Could not download the background-removal model (${res.status}). Check MODEL_URL in server/routes/ai.js is still valid.`);
  const buffer = await res.buffer();
  fs.writeFileSync(MODEL_PATH, buffer);
  console.log('Model downloaded and cached at', MODEL_PATH);
}

async function getSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      await ensureModelDownloaded();
      return ort.InferenceSession.create(MODEL_PATH);
    })();
  }
  return sessionPromise;
}

// ---------------------------------------------------------------
// POST /api/ai/remove-bg-local  { imageBase64 }
// Returns { imageBase64 } — a PNG with the background made transparent.
// ---------------------------------------------------------------
router.post('/remove-bg-local', async (req, res) => {
  const t0 = Date.now();
  const log = (msg) => console.log(`[remove-bg-local +${Date.now() - t0}ms] ${msg}`);
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 is required' });
    const inputBuffer = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    log(`received image, ${(inputBuffer.length / 1024).toFixed(0)}KB`);

    const session = await getSession();
    log('model session ready');

    // 1. Preprocess: resize to what the model expects, normalize to floats.
    const { data: smallData } = await sharp(inputBuffer)
      .rotate() // normalize EXIF orientation so raw pixel data matches reported width/height everywhere below
      .resize(MODEL_INPUT_SIZE, MODEL_INPUT_SIZE, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    log('resized input to model size');

    const S = MODEL_INPUT_SIZE;
    const floatData = new Float32Array(3 * S * S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const pixelIdx = (y * S + x) * 3;
        for (let c = 0; c < 3; c++) {
          const v = smallData[pixelIdx + c] / 255;
          floatData[c * S * S + y * S + x] = (v - NORM_MEAN[c]) / NORM_STD[c];
        }
      }
    }
    const inputTensor = new ort.Tensor('float32', floatData, [1, 3, S, S]);
    log('preprocessed to tensor, starting inference…');

    // 2. Run inference. We read the model's actual input/output tensor names
    // at runtime rather than hardcoding them — ONNX exports often have
    // auto-generated names that vary by export tool/version.
    const inputName = session.inputNames[0];
    const outputName = session.outputNames[0];
    log(`model I/O — inputs: [${session.inputNames.join(', ')}], outputs: [${session.outputNames.join(', ')}]`);
    const results = await session.run({ [inputName]: inputTensor });
    const maskTensor = results[outputName];
    const maskData = maskTensor.data;
    log(`inference done — output dims: [${maskTensor.dims.join(',')}], data length: ${maskData.length} (expected ${S * S} if single-channel ${S}x${S})`);

    // 3. Normalize the raw saliency map to 0-255 (u2net's raw output isn't
    // perfectly bounded to 0-1, so min-max stretch gives a cleaner mask).
    if (maskData.length !== S * S) {
      log(`WARNING: output length ${maskData.length} does not match expected ${S * S} — model output shape may not be single-channel ${S}x${S} as assumed. Using the first ${S * S} values.`);
    }
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < S * S; i++) {
      if (maskData[i] < min) min = maskData[i];
      if (maskData[i] > max) max = maskData[i];
    }
    const range = max - min || 1;
    const maskBytes = new Uint8Array(S * S);
    for (let i = 0; i < S * S; i++) {
      maskBytes[i] = Math.round(((maskData[i] - min) / range) * 255);
    }

    // Self-correcting check: a salient-object mask should be more "opaque"
    // in the center of the photo (where subjects usually are) than at the
    // corners (usually background). If a model/export has the opposite
    // polarity convention, this flips it automatically instead of guessing.
    const { centerAvg, cornerAvg } = centerVsCornerAvg(maskBytes, S);
    if (centerAvg < cornerAvg) {
      for (let i = 0; i < maskBytes.length; i++) maskBytes[i] = 255 - maskBytes[i];
      log(`mask polarity was inverted (center ${centerAvg.toFixed(0)} < corner ${cornerAvg.toFixed(0)}) — flipped`);
    } else {
      log(`mask polarity OK (center ${centerAvg.toFixed(0)} >= corner ${cornerAvg.toFixed(0)})`);
    }
    log('mask normalized');

    // 4. Get the full-resolution original (EXIF-normalized) — this is now
    // the single source of truth for output dimensions, used for both the
    // mask resize below and the final composite, so they can never disagree.
    const { data: origData, info: origInfo } = await sharp(inputBuffer)
      .rotate()
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    log(`original buffer info: ${JSON.stringify(origInfo)}, actual buffer byte length: ${origData.length} (expected ${origInfo.width * origInfo.height * origInfo.channels})`);

    const resizedMask = await sharp(Buffer.from(maskBytes), { raw: { width: S, height: S, channels: 1 } })
      .resize(origInfo.width, origInfo.height, { fit: 'fill' })
      .greyscale() // sharp can silently upconvert raw single-channel data to RGB during resize otherwise
      .raw()
      .toBuffer();
    const expectedMaskLength = origInfo.width * origInfo.height;
    if (resizedMask.length !== expectedMaskLength) {
      throw new Error(`Mask buffer size mismatch: got ${resizedMask.length} bytes, expected ${expectedMaskLength}. This would corrupt the output, so stopping here instead of producing a broken image.`);
    }
    log(`mask resized — buffer length: ${resizedMask.length} (expected ${expectedMaskLength})`);

    // 5. Apply the mask as the alpha channel of the original image.
    for (let i = 0; i < origInfo.width * origInfo.height; i++) {
      origData[i * 4 + 3] = resizedMask[i];
    }
    const outputPng = await sharp(origData, { raw: { width: origInfo.width, height: origInfo.height, channels: 4 } })
      .png()
      .toBuffer();
    log('done, sending response');

    res.json({ imageBase64: `data:image/png;base64,${outputPng.toString('base64')}` });
  } catch (err) {
    console.error(`[remove-bg-local +${Date.now() - t0}ms] ERROR:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// Hugging Face retired api-inference.huggingface.co in late 2025 in favor of
// this router, under their new "Inference Providers" system. Same request
// shape for HF-hosted models, just a new base URL.
const HF_BASE = 'https://router.huggingface.co/hf-inference/models';

// Swap this if Hugging Face deprecates the inpainting model — this is the
// one place that choice lives. Background removal runs locally now (above),
// not through Hugging Face at all.
const MODELS = {
  inpaint: 'runwayml/stable-diffusion-inpainting',
};

// Free Inference API endpoints "cold start" the first time a model is called
// after a period of inactivity — HF returns 503 with an estimated_time while it
// spins up. We retry a few times instead of failing immediately.
async function callHuggingFace(modelId, bodyBuffer, extraHeaders = {}) {
  if (!process.env.HF_TOKEN) {
    throw new Error('HF_TOKEN is not set on the server. See README.md to get a free Hugging Face token.');
  }

  const url = `${HF_BASE}/${modelId}`;
  const maxRetries = 4;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.HF_TOKEN}`,
        ...extraHeaders,
      },
      body: bodyBuffer,
    });

    if (res.status === 503) {
      const info = await res.json().catch(() => ({}));
      const waitMs = Math.min((info.estimated_time || 15) * 1000, 30000);
      console.log(`Model ${modelId} is loading, waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${maxRetries})...`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Hugging Face request failed (${res.status}): ${text.slice(0, 300)}`);
    }

    return res;
  }

  throw new Error('Model is still loading after several retries — try again in a minute.');
}

function base64ToBuffer(base64) {
  return Buffer.from(base64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
}

// ---------------------------------------------------------------
// TEMPORARY DIAGNOSTIC — POST /api/ai/debug-roundtrip  { imageBase64 }
// Round-trips the image through the exact same rotate/raw/re-encode steps
// as remove-bg-local, but WITHOUT the model or mask — isolates whether a
// visual artifact comes from basic buffer handling or the mask logic.
// Safe to delete this route once the striping issue is resolved.
// ---------------------------------------------------------------
router.post('/debug-roundtrip', async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 is required' });
    const inputBuffer = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    const { data, info } = await sharp(inputBuffer).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    console.log(`[debug-roundtrip] buffer info: ${JSON.stringify(info)}, actual length: ${data.length}`);
    const outputPng = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
    res.json({ imageBase64: `data:image/png;base64,${outputPng.toString('base64')}` });
  } catch (err) {
    console.error('debug-roundtrip error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------
// POST /api/ai/inpaint  { imageBase64, maskBase64, prompt }
// `prompt` is optional — for object *removal* rather than replacement,
// a background-describing prompt (e.g. "empty grass field") usually
// works better than leaving it blank.
// Returns { imageBase64 } — the image with the masked area filled in
// ---------------------------------------------------------------
router.post('/inpaint', async (req, res) => {
  try {
    const { imageBase64, maskBase64, prompt } = req.body;
    if (!imageBase64 || !maskBase64) {
      return res.status(400).json({ error: 'imageBase64 and maskBase64 are required' });
    }

    const payload = {
      inputs: prompt && prompt.trim() ? prompt.trim() : 'seamless natural background, photorealistic',
      parameters: {
        image: imageBase64.replace(/^data:image\/\w+;base64,/, ''),
        mask_image: maskBase64.replace(/^data:image\/\w+;base64,/, ''),
      },
    };

    const hfRes = await callHuggingFace(MODELS.inpaint, Buffer.from(JSON.stringify(payload)), {
      'Content-Type': 'application/json',
    });
    const outputBuffer = await hfRes.buffer();

    res.json({ imageBase64: `data:image/png;base64,${outputBuffer.toString('base64')}` });
  } catch (err) {
    console.error('inpaint error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
