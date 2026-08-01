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

// Alumbrado Público no usa el sistema de accesos de la suite (tiene su propio
// backend en Firebase) -- en vez del panel de "otorgar acceso" genérico, su
// tarjeta expandida muestra la gestión completa (ver panelAlumbrado() más
// abajo). Para que enganche, hay que registrar la app desde "+ Registrar
// aplicación" con este identificador EXACTO.
const SLUG_ALUMBRADO = 'alumbrado_publico';

function iconoAppHtml(a) {
    return a.icono_url
        ? `<img src="${escapeHtml(a.icono_url)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:12px;">`
        : '🧩';
}

function renderAplicaciones() {
    $('#apps-grid').innerHTML = apps.map((a, i) => {
        const misAccesos = accesos.filter((ac) => ac.app === a.slug);
        const expandida = a.slug === appExpandidaSlug;
        if (!expandida) {
            // Colapsada: solo el nombre -- todo lo demás vive adentro, al entrar.
            return `
            <div class="app-card" data-tilt-suave data-toggle-app="${a.slug}" style="animation-delay:${i * 60}ms">
                <div class="app-card-cabecera">
                    <div class="app-card-icono">${iconoAppHtml(a)}</div>
                    <div class="app-card-titulos"><h3>${escapeHtml(a.nombre)}</h3></div>
                </div>
            </div>`;
        }
        return `
        <div class="app-card app-card-expandida" style="animation-delay:${i * 60}ms">
            <div class="app-card-cabecera">
                <div class="app-card-icono app-card-icono-editable" data-cambiar-icono="${a.slug}" tabindex="0" title="Clic para elegir un archivo, o hacé foco acá y pegá una imagen con Ctrl+V">
                    ${iconoAppHtml(a)}
                    <span class="app-card-icono-lapiz">✎</span>
                </div>
                <div class="app-card-titulos" data-toggle-app="${a.slug}" style="cursor:pointer;">
                    <h3>${escapeHtml(a.nombre)}</h3>
                    <span class="app-card-slug">${escapeHtml(a.slug)}</span>
                </div>
                <span class="app-card-cerrar" data-toggle-app="${a.slug}">Ocultar ▲</span>
            </div>
            ${a.slug === SLUG_ALUMBRADO ? panelAlumbrado() : panelUsuariosApp(a.slug, misAccesos)}
        </div>`;
    }).join('') || '<p class="grafica-vacia">Todavía no hay aplicaciones registradas.</p>';

    $$('#apps-grid .app-card:not(.app-card-expandida)').forEach((el) => aplicarTilt(el, 3));
}

// Sirve tanto para el selector de archivo como para pegar (Ctrl+V) una imagen
// copiada -- en los dos casos termina acá con un File/Blob real en la mano.
async function subirArchivoIcono(slug, archivo) {
    const extension = (archivo.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    const ruta = `${slug}.${extension}`;
    const { error: errSubida } = await supabase.storage.from('app-iconos').upload(ruta, archivo, {
        contentType: archivo.type || 'image/png', upsert: true,
    });
    if (errSubida) { toast('No se pudo subir el ícono: ' + errSubida.message, 'error'); return; }

    const { data: pub } = supabase.storage.from('app-iconos').getPublicUrl(ruta);
    // ?v= al final para que el navegador no muestre la imagen vieja en caché
    // cuando se reemplaza el ícono de la misma app.
    const iconoUrl = `${pub.publicUrl}?v=${Date.now()}`;
    const { error: errUpdate } = await supabase.from('apps').update({ icono_url: iconoUrl }).eq('slug', slug);
    if (errUpdate) { toast('No se pudo guardar el ícono: ' + errUpdate.message, 'error'); return; }

    toast('Ícono actualizado.');
    await cargarTodo();
}

async function subirIconoApp(slug) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', () => {
        const archivo = input.files[0];
        if (archivo) subirArchivoIcono(slug, archivo);
    });
    input.click();
}

// Pegar una imagen (Ctrl+V) mientras el cuadrito del ícono tiene el foco --
// hace falta clickearlo primero (o tabular hasta él) para "apuntar" a qué app
// se le va a cambiar el ícono, ya que el evento 'paste' no sabe por sí solo
// sobre qué elemento se pegó.
document.addEventListener('paste', (e) => {
    const foco = document.activeElement;
    const slug = foco?.dataset?.cambiarIcono;
    if (!slug) return;
    const item = Array.from(e.clipboardData?.items || []).find((i) => i.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    const archivo = item.getAsFile();
    if (archivo) subirArchivoIcono(slug, archivo);
});

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
                    <select class="vig-inline-unidad" data-tipo-app="${u.correo}|${slug}"
                            title="Tipo de licencia: la app lo muestra en su barra de estado (Versión de prueba / Versión definitiva). Se guarda al cambiarlo.">
                        <option value="prueba" ${a.tipo_licencia === 'definitiva' ? '' : 'selected'}>Prueba</option>
                        <option value="definitiva" ${a.tipo_licencia === 'definitiva' ? 'selected' : ''}>Definitiva</option>
                    </select>
                </div>
            </td>
            <td class="col-estado">
                <label class="switch" title="${u.bloqueado ? 'Desbloquear' : 'Bloquear'}">
                    <input type="checkbox" data-toggle="${u.correo}" ${u.bloqueado ? '' : 'checked'}>
                    <span class="slider"></span>
                </label>
            </td>
            <td class="col-borrar">
                <button class="btn-icono btn-icono-peligro" data-revocar="${u.correo}|${slug}" title="Revocar acceso a esta app">🗑</button>
                <button class="btn-icono btn-icono-peligro" data-borrar-cuenta="${u.correo}" title="Borrar cuenta completa (todas las apps de la suite)">⛔</button>
            </td>
        </tr>`;
}

$('#apps-grid').addEventListener('click', async (e) => {
    // va primero: el botón de cambiar ícono vive DENTRO del área que también
    // tiene data-toggle-app (la cabecera de la tarjeta expandida), así que hay
    // que interceptarlo antes de que closest('[data-toggle-app]') lo agarre.
    const cambiarIcono = e.target.closest('[data-cambiar-icono]');
    if (cambiarIcono) { subirIconoApp(cambiarIcono.dataset.cambiarIcono); return; }

    const toggleApp = e.target.closest('[data-toggle-app]');
    if (toggleApp) {
        const slug = toggleApp.dataset.toggleApp;
        appExpandidaSlug = appExpandidaSlug === slug ? null : slug;
        renderAplicaciones();
        if (appExpandidaSlug === SLUG_ALUMBRADO) activarSubtabAlumbrado(aluSubtabActiva);
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
    // Tipo de licencia (Prueba / Definitiva): se guarda apenas se cambia.
    const tipoSel = e.target.closest('[data-tipo-app]');
    if (tipoSel) {
        const [correo, app] = tipoSel.dataset.tipoApp.split('|');
        const { error } = await supabase.from('accesos')
            .update({ tipo_licencia: tipoSel.value }).eq('correo', correo).eq('app', app);
        if (error) { toast('No se pudo guardar: ' + error.message, 'error'); return; }
        toast(`Licencia de "${correo}" marcada como ${tipoSel.value}.`);
        await cargarTodo();
        return;
    }
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
// Los técnicos de Alumbrado Público NO viven en Supabase (están en el
// Firestore de esa app, ver SLUG_ALUMBRADO más arriba) -- para que el Panel
// los sume igual, se pide su conteo aparte acá, sin que un fallo ahí tumbe la
// carga del resto del panel (por eso el try/catch: la app puede no estar
// registrada todavía, o la Edge Function 'alumbrado' puede no estar deployada).
let aluTecnicosCount = 0;
async function cargarAluTecnicosCount() {
    if (!apps.some((a) => a.slug === SLUG_ALUMBRADO)) { aluTecnicosCount = 0; return; }
    try {
        const { kpis } = await invocarAlumbrado('dashboard_kpis');
        aluTecnicosCount = kpis?.usuarios || 0;
    } catch {
        aluTecnicosCount = 0;
    }
}

async function cargarTodo() {
    const [{ data: a }, { data: u }, { data: ac }, { data: lg }, { data: sop }, { data: en }] = await Promise.all([
        supabase.from('apps').select('slug,nombre,icono_url').order('nombre'),
        supabase.from('usuarios').select('correo,nombre_completo,cedula,empresa,celular,bloqueado,creado,requiere_cambio_clave').order('creado', { ascending: false }),
        supabase.from('accesos').select('correo,app,creado,expira,tipo_licencia'),
        supabase.from('logs_seguridad').select('*').order('creado', { ascending: false }).limit(200),
        supabase.from('mensajes_soporte').select('*').order('creado', { ascending: false }),
        supabase.from('enlaces_apps').select('id,app,nombre,url,orden').order('app').order('orden'),
    ]);
    apps = a || []; usuarios = u || []; accesos = ac || []; logs = lg || [];
    soporte = sop || []; enlaces = en || [];
    await cargarAluTecnicosCount();

    renderListaEmpresas();
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
    // Total usuarios = usuarios de la suite (Supabase) + técnicos de Alumbrado
    // Público (Firestore, ver cargarAluTecnicosCount) -- "Nuevos este mes" NO
    // los incluye porque esos registros no tienen fecha de creación guardada.
    const items = [
        { icono: '👤', valor: usuarios.length + aluTecnicosCount, label: 'Total usuarios' },
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
        // Alumbrado Público no usa 'accesos' de Supabase -- sus usuarios
        // (técnicos) viven en Firestore, ya contados en aluTecnicosCount.
        n: a.slug === SLUG_ALUMBRADO
            ? aluTecnicosCount
            : accesos.filter((ac) => ac.app === a.slug && (!ac.expira || new Date(ac.expira).getTime() > ahora)).length,
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

// Sugerencias del campo "Empresa" (crear/editar usuario) -- las empresas que
// ya tienen al menos un usuario, para no crear duplicados por typo
// ("ElectroHuila" vs "Electrohuila"). Sigue permitiendo escribir una nueva.
function renderListaEmpresas() {
    const empresas = [...new Set(usuarios.map((u) => u.empresa).filter(Boolean))].sort();
    $('#lista-empresas').innerHTML = empresas.map((e) => `<option value="${escapeHtml(e)}">`).join('');
}

// ------------------------------------------------------------------ usuarios
function renderTablaUsuarios() {
    $('#usuarios-vacio').classList.toggle('oculto', usuarios.length > 0);
    $('#tbody-usuarios').innerHTML = usuarios.map((u) => `
        <tr>
            <td class="col-correo">${escapeHtml(u.correo)}</td>
            <td title="Cédula: ${escapeHtml(u.cedula || '—')}  ·  Celular: ${escapeHtml(u.celular || '—')}">
                ${u.nombre_completo ? escapeHtml(u.nombre_completo) : '—'}
                ${u.empresa ? `<br><small style="color:#8a8a8a;">${escapeHtml(u.empresa)}</small>` : ''}
            </td>
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
            <td class="col-borrar">
                <button class="btn-icono" data-editar-usuario="${u.correo}" title="Editar datos (nombre, cédula, empresa, celular)">✎</button>
                <button class="btn-icono" data-resetear-usuario="${u.correo}" title="Generar clave temporal nueva y mandarla por correo">🔑</button>
                <button class="btn-icono btn-icono-peligro" data-borrar-usuario="${u.correo}" title="Borrar cuenta completa (todas las apps de la suite)">⛔</button>
            </td>
        </tr>`).join('');
}

function abrirModalEditarUsuario(u) {
    $('#eu-correo').value = u.correo;
    $('#eu-nombre').value = u.nombre_completo || '';
    $('#eu-cedula').value = u.cedula || '';
    $('#eu-empresa').value = u.empresa || '';
    $('#eu-celular').value = u.celular || '';
    $('#eu-msg').textContent = '';
    $('#modal-editar-usuario').classList.remove('oculto');
}
$('#eu-cancelar').addEventListener('click', () => $('#modal-editar-usuario').classList.add('oculto'));
$('#modal-editar-usuario').addEventListener('click', (e) => { if (e.target.id === 'modal-editar-usuario') $('#modal-editar-usuario').classList.add('oculto'); });

$('#eu-confirmar').addEventListener('click', async () => {
    const correo = $('#eu-correo').value;
    const nombre_completo = $('#eu-nombre').value.trim();
    const cedula = $('#eu-cedula').value.trim();
    const empresa = $('#eu-empresa').value.trim();
    const celular = $('#eu-celular').value.trim();
    const msg = $('#eu-msg');
    const btn = $('#eu-confirmar');
    msg.textContent = '';
    if (!nombre_completo) { msg.textContent = 'Falta el nombre completo.'; return; }
    if (!cedula) { msg.textContent = 'Falta la cédula.'; return; }
    if (!empresa) { msg.textContent = 'Falta la empresa.'; return; }
    if (!celular) { msg.textContent = 'Falta el celular.'; return; }

    btn.disabled = true; btn.classList.add('cargando');
    const { error } = await supabase.from('usuarios')
        .update({ nombre_completo, cedula, empresa, celular }).eq('correo', correo);
    btn.disabled = false; btn.classList.remove('cargando');

    if (error) { msg.textContent = 'No se pudo guardar: ' + error.message; return; }
    toast(`Datos de "${correo}" actualizados.`);
    $('#modal-editar-usuario').classList.add('oculto');
    await cargarTodo();
});
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
$('#tbody-usuarios').addEventListener('click', async (e) => {
    const editar = e.target.closest('[data-editar-usuario]');
    if (editar) { abrirModalEditarUsuario(usuarios.find((u) => u.correo === editar.dataset.editarUsuario)); return; }

    const resetear = e.target.closest('[data-resetear-usuario]');
    if (resetear) {
        const correo = resetear.dataset.resetearUsuario;
        if (!confirm(`¿Generar una clave temporal nueva para "${correo}"? La clave actual deja de funcionar.`)) return;
        resetear.disabled = true;
        const { data, error } = await supabase.functions.invoke('resetear-clave', { body: { correo } });
        resetear.disabled = false;
        if (error || data?.error) { toast('No se pudo resetear: ' + (data?.error || error.message), 'error'); return; }
        if (data.email_enviado === false) {
            toast(`Clave temporal de "${correo}": ${data.password_temporal} (no se pudo mandar el correo, pasásela a mano)`, 'error');
        } else {
            toast(`Clave temporal generada y enviada a "${correo}".`);
        }
        await cargarTodo();
        return;
    }

    const borrar = e.target.closest('[data-borrar-usuario]');
    if (!borrar) return;
    const correo = borrar.dataset.borrarUsuario;
    if (!confirm(`¿Borrar la cuenta de "${correo}"? Pierde el acceso a TODAS las apps de la suite.`)) return;
    const { error } = await supabase.from('usuarios').delete().eq('correo', correo);
    if (error) { toast('No se pudo borrar: ' + error.message, 'error'); return; }
    await supabase.from('logs_seguridad').insert({ tipo: 'borrado', correo });
    toast(`Cuenta de "${correo}" borrada.`);
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
    $('#us-correo').value = '';
    $('#us-nombre').value = ''; $('#us-cedula').value = '';
    $('#us-empresa').value = ''; $('#us-celular').value = '';
    $('#us-msg').textContent = '';
    renderChecklistAppsUsuario();
    $('#modal-usuario').classList.remove('oculto');
});
$('#us-cancelar').addEventListener('click', () => $('#modal-usuario').classList.add('oculto'));
$('#modal-usuario').addEventListener('click', (e) => { if (e.target.id === 'modal-usuario') $('#modal-usuario').classList.add('oculto'); });

$('#us-confirmar').addEventListener('click', async () => {
    const correo = $('#us-correo').value.trim().toLowerCase();
    const nombre = $('#us-nombre').value.trim();
    const cedula = $('#us-cedula').value.trim();
    const empresa = $('#us-empresa').value.trim();
    const celular = $('#us-celular').value.trim();
    const msg = $('#us-msg');
    const btn = $('#us-confirmar');
    msg.textContent = '';
    if (!nombre) { msg.textContent = 'Falta el nombre completo.'; return; }
    if (!cedula) { msg.textContent = 'Falta la cédula.'; return; }
    if (!empresa) { msg.textContent = 'Falta la empresa.'; return; }
    if (!celular) { msg.textContent = 'Falta el celular.'; return; }
    if (!correo || !correo.includes('@')) { msg.textContent = 'Correo inválido.'; return; }
    if (usuarios.some((u) => u.correo === correo)) { msg.textContent = 'Ya existe una cuenta con ese correo.'; return; }

    const accesosElegidos = $$('#us-apps-lista [data-us-app]:checked').map((chk) => {
        const slug = chk.dataset.usApp;
        const cant = $(`[data-us-vc="${slug}"]`).value;
        const unidad = $(`[data-us-vu="${slug}"]`).value;
        return { app: slug, expira: calcularExpira(cant, unidad) };
    });

    btn.disabled = true; btn.classList.add('cargando');
    const { data, error } = await supabase.functions.invoke('crear-usuario', {
        body: { correo, nombre, cedula, empresa, celular, accesos: accesosElegidos },
    });
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
                <button class="btn-icono btn-icono-peligro" data-borrar-enlace="${en.id}" title="Borrar">🗑</button>
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

// ------------------------------------------------------------------ alumbrado público
// Vive DENTRO de la tarjeta expandida de "Aplicaciones" (ver SLUG_ALUMBRADO
// más arriba), no como sección propia -- por eso todo el HTML se arma en
// panelAlumbrado() como string, y los clicks se escuchan por delegación sobre
// #apps-grid (el contenedor NO se destruye; el markup de adentro sí, cada vez
// que se re-renderiza). Nada acá toca Firebase directo: todo pasa por la Edge
// Function 'alumbrado' -- ver edge-function-alumbrado.ts.
async function invocarAlumbrado(accion, datos = {}) {
    const { data, error } = await supabase.functions.invoke('alumbrado', { body: { accion, ...datos } });
    if (error || data?.error) throw new Error(data?.error || error.message);
    return data;
}

function panelAlumbrado() {
    return `
        <div class="app-panel alu-panel">
            <div class="subtabs">
                <button class="subtab-item ${aluSubtabActiva === 'dashboard' ? 'activo' : ''}" data-subtab-alumbrado="dashboard">Dashboard</button>
                <button class="subtab-item ${aluSubtabActiva === 'usuarios' ? 'activo' : ''}" data-subtab-alumbrado="usuarios">Usuarios técnicos</button>
                <button class="subtab-item ${aluSubtabActiva === 'configuracion' ? 'activo' : ''}" data-subtab-alumbrado="configuracion">Configuración</button>
                <button class="subtab-item ${aluSubtabActiva === 'zonas' ? 'activo' : ''}" data-subtab-alumbrado="zonas">Zonas</button>
                <button class="subtab-item ${aluSubtabActiva === 'proyectos' ? 'activo' : ''}" data-subtab-alumbrado="proyectos">Proyectos</button>
                <button class="subtab-item ${aluSubtabActiva === 'actividad' ? 'activo' : ''}" data-subtab-alumbrado="actividad">Actividad</button>
            </div>

            <div id="alu-tab-dashboard" class="alu-tab ${aluSubtabActiva === 'dashboard' ? '' : 'oculto'}">
                <div class="stats" id="alu-kpis"></div>
            </div>

            <div id="alu-tab-usuarios" class="alu-tab ${aluSubtabActiva === 'usuarios' ? '' : 'oculto'}">
                <div class="panel-head">
                    <h3>Usuarios técnicos (app móvil de campo)</h3>
                    <button id="alu-btn-crear-tecnico" class="btn-primario">+ Crear técnico</button>
                </div>
                <p class="nota-panel">Estas cuentas las usa la app móvil de los técnicos en campo (código +
                    contraseña). No tienen relación con los usuarios de la suite.</p>
                <div class="tabla-wrap">
                    <table id="alu-tabla-usuarios">
                        <thead><tr><th>Código</th><th>Nombre</th><th>Correo</th><th>Rol</th><th>Estado</th><th></th></tr></thead>
                        <tbody id="alu-tbody-usuarios"></tbody>
                    </table>
                    <p class="tabla-vacia oculto" id="alu-usuarios-vacio">Todavía no hay técnicos registrados.</p>
                </div>
            </div>

            <div id="alu-tab-configuracion" class="alu-tab ${aluSubtabActiva === 'configuracion' ? '' : 'oculto'}">
                <label class="campo">
                    <span>Correo administrador (recibe códigos de verificación)</span>
                    <input type="email" id="alu-correo-admin" placeholder="admin@cinco.com">
                </label>
                <label class="campo"><span>Correos destino (reciben el Excel/PDF cuando un técnico sincroniza)</span></label>
                <div id="alu-correos-lista" class="chips" style="max-width:none;"></div>
                <div class="vig-inline" style="margin:10px 0 16px;">
                    <input type="email" id="alu-nuevo-correo" placeholder="agregar correo...">
                    <button class="btn-icono" id="alu-btn-agregar-correo" title="Agregar">+</button>
                </div>
                <label class="campo">
                    <span>Municipios (uno por línea, lista desplegable de la app)</span>
                    <textarea id="alu-municipios" rows="8" placeholder="ACEVEDO&#10;AGRADO&#10;AIPE"></textarea>
                </label>
                <label class="campo">
                    <span>Tipos y potencias de luminaria (JSON -- mismo formato que la app original)</span>
                    <textarea id="alu-tipos-potencia" rows="10" placeholder='{"Mercurio": [125], "Ahorradores": [20, 25]}'></textarea>
                </label>
                <div class="modal-actions" style="justify-content:flex-start;">
                    <button id="alu-btn-guardar-config" class="btn-primario">Guardar configuración</button>
                </div>
                <p class="modal-msg" id="alu-config-msg"></p>
            </div>

            <div id="alu-tab-zonas" class="alu-tab ${aluSubtabActiva === 'zonas' ? '' : 'oculto'}">
                <div class="panel-head">
                    <h3>Zonas (aviso por correo según municipio)</h3>
                    <div class="panel-actions">
                        <button id="alu-btn-revisar-zonas" class="btn-secundario">🔄 Revisar ahora</button>
                        <button id="alu-btn-crear-zona" class="btn-primario">+ Crear zona</button>
                    </div>
                </div>
                <p class="nota-panel">Cuando se sincroniza un proyecto, se avisa por correo SOLO a la zona que
                    corresponda según el municipio del proyecto -- aparte de "Correos destino" en Configuración
                    (que sigue mandándole a todos, mientras se prueba este sistema nuevo). Se revisa automático
                    cada 15 minutos, o con el botón de arriba.</p>
                <div class="tabla-wrap">
                    <table id="alu-tabla-zonas">
                        <thead><tr><th>Zona</th><th>Municipios</th><th>Correos</th><th></th></tr></thead>
                        <tbody id="alu-tbody-zonas"></tbody>
                    </table>
                    <p class="tabla-vacia oculto" id="alu-zonas-vacio">Todavía no hay zonas creadas.</p>
                </div>
            </div>

            <div id="alu-tab-proyectos" class="alu-tab ${aluSubtabActiva === 'proyectos' ? '' : 'oculto'}">
                <div class="tabla-wrap">
                    <table id="alu-tabla-proyectos">
                        <thead><tr><th>Proyecto</th><th>Funcionario</th><th>Creado</th><th></th></tr></thead>
                        <tbody id="alu-tbody-proyectos"></tbody>
                    </table>
                    <p class="tabla-vacia oculto" id="alu-proyectos-vacio">No hay proyectos sincronizados todavía.</p>
                </div>
            </div>

            <div id="alu-tab-actividad" class="alu-tab ${aluSubtabActiva === 'actividad' ? '' : 'oculto'}">
                <div class="panel-head">
                    <h3>Actividad</h3>
                    <button id="alu-btn-borrar-actividad" class="btn-secundario btn-secundario-peligro">Borrar todo</button>
                </div>
                <div class="tabla-wrap">
                    <table id="alu-tabla-actividad">
                        <thead><tr><th>Acción</th><th>Detalle</th><th>Cuándo</th><th></th></tr></thead>
                        <tbody id="alu-tbody-actividad"></tbody>
                    </table>
                    <p class="tabla-vacia oculto" id="alu-actividad-vacio">Sin actividad todavía.</p>
                </div>
            </div>
        </div>`;
}

let aluSubtabActiva = 'dashboard';
function activarSubtabAlumbrado(nombre) {
    aluSubtabActiva = nombre;
    $$('.alu-tab').forEach((t) => t.classList.add('oculto'));
    $(`#alu-tab-${nombre}`)?.classList.remove('oculto');
    $$('[data-subtab-alumbrado]').forEach((b) => b.classList.toggle('activo', b.dataset.subtabAlumbrado === nombre));
    if (nombre === 'dashboard') cargarAluDashboard();
    if (nombre === 'usuarios') cargarAluUsuarios();
    if (nombre === 'configuracion') cargarAluConfiguracion();
    if (nombre === 'zonas') cargarAluZonas();
    if (nombre === 'proyectos') cargarAluProyectos();
    if (nombre === 'actividad') cargarAluActividad();
}

async function cargarAluDashboard() {
    const cont = $('#alu-kpis');
    cont.innerHTML = '<p class="grafica-vacia">Cargando…</p>';
    try {
        const { kpis } = await invocarAlumbrado('dashboard_kpis');
        cont.innerHTML = '';
        [
            { icono: '👷', valor: kpis.usuarios, label: 'Técnicos registrados' },
            { icono: '📁', valor: kpis.proyectos, label: 'Proyectos sincronizados' },
            { icono: '📍', valor: kpis.ubicaciones, label: 'Ubicaciones registradas' },
        ].forEach((it, i) => {
            const div = document.createElement('div');
            div.className = 'stat-card';
            div.style.animationDelay = `${i * 60}ms`;
            div.innerHTML = `<span class="stat-icono">${it.icono}</span>
                <span class="stat-valor">${it.valor}</span>
                <span class="stat-label">${it.label}</span>`;
            cont.appendChild(div);
            aplicarTilt(div, 4);
        });
    } catch (e) {
        cont.innerHTML = `<p class="grafica-vacia">No se pudo cargar: ${escapeHtml(e.message)}</p>`;
    }
}

// -------- usuarios técnicos (credenciales de la app móvil de campo)
let aluUsuariosCache = [];
let tecnicoEditando = null;

function etiquetaRolTecnico(r) { return { admin: 'Administrador', operador: 'Operador' }[r] || r || 'Técnico'; }

async function cargarAluUsuarios() {
    const tbody = $('#alu-tbody-usuarios');
    tbody.innerHTML = '<tr><td colspan="6">Cargando…</td></tr>';
    try {
        const { usuarios } = await invocarAlumbrado('listar_usuarios');
        aluUsuariosCache = usuarios || [];
        $('#alu-usuarios-vacio').classList.toggle('oculto', aluUsuariosCache.length > 0);
        tbody.innerHTML = aluUsuariosCache.map((u) => {
            const activo = u.activo !== false;
            return `
            <tr>
                <td>${escapeHtml(u.id)}</td>
                <td>${escapeHtml(u.nombre || '')}</td>
                <td>${escapeHtml(u.correo || '')}</td>
                <td><span class="chip">${escapeHtml(etiquetaRolTecnico(u.rol))}</span></td>
                <td><span class="tipo-tag ${activo ? 'tipo-login_ok' : 'tipo-login_fallido'}">${activo ? 'Activo' : 'Bloqueado'}</span></td>
                <td class="col-borrar">
                    <button class="btn-icono" data-editar-tecnico="${escapeHtml(u.id)}" title="Editar">✎</button>
                    <button class="btn-icono" data-bloquear-tecnico="${escapeHtml(u.id)}" data-activo="${activo}" title="${activo ? 'Bloquear' : 'Desbloquear'}">${activo ? '🔒' : '🔓'}</button>
                    <button class="btn-icono btn-icono-peligro" data-borrar-tecnico="${escapeHtml(u.id)}" title="Eliminar">🗑</button>
                </td>
            </tr>`;
        }).join('');
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="6">Error: ${escapeHtml(e.message)}</td></tr>`;
    }
}

function abrirModalTecnico(u = null) {
    tecnicoEditando = u;
    $('#tec-codigo').value = u?.id || '';
    $('#tec-nombre').value = u?.nombre || '';
    $('#tec-correo').value = u?.correo || '';
    $('#tec-contrasena').value = u?.contrasena || '';
    $('#tec-rol').value = u?.rol || 'operador';
    $('#tec-msg').textContent = '';
    $('#modal-tecnico').classList.remove('oculto');
}
$('#tec-cancelar').addEventListener('click', () => $('#modal-tecnico').classList.add('oculto'));
$('#modal-tecnico').addEventListener('click', (e) => { if (e.target.id === 'modal-tecnico') $('#modal-tecnico').classList.add('oculto'); });

$('#tec-confirmar').addEventListener('click', async () => {
    const codigo = $('#tec-codigo').value.trim();
    const nombre = $('#tec-nombre').value.trim();
    const correo = $('#tec-correo').value.trim();
    const contrasena = $('#tec-contrasena').value.trim();
    const rol = $('#tec-rol').value;
    const msg = $('#tec-msg');
    if (!codigo || !nombre || !correo || !contrasena) { msg.textContent = 'Completá todos los campos.'; return; }
    try {
        await invocarAlumbrado('guardar_usuario', {
            codigoOriginal: tecnicoEditando?.id || '', codigo, nombre, correo, contrasena, rol,
            activo: tecnicoEditando ? tecnicoEditando.activo !== false : true,
        });
        toast('Técnico guardado.');
        $('#modal-tecnico').classList.add('oculto');
        await cargarAluUsuarios();
    } catch (err) { msg.textContent = 'No se pudo guardar: ' + err.message; }
});

// -------- configuración (correos y catálogos)
let aluCorreosDestino = [];

async function cargarAluConfiguracion() {
    const msg = $('#alu-config-msg'); msg.textContent = '';
    try {
        const { configuracion } = await invocarAlumbrado('leer_configuracion');
        $('#alu-correo-admin').value = configuracion.correoAdmin || '';
        // municipios: uno por línea (igual que la app original). tiposPotencia: objeto
        // {categoría: [potencias]} -- se edita como JSON crudo, mismo formato de siempre.
        $('#alu-municipios').value = (configuracion.municipios || []).join('\n');
        $('#alu-tipos-potencia').value = JSON.stringify(configuracion.tiposPotencia || {}, null, 2);
        aluCorreosDestino = configuracion.correosDestino || [];
        pintarAluCorreos();
    } catch (e) {
        msg.textContent = 'No se pudo cargar: ' + e.message;
    }
}
function pintarAluCorreos() {
    $('#alu-correos-lista').innerHTML = aluCorreosDestino.map((c) => `
        <span class="chip">${escapeHtml(c)} <button class="chip-x" data-quitar-correo="${escapeHtml(c)}" title="Quitar">×</button></span>
    `).join('') || '<p class="grafica-vacia">Sin correos destino todavía.</p>';
}
async function guardarAluConfiguracion() {
    const msg = $('#alu-config-msg'); msg.textContent = '';
    const correoAdmin = $('#alu-correo-admin').value.trim();
    const municipios = $('#alu-municipios').value.split('\n').map((m) => m.trim()).filter(Boolean);
    let tiposPotencia;
    try {
        tiposPotencia = JSON.parse($('#alu-tipos-potencia').value.trim() || '{}');
    } catch {
        msg.textContent = 'El JSON de "Tipos y potencias" no es válido -- revisá comas/llaves.';
        return;
    }
    try {
        await invocarAlumbrado('guardar_configuracion', { correosDestino: aluCorreosDestino, correoAdmin, municipios, tiposPotencia });
        toast('Configuración guardada.');
    } catch (e) { msg.textContent = 'No se pudo guardar: ' + e.message; }
}

// -------- zonas (correo automático por municipio)
let aluZonasCache = [];
let zonaEditando = null;

async function cargarAluZonas() {
    const tbody = $('#alu-tbody-zonas');
    tbody.innerHTML = '<tr><td colspan="4">Cargando…</td></tr>';
    try {
        const { zonas } = await invocarAlumbrado('listar_zonas');
        aluZonasCache = zonas || [];
        $('#alu-zonas-vacio').classList.toggle('oculto', aluZonasCache.length > 0);
        tbody.innerHTML = aluZonasCache.map((z) => `
            <tr>
                <td>${escapeHtml(z.nombre)}</td>
                <td>${escapeHtml((z.municipios || []).join(', ') || '—')}</td>
                <td>${(z.correos || []).length} correo(s)</td>
                <td class="col-borrar">
                    <button class="btn-icono" data-editar-zona="${escapeHtml(z.id)}" title="Editar">✎</button>
                    <button class="btn-icono btn-icono-peligro" data-borrar-zona="${escapeHtml(z.id)}" title="Borrar">🗑</button>
                </td>
            </tr>`).join('');
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="4">Error: ${escapeHtml(e.message)}</td></tr>`;
    }
}

function slugZona(nombre) {
    return nombre.toLowerCase().trim()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // saca tildes
        .replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

function abrirModalZona(z = null) {
    zonaEditando = z;
    $('#zona-nombre').value = z?.nombre || '';
    $('#zona-municipios').value = (z?.municipios || []).join('\n');
    $('#zona-correos').value = (z?.correos || []).join('\n');
    $('#zona-msg').textContent = '';
    $('#modal-zona').classList.remove('oculto');
}
$('#zona-cancelar').addEventListener('click', () => $('#modal-zona').classList.add('oculto'));
$('#modal-zona').addEventListener('click', (e) => { if (e.target.id === 'modal-zona') $('#modal-zona').classList.add('oculto'); });

$('#zona-confirmar').addEventListener('click', async () => {
    const nombre = $('#zona-nombre').value.trim();
    const municipios = $('#zona-municipios').value.split('\n').map((m) => m.trim()).filter(Boolean);
    const correos = $('#zona-correos').value.split('\n').map((c) => c.trim()).filter(Boolean);
    const msg = $('#zona-msg');
    if (!nombre) { msg.textContent = 'Ponele un nombre a la zona.'; return; }
    const id = slugZona(nombre);
    try {
        await invocarAlumbrado('guardar_zona', { idOriginal: zonaEditando?.id || '', id, nombre, municipios, correos });
        toast('Zona guardada.');
        $('#modal-zona').classList.add('oculto');
        await cargarAluZonas();
    } catch (err) { msg.textContent = 'No se pudo guardar: ' + err.message; }
});

// -------- proyectos sincronizados
async function cargarAluProyectos() {
    const tbody = $('#alu-tbody-proyectos');
    tbody.innerHTML = '<tr><td colspan="4">Cargando…</td></tr>';
    try {
        const { proyectos } = await invocarAlumbrado('listar_proyectos');
        $('#alu-proyectos-vacio').classList.toggle('oculto', (proyectos || []).length > 0);
        tbody.innerHTML = (proyectos || []).map((p) => `
            <tr>
                <td>${escapeHtml(p.id)}</td>
                <td>${escapeHtml(p.nombreFuncionario || '')} (${escapeHtml(p.codigoFuncionario || '')})</td>
                <td class="col-fecha">${escapeHtml(p.fechaCreacion || '—')}</td>
                <td class="col-borrar">
                    <button class="btn-icono" data-descargar-proyecto="${escapeHtml(p.id)}" title="Descargar fotos (ZIP)">⬇</button>
                    <button class="btn-icono btn-icono-peligro" data-borrar-proyecto="${escapeHtml(p.id)}" title="Borrar">🗑</button>
                </td>
            </tr>`).join('');
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="4">Error: ${escapeHtml(e.message)}</td></tr>`;
    }
}

// Arma el ZIP en el navegador (JSZip, cargado en index.html como
// vendor-jszip.js): trae la lista de fotos con sus URLs de descarga (la
// Edge Function las arma con el token de Firebase Storage), las descarga acá
// mismo con fetch() y las empaqueta -- así no hay límite de tamaño/tiempo de
// la Edge Function, es directo navegador -> Firebase Storage.
async function descargarZipProyecto(nombreProyecto) {
    toast('Preparando descarga…');
    try {
        const { fotos } = await invocarAlumbrado('obtener_fotos_proyecto', { nombreProyecto });
        if (!fotos || !fotos.length) { toast('Ese proyecto no tiene fotos.', 'error'); return; }

        const zip = new window.JSZip();
        await Promise.all(fotos.map(async (f) => {
            const resp = await fetch(f.url);
            if (!resp.ok) return;
            zip.file(f.nombre, await resp.arrayBuffer());
        }));

        const blob = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `${nombreProyecto}.zip`;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
        toast('Descarga lista.');
    } catch (err) {
        toast('No se pudo descargar: ' + err.message, 'error');
    }
}

// -------- actividad
async function cargarAluActividad() {
    const tbody = $('#alu-tbody-actividad');
    tbody.innerHTML = '<tr><td colspan="4">Cargando…</td></tr>';
    try {
        const { logs } = await invocarAlumbrado('listar_logs');
        $('#alu-actividad-vacio').classList.toggle('oculto', (logs || []).length > 0);
        tbody.innerHTML = (logs || []).map((l) => `
            <tr>
                <td>${escapeHtml(l.accion || '')}</td>
                <td>${escapeHtml(l.detalle || '—')}</td>
                <td class="col-fecha">${l.fecha ? new Date(l.fecha).toLocaleString('es-CO') : '—'}</td>
                <td class="col-borrar"><button class="btn-icono btn-icono-peligro" data-borrar-log="${escapeHtml(l.id)}" title="Borrar">🗑</button></td>
            </tr>`).join('');
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="4">Error: ${escapeHtml(e.message)}</td></tr>`;
    }
}
// -------- clicks del panel de Alumbrado, todos delegados sobre #apps-grid
// (el markup de panelAlumbrado() se recrea en cada renderAplicaciones(), así
// que un listener puesto directo sobre un botón de adentro se perdería en el
// próximo repintado -- ver comentario al inicio de esta sección).
$('#apps-grid').addEventListener('click', async (e) => {
    const subtab = e.target.closest('[data-subtab-alumbrado]');
    if (subtab) { activarSubtabAlumbrado(subtab.dataset.subtabAlumbrado); return; }

    if (e.target.closest('#alu-btn-crear-tecnico')) { abrirModalTecnico(); return; }

    const editarTec = e.target.closest('[data-editar-tecnico]');
    if (editarTec) { abrirModalTecnico(aluUsuariosCache.find((u) => u.id === editarTec.dataset.editarTecnico)); return; }

    const bloquearTec = e.target.closest('[data-bloquear-tecnico]');
    if (bloquearTec) {
        const codigo = bloquearTec.dataset.bloquearTecnico;
        const activoActual = bloquearTec.dataset.activo === 'true';
        try {
            await invocarAlumbrado('alternar_bloqueo_usuario', { codigo, activoActual });
            toast(activoActual ? `"${codigo}" bloqueado.` : `"${codigo}" desbloqueado.`);
            await cargarAluUsuarios();
        } catch (err) { toast('No se pudo actualizar: ' + err.message, 'error'); }
        return;
    }

    const borrarTec = e.target.closest('[data-borrar-tecnico]');
    if (borrarTec) {
        const codigo = borrarTec.dataset.borrarTecnico;
        if (!confirm(`¿Eliminar el técnico "${codigo}"? Perderá acceso a la app móvil en su próxima sincronización.`)) return;
        try {
            await invocarAlumbrado('borrar_usuario', { codigo });
            toast(`Técnico "${codigo}" eliminado.`);
            await cargarAluUsuarios();
        } catch (err) { toast('No se pudo borrar: ' + err.message, 'error'); }
        return;
    }

    const quitarCorreo = e.target.closest('[data-quitar-correo]');
    if (quitarCorreo) {
        aluCorreosDestino = aluCorreosDestino.filter((c) => c !== quitarCorreo.dataset.quitarCorreo);
        pintarAluCorreos();
        return;
    }

    if (e.target.closest('#alu-btn-agregar-correo')) {
        const input = $('#alu-nuevo-correo');
        const correo = input.value.trim();
        if (!correo || !correo.includes('@') || aluCorreosDestino.includes(correo)) { input.value = ''; return; }
        aluCorreosDestino.push(correo);
        input.value = '';
        pintarAluCorreos();
        return;
    }

    if (e.target.closest('#alu-btn-guardar-config')) { await guardarAluConfiguracion(); return; }

    if (e.target.closest('#alu-btn-crear-zona')) { abrirModalZona(); return; }

    const editarZona = e.target.closest('[data-editar-zona]');
    if (editarZona) { abrirModalZona(aluZonasCache.find((z) => z.id === editarZona.dataset.editarZona)); return; }

    const borrarZona = e.target.closest('[data-borrar-zona]');
    if (borrarZona) {
        const id = borrarZona.dataset.borrarZona;
        const z = aluZonasCache.find((x) => x.id === id);
        if (!z || !confirm(`¿Borrar la zona "${z.nombre}"?`)) return;
        try {
            await invocarAlumbrado('borrar_zona', { id });
            toast('Zona borrada.');
            await cargarAluZonas();
        } catch (err) { toast('No se pudo borrar: ' + err.message, 'error'); }
        return;
    }

    if (e.target.closest('#alu-btn-revisar-zonas')) {
        const btn = $('#alu-btn-revisar-zonas');
        btn.disabled = true;
        try {
            const r = await invocarAlumbrado('revisar_proyectos_pendientes');
            toast(`Revisado: ${r.avisados} avisado(s), ${r.sinZona} sin zona todavía, de ${r.revisados} pendiente(s).`);
        } catch (err) {
            toast('No se pudo revisar: ' + err.message, 'error');
        } finally {
            btn.disabled = false;
        }
        return;
    }

    const descargarProyecto = e.target.closest('[data-descargar-proyecto]');
    if (descargarProyecto) { await descargarZipProyecto(descargarProyecto.dataset.descargarProyecto); return; }

    const borrarProyecto = e.target.closest('[data-borrar-proyecto]');
    if (borrarProyecto) {
        const nombreProyecto = borrarProyecto.dataset.borrarProyecto;
        if (!confirm(`¿Borrar el proyecto "${nombreProyecto}" y sus fotos? Esto no se puede deshacer.`)) return;
        try {
            await invocarAlumbrado('borrar_proyecto', { nombreProyecto });
            toast('Proyecto borrado.');
            await cargarAluProyectos();
        } catch (err) { toast('No se pudo borrar: ' + err.message, 'error'); }
        return;
    }

    const borrarLog = e.target.closest('[data-borrar-log]');
    if (borrarLog) {
        try {
            await invocarAlumbrado('borrar_log', { id: borrarLog.dataset.borrarLog });
            await cargarAluActividad();
        } catch (err) { toast('No se pudo borrar: ' + err.message, 'error'); }
        return;
    }

    if (e.target.closest('#alu-btn-borrar-actividad')) {
        if (!confirm('¿Borrar TODA la actividad registrada? Esto no se puede deshacer.')) return;
        try {
            await invocarAlumbrado('borrar_toda_actividad');
            toast('Actividad borrada.');
            await cargarAluActividad();
        } catch (err) { toast('No se pudo borrar: ' + err.message, 'error'); }
    }
});

intentarSesion();
