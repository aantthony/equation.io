/**
 * The hero backdrop: the gallery's orbiting-charge scene, ln(w - r) - ln(w + r)
 * with r = 2 + sin(t), drawn on a 2D canvas. Its level sets are exact circles
 * (bipolar coordinates), so the page draws them directly instead of booting
 * the GPU renderer: equipotentials |w - r| / |w + r| = k are Apollonian
 * circles, streamlines arg((w - r)/(w + r)) = θ are circles through ±r.
 */

/** Units across the canvas's short edge — the app's opening view. */
const SPAN = 12;
/** Level spacing: ln k steps for equipotentials, π/N for streamlines. */
const LN_K_STEP = 0.32;
const LN_K_LEVELS = 12;
const STREAMLINES = 14;

const FIELD = '222, 128, 88';
const FONT = "11px 'JetBrains Mono Variable', ui-monospace, Menlo, monospace";

export function startHeroField(opts: {
  canvas: HTMLCanvasElement;
  clock: HTMLElement;
  typed: HTMLElement;
  rows: string[];
}): void {
  const { canvas, clock, typed, rows } = opts;
  const ctx = canvas.getContext('2d')!;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let w = 0;
  let h = 0;
  let dpr = 1;
  const resize = () => {
    dpr = Math.min(devicePixelRatio || 1, 2);
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    if (!running) draw();
  };

  // Typing: each row gets a dot, a text node and (while typing) a caret.
  const lines = rows.map((eq, i) => {
    const row = document.createElement('span');
    row.className = 'row';
    row.style.setProperty('--i', String(i));
    const dot = document.createElement('i');
    const text = document.createElement('span');
    row.append(dot, text);
    typed.append(row);
    return { row, text, eq };
  });
  const caret = document.createElement('b');
  caret.className = 'caret';

  let reveal = 0; // 0 → 1 once the last row is typed
  let revealStart = -1;
  let t0 = performance.now();
  let t = 1.234;

  if (still) {
    for (const l of lines) {
      l.text.textContent = l.eq;
      l.row.classList.add('done');
    }
    reveal = 1;
  } else {
    let delay = 900;
    lines.forEach((l, i) => {
      for (let n = 1; n <= l.eq.length; n++) {
        setTimeout(() => {
          l.text.textContent = l.eq.slice(0, n);
          l.row.append(caret);
          if (n === l.eq.length) {
            l.row.classList.add('done');
            if (i === lines.length - 1) {
              revealStart = performance.now();
              setTimeout(() => caret.remove(), 2400);
            }
          }
        }, delay);
        // Spaces and operators go down quicker, like real typing.
        delay += /[\s()]/.test(l.eq[n - 1]!) ? 35 : 55 + ((n * 37) % 40);
      }
      delay += 380;
    });
  }

  function draw() {
    if (!w || !h) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const s = Math.min(w, h) / SPAN;
    const ox = w / 2;
    const oy = h / 2;
    const X = (x: number) => ox + x * s;
    const Y = (y: number) => oy - y * s;
    const x0 = -ox / s;
    const x1 = ox / s;
    const y0 = -oy / s;
    const y1 = oy / s;

    // Grid: fifths, then units, then the axes.
    ctx.lineWidth = 1;
    for (const [step, alpha] of [
      [0.2, 0.045],
      [1, 0.1],
    ] as const) {
      ctx.strokeStyle = `rgba(150, 170, 210, ${alpha})`;
      ctx.beginPath();
      for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) {
        const px = Math.round(X(x)) + 0.5;
        ctx.moveTo(px, 0);
        ctx.lineTo(px, h);
      }
      for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) {
        const py = Math.round(Y(y)) + 0.5;
        ctx.moveTo(0, py);
        ctx.lineTo(w, py);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = `rgba(${FIELD}, 0.32)`;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(Y(0)) + 0.5);
    ctx.lineTo(w, Math.round(Y(0)) + 0.5);
    ctx.moveTo(Math.round(X(0)) + 0.5, 0);
    ctx.lineTo(Math.round(X(0)) + 0.5, h);
    ctx.stroke();

    ctx.font = FONT;
    ctx.fillStyle = 'rgba(170, 180, 200, 0.32)';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    for (let x = Math.ceil(x0); x <= x1; x++) if (x) ctx.fillText(String(x), X(x), Y(0) + 6);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let y = Math.ceil(y0); y <= y1; y++) if (y) ctx.fillText(String(y), X(0) + 6, Y(y));

    if (reveal <= 0) return;
    const r = 2 + Math.sin(t);
    const R = Math.hypot(x1, y1) * 3;
    ctx.lineWidth = 1.15;

    // Equipotentials: k = e^(±n·step), both sides mirror through the y-axis.
    for (let n = 1; n <= LN_K_LEVELS; n++) {
      const k = Math.exp(n * LN_K_STEP);
      const cx = (r * (1 + k * k)) / (k * k - 1);
      const rad = (2 * r * k) / (k * k - 1);
      const a = reveal * (0.62 - n * 0.025);
      ctx.strokeStyle = `rgba(${FIELD}, ${a})`;
      ctx.beginPath();
      ctx.arc(X(cx), Y(0), rad * s, 0, Math.PI * 2);
      ctx.moveTo(X(-cx) + rad * s, Y(0));
      ctx.arc(X(-cx), Y(0), rad * s, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Streamlines: circles through ±r, centered on the y-axis.
    ctx.strokeStyle = `rgba(${FIELD}, ${reveal * 0.5})`;
    ctx.beginPath();
    for (let n = 1; n < STREAMLINES; n++) {
      const th = (n * Math.PI) / STREAMLINES;
      const cy = r / Math.tan(th);
      const rad = r / Math.sin(th);
      if (rad > R) continue;
      ctx.moveTo(X(0) + rad * s, Y(cy));
      ctx.arc(X(0), Y(cy), rad * s, 0, Math.PI * 2);
    }
    ctx.stroke();

    // The two charges.
    for (const cx of [r, -r]) {
      const g = ctx.createRadialGradient(X(cx), Y(0), 0, X(cx), Y(0), 18);
      g.addColorStop(0, `rgba(255, 190, 120, ${0.9 * reveal})`);
      g.addColorStop(1, 'rgba(255, 190, 120, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(X(cx) - 18, Y(0) - 18, 36, 36);
    }
  }

  let running = false;
  let visible = true;
  const frame = (now: number) => {
    if (!visible) {
      running = false;
      return;
    }
    t = (now - t0) / 1000;
    if (revealStart >= 0) reveal = Math.min(1, (now - revealStart) / 900);
    clock.textContent = t.toFixed(3);
    draw();
    requestAnimationFrame(frame);
  };
  const start = () => {
    if (running || still) return;
    running = true;
    requestAnimationFrame(frame);
  };

  new ResizeObserver(resize).observe(canvas);
  new IntersectionObserver(([e]) => {
    visible = e!.isIntersecting;
    if (visible) start();
  }).observe(canvas);

  if (still) {
    clock.textContent = t.toFixed(3);
    // Redraw once the mono face arrives so the axis labels match the page.
    void document.fonts.ready.then(draw);
  } else {
    t0 = performance.now();
    start();
  }
}
