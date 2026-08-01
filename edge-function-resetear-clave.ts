// edge-function-resetear-clave.ts
// =============================================================================
// Edge Function 'resetear-clave' de Supabase (Deno). Genera una contraseña
// TEMPORAL nueva para una cuenta que YA EXISTE (a diferencia de
// 'crear-usuario', que crea la cuenta desde cero), marca requiere_cambio_clave
// = true, y se la manda por correo. Mismo esquema de hash que crear-usuario
// (PBKDF2-HMAC-SHA256, 200.000 iteraciones) para ser 100% compatible.
//
// Uso desde el panel: botón "Resetear clave" junto a cada usuario -> llama
// esta función con {correo} -> el usuario recibe un correo con la clave
// temporal y, al ingresar, la app le pide elegir una nueva.
//
// CÓMO PUBLICARLA: igual que 'crear-usuario' -- Dashboard -> Edge Functions ->
// Create a new function -> "resetear-clave" -> pegar y Deploy. Usa los mismos
// secrets ya configurados (GMAIL_USER, GMAIL_APP_PASSWORD, SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY) -- no hace falta agregar nada.
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GMAIL_USER = Deno.env.get("GMAIL_USER")!;
const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD")!;

const CABECERAS_CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const jsonRespuesta = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { ...CABECERAS_CORS, "Content-Type": "application/json" } });

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

// Réplica exacta de seguridad.py / crear-usuario.
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

function armarCorreoReset(correo: string, password: string): string {
    return `
    <div style="background:#f4f5f7;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #E2E8F0;">
        <tr><td style="background:#ffffff;padding:20px 28px;border-bottom:3px solid #F97316;">
          <div style="color:#1a1a1a;font-size:16px;font-weight:bold;">CINCO S.A.S.</div>
          <div style="color:#999;font-size:11px;">Sistema automatizado</div>
        </td></tr>
        <tr><td style="padding:28px;color:#2b2b2b;font-size:14px;line-height:1.6;">
          <h2 style="margin:0 0 12px;font-size:19px;color:#1a1a1a;">Se restableció tu contraseña</h2>
          <p style="margin:0 0 20px;">Un administrador generó una contraseña temporal nueva para tu cuenta.</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F5F7;border-radius:10px;margin:0 0 20px;">
            <tr><td style="padding:16px 20px;">
              <p style="margin:0 0 3px;font-size:11px;color:#999999;text-transform:uppercase;letter-spacing:.5px;">Correo</p>
              <p style="margin:0 0 14px;font-size:14px;font-weight:bold;color:#1a1a1a;">${escapeHtml(correo)}</p>
              <p style="margin:0 0 3px;font-size:11px;color:#999999;text-transform:uppercase;letter-spacing:.5px;">Contraseña temporal</p>
              <p style="margin:0;font-size:19px;font-weight:bold;letter-spacing:1px;font-family:'Courier New',monospace;color:#F97316;">${escapeHtml(password)}</p>
            </td></tr>
          </table>
          <p style="margin:0 0 24px;padding:12px 16px;background:#FFF3E0;border-left:3px solid #F97316;font-size:13px;color:#7A4A00;border-radius:0 6px 6px 0;">
            🔒 Por seguridad, al ingresar el sistema te va a pedir que la cambies.
          </p>
          <p style="margin:28px 0 0;font-size:11.5px;color:#999999;border-top:1px solid #eeeeee;padding-top:16px;">Si no esperabas este correo, comunícate con tu administrador.</p>
        </td></tr>
      </table>
      <p style="text-align:center;color:#999999;font-size:11px;margin:16px 0 0;">Sistema automatizado &middot; CINCO S.A.S.</p>
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
        if (!correo) return jsonRespuesta({ error: "Falta el correo." }, 400);

        const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

        const { data: existente } = await supabaseAdmin.from("usuarios").select("correo").eq("correo", correo).maybeSingle();
        if (!existente) return jsonRespuesta({ error: "No existe una cuenta con ese correo." }, 404);

        const password = generarPassword();
        const salt = generarSalt();
        const hash = await calcularHash(salt, password);

        const { error: errUpdate } = await supabaseAdmin.from("usuarios")
            .update({ salt, hash, requiere_cambio_clave: true, cambiada: new Date().toISOString() })
            .eq("correo", correo);
        if (errUpdate) return jsonRespuesta({ error: `No se pudo resetear: ${errUpdate.message}` }, 500);

        await supabaseAdmin.from("logs_seguridad").insert({ tipo: "clave_reseteada", correo });

        let emailEnviado = true;
        try {
            await enviarCorreo(correo, "Tu contraseña fue restablecida", armarCorreoReset(correo, password));
        } catch (e) {
            console.error("Fallo el envío del correo de reset:", e);
            emailEnviado = false;
        }

        return jsonRespuesta(emailEnviado
            ? { ok: true, correo, email_enviado: true }
            : { ok: true, correo, email_enviado: false, password_temporal: password });
    } catch (e) {
        return jsonRespuesta({ error: `Error inesperado: ${e instanceof Error ? e.message : e}` }, 500);
    }
});
