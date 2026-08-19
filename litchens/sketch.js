// ---- litchens engine, adapted to render onto the tilt-plane metal panel ----
// Same Game-of-Life-on-text-mask logic as the original litchens project,
// but drawn on a transparent canvas so the metal texture shows through.
// Shown automatically on load (litchensActive defaults to true) — there's
// no more flyer-artwork mode to toggle away from.

// ABC Diatype (trial), self-hosted from /fonts via @font-face in tilt-plane.html.
// Confirmed against the actual Figma source ("Instagram post - 15"): the text
// layers use Regular, not Medium. Falls back to Helvetica/Arial if the font
// file somehow fails to load.
const DIATYPE_REGULAR = '"ABC Diatype Regular"';
const FONT_STACK = DIATYPE_REGULAR + ', Helvetica, Arial, sans-serif';

// The plate's aspect ratio is locked to 1080x1350 (see .plane in
// tilt-plane.html), but the canvas itself renders at whatever actual
// on-screen pixel size the plate happens to be (viewport width, zoom,
// device pixel ratio, etc). cellSize is a "design-space" pixel count
// (relative to this 1080-wide reference) so the CA grid has the same
// density relative to the letterforms no matter how large the plate
// renders — otherwise the same "Cell 2" setting would produce a visibly
// finer or chunkier grid on a bigger screen/window than a smaller one.
const DESIGN_GRID_WIDTH = 1080;
const DESIGN_GRID_HEIGHT = 1350;
let screenCellSize; // cellSize converted to actual on-screen pixels, kept in sync by buildGridDimensions()

let cellSize = 6;
let cols, rows;
let grid, age, mask, core, boundary, halo;
let running = true;
let generation = 0;
let liveCount = 0;
let framesPerStep = 5; // 13 - speed(8), kept in sync with the speed slider default
let wrapEdges = false;
let currentText = "Natural/Computing";

let coreHold = 1.0;     // legibility(100): 0.5 + 1.0*0.5
let boundaryHold = 1.0; // legibility(100): 0.15 + 1.0*0.85
let edgeGrowth = 1.0;   // edge growth slider default (100)

let litchensActive = true; // litchens is the default/only display mode now
let litchensCanvasHolder = null;

let fillColor = [0, 0, 0]; // #000000, editable via the color/hex controls
let outlineColor = [233, 114, 189]; // #E972BD

// Perf: the fill+outline pass loops every live cell and issues its own
// rect()/line() draw calls — with a fine cellSize and high edge growth that
// can be hundreds of thousands of calls. The simulation itself only
// actually changes every `framesPerStep` frames, so re-running that full
// draw loop on every single animation frame (60fps) was mostly wasted work.
// Instead we render into an offscreen buffer only when something actually
// changed (a step happened, or the user touched a color/cell/text control),
// and just blit that cached image to the canvas the rest of the time.
let renderBuffer;
let needsRedraw = true;

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return [r, g, b];
}

function rgbToHex(rgb) {
  return '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');
}

function setup() {
  litchensCanvasHolder = document.getElementById('litchensHolder');
  const cnv = createCanvas(litchensCanvasHolder.clientWidth, litchensCanvasHolder.clientHeight);
  cnv.parent(litchensCanvasHolder);
  pixelDensity(1);
  noStroke();
  // Canvas 2D smooths images by default — without this, blitting renderBuffer
  // onto the main canvas each frame softens/blurs the crisp cell edges
  // (visible as fuzzy pixels instead of the sharp CA grid).
  drawingContext.imageSmoothingEnabled = false;
  renderBuffer = createGraphics(width, height);
  renderBuffer.pixelDensity(1);
  renderBuffer.drawingContext.imageSmoothingEnabled = false;
  buildGridDimensions();
  buildTextMask(currentText); // draw once immediately with the fallback font
  classifyZones();
  seedFromMask(1.0);
  wireControls();
  noLoop(); // draw() only advances while litchensActive, see below
  loop();

  // canvas text doesn't wait for a self-hosted @font-face to finish loading
  // on its own, so rebuild the mask once ABC Diatype Regular is actually ready
  if (document.fonts && document.fonts.load) {
    document.fonts.load('100px ' + DIATYPE_REGULAR).then(() => {
      buildTextMask(currentText);
      classifyZones();
      seedFromMask(1.0);
      needsRedraw = true;
    }).catch(() => { /* font failed to load; keep the fallback */ });
  }
}

function windowResized() {
  if (!litchensCanvasHolder) return;
  resizeCanvas(litchensCanvasHolder.clientWidth, litchensCanvasHolder.clientHeight);
  renderBuffer.resizeCanvas(width, height);
  // resizing a canvas resets its 2D context state, including smoothing
  drawingContext.imageSmoothingEnabled = false;
  renderBuffer.drawingContext.imageSmoothingEnabled = false;
  buildGridDimensions();
  buildTextMask(currentText);
  classifyZones();
  seedFromMask(1.0);
  needsRedraw = true;
}

// called by tilt-plane.html when the plate is resized/re-tilted layout changes
function litchensSyncSize() {
  windowResized();
}

function setLitchensActive(on) {
  litchensActive = on;
}

// called from tilt-plane.html when the texture is toggled, so the litchens
// fill/outline swap along with the texture-specific palette. Keeps the
// swatch pickers + hex fields in the control panel in sync too.
function setLitchensColors(fillHex, outlineHex) {
  fillColor = hexToRgb(fillHex);
  outlineColor = hexToRgb(outlineHex);
  const fillPicker = document.getElementById('fillColorPicker');
  const fillHexInput = document.getElementById('fillColorHex');
  const outlinePicker = document.getElementById('outlineColorPicker');
  const outlineHexInput = document.getElementById('outlineColorHex');
  if (fillPicker) fillPicker.value = fillHex;
  if (fillHexInput) fillHexInput.value = fillHex;
  if (outlinePicker) outlinePicker.value = outlineHex;
  if (outlineHexInput) outlineHexInput.value = outlineHex;
  needsRedraw = true;
}

function buildGridDimensions() {
  // cols/rows come from the design-space reference (1080x1350), not the
  // actual canvas pixel size, so the grid density stays constant across
  // screen sizes — see the comment on DESIGN_GRID_WIDTH above.
  cols = Math.max(1, Math.floor(DESIGN_GRID_WIDTH / cellSize));
  rows = Math.max(1, Math.floor(DESIGN_GRID_HEIGHT / cellSize));
  screenCellSize = cellSize * (width / DESIGN_GRID_WIDTH);
  grid = make2D(cols, rows, 0);
  age = make2D(cols, rows, 0);
}

function make2D(c, r, fillVal) {
  const arr = new Array(c);
  for (let i = 0; i < c; i++) arr[i] = new Array(r).fill(fillVal);
  return arr;
}

// Verified against the actual Figma source ("Instagram post - 15", node
// 225:56/225:57): 225px type (225.259/226.079px on the two lines), -6.77px
// tracking, positioned at x≈0, y=24 in a 1080×1350 frame, 40px gap between
// lines.
const DESIGN_FONT_SIZE = 226;
const DESIGN_TRACKING = -6.77;
// Figma's text boxes are trimmed to cap-height (text-box-trim: cap_alphabetic),
// measured at ~158px tall for ~225.5px type — about 70% of the full em size.
// Line-to-line advance should step by that cap-height + gap, not the full
// font size + gap, or the gap number never actually controls the spacing.
const CAP_HEIGHT_RATIO = 0.7;

// use "/" in the text input to break lines, e.g. "Natural/Computing"
function buildTextMask(txt) {
  mask = make2D(cols, rows, 0);
  if (width < 1 || height < 1) return;

  const lines = txt.split('/').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) lines.push('test');

  // Match the source design file: 1080×1350 canvas (the same 4:5 ratio
  // locked in by .plane's aspect-ratio), 2px top margin, 40px vertical gap
  // between lines. The litchens canvas renders at whatever on-screen pixel
  // size the plate actually is, so scale everything by how the canvas's
  // width compares to that 1080px reference instead of using fixed pixels.
  const DESIGN_LINE_GAP = 40;
  const DESIGN_MARGIN_TOP = 2; // was -4, nudged down 6px
  const scale = width / DESIGN_GRID_WIDTH;

  // draws the lines at the given size, anchored flush-left with the top
  // margin, matching the Figma frame.
  function drawLines(buf, size) {
    buf.textSize(size);
    buf.drawingContext.letterSpacing = (DESIGN_TRACKING * scale).toFixed(2) + 'px';
    const lineHeight = size * CAP_HEIGHT_RATIO + DESIGN_LINE_GAP * scale;
    let y = DESIGN_MARGIN_TOP * scale;
    for (const line of lines) {
      buf.text(line, 0, y);
      y += lineHeight;
    }
  }

  const pg = createGraphics(width, height);
  pg.pixelDensity(1);
  pg.background(0);
  pg.fill(255);
  pg.noStroke();
  pg.textAlign(LEFT, TOP);
  pg.textFont(FONT_STACK);
  pg.textStyle(NORMAL); // Regular weight is baked into the font file itself

  // DESIGN_FONT_SIZE is used as-is now — text can run past the canvas edges
  // at large sizes/long strings; anything off-canvas just doesn't get sampled
  // into the mask below, so it crops cleanly rather than causing errors.
  const size = DESIGN_FONT_SIZE * scale;
  drawLines(pg, size);
  pg.loadPixels();

  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const px = Math.floor((i + 0.5) * screenCellSize);
      const py = Math.floor((j + 0.5) * screenCellSize);
      if (px < width && py < height) {
        const idx = 4 * (py * width + px);
        mask[i][j] = pg.pixels[idx] > 120 ? 1 : 0;
      }
    }
  }
  pg.remove();
}

function classifyZones() {
  core = make2D(cols, rows, 0);
  boundary = make2D(cols, rows, 0);
  halo = make2D(cols, rows, 0);

  const maskNeighborCount = (x, y) => {
    let n = 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const xi = x + dx, yj = y + dy;
        if (xi < 0 || xi >= cols || yj < 0 || yj >= rows) continue;
        n += mask[xi][yj];
      }
    }
    return n;
  };

  const dilation1 = make2D(cols, rows, 0);
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      if (mask[i][j]) {
        const n = maskNeighborCount(i, j);
        if (n >= 6) core[i][j] = 1;
        else boundary[i][j] = 1;
      } else if (maskNeighborCount(i, j) >= 1) {
        dilation1[i][j] = 1;
        halo[i][j] = 1;
      }
    }
  }
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      if (mask[i][j] || halo[i][j]) continue;
      let n = 0;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const xi = i + dx, yj = j + dy;
          if (xi < 0 || xi >= cols || yj < 0 || yj >= rows) continue;
          if (dilation1[xi][yj]) n++;
        }
      }
      if (n >= 1) halo[i][j] = 1;
    }
  }
}

function seedFromMask(prob) {
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      if (mask[i][j] && Math.random() < prob) {
        grid[i][j] = 1;
        age[i][j] = 0;
      }
    }
  }
}

function countNeighbors(g, x, y) {
  let sum = 0;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      let xi = x + dx, yj = y + dy;
      if (wrapEdges) {
        xi = (xi + cols) % cols;
        yj = (yj + rows) % rows;
      } else {
        if (xi < 0 || xi >= cols || yj < 0 || yj >= rows) continue;
      }
      sum += g[xi][yj];
    }
  }
  return sum;
}

function step() {
  const next = make2D(cols, rows, 0);

  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const n = countNeighbors(grid, i, j);
      const alive = grid[i][j] === 1;

      let willLive = 0;
      if (alive && (n === 2 || n === 3)) willLive = 1;
      if (!alive && n === 3) willLive = 1;

      if (!willLive && halo[i][j] && !alive && n === 2) {
        if (Math.random() < edgeGrowth * 0.6) willLive = 1;
      }

      if (!willLive && core[i][j] && Math.random() < coreHold) willLive = 1;
      if (!willLive && boundary[i][j] && Math.random() < boundaryHold) willLive = 1;

      next[i][j] = willLive;
    }
  }

  liveCount = 0;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      if (next[i][j] === 1) {
        age[i][j] = grid[i][j] === 1 ? age[i][j] + 1 : 0;
        liveCount++;
      } else {
        age[i][j] = 0;
      }
    }
  }
  grid = next;
  generation++;
}

// Does the actual per-cell fill+outline rendering into the offscreen
// renderBuffer. Only called when needsRedraw is true (see draw()) — this is
// the expensive part (up to ~2 draw calls per live cell), so it should run
// only when the picture has actually changed, not on every animation frame.
function renderToBuffer() {
  renderBuffer.clear();
  const isLive = (i, j) => i >= 0 && i < cols && j >= 0 && j < rows && grid[i][j] === 1;

  // pass 1: fill. Only round a cell's corner where it's a true exterior
  // corner of the overall shape (both its edge-neighbors at that corner are
  // dead) — corners touching a live neighbor stay square, so adjacent cells
  // still butt flush with no gap.
  renderBuffer.noStroke();
  renderBuffer.fill(fillColor[0], fillColor[1], fillColor[2]);
  const cornerRadius = screenCellSize * 0.35;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      if (!isLive(i, j)) continue;
      const x = i * screenCellSize, y = j * screenCellSize;
      const left = isLive(i - 1, j), right = isLive(i + 1, j);
      const up = isLive(i, j - 1), down = isLive(i, j + 1);
      const tl = (!left && !up) ? cornerRadius : 0;
      const tr = (!right && !up) ? cornerRadius : 0;
      const br = (!right && !down) ? cornerRadius : 0;
      const bl = (!left && !down) ? cornerRadius : 0;
      renderBuffer.rect(x, y, screenCellSize, screenCellSize, tl, tr, br, bl);
    }
  }

  // pass 2, on top: a thin outline traced along the perimeter of the live
  // cellular-automaton pattern (only where a live cell borders a dead one),
  // so the shape reads as outlined without a heavy background band.
  renderBuffer.stroke(outlineColor[0], outlineColor[1], outlineColor[2]);
  renderBuffer.strokeWeight(2);
  renderBuffer.strokeCap(ROUND);
  renderBuffer.strokeJoin(ROUND);
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      if (!isLive(i, j)) continue;
      const x = i * screenCellSize, y = j * screenCellSize;
      if (!isLive(i, j - 1)) renderBuffer.line(x, y, x + screenCellSize, y);                             // top
      if (!isLive(i, j + 1)) renderBuffer.line(x, y + screenCellSize, x + screenCellSize, y + screenCellSize); // bottom
      if (!isLive(i - 1, j)) renderBuffer.line(x, y, x, y + screenCellSize);                             // left
      if (!isLive(i + 1, j)) renderBuffer.line(x + screenCellSize, y, x + screenCellSize, y + screenCellSize); // right
    }
  }
}

function draw() {
  clear(); // transparent so the metal texture shows through underneath

  if (!litchensActive) return;

  if (running && frameCount % framesPerStep === 0) {
    step();
    needsRedraw = true;
  }

  if (needsRedraw) {
    renderToBuffer();
    needsRedraw = false;
    const genEl = document.getElementById('genCount');
    const liveEl = document.getElementById('liveCount');
    if (genEl) genEl.innerText = generation;
    if (liveEl) liveEl.innerText = liveCount;
  }

  // cheap every-frame blit of the cached render, instead of redoing the
  // full per-cell draw-call loop 60 times a second
  image(renderBuffer, 0, 0);
}

function mouseDragged() { if (litchensActive) toggleAtMouse(); }
function mousePressed() { if (litchensActive) toggleAtMouse(); }
function toggleAtMouse() {
  if (mouseX < 0 || mouseX > width || mouseY < 0 || mouseY > height) return;
  const i = Math.floor(mouseX / screenCellSize);
  const j = Math.floor(mouseY / screenCellSize);
  if (i >= 0 && i < cols && j >= 0 && j < rows) {
    grid[i][j] = 1;
    age[i][j] = 0;
    needsRedraw = true;
  }
}

function wireControls() {
  document.getElementById('playPause').addEventListener('click', (e) => {
    running = !running;
    e.target.innerText = running ? 'Pause' : 'Play';
  });
  document.getElementById('reset').addEventListener('click', () => {
    grid = make2D(cols, rows, 0);
    age = make2D(cols, rows, 0);
    seedFromMask(1.0);
    generation = 0;
    needsRedraw = true;
  });
  document.getElementById('cellSize').addEventListener('input', (e) => {
    cellSize = parseInt(e.target.value);
    document.getElementById('cellSizeVal').textContent = cellSize;
    buildGridDimensions();
    buildTextMask(currentText);
    classifyZones();
    seedFromMask(1.0);
    generation = 0;
    needsRedraw = true;
  });
  document.getElementById('speed').addEventListener('input', (e) => {
    const v = parseInt(e.target.value);
    framesPerStep = 13 - v;
    document.getElementById('speedVal').textContent = v;
  });
  document.getElementById('legibility').addEventListener('input', (e) => {
    const raw = parseInt(e.target.value);
    const v = raw / 100;
    coreHold = 0.5 + v * 0.5;    // 0.5 .. 1.0
    boundaryHold = 0.15 + v * 0.85; // 0.15 .. 1.0
    document.getElementById('legibilityVal').textContent = raw;
  });
  document.getElementById('edgeGrowth').addEventListener('input', (e) => {
    const raw = parseInt(e.target.value);
    edgeGrowth = raw / 100;
    document.getElementById('edgeGrowthVal').textContent = raw;
  });

  // fill + outline color: swatch picker and hex text field kept in sync
  const fillPicker = document.getElementById('fillColorPicker');
  const fillHex = document.getElementById('fillColorHex');
  const outlinePicker = document.getElementById('outlineColorPicker');
  const outlineHex = document.getElementById('outlineColorHex');

  fillPicker.value = rgbToHex(fillColor);
  fillHex.value = rgbToHex(fillColor);
  outlinePicker.value = rgbToHex(outlineColor);
  outlineHex.value = rgbToHex(outlineColor);

  fillPicker.addEventListener('input', (e) => {
    fillColor = hexToRgb(e.target.value);
    fillHex.value = e.target.value;
    needsRedraw = true;
  });
  fillHex.addEventListener('change', (e) => {
    let v = e.target.value.trim();
    if (!v.startsWith('#')) v = '#' + v;
    if (/^#[0-9a-fA-F]{6}$/.test(v)) {
      fillColor = hexToRgb(v);
      fillPicker.value = v;
      fillHex.value = v;
      needsRedraw = true;
    } else {
      fillHex.value = rgbToHex(fillColor); // revert on bad input
    }
  });

  outlinePicker.addEventListener('input', (e) => {
    outlineColor = hexToRgb(e.target.value);
    outlineHex.value = e.target.value;
    needsRedraw = true;
  });
  outlineHex.addEventListener('change', (e) => {
    let v = e.target.value.trim();
    if (!v.startsWith('#')) v = '#' + v;
    if (/^#[0-9a-fA-F]{6}$/.test(v)) {
      outlineColor = hexToRgb(v);
      outlinePicker.value = v;
      outlineHex.value = v;
      needsRedraw = true;
    } else {
      outlineHex.value = rgbToHex(outlineColor); // revert on bad input
    }
  });

  framesPerStep = 13 - parseInt(document.getElementById('speed').value);
}
