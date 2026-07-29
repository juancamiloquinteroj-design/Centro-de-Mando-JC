-- =============================================================================
-- supabase_centro_mando_v2.sql
-- =============================================================================
-- Corré esto en el MISMO proyecto de Supabase que ya usan todas las apps de la
-- suite, después de supabase_centro_mando.sql y supabase_apps_modulo.sql. Este
-- script SOLO agrega lo nuevo, no borra ni pisa nada existente.
--
-- Qué agrega:
--   1. Bandera 'requiere_cambio_clave' en usuarios (para forzar cambio de
--      contraseña en el primer ingreso de un usuario creado desde el panel).
--   2. Enlaces de descarga por app (módulo "Enlaces").
--   3. Notificaciones de soporte que las apps de la suite pueden consultar
--      (RPCs para 'anon', igual patrón que rpc_registrar_login/rpc_credenciales
--      -- las apps de la suite NO tienen sesión de Supabase Auth, validan con
--      la anon key + estas RPCs 'security definer').
--
-- IMPORTANTE -- 'usuarios'/'accesos' NO reciben policies nuevas de insert acá
-- a propósito: la creación de usuarios (con salt/hash) la hace la Edge
-- Function 'crear-usuario' usando la service role key, para no tener que
-- exponer esas columnas sensibles a un grant directo del cliente.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) BANDERA DE CAMBIO DE CLAVE OBLIGATORIO
-- -----------------------------------------------------------------------------
alter table public.usuarios add column if not exists requiere_cambio_clave boolean not null default false;

-- rpc_credenciales ahora también devuelve la bandera -- cada app de la suite
-- (en su seguridad.py) tiene que leer este campo NUEVO por NOMBRE (no por
-- posición) y forzar el cambio de clave en el primer ingreso. Ese ajuste en
-- seguridad.py queda pendiente en cada app, fuera de este repo.
--
-- Postgres no deja cambiar el tipo de retorno de una función existente con
-- CREATE OR REPLACE (el error 42P13 que tira el SQL Editor) -- hay que
-- borrarla primero. El DROP se lleva puestos los grants/permisos que tuviera,
-- por eso el GRANT de abajo los repone explícitamente para 'anon' (las apps
-- de la suite llaman esta función con la anon key, sin sesión).
drop function if exists public.rpc_credenciales(text, text);

create function public.rpc_credenciales(p_correo text, p_app text)
returns table(salt text, hash text, bloqueado boolean, tiene_acceso boolean, requiere_cambio_clave boolean)
language sql security definer set search_path = public as $$
    select u.salt, u.hash, u.bloqueado,
           exists(select 1 from accesos a
                  where a.correo = u.correo and a.app = p_app
                    and (a.expira is null or a.expira > now())) as tiene_acceso,
           u.requiere_cambio_clave
    from usuarios u
    where u.correo = lower(p_correo);
$$;
grant execute on function public.rpc_credenciales(text, text) to anon;

-- -----------------------------------------------------------------------------
-- 2) ENLACES DE DESCARGA (módulo "Enlaces")
-- -----------------------------------------------------------------------------
-- Varios enlaces por app (ej. "Instalador Windows", "Portable") -- se usan
-- tanto en la sección "Enlaces" del panel como en el correo de bienvenida que
-- manda la Edge Function 'crear-usuario'.
create table if not exists public.enlaces_apps (
    id      bigint generated always as identity primary key,
    app     text not null references public.apps(slug) on delete cascade,
    nombre  text not null,        -- ej. 'Instalador Windows', 'Portable', 'macOS'
    url     text not null,
    orden   int not null default 0,
    creado  timestamptz not null default now()
);
create index if not exists enlaces_apps_app_idx on public.enlaces_apps (app, orden);

alter table public.enlaces_apps enable row level security;
create policy admin_todo_enlaces_apps on public.enlaces_apps for all
    to authenticated using (es_admin()) with check (es_admin());
grant select, insert, update, delete on public.enlaces_apps to authenticated;

-- -----------------------------------------------------------------------------
-- 3) NOTIFICACIONES DE SOPORTE (aviso in-app de "tu ticket se resolvió")
-- -----------------------------------------------------------------------------
create table if not exists public.notificaciones_soporte (
    id                 uuid primary key default gen_random_uuid(),
    correo             text not null,
    app                text references public.apps(slug) on delete set null,
    mensaje_soporte_id bigint references public.mensajes_soporte(id) on delete set null,
    mensaje            text not null,
    leida              boolean not null default false,
    leida_en           timestamptz,
    creado             timestamptz not null default now()
);
create index if not exists notificaciones_soporte_correo_idx on public.notificaciones_soporte (correo, app, leida);

alter table public.notificaciones_soporte enable row level security;
-- El panel (admin) solo necesita LEER para debug -- la escritura la hace la
-- Edge Function 'enviar-correo-soporte' con la service role key.
create policy admin_select_notificaciones on public.notificaciones_soporte for select
    to authenticated using (es_admin());
grant select on public.notificaciones_soporte to authenticated;

-- RPCs para que cada app de la suite (anon key, sin sesión) consulte y marque
-- sus propias notificaciones -- mismo patrón que rpc_registrar_login.
create or replace function public.rpc_notificaciones_pendientes(p_correo text, p_app text)
returns table(id uuid, mensaje text, creado timestamptz)
language sql security definer set search_path = public as $$
    select id, mensaje, creado from notificaciones_soporte
    where correo = lower(p_correo) and (app = p_app or app is null) and leida = false
    order by creado desc;
$$;
grant execute on function public.rpc_notificaciones_pendientes(text, text) to anon;

-- El filtro por correo acá es defensa en profundidad: aunque 'id' es un uuid
-- no adivinable, evita que un llamado con un id ajeno marque como leída la
-- notificación de otro usuario.
create or replace function public.rpc_marcar_notificacion_leida(p_id uuid, p_correo text)
returns void
language plpgsql security definer set search_path = public as $$
begin
    update notificaciones_soporte set leida = true, leida_en = now()
    where id = p_id and correo = lower(p_correo);
end;
$$;
grant execute on function public.rpc_marcar_notificacion_leida(uuid, text) to anon;

create or replace function public.rpc_marcar_notificaciones_leidas(p_correo text, p_app text)
returns void
language plpgsql security definer set search_path = public as $$
begin
    update notificaciones_soporte set leida = true, leida_en = now()
    where correo = lower(p_correo) and (app = p_app or app is null) and leida = false;
end;
$$;
grant execute on function public.rpc_marcar_notificaciones_leidas(text, text) to anon;

-- =============================================================================
-- OPCIONAL -- Cerebro/Documentos se retiraron del panel. Esto NO se corre
-- automático: descomentá y corré a mano SOLO si ya decidiste que no vas a
-- retomarlos pronto. Borra datos, no hay vuelta atrás. El bucket de Storage
-- 'documentos' no se puede borrar por SQL -- hacelo aparte desde Dashboard ->
-- Storage -> 'documentos' -> Delete bucket.
-- =============================================================================
-- drop table if exists public.mensajes cascade;
-- drop table if exists public.conversaciones cascade;
-- drop table if exists public.documentos cascade;
-- drop policy if exists admin_leer_documentos_storage on storage.objects;
-- drop policy if exists admin_subir_documentos_storage on storage.objects;
-- drop policy if exists admin_borrar_documentos_storage on storage.objects;
