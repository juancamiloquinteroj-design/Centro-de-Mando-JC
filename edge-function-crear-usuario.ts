// edge-function-crear-usuario.ts
// =============================================================================
// Edge Function 'crear-usuario' de Supabase (Deno). Crea una cuenta nueva en
// la tabla 'usuarios' (el esquema custom de login que usan las apps de la
// suite, NO Supabase Auth), le otorga acceso opcional a una o más apps, y le
// manda un correo de bienvenida con una contraseña temporal + los links de
// descarga correspondientes, vía Resend.
//
// Flujo:
//   1. Verifica que quien llama esté logueado Y sea administrador (igual que
//      la función 'cerebro').
//   2. Valida el correo y que no exista ya en 'usuarios'.
//   3. Genera contraseña temporal + salt + hash.
//   4. Inserta usuario (requiere_cambio_clave = true) y los accesos pedidos,
//      usando la SERVICE ROLE KEY (no el JWT del admin) -- así las columnas
//      salt/hash nunca quedan expuestas a un grant directo del cliente.
//   5. Junta los enlaces de descarga de las apps otorgadas.
//   6. Manda el correo de bienvenida con Resend. Si falla, el usuario queda
//      creado igual -- se devuelve la contraseña en la respuesta para que el
//      admin la copie a mano.
//   7. Registra el alta en logs_seguridad.
//
// CÓMO PUBLICARLA (sin instalar nada local, igual que 'cerebro'):
//   1. Supabase Dashboard -> Edge Functions -> Create a new function -> "crear-usuario".
//   2. Pegá todo este archivo y Deploy.
//   3. Dashboard -> Edge Functions -> Secrets -> agregá RESEND_API_KEY (ver
//      resend.com). SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY ya están
//      disponibles automáticamente, no hace falta cargarlas a mano.
//
// Requiere haber corrido supabase_centro_mando_v2.sql en el proyecto.
//
// RIESGO CONOCIDO -- el algoritmo de hash de abajo (sha256(salt+password))
// es un SUPUESTO: no tuvimos acceso al 'seguridad.py' real de las apps de la
// suite para confirmar que coincide. Si la contraseña temporal no sirve para
// entrar a una app real, hay que ajustar SOLO la función calcularHash() de
// acá para que coincida con lo que valida cada app.
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;

const CABECERAS_CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const jsonRespuesta = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { ...CABECERAS_CORS, "Content-Type": "application/json" } });

const REGEX_CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function generarPassword(longitud = 12): string {
    // Sin caracteres ambiguos (0/O, 1/l/I) para que se pueda transcribir a mano sin errores.
    const alfabeto = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%";
    const bytes = new Uint8Array(longitud);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => alfabeto[b % alfabeto.length]).join("");
}

function generarSalt(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Ver aviso de riesgo en la cabecera del archivo: este esquema (sha256 de
// salt+password concatenados, en hex) es un supuesto pendiente de validar
// contra el seguridad.py real de las apps de la suite.
async function calcularHash(salt: string, password: string): Promise<string> {
    const bytes = new TextEncoder().encode(salt + password);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function enviarCorreo(destinatario: string, asunto: string, html: string) {
    const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        // TODO: cambiar el remitente a un dominio propio verificado en Resend
        // en cuanto lo tengan -- en modo sandbox (onboarding@resend.dev) solo
        // le llega a la cuenta de Resend registrada, no a usuarios reales.
        body: JSON.stringify({ from: "Centro de Mando JC <onboarding@resend.dev>", to: [destinatario], subject: asunto, html }),
    });
    if (!resp.ok) throw new Error(`Resend respondió ${resp.status}: ${await resp.text()}`);
}

function armarCorreoBienvenida(correo: string, password: string, enlacesPorApp: Map<string, { nombre: string; url: string }[]>): string {
    const bloquesApps = Array.from(enlacesPorApp.entries()).map(([nombreApp, links]) => {
        const items = links.length
            ? links.map((l) => `<li><a href="${l.url}">${l.nombre}</a></li>`).join("")
            : `<li>El instalador te lo comparte tu administrador.</li>`;
        return `<p style="margin:16px 0 4px"><b>${nombreApp}</b></p><ul style="margin:4px 0">${items}</ul>`;
    }).join("");

    return `
        <div style="font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.5">
            <h2>Bienvenido al Centro de Mando JC</h2>
            <p>Se creó tu cuenta para acceder a la suite de aplicaciones de CINCO S.A.S.</p>
            <p><b>Correo:</b> ${correo}<br><b>Contraseña temporal:</b> <code style="font-size:15px">${password}</code></p>
            <p>Por seguridad, al ingresar por primera vez el sistema te va a pedir que la cambies.</p>
            ${bloquesApps || "<p>Todavía no tenés acceso a ninguna app -- pedile a tu administrador que te lo otorgue.</p>"}
            <p style="margin-top:24px;color:#666;font-size:12px">Si no esperabas este correo, avisale a tu administrador.</p>
        </div>`;
}

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

        const body = await req.json();
        const correo = String(body?.correo ?? "").trim().toLowerCase();
        const accesos: { app: string; expira: string | null }[] = Array.isArray(body?.accesos) ? body.accesos : [];

        if (!REGEX_CORREO.test(correo)) return jsonRespuesta({ error: "Correo inválido." }, 400);

        // service role: bypassa RLS a propósito, es la única puerta de
        // escritura a salt/hash (ver aviso en la cabecera del archivo).
        const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

        const { data: existente } = await supabaseAdmin.from("usuarios").select("correo").eq("correo", correo).maybeSingle();
        if (existente) return jsonRespuesta({ error: "Ya existe una cuenta con ese correo." }, 409);

        const password = generarPassword();
        const salt = generarSalt();
        const hash = await calcularHash(salt, password);

        const { error: errUsuario } = await supabaseAdmin.from("usuarios")
            .insert({ correo, salt, hash, bloqueado: false, requiere_cambio_clave: true });
        if (errUsuario) return jsonRespuesta({ error: `No se pudo crear el usuario: ${errUsuario.message}` }, 500);

        const appsOtorgadas = accesos.map((a) => a.app).filter(Boolean);
        if (appsOtorgadas.length) {
            const { error: errAccesos } = await supabaseAdmin.from("accesos")
                .insert(accesos.map((a) => ({ correo, app: a.app, expira: a.expira ?? null })));
            if (errAccesos) return jsonRespuesta({ error: `Usuario creado, pero no se pudo otorgar el acceso: ${errAccesos.message}` }, 500);
        }

        // links de descarga de las apps otorgadas, agrupados por nombre visible de la app
        const enlacesPorApp = new Map<string, { nombre: string; url: string }[]>();
        if (appsOtorgadas.length) {
            const { data: appsInfo } = await supabaseAdmin.from("apps").select("slug,nombre").in("slug", appsOtorgadas);
            const { data: enlaces } = await supabaseAdmin.from("enlaces_apps")
                .select("app,nombre,url").in("app", appsOtorgadas).order("orden");
            for (const a of appsInfo ?? []) enlacesPorApp.set(a.nombre, []);
            for (const e of enlaces ?? []) {
                const nombreApp = appsInfo?.find((a) => a.slug === e.app)?.nombre ?? e.app;
                enlacesPorApp.get(nombreApp)?.push({ nombre: e.nombre, url: e.url });
            }
        }

        await supabaseAdmin.from("logs_seguridad").insert({
            tipo: "usuario_creado", correo,
            detalle: appsOtorgadas.length ? `apps: ${appsOtorgadas.join(", ")}` : "sin apps iniciales",
        });

        let emailEnviado = true;
        try {
            await enviarCorreo(correo, "Bienvenido al Centro de Mando JC", armarCorreoBienvenida(correo, password, enlacesPorApp));
        } catch {
            emailEnviado = false;
        }

        return jsonRespuesta(emailEnviado
            ? { ok: true, correo, email_enviado: true }
            : { ok: true, correo, email_enviado: false, password_temporal: password });
    } catch (e) {
        return jsonRespuesta({ error: `Error inesperado: ${e instanceof Error ? e.message : e}` }, 500);
    }
});
