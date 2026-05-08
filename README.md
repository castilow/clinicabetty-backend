# clinica-erp-backend

Backend Node.js (Express) **standalone** que expone los mismos endpoints `/api/*`
que el dev server de Vite (los plugins definidos en
`aplicacion-web/vite.config.js`). Pensado para correr en **Render** (Docker)
y servir como API para el frontend desplegado en Vercel.

## Por qué existe

El proyecto original implementa toda la API como middlewares de Vite, lo cual
funciona perfecto en `npm run dev`, pero **no se ejecuta** cuando el frontend se
buildea como sitio estático (Vercel). Este servicio toma esos mismos plugins y
los monta en una app Express normal, escuchando en `$PORT`.

`./plugins.mjs` es una **copia** de `aplicacion-web/vite.config.js` con los
imports de Vite/React quitados y `export` agregado a cada función plugin. Si
agregás un endpoint nuevo en el dev server, **acordate de duplicarlo aquí** (o,
mejor aún, refactorizá ambos para que importen desde un módulo compartido).

## Endpoints

- `GET  /` — info básica del servicio
- `GET  /health` — chequeo de salud (lo usa Render)
- `GET|POST /api/erp-state` — estado en memoria
- `POST /api/openai/doctor-session`
- `POST /api/openai/doctor-audio`
- `POST /api/openai/resultado-sesion`
- `POST /api/openai/resultado-audio`
- `POST /api/openai/tpv-cobro`
- `POST /api/openai/face-landmarks`
- `POST /api/ocr`
- `POST /api/deepface` — proxy/local DeepFace
- `GET  /api/deepface/status`
- `POST /api/face-analysis/full` — combo DeepFace + OpenAI Vision
- `POST /api/admin/create-staff`
- `POST /api/admin/create-clinic`
- `POST /api/admin/bootstrap-gerente`
- `POST /api/admin/upload-image`
- `POST /api/admin/delete-image`
- `GET|POST /api/erp/*` — todas las operaciones del ERP (bootstrap, turnos, clientes, stock, etc.)

## Variables de entorno

| Variable                    | Obligatoria | Para qué sirve                                                            |
|-----------------------------|-------------|---------------------------------------------------------------------------|
| `PORT`                      | Sí (Render) | Puerto HTTP. Render lo inyecta automáticamente                            |
| `ALLOWED_ORIGIN`            | No          | CORS. Default `*`. Podés poner `https://clinicabetty.vercel.app`          |
| `VITE_SUPABASE_URL`         | Sí          | URL del proyecto Supabase                                                 |
| `SUPABASE_SERVICE_ROLE_KEY` | Sí          | Service role key (NUNCA exponer al cliente)                               |
| `OPENAI_API_KEY`            | Sí          | Clave OpenAI                                                              |
| `GERENTE_SIGNUP_SECRET`     | Opcional    | Secreto para registrar el primer gerente                                  |
| `DEEPFACE_REMOTE_URL`       | Opcional    | URL del deepface-service (otro servicio Render). Si vacío, intenta Python local (no funciona en Docker) |
| `DEEPFACE_REMOTE_TOKEN`     | Opcional    | Token si activaste API_TOKEN en el deepface-service                       |

## Probar localmente

```bash
cd backend-node
npm install
PORT=8765 \
VITE_SUPABASE_URL='https://xxxx.supabase.co' \
SUPABASE_SERVICE_ROLE_KEY='eyJxxx...' \
OPENAI_API_KEY='sk-xxx' \
DEEPFACE_REMOTE_URL='https://clinicabetty.onrender.com' \
node server.js
```

Probá:
```bash
curl http://localhost:8765/health
curl http://localhost:8765/api/erp-state
```

## Deploy en Render (Docker)

### Opción A: usar el `render.yaml` (Blueprint)

1. Pusheá el repo a GitHub.
2. En Render → **New** → **Blueprint** → seleccioná el repo. Render detecta
   `backend-node/render.yaml` y crea el servicio automáticamente.
3. Cargá las variables marcadas como `sync: false` desde la pestaña
   **Environment** del servicio recién creado:
   - `VITE_SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `OPENAI_API_KEY`
   - `DEEPFACE_REMOTE_URL` → `https://clinicabetty.onrender.com`
   - (opcional) `DEEPFACE_REMOTE_TOKEN`
   - (opcional) `GERENTE_SIGNUP_SECRET`
4. **Manual Deploy** → **Deploy latest commit**.

### Opción B: crear el servicio a mano

1. Render → **New** → **Web Service** → seleccioná tu repo.
2. **Root Directory**: `backend-node`
3. **Environment**: `Docker`
4. **Region**: Frankfurt (o la que uses)
5. **Plan**: Starter (suficiente, este servicio es liviano)
6. **Health Check Path**: `/health`
7. Cargá las variables de entorno listadas arriba.
8. Deploy.

Cuando arranque vas a ver en logs:
```
[backend] Escuchando en :10000 · supabase=true · openai=true · deepface=true
```

Anotá la URL pública (algo como `https://clinica-erp-backend.onrender.com`).

## Conectar Vercel al backend

El frontend está en `aplicacion-web/`. Tiene `vercel.json` con dos rewrites:

1. **`/api/:path*` → `https://clinica-erp-backend.onrender.com/api/:path*`**
   Todas las llamadas a `/api/*` desde el navegador van transparentemente al
   backend de Render. **No hace falta cambiar nada en el código del frontend.**

2. **SPA fallback** → `/index.html`
   Para que rutas tipo `/area-medica`, `/admin`, etc. no devuelvan 404 al
   recargar.

⚠️ Si usás otra URL para el backend (no `clinica-erp-backend.onrender.com`),
editá `aplicacion-web/vercel.json` y reemplazá el host del primer rewrite.

### Variables de Vercel

En el proyecto de Vercel del frontend, además de las que ya tenías, necesitás:

```
VITE_SUPABASE_URL          = https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY     = eyJxxx...   (la pública, NO la service role)
VITE_DEEPFACE_URL          = https://clinicabetty.onrender.com
```

(`VITE_DEEPFACE_TOKEN` solo si configuraste `API_TOKEN` en el deepface-service.)

Después de cambiar variables o `vercel.json`, **redeploy**.

## Verificar que todo anda

```bash
# health
curl https://clinica-erp-backend.onrender.com/health

# desde el dominio del frontend (Vercel rewrite)
curl https://clinicabetty.vercel.app/api/erp-state

# SPA route (debe devolver el HTML, no 404)
curl -I https://clinicabetty.vercel.app/area-medica
```

## Mantenimiento futuro

**Hoy hay duplicación**: la lógica de los plugins vive tanto en
`aplicacion-web/vite.config.js` (para `npm run dev`) como en
`backend-node/plugins.mjs` (para producción). Cuando tengas tiempo, refactorizá
para que `vite.config.js` haga `import { ... } from '../backend-node/plugins.mjs'`
y elimine las definiciones locales. Eso te deja una sola fuente de verdad.
