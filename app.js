// app.js — Centro de Mando JC
// La librería de Supabase se sirve DESDE ESTE MISMO SITIO (vendor-supabase.js,
// cargado como <script> normal en index.html, ANTES que este archivo), no
// desde esm.sh -- algunas redes/antivirus bloquean CDNs externos como esm.sh
// y eso dejaba el login "cargando" para siempre sin ningún error visible.
// Sirviéndola local, solo depende de que GitHub Pages cargue (que ya sabemos
// que sí) y de tu propio proyecto de Supabase. vendor-supabase.js es la
// build UMD: define una variable global 'supabase' (window.supabase), no un
// módulo -- por eso acá NO se importa, se usa directo window.supabase.
import { aplicarTilt } from './bg.js';

const { url, anonKey } = window.SUPABASE_CONFIG;
const supabase = window.supabase.createClient(url, anonKey);

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
let soporte = [];
let enlaces = [];

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
    aplicaciones: ['Aplicaciones', 'Una tarjeta por cada app de la suite'],
    usuarios: ['Usuarios', 'Crea cuentas nuevas y mandales la bienvenida'],
    enlaces: ['Enlaces', 'Links de descarga que se incluyen en el correo de bienvenida'],
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
    if (nombre === 'aplicaciones') renderAplicaciones();
    if (nombre === 'usuarios') renderTablaUsuarios();
    if (nombre === 'enlaces') renderTablaEnlaces();
    if (nombre === 'logs') renderTablaLogsCompleta();
    if (nombre === 'soporte') renderTablaSoporte();
}

// -------------------------------------------------------------- aplicaciones
let appExpandidaSlug = null;

function renderAplicaciones() {
    $('#apps-grid').innerHTML = apps.map((a, i) => {
        const misAccesos = accesos.filter((ac) => ac.app === a.slug);
        const expandida = a.slug === appExpandidaSlug;
        if (!expandida) {
            // Colapsada: solo el nombre -- todo lo demás vive adentro, al entrar.
            return `
            <div class="app-card" data-tilt-suave data-toggle-app="${a.slug}" style="animation-delay:${i * 60}ms">
                <div class="app-card-cabecera">
                    <div class="app-card-icono">🧩</div>
                    <div class="app-card-titulos"><h3>${escapeHtml(a.nombre)}</h3></div>
                </div>
            </div>`;
        }
        return `
        <div class="app-card app-card-expandida" style="animation-delay:${i * 60}ms">
            <div class="app-card-cabecera" data-toggle-app="${a.slug}" title="Ocultar">
                <div class="app-card-icono">🧩</div>
                <div class="app-card-titulos">
                    <h3>${escapeHtml(a.nombre)}</h3>
                    <span class="app-card-slug">${escapeHtml(a.slug)}</span>
                </div>
                <span class="app-card-cerrar">Ocultar ▲</span>
            </div>
            ${panelUsuariosApp(a.slug, misAccesos)}
        </div>`;
    }).join('') || '<p class="grafica-vacia">Todavía no hay aplicaciones registradas.</p>';

    $$('#apps-grid .app-card:not(.app-card-expandida)').forEach((el) => aplicarTilt(el, 3));
}

function panelUsuariosApp(slug, misAccesos) {
    const ahora = Date.now();
    const activos = misAccesos.filter((a) => !a.expira || new Date(a.expira).getTime() > ahora).length;
    const vencenPronto = misAccesos.filter((a) => a.expira && new Date(a.expira).getTime() > ahora
        && new Date(a.expira).getTime() - ahora <= 7 * 86400000).length;
    const bloqueados = misAccesos.filter((a) => usuarios.find((u) => u.correo === a.correo)?.bloqueado).length;

    const filas = misAccesos.map((a) => {
        const u = usuarios.find((x) => x.correo === a.correo);
        if (!u) return '';
        return filaUsuarioApp(u, a, slug);
    }).join('');

    return `
        <div class="app-panel">
            <div class="app-panel-stats">
                <span><b>${misAccesos.length}</b> con acceso</span>
                <span><b>${activos}</b> activos</span>
                <span class="${vencenPronto ? 'app-panel-alerta' : ''}"><b>${vencenPronto}</b> vencen ≤7 días</span>
                <span class="${bloqueados ? 'app-panel-alerta' : ''}"><b>${bloqueados}</b> bloqueados</span>
                <button class="btn-primario" data-otorgar-app="${slug}">+ Otorgar acceso</button>
            </div>
            <div class="tabla-wrap">
                <table class="tabla-app-panel">
                    <thead><tr><th>Correo</th><th>Vigencia</th><th>Estado</th><th></th></tr></thead>
                    <tbody>${filas || `<tr><td colspan="4" class="tabla-vacia">Nadie tiene acceso a esta app todavía.</td></tr>`}</tbody>
                </table>
            </div>
        </div>`;
}

function filaUsuarioApp(u, a, slug) {
    const ahora = Date.now();
    const vencido = a.expira && new Date(a.expira).getTime() < ahora;
    let estadoVigencia;
    if (!a.expira) estadoVigencia = 'Sin vencimiento';
    else if (vencido) estadoVigencia = `Venció ${fechaCorta(a.expira)}`;
    else estadoVigencia = `Vence ${fechaCorta(a.expira)}`;

    return `
        <tr>
            <td class="col-correo">${escapeHtml(u.correo)}</td>
            <td>
                <div class="vig-inline">
                    <span class="vig-inline-estado ${vencido ? 'chip-vence' : ''}">${estadoVigencia}</span>
                    <input type="number" min="1" value="1" class="vig-inline-cant" data-vc="${u.correo}|${slug}">
                    <select class="vig-inline-unidad" data-vu="${u.correo}|${slug}">
                        <option value="quitar">Quitar</option>
                        <option value="horas">Horas</option>
                        <option value="dias" selected>Días</option>
                        <option value="meses">Meses</option>
                    </select>
                    <button class="btn-icono vig-inline-ok" data-vig-app="${u.correo}|${slug}" title="Aplicar">✔</button>
                </div>
            </td>
            <td class="col-estado">
                <label class="switch" title="${u.bloqueado ? 'Desbloquear' : 'Bloquear'}">
                    <input type="checkbox" data-toggle="${u.correo}" ${u.bloqueado ? '' : 'checked'}>
                    <span class="slider"></span>
                </label>
            </td>
            <td class="col-borrar">
                <button class="btn-icono" data-revocar="${u.correo}|${slug}" title="Revocar acceso a esta app">🗑</button>
                <button class="btn-icono" data-borrar-cuenta="${u.correo}" title="Borrar cuenta completa (todas las apps de la suite)">⛔</button>
            </td>
        </tr>`;
}

$('#apps-grid').addEventListener('click', async (e) => {
    const toggleApp = e.target.closest('[data-toggle-app]');
    if (toggleApp) {
        const slug = toggleApp.dataset.toggleApp;
        appExpandidaSlug = appExpandidaSlug === slug ? null : slug;
        renderAplicaciones();
        return;
    }
    const ot = e.target.closest('[data-otorgar-app]');
    if (ot) { abrirModalOtorgar(ot.dataset.otorgarApp); return; }

    const borrarCuenta = e.target.closest('[data-borrar-cuenta]');
    if (borrarCuenta) {
        const correo = borrarCuenta.dataset.borrarCuenta;
        if (!confirm(`¿Borrar la cuenta de "${correo}"? Pierde el acceso a TODAS las apps de la suite, no solo esta.`)) return;
        const { error } = await supabase.from('usuarios').delete().eq('correo', correo);
        if (error) { toast('No se pudo borrar: ' + error.message, 'error'); return; }
        await supabase.from('logs_seguridad').insert({ tipo: 'borrado', correo });
        toast(`Cuenta de "${correo}" borrada.`);
        await cargarTodo();
        return;
    }

    const vigOk = e.target.closest('[data-vig-app]');
    if (vigOk) {
        const [correo, app] = vigOk.dataset.vigApp.split('|');
        const cant = $(`[data-vc="${correo}|${app}"]`).value;
        const unidad = $(`[data-vu="${correo}|${app}"]`).value;
        const expira = unidad === 'quitar' ? null : calcularExpira(cant, unidad);
        const { error } = await supabase.from('accesos').update({ expira }).eq('correo', correo).eq('app', app);
        if (error) { toast('No se pudo guardar: ' + error.message, 'error'); return; }
        toast('Vigencia actualizada.');
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
    }
});

$('#apps-grid').addEventListener('change', async (e) => {
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

$('#btn-registrar-app').addEventListener('click', () => {
    $('#app-nombre').value = ''; $('#app-slug').value = ''; $('#app-msg').textContent = '';
    $('#modal-app').classList.remove('oculto');
});
$('#app-cancelar').addEventListener('click', () => $('#modal-app').classList.add('oculto'));
$('#modal-app').addEventListener('click', (e) => { if (e.target.id === 'modal-app') $('#modal-app').classList.add('oculto'); });

$('#app-confirmar').addEventListener('click', async () => {
    const nombre = $('#app-nombre').value.trim();
    const slug = $('#app-slug').value.trim().toLowerCase().replace(/\s+/g, '_');
    const msg = $('#app-msg');
    if (!nombre || !slug) { msg.textContent = 'Completá los dos campos.'; return; }
    if (apps.some((a) => a.slug === slug)) { msg.textContent = 'Ya existe una app con ese identificador.'; return; }
    const { error } = await supabase.from('apps').insert({ slug, nombre });
    if (error) { msg.textContent = 'No se pudo registrar: ' + error.message; return; }
    toast(`Aplicación "${nombre}" registrada.`);
    $('#modal-app').classList.add('oculto');
    await cargarTodo();
});

// ------------------------------------------------------------------ carga de datos
async function cargarTodo() {
    const [{ data: a }, { data: u }, { data: ac }, { data: lg }, { data: sop }, { data: en }] = await Promise.all([
        supabase.from('apps').select('slug,nombre').order('nombre'),
        supabase.from('usuarios').select('correo,bloqueado,creado,requiere_cambio_clave').order('creado', { ascending: false }),
        supabase.from('accesos').select('correo,app,creado,expira'),
        supabase.from('logs_seguridad').select('*').order('creado', { ascending: false }).limit(200),
        supabase.from('mensajes_soporte').select('*').order('creado', { ascending: false }),
        supabase.from('enlaces_apps').select('id,app,nombre,url,orden').order('app').order('orden'),
    ]);
    apps = a || []; usuarios = u || []; accesos = ac || []; logs = lg || [];
    soporte = sop || []; enlaces = en || [];

    renderStats();
    renderGraficaCrecimiento();
    renderGraficaApps();
    renderTablaLogsMini();
    poblarSelectApps();
    renderBadgeSoporte();
    if (!$('#seccion-aplicaciones').classList.contains('oculto')) renderAplicaciones();
    if (!$('#seccion-usuarios').classList.contains('oculto')) renderTablaUsuarios();
    if (!$('#seccion-enlaces').classList.contains('oculto')) renderTablaEnlaces();
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
        borrado: 'Borrado', acceso_otorgado: 'Acceso otorgado', acceso_revocado: 'Acceso revocado',
        usuario_creado: 'Usuario creado', soporte_resuelto: 'Soporte resuelto' }[t] || t;
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

// -------------------------------------------------------------- otorgar acceso
function poblarSelectApps() {
    const opciones = apps.map((a) => `<option value="${a.slug}">${a.nombre}</option>`).join('');
    $('#ot-app').innerHTML = opciones;
    $('#en-app').innerHTML = opciones;
}

// Calcula la fecha de vencimiento a partir de una cantidad + unidad (horas,
// días o meses) -- null si no hay unidad (sin vencimiento).
function calcularExpira(cantidad, unidad) {
    if (!unidad) return null;
    const n = Math.max(1, Number(cantidad) || 1);
    const d = new Date();
    if (unidad === 'horas') d.setHours(d.getHours() + n);
    else if (unidad === 'dias') d.setDate(d.getDate() + n);
    else if (unidad === 'meses') d.setMonth(d.getMonth() + n);
    return d.toISOString();
}

function abrirModalOtorgar(appPreseleccionada = '') {
    $('#ot-correo').value = '';
    $('#ot-vig-cantidad').value = '1';
    $('#ot-vig-unidad').value = 'dias';
    $('#ot-msg').textContent = '';
    if (appPreseleccionada) $('#ot-app').value = appPreseleccionada;
    $('#modal-otorgar').classList.remove('oculto');
}
$('#ot-cancelar').addEventListener('click', () => $('#modal-otorgar').classList.add('oculto'));
$('#modal-otorgar').addEventListener('click', (e) => { if (e.target.id === 'modal-otorgar') $('#modal-otorgar').classList.add('oculto'); });

$('#ot-confirmar').addEventListener('click', async () => {
    const correo = $('#ot-correo').value.trim().toLowerCase();
    const app = $('#ot-app').value;
    const cantidad = $('#ot-vig-cantidad').value;
    const unidad = $('#ot-vig-unidad').value;
    const msg = $('#ot-msg');
    msg.textContent = '';

    if (!correo || !correo.includes('@')) { msg.textContent = 'Correo inválido.'; return; }
    if (!usuarios.some((u) => u.correo === correo)) {
        msg.textContent = `"${correo}" todavía no tiene cuenta (debe crearla primero desde alguna app de la suite).`;
        return;
    }
    if (accesos.some((a) => a.correo === correo && a.app === app)) { msg.textContent = 'Ya tiene acceso a esa app.'; return; }

    const expira = calcularExpira(cantidad, unidad);
    const { error } = await supabase.from('accesos').insert({ correo, app, expira });
    if (error) { msg.textContent = 'No se pudo otorgar: ' + error.message; return; }
    await supabase.from('logs_seguridad').insert({ tipo: 'acceso_otorgado', correo, app });
    toast(`Acceso a "${nombreApp(app)}" otorgado a "${correo}".`);
    $('#modal-otorgar').classList.add('oculto');
    await cargarTodo();
});

// ------------------------------------------------------------------ usuarios
function renderTablaUsuarios() {
    $('#usuarios-vacio').classList.toggle('oculto', usuarios.length > 0);
    $('#tbody-usuarios').innerHTML = usuarios.map((u) => `
        <tr>
            <td class="col-correo">${escapeHtml(u.correo)}</td>
            <td class="col-estado">
                <label class="switch" title="${u.bloqueado ? 'Desbloquear' : 'Bloquear'}">
                    <input type="checkbox" data-toggle-usuario="${u.correo}" ${u.bloqueado ? '' : 'checked'}>
                    <span class="slider"></span>
                </label>
            </td>
            <td>${u.requiere_cambio_clave
                ? '<span class="tipo-tag tipo-login_fallido">Debe cambiarla</span>'
                : '<span class="tipo-tag tipo-login_ok">OK</span>'}</td>
            <td class="col-fecha">${fechaCorta(u.creado)}</td>
        </tr>`).join('');
}
$('#tbody-usuarios').addEventListener('change', async (e) => {
    const toggle = e.target.closest('[data-toggle-usuario]');
    if (!toggle) return;
    const correo = toggle.dataset.toggleUsuario;
    const bloqueado = !toggle.checked;
    const { error } = await supabase.from('usuarios').update({ bloqueado }).eq('correo', correo);
    if (error) { toast('No se pudo actualizar: ' + error.message, 'error'); toggle.checked = !toggle.checked; return; }
    await supabase.from('logs_seguridad').insert({ tipo: bloqueado ? 'bloqueo' : 'desbloqueo', correo });
    toast(bloqueado ? `"${correo}" bloqueado.` : `"${correo}" desbloqueado.`);
    await cargarTodo();
});

// Checklist de apps del modal "Crear usuario" -- cada fila trae su propio
// combo de vigencia (igual que "Otorgar acceso"), deshabilitado hasta que se
// marque el checkbox de esa app.
function renderChecklistAppsUsuario() {
    $('#us-apps-lista').innerHTML = apps.map((a) => `
        <div class="checklist-app-item">
            <label class="campo-check">
                <input type="checkbox" data-us-app="${a.slug}">
                <span>${escapeHtml(a.nombre)}</span>
            </label>
            <div class="vigencia-combo">
                <input type="number" min="1" value="1" data-us-vc="${a.slug}" disabled>
                <select data-us-vu="${a.slug}" disabled>
                    <option value="">Sin vencimiento</option>
                    <option value="horas">Horas</option>
                    <option value="dias" selected>Días</option>
                    <option value="meses">Meses</option>
                </select>
            </div>
        </div>`).join('') || '<p class="grafica-vacia">Registrá una app primero.</p>';
}
$('#us-apps-lista').addEventListener('change', (e) => {
    const chk = e.target.closest('[data-us-app]');
    if (!chk) return;
    const slug = chk.dataset.usApp;
    $(`[data-us-vc="${slug}"]`).disabled = !chk.checked;
    $(`[data-us-vu="${slug}"]`).disabled = !chk.checked;
});

$('#btn-crear-usuario').addEventListener('click', () => {
    $('#us-correo').value = ''; $('#us-msg').textContent = '';
    renderChecklistAppsUsuario();
    $('#modal-usuario').classList.remove('oculto');
});
$('#us-cancelar').addEventListener('click', () => $('#modal-usuario').classList.add('oculto'));
$('#modal-usuario').addEventListener('click', (e) => { if (e.target.id === 'modal-usuario') $('#modal-usuario').classList.add('oculto'); });

$('#us-confirmar').addEventListener('click', async () => {
    const correo = $('#us-correo').value.trim().toLowerCase();
    const msg = $('#us-msg');
    const btn = $('#us-confirmar');
    msg.textContent = '';
    if (!correo || !correo.includes('@')) { msg.textContent = 'Correo inválido.'; return; }
    if (usuarios.some((u) => u.correo === correo)) { msg.textContent = 'Ya existe una cuenta con ese correo.'; return; }

    const accesosElegidos = $$('#us-apps-lista [data-us-app]:checked').map((chk) => {
        const slug = chk.dataset.usApp;
        const cant = $(`[data-us-vc="${slug}"]`).value;
        const unidad = $(`[data-us-vu="${slug}"]`).value;
        return { app: slug, expira: calcularExpira(cant, unidad) };
    });

    btn.disabled = true; btn.classList.add('cargando');
    const { data, error } = await supabase.functions.invoke('crear-usuario', { body: { correo, accesos: accesosElegidos } });
    btn.disabled = false; btn.classList.remove('cargando');

    if (error || data?.error) { msg.textContent = 'No se pudo crear: ' + (data?.error || error.message); return; }

    if (data.email_enviado === false) {
        msg.textContent = `Usuario creado, pero el correo no se pudo enviar. Contraseña temporal: ${data.password_temporal} — copiala y pasásela a mano.`;
        toast(`"${correo}" creado (avisale la clave a mano).`, 'error');
    } else {
        toast(`"${correo}" creado. Le llegó el correo de bienvenida.`);
        $('#modal-usuario').classList.add('oculto');
    }
    await cargarTodo();
});

// ------------------------------------------------------------------ enlaces de descarga
let enlaceEditando = null;

function renderTablaEnlaces() {
    $('#enlaces-vacio').classList.toggle('oculto', enlaces.length > 0);
    $('#tbody-enlaces').innerHTML = enlaces.map((en) => `
        <tr>
            <td>${escapeHtml(nombreApp(en.app))}</td>
            <td>${escapeHtml(en.nombre)}</td>
            <td class="col-url"><a href="${escapeHtml(en.url)}" target="_blank" rel="noopener">${escapeHtml(en.url)}</a></td>
            <td class="col-borrar">
                <button class="btn-icono" data-editar-enlace="${en.id}" title="Editar">✎</button>
                <button class="btn-icono" data-borrar-enlace="${en.id}" title="Borrar">🗑</button>
            </td>
        </tr>`).join('');
}
$('#tbody-enlaces').addEventListener('click', async (e) => {
    const editar = e.target.closest('[data-editar-enlace]');
    if (editar) { abrirModalEnlace(enlaces.find((en) => en.id === Number(editar.dataset.editarEnlace))); return; }

    const borrar = e.target.closest('[data-borrar-enlace]');
    if (borrar) {
        const id = Number(borrar.dataset.borrarEnlace);
        const en = enlaces.find((x) => x.id === id);
        if (!en || !confirm(`¿Borrar el enlace "${en.nombre}"?`)) return;
        const { error } = await supabase.from('enlaces_apps').delete().eq('id', id);
        if (error) { toast('No se pudo borrar: ' + error.message, 'error'); return; }
        toast('Enlace borrado.');
        await cargarTodo();
    }
});

function abrirModalEnlace(en = null) {
    enlaceEditando = en;
    $('#en-app').value = en?.app || apps[0]?.slug || '';
    $('#en-nombre').value = en?.nombre || '';
    $('#en-url').value = en?.url || '';
    $('#en-msg').textContent = '';
    $('#modal-enlace').classList.remove('oculto');
}
$('#btn-agregar-enlace').addEventListener('click', () => abrirModalEnlace());
$('#en-cancelar').addEventListener('click', () => $('#modal-enlace').classList.add('oculto'));
$('#modal-enlace').addEventListener('click', (e) => { if (e.target.id === 'modal-enlace') $('#modal-enlace').classList.add('oculto'); });

$('#en-confirmar').addEventListener('click', async () => {
    const app = $('#en-app').value;
    const nombre = $('#en-nombre').value.trim();
    const url = $('#en-url').value.trim();
    const msg = $('#en-msg');
    if (!app || !nombre || !url) { msg.textContent = 'Completá los tres campos.'; return; }

    const payload = { app, nombre, url };
    const { error } = enlaceEditando
        ? await supabase.from('enlaces_apps').update(payload).eq('id', enlaceEditando.id)
        : await supabase.from('enlaces_apps').insert(payload);
    if (error) { msg.textContent = 'No se pudo guardar: ' + error.message; return; }

    toast('Enlace guardado.');
    $('#modal-enlace').classList.add('oculto');
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
$('#sop-enviar-correo').addEventListener('click', async () => {
    if (!soporteContexto) return;
    if (!confirm(`¿Enviarle un correo a "${soporteContexto.correo}" avisando que se solucionó?`)) return;
    const btn = $('#sop-enviar-correo');
    btn.disabled = true; btn.classList.add('cargando');
    const { data, error } = await supabase.functions.invoke('enviar-correo-soporte', {
        body: { mensaje_id: soporteContexto.id },
    });
    btn.disabled = false; btn.classList.remove('cargando');

    if (error || data?.error) { $('#sop-msg').textContent = 'No se pudo enviar: ' + (data?.error || error.message); return; }

    toast(data.email_enviado ? 'Correo enviado y ticket cerrado.' : 'Ticket cerrado, pero el correo no se pudo enviar.',
        data.email_enviado ? 'ok' : 'error');
    $('#modal-soporte').classList.add('oculto');
    await cargarTodo();
    renderTablaSoporte();
});

intentarSesion();
