-- =============================================================================
-- supabase_centro_mando_v5.sql
-- =============================================================================
-- Corré esto una sola vez en el SQL Editor, DESPUÉS de _v4.
--
-- QUÉ ARREGLA: cierra el ciclo del cambio de contraseña obligatorio.
-- La Edge Function 'crear-usuario' marca requiere_cambio_clave = true y las
-- apps (desde hoy) fuerzan el cambio en el primer ingreso — pero
-- rpc_cambiar_clave no APAGABA la bandera, así que el usuario quedaba
-- pidiendo cambio en cada login. Ahora cambiar la clave (sea por el flujo
-- obligatorio o por "olvidé mi contraseña") deja la bandera en false.
--
-- Mismo tipo de retorno que la función original: CREATE OR REPLACE alcanza,
-- no hay que dropear ni reponer grants.
-- =============================================================================

create or replace function public.rpc_cambiar_clave(p_correo text, p_salt text, p_hash text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
    n int;
begin
    update usuarios set salt = p_salt, hash = p_hash, cambiada = now(),
                        requiere_cambio_clave = false
    where correo = lower(p_correo);
    get diagnostics n = row_count;
    return n > 0;
end;
$$;
