// bg.js — fondo animado (red de nodos tipo circuito, con pulsos de "energía")
// + tilt 3D reutilizable. Lee los colores del tema activo (claro/oscuro) desde
// las variables CSS, así cambia solo cuando se cambia de tema.

const canvas = document.getElementById('bg-canvas');
const ctx = canvas.getContext('2d');

let w = 0, h = 0, nodos = [];
const DIST_MAX = 150;
const pulsos = [];
const prefiereMenosMovimiento =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function colorTema(variable, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
    return v || fallback;
}

function hexARgb(hex) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function crearNodos() {
    const n = Math.max(18, Math.min(90, Math.floor((w * h) / 42000)));
    nodos = [];
    for (let i = 0; i < n; i++) {
        nodos.push({
            x: Math.random() * w, y: Math.random() * h,
            vx: (Math.random() - 0.5) * 0.18, vy: (Math.random() - 0.5) * 0.18,
            r: Math.random() * 1.4 + 1.1,
        });
    }
}

function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
    crearNodos();
}
window.addEventListener('resize', resize);
resize();

function tick() {
    const rgbNodo = hexARgb(colorTema('--accent', '#00B4D8'));
    const rgbPulso = hexARgb(colorTema('--accent2', '#F97316'));

    ctx.clearRect(0, 0, w, h);

    for (const n of nodos) {
        n.x += n.vx; n.y += n.vy;
        if (n.x < 0 || n.x > w) n.vx *= -1;
        if (n.y < 0 || n.y > h) n.vy *= -1;
    }

    ctx.lineWidth = 1;
    for (let i = 0; i < nodos.length; i++) {
        for (let j = i + 1; j < nodos.length; j++) {
            const a = nodos[i], b = nodos[j];
            const dx = a.x - b.x, dy = a.y - b.y;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < DIST_MAX) {
                const op = (1 - d / DIST_MAX) * 0.28;
                ctx.strokeStyle = `rgba(${rgbNodo.r},${rgbNodo.g},${rgbNodo.b},${op})`;
                ctx.beginPath();
                ctx.moveTo(a.x, a.y);
                ctx.lineTo(b.x, b.y);
                ctx.stroke();
                if (!prefiereMenosMovimiento && Math.random() < 0.0006) {
                    pulsos.push({ a, b, t: 0 });
                }
            }
        }
    }

    for (const n of nodos) {
        ctx.beginPath();
        ctx.fillStyle = `rgba(${rgbNodo.r},${rgbNodo.g},${rgbNodo.b},0.6)`;
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fill();
    }

    for (let i = pulsos.length - 1; i >= 0; i--) {
        const p = pulsos[i];
        p.t += 0.018;
        if (p.t >= 1) { pulsos.splice(i, 1); continue; }
        const x = p.a.x + (p.b.x - p.a.x) * p.t;
        const y = p.a.y + (p.b.y - p.a.y) * p.t;
        ctx.beginPath();
        ctx.fillStyle = `rgb(${rgbPulso.r},${rgbPulso.g},${rgbPulso.b})`;
        ctx.shadowColor = `rgb(${rgbPulso.r},${rgbPulso.g},${rgbPulso.b})`;
        ctx.shadowBlur = 9;
        ctx.arc(x, y, 2.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
    }

    requestAnimationFrame(tick);
}
tick();

// --- Tilt 3D reutilizable ---
export function aplicarTilt(el, intensidad = 7) {
    if (prefiereMenosMovimiento) return;
    el.addEventListener('mousemove', (e) => {
        const r = el.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - 0.5;
        const py = (e.clientY - r.top) / r.height - 0.5;
        el.style.transform =
            `perspective(900px) rotateY(${(px * intensidad).toFixed(2)}deg) ` +
            `rotateX(${(-py * intensidad).toFixed(2)}deg) translateZ(4px)`;
    });
    el.addEventListener('mouseleave', () => {
        el.style.transform = 'perspective(900px) rotateY(0) rotateX(0) translateZ(0)';
    });
}

document.querySelectorAll('[data-tilt]').forEach((el) => aplicarTilt(el, 6));
document.querySelectorAll('[data-tilt-suave]').forEach((el) => aplicarTilt(el, 1.5));
