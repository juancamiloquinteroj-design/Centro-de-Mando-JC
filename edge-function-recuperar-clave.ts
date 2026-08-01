// edge-function-recuperar-clave.ts
// =============================================================================
// Edge Function 'recuperar-clave' de Supabase (Deno). A diferencia de
// 'resetear-clave' (que requiere sesión de administrador), esta es PÚBLICA:
// cualquier app de la suite la puede llamar con la anon key para que un
// usuario recupere su propio acceso ("olvidé mi contraseña"), sin que un
// admin tenga que intervenir.
//
// Seguridad: la respuesta es SIEMPRE la misma (ok:true) exista o no el
// correo, tenga o no acceso a la app -- así nadie puede usar este endpoint
// para averiguar qué correos están registrados. El correo con la clave
// temporal solo se manda si de verdad existe la cuenta, tiene acceso a esa
// app, y no está bloqueada.
//
// CÓMO PUBLICARLA: Dashboard -> Edge Functions -> Create a new function ->
// "recuperar-clave" -> pegar y Deploy. Mismos secrets que crear-usuario /
// resetear-clave, no hace falta agregar nada.
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GMAIL_USER = Deno.env.get("GMAIL_USER")!;
const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD")!;
const LOGO_CINCO_URL = "https://juancamiloquinteroj-design.github.io/Aplicaciones-CINCO/perdidas-tecnicas/assets/logo_cinco.png";


const CABECERAS_CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const RESPUESTA_GENERICA = { ok: true, mensaje: "Si el correo está registrado y tiene acceso, va a recibir un mensaje." };
const jsonRespuesta = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { ...CABECERAS_CORS, "Content-Type": "application/json" } });

const REGEX_CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function generarPassword(longitud = 12): string {
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

async function calcularHash(salt: string, password: string): Promise<string> {
    const saltBytes = new Uint8Array(salt.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
    const clave = await crypto.subtle.importKey(
        "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations: 200000 },
        clave, 256);
    return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, "0")).join("");
}

function escapeHtml(s: string): string {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

async function enviarCorreo(destinatario: string, asunto: string, html: string) {
    const client = new SMTPClient({
        connection: {
            hostname: "smtp.gmail.com",
            port: 465,
            tls: true,
            auth: { username: GMAIL_USER, password: GMAIL_APP_PASSWORD },
        },
    });
    try {
        await client.send({
            from: `CINCO S.A.S. <${GMAIL_USER}>`,
            to: destinatario,
            subject: asunto,
            content: "Tu cliente de correo no muestra HTML -- pedile a tu administrador los datos por otro medio.",
            html,
        });
    } finally {
        try { await client.close(); } catch { /* no hay conexión que cerrar */ }
    }
}

function armarCorreoRecuperacion(correo: string, password: string): string {
    return `
    <div style="background:#f4f5f7;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #E2E8F0;">
        <tr>
          <td style="background:#ffffff;padding:20px 28px;border-bottom:3px solid #F97316;">
            <table role="presentation" style="border-collapse:collapse;"><tr>
              <td style="vertical-align:middle;"><img src="${LOGO_CINCO_URL}" alt="CINCO S.A.S." style="height:44px;display:block;"></td>
              <td style="vertical-align:middle;padding-left:14px;">
                <div style="color:#1a1a1a;font-size:16px;font-weight:bold;">CINCO S.A.S.</div>
                <div style="color:#999;font-size:11px;">Construcción, Ingeniería y Consultoría</div>
              </td>
            </tr></table>
          </td>
        </tr>
        <tr><td style="padding:28px;color:#2b2b2b;font-size:14px;line-height:1.6;">
          <h2 style="margin:0 0 12px;font-size:19px;color:#1a1a1a;">Recuperación de contraseña</h2>
          <p style="margin:0 0 20px;">Recibimos una solicitud para restablecer la contraseña de tu cuenta. A continuación encontrarás una contraseña temporal para ingresar nuevamente.</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F5F7;border-radius:10px;margin:0 0 20px;">
            <tr><td style="padding:16px 20px;">
              <p style="margin:0 0 3px;font-size:11px;color:#999999;text-transform:uppercase;letter-spacing:.5px;">Correo</p>
              <p style="margin:0 0 14px;font-size:14px;font-weight:bold;color:#1a1a1a;">${escapeHtml(correo)}</p>
              <p style="margin:0 0 3px;font-size:11px;color:#999999;text-transform:uppercase;letter-spacing:.5px;">Contraseña temporal</p>
              <p style="margin:0;font-size:19px;font-weight:bold;letter-spacing:1px;font-family:'Courier New',monospace;color:#F97316;">${escapeHtml(password)}</p>
            </td></tr>
          </table>
          <p style="margin:0 0 24px;padding:12px 16px;background:#FFF3E0;border-left:3px solid #F97316;font-size:13px;color:#7A4A00;border-radius:0 6px 6px 0;">
            🔒 Al ingresar el sistema te va a pedir que la cambies.
          </p>
          <p style="margin:28px 0 0;font-size:11.5px;color:#999999;border-top:1px solid #eeeeee;padding-top:16px;">Si tú no solicitaste este cambio, alguien más podría estar intentando acceder a tu cuenta: ignora este mensaje y avísale a tu administrador.</p>
        </td></tr>
      </table>
      <p style="text-align:center;color:#999999;font-size:11px;margin:16px 0 0;">Sistema automatizado &middot; CINCO S.A.S.</p>
    </div>`;
}

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CABECERAS_CORS });

    try {
        const body = await req.json();
        const correo = String(body?.correo ?? "").trim().toLowerCase();
        const app = String(body?.app ?? "").trim();

        if (!REGEX_CORREO.test(correo) || !app) {
            // Ni siquiera esto se revela con detalle -- mismo mensaje genérico.
            return jsonRespuesta(RESPUESTA_GENERICA);
        }

        const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

        const { data: usuario } = await supabaseAdmin.from("usuarios")
            .select("correo,bloqueado").eq("correo", correo).maybeSingle();
        if (!usuario || usuario.bloqueado) return jsonRespuesta(RESPUESTA_GENERICA);

        const { data: acceso } = await supabaseAdmin.from("accesos")
            .select("correo").eq("correo", correo).eq("app", app).maybeSingle();
        if (!acceso) return jsonRespuesta(RESPUESTA_GENERICA);

        const password = generarPassword();
        const salt = generarSalt();
        const hash = await calcularHash(salt, password);

        const { error: errUpdate } = await supabaseAdmin.from("usuarios")
            .update({ salt, hash, requiere_cambio_clave: true, cambiada: new Date().toISOString() })
            .eq("correo", correo);
        if (errUpdate) {
            console.error("recuperar-clave: fallo el update:", errUpdate);
            return jsonRespuesta(RESPUESTA_GENERICA);
        }

        await supabaseAdmin.from("logs_seguridad").insert({ tipo: "clave_recuperada", correo, app });

        try {
            await enviarCorreo(correo, "Recuperación de contraseña", armarCorreoRecuperacion(correo, password));
        } catch (e) {
            console.error("recuperar-clave: fallo el envío del correo:", e);
        }

        return jsonRespuesta(RESPUESTA_GENERICA);
    } catch (e) {
        console.error("recuperar-clave: error inesperado:", e);
        return jsonRespuesta(RESPUESTA_GENERICA);
    }
});
