-- =============================================================================
-- supabase_cron_zonas_alumbrado.sql
-- =============================================================================
-- Programa un chequeo automático cada 15 minutos: le pega a la Edge Function
-- 'alumbrado' con accion='revisar_proyectos_pendientes', que busca proyectos
-- de Alumbrado Público recién sincronizados, identifica su zona por el
-- municipio, y le avisa por correo SOLO a los correos de esa zona (sin tocar
-- el envío general que ya hace la app móvil -- son dos sistemas en paralelo
-- por ahora, a propósito, mientras se prueba este nuevo).
--
-- YA CORRIDO -- el cron 'revisar-zonas-alumbrado' quedó programado en este
-- proyecto de Supabase (confirmado: select * from cron.job). La clave real
-- que se usó para crearlo vive ahora DENTRO de la base de datos de Supabase,
-- no hace falta que siga en este archivo -- por eso quedó con el placeholder
-- de nuevo, para no tener una clave con acceso total a la base pegada en
-- texto plano en un archivo del proyecto.
--
-- Si en algún momento hay que volver a correr este script (por ejemplo si se
-- borra el cron y se quiere recrear), reemplazá TU_SERVICE_ROLE_KEY_ACA por
-- la clave real de nuevo: Supabase Dashboard -> Project Settings -> API Keys
-- -> pestaña "Legacy anon, service_role API keys" -> "service_role".
-- =============================================================================

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
    'revisar-zonas-alumbrado',
    '*/15 * * * *',
    $$
    select net.http_post(
        url := 'https://xldnymthuxcpldnqgfcu.supabase.co/functions/v1/alumbrado',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer TU_SERVICE_ROLE_KEY_ACA'
        ),
        body := jsonb_build_object('accion', 'revisar_proyectos_pendientes')
    ) as request_id;
    $$
);

-- Para revisar que quedó programado:
-- select * from cron.job;

-- Para borrar el cron (si algún día lo querés desactivar):
-- select cron.unschedule('revisar-zonas-alumbrado');
