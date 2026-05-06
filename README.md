# Mi Coach — PWA de asistencia y abonos

App web instalable para gestionar alumnos, asistencia diaria, cuotas y métricas.

## Estructura

```
coach-app/
├── index.html       # estructura + 4 vistas
├── styles.css       # estilos mobile-first
├── app.js           # lógica + Dexie (IndexedDB)
├── sw.js            # service worker (offline + cache)
├── manifest.json    # PWA manifest
└── icons/
    ├── icon-192.png
    └── icon-512.png
```

## Probarla localmente

El service worker requiere HTTPS o localhost. Lo más rápido:

```bash
cd coach-app
python3 -m http.server 8080
# abrir http://localhost:8080
```

Después en Chrome/Edge: ⋮ → "Instalar Mi Coach". En Android lo mismo. En iOS Safari: Compartir → "Agregar a pantalla de inicio".

## Subir a Cloudflare Pages

1. Crear repo nuevo en GitHub (público o privado da igual) y subir esta carpeta.
2. Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git.
3. Elegir el repo. Build settings: **Framework preset: None**. **Build command: vacío**. **Build output directory: `/`** (o el subdir donde está `index.html`).
4. Save and Deploy. Quedará servido en `https://<proyecto>.pages.dev`.

Cada `git push` redeploy automático.

## Personalización rápida

- **Nombre y color**: en `manifest.json` (`name`, `theme_color`, `background_color`) y en `styles.css` (las variables al inicio: `--primary`, `--bg`, etc.).
- **Íconos**: reemplazar `icons/icon-192.png` y `icons/icon-512.png` por algo propio (la coach puede mandar un logo y se generan rápido en cualquier editor o en realfavicongenerator.net).
- **Versionado del cache**: cuando hagas cambios y querés forzar refresh, subir `CACHE = 'mi-coach-v1'` a `v2` en `sw.js`.

## Modelo de datos (IndexedDB via Dexie)

- **alumnos**: `id, nombre, contacto, monto_cuota, dia_pago_mes, fecha_alta, activo (1/0)`
- **asistencias**: `id, alumno_id, fecha (YYYY-MM-DD), estado (presente/ausente/justificado)`
- **pagos**: `id, alumno_id, mes (YYYY-MM), monto, vencimiento, fecha_pago, estado (pendiente/pagado/vencido)`

Todo vive en el dispositivo. Nada sale a internet.

## Próximos pasos sugeridos (fase 2)

- Cron diario en Cloudflare Workers + Web Push para que avise con la app cerrada.
- Backup automático a Cloudflare D1 (sync incremental).
- Export CSV de asistencias y pagos.
- Pantalla de histórico por alumno (asistencia y pagos).
