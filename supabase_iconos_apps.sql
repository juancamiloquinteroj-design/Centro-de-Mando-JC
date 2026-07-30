-- =============================================================================
-- supabase_iconos_apps.sql
-- =============================================================================
-- Corré esto una sola vez. Agrega la posibilidad de subir un ícono (PNG)
-- para cada app del catálogo, en vez del rompecabezas 🧩 genérico.
-- =============================================================================

alter table public.apps add column if not exists icono_url text;

-- Bucket público: los íconos no son información sensible, y así el <img> del
-- panel los puede mostrar directo con la URL pública, sin tener que pedir una
-- URL firmada cada vez (a diferencia del bucket 'documentos', que es privado).
insert into storage.buckets (id, name, public)
values ('app-iconos', 'app-iconos', true)
on conflict (id) do nothing;

create policy admin_subir_iconos_storage on storage.objects for insert
    to authenticated with check (bucket_id = 'app-iconos' and es_admin());
create policy admin_actualizar_iconos_storage on storage.objects for update
    to authenticated using (bucket_id = 'app-iconos' and es_admin());
create policy admin_borrar_iconos_storage on storage.objects for delete
    to authenticated using (bucket_id = 'app-iconos' and es_admin());
create policy publico_leer_iconos_storage on storage.objects for select
    to public using (bucket_id = 'app-iconos');

-- Actualizar apps.icono_url -- si ya existe una policy de update en 'apps'
-- (por ejemplo de una migración anterior que no está en este repo) este
-- create policy puede fallar con "ya existe" -- en ese caso ignorá el error,
-- ya está cubierto.
create policy admin_update_apps on public.apps for update
    to authenticated using (es_admin()) with check (es_admin());
grant update on public.apps to authenticated;
