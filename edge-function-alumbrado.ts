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
// Flujo por pedido:
//   1. Verifica que quien llama esté logueado Y sea administrador (mismo
//      patrón que 'cerebro' / 'crear-usuario').
//   2. Según body.accion, hace la operación correspondiente contra Firestore
//      o Storage con el Admin SDK de Firebase.
//
// CÓMO PUBLICARLA:
//   1. Firebase Console (proyecto inventario-ap-cinco) -> ⚙ Configuración del
//      proyecto -> Cuentas de servicio -> Generar nueva clave privada
//      -> descarga un JSON.
//   2. Supabase Dashboard -> Edge Functions -> Secrets -> agregá
//      FIREBASE_SERVICE_ACCOUNT_JSON pegando TODO el contenido de ese JSON.
//   3. Dashboard -> Edge Functions -> Create a new function -> "alumbrado"
//      -> pegá este archivo -> Deploy.
//
// RIESGO TÉCNICO CONOCIDO -- 'npm:firebase-admin' está pensado para Node y no
// siempre corre limpio en el runtime Deno de Supabase Edge Functions. Si el
// Deploy falla o tira error de módulo no soportado, avisale a Claude para
// reemplazar esta implementación por llamadas directas a la API REST de
// Firestore/Storage (firmando un JWT con la clave privada de la cuenta de
// servicio vía Web Crypto, sin depender del SDK) -- mismo diseño, sin esta
// dependencia.
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import admin from "npm:firebase-admin@12";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const FIREBASE_SERVICE_ACCOUNT_JSON = Deno.env.get("FIREBASE_SERVICE_ACCOUNT_JSON")!;

const CABECERAS_CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const jsonRespuesta = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { ...CABECERAS_CORS, "Content-Type": "application/json" } });

// Firebase Admin se inicializa una sola vez por instancia de la función (se
// reusa entre invocaciones mientras el Edge Function siga "caliente").
function obtenerAppFirebase() {
    if (admin.apps.length) return admin.apps[0]!;
    const cuentaServicio = JSON.parse(FIREBASE_SERVICE_ACCOUNT_JSON);
    return admin.initializeApp({
        credential: admin.credential.cert(cuentaServicio),
        storageBucket: "inventario-ap-cinco.firebasestorage.app",
    });
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

        const app = obtenerAppFirebase();
        const db = admin.firestore(app);
        const bucket = admin.storage(app).bucket();

        const { accion, ...datos } = await req.json();

        switch (accion) {
            // ---------------------------------------------------------- usuarios (técnicos)
            case "listar_usuarios": {
                const snap = await db.collection("usuarios").get();
                const usuarios = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
                return jsonRespuesta({ ok: true, usuarios });
            }
            case "guardar_usuario": {
                const { codigoOriginal, codigo, nombre, correo, contrasena, rol, activo } = datos;
                if (!codigo || !nombre || !correo || !contrasena) {
                    return jsonRespuesta({ error: "Completá todos los campos." }, 400);
                }
                const registro = { codigo, nombre, correo, contrasena, rol: rol || "tecnico", activo: activo !== false };
                if (codigoOriginal && codigoOriginal !== codigo) {
                    await db.collection("usuarios").doc(codigo).set(registro);
                    await db.collection("usuarios").doc(codigoOriginal).delete();
                } else {
                    await db.collection("usuarios").doc(codigo).set(registro, { merge: true });
                }
                return jsonRespuesta({ ok: true });
            }
            case "alternar_bloqueo_usuario": {
                const { codigo, activoActual } = datos;
                await db.collection("usuarios").doc(codigo).set({ activo: !activoActual }, { merge: true });
                return jsonRespuesta({ ok: true });
            }
            case "borrar_usuario": {
                const { codigo } = datos;
                await db.collection("usuarios").doc(codigo).delete();
                return jsonRespuesta({ ok: true });
            }

            // ------------------------------------------------------------- configuración
            case "leer_configuracion": {
                const ref = await db.doc("configuracion/general").get();
                return jsonRespuesta({ ok: true, configuracion: ref.exists ? ref.data() : {} });
            }
            case "guardar_configuracion": {
                const { correosDestino, correoAdmin, municipios, tiposPotencia } = datos;
                await db.doc("configuracion/general").set(
                    { correosDestino: correosDestino || [], correoAdmin: correoAdmin || "", municipios: municipios || [], tiposPotencia: tiposPotencia || [] },
                    { merge: true },
                );
                return jsonRespuesta({ ok: true });
            }

            // -------------------------------------------------------------- proyectos
            case "listar_proyectos": {
                const snap = await db.collection("proyectos").get();
                const proyectos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
                return jsonRespuesta({ ok: true, proyectos });
            }
            case "borrar_proyecto": {
                const { nombreProyecto } = datos;
                const [archivos] = await bucket.getFiles({ prefix: `proyectos/${nombreProyecto}/` });
                await Promise.all(archivos.map((f) => f.delete().catch(() => {})));
                await db.collection("proyectos").doc(nombreProyecto).delete();
                return jsonRespuesta({ ok: true });
            }

            // --------------------------------------------------------------- actividad
            case "listar_logs": {
                const snap = await db.collection("logs").orderBy("fecha", "desc").limit(150).get();
                const logs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
                return jsonRespuesta({ ok: true, logs });
            }
            case "borrar_log": {
                const { id } = datos;
                await db.collection("logs").doc(id).delete();
                return jsonRespuesta({ ok: true });
            }
            case "borrar_toda_actividad": {
                const snap = await db.collection("logs").get();
                await Promise.all(snap.docs.map((d) => d.ref.delete()));
                return jsonRespuesta({ ok: true });
            }

            // --------------------------------------------------------------- dashboard
            case "dashboard_kpis": {
                const [usuarios, proyectos, ubicaciones, logsRecientes] = await Promise.all([
                    db.collection("usuarios").count().get(),
                    db.collection("proyectos").count().get(),
                    db.collection("ubicaciones").count().get(),
                    db.collection("logs").orderBy("fecha", "desc").limit(8).get(),
                ]);
                return jsonRespuesta({
                    ok: true,
                    kpis: {
                        usuarios: usuarios.data().count,
                        proyectos: proyectos.data().count,
                        ubicaciones: ubicaciones.data().count,
                    },
                    actividadReciente: logsRecientes.docs.map((d) => ({ id: d.id, ...d.data() })),
                });
            }

            default:
                return jsonRespuesta({ error: `Acción desconocida: ${accion}` }, 400);
        }
    } catch (e) {
        return jsonRespuesta({ error: `Error inesperado: ${e instanceof Error ? e.message : e}` }, 500);
    }
});
