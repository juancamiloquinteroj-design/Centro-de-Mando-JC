// config.js
// Credenciales PÚBLICAS de Supabase (publishable/anon key): es segura de
// exponer en el navegador -- el acceso real a los datos lo controla RLS + el
// login de Supabase Auth (ver supabase_panel_admin.sql), no el secreto de
// esta clave. MISMO proyecto de Supabase que ya usan las apps de la suite
// (Pérdidas Técnicas y las que sigan) -- una sola identidad de usuarios para
// todas, tal como se diseñó.
window.SUPABASE_CONFIG = {
    url: "https://xldnymthuxcpldnqgfcu.supabase.co",
    anonKey: "sb_publishable_H4nrbjKL0F5RTpWoUiTuKQ_pkzJtuvG",
};
