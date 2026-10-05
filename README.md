# 🏨 Motel Control

App en React (un solo archivo `App.jsx`) para controlar la ocupación por horas, la limpieza y el inventario de un motel. Usa Supabase en la nube y se compila también como APK de Android.

## 1. Base de datos (Supabase)
1. Abre https://fgzxxzkeumpshegibzek.supabase.co → **SQL Editor** → *New query*.
2. Pega todo el contenido de `supabase/schema.sql` y presiona **Run**.
   - Crea las tablas, funciones, el bucket de imágenes `motel`, el tiempo real y los usuarios:
     - `admin` / `123456`
     - `superadmin` / `1234`
   - Las contraseñas se guardan cifradas (bcrypt) en la base de datos; no están en el código.

## 2. Ejecutar en el navegador
```bash
npm install
npm run dev
```

## 3. APK
Cada push a `main` ejecuta GitHub Actions (`.github/workflows/build-apk.yml`), que compila la app con Capacitor y publica `motel-control.apk` en **Releases** (y como artefacto del workflow).

Para compilarla localmente se necesita Android Studio (JDK 21 + Android SDK):
```bash
npm install
npm run build
npx cap add android
npx cap sync android
cd android && gradlew assembleDebug
```

## Funciones
- **Recepción**: registro de ingreso (carro con placa / moto / a pie), hora de inicio automática, el contador arranca 2 minutos después del registro, tablero en vivo de habitaciones dentro del formulario, lista de espera, productos, pago inmediato (efectivo / transferencia) o al final con cuenta pendiente.
- **Habitaciones**: estados disponible / ocupado / limpieza / no disponible, burbujas con contador en tiempo real y saldo pendiente, agregar consumos, abonos y liquidación.
- **Limpieza**: escaneo de QR o tag NFC para iniciar y terminar, con foto obligatoria; historial de tiempos.
- **Inventarios**: productos para venta (descuento automático, agotados y por agotarse), inventario del negocio (activos y aseo), facturas de compra con imagen.
- **Chat interno + auditorías**: el superadmin pide foto y cantidad de productos; el admin responde; el superadmin ajusta el inventario indicando el motivo (daño, pérdida, vencida…).
- **Superadmin**: estadísticas, historial por día con el detalle de cada habitación, edición de pagos, precios, sugerencias de compra y cambio de contraseñas.

> NFC: en el APK funciona de forma nativa (plugin `@capgo/capacitor-nfc`); en la web funciona con Chrome para Android (Web NFC). Al abrir el escáner se activan a la vez la cámara (QR) y el NFC.
