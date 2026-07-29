// edge-function-cerebro.ts
// =============================================================================
// Edge Function 'cerebro' de Supabase (Deno). Puente seguro entre el panel y
// Claude, CON MEMORIA (hilo de conversación) y lectura de los PDFs subidos en
// 'Documentos' (los lee completos, no solo texto extraído, para no perder
// tablas ni fórmulas).
//
// Flujo por pregunta:
//   1. Verifica que quien pregunta esté logueado Y sea administrador.
//   2. Guarda la pregunta como mensaje en la conversación.
//   3. Trae el hilo completo de esa conversación (memoria).
//   4. Busca los documentos más relacionados con la pregunta (texto completo)
//      y los descarga del Storage para pasárselos a Claude tal cual (PDF).
//   5. Le pide a Claude que responda con base en el hilo + esos documentos.
//   6. Guarda la respuesta como mensaje y la devuelve al panel.
//
// CÓMO PUBLICARLA (sin instalar nada local):
//   1. Supabase Dashboard -> Edge Functions -> Create a new function -> "cerebro".
//   2. Pegá todo este archivo y Deploy.
//   3. Dashboard -> Edge Functions -> "cerebro" -> Secrets -> agregá
//      ANTHROPIC_API_KEY con tu clave de console.anthropic.com.
//   4. Dashboard -> Storage -> New bucket -> nombre "documentos", privado.
//
// Requiere haber corrido supabase_panel_admin.sql, supabase_cerebro.sql y
// supabase_centro_mando.sql en el proyecto.
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@0.32.1";
import { encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

const CABECERAS_CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const jsonRespuesta = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { ...CABECERAS_CORS, "Content-Type": "application/json" } });

const MAX_DOCUMENTOS_POR_PREGUNTA = 3;
const MAX_MB_POR_DOCUMENTO = 30;

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CABECERAS_CORS });

    try {
        const authHeader = req.headers.get("Authorization") ?? "";
        // Cliente CON la sesión de quien pregunta: todo lo que consulta acá
        // respeta exactamente sus mismos permisos (RLS), no privilegios de
        // servicio.
        const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            global: { headers: { Authorization: authHeader } },
        });

        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return jsonRespuesta({ error: "No autenticado." }, 401);

        const { data: esAdmin } = await supabase.rpc("rpc_soy_admin");
        if (!esAdmin) return jsonRespuesta({ error: "Esta cuenta no tiene permisos de administrador." }, 403);

        const { pregunta, conversacion_id } = await req.json();
        if (!pregunta?.trim()) return jsonRespuesta({ error: "Falta la pregunta." }, 400);
        if (!conversacion_id) return jsonRespuesta({ error: "Falta la conversación." }, 400);

        // 1) guardar la pregunta como mensaje
        const { error: errIns } = await supabase.from("mensajes")
            .insert({ conversacion_id, rol: "user", contenido: pregunta });
        if (errIns) return jsonRespuesta({ error: `No se pudo guardar el mensaje: ${errIns.message}` }, 500);
        await supabase.from("conversaciones").update({ actualizado: new Date().toISOString() }).eq("id", conversacion_id);

        // 2) traer el hilo completo (memoria)
        const { data: hilo } = await supabase.from("mensajes")
            .select("rol, contenido").eq("conversacion_id", conversacion_id).order("creado");

        // 3) buscar documentos relacionados con la pregunta
        const { data: candidatos } = await supabase.from("documentos")
            .select("titulo, categoria, storage_path")
            .textSearch("busqueda", pregunta, { type: "websearch", config: "spanish" })
            .limit(MAX_DOCUMENTOS_POR_PREGUNTA);

        // si la búsqueda de texto no encuentra nada (ej. documento sin texto
        // extraído todavía), cae a los documentos más recientes -- mejor
        // pasarle algo de contexto que nada.
        let documentos = candidatos ?? [];
        if (!documentos.length) {
            const { data: recientes } = await supabase.from("documentos")
                .select("titulo, categoria, storage_path").order("creado", { ascending: false })
                .limit(MAX_DOCUMENTOS_POR_PREGUNTA);
            documentos = recientes ?? [];
        }

        // 4) descargar los PDFs y armarlos como bloques 'document' para Claude
        const bloquesDocumento: Anthropic.Messages.ContentBlockParam[] = [];
        const fuentes: string[] = [];
        for (const doc of documentos) {
            const { data: archivo, error: errDescarga } = await supabase.storage
                .from("documentos").download(doc.storage_path);
            if (errDescarga || !archivo) continue;
            if (archivo.size > MAX_MB_POR_DOCUMENTO * 1024 * 1024) continue;

            const bytes = new Uint8Array(await archivo.arrayBuffer());
            bloquesDocumento.push({
                type: "document",
                source: { type: "base64", media_type: "application/pdf", data: encodeBase64(bytes) },
                title: doc.titulo,
            });
            fuentes.push(doc.titulo);
        }

        // 5) armar los mensajes para Claude: el hilo completo, con los
        // documentos adjuntos SOLO en el turno actual (el último).
        const mensajesClaude: Anthropic.Messages.MessageParam[] = (hilo ?? []).map((m, i, arr) => {
            const esUltimo = i === arr.length - 1;
            if (esUltimo && m.rol === "user" && bloquesDocumento.length) {
                return { role: "user", content: [...bloquesDocumento, { type: "text", text: m.contenido }] };
            }
            return { role: m.rol === "user" ? "user" : "assistant", content: m.contenido };
        });

        const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
        const mensaje = await anthropic.messages.create({
            model: "claude-opus-5",
            max_tokens: 2000,
            system: bloquesDocumento.length
                ? `Sos el asistente interno de CINCO S.A.S. Respondé usando SOLO la información de ` +
                  `los documentos adjuntos (y del hilo de la conversación). Cuando el documento lo ` +
                  `permita, citá el capítulo, artículo o sección exacta -- y reproducí fórmulas tal ` +
                  `cual aparecen. Si la respuesta no está en los documentos, decilo claramente en vez ` +
                  `de inventar.`
                : `Sos el asistente interno de CINCO S.A.S. No se encontraron documentos relacionados ` +
                  `con esta pregunta en la base. Decíselo al usuario y sugerí que suba un documento ` +
                  `sobre el tema desde la sección "Documentos" del panel.`,
            messages: mensajesClaude,
        });

        const respuesta = mensaje.content.find((b) => b.type === "text")?.text ?? "";

        // 6) guardar la respuesta y devolverla
        await supabase.from("mensajes").insert({ conversacion_id, rol: "assistant", contenido: respuesta, fuentes });

        // si es el primer intercambio, usar la pregunta como título de la conversación
        if ((hilo ?? []).length <= 1) {
            const titulo = pregunta.length > 48 ? pregunta.slice(0, 45) + "…" : pregunta;
            await supabase.from("conversaciones").update({ titulo }).eq("id", conversacion_id);
        }

        return jsonRespuesta({ respuesta, fuentes });
    } catch (e) {
        return jsonRespuesta({ error: `Error inesperado: ${e instanceof Error ? e.message : e}` }, 500);
    }
});
