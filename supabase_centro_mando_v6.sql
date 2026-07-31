-- =============================================================================
-- supabase_centro_mando_v6.sql
-- =============================================================================
-- Corré esto una sola vez en el SQL Editor, DESPUÉS de _v5.
--
-- QUÉ AGREGA: datos de la persona (no solo el correo) en la tabla
-- 'usuarios': nombre completo, cédula, empresa y celular. El panel los pide
-- al crear el usuario y el correo de bienvenida los usa para saludar por
-- nombre y decir a qué empresa pertenece.
-- =============================================================================

alter table public.usuarios
    add column if not exists nombre_completo text,
    add column if not exists cedula text,
    add column if not exists empresa text,
    add column if not exists celular text;
