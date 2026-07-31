-- =============================================================================
-- supabase_centro_mando_v3.sql
-- =============================================================================
-- Corré esto una sola vez en el SQL Editor, DESPUÉS de _v2.
--
-- QUÉ ARREGLA: la barra de estado de las apps de la suite (ej. Pérdidas
-- Técnicas) siempre decía "Acceso sin vencimiento" aunque el panel tuviera
-- una vigencia puesta (ej. "Vence 2/8/2026"). La causa: rpc_credenciales
-- usaba 'accesos.expira' solo para calcular 'tiene_acceso', pero no la
-- DEVOLVÍA — y seguridad.py de cada app lee el campo 'expira' por nombre
-- (verificar_detallado -> {'expira': fila.get('expira')}), así que le
-- llegaba siempre NULL.
--
-- Igual que en _v2: Postgres no deja cambiar el tipo de retorno con CREATE
-- OR REPLACE (error 42P13), hay que dropear primero; el DROP se lleva los
-- grants, por eso se repone el GRANT a 'anon' (las apps llaman esta función
-- con la anon key, sin sesión).
-- =============================================================================

drop function if exists public.rpc_credenciales(text, text);

create function public.rpc_credenciales(p_correo text, p_app text)
returns table(salt text, hash text, bloqueado boolean, tiene_acceso boolean,
              requiere_cambio_clave boolean, expira timestamptz)
language sql security definer set search_path = public as $$
    select u.salt, u.hash, u.bloqueado,
           exists(select 1 from accesos a
                  where a.correo = u.correo and a.app = p_app
                    and (a.expira is null or a.expira > now())) as tiene_acceso,
           u.requiere_cambio_clave,
           (select a.expira from accesos a
             where a.correo = u.correo and a.app = p_app
             limit 1) as expira
    from usuarios u
    where u.correo = lower(p_correo);
$$;
grant execute on function public.rpc_credenciales(text, text) to anon;
