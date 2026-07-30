// edge-function-enviar-correo-soporte.ts
// =============================================================================
// Edge Function 'enviar-correo-soporte' de Supabase (Deno). Se dispara cuando
// el admin aprieta "Enviar correo" en un ticket de soporte: le avisa por
// correo (Gmail SMTP) al usuario que su solicitud se resolvió, deja una
// notificación in-app para que la app correspondiente se la muestre, y cierra
// el ticket.
//
// Flujo:
//   1. Verifica que quien llama esté logueado Y sea administrador.
//   2. Busca el mensaje de soporte.
//   3. Arma y manda el correo por Gmail SMTP (incluye la respuesta guardada, si la hay).
//   4. Con la service role key: guarda la notificación in-app, cierra el
//      ticket y registra el evento en logs_seguridad. Esto se hace pase lo
//      que pase con el correo -- si el envío falla, igual queda la
//      notificación in-app y el ticket cerrado.
//
// CÓMO PUBLICARLA: igual que 'crear-usuario' -- Dashboard -> Edge Functions ->
// Create a new function -> "enviar-correo-soporte" -> pegar y Deploy. Usa los
// mismos secrets GMAIL_USER / GMAIL_APP_PASSWORD ya configurados para
// 'crear-usuario' (ver cabecera de ese archivo para cómo generarlos).
//
// Requiere haber corrido supabase_centro_mando_v2.sql en el proyecto.
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
            from: `Centro de Mando JC <${GMAIL_USER}>`,
            to: destinatario,
            subject: asunto,
            content: "Tu cliente de correo no muestra HTML -- pedile a tu administrador los datos por otro medio.",
            html,
        });
    } finally {
        await client.close();
    }
}

function armarCorreoResuelto(respuesta: string | null): string {
    return `
        <div style="font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.5">
            <h2>Tu solicitud de soporte fue resuelta</h2>
            ${respuesta
                ? `<p>El equipo dejó esta respuesta:</p><p style="background:#f4f4f4;border-radius:8px;padding:12px 14px;white-space:pre-wrap">${respuesta}</p>`
                : `<p>El equipo ya resolvió tu solicitud.</p>`}
            <p style="margin-top:24px;color:#666;font-size:12px">Si el problema sigue, volvé a escribirnos desde la app.</p>
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

        const { mensaje_id } = await req.json();
        if (!mensaje_id) return jsonRespuesta({ error: "Falta el id del mensaje." }, 400);

        const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
        const { data: s, error: errBusqueda } = await supabaseAdmin.from("mensajes_soporte")
            .select("*").eq("id", mensaje_id).maybeSingle();
        if (errBusqueda) return jsonRespuesta({ error: errBusqueda.message }, 500);
        if (!s) return jsonRespuesta({ error: "No se encontró ese mensaje de soporte." }, 404);

        let emailEnviado = true;
        try {
            await enviarCorreo(s.correo, "Tu solicitud de soporte fue resuelta", armarCorreoResuelto(s.respuesta ?? null));
        } catch {
            emailEnviado = false;
        }

        const mensajeNotificacion = s.respuesta
            ? `Tu solicitud de soporte fue resuelta: ${s.respuesta}`
            : "Tu solicitud de soporte fue resuelta.";
        await supabaseAdmin.from("notificaciones_soporte").insert({
            correo: s.correo, app: s.app ?? null, mensaje_soporte_id: s.id, mensaje: mensajeNotificacion,
        });

        await supabaseAdmin.from("mensajes_soporte")
            .update({ estado: "cerrado", respondido_en: s.respondido_en ?? new Date().toISOString() })
            .eq("id", s.id);

        await supabaseAdmin.from("logs_seguridad").insert({ tipo: "soporte_resuelto", correo: s.correo, app: s.app ?? null });

        return jsonRespuesta({ ok: true, email_enviado: emailEnviado });
    } catch (e) {
        return jsonRespuesta({ error: `Error inesperado: ${e instanceof Error ? e.message : e}` }, 500);
    }
});
