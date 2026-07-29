// app.js — Centro de Mando JC
// La librería de Supabase se sirve DESDE ESTE MISMO SITIO (vendor-supabase.js),
// no desde esm.sh -- algunas redes/antivirus bloquean CDNs externos como
// esm.sh y eso dejaba el login "cargando" para siempre sin ningún error
// visible. Sirviéndola local, solo depende de que GitHub Pages cargue (que
// ya sabemos que sí) y de tu propio proyecto de Supabase.
import { createClient } from './vendor-supabase.js';
import { aplicarTilt } from './bg.js';

const { url, anonKey } = window.SUPABASE_CONFIG;
const supabase = createClient(url, anonKey);

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ------------------------------------------------------------------- TEMA
function aplicarTema(tema) {
    document.documentElement.dataset.theme = tema;
    localStorage.setItem('cmjc_tema', tema);
}
(function initTema() {
    const guardado = localStorage.getItem('cmjc_tema');
    const preferido = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    aplicarTema(guardado || preferido);
})();
function alternarTema() {
    aplicarTema(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
}
$('#btn-tema')?.addEventListener('click', alternarTema);
$('#btn-tema-login')?.addEventListener('click', alternarTema);

// ------------------------------------------------------------------- estado
const vistaLogin = $('#vista-login');
const vistaDash = $('#vista-dashboard');
const formLogin = $('#form-login');
const loginError = $('#login-error');
const btnLogin = $('#btn-login');
const loginCard = $('#login-card');

let apps = [];
let usuarios = [];
let accesos = [];
let logs = [];
let documentos = [];
let soporte = [];
let conversaciones = [];
let conversacionActivaId = null;

// ------------------------------------------------------------------ utilidades
function toast(msg, tipo = 'ok') {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast ${tipo} mostrar`;
    clearTimeout(toast._h);
    toast._h = setTimeout(() => t.classList.remove('mostrar'), 3200);
}
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function nombreApp(slug) {
    const a = apps.find((x) => x.slug === slug);
    return a ? a.nombre : slug;
}
function fechaCorta(iso) {
    return new Date(iso).toLocaleDateString('es-CO');
}

async function registrarLog(exito, appSlug = 'panel_admin', correo = '') {
    try { await supabase.rpc('rpc_registrar_login', { p_correo: correo, p_app: appSlug, p_exito: exito }); }
    catch { /* no bloquea la UI si falla el registro */ }
}

// ------------------------------------------------------------------ sesión
async function intentarSesion() {
    const { data: { session } } = await supabase.auth.getSession();
    if (session && await esAdmin()) { mostrarDashboard(session); return; }
    if (session) await supabase.auth.signOut();
    mostrarLogin();
}
async function esAdmin() {
    const { data, error } = await supabase.rpc('rpc_soy_admin');
    return !error && data === true;
}
function mostrarLogin() { vistaDash.classList.add('oculto'); vistaLogin.classList.remove('oculto'); }
async function mostrarDashboard(session) {
    vistaLogin.classList.add('oculto');
    vistaDash.classList.remove('oculto');
    $('#admin-email').textContent = session.user.email;
    await cargarTodo();
    activarSeccion('panel');
}

formLogin.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.textContent = '';
    btnLogin.disabled = true; btnLogin.classList.add('cargando');

    const email = $('#login-email').value.trim();
    const password = $('#login-pass').value;
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
        await registrarLog(false, 'panel_admin', email);
        btnLogin.disabled = false; btnLogin.classList.remove('cargando');
        mostrarErrorLogin('Correo o contraseña incorrectos.');
        return;
    }
    if (!await esAdmin()) {
        await supabase.auth.signOut();
        await registrarLog(false, 'panel_admin', email);
        btnLogin.disabled = false; btnLogin.classList.remove('cargando');
        mostrarErrorLogin('Esta cuenta no tiene permisos de administrador.');
        return;
    }
    await registrarLog(true, 'panel_admin', email);
    btnLogin.disabled = false; btnLogin.classList.remove('cargando');
    formLogin.reset();
    mostrarDashboard(data.session);
});
function mostrarErrorLogin(msg) {
    loginError.textContent = msg;
    loginCard.classList.remove('shake'); void loginCard.offsetWidth; loginCard.classList.add('shake');
}
$('#btn-logout').addEventListener('click', async () => { await supabase.auth.signOut(); mostrarLogin(); });

// ------------------------------------------------------------------ navegación
$$('.nav-item, .link-btn').forEach((btn) => {
    btn.addEventListener('click', () => activarSeccion(btn.dataset.vista));
});
const TITULOS = {
    panel: ['Panel', 'Vista general de la suite'],
    usuarios: ['Usuarios', 'Gestión de identidades y accesos'],
    cerebro: ['Cerebro', 'Asistente sobre tus documentos, con memoria'],
    documentos: ['Documentos', 'Fuentes que lee el cerebro'],
    soporte: ['Soporte', 'Mensajes de ayuda enviados desde las apps'],
    logs: ['Seguridad', 'Actividad y eventos de todas las apps'],
};
function activarSeccion(nombre) {
    $$('.seccion-vista').forEach((s) => s.classList.add('oculto'));
    $(`#seccion-${nombre}`)?.classList.remove('oculto');
    $$('.nav-item').forEach((b) => b.classList.toggle('activo', b.dataset.vista === nombre));
    const [t, s] = TITULOS[nombre] || ['', ''];
    $('#titulo-vista').textContent = t;
    $('#subtitulo-vista').textContent = s;
    if (nombre === 'cerebro') cargarConversaciones();
    if (nombre === 'logs') renderTablaLogsCompleta();
    if (nombre === 'soporte') renderTablaSoporte();
}

// ------------------------------------------------------------------ carga de datos
async function cargarTodo() {
    const [{ data: a }, { data: u }, { data: ac }, { data: lg }, { data: docs }, { data: sop }] = await Promise.all([
        supabase.from('apps').select('slug,nombre').order('nombre'),
        supabase.from('usuarios').select('correo,bloqueado,creado').order('creado', { ascending: false }),
        supabase.from('accesos').select('correo,app,creado,expira'),
        supabase.from('logs_seguridad').select('*').order('creado', { ascending: false }).limit(200),
        supabase.from('documentos').select('id,titulo,categoria,storage_path,creado').order('creado', { ascending: false }),
        supabase.from('mensajes_soporte').select('*').order('creado', { ascending: false }),
    ]);
    apps = a || []; usuarios = u || []; accesos = ac || []; logs = lg || []; documentos = docs || [];
    soporte = sop || [];

    renderStats();
    renderGraficaCrecimiento();
    renderGraficaApps();
    renderTablaLogsMini();
    renderTabla($('#buscar').value);
    poblarSelectApps();
    renderTablaDocumentos();
    renderBadgeSoporte();
}

// ------------------------------------------------------------------ stats
function renderStats() {
    const bloqueados = usuarios.filter((u) => u.bloqueado).length;
    const inicioMes = new Date(); inicioMes.setDate(1); inicioMes.setHours(0, 0, 0, 0);
    const nuevosMes = usuarios.filter((u) => new Date(u.creado) >= inicioMes).length;
    const hace7d = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const alertas = logs.filter((l) => l.tipo === 'login_fallido' && new Date(l.creado).getTime() >= hace7d).length + bloqueados;

    const sinResponder = soporte.filter((s) => s.estado === 'abierto').length;
    const items = [
        { icono: '👤', valor: usuarios.length, label: 'Total usuarios' },
        { icono: '🧩', valor: apps.length, label: 'Aplicaciones activas' },
        { icono: '✨', valor: nuevosMes, label: 'Nuevos este mes' },
        { icono: '⚠️', valor: alertas, label: 'Alertas de seguridad' },
        { icono: '✉️', valor: sinResponder, label: 'Mensajes sin responder' },
    ];
    const cont = $('#stats');
    cont.innerHTML = '';
    items.forEach((it, i) => {
        const div = document.createElement('div');
        div.className = 'stat-card';
        div.style.animationDelay = `${i * 60}ms`;
        div.innerHTML = `<span class="stat-icono">${it.icono}</span>
            <span class="stat-valor">${it.valor}</span>
            <span class="stat-label">${it.label}</span>`;
        cont.appendChild(div);
        aplicarTilt(div, 4);
    });
}

// ------------------------------------------------------------------ gráficas
// Sigue el flujo del skill de dataviz: forma -> color por rol -> paleta ya
// validada (ver style.css, --s1..--s8) -> marcas finas con extremos
// redondeados -> etiquetas directas donde el contraste lo pide -> SVG simple.
function renderGraficaCrecimiento() {
    const cont = $('#grafica-crecimiento');
    if (!usuarios.length) { cont.innerHTML = '<p class="grafica-vacia">Todavía no hay usuarios registrados.</p>'; return; }

    const meses = [];
    const hoy = new Date();
    for (let i = 5; i >= 0; i--) {
        const d = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
        meses.push({ etiqueta: d.toLocaleDateString('es-CO', { month: 'short' }), corte: new Date(d.getFullYear(), d.getMonth() + 1, 1) });
    }
    const acumulado = meses.map((m) => usuarios.filter((u) => new Date(u.creado) < m.corte).length);

    const W = 560, H = 200, PAD = 30;
    const max = Math.max(...acumulado, 1);
    const pasoX = (W - PAD * 2) / (meses.length - 1 || 1);
    const puntos = acumulado.map((v, i) => {
        const x = PAD + i * pasoX;
        const y = H - PAD - (v / max) * (H - PAD * 2 - 16);
        return { x, y, v };
    });
    const linea = puntos.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    const area = `${linea} L ${puntos[puntos.length - 1].x.toFixed(1)} ${H - PAD} L ${puntos[0].x.toFixed(1)} ${H - PAD} Z`;

    const ejeY = H - PAD;
    const etiquetasX = meses.map((m, i) =>
        `<text class="grafica-eje-texto" x="${(PAD + i * pasoX).toFixed(1)}" y="${H - 8}" text-anchor="middle">${m.etiqueta}</text>`
    ).join('');
    const puntosSvg = puntos.map((p) =>
        `<circle class="grafica-linea-punto" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5"></circle>`
    ).join('');
    const ultimo = puntos[puntos.length - 1];

    cont.innerHTML = `
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
            <line class="grafica-eje" x1="${PAD}" y1="${ejeY}" x2="${W - PAD}" y2="${ejeY}"></line>
            <path class="grafica-linea-area" d="${area}" fill="var(--s1)"></path>
            <path class="grafica-linea-trazo" d="${linea}"></path>
            ${puntosSvg}
            <text class="grafica-linea-etiqueta" x="${ultimo.x.toFixed(1)}" y="${(ultimo.y - 10).toFixed(1)}" text-anchor="middle">${ultimo.v}</text>
            ${etiquetasX}
        </svg>`;
}

function renderGraficaApps() {
    const cont = $('#grafica-apps');
    if (!apps.length) { cont.innerHTML = '<p class="grafica-vacia">Todavía no hay aplicaciones registradas.</p>'; return; }

    const ahora = Date.now();
    const conteos = apps.map((a) => ({
        app: a,
        n: accesos.filter((ac) => ac.app === a.slug && (!ac.expira || new Date(ac.expira).getTime() > ahora)).length,
    }));

    const W = 560, H = 200, PAD = 30;
    const max = Math.max(...conteos.map((c) => c.n), 1);
    const anchoBarra = Math.min(52, (W - PAD * 2) / conteos.length - 16);
    const paso = (W - PAD * 2) / conteos.length;
    const paleta = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];

    const barras = conteos.map((c, i) => {
        const alto = (c.n / max) * (H - PAD * 2 - 20);
        const x = PAD + i * paso + (paso - anchoBarra) / 2;
        const y = H - PAD - alto;
        const color = paleta[i % paleta.length];
        const catCorta = c.app.nombre.length > 10 ? c.app.nombre.slice(0, 9) + '…' : c.app.nombre;
        return `
            <rect class="grafica-barra" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${anchoBarra.toFixed(1)}"
                  height="${Math.max(alto, 1).toFixed(1)}" rx="4" fill="${color}">
                <title>${escapeHtml(c.app.nombre)}: ${c.n}</title>
            </rect>
            <text class="grafica-barra-valor" x="${(x + anchoBarra / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}">${c.n}</text>
            <text class="grafica-barra-cat" x="${(x + anchoBarra / 2).toFixed(1)}" y="${H - 8}">${escapeHtml(catCorta)}</text>`;
    }).join('');

    cont.innerHTML = `
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
            <line class="grafica-eje" x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}"></line>
            ${barras}
        </svg>`;
}

// ------------------------------------------------------------------ logs
function filaLog(l) {
    return `<tr>
        <td><span class="tipo-tag tipo-${l.tipo}">${etiquetaTipo(l.tipo)}</span></td>
        <td>${escapeHtml(l.correo || '—')}</td>
        <td>${escapeHtml(l.app ? nombreApp(l.app) : '—')}</td>
        ${l._detalle !== undefined ? `<td>${escapeHtml(l.detalle || '—')}</td>` : ''}
        <td class="col-fecha">${new Date(l.creado).toLocaleString('es-CO')}</td>
    </tr>`;
}
function etiquetaTipo(t) {
    return { login_ok: 'Login OK', login_fallido: 'Login fallido', bloqueo: 'Bloqueo', desbloqueo: 'Desbloqueo',
        borrado: 'Borrado', acceso_otorgado: 'Acceso otorgado', acceso_revocado: 'Acceso revocado' }[t] || t;
}
function renderTablaLogsMini() {
    $('#tbody-logs-mini').innerHTML = logs.slice(0, 8).map((l) => filaLog(l)).join('') ||
        '<tr><td colspan="4" class="tabla-vacia">Sin eventos todavía.</td></tr>';
}
function renderTablaLogsCompleta() {
    const filtro = $('#filtro-logs').value;
    const filas = filtro ? logs.filter((l) => l.tipo === filtro) : logs;
    $('#logs-vacio').classList.toggle('oculto', filas.length > 0);
    $('#tbody-logs').innerHTML = filas.map((l) => filaLog({ ...l, _detalle: true })).join('');
}
$('#filtro-logs').addEventListener('change', renderTablaLogsCompleta);

// ------------------------------------------------------------------ usuarios
function renderTabla(filtro = '') {
    const tbody = $('#tbody-usuarios');
    tbody.innerHTML = '';
    const f = filtro.trim().toLowerCase();
    const filas = usuarios.filter((u) => !f || u.correo.includes(f));
    $('#tabla-vacia').classList.toggle('oculto', filas.length > 0);
    const ahora = Date.now();

    filas.forEach((u, i) => {
        const misAccesos = accesos.filter((a) => a.correo === u.correo);
        const tr = document.createElement('tr');
        tr.style.animationDelay = `${Math.min(i, 12) * 30}ms`;
        tr.innerHTML = `
            <td class="col-correo">${escapeHtml(u.correo)}</td>
            <td class="chips">${
                misAccesos.map((a) => {
                    const vencido = a.expira && new Date(a.expira).getTime() < ahora;
                    const claseVence = vencido ? 'chip chip-vence' : 'chip';
                    const textoVence = a.expira ? ` · vence ${fechaCorta(a.expira)}` : '';
                    return `<span class="${claseVence}">${escapeHtml(nombreApp(a.app))}${textoVence}
                        <button class="chip-editar" data-editar-vig="${u.correo}|${a.app}" title="Editar vigencia">✎</button>
                        <button class="chip-x" data-revocar="${u.correo}|${a.app}" title="Revocar acceso">×</button>
                    </span>`;
                }).join('') || '<span class="chip chip-vacio">sin accesos</span>'
            }</td>
            <td class="col-fecha">${fechaCorta(u.creado)}</td>
            <td class="col-estado">
                <label class="switch" title="${u.bloqueado ? 'Desbloquear' : 'Bloquear'}">
                    <input type="checkbox" data-toggle="${u.correo}" ${u.bloqueado ? '' : 'checked'}>
                    <span class="slider"></span>
                </label>
                <span class="estado-txt ${u.bloqueado ? 'estado-bloqueado' : 'estado-activo'}">${u.bloqueado ? 'Bloqueado' : 'Activo'}</span>
            </td>
            <td class="col-borrar"><button class="btn-icono" data-borrar="${u.correo}" title="Borrar usuario">🗑</button></td>
        `;
        tbody.appendChild(tr);
    });
}
$('#buscar').addEventListener('input', (e) => renderTabla(e.target.value));

$('#tbody-usuarios').addEventListener('click', async (e) => {
    const borrar = e.target.closest('[data-borrar]');
    if (borrar) {
        const correo = borrar.dataset.borrar;
        if (!confirm(`¿Borrar a "${correo}"? Pierde el acceso a TODAS las apps de la suite.`)) return;
        const { error } = await supabase.from('usuarios').delete().eq('correo', correo);
        if (error) { toast('No se pudo borrar: ' + error.message, 'error'); return; }
        await supabase.from('logs_seguridad').insert({ tipo: 'borrado', correo });
        toast(`Usuario "${correo}" borrado.`);
        await cargarTodo();
        return;
    }
    const revocar = e.target.closest('[data-revocar]');
    if (revocar) {
        const [correo, app] = revocar.dataset.revocar.split('|');
        if (!confirm(`¿Revocar el acceso de "${correo}" a "${nombreApp(app)}"?`)) return;
        const { error } = await supabase.from('accesos').delete().eq('correo', correo).eq('app', app);
        if (error) { toast('No se pudo revocar: ' + error.message, 'error'); return; }
        await supabase.from('logs_seguridad').insert({ tipo: 'acceso_revocado', correo, app });
        toast('Acceso revocado.');
        await cargarTodo();
        return;
    }
    const editarVig = e.target.closest('[data-editar-vig]');
    if (editarVig) abrirModalVigencia(...editarVig.dataset.editarVig.split('|'));
});

$('#tbody-usuarios').addEventListener('change', async (e) => {
    const toggle = e.target.closest('[data-toggle]');
    if (!toggle) return;
    const correo = toggle.dataset.toggle;
    const bloqueado = !toggle.checked;
    const { error } = await supabase.from('usuarios').update({ bloqueado }).eq('correo', correo);
    if (error) { toast('No se pudo actualizar: ' + error.message, 'error'); toggle.checked = !toggle.checked; return; }
    await supabase.from('logs_seguridad').insert({ tipo: bloqueado ? 'bloqueo' : 'desbloqueo', correo });
    toast(bloqueado ? `"${correo}" bloqueado.` : `"${correo}" desbloqueado.`);
    await cargarTodo();
});

// -------------------------------------------------------------- otorgar acceso
function poblarSelectApps() { $('#ot-app').innerHTML = apps.map((a) => `<option value="${a.slug}">${a.nombre}</option>`).join(''); }

$('#btn-otorgar').addEventListener('click', () => {
    $('#ot-correo').value = ''; $('#ot-vigencia').value = ''; $('#ot-msg').textContent = '';
    $('#modal-otorgar').classList.remove('oculto');
});
$('#ot-cancelar').addEventListener('click', () => $('#modal-otorgar').classList.add('oculto'));
$('#modal-otorgar').addEventListener('click', (e) => { if (e.target.id === 'modal-otorgar') $('#modal-otorgar').classList.add('oculto'); });

function fechaMasMeses(meses) {
    const d = new Date();
    d.setMonth(d.getMonth() + Number(meses));
    return d.toISOString();
}

$('#ot-confirmar').addEventListener('click', async () => {
    const correo = $('#ot-correo').value.trim().toLowerCase();
    const app = $('#ot-app').value;
    const vigencia = $('#ot-vigencia').value;
    const msg = $('#ot-msg');
    msg.textContent = '';

    if (!correo || !correo.includes('@')) { msg.textContent = 'Correo inválido.'; return; }
    if (!usuarios.some((u) => u.correo === correo)) {
        msg.textContent = `"${correo}" todavía no tiene cuenta (debe crearla primero desde alguna app de la suite).`;
        return;
    }
    if (accesos.some((a) => a.correo === correo && a.app === app)) { msg.textContent = 'Ya tiene acceso a esa app.'; return; }

    const expira = vigencia ? fechaMasMeses(vigencia) : null;
    const { error } = await supabase.from('accesos').insert({ correo, app, expira });
    if (error) { msg.textContent = 'No se pudo otorgar: ' + error.message; return; }
    await supabase.from('logs_seguridad').insert({ tipo: 'acceso_otorgado', correo, app });
    toast(`Acceso a "${nombreApp(app)}" otorgado a "${correo}".`);
    $('#modal-otorgar').classList.add('oculto');
    await cargarTodo();
});

// -------------------------------------------------------------- editar vigencia
let vigContexto = null;
function abrirModalVigencia(correo, app) {
    vigContexto = { correo, app };
    $('#vig-titulo').textContent = `${correo} · ${nombreApp(app)}`;
    $('#vig-nueva').value = '1';
    $('#vig-msg').textContent = '';
    $('#modal-vigencia').classList.remove('oculto');
}
$('#vig-cancelar').addEventListener('click', () => $('#modal-vigencia').classList.add('oculto'));
$('#modal-vigencia').addEventListener('click', (e) => { if (e.target.id === 'modal-vigencia') $('#modal-vigencia').classList.add('oculto'); });

$('#vig-confirmar').addEventListener('click', async () => {
    if (!vigContexto) return;
    const valor = $('#vig-nueva').value;
    const expira = valor === 'quitar' ? null : fechaMasMeses(valor);
    const { error } = await supabase.from('accesos').update({ expira })
        .eq('correo', vigContexto.correo).eq('app', vigContexto.app);
    if (error) { $('#vig-msg').textContent = 'No se pudo guardar: ' + error.message; return; }
    toast('Vigencia actualizada.');
    $('#modal-vigencia').classList.add('oculto');
    await cargarTodo();
});

// ------------------------------------------------------------------ documentos
function renderTablaDocumentos() {
    $('#documentos-vacio').classList.toggle('oculto', documentos.length > 0);
    $('#tbody-documentos').innerHTML = documentos.map((d) => `
        <tr>
            <td class="col-correo">${escapeHtml(d.titulo)}</td>
            <td>${escapeHtml(d.categoria || '—')}</td>
            <td class="col-fecha">${fechaCorta(d.creado)}</td>
            <td class="col-borrar"><button class="btn-icono" data-borrar-doc="${d.id}" title="Borrar documento">🗑</button></td>
        </tr>`).join('');
}
$('#tbody-documentos').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-borrar-doc]');
    if (!btn) return;
    const id = Number(btn.dataset.borrarDoc);
    const doc = documentos.find((d) => d.id === id);
    if (!doc || !confirm(`¿Borrar "${doc.titulo}"? El cerebro dejará de usarlo.`)) return;
    await supabase.storage.from('documentos').remove([doc.storage_path]);
    const { error } = await supabase.from('documentos').delete().eq('id', id);
    if (error) { toast('No se pudo borrar: ' + error.message, 'error'); return; }
    toast('Documento borrado.');
    await cargarTodo();
});

let archivoPdf = null;
$('#btn-subir-doc').addEventListener('click', () => $('#input-pdf').click());
$('#input-pdf').addEventListener('change', () => {
    archivoPdf = $('#input-pdf').files[0] || null;
    if (!archivoPdf) return;
    $('#doc-titulo').value = archivoPdf.name.replace(/\.pdf$/i, '');
    $('#doc-categoria').value = '';
    $('#doc-archivo-nombre').textContent = `Archivo: ${archivoPdf.name} (${(archivoPdf.size / 1024 / 1024).toFixed(1)} MB)`;
    $('#doc-msg').textContent = '';
    $('#modal-doc').classList.remove('oculto');
});
$('#doc-cancelar').addEventListener('click', () => { $('#modal-doc').classList.add('oculto'); $('#input-pdf').value = ''; });
$('#modal-doc').addEventListener('click', (e) => { if (e.target.id === 'modal-doc') $('#modal-doc').classList.add('oculto'); });

$('#doc-confirmar').addEventListener('click', async () => {
    if (!archivoPdf) return;
    const titulo = $('#doc-titulo').value.trim();
    const categoria = $('#doc-categoria').value.trim();
    const msg = $('#doc-msg');
    if (!titulo) { msg.textContent = 'Ponele un título.'; return; }

    msg.textContent = 'Subiendo…';
    const ruta = `${Date.now()}_${archivoPdf.name.replace(/[^\w.\-]/g, '_')}`;
    const { error: errSubida } = await supabase.storage.from('documentos').upload(ruta, archivoPdf, {
        contentType: 'application/pdf',
    });
    if (errSubida) { msg.textContent = 'No se pudo subir el archivo: ' + errSubida.message; return; }

    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from('documentos').insert({
        titulo, categoria: categoria || null, storage_path: ruta, subido_por: user?.email || null,
    });
    if (error) { msg.textContent = 'No se pudo guardar: ' + error.message; return; }

    toast(`"${titulo}" subido. Ya lo puede leer el cerebro.`);
    $('#modal-doc').classList.add('oculto');
    $('#input-pdf').value = ''; archivoPdf = null;
    await cargarTodo();
});

// ------------------------------------------------------------------ soporte
function renderBadgeSoporte() {
    const n = soporte.filter((s) => s.estado === 'abierto').length;
    const badge = $('#badge-soporte');
    badge.textContent = n;
    badge.classList.toggle('oculto', n === 0);
}

function etiquetaEstadoSoporte(e) {
    return { abierto: 'Sin responder', respondido: 'Respondido', cerrado: 'Resuelto' }[e] || e;
}

function renderTablaSoporte() {
    const filtro = $('#filtro-soporte').value;
    const filas = filtro ? soporte.filter((s) => s.estado === filtro) : soporte;
    $('#soporte-vacio').classList.toggle('oculto', filas.length > 0);
    $('#tbody-soporte').innerHTML = filas.map((s) => `
        <tr>
            <td class="col-correo">${escapeHtml(s.correo)}</td>
            <td>${escapeHtml(s.app ? nombreApp(s.app) : '—')}</td>
            <td class="col-mensaje" title="${escapeHtml(s.mensaje)}">${escapeHtml(s.mensaje)}</td>
            <td><span class="tipo-tag tipo-${s.estado}">${etiquetaEstadoSoporte(s.estado)}</span></td>
            <td class="col-fecha">${new Date(s.creado).toLocaleString('es-CO')}</td>
            <td class="col-borrar"><button class="btn-icono" data-abrir-sop="${s.id}" title="Ver / responder">👁</button></td>
        </tr>`).join('');
}
$('#filtro-soporte').addEventListener('change', renderTablaSoporte);

let soporteContexto = null;
$('#tbody-soporte').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-abrir-sop]');
    if (!btn) return;
    const s = soporte.find((x) => x.id === Number(btn.dataset.abrirSop));
    if (!s) return;
    soporteContexto = s;
    $('#sop-encabezado').textContent =
        `${s.correo} · ${s.app ? nombreApp(s.app) : '—'} · ${new Date(s.creado).toLocaleString('es-CO')}`;
    $('#sop-mensaje').textContent = s.mensaje;
    $('#sop-respuesta').value = s.respuesta || '';
    $('#sop-msg').textContent = '';
    $('#modal-soporte').classList.remove('oculto');
});
$('#sop-cancelar').addEventListener('click', () => $('#modal-soporte').classList.add('oculto'));
$('#modal-soporte').addEventListener('click', (e) => { if (e.target.id === 'modal-soporte') $('#modal-soporte').classList.add('oculto'); });

$('#sop-guardar').addEventListener('click', async () => {
    if (!soporteContexto) return;
    const respuesta = $('#sop-respuesta').value.trim();
    const { error } = await supabase.from('mensajes_soporte')
        .update({ respuesta, estado: 'respondido', respondido_en: new Date().toISOString() })
        .eq('id', soporteContexto.id);
    if (error) { $('#sop-msg').textContent = 'No se pudo guardar: ' + error.message; return; }
    toast('Respuesta guardada.');
    $('#modal-soporte').classList.add('oculto');
    await cargarTodo();
    renderTablaSoporte();
});
$('#sop-marcar-cerrado').addEventListener('click', async () => {
    if (!soporteContexto) return;
    const { error } = await supabase.from('mensajes_soporte').update({ estado: 'cerrado' }).eq('id', soporteContexto.id);
    if (error) { $('#sop-msg').textContent = 'No se pudo actualizar: ' + error.message; return; }
    toast('Marcado como resuelto.');
    $('#modal-soporte').classList.add('oculto');
    await cargarTodo();
    renderTablaSoporte();
});

// ------------------------------------------------------------------ cerebro
async function cargarConversaciones() {
    const { data } = await supabase.from('conversaciones').select('id,titulo,actualizado').order('actualizado', { ascending: false });
    conversaciones = data || [];
    renderListaConversaciones();
    if (!conversacionActivaId && conversaciones.length) await seleccionarConversacion(conversaciones[0].id);
    else if (!conversaciones.length) mostrarChatVacio();
}
function renderListaConversaciones() {
    $('#lista-conversaciones').innerHTML = conversaciones.map((c) => `
        <button class="conv-item ${c.id === conversacionActivaId ? 'activa' : ''}" data-conv="${c.id}">${escapeHtml(c.titulo)}</button>
    `).join('') || '<p class="chat-vacio">Sin conversaciones todavía.</p>';
}
$('#lista-conversaciones').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-conv]');
    if (btn) seleccionarConversacion(btn.dataset.conv);
});
$('#btn-nueva-conv').addEventListener('click', async () => {
    const { data, error } = await supabase.from('conversaciones').insert({ titulo: 'Nueva conversación' }).select().single();
    if (error) { toast('No se pudo crear la conversación: ' + error.message, 'error'); return; }
    conversaciones.unshift(data);
    await seleccionarConversacion(data.id);
});

function mostrarChatVacio() {
    $('#chat-mensajes').innerHTML = `<p class="chat-vacio">Preguntá algo sobre los documentos que hayas cargado.
        El cerebro responde solo con base en ellos, citando capítulo o artículo cuando aplique.</p>`;
}

async function seleccionarConversacion(id) {
    conversacionActivaId = id;
    renderListaConversaciones();
    const { data } = await supabase.from('mensajes').select('*').eq('conversacion_id', id).order('creado');
    const cont = $('#chat-mensajes');
    cont.innerHTML = '';
    if (!data || !data.length) { mostrarChatVacio(); return; }
    data.forEach((m) => agregarMensajeChat(m.contenido, m.rol === 'user' ? 'usuario' : 'cerebro', m.fuentes || []));
}

function agregarMensajeChat(texto, tipo, fuentes = []) {
    const cont = $('#chat-mensajes');
    cont.querySelector('.chat-vacio')?.remove();
    const div = document.createElement('div');
    div.className = `chat-burbuja chat-${tipo}`;
    div.innerHTML = `<p>${escapeHtml(texto).replace(/\n/g, '<br>')}</p>`;
    if (fuentes.length) {
        div.innerHTML += `<div class="chat-fuentes">${fuentes.map((f) => `<span class="chip chip-fuente">${escapeHtml(f)}</span>`).join('')}</div>`;
    }
    cont.appendChild(div);
    cont.scrollTop = cont.scrollHeight;
    return div;
}

$('#form-chat').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!conversacionActivaId) {
        const { data } = await supabase.from('conversaciones').insert({ titulo: 'Nueva conversación' }).select().single();
        conversaciones.unshift(data);
        conversacionActivaId = data.id;
        renderListaConversaciones();
    }
    const input = $('#chat-input');
    const pregunta = input.value.trim();
    if (!pregunta) return;

    const btn = $('#btn-chat');
    btn.disabled = true; btn.classList.add('cargando');
    agregarMensajeChat(pregunta, 'usuario');
    input.value = '';
    const pensando = agregarMensajeChat('Pensando…', 'cerebro pensando');

    const { data, error } = await supabase.functions.invoke('cerebro', {
        body: { pregunta, conversacion_id: conversacionActivaId },
    });

    pensando.remove();
    btn.disabled = false; btn.classList.remove('cargando');

    if (error || data?.error) {
        agregarMensajeChat('No se pudo obtener respuesta: ' + (data?.error || error.message), 'cerebro chat-error');
        return;
    }
    agregarMensajeChat(data.respuesta || '(sin respuesta)', 'cerebro', data.fuentes || []);
    await cargarConversaciones();
});

intentarSesion();
