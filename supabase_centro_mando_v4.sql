-- =============================================================================
-- supabase_centro_mando_v4.sql
-- =============================================================================
-- Corré esto una sola vez en el SQL Editor, DESPUÉS de _v3.
--
-- QUÉ AGREGA: el TIPO DE LICENCIA por acceso ('prueba' o 'definitiva'),
-- administrado desde el panel. Hasta ahora la app deducía "Versión de
-- prueba" solo por tener fecha de vencimiento; con esto la etiqueta es un
-- dato propio: el panel lo cambia con un selector y la barra de estado de
-- la app muestra "Versión de prueba" o "Versión definitiva" según el valor.
--
-- Los accesos existentes quedan como 'prueba' (default); pasalos a
-- 'definitiva' desde el panel cuando corresponda.
-- =============================================================================

alter table public.accesos
    add column if not exists tipo_licencia text not null default 'prueba';

-- El panel (rol authenticated) puede cambiar el tipo, igual que la vigencia.
grant update (tipo_licencia) on public.accesos to authenticated;

-- rpc_credenciales devuelve también el tipo. Mismo patrón de _v2/_v3:
-- cambiar el tipo de retorno exige DROP (error 42P13 con CREATE OR REPLACE)
-- y el DROP tumba los grants, por eso se repone el de 'anon' al final.
drop function if exists public.rpc_credenciales(text, text);

create function public.rpc_credenciales(p_correo text, p_app text)
returns table(salt text, hash text, bloqueado boolean, tiene_acceso boolean,
              requiere_cambio_clave boolean, expira timestamptz,
              tipo_licencia text)
language sql security definer set search_path = public as $$
    select u.salt, u.hash, u.bloqueado,
           exists(select 1 from accesos a
                  where a.correo = u.correo and a.app = p_app
                    and (a.expira is null or a.expira > now())) as tiene_acceso,
           u.requiere_cambio_clave,
           (select a.expira from accesos a
             where a.correo = u.correo and a.app = p_app
             limit 1) as expira,
           (select a.tipo_licencia from accesos a
             where a.correo = u.correo and a.app = p_app
             limit 1) as tipo_licencia
    from usuarios u
    where u.correo = lower(p_correo);
$$;
grant execute on function public.rpc_credenciales(text, text) to anon;
