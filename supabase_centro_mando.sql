-- =============================================================================
-- supabase_centro_mando.sql
-- =============================================================================
-- Corré esto en el MISMO proyecto de Supabase que ya usa Pérdidas Técnicas
-- (después de supabase_usuarios.sql, supabase_panel_admin.sql y
-- supabase_cerebro.sql, si ya los corriste antes -- si no, corré esos tres
-- primero, están en la carpeta de Pérdidas Técnicas). Este script SOLO agrega
-- lo nuevo del Centro de Mando: no borra ni pisa nada de usuarios/accesos/apps
-- que ya tengas.
--
-- Qué agrega:
--   1. Vencimiento de accesos (permisos temporales por app, ej. "3 meses").
--   2. Logs de seguridad (login ok/fallido, bloqueos, altas de acceso...).
--   3. Memoria del cerebro (conversaciones con hilo, no una pregunta suelta).
--   4. Documentos (PDFs que el cerebro lee para responder).
-- =============================================================================

create extension if not exists pgcrypto;   -- para gen_random_uuid()

-- -----------------------------------------------------------------------------
-- 1) VENCIMIENTO DE ACCESOS
-- -----------------------------------------------------------------------------
-- 'expira' NULL = acceso sin vencimiento (como hasta ahora). Con fecha = el
-- acceso deja de funcionar solo, sin que nadie tenga que borrarlo a mano --
-- para dar permisos "por 3 meses" como pediste.
alter table public.accesos add column if not exists expira timestamptz;

-- rpc_credenciales ahora también revisa el vencimiento: un acceso vencido
-- cuenta como "sin acceso", igual que si nunca se hubiera otorgado.
create or replace function public.rpc_credenciales(p_correo text, p_app text)
returns table(salt text, hash text, bloqueado boolean, tiene_acceso boolean)
language sql security definer set search_path = public as $$
    select u.salt, u.hash, u.bloqueado,
           exists(select 1 from accesos a
                  where a.correo = u.correo and a.app = p_app
                    and (a.expira is null or a.expira > now())) as tiene_acceso
    from usuarios u
    where u.correo = lower(p_correo);
$$;

-- El panel (admin logueado) puede editar la fecha de vencimiento de un acceso
-- ya otorgado (extenderlo o quitarle el vencimiento), además de lo que ya
-- podía hacer (ver/otorgar/revocar).
grant update (expira) on public.accesos to authenticated;
create policy admin_update_accesos on public.accesos for update
    to authenticated using (es_admin()) with check (es_admin());

-- -----------------------------------------------------------------------------
-- 2) LOGS DE SEGURIDAD
-- -----------------------------------------------------------------------------
create table if not exists public.logs_seguridad (
    id      bigint generated always as identity primary key,
    tipo    text not null,    -- 'login_ok' | 'login_fallido' | 'bloqueo' | 'desbloqueo' | 'borrado' | 'acceso_otorgado' | 'acceso_revocado'
    correo  text,
    app     text,
    detalle text,
    creado  timestamptz not null default now()
);
create index if not exists logs_seguridad_creado_idx on public.logs_seguridad (creado desc);

alter table public.logs_seguridad enable row level security;
create policy admin_select_logs on public.logs_seguridad for select
    to authenticated using (es_admin());
create policy admin_insert_logs on public.logs_seguridad for insert
    to authenticated with check (es_admin());
grant select, insert on public.logs_seguridad to authenticated;

-- Cualquier app de la suite (con la anon key) puede registrar un intento de
-- login -- así el panel ve intentos fallidos de TODAS las apps, no solo
-- acciones hechas desde el propio panel. No expone nada sensible: solo
-- guarda si funcionó o no, cuándo, y en qué app.
create or replace function public.rpc_registrar_login(p_correo text, p_app text, p_exito boolean)
returns void
language plpgsql security definer set search_path = public as $$
begin
    insert into logs_seguridad (tipo, correo, app)
    values (case when p_exito then 'login_ok' else 'login_fallido' end, lower(p_correo), p_app);
end;
$$;
grant execute on function public.rpc_registrar_login(text, text, boolean) to anon;

-- -----------------------------------------------------------------------------
-- 3) MEMORIA DEL CEREBRO (conversaciones con hilo)
-- -----------------------------------------------------------------------------
create table if not exists public.conversaciones (
    id          uuid primary key default gen_random_uuid(),
    titulo      text not null default 'Nueva conversación',
    creado      timestamptz not null default now(),
    actualizado timestamptz not null default now()
);
alter table public.conversaciones enable row level security;
create policy admin_todo_conversaciones on public.conversaciones for all
    to authenticated using (es_admin()) with check (es_admin());
grant select, insert, update, delete on public.conversaciones to authenticated;

create table if not exists public.mensajes (
    id              bigint generated always as identity primary key,
    conversacion_id uuid not null references public.conversaciones(id) on delete cascade,
    rol             text not null check (rol in ('user', 'assistant')),
    contenido       text not null,
    fuentes         text[],
    creado          timestamptz not null default now()
);
create index if not exists mensajes_conversacion_idx on public.mensajes (conversacion_id, creado);
alter table public.mensajes enable row level security;
create policy admin_todo_mensajes on public.mensajes for all
    to authenticated using (es_admin()) with check (es_admin());
grant select, insert, update, delete on public.mensajes to authenticated;

-- -----------------------------------------------------------------------------
-- 4) DOCUMENTOS (PDFs que el cerebro lee -- resoluciones CREG, libros, etc.)
-- -----------------------------------------------------------------------------
-- El archivo en sí vive en Supabase Storage (bucket 'documentos' -- creálo en
-- Dashboard -> Storage -> New bucket -> nombre 'documentos', privado, NO
-- publico). Esta tabla guarda solo la referencia + metadatos + texto para
-- busqueda simple por ahora (v1: la Edge Function le pasa el PDF completo a
-- Claude para no perder formulas/estructura -- ver README).
create table if not exists public.documentos (
    id           bigint generated always as identity primary key,
    titulo       text not null,
    categoria    text,               -- ej. 'CREG', 'libro', 'procedimiento'
    storage_path text not null,      -- ruta dentro del bucket 'documentos'
    texto        text,               -- opcional: texto extraido, solo para busqueda
    busqueda     tsvector generated always as (
                     to_tsvector('spanish', coalesce(titulo, '') || ' ' || coalesce(texto, ''))
                 ) stored,
    subido_por   text,
    creado       timestamptz not null default now()
);
create index if not exists documentos_busqueda_idx on public.documentos using gin (busqueda);
alter table public.documentos enable row level security;
create policy admin_todo_documentos on public.documentos for all
    to authenticated using (es_admin()) with check (es_admin());
grant select, insert, update, delete on public.documentos to authenticated;

-- IMPORTANTE -- Storage tiene SU PROPIA seguridad, aparte de la de esta
-- tabla: sin estas políticas, aunque seas admin, Supabase te va a negar el
-- permiso al subir o leer el PDF del bucket. Primero creá el bucket
-- (Dashboard -> Storage -> New bucket -> nombre EXACTO "documentos",
-- desmarcado "Public bucket"), DESPUÉS corré esto:
create policy admin_leer_documentos_storage on storage.objects for select
    to authenticated using (bucket_id = 'documentos' and es_admin());
create policy admin_subir_documentos_storage on storage.objects for insert
    to authenticated with check (bucket_id = 'documentos' and es_admin());
create policy admin_borrar_documentos_storage on storage.objects for delete
    to authenticated using (bucket_id = 'documentos' and es_admin());
