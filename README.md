# Motel Cashless (PWA)

App React en un solo `index.html` (sin build). Mapa 3D de fondo, estilo cristal líquido.

| Interfaz | Acceso |
|---|---|
| Cliente / landing (reservar, validar reserva, sala de espera) | `/` |
| Administrador (PIN inicial `1234`, cámbialo en Ajustes) | `/#admin` |
| Servicios generales (login con cédula) | `/#servicio` |
| Checador de personal (cédula o NFC) | `/#checador` |

## Base de datos
- Ejecuta `supabase/schema.sql` en el SQL Editor de Supabase.
- Credenciales en `config.js` (fuera del index). Déjalo con `SUPABASE_URL: ""` para modo 100 % local (localStorage).

## Ejecutar local
`python -m http.server 5173` o `npx serve .` y abre http://localhost:5173

## Nota de seguridad
Sin proveedores de auth, las políticas RLS son abiertas para la clave anon; el PIN admin y la cédula se validan en el cliente. Para producción conviene endurecer con Supabase Auth / RLS por rol.
