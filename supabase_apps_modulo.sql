-- =============================================================================
-- supabase_apps_modulo.sql
-- =============================================================================
-- Corré esto una sola vez, después de los scripts anteriores. Antes el panel
-- solo podía LEER la tabla 'apps' (para el selector de "otorgar acceso");
-- ahora el módulo "Aplicaciones" también puede REGISTRAR una app nueva
-- directamente desde el panel, sin que tengas que pedirme un INSERT por SQL
-- cada vez que armes una aplicación nueva.
-- =============================================================================

create policy admin_insert_apps on public.apps for insert
    to authenticated with check (es_admin());
grant insert on public.apps to authenticated;
