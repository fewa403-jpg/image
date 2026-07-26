// ============================================================
// Image Editor
// Fabric.js powers the canvas engine. AI features call our own
// backend (which proxies Hugging Face's free Inference API) or,
// for Style Transfer, run entirely client-side via TensorFlow.js.
// ============================================================

let canvas = null;
let baseImage = null;       // the current flattened photo (fabric.Image)
let originalImageSrc = null; // untouched original, for Reset
let history = [];
let historyIndex = -1;
let suppressHistory = false;
let currentDrawTool = 'brush'; // 'brush' | 'blur' | 'mask'
let maskStrokes = [];         // points painted in "mask" mode, for Remove Object

const $ = (id) => document.getElementById(id);

function toast(msg, type = 'success') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast show ${type}`;
  setTimeout(() => (t.className = 'toast'), 3800);
}

// ---------------- Landing screen: load an image ----------------
const fileInput = $('fileInput');
const landing = $('landing');

fileInput.addEventListener('change', (e) => {
  if (e.target.files[0]) loadImageFile(e.target.files[0]);
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer.files[0]) loadImageFile(e.dataTransfer.files[0]);
});

$('newImageInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (baseImage && !confirm('Load a new image? Any unsaved edits to the current one will be lost.')) {
    e.target.value = '';
    return;
  }
  loadImageFile(file);
  e.target.value = '';
});

function loadImageFile(file) {
  if (!file.type.startsWith('image/')) return toast('Please choose an image file', 'error');
  const reader = new FileReader();
  reader.onload = (ev) => openEditorWithImage(ev.target.result);
  reader.readAsDataURL(file);
}

function openEditorWithImage(dataUrl) {
  originalImageSrc = dataUrl;
  landing.classList.add('hidden');
  $('editor').classList.remove('hidden');
  initCanvasIfNeeded();
  loadImageIntoCanvas(dataUrl, true);
}

function initCanvasIfNeeded() {
  if (canvas) return;
  canvas = new fabric.Canvas('mainCanvas', { preserveObjectStacking: true, backgroundColor: '#fff' });
  canvas.freeDrawingBrush = new fabric.PencilBrush(canvas);

  canvas.on('object:modified', pushHistory);
  canvas.on('object:added', () => { pushHistory(); refreshLayersList(); });
  canvas.on('object:removed', () => { refreshLayersList(); });
  canvas.on('selection:created', syncStylePanelToSelection);
  canvas.on('selection:updated', syncStylePanelToSelection);

  setupToolRail();
  setupCropTools();
  setupAdjustments();
  setupFilterPresets();
  setupTextTools();
  setupStickers();
  setupDrawTools();
  setupCutoutTools();
  setupAnimateTools();
  setupTopbar();
  setupAiTools();
}

function loadImageIntoCanvas(dataUrl, resetHistory = false) {
  fabric.Image.fromURL(dataUrl, (img) => {
    canvas.clear();
    const container = document.getElementById('canvasFrame').parentElement;
    const maxW = container.clientWidth - 60;
    const maxH = container.clientHeight - 60;
    const scale = Math.min(maxW / img.width, maxH / img.height, 1);

    canvas.setWidth(img.width * scale);
    canvas.setHeight(img.height * scale);
    canvas.setZoom(scale);

    img.set({ left: 0, top: 0, selectable: false, evented: false });
    canvas.add(img);
    baseImage = img;
    canvas.renderAll();

    if (resetHistory || history.length === 0) {
      history = [];
      historyIndex = -1;
    }
    pushHistory();
    refreshLayersList();
    updateZoomLabel();
  }, { crossOrigin: 'anonymous' });
}

// ---------------- History (undo/redo) ----------------
function pushHistory() {
  if (suppressHistory || !canvas) return;
  history = history.slice(0, historyIndex + 1);
  history.push(JSON.stringify(canvas.toJSON()));
  historyIndex = history.length - 1;
}

function restoreHistory(index) {
  if (index < 0 || index >= history.length) return;
  suppressHistory = true;
  canvas.loadFromJSON(history[index], () => {
    canvas.renderAll();
    baseImage = canvas.getObjects().find((o) => o.type === 'image' && !o.selectable) || canvas.getObjects()[0];
    refreshLayersList();
    suppressHistory = false;
  });
}

$('btnUndo').addEventListener('click', () => { if (historyIndex > 0) restoreHistory(--historyIndex); });
$('btnRedo').addEventListener('click', () => { if (historyIndex < history.length - 1) restoreHistory(++historyIndex); });
$('btnReset').addEventListener('click', () => {
  if (!originalImageSrc) return;
  if (!confirm('Discard all edits and reset to the original image?')) return;
  loadImageIntoCanvas(originalImageSrc, true);
});

// ---------------- Top bar: zoom + export ----------------
function setupTopbar() {
  $('btnZoomIn').addEventListener('click', () => setZoom(canvas.getZoom() * 1.15));
  $('btnZoomOut').addEventListener('click', () => setZoom(canvas.getZoom() / 1.15));
  $('btnExport').addEventListener('click', exportImage);
}
function setZoom(z) {
  const clamped = Math.min(Math.max(z, 0.1), 4);
  canvas.setZoom(clamped);
  canvas.setWidth(baseImage.width * clamped);
  canvas.setHeight(baseImage.height * clamped);
  updateZoomLabel();
}
function updateZoomLabel() {
  $('zoomLabel').textContent = `${Math.round(canvas.getZoom() * 100)}%`;
}
function exportImage() {
  const dataUrl = canvas.toDataURL({ format: 'png', quality: 1, multiplier: 1 / canvas.getZoom() });
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = 'edited-image.png';
  a.click();
}

// ---------------- Tool rail switching ----------------
function setupToolRail() {
  document.querySelectorAll('.rail-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      try {
        document.querySelectorAll('.rail-btn').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.panel-section').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        const target = document.querySelector(`.panel-section[data-section="${btn.dataset.panel}"]`);
        if (!target) {
          console.error(`No panel found for data-panel="${btn.dataset.panel}"`);
          return;
        }
        target.classList.add('active');
        if (btn.dataset.panel === 'layers') refreshLayersList();

        if (btn.dataset.panel === 'cutout') {
          $('canvasFrame').classList.add('hidden');
          $('cutoutFrame').classList.remove('hidden');
          initCutoutTool();
        } else {
          $('cutoutFrame').classList.add('hidden');
          $('canvasFrame').classList.remove('hidden');
        }
      } catch (err) {
        console.error('Tab switch failed:', err);
      }
      // Leaving the Draw panel should stop drawing mode so clicks elsewhere behave normally
      if (btn.dataset.panel !== 'draw') canvas.isDrawingMode = false;
    });
  });
}

// ---------------- Crop ----------------
let cropRect = null;
function setupCropTools() {
  $('btnRotateLeft').addEventListener('click', () => rotateBase(-90));
  $('btnRotateRight').addEventListener('click', () => rotateBase(90));
  $('btnFlipH').addEventListener('click', () => { baseImage.set('flipX', !baseImage.flipX); canvas.renderAll(); pushHistory(); });
  $('btnFlipV').addEventListener('click', () => { baseImage.set('flipY', !baseImage.flipY); canvas.renderAll(); pushHistory(); });

  $('rotateSlider').addEventListener('input', (e) => {
    baseImage.set('angle', Number(e.target.value));
    canvas.renderAll();
  });
  $('rotateSlider').addEventListener('change', pushHistory);

  $('btnStartCrop').addEventListener('click', () => {
    if (cropRect) canvas.remove(cropRect);
    cropRect = new fabric.Rect({
      left: canvas.width * 0.15,
      top: canvas.height * 0.15,
      width: canvas.width * 0.7,
      height: canvas.height * 0.7,
      fill: 'rgba(201,162,39,0.12)',
      stroke: '#c9a227',
      strokeWidth: 1.5,
      strokeDashArray: [6, 4],
      cornerColor: '#c9a227',
      transparentCorners: false,
    });
    canvas.add(cropRect);
    canvas.setActiveObject(cropRect);
  });

  $('btnApplyCrop').addEventListener('click', () => {
    if (!cropRect) return toast('Click "Start Crop" first', 'error');
    const zoom = canvas.getZoom();
    const cropData = {
      left: cropRect.left / zoom,
      top: cropRect.top / zoom,
      width: (cropRect.width * cropRect.scaleX) / zoom,
      height: (cropRect.height * cropRect.scaleY) / zoom,
    };
    const croppedDataUrl = canvas.toDataURL({
      format: 'png',
      left: cropRect.left,
      top: cropRect.top,
      width: cropRect.width * cropRect.scaleX,
      height: cropRect.height * cropRect.scaleY,
    });
    canvas.remove(cropRect);
    cropRect = null;
    loadImageIntoCanvas(croppedDataUrl);
  });
}
function rotateBase(delta) {
  const newAngle = ((baseImage.angle || 0) + delta) % 360;
  baseImage.set('angle', newAngle);
  $('rotateSlider').value = 0;
  canvas.renderAll();
  pushHistory();
}

// ---------------- Adjustments (filters) ----------------
function setupAdjustments() {
  document.querySelectorAll('.adjust-slider').forEach((slider) => {
    slider.addEventListener('input', () => applyAdjustments());
    slider.addEventListener('change', pushHistory);
  });
  $('vignetteSlider').addEventListener('input', () => applyAdjustments());
  $('vignetteSlider').addEventListener('change', pushHistory);
  $('btnResetAdjust').addEventListener('click', () => {
    document.querySelectorAll('.adjust-slider').forEach((s) => (s.value = 0));
    $('vignetteSlider').value = 0;
    applyAdjustments();
    pushHistory();
  });
}
function applyAdjustments() {
  if (!baseImage) return;
  const get = (name) => {
    const el = document.querySelector(`.adjust-slider[data-filter="${name}"]`);
    return el ? Number(el.value) : 0;
  };
  const filters = [];
  const brightness = get('brightness');
  const contrast = get('contrast');
  const highlights = get('highlights');
  const shadows = get('shadows');
  const saturation = get('saturation');
  const vibrance = get('vibrance');
  const temperature = get('temperature');
  const tint = get('tint');
  const hue = get('hue');
  const sharpen = get('sharpen');
  const blur = get('blur');
  const grain = get('grain');

  if (brightness) filters.push(new fabric.Image.filters.Brightness({ brightness }));
  if (contrast) filters.push(new fabric.Image.filters.Contrast({ contrast }));
  // Highlights/Shadows approximated via per-channel gamma — canvas filters have
  // no true tone curve, but pushing gamma up/down mimics lifting or crushing
  // brighter vs darker tones reasonably well.
  if (highlights) {
    const g = 1 - highlights * 0.4;
    filters.push(new fabric.Image.filters.Gamma({ gamma: [g, g, g] }));
  }
  if (shadows) {
    const g = 1 + shadows * 0.4;
    filters.push(new fabric.Image.filters.Brightness({ brightness: shadows * 0.15 }));
    filters.push(new fabric.Image.filters.Gamma({ gamma: [g, g, g] }));
  }
  if (saturation) filters.push(new fabric.Image.filters.Saturation({ saturation }));
  if (vibrance) filters.push(new fabric.Image.filters.Saturation({ saturation: vibrance * 0.6 }));
  if (temperature) filters.push(new fabric.Image.filters.HueRotation({ rotation: temperature * 0.35 }));
  if (tint) filters.push(new fabric.Image.filters.HueRotation({ rotation: tint * 0.12 }));
  if (hue) filters.push(new fabric.Image.filters.HueRotation({ rotation: hue * Math.PI }));
  if (sharpen) {
    const s = sharpen * 0.6;
    filters.push(new fabric.Image.filters.Convolute({
      matrix: [0, -s, 0, -s, 1 + 4 * s, -s, 0, -s, 0],
    }));
  }
  if (blur) filters.push(new fabric.Image.filters.Blur({ blur }));
  if (grain) filters.push(new fabric.Image.filters.Noise({ noise: grain * 120 }));

  baseImage.filters = filters;
  baseImage.applyFilters();
  updateVignette(Number($('vignetteSlider').value));
  canvas.renderAll();
}

// Vignette isn't a per-pixel filter — implemented as a radial-gradient overlay
// object with a multiply blend, sized to the photo.
let vignetteObj = null;
function updateVignette(strength) {
  if (vignetteObj) { canvas.remove(vignetteObj); vignetteObj = null; }
  if (!strength) { canvas.renderAll(); return; }
  const w = baseImage.width, h = baseImage.height;
  const gradient = new fabric.Gradient({
    type: 'radial',
    coords: { x1: w / 2, y1: h / 2, r1: 0, x2: w / 2, y2: h / 2, r2: Math.max(w, h) * 0.72 },
    colorStops: [
      { offset: 0, color: `rgba(0,0,0,0)` },
      { offset: 1, color: `rgba(0,0,0,${0.75 * strength})` },
    ],
  });
  vignetteObj = new fabric.Rect({
    left: 0, top: 0, width: w, height: h,
    selectable: false, evented: false,
    globalCompositeOperation: 'multiply',
  });
  vignetteObj.set('fill', gradient);
  canvas.add(vignetteObj);
  canvas.bringToFront(vignetteObj);
  canvas.renderAll();
}

// ---------------- Filter presets ("Looks") ----------------
// Rather than hand-author 100 unique looks, we combine a set of base color
// grades with several intensity levels each — the same technique most photo
// apps use to offer a big filter library without it being 100 one-off recipes.
const GRADE_DEFS = [
  { name: 'Noir', build: (t) => [new fabric.Image.filters.Grayscale(), new fabric.Image.filters.Contrast({ contrast: 0.35 * t })] },
  { name: 'Vivid', build: (t) => [new fabric.Image.filters.Saturation({ saturation: 0.6 * t }), new fabric.Image.filters.Contrast({ contrast: 0.15 * t })] },
  { name: 'Vintage', build: (t) => [new fabric.Image.filters.Sepia(), new fabric.Image.filters.Noise({ noise: 40 * t }), new fabric.Image.filters.Brightness({ brightness: -0.05 * t })] },
  { name: 'Cool', build: (t) => [new fabric.Image.filters.HueRotation({ rotation: 0.35 * t })] },
  { name: 'Warm', build: (t) => [new fabric.Image.filters.HueRotation({ rotation: -0.2 * t }), new fabric.Image.filters.Saturation({ saturation: 0.15 * t })] },
  { name: 'High Contrast', build: (t) => [new fabric.Image.filters.Contrast({ contrast: 0.5 * t })] },
  { name: 'Soft Focus', build: (t) => [new fabric.Image.filters.Blur({ blur: 0.1 * t }), new fabric.Image.filters.Brightness({ brightness: 0.06 * t })] },
  { name: 'Faded', build: (t) => [new fabric.Image.filters.Contrast({ contrast: -0.2 * t }), new fabric.Image.filters.Brightness({ brightness: 0.1 * t }), new fabric.Image.filters.Saturation({ saturation: -0.2 * t })] },
  { name: 'Teal & Orange', build: (t) => [new fabric.Image.filters.HueRotation({ rotation: 0.18 * t }), new fabric.Image.filters.Saturation({ saturation: 0.3 * t })] },
  { name: 'Moody', build: (t) => [new fabric.Image.filters.Contrast({ contrast: 0.25 * t }), new fabric.Image.filters.Brightness({ brightness: -0.12 * t }), new fabric.Image.filters.Saturation({ saturation: -0.15 * t })] },
  { name: 'Golden Hour', build: (t) => [new fabric.Image.filters.HueRotation({ rotation: -0.12 * t }), new fabric.Image.filters.Brightness({ brightness: 0.08 * t }), new fabric.Image.filters.Saturation({ saturation: 0.2 * t })] },
  { name: 'Blue Hour', build: (t) => [new fabric.Image.filters.HueRotation({ rotation: 0.28 * t }), new fabric.Image.filters.Brightness({ brightness: -0.1 * t })] },
  { name: 'Cross Process', build: (t) => [new fabric.Image.filters.HueRotation({ rotation: 0.22 * t }), new fabric.Image.filters.Contrast({ contrast: 0.2 * t }), new fabric.Image.filters.Saturation({ saturation: 0.25 * t })] },
  { name: 'Matte', build: (t) => [new fabric.Image.filters.Contrast({ contrast: -0.12 * t }), new fabric.Image.filters.Brightness({ brightness: 0.05 * t })] },
  { name: 'Rose', build: (t) => [new fabric.Image.filters.HueRotation({ rotation: -0.06 * t }), new fabric.Image.filters.Saturation({ saturation: 0.1 * t }), new fabric.Image.filters.Brightness({ brightness: 0.04 * t })] },

  // ---- Instagram-style classics ----
  { name: 'IG Clarendon', build: (t) => [new fabric.Image.filters.Brightness({ brightness: 0.1 * t }), new fabric.Image.filters.Contrast({ contrast: 0.3 * t }), new fabric.Image.filters.HueRotation({ rotation: 0.08 * t })] },
  { name: 'IG Gingham', build: (t) => [new fabric.Image.filters.Sepia(), new fabric.Image.filters.Brightness({ brightness: 0.05 * t }), new fabric.Image.filters.Contrast({ contrast: -0.15 * t })] },
  { name: 'IG Juno', build: (t) => [new fabric.Image.filters.HueRotation({ rotation: -0.1 * t }), new fabric.Image.filters.Saturation({ saturation: 0.35 * t }), new fabric.Image.filters.Contrast({ contrast: 0.1 * t })] },
  { name: 'IG Lark', build: (t) => [new fabric.Image.filters.Brightness({ brightness: 0.12 * t }), new fabric.Image.filters.Saturation({ saturation: -0.15 * t }), new fabric.Image.filters.Contrast({ contrast: 0.08 * t })] },
  { name: 'IG Valencia', build: (t) => [new fabric.Image.filters.Sepia(), new fabric.Image.filters.Brightness({ brightness: 0.08 * t }), new fabric.Image.filters.Contrast({ contrast: 0.1 * t })] },

  // ---- TikTok-style looks ----
  { name: 'TikTok Glow', build: (t) => [new fabric.Image.filters.Blur({ blur: 0.04 * t }), new fabric.Image.filters.Brightness({ brightness: 0.12 * t }), new fabric.Image.filters.HueRotation({ rotation: -0.05 * t })] },
  { name: 'TikTok Vivid', build: (t) => [new fabric.Image.filters.Saturation({ saturation: 0.5 * t }), new fabric.Image.filters.Contrast({ contrast: 0.25 * t })] },
  { name: 'TikTok Pastel', build: (t) => [new fabric.Image.filters.Contrast({ contrast: -0.2 * t }), new fabric.Image.filters.Brightness({ brightness: 0.15 * t }), new fabric.Image.filters.Saturation({ saturation: -0.1 * t })] },
  { name: 'TikTok Neon Pop', build: (t) => [new fabric.Image.filters.Saturation({ saturation: 0.45 * t }), new fabric.Image.filters.HueRotation({ rotation: 0.2 * t }), new fabric.Image.filters.Contrast({ contrast: 0.15 * t })] },

  // ---- Beauty / portrait smoothing ----
  { name: 'Beauty Smooth', build: (t) => [new fabric.Image.filters.Blur({ blur: 0.05 * t }), new fabric.Image.filters.Brightness({ brightness: 0.08 * t }), new fabric.Image.filters.Saturation({ saturation: 0.08 * t })] },
];
const INTENSITY_LEVELS = [0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1.0];

function setupFilterPresets() {
  const grid = $('filterGrid');
  const countLabel = $('filterCount');
  if (countLabel) countLabel.textContent = `${GRADE_DEFS.length} looks`;
  grid.innerHTML = '';

  // "Original" card — clears whichever Look is active
  const resetCard = document.createElement('div');
  resetCard.className = 'filter-thumb';
  resetCard.textContent = 'Original';
  resetCard.addEventListener('click', () => {
    transitionEffect(() => {
      collapseAllFilterCards();
      document.querySelectorAll('.adjust-slider').forEach((s) => (s.value = 0));
      baseImage.filters = [];
      baseImage.applyFilters();
      canvas.renderAll();
      pushHistory();
    });
  });
  grid.appendChild(resetCard);

  GRADE_DEFS.forEach((grade) => {
    const card = document.createElement('div');
    card.className = 'filter-thumb';

    const label = document.createElement('div');
    label.className = 'filter-thumb-label';
    label.textContent = grade.name;
    card.appendChild(label);

    const sliderRow = document.createElement('div');
    sliderRow.className = 'filter-slider-row';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = 0;
    slider.max = 100;
    slider.value = 60; // sensible default intensity the moment a Look is opened
    sliderRow.appendChild(slider);
    card.appendChild(sliderRow);
    grid.appendChild(card);

    // Click the name: open this card's slider (closing any other open one)
    // and apply the Look immediately at the slider's current value.
    label.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = card.classList.contains('expanded');
      collapseAllFilterCards();
      if (wasOpen) return; // clicking an already-open card just closes it

      transitionEffect(() => {
        card.classList.add('expanded');
        document.querySelectorAll('.adjust-slider').forEach((s) => (s.value = 0));
        applyGradeLive(grade, Number(slider.value) / 100);
        pushHistory();
      });
    });

    // Dragging the slider: live preview, no crossfade (would be jarring
    // mid-drag) — just an instant, continuous update.
    slider.addEventListener('input', () => {
      applyGradeLive(grade, Number(slider.value) / 100);
    });
    // Commit one history entry when the user releases the slider, not on
    // every tick while dragging.
    slider.addEventListener('change', () => {
      pushHistory();
    });
  });
}

function collapseAllFilterCards() {
  document.querySelectorAll('#filterGrid .filter-thumb.expanded').forEach((el) => el.classList.remove('expanded'));
}

function applyGradeLive(grade, t) {
  baseImage.filters = grade.build(t);
  baseImage.applyFilters();
  canvas.renderAll();
}

// A quick "transition": snapshot the current look, swap to the new one, then
// crossfade the old snapshot out — gives filter changes a bit of polish
// instead of an instant, jarring swap.
function transitionEffect(applyFn) {
  const frame = $('canvasFrame');
  const snapshot = canvas.toDataURL({ format: 'png' });
  const overlay = document.createElement('img');
  overlay.src = snapshot;
  overlay.style.position = 'absolute';
  overlay.style.left = '0';
  overlay.style.top = '0';
  overlay.style.width = '100%';
  overlay.style.height = '100%';
  overlay.style.transition = 'opacity 0.4s ease';
  overlay.style.pointerEvents = 'none';
  frame.style.position = 'relative';
  frame.appendChild(overlay);

  applyFn();

  requestAnimationFrame(() => {
    overlay.style.opacity = '0';
    setTimeout(() => overlay.remove(), 420);
  });
}

// ---------------- Text ----------------
function setupTextTools() {
  $('btnAddText').addEventListener('click', () => {
    const text = new fabric.IText('Double-click to edit', {
      left: canvas.width / 2 - 80,
      top: canvas.height / 2 - 20,
      fontFamily: $('textFont').value,
      fontSize: Number($('textSize').value),
      fill: $('textColor').value,
    });
    canvas.add(text);
    canvas.setActiveObject(text);
  });

  const applyToActiveText = (fn) => {
    const obj = canvas.getActiveObject();
    if (!obj || obj.type !== 'i-text') return;
    fn(obj);
    canvas.renderAll();
  };

  $('textFont').addEventListener('input', () => applyToActiveText((o) => o.set('fontFamily', $('textFont').value)));
  $('textSize').addEventListener('input', () => applyToActiveText((o) => o.set('fontSize', Number($('textSize').value))));
  $('textColor').addEventListener('input', () => applyToActiveText((o) => o.set('fill', $('textColor').value)));
  $('textSpacing').addEventListener('input', () => applyToActiveText((o) => o.set('charSpacing', Number($('textSpacing').value))));
  $('textLineHeight').addEventListener('input', () => applyToActiveText((o) => o.set('lineHeight', Number($('textLineHeight').value))));
  $('textOpacity').addEventListener('input', () => applyToActiveText((o) => o.set('opacity', Number($('textOpacity').value))));

  $('textBold').addEventListener('click', () => {
    applyToActiveText((o) => o.set('fontWeight', o.fontWeight === 'bold' ? 'normal' : 'bold'));
    $('textBold').classList.toggle('active');
  });
  $('textItalic').addEventListener('click', () => {
    applyToActiveText((o) => o.set('fontStyle', o.fontStyle === 'italic' ? 'normal' : 'italic'));
    $('textItalic').classList.toggle('active');
  });
  $('textUnderline').addEventListener('click', () => {
    applyToActiveText((o) => o.set('underline', !o.underline));
    $('textUnderline').classList.toggle('active');
  });

  ['textAlignLeft', 'textAlignCenter', 'textAlignRight'].forEach((id) => {
    $(id).addEventListener('click', () => {
      const align = id.replace('textAlign', '').toLowerCase();
      applyToActiveText((o) => o.set('textAlign', align));
      document.querySelectorAll('#textAlignLeft, #textAlignCenter, #textAlignRight').forEach((b) => b.classList.remove('active'));
      $(id).classList.add('active');
    });
  });

  $('textShadowToggle').addEventListener('click', () => {
    applyToActiveText((o) => {
      o.set('shadow', o.shadow ? null : new fabric.Shadow({ color: 'rgba(0,0,0,0.6)', blur: 8, offsetX: 3, offsetY: 3 }));
    });
    $('textShadowToggle').classList.toggle('active');
  });
}
function syncStylePanelToSelection() {
  const obj = canvas.getActiveObject();
  if (obj && obj.type === 'i-text') {
    $('textFont').value = obj.fontFamily || 'Inter';
    $('textSize').value = obj.fontSize || 48;
    $('textColor').value = rgbToHex(obj.fill) || '#f2f0ea';
    $('textSpacing').value = obj.charSpacing || 0;
    $('textLineHeight').value = obj.lineHeight || 1.16;
    $('textOpacity').value = obj.opacity ?? 1;
    $('textBold').classList.toggle('active', obj.fontWeight === 'bold');
    $('textItalic').classList.toggle('active', obj.fontStyle === 'italic');
    $('textUnderline').classList.toggle('active', !!obj.underline);
    $('textShadowToggle').classList.toggle('active', !!obj.shadow);
  }
}
function rgbToHex(color) {
  if (!color) return null;
  if (color.startsWith('#')) return color;
  return color;
}

// ---------------- Stickers ----------------
const EMOJIS = ['⭐', '❤️', '✨', '🔥', '👑', '💎', '🌿', '☀️', '🌙', '📍', '✔️', '➤'];
function setupStickers() {
  const grid = $('emojiGrid');
  EMOJIS.forEach((emoji) => {
    const btn = document.createElement('button');
    btn.textContent = emoji;
    btn.addEventListener('click', () => {
      const obj = new fabric.Text(emoji, {
        left: canvas.width / 2 - 20,
        top: canvas.height / 2 - 20,
        fontSize: 48,
      });
      canvas.add(obj);
      canvas.setActiveObject(obj);
    });
    grid.appendChild(btn);
  });

  $('overlayInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      fabric.Image.fromURL(ev.target.result, (img) => {
        img.scaleToWidth(canvas.width * 0.3);
        img.set({ left: canvas.width / 2, top: canvas.height / 2 });
        canvas.add(img);
        canvas.setActiveObject(img);
      });
    };
    reader.readAsDataURL(file);
  });
}

// ---------------- Draw & retouch ----------------
function setupDrawTools() {
  $('toolBrush').addEventListener('click', () => setDrawTool('brush'));
  $('toolBlur').addEventListener('click', () => setDrawTool('blur'));
  $('btnStopDraw').addEventListener('click', () => {
    canvas.isDrawingMode = false;
    canvas.off('mouse:move', blurPaintHandler);
    canvas.off('mouse:down', blurDownHandler);
    canvas.off('mouse:up', blurUpHandler);
  });

  $('brushSize').addEventListener('input', (e) => {
    if (canvas.freeDrawingBrush) canvas.freeDrawingBrush.width = Number(e.target.value);
    currentBrushSize = Number(e.target.value);
  });
  $('brushColor').addEventListener('input', (e) => {
    if (canvas.freeDrawingBrush) canvas.freeDrawingBrush.color = e.target.value;
  });

  setDrawTool('brush');
}

let currentBrushSize = 14;
let isBlurPainting = false;

function setDrawTool(tool) {
  currentDrawTool = tool;
  document.querySelectorAll('#toolBrush, #toolBlur').forEach((b) => b.classList.remove('active'));
  canvas.off('mouse:move', blurPaintHandler);
  canvas.off('mouse:down', blurDownHandler);
  canvas.off('mouse:up', blurUpHandler);

  if (tool === 'brush') {
    $('toolBrush').classList.add('active');
    canvas.isDrawingMode = true;
    canvas.freeDrawingBrush.width = currentBrushSize;
    canvas.freeDrawingBrush.color = $('brushColor').value;
  } else if (tool === 'blur') {
    $('toolBlur').classList.add('active');
    canvas.isDrawingMode = false;
    canvas.on('mouse:down', blurDownHandler);
    canvas.on('mouse:move', blurPaintHandler);
    canvas.on('mouse:up', blurUpHandler);
  }
}

function blurDownHandler() { isBlurPainting = true; }
function blurUpHandler() { isBlurPainting = false; pushHistory(); }
function blurPaintHandler(opt) {
  if (!isBlurPainting) return;
  const pointer = canvas.getPointer(opt.e);
  const radius = currentBrushSize;
  paintBlurDab(pointer.x, pointer.y, radius);
}

// Paints a small blurred patch of the current canvas at (x, y) — a simple,
// effective "retouch" brush without needing a full clone-stamp implementation.
function paintBlurDab(x, y, radius) {
  const size = radius * 2;
  const srcCanvas = canvas.lowerCanvasEl;
  const off = document.createElement('canvas');
  off.width = size;
  off.height = size;
  const offCtx = off.getContext('2d');
  offCtx.filter = `blur(${Math.max(2, radius * 0.35)}px)`;
  offCtx.drawImage(srcCanvas, x - radius, y - radius, size, size, 0, 0, size, size);

  fabric.Image.fromURL(off.toDataURL(), (img) => {
    img.set({
      left: x - radius,
      top: y - radius,
      selectable: false,
      evented: false,
    });
    img.clipPath = new fabric.Circle({ radius, originX: 'center', originY: 'center', left: radius, top: radius });
    suppressHistory = true;
    canvas.add(img);
    canvas.renderAll();
    suppressHistory = false;
  });
}

// ---------------- Layers panel ----------------
function refreshLayersList() {
  if (!canvas) return;
  const list = $('layersList');
  list.innerHTML = '';
  const objects = canvas.getObjects().slice().reverse();
  objects.forEach((obj) => {
    const li = document.createElement('li');
    if (canvas.getActiveObject() === obj) li.classList.add('selected');
    const name = document.createElement('span');
    name.className = 'layer-name';
    name.textContent = labelForObject(obj);
    li.appendChild(name);

    if (obj !== baseImage) {
      const upBtn = mkBtn('↑', () => { canvas.bringForward(obj); refreshLayersList(); });
      const downBtn = mkBtn('↓', () => { canvas.sendBackwards(obj); refreshLayersList(); });
      const visBtn = mkBtn(obj.visible === false ? '👁‍🗨' : '👁', () => { obj.visible = obj.visible === false ? true : false; canvas.renderAll(); refreshLayersList(); });
      const delBtn = mkBtn('✕', () => { canvas.remove(obj); });
      li.append(upBtn, downBtn, visBtn, delBtn);
    }

    li.addEventListener('click', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      canvas.setActiveObject(obj);
      canvas.renderAll();
      refreshLayersList();
    });
    list.appendChild(li);
  });
}
function mkBtn(label, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}
function labelForObject(obj) {
  if (obj === baseImage) return 'Photo';
  if (obj.type === 'i-text') return `Text: ${obj.text.slice(0, 16)}`;
  if (obj.type === 'image') return 'Image / Sticker';
  if (obj.type === 'text') return `Sticker: ${obj.text}`;
  if (obj.type === 'path') return 'Brush stroke';
  return obj.type;
}

// ============================================================
// Animated Thumbnail — 50 presets (5 movements x 5 filter tracks x 2 speeds),
// each rendering a real downloadable GIF client-side via gif.js.
// ============================================================
const MOVEMENTS = ['Zoom In', 'Zoom Out', 'Pan Left', 'Pan Right', 'Diagonal'];
const FILTER_TRACK_GRADES = ['None', 'Warm', 'Cool', 'Vivid', 'Noir'];
const SPEEDS = [{ name: 'Slow', duration: 6 }, { name: 'Fast', duration: 3 }];

function filtersForGrade(gradeName) {
  if (gradeName === 'None') return null;
  const grade = GRADE_DEFS.find((g) => g.name === gradeName);
  if (!grade) return null;
  return INTENSITY_LEVELS.map((t) => ({ filters: () => grade.build(t) }));
}

const ANIM_PRESETS = [];
MOVEMENTS.forEach((movement) => {
  FILTER_TRACK_GRADES.forEach((grade) => {
    SPEEDS.forEach((speed) => {
      ANIM_PRESETS.push({
        name: `${movement} · ${grade} · ${speed.name}`,
        movement,
        grade,
        duration: speed.duration,
      });
    });
  });
});

function setupAnimateTools() {
  const grid = $('animGrid');
  const countLabel = $('animCount');
  if (countLabel) countLabel.textContent = `${ANIM_PRESETS.length} presets`;
  ANIM_PRESETS.forEach((preset) => {
    const div = document.createElement('div');
    div.className = 'filter-thumb';
    div.textContent = preset.name;
    div.addEventListener('click', () => generateAnimatedThumbnail(preset));
    grid.appendChild(div);
  });
}

let cachedGifWorkerUrl = null;
async function getGifWorkerBlobUrl() {
  if (cachedGifWorkerUrl) return cachedGifWorkerUrl;
  const resp = await fetch('https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.worker.js');
  if (!resp.ok) throw new Error('Could not load the GIF encoder worker script');
  const text = await resp.text();
  const blob = new Blob([text], { type: 'application/javascript' });
  cachedGifWorkerUrl = URL.createObjectURL(blob);
  return cachedGifWorkerUrl;
}

async function generateAnimatedThumbnail(preset) {
  if (!baseImage) return toast('Load an image first', 'error');
  const fps = 15;
  const totalFrames = Math.max(50, Math.round(preset.duration * fps));

  showAiOverlay(`Rendering "${preset.name}"… (0/${totalFrames})`);
  $('animPreviewWrap').innerHTML = '';

  try {
    const frameSrc = getFlattenedImageBase64();
    const baseImg = await new Promise((resolve) => {
      fabric.Image.fromURL(frameSrc, resolve, { crossOrigin: 'anonymous' });
    });

    const offCanvas = document.createElement('canvas');
    const staticCanvas = new fabric.StaticCanvas(offCanvas, { width: baseImg.width, height: baseImg.height });
    baseImg.set({ left: 0, top: 0, originX: 'left', originY: 'top' });
    staticCanvas.add(baseImg);

    const workerScriptUrl = await getGifWorkerBlobUrl();
    const gif = new GIF({ workers: 2, quality: 12, width: baseImg.width, height: baseImg.height, workerScript: workerScriptUrl });

    const cycleFilters = filtersForGrade(preset.grade);

    for (let i = 0; i < totalFrames; i++) {
      const t = i / (totalFrames - 1);

      switch (preset.movement) {
        case 'Zoom In': {
          const scale = 1 + 0.15 * t;
          baseImg.set({ scaleX: scale, scaleY: scale, left: -(baseImg.width * (scale - 1)) / 2, top: -(baseImg.height * (scale - 1)) / 2 });
          break;
        }
        case 'Zoom Out': {
          const scale = 1.15 - 0.15 * t;
          baseImg.set({ scaleX: scale, scaleY: scale, left: -(baseImg.width * (scale - 1)) / 2, top: -(baseImg.height * (scale - 1)) / 2 });
          break;
        }
        case 'Pan Left': {
          baseImg.set({ scaleX: 1.12, scaleY: 1.12, left: -(baseImg.width * 0.12) * t, top: -(baseImg.height * 0.06) });
          break;
        }
        case 'Pan Right': {
          baseImg.set({ scaleX: 1.12, scaleY: 1.12, left: -(baseImg.width * 0.12) * (1 - t), top: -(baseImg.height * 0.06) });
          break;
        }
        case 'Diagonal': {
          const scale = 1 + 0.14 * t;
          baseImg.set({ scaleX: scale, scaleY: scale, left: -(baseImg.width * 0.1) * t, top: -(baseImg.height * 0.08) * t });
          break;
        }
      }

      if (cycleFilters) {
        const idx = Math.floor(t * (cycleFilters.length - 1e-6));
        baseImg.filters = cycleFilters[idx].filters();
        baseImg.applyFilters();
      }

      staticCanvas.renderAll();
      gif.addFrame(staticCanvas.getContext('2d'), { copy: true, delay: Math.round(1000 / fps) });

      if (i % 8 === 0) {
        showAiOverlay(`Rendering "${preset.name}"… (${i}/${totalFrames})`);
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    gif.on('progress', (p) => showAiOverlay(`Encoding GIF… ${Math.round(p * 100)}%`));
    gif.on('finished', (blob) => {
      const url = URL.createObjectURL(blob);
      $('animPreviewWrap').innerHTML = `
        <img src="${url}" style="max-width:100%;border-radius:6px;margin-top:12px;display:block;" />
        <a href="${url}" download="animated-thumbnail.gif" class="chip-btn accent" style="display:inline-block;margin-top:10px;text-decoration:none;">Download GIF</a>
      `;
      hideAiOverlay();
      toast(`Animated thumbnail ready (${totalFrames} frames)`);
    });
    gif.render();
  } catch (err) {
    hideAiOverlay();
    toast('Animation failed: ' + err.message, 'error');
  }
}
// ============================================================
// Background Cutout — Magic Wand + Erase + Restore.
// Pure canvas pixel math, zero external dependencies, so nothing here can
// fail to load or version-conflict. Two persistent full-resolution canvases:
// cutoutOriginalCanvas (never touched — the source for Restore) and
// cutoutFullCanvas (the working copy we actually cut into).
// ============================================================
let cutoutOriginalCanvas = null;
let cutoutFullCanvas = null;
let cutoutFullCtx = null;
let cutoutScale = 1;
let cutoutMode = 'wand';
let cutoutPainting = false;

function setupCutoutTools() {
  $('wandModeBtn').addEventListener('click', () => setCutoutMode('wand'));
  $('eraseModeBtn').addEventListener('click', () => setCutoutMode('erase'));
  $('restoreModeBtn').addEventListener('click', () => setCutoutMode('restore'));
  $('btnResetCutout').addEventListener('click', initCutoutTool);
  $('btnApplyCutout').addEventListener('click', applyCutout);

  const cvs = $('cutoutCanvas');
  cvs.addEventListener('pointerdown', (e) => {
    if (cutoutMode === 'wand') { handleWandClick(e); return; }
    cutoutPainting = true;
    paintCutoutBrush(e);
  });
  cvs.addEventListener('pointermove', (e) => { if (cutoutPainting) paintCutoutBrush(e); });
  window.addEventListener('pointerup', () => { cutoutPainting = false; });
  window.addEventListener('resize', () => { if (cutoutFullCanvas) renderCutoutPreview(); });
}

function setCutoutMode(mode) {
  cutoutMode = mode;
  ['wand', 'erase', 'restore'].forEach((m) => $(`${m}ModeBtn`).classList.toggle('active', m === mode));
}

async function initCutoutTool() {
  if (!baseImage) return;
  const frameSrc = getFlattenedImageBase64();
  const imgEl = await dataUrlToImageElement(frameSrc);

  cutoutOriginalCanvas = document.createElement('canvas');
  cutoutOriginalCanvas.width = imgEl.width;
  cutoutOriginalCanvas.height = imgEl.height;
  cutoutOriginalCanvas.getContext('2d').drawImage(imgEl, 0, 0);

  cutoutFullCanvas = document.createElement('canvas');
  cutoutFullCanvas.width = imgEl.width;
  cutoutFullCanvas.height = imgEl.height;
  cutoutFullCtx = cutoutFullCanvas.getContext('2d');
  cutoutFullCtx.drawImage(imgEl, 0, 0);

  renderCutoutPreview();
}

function renderCutoutPreview() {
  if (!cutoutFullCanvas) return;
  const wrap = $('cutoutFrame');
  const container = wrap.parentElement;
  const maxW = container.clientWidth - 60;
  const maxH = container.clientHeight - 60;
  cutoutScale = Math.min(maxW / cutoutFullCanvas.width, maxH / cutoutFullCanvas.height, 1);

  const canvas = $('cutoutCanvas');
  canvas.width = cutoutFullCanvas.width * cutoutScale;
  canvas.height = cutoutFullCanvas.height * cutoutScale;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(cutoutFullCanvas, 0, 0, canvas.width, canvas.height);
}

function handleWandClick(e) {
  const canvas = $('cutoutCanvas');
  const rect = canvas.getBoundingClientRect();
  const x = Math.round((e.clientX - rect.left) / cutoutScale);
  const y = Math.round((e.clientY - rect.top) / cutoutScale);
  if (x < 0 || y < 0 || x >= cutoutFullCanvas.width || y >= cutoutFullCanvas.height) return;

  const tolerance = Number($('wandTolerance').value);
  const imageData = cutoutFullCtx.getImageData(0, 0, cutoutFullCanvas.width, cutoutFullCanvas.height);
  floodFillRemove(imageData, x, y, tolerance);
  cutoutFullCtx.putImageData(imageData, 0, 0);
  renderCutoutPreview();
}

// Stack-based flood fill (recursion would overflow on large images) —
// removes the connected region of similar color starting at (startX, startY).
function floodFillRemove(imageData, startX, startY, tolerance) {
  const { width, height, data } = imageData;
  const startIdx = (startY * width + startX) * 4;
  if (data[startIdx + 3] === 0) return; // already transparent
  const r0 = data[startIdx], g0 = data[startIdx + 1], b0 = data[startIdx + 2];

  const visited = new Uint8Array(width * height);
  const stack = [[startX, startY]];

  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const vIdx = y * width + x;
    if (visited[vIdx]) continue;
    visited[vIdx] = 1;

    const i = vIdx * 4;
    if (data[i + 3] === 0) continue;
    const dr = data[i] - r0, dg = data[i + 1] - g0, db = data[i + 2] - b0;
    if (Math.sqrt(dr * dr + dg * dg + db * db) > tolerance) continue;

    data[i + 3] = 0;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
}

function paintCutoutBrush(e) {
  const canvas = $('cutoutCanvas');
  const rect = canvas.getBoundingClientRect();
  const fx = (e.clientX - rect.left) / cutoutScale;
  const fy = (e.clientY - rect.top) / cutoutScale;
  const radius = Number($('cutoutBrushSize').value) / 2 / cutoutScale;

  cutoutFullCtx.save();
  if (cutoutMode === 'erase') {
    cutoutFullCtx.globalCompositeOperation = 'destination-out';
    cutoutFullCtx.beginPath();
    cutoutFullCtx.arc(fx, fy, radius, 0, Math.PI * 2);
    cutoutFullCtx.fill();
  } else if (cutoutMode === 'restore') {
    cutoutFullCtx.beginPath();
    cutoutFullCtx.arc(fx, fy, radius, 0, Math.PI * 2);
    cutoutFullCtx.clip();
    cutoutFullCtx.clearRect(fx - radius, fy - radius, radius * 2, radius * 2);
    cutoutFullCtx.drawImage(cutoutOriginalCanvas, 0, 0);
  }
  cutoutFullCtx.restore();
  renderCutoutPreview();
}

function applyCutout() {
  if (!cutoutFullCanvas) return;
  const dataUrl = cutoutFullCanvas.toDataURL('image/png');
  loadImageIntoCanvas(dataUrl);
  toast('Cutout applied');
  document.querySelector('.rail-btn[data-panel="layers"]').click();
}

function showAiOverlay(text) {
  $('aiOverlayText').textContent = text;
  $('aiOverlay').classList.remove('hidden');
}
function hideAiOverlay() {
  $('aiOverlay').classList.add('hidden');
}

function getFlattenedImageBase64() {
  return canvas.toDataURL({ format: 'png', multiplier: 1 / canvas.getZoom() });
}

function setupAiTools() {
  $('aiRemoveBg').addEventListener('click', runRemoveBackground);
  $('aiDebugRoundtrip').addEventListener('click', runDebugRoundtrip);
  $('aiUpscale').addEventListener('click', runUpscale);
  $('aiStyleTransfer').addEventListener('click', () => $('styleImageInput').click());
  $('styleImageInput').addEventListener('change', runStyleTransfer);
  $('aiRemoveObject').addEventListener('click', runRemoveObject);
}

async function runDebugRoundtrip() {
  showAiOverlay('Running round-trip test…');
  try {
    const imageBase64 = getFlattenedImageBase64();
    const res = await fetch('/api/ai/debug-roundtrip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64 }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    loadImageIntoCanvas(data.imageBase64);
    toast('Round-trip test done — check for striping');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    hideAiOverlay();
  }
}

// Calls our own server, which runs a small U2Net model locally via
// onnxruntime-node — no Hugging Face, no token, no rate limit, our own compute.
async function runRemoveBackground() {
  const alreadyTransparent = await checkSignificantTransparency();
  if (alreadyTransparent) {
    return toast('This image already looks like its background was removed — running it again tends to over-remove. Use Reset first if you want to redo it.', 'error');
  }
  showAiOverlay('Removing background (first call may take a few extra seconds)…');
  try {
    const imageBase64 = getFlattenedImageBase64();
    const res = await fetch('/api/ai/remove-bg-local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64 }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    loadImageIntoCanvas(data.imageBase64);
    toast('Background removed — touch up in the Cutout tab if needed');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    hideAiOverlay();
  }
}

// Samples the current image's alpha channel to detect if it already has a
// mostly-removed background — re-running removal on that flattens
// transparent areas to solid white first, which confuses the model.
async function checkSignificantTransparency() {
  const img = await dataUrlToImageElement(getFlattenedImageBase64());
  const off = document.createElement('canvas');
  off.width = img.width;
  off.height = img.height;
  const ctx = off.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, off.width, off.height);
  let transparentCount = 0;
  let sampled = 0;
  for (let i = 3; i < data.length; i += 4 * 37) { // sample every 37th pixel for speed
    sampled++;
    if (data[i] < 10) transparentCount++;
  }
  return sampled > 0 && transparentCount / sampled > 0.15;
}

function dataUrlToImageElement(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

// "Upscale" runs locally too: a high-quality resize plus a sharpening pass.
// Honest framing — this isn't a neural super-resolution model (those aren't
// reliably available for free right now), but it's a real, dependable
// improvement in size and perceived clarity, with zero server dependency.
async function runUpscale() {
  showAiOverlay('Enhancing image…');
  try {
    const factor = 1.6;
    const srcImg = await dataUrlToImageElement(getFlattenedImageBase64());

    // Do the resize ourselves with explicit high-quality smoothing — this
    // matters a lot more for perceived sharpness than the sharpen pass does.
    const resized = document.createElement('canvas');
    resized.width = Math.round(srcImg.width * factor);
    resized.height = Math.round(srcImg.height * factor);
    const rctx = resized.getContext('2d');
    rctx.imageSmoothingEnabled = true;
    rctx.imageSmoothingQuality = 'high';
    rctx.drawImage(srcImg, 0, 0, resized.width, resized.height);

    const img = new fabric.Image(resized);
    img.filters = [
      new fabric.Image.filters.Convolute({ matrix: [0, -0.25, 0, -0.25, 2, -0.25, 0, -0.25, 0] }),
      new fabric.Image.filters.Contrast({ contrast: 0.03 }),
      new fabric.Image.filters.Saturation({ saturation: 0.04 }),
    ];
    img.applyFilters();
    const dataUrl = img.toDataURL({ format: 'png' });
    loadImageIntoCanvas(dataUrl);
    toast('Enhanced — sharpened and upscaled locally');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    hideAiOverlay();
  }
}

// Style Match: classic statistical color-transfer (matches mean/spread of
// each color channel from a reference photo onto the current one) — plain
// canvas math, zero external libraries, so nothing here can go out of date
// or break from a CDN/version conflict.
async function runStyleTransfer(e) {
  const file = e.target.files[0];
  if (!file) return;
  showAiOverlay('Matching style…');
  try {
    const styleImg = await fileToImageElement(file);
    const srcImg = await dataUrlToImageElement(getFlattenedImageBase64());

    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = srcImg.width;
    srcCanvas.height = srcImg.height;
    const sctx = srcCanvas.getContext('2d');
    sctx.drawImage(srcImg, 0, 0);
    const srcData = sctx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);

    const styleCanvas = document.createElement('canvas');
    styleCanvas.width = styleImg.width;
    styleCanvas.height = styleImg.height;
    const stctx = styleCanvas.getContext('2d');
    stctx.drawImage(styleImg, 0, 0);
    const styleData = stctx.getImageData(0, 0, styleCanvas.width, styleCanvas.height);

    applyColorTransfer(srcData, styleData);
    sctx.putImageData(srcData, 0, 0);

    loadImageIntoCanvas(srcCanvas.toDataURL('image/png'));
    toast('Style matched');
  } catch (err) {
    toast('Style match failed: ' + err.message, 'error');
  } finally {
    hideAiOverlay();
  }
}
function channelStats(data, offset) {
  const n = data.length / 4;
  let sum = 0;
  for (let i = offset; i < data.length; i += 4) sum += data[i];
  const mean = sum / n;
  let sumSq = 0;
  for (let i = offset; i < data.length; i += 4) sumSq += (data[i] - mean) ** 2;
  const std = Math.sqrt(sumSq / n) || 1;
  return { mean, std };
}
function applyColorTransfer(srcImageData, styleImageData) {
  const src = srcImageData.data;
  const style = styleImageData.data;
  for (let c = 0; c < 3; c++) {
    const s = channelStats(src, c);
    const t = channelStats(style, c);
    const ratio = t.std / (s.std || 1);
    for (let i = c; i < src.length; i += 4) {
      const v = (src[i] - s.mean) * ratio + t.mean;
      src[i] = Math.max(0, Math.min(255, v));
    }
  }
}
function fileToImageElement(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// Remove Object: uses whatever has been painted with the Brush tool (in the
// Draw panel) as the mask — paint over the object you want removed, then run
// this. We build a black/white mask from the brush strokes' positions.
async function runRemoveObject() {
  const strokes = canvas.getObjects().filter((o) => o.type === 'path');
  if (strokes.length === 0) {
    return toast('Paint over the object to remove first, using the Brush tool', 'error');
  }
  showAiOverlay('Removing object…');
  try {
    // Build the mask: white strokes on black, at the image's native resolution.
    const maskCanvasEl = document.createElement('canvas');
    maskCanvasEl.width = baseImage.width;
    maskCanvasEl.height = baseImage.height;
    const mctx = maskCanvasEl.getContext('2d');
    mctx.fillStyle = '#000';
    mctx.fillRect(0, 0, maskCanvasEl.width, maskCanvasEl.height);
    mctx.strokeStyle = '#fff';
    mctx.fillStyle = '#fff';
    const zoom = canvas.getZoom();
    strokes.forEach((path) => {
      mctx.save();
      mctx.lineWidth = (path.strokeWidth || 10) / zoom;
      mctx.beginPath();
      const pathData = path.path;
      pathData.forEach((seg, i) => {
        const cmd = seg[0];
        if (cmd === 'M') mctx.moveTo(seg[1] / zoom, seg[2] / zoom);
        else if (cmd === 'L') mctx.lineTo(seg[1] / zoom, seg[2] / zoom);
        else if (cmd === 'Q') mctx.quadraticCurveTo(seg[1] / zoom, seg[2] / zoom, seg[3] / zoom, seg[4] / zoom);
      });
      mctx.stroke();
      mctx.restore();
    });

    const imageBase64 = getFlattenedImageBase64();
    const maskBase64 = maskCanvasEl.toDataURL('image/png');
    const prompt = $('inpaintPrompt').value;

    const res = await fetch('/api/ai/inpaint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64, maskBase64, prompt }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    loadImageIntoCanvas(data.imageBase64);
    toast('Object removed');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    hideAiOverlay();
  }
}
