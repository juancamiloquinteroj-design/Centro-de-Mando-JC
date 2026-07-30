// edge-function-alumbrado.ts
// =============================================================================
// Edge Function 'alumbrado' de Supabase (Deno). Puente seguro entre el panel
// de Centro de Mando y el Firestore/Storage de "Alumbrado Público" (proyecto
// Firebase 'inventario-ap-cinco', repo original: Alumbrado-final-).
//
// POR QUÉ EXISTE ESTA FUNCIÓN (no llamamos a Firebase directo desde el
// navegador): Alumbrado Público es un backend de Firebase completamente
// aparte del de esta suite (que usa Supabase). Su Firestore exige una sesión
// de Firebase Auth para leer/escribir -- si el navegador llamara directo,
// habría que o (a) exponer credenciales de un admin de Firebase en el JS
// público de este sitio (cualquiera que vea el código fuente se las roba), o
// (b) mostrar una segunda pantalla de login aparte, que es justo lo que se
// quiere evitar al fusionar todo en un solo panel. En cambio, esta función
// corre del lado del servidor con una cuenta de servicio de Firebase (nunca
// llega al navegador) y el navegador solo habla con ESTA función, protegida
// igual que las demás (rpc_soy_admin()).
//
// IMPORTANTE -- Esto NO migra ni toca ningún dato de Firestore/Storage. Lee y
// escribe EXACTAMENTE las mismas colecciones/campos que ya usaba
// Alumbrado-final-, incluida la colección 'usuarios' (código/nombre/correo/
// contraseña en texto plano/rol) que es la que valida el login de la app
// móvil real que usan los técnicos en campo -- se preserva tal cual para no
// romperla. Cifrar esa contraseña queda pendiente para cuando también se
// pueda actualizar esa app móvil (fuera de alcance acá, no tenemos su código).
//
// CÓMO HABLA CON FIREBASE -- SIN el SDK 'firebase-admin' (se probó primero
// con ese SDK y la función se colgaba ~55s hasta caer en timeout: su cliente
// de Firestore usa gRPC, que no corre bien en el runtime Deno de las Edge
// Functions de Supabase). En cambio, esto llama DIRECTO a las APIs REST de
// Firestore y Cloud Storage con 'fetch', autenticado con un token OAuth2 que
// se saca firmando un JWT con la clave privada de la cuenta de servicio (Web
// Crypto, sin dependencias externas). Mismo resultado, sin la librería que
// causaba el cuelgue.
//
// CÓMO PUBLICARLA:
//   1. Firebase Console (proyecto inventario-ap-cinco) -> ⚙ Configuración del
//      proyecto -> Cuentas de servicio -> Generar nueva clave privada
//      -> descarga un JSON.
//   2. Supabase Dashboard -> Edge Functions -> Secrets -> agregá
//      FIREBASE_SERVICE_ACCOUNT_JSON pegando TODO el contenido de ese JSON.
//   3. Dashboard -> Edge Functions -> "alumbrado" -> pegá este archivo -> Deploy.
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const CUENTA_SERVICIO = JSON.parse(Deno.env.get("FIREBASE_SERVICE_ACCOUNT_JSON")!);

const PROJECT_ID = CUENTA_SERVICIO.project_id;
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const STORAGE_BUCKET = "inventario-ap-cinco.firebasestorage.app";

const CABECERAS_CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const jsonRespuesta = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { ...CABECERAS_CORS, "Content-Type": "application/json" } });

// ----------------------------------------------------------------- auth OAuth2
// Un solo token por instancia "caliente" de la función -- se reusa mientras
// no esté por vencer, para no firmar un JWT nuevo en cada operación.
let tokenCache: { token: string; exp: number } | null = null;

function base64urlDeArrayBuffer(buf: ArrayBuffer): string {
    let binaria = "";
    for (const b of new Uint8Array(buf)) binaria += String.fromCharCode(b);
    return btoa(binaria).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlDeTexto(texto: string): string {
    return base64urlDeArrayBuffer(new TextEncoder().encode(texto));
}
function pemAArrayBuffer(pem: string): ArrayBuffer {
    const base64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
    const binaria = atob(base64);
    const bytes = new Uint8Array(binaria.length);
    for (let i = 0; i < binaria.length; i++) bytes[i] = binaria.charCodeAt(i);
    return bytes.buffer;
}

async function obtenerTokenAcceso(): Promise<string> {
    const ahora = Math.floor(Date.now() / 1000);
    if (tokenCache && tokenCache.exp - 60 > ahora) return tokenCache.token;

    const encabezado = base64urlDeTexto(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const cuerpo = base64urlDeTexto(JSON.stringify({
        iss: CUENTA_SERVICIO.client_email,
        scope: "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/devstorage.read_write",
        aud: "https://oauth2.googleapis.com/token",
        exp: ahora + 3600,
        iat: ahora,
    }));
    const sinFirmar = `${encabezado}.${cuerpo}`;

    const clave = await crypto.subtle.importKey(
        "pkcs8",
        pemAArrayBuffer(CUENTA_SERVICIO.private_key),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const firma = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", clave, new TextEncoder().encode(sinFirmar));
    const jwt = `${sinFirmar}.${base64urlDeArrayBuffer(firma)}`;

    const resp = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${jwt}`,
    });
    if (!resp.ok) throw new Error(`No se pudo autenticar con Firebase: ${resp.status} ${await resp.text()}`);
    const data = await resp.json();
    tokenCache = { token: data.access_token, exp: ahora + data.expires_in };
    return data.access_token;
}

// -------------------------------------------------------- Firestore (REST v1)
// Firestore representa cada valor como {stringValue}/{integerValue}/etc -- acá
// se traduce ida y vuelta a JSON plano para no ensuciar el resto del código.
function aFirestoreValue(v: unknown): unknown {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === "string") return { stringValue: v };
    if (typeof v === "boolean") return { booleanValue: v };
    if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(aFirestoreValue) } };
    if (typeof v === "object") return { mapValue: { fields: aFirestoreFields(v as Record<string, unknown>) } };
    return { stringValue: String(v) };
}
function aFirestoreFields(obj: Record<string, unknown>): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(obj)) fields[k] = aFirestoreValue(val);
    return fields;
}
// deno-lint-ignore no-explicit-any
function deFirestoreValue(v: any): unknown {
    if (!v) return null;
    if ("stringValue" in v) return v.stringValue;
    if ("booleanValue" in v) return v.booleanValue;
    if ("integerValue" in v) return Number(v.integerValue);
    if ("doubleValue" in v) return v.doubleValue;
    if ("timestampValue" in v) return v.timestampValue;
    if ("arrayValue" in v) return (v.arrayValue.values || []).map(deFirestoreValue);
    if ("mapValue" in v) return deFirestoreFields(v.mapValue.fields || {});
    return null;
}
// deno-lint-ignore no-explicit-any
function deFirestoreFields(fields: Record<string, any>): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) obj[k] = deFirestoreValue(v);
    return obj;
}
function docIdDeNombre(name: string): string {
    return name.split("/").pop()!;
}

async function firestoreFetch(path: string, opciones: RequestInit = {}) {
    const token = await obtenerTokenAcceso();
    const resp = await fetch(`${FIRESTORE_BASE}${path}`, {
        ...opciones,
        headers: { ...(opciones.headers || {}), Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    if (!resp.ok) throw new Error(`Firestore respondió ${resp.status}: ${await resp.text()}`);
    return resp.status === 204 ? null : await resp.json();
}

// Trae todos los documentos de una colección (pagina sola si hace falta), o
// solo los primeros `pageSize` si se pide explícito (ej. "últimos 150 logs").
async function listarColeccion(coleccion: string, opciones: { orderBy?: string; pageSize?: number } = {}) {
    // deno-lint-ignore no-explicit-any
    let resultados: any[] = [];
    let pageToken: string | undefined;
    do {
        const params = new URLSearchParams();
        if (opciones.orderBy) params.set("orderBy", opciones.orderBy);
        params.set("pageSize", String(opciones.pageSize ?? 300));
        if (pageToken) params.set("pageToken", pageToken);
        const data = await firestoreFetch(`/${coleccion}?${params.toString()}`);
        const docs = data.documents || [];
        resultados = resultados.concat(docs.map((d: { name: string; fields?: Record<string, unknown> }) =>
            ({ id: docIdDeNombre(d.name), ...deFirestoreFields(d.fields || {}) })));
        pageToken = data.nextPageToken;
        if (opciones.pageSize) break; // límite explícito -- no seguir paginando de más
    } while (pageToken);
    return resultados;
}

async function obtenerDoc(ruta: string): Promise<Record<string, unknown> | null> {
    try {
        const data = await firestoreFetch(`/${ruta}`);
        return deFirestoreFields(data.fields || {});
    } catch (e) {
        if (String(e).includes("404")) return null;
        throw e;
    }
}

// Sin `camposAMezclar`: reemplaza el documento entero (equivalente a .set()).
// Con `camposAMezclar`: solo toca esos campos (equivalente a .set({merge:true})).
async function escribirDoc(ruta: string, datos: Record<string, unknown>, camposAMezclar?: string[]) {
    const fields = aFirestoreFields(datos);
    let path = `/${ruta}`;
    if (camposAMezclar) {
        path += `?${camposAMezclar.map((c) => `updateMask.fieldPaths=${encodeURIComponent(c)}`).join("&")}`;
    }
    await firestoreFetch(path, { method: "PATCH", body: JSON.stringify({ fields }) });
}

async function borrarDoc(ruta: string) {
    await firestoreFetch(`/${ruta}`, { method: "DELETE" });
}

// ------------------------------------------------------------------ Storage
async function listarArchivosStorage(prefix: string): Promise<string[]> {
    const token = await obtenerTokenAcceso();
    const resp = await fetch(`https://storage.googleapis.com/storage/v1/b/${STORAGE_BUCKET}/o?prefix=${encodeURIComponent(prefix)}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    // deno-lint-ignore no-explicit-any
    return (data.items || []).map((i: any) => i.name as string);
}
async function borrarArchivoStorage(nombre: string) {
    const token = await obtenerTokenAcceso();
    await fetch(`https://storage.googleapis.com/storage/v1/b/${STORAGE_BUCKET}/o/${encodeURIComponent(nombre)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
}

// =============================================================================
Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CABECERAS_CORS });

    try {
        const authHeader = req.headers.get("Authorization") ?? "";
        const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            global: { headers: { Authorization: authHeader } },
        });

        const { data: { user } } = await supabaseAuth.auth.getUser();
        if (!user) return jsonRespuesta({ error: "No autenticado." }, 401);

        const { data: esAdmin } = await supabaseAuth.rpc("rpc_soy_admin");
        if (!esAdmin) return jsonRespuesta({ error: "Esta cuenta no tiene permisos de administrador." }, 403);

        const { accion, ...datos } = await req.json();

        switch (accion) {
            // ---------------------------------------------------------- usuarios (técnicos)
            case "listar_usuarios": {
                const usuarios = await listarColeccion("usuarios");
                return jsonRespuesta({ ok: true, usuarios });
            }
            case "guardar_usuario": {
                const { codigoOriginal, codigo, nombre, correo, contrasena, rol, activo } = datos;
                if (!codigo || !nombre || !correo || !contrasena) {
                    return jsonRespuesta({ error: "Completá todos los campos." }, 400);
                }
                const registro = { codigo, nombre, correo, contrasena, rol: rol || "tecnico", activo: activo !== false };
                await escribirDoc(`usuarios/${codigo}`, registro);
                if (codigoOriginal && codigoOriginal !== codigo) await borrarDoc(`usuarios/${codigoOriginal}`);
                return jsonRespuesta({ ok: true });
            }
            case "alternar_bloqueo_usuario": {
                const { codigo, activoActual } = datos;
                await escribirDoc(`usuarios/${codigo}`, { activo: !activoActual }, ["activo"]);
                return jsonRespuesta({ ok: true });
            }
            case "borrar_usuario": {
                const { codigo } = datos;
                await borrarDoc(`usuarios/${codigo}`);
                return jsonRespuesta({ ok: true });
            }

            // ------------------------------------------------------------- configuración
            case "leer_configuracion": {
                const configuracion = (await obtenerDoc("configuracion/general")) || {};
                return jsonRespuesta({ ok: true, configuracion });
            }
            case "guardar_configuracion": {
                const { correosDestino, correoAdmin, municipios, tiposPotencia } = datos;
                await escribirDoc("configuracion/general", {
                    correosDestino: correosDestino || [], correoAdmin: correoAdmin || "",
                    municipios: municipios || [], tiposPotencia: tiposPotencia || {},
                }, ["correosDestino", "correoAdmin", "municipios", "tiposPotencia"]);
                return jsonRespuesta({ ok: true });
            }

            // -------------------------------------------------------------- proyectos
            case "listar_proyectos": {
                const proyectos = await listarColeccion("proyectos");
                return jsonRespuesta({ ok: true, proyectos });
            }
            case "borrar_proyecto": {
                const { nombreProyecto } = datos;
                const archivos = await listarArchivosStorage(`proyectos/${nombreProyecto}/`);
                await Promise.all(archivos.map(borrarArchivoStorage));
                await borrarDoc(`proyectos/${nombreProyecto}`);
                return jsonRespuesta({ ok: true });
            }

            // --------------------------------------------------------------- actividad
            case "listar_logs": {
                const logs = await listarColeccion("logs", { orderBy: "fecha desc", pageSize: 150 });
                return jsonRespuesta({ ok: true, logs });
            }
            case "borrar_log": {
                const { id } = datos;
                await borrarDoc(`logs/${id}`);
                return jsonRespuesta({ ok: true });
            }
            case "borrar_toda_actividad": {
                const logs = await listarColeccion("logs");
                await Promise.all(logs.map((l) => borrarDoc(`logs/${l.id}`)));
                return jsonRespuesta({ ok: true });
            }

            // --------------------------------------------------------------- dashboard
            case "dashboard_kpis": {
                const [usuarios, proyectos, ubicaciones] = await Promise.all([
                    listarColeccion("usuarios"),
                    listarColeccion("proyectos"),
                    listarColeccion("ubicaciones"),
                ]);
                return jsonRespuesta({
                    ok: true,
                    kpis: { usuarios: usuarios.length, proyectos: proyectos.length, ubicaciones: ubicaciones.length },
                });
            }

            default:
                return jsonRespuesta({ error: `Acción desconocida: ${accion}` }, 400);
        }
    } catch (e) {
        return jsonRespuesta({ error: `Error inesperado: ${e instanceof Error ? e.message : e}` }, 500);
    }
});
