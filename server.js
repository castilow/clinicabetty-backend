#!/usr/bin/env node
/**
 * Backend Node.js standalone para el ERP de Clínica Betty.
 *
 * Monta todos los middlewares que están en aplicacion-web/vite.config.js
 * (copiados en ./plugins.mjs) dentro de una app Express, para poder desplegarlos
 * en un entorno real (Render) en lugar de depender del dev server de Vite.
 *
 * Variables de entorno esperadas:
 *   PORT                          (Render lo inyecta automáticamente)
 *   VITE_SUPABASE_URL             URL del proyecto Supabase (mismo que el front)
 *   SUPABASE_SERVICE_ROLE_KEY     Service role key (secreta, solo server-side)
 *   OPENAI_API_KEY                Clave de OpenAI
 *   GERENTE_SIGNUP_SECRET         Secreto opcional para bootstrap del primer gerente
 *   DEEPFACE_REMOTE_URL           URL del deepface-service (otro servicio de Render)
 *   DEEPFACE_REMOTE_TOKEN         Token opcional si activaste API_TOKEN en DeepFace
 *   ALLOWED_ORIGIN                CORS (default: "*")
 */
import express from 'express'
import cors from 'cors'
import {
  erpStateSyncPlugin,
  openaiProxiesPlugin,
  deepfaceBridgePlugin,
  faceAnalysisFullPlugin,
  adminCreateStaffPlugin,
  adminCreateClinicPlugin,
  bootstrapGerentePlugin,
  erpOperationsPlugin,
  mediaUploadPlugin,
} from './plugins.mjs'

const PORT = Number(process.env.PORT || 8080)
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || ''
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''
const GERENTE_SIGNUP_SECRET = process.env.GERENTE_SIGNUP_SECRET || ''
const DEEPFACE_REMOTE_URL = process.env.DEEPFACE_REMOTE_URL || ''
const DEEPFACE_REMOTE_TOKEN = process.env.DEEPFACE_REMOTE_TOKEN || ''
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*'

const app = express()
// Body parsing: los plugins leen el body con req.on('data') directamente, así
// que NO usamos express.json() para no consumir el stream dos veces.
app.disable('x-powered-by')
app.use(
  cors({
    origin: ALLOWED_ORIGIN === '*' ? true : ALLOWED_ORIGIN.split(',').map(s => s.trim()),
    credentials: false,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
)

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'clinica-erp-backend',
    endpoints: [
      '/health',
      '/api/erp-state',
      '/api/openai/*',
      '/api/ocr',
      '/api/deepface*',
      '/api/face-analysis/full',
      '/api/admin/*',
      '/api/erp/*',
    ],
  })
})

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    supabase: Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE),
    openai: Boolean(OPENAI_API_KEY),
    deepface: Boolean(DEEPFACE_REMOTE_URL),
  })
})

// Adaptador: los plugins esperan un objeto `server` con `middlewares.use(path, handler)`.
// Express `app.use(path, handler)` es API-compatible con connect, así que pasamos un
// proxy que delega en app. httpServer.on('close', ...) lo dejamos no-op porque
// Express lo maneja por su cuenta en .listen().
const fakeServer = {
  middlewares: app,
  httpServer: {
    on: () => { /* no-op en modo backend */ },
  },
}

/** Monta un plugin (retorno de una función factory) en la app. */
function mountPlugin(plugin) {
  if (!plugin) return
  if (typeof plugin.configureServer === 'function') {
    plugin.configureServer(fakeServer)
  }
}

// ─── Montaje de plugins ─────────────────────────────────────────────
mountPlugin(erpStateSyncPlugin())
mountPlugin(openaiProxiesPlugin(OPENAI_API_KEY))

const dfPlugin = deepfaceBridgePlugin({
  remoteUrl: DEEPFACE_REMOTE_URL,
  remoteToken: DEEPFACE_REMOTE_TOKEN,
})
mountPlugin(dfPlugin)
mountPlugin(faceAnalysisFullPlugin(OPENAI_API_KEY, dfPlugin))

mountPlugin(erpOperationsPlugin(SUPABASE_URL, SUPABASE_SERVICE_ROLE))
mountPlugin(mediaUploadPlugin(SUPABASE_URL, SUPABASE_SERVICE_ROLE))
mountPlugin(adminCreateStaffPlugin(SUPABASE_URL, SUPABASE_SERVICE_ROLE))
mountPlugin(adminCreateClinicPlugin(SUPABASE_URL, SUPABASE_SERVICE_ROLE))
mountPlugin(bootstrapGerentePlugin(SUPABASE_URL, SUPABASE_SERVICE_ROLE, GERENTE_SIGNUP_SECRET))

// Fallback 404 para rutas desconocidas bajo /api/*
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Endpoint no encontrado' })
})

app.use((err, _req, res, _next) => {
  console.error('[backend] error no manejado:', err)
  if (res.headersSent) return
  res.status(500).json({ error: String(err?.message || err) })
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(
    `[backend] Escuchando en :${PORT} · supabase=${Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE)} · ` +
      `openai=${Boolean(OPENAI_API_KEY)} · deepface=${Boolean(DEEPFACE_REMOTE_URL)}`
  )
})
