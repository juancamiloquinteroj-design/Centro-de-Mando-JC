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

// Backend del Visualizador de Datos, corriendo en el PC de Juan Camilo
// (dominio fijo de ngrok). Se usa SOLO para crear la carpeta local de un
// operador nuevo cuando se elige "+ Nueva empresa..." al crear un usuario
// -- ver ADMIN_TOKEN en backend/.env de ese proyecto. Sabido y aceptado:
// esta clave queda visible en el navegador, así que cualquiera que abra
// Centro de Mando con las herramientas de desarrollador podría usarla para
// crear carpetas vacías en ese PC (no puede leer ni borrar nada).
window.VISUALIZADOR_DATOS_CONFIG = {
    apiBase: "https://murkiness-dairy-anagram.ngrok-free.dev",
    adminToken: "fbefc83385fa4e16952bcd89a57c77da5f7db955754d65b8",
};
