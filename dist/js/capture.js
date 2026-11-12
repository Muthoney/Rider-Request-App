// Proof of collection / delivery: a camera photo (downscaled to a JPEG on the phone before upload)
// and an on-screen D-note (delivery note) signature pad.
import { html, ic, toast } from './ui.js';

const MAX_SIDE = 1600;
const QUALITY = 0.78;

export function photoField({ label, required = false, hint = 'Use the camera, or choose a photo' }) {
  return html`
    <div class="field proof" data-photo>
      <span class="label">${ic('camera', 'sm')} ${label} ${required ? html`<span class="req">Required</span>` : html`<span class="muted">(optional)</span>`}</span>
      <label class="photo-drop">
        <input type="file" accept="image/*" capture="environment" data-photo-input aria-label="${label}">
        <span class="ph-empty">${ic('camera', 'lg')}<b>Take a photo</b><small>${hint}</small></span>
        <img alt="Photo preview" hidden data-photo-preview>
      </label>
      <div class="row" data-photo-actions hidden>
        <span class="coord-ok">${ic('check', 'sm')} Photo added</span><span class="grow"></span>
        <button type="button" class="btn sm ghost" data-photo-retake>${ic('camera', 'sm')} Retake</button>
      </div>
    </div>`;
}

/** Wires a photoField inside `root`. Returns { value } (a JPEG data URL or null). */
export function wirePhoto(root) {
  const box = root.querySelector('[data-photo]');
  const input = box.querySelector('[data-photo-input]');
  const img = box.querySelector('[data-photo-preview]');
  const emptyEl = box.querySelector('.ph-empty');
  const actions = box.querySelector('[data-photo-actions]');
  let value = null;
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    box.classList.add('busy');
    try {
      value = await downscale(file);
      img.src = value; img.hidden = false; emptyEl.hidden = true; actions.hidden = false;
      box.classList.remove('invalid');
    } catch {
      toast('That photo could not be read. Try taking it again.', 'err');
    } finally { box.classList.remove('busy'); }
  });
  box.querySelector('[data-photo-retake]').addEventListener('click', () => input.click());
  return {
    get value() { return value; },
    flag() { box.classList.add('invalid'); box.scrollIntoView({ block: 'center', behavior: 'smooth' }); },
  };
}

export async function downscale(file) {
  let source;
  try { source = await createImageBitmap(file); } catch { source = await loadImage(file); }
  const w0 = source.width, h0 = source.height;
  if (!w0 || !h0) throw new Error('empty image');
  const scale = Math.min(1, MAX_SIDE / Math.max(w0, h0));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w0 * scale);
  canvas.height = Math.round(h0 * scale);
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close?.();
  return canvas.toDataURL('image/jpeg', QUALITY);
}
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable')); };
    im.src = url;
  });
}

export function signatureField({ label = 'D-note signature', required = false, hint = '' }) {
  return html`
    <div class="field proof" data-sign>
      <span class="label">${ic('pen', 'sm')} ${label} ${required ? html`<span class="req">Required</span>` : html`<span class="muted">(optional)</span>`}</span>
      <div class="sign-pad">
        <canvas role="img" aria-label="Signature pad. Sign with a finger, stylus or mouse."></canvas>
        <span class="sign-x" aria-hidden="true">✕</span>
        <span class="sign-line" aria-hidden="true">Sign above the line</span>
        <button type="button" class="btn sm ghost sign-clear" data-sign-clear>${ic('refresh', 'sm')} Clear</button>
      </div>
      ${hint ? html`<span class="hint">${hint}</span>` : ''}
    </div>`;
}

/** Wires a signatureField inside `root`. Returns { empty, dataUrl(), flag() }. */
export function wireSignature(root) {
  const box = root.querySelector('[data-sign]');
  const canvas = box.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const strokes = [];
  let current = null;
  let ratio = 1;

  const paint = () => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.strokeStyle = '#0f1424';
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of strokes) {
      ctx.beginPath();
      s.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      if (s.length === 1) ctx.lineTo(s[0].x + 0.1, s[0].y + 0.1);
      ctx.stroke();
    }
  };
  const resize = () => {
    ratio = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const r = canvas.getBoundingClientRect();
    if (!r.width) return;
    canvas.width = Math.round(r.width * ratio);
    canvas.height = Math.round(r.height * ratio);
    paint();
  };
  const point = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    current = [point(e)];
    strokes.push(current);
    box.classList.add('signed'); box.classList.remove('invalid');
    paint();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!current) return;
    for (const ev of e.getCoalescedEvents?.() || [e]) current.push(point(ev));
    paint();
  });
  const end = () => { current = null; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  box.querySelector('[data-sign-clear]').addEventListener('click', () => { strokes.length = 0; box.classList.remove('signed'); paint(); });
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();
  return {
    get empty() { return !strokes.some((s) => s.length > 0); },
    dataUrl() { return strokes.length ? canvas.toDataURL('image/png') : null; },
    flag() { box.classList.add('invalid'); box.scrollIntoView({ block: 'center', behavior: 'smooth' }); },
  };
}
