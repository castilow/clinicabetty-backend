// Copia de vite.config.js (solo los plugins de middleware) usable como módulo Node
// independiente. Se consume desde backend-node/server.js (Express).
// IMPORTANTE: si agregás o cambiás un middleware, acordate de mantener también
// aplicacion-web/vite.config.js sincronizado para el entorno de desarrollo.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'

const __viteDirname = path.dirname(fileURLToPath(import.meta.url))
const DEEPFACE_BRIDGE_SCRIPT = path.resolve(__viteDirname, '../face-proportion-overlay/deepface_bridge.py')

/** PostgREST cuando falta la columna en la BD remota (migración no aplicada). */
export function mapSupabaseSchemaError(msg) {
  const s = String(msg || '')
  if (s.includes('auth_user_id') && (s.includes('schema cache') || s.includes('does not exist'))) {
    return (
      'Falta la columna auth_user_id en la tabla empleados. En Supabase → SQL Editor pegá y ejecutá el archivo ' +
      'supabase/migrations/20260331150000_fix_empleados_auth_user_id.sql, o en esta carpeta: npm run db:fix-auth-user-id ' +
      '(necesitás DATABASE_URL en .env.local). Después: Settings → API → Reload schema.'
    )
  }
  if (s.includes('modalidad_negocio') || s.includes('clinic_matriz_id')) {
    return (
      'Falta actualizar la tabla clinics con columnas de tipo/franquicia. Ejecutá la migración ' +
      'supabase/migrations/20260331162000_add_clinics_business_model.sql y luego Settings → API → Reload schema.'
    )
  }
  return s
}

/** Estado compartido en memoria: sincroniza móvil ↔ PC en la misma red (solo dev / vite preview). */
export function erpStateSyncPlugin() {
  let state = null
  const mount = (server) => {
    server.middlewares.use('/api/erp-state', (req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      if (req.method === 'OPTIONS') {
        res.statusCode = 204
        return res.end()
      }
      if (req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        if (!state) return res.end(JSON.stringify({ _empty: true }))
        return res.end(JSON.stringify(state))
      }
      if (req.method === 'POST') {
        const chunks = []
        req.on('data', (c) => { chunks.push(c) })
        req.on('end', () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf8')
            state = JSON.parse(raw || '{}')
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({ ok: true, rev: state._meta?.rev ?? 0 }))
          } catch (e) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: String(e?.message || e) }))
          }
        })
        return
      }
      next()
    })
  }
  return {
    name: 'erp-state-sync',
    configureServer: mount,
    configurePreviewServer: mount,
  }
}

/** Sesión médica: modelo principal. Visión (landmarks, OCR): mismo modelo multimodal. */
const OPENAI_MODEL_SESSION = 'gpt-5.4'
const OPENAI_MODEL_VISION = 'gpt-5.4'
/** Transcripción de audio: más fiel que whisper-1 para dictado clínico largo. */
const OPENAI_MODEL_TRANSCRIBE = 'gpt-4o-transcribe'

/** Payload Chat Completions para GPT-5.4 (salida larga JSON, razonamiento mínimo para latencia). */
function bodyDoctorSessionCompletion(messages) {
  return {
    model: OPENAI_MODEL_SESSION,
    messages,
    response_format: { type: 'json_object' },
    max_completion_tokens: 16384,
  }
}

/** Prompt compartido: evaluación extensa y redacción clínica profesional (sesión médica). */
function buildDoctorSessionSystemContent(servStr, stockStr, anamnesisPrevStr) {
  const prev = String(anamnesisPrevStr || "{}").slice(0, 4000)
  return `Eres asistente clínico para completar la ficha de una sesión médico-estética (España / UE). El contenido proviene del dictado o transcripción del profesional. Responde SOLO un JSON válido con esta forma exacta (sin markdown):
{"motivoConsulta":"string","evaluacion":"string","servicioId":number|null,"serviciosIds":[number],"nuevoServicio":{"nombre":"string","cat":"valoracion|clinico|facial|corporal|laser|botox","precio":number|null,"duracion":number|null}|null,"protocolo":"string","notas":"string","alergias":["string"],"tratamientos":["string"],"insumos":[{"stockId":number,"cantidad":number}],"anamnesis":{"antecedentes":"string","medicacion":"string","fuma":"string","embarazo":"string","piel":"string","observaciones":"string"}}

Anamnesis (cuestionario ficha paciente):
- anamnesis.antecedentes: antecedentes personales/familiares relevantes que el médico mencione.
- anamnesis.medicacion: fármacos o suplementos que cite el dictado.
- anamnesis.fuma: sí/no o breve descripción si habla de tabaco.
- anamnesis.embarazo: solo si aplica (embarazo, lactancia, métodos anticonceptivos si lo dicen).
- anamnesis.piel: tipo de piel, patologías dermatológicas, sensibilidad, si lo mencionan.
- anamnesis.observaciones: otros datos clínicos del dictado que encajen aquí.
- Usá cadenas vacías "" para campos que el dictado no aborde. NO inventes datos de anamnesis.
- Anamnesis ya guardada en ficha (fusionar): ${prev}
  Si hay texto previo y el dictado solo añade detalle, integrá o ampliá sin borrar hechos; si el médico corrige algo, actualizá ese campo.

Fidelidad al dictado (obligatorio):
- evaluacion y protocolo deben reflejar con exactitud lo dicho o transcrito: organizá, unificá términos médicos y redactá en estilo clínico, pero NO inventes tratamientos, productos, dosis, zonas, hallazgos, alergias ni planes que el profesional no haya mencionado.
- Si algo no está en el texto de entrada, no lo incluyas como hecho; usá formulaciones neutras solo cuando el dictado sea ambiguo y marcá la incertidumbre en notas si hace falta.
- No inventes procedimientos que el texto no mencione. Si el texto describe solo valoración o primera consulta sin tratamiento aplicado, no conviertas eso en cirugía o relleno.

Redacción y extensión (importante):
- Usá español (España), tono profesional, claro y apto para historia clínica / auditoría.
- evaluacion: texto clínico COMPLETO. Incluí todo el detalle del dictado; podés usar varios párrafos separados por \\n. Si el dictado es largo, conservá el contenido sin resumir en exceso.
- protocolo: descripción detallada en lenguaje técnico-profesional solo con lo mencionado (técnica, zonas, unidades o dosis si se citan).
- notas: seguimiento, advertencias, próximos pasos o observaciones adicionales; si no aplica, cadena vacía o un breve párrafo según contexto.
- motivoConsulta: motivo principal de la visita en una sola frase clara.

Facturación: servicio(s) tabulados vs insumos (obligatorio entender la diferencia):
- insumos = producto/material del almacén consumido (vial, ampolla, etc.): rellená stockId+cantidad cuando el dictado lo permita. Eso NO reemplaza los servicios a facturar.
- serviciosIds = ARRAY de ids numéricos del catálogo de SERVICIOS: un id por cada acto clínico-estético DISTINTO facturable que el relato indique haber realizado en la misma sesión (ej. relleno con AH + masoterapia → dos ids). Sin duplicados. Orden: del acto principal o más costoso primero si aplica.
- servicioId = redundante pero obligatorio para compatibilidad: igual que serviciosIds[0] si serviciosIds no está vacío; si solo hay un acto, un elemento en serviciosIds y el mismo número en servicioId; si serviciosIds es [], null en ambos salvo que uses un solo servicioId clásico.
- Si el dictado describe procedimientos realizados (rellenos, toxina, peeling, masaje/masoterapia corporal o facial, láser, hilos, microneedling, etc.), DEBÉS incluir en serviciosIds cada id del catálogo que encaje por significado con cada acto, aunque el nombre no sea idéntimo al dictado.
- NO dejes serviciosIds vacío ni elijas por defecto solo «Valoración» si el texto indica varios actos ya realizados. Reservá valoración solo cuando el relato sea efectivamente consulta sin procedimiento aplicado.
- nuevoServicio: devolvé objeto solo si ningún id del catálogo encaja razonablemente con el acto descrito o si el profesional pide crear un ítem nuevo; nombre y cat acordes al procedimiento (precio/duración opcionales). Si ya elegiste servicioId del catálogo, null.

- alergias: lista de alergias identificadas de forma explícita en el dictado.
- tratamientos: lista de tratamientos/planes activos mencionados por el profesional.
- insumos: solo {stockId, cantidad} para ids existentes en el stock cuando el texto sugiera cantidades razonables; si no aplica, [].

Catálogo servicios (cada ítem: id, nombre, precio, categoría) — recorré TODA la lista y compará con evaluación/protocolo/motivo antes de fijar servicioId: ${servStr}
Stock insumos (id, nombre) — productos consumibles; coherente con lo dicho pero independiente del servicio facturable: ${stockStr}`
}

function buildResultadoSesionSystemContent(protocoloSnippet) {
  const ctx = String(protocoloSnippet || "").trim().slice(0, 1200)
  return `Eres asistente clínico para una clínica médico-estética (España). El profesional describe el RESULTADO inmediato o la evolución tras el tratamiento en esta sesión (no la valoración previa).
Responde SOLO un JSON válido: {"resultado":"string"}
Reglas:
- resultado: texto clínico completo, fiel al dictado, sin inventar hallazgos ni procedimientos no mencionados. Español (España), tono profesional.
${ctx ? `Contexto opcional (protocolo de la sesión): ${ctx}` : ""}`
}

/** Proxy API de IA: la clave no sale al navegador y se evita CORS. */
export function openaiProxiesPlugin(openaiKey) {
  const mount = (server) => {
    server.middlewares.use('/api/openai/resultado-sesion', (req, res, next) => {
      if (req.method !== "POST") return next()
      const chunks = []
      req.on("data", c => chunks.push(c))
      req.on("end", async () => {
        res.setHeader("Content-Type", "application/json; charset=utf-8")
        try {
          if (!openaiKey) {
            res.statusCode = 503
            return res.end(JSON.stringify({
              error: "Configurá la clave de API de IA en .env.local y reiniciá el servidor de desarrollo.",
            }))
          }
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
          const { texto, protocolo } = body
          if (!texto || typeof texto !== "string") {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: "Falta texto" }))
          }
          const r = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${openaiKey}`,
            },
            body: JSON.stringify({
              model: OPENAI_MODEL_SESSION,
              messages: [
                { role: "system", content: buildResultadoSesionSystemContent(typeof protocolo === "string" ? protocolo : "") },
                { role: "user", content: texto.trim() },
              ],
              response_format: { type: "json_object" },
              max_completion_tokens: 8192,
            }),
          })
          const buf = await r.text()
          res.statusCode = r.status
          res.end(buf)
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })
    })

    server.middlewares.use('/api/openai/doctor-session', (req, res, next) => {
      if (req.method !== 'POST') return next()
      const chunks = []
      req.on('data', (c) => { chunks.push(c) })
      req.on('end', async () => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        try {
          if (!openaiKey) {
            res.statusCode = 503
            return res.end(JSON.stringify({
              error: 'Configurá la clave de API de IA en .env.local y reiniciá el servidor de desarrollo.',
            }))
          }
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          const { texto, servicios, stock, anamnesisActual } = body
          if (!texto || typeof texto !== 'string') {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: 'Falta texto' }))
          }
          const servStr = JSON.stringify(servicios || [])
          const stockStr = JSON.stringify(stock || [])
          const anamStr = JSON.stringify(anamnesisActual && typeof anamnesisActual === 'object' ? anamnesisActual : {})
          const r = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${openaiKey}`,
            },
            body: JSON.stringify(
              bodyDoctorSessionCompletion([
                {
                  role: 'system',
                  content: buildDoctorSessionSystemContent(servStr, stockStr, anamStr),
                },
                { role: 'user', content: texto.trim() },
              ]),
            ),
          })
          const buf = await r.text()
          res.statusCode = r.status
          res.end(buf)
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })
    })

    /** Audio (base64) → GPT-4o Transcribe → misma extracción JSON que doctor-session. */
    server.middlewares.use('/api/openai/doctor-audio', (req, res, next) => {
      if (req.method !== 'POST') return next()
      const chunks = []
      req.on('data', (c) => { chunks.push(c) })
      req.on('end', async () => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        try {
          if (!openaiKey) {
            res.statusCode = 503
            return res.end(JSON.stringify({
              error: 'Configurá la clave de API de IA en .env.local y reiniciá el servidor de desarrollo.',
            }))
          }
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          const { audioBase64, mimeType, servicios, stock, anamnesisActual } = body
          if (!audioBase64 || typeof audioBase64 !== 'string') {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: 'Falta audioBase64' }))
          }
          const buffer = Buffer.from(audioBase64, 'base64')
          if (buffer.length < 64) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: 'Audio vacío o demasiado corto' }))
          }
          const mt = typeof mimeType === 'string' ? mimeType : 'audio/webm'
          const ext = mt.includes('mp4') || mt.includes('m4a') ? 'm4a'
            : mt.includes('mpeg') || mt.includes('mp3') ? 'mp3'
              : mt.includes('wav') ? 'wav'
                : mt.includes('ogg') ? 'ogg'
                  : mt.includes('webm') ? 'webm'
                    : 'webm'
          const form = new FormData()
          form.append('file', new Blob([buffer], { type: mt }), `grabacion.${ext}`)
          form.append('model', OPENAI_MODEL_TRANSCRIBE)
          form.append('language', 'es')
          const tr = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${openaiKey}` },
            body: form,
          })
          const trRaw = await tr.text()
          if (!tr.ok) {
            res.statusCode = tr.status
            try {
              const j = JSON.parse(trRaw)
              return res.end(JSON.stringify({ error: j.error?.message || trRaw }))
            } catch {
              return res.end(JSON.stringify({ error: trRaw || 'Error en transcripción' }))
            }
          }
          let texto = ''
          try {
            texto = (JSON.parse(trRaw).text || '').trim()
          } catch {
            texto = trRaw.trim()
          }
          if (!texto) {
            res.statusCode = 400
            return res.end(JSON.stringify({
              error: 'No se pudo transcribir el audio. Probá hablar más cerca del micrófono o más largo.',
            }))
          }
          const servStr = JSON.stringify(servicios || [])
          const stockStr = JSON.stringify(stock || [])
          const anamStr = JSON.stringify(anamnesisActual && typeof anamnesisActual === 'object' ? anamnesisActual : {})
          const r = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${openaiKey}`,
            },
            body: JSON.stringify(
              bodyDoctorSessionCompletion([
                {
                  role: 'system',
                  content: buildDoctorSessionSystemContent(servStr, stockStr, anamStr),
                },
                { role: 'user', content: texto },
              ]),
            ),
          })
          const buf = await r.text()
          if (!r.ok) {
            res.statusCode = r.status
            return res.end(buf)
          }
          let chatPayload
          try {
            chatPayload = JSON.parse(buf)
          } catch {
            res.statusCode = 502
            return res.end(JSON.stringify({ error: 'Respuesta inválida del modelo', transcript: texto }))
          }
          const content = chatPayload.choices?.[0]?.message?.content
          if (!content) {
            res.statusCode = 502
            return res.end(JSON.stringify({ error: 'Respuesta vacía del modelo', transcript: texto }))
          }
          let parsed
          try {
            parsed = JSON.parse(content)
          } catch {
            res.statusCode = 502
            return res.end(JSON.stringify({ error: 'JSON del modelo inválido', transcript: texto }))
          }
          res.end(JSON.stringify({ transcript: texto, ...parsed }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })
    })

    /** Audio → transcripción → JSON solo { resultado } (fase Resultado del área médica). */
    server.middlewares.use('/api/openai/resultado-audio', (req, res, next) => {
      if (req.method !== "POST") return next()
      const chunks = []
      req.on("data", c => chunks.push(c))
      req.on("end", async () => {
        res.setHeader("Content-Type", "application/json; charset=utf-8")
        try {
          if (!openaiKey) {
            res.statusCode = 503
            return res.end(JSON.stringify({
              error: "Configurá la clave de API de IA en .env.local y reiniciá el servidor de desarrollo.",
            }))
          }
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
          const { audioBase64, mimeType, protocolo } = body
          if (!audioBase64 || typeof audioBase64 !== "string") {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: "Falta audioBase64" }))
          }
          const buffer = Buffer.from(audioBase64, "base64")
          if (buffer.length < 64) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: "Audio vacío o demasiado corto" }))
          }
          const mt = typeof mimeType === "string" ? mimeType : "audio/webm"
          const ext = mt.includes("mp4") || mt.includes("m4a") ? "m4a"
            : mt.includes("mpeg") || mt.includes("mp3") ? "mp3"
              : mt.includes("wav") ? "wav"
                : mt.includes("ogg") ? "ogg"
                  : mt.includes("webm") ? "webm"
                    : "webm"
          const form = new FormData()
          form.append("file", new Blob([buffer], { type: mt }), `grabacion.${ext}`)
          form.append("model", OPENAI_MODEL_TRANSCRIBE)
          form.append("language", "es")
          const tr = await fetch("https://api.openai.com/v1/audio/transcriptions", {
            method: "POST",
            headers: { Authorization: `Bearer ${openaiKey}` },
            body: form,
          })
          const trRaw = await tr.text()
          if (!tr.ok) {
            res.statusCode = tr.status
            try {
              const j = JSON.parse(trRaw)
              return res.end(JSON.stringify({ error: j.error?.message || trRaw }))
            } catch {
              return res.end(JSON.stringify({ error: trRaw || "Error en transcripción" }))
            }
          }
          let texto = ""
          try {
            texto = (JSON.parse(trRaw).text || "").trim()
          } catch {
            texto = trRaw.trim()
          }
          if (!texto) {
            res.statusCode = 400
            return res.end(JSON.stringify({
              error: "No se pudo transcribir el audio. Probá hablar más cerca del micrófono o más largo.",
            }))
          }
          const prot = typeof protocolo === "string" ? protocolo : ""
          const r = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${openaiKey}`,
            },
            body: JSON.stringify({
              model: OPENAI_MODEL_SESSION,
              messages: [
                { role: "system", content: buildResultadoSesionSystemContent(prot) },
                { role: "user", content: texto },
              ],
              response_format: { type: "json_object" },
              max_completion_tokens: 8192,
            }),
          })
          const buf = await r.text()
          if (!r.ok) {
            res.statusCode = r.status
            return res.end(buf)
          }
          let chatPayload
          try {
            chatPayload = JSON.parse(buf)
          } catch {
            res.statusCode = 502
            return res.end(JSON.stringify({ error: "Respuesta inválida del modelo", transcript: texto }))
          }
          const content = chatPayload.choices?.[0]?.message?.content
          if (!content) {
            res.statusCode = 502
            return res.end(JSON.stringify({ error: "Respuesta vacía del modelo", transcript: texto }))
          }
          let parsed
          try {
            parsed = JSON.parse(content)
          } catch {
            res.statusCode = 502
            return res.end(JSON.stringify({ error: "JSON del modelo inválido", transcript: texto }))
          }
          res.end(JSON.stringify({ transcript: texto, ...parsed }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })
    })

    server.middlewares.use('/api/openai/tpv-cobro', (req, res, next) => {
      if (req.method !== 'POST') return next()
      const chunks = []
      req.on('data', (c) => { chunks.push(c) })
      req.on('end', async () => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        try {
          if (!openaiKey) {
            res.statusCode = 503
            return res.end(JSON.stringify({
              error: 'Configurá la clave de API de IA en .env.local y reiniciá el servidor de desarrollo.',
            }))
          }
          const { texto, catalogo } = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          if (!texto || typeof texto !== 'string') {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: 'Falta texto' }))
          }
          const catStr = JSON.stringify(catalogo || [])
          const r = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${openaiKey}`,
            },
            body: JSON.stringify({
              model: 'gpt-4o-mini',
              messages: [
                {
                  role: 'system',
                  content:
                    `Eres asistente de TPV para clínica estética (España). Responde SOLO un JSON con esta forma exacta:
{"lineas":[{"nombre":"string","monto":number,"cantidad":number}],"metodo":"efectivo"|"tarjeta"|"transferencia","comprobante":""}
Reglas:
- lineas: ítems a cobrar; monto es precio unitario en euros (EUR). Si el usuario nombra algo parecido a un servicio del catálogo, usa el precio del catálogo salvo que indique otro importe.
- cantidad entera >= 1.
- metodo: efectivo si dice efectivo/plata/en efectivo; tarjeta si dice tarjeta/débito/crédito/pos/visa; transferencia si dice transferencia/transfer/banco.
- comprobante: número solo si el usuario lo dicta; si no, cadena vacía.
Catálogo servicios: ${catStr}`,
                },
                { role: 'user', content: texto.trim() },
              ],
              response_format: { type: 'json_object' },
              temperature: 0.2,
            }),
          })
          const buf = await r.text()
          res.statusCode = r.status
          res.end(buf)
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })
    })

    server.middlewares.use('/api/openai/face-landmarks', (req, res, next) => {
      if (req.method !== 'POST') return next()
      const chunks = []
      req.on('data', (c) => { chunks.push(c) })
      req.on('end', async () => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        try {
          if (!openaiKey) {
            res.statusCode = 503
            return res.end(JSON.stringify({ error: 'Configurá OPENAI_API_KEY en .env.local.' }))
          }
          const { imageBase64 } = JSON.parse(Buffer.concat(chunks).toString())
          if (!imageBase64) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: 'Falta imageBase64' }))
          }
          const dataUrl = imageBase64.startsWith('data:') ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`
          const r = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${openaiKey}`,
            },
            body: JSON.stringify({
              model: OPENAI_MODEL_VISION,
              max_completion_tokens: 4096,
              messages: [
                {
                  role: 'system',
                  content: `Eres un sistema de análisis facial para una clínica de estética. Analiza la foto y devuelve las coordenadas de los landmarks faciales como porcentajes (0-100) del ancho y alto de la imagen. Responde SOLO con JSON válido, sin markdown.

Formato exacto:
{
  "found": true,
  "faceBox": { "x": number, "y": number, "w": number, "h": number },
  "landmarks": {
    "eyeLeft": { "x": number, "y": number },
    "eyeRight": { "x": number, "y": number },
    "eyebrowLeftOuter": { "x": number, "y": number },
    "eyebrowLeftInner": { "x": number, "y": number },
    "eyebrowRightInner": { "x": number, "y": number },
    "eyebrowRightOuter": { "x": number, "y": number },
    "noseBridge": { "x": number, "y": number },
    "noseTip": { "x": number, "y": number },
    "noseLeftAla": { "x": number, "y": number },
    "noseRightAla": { "x": number, "y": number },
    "mouthLeft": { "x": number, "y": number },
    "mouthRight": { "x": number, "y": number },
    "mouthTop": { "x": number, "y": number },
    "mouthBottom": { "x": number, "y": number },
    "chinTip": { "x": number, "y": number },
    "jawLeft": { "x": number, "y": number },
    "jawRight": { "x": number, "y": number },
    "foreheadCenter": { "x": number, "y": number },
    "cheekLeft": { "x": number, "y": number },
    "cheekRight": { "x": number, "y": number },
    "earLeft": { "x": number, "y": number },
    "earRight": { "x": number, "y": number },
    "glabellaCenter": { "x": number, "y": number },
    "nasolabialLeft": { "x": number, "y": number },
    "nasolabialRight": { "x": number, "y": number }
  }
}
Si no hay rostro visible, responde: { "found": false }
Los valores x e y son porcentajes (0 = izquierda/arriba, 100 = derecha/abajo) relativos a la imagen completa.
Sé lo más preciso posible con las coordenadas.`
                },
                {
                  role: 'user',
                  content: [
                    { type: 'text', text: 'Analiza esta foto y devuelve los landmarks faciales en JSON.' },
                    { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
                  ],
                },
              ],
            }),
          })
          const raw = await r.text()
          if (!r.ok) {
            res.statusCode = 502
            return res.end(JSON.stringify({ error: `OpenAI ${r.status}: ${raw.slice(0, 300)}` }))
          }
          const j = JSON.parse(raw)
          const txt = j.choices?.[0]?.message?.content || ''
          const clean = txt.replace(/```json\s*/gi, '').replace(/```/g, '').trim()
          const parsed = JSON.parse(clean)
          res.end(JSON.stringify(parsed))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })
    })

    /** JPEG base64 → OpenAI OCR (mismo prompt que face-proportion-overlay/face_overlay_server.py). */
    server.middlewares.use('/api/ocr', (req, res, next) => {
      if (req.method !== 'POST') return next()
      const chunks = []
      req.on('data', (c) => { chunks.push(c) })
      req.on('end', async () => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        try {
          if (!openaiKey) {
            res.statusCode = 503
            return res.end(JSON.stringify({
              error: 'Configurá OPENAI_API_KEY en .env.local y reiniciá el servidor de desarrollo.',
            }))
          }
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          const b64 = (body.image_base64 || '').trim()
          if (!b64) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: 'image_base64 vacío' }))
          }
          const dataUrl = `data:image/jpeg;base64,${b64}`
          const r = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${openaiKey}`,
            },
            body: JSON.stringify({
              model: OPENAI_MODEL_VISION,
              messages: [
                {
                  role: 'user',
                  content: [
                    {
                      type: 'text',
                      text:
                        'Extrae todo el texto visible en la imagen (OCR). '
                        + 'Transcribe letras y números con fidelidad. '
                        + 'Si no hay texto legible, responde exactamente: (sin texto visible). '
                        + 'Responde solo con el texto extraído, sin markdown ni comillas.',
                    },
                    { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
                  ],
                },
              ],
              max_completion_tokens: 8192,
            }),
          })
          const raw = await r.text()
          if (!r.ok) {
            res.statusCode = 502
            let detail = raw
            try {
              const j = JSON.parse(raw)
              detail = j.error?.message || raw
            } catch {
              /* ignore */
            }
            return res.end(JSON.stringify({ error: detail }))
          }
          const j = JSON.parse(raw)
          const text = (j.choices?.[0]?.message?.content || '').trim()
          res.end(JSON.stringify({ text }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })
    })
  }
  return {
    name: 'openai-proxies',
    configureServer: mount,
    configurePreviewServer: mount,
  }
}

/** DeepFace vía Python (face-proportion-overlay/deepface_bridge.py)
 *  o vía servicio HTTP remoto (Render) si se define DEEPFACE_REMOTE_URL. */
export function deepfaceBridgePlugin(opts = {}) {
  const python = process.env.PYTHON || 'python3'
  const requestTimeoutMs = 60000

  // ─── Modo remoto (servicio HTTP tipo FastAPI en Render) ───
  const remoteUrlRaw = (opts.remoteUrl || process.env.DEEPFACE_REMOTE_URL || '').trim()
  const remoteToken = (opts.remoteToken || process.env.DEEPFACE_REMOTE_TOKEN || '').trim()
  const useRemote = Boolean(remoteUrlRaw)
  const remoteBase = useRemote ? remoteUrlRaw.replace(/\/+$/, '') : ''

  if (useRemote) {
    console.info(`[deepface-bridge] Modo remoto activo → ${remoteBase}`)
    const remoteAnalyze = async (b64) => {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), requestTimeoutMs)
      try {
        const headers = { 'Content-Type': 'application/json' }
        if (remoteToken) headers['Authorization'] = `Bearer ${remoteToken}`
        const resp = await fetch(`${remoteBase}/analyze`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ image_base64: b64 }),
          signal: ctrl.signal,
        })
        const text = await resp.text()
        let j
        try { j = JSON.parse(text) } catch {
          throw new Error(`Respuesta no-JSON del servicio DeepFace (HTTP ${resp.status})`)
        }
        if (!resp.ok) {
          throw new Error(j?.error || j?.detail || `HTTP ${resp.status}`)
        }
        if (j && j.ok === false) {
          throw new Error(j.error || 'DeepFace error')
        }
        return j
      } finally {
        clearTimeout(t)
      }
    }
    const remoteStatus = async () => {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 8000)
      try {
        const resp = await fetch(`${remoteBase}/status`, { signal: ctrl.signal })
        const j = await resp.json().catch(() => ({}))
        return {
          ok: resp.ok && j?.ok !== false,
          running: true,
          ready: !!j?.ready,
          warming: !!j?.warming,
          pending: 0,
          queued: 0,
          remote: remoteBase,
          error: j?.error || (resp.ok ? undefined : `HTTP ${resp.status}`),
        }
      } catch (e) {
        return {
          ok: false,
          running: false,
          ready: false,
          warming: false,
          pending: 0,
          queued: 0,
          remote: remoteBase,
          error: String(e?.message || e),
        }
      } finally {
        clearTimeout(t)
      }
    }
    const mountRemote = (server) => {
      server.middlewares.use('/api/deepface/status', (req, res, next) => {
        if (req.method !== 'GET') return next()
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        remoteStatus().then((s) => {
          res.statusCode = 200
          res.end(JSON.stringify(s))
        })
      })
      server.middlewares.use('/api/deepface', (req, res, next) => {
        if (req.method !== 'POST') return next()
        const chunks = []
        req.on('data', (c) => { chunks.push(c) })
        req.on('end', async () => {
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          let body
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          } catch {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: 'JSON inválido' }))
          }
          const b64 = (body.image_base64 || '').trim()
          if (!b64) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: 'image_base64 vacío' }))
          }
          try {
            const j = await remoteAnalyze(b64)
            res.statusCode = 200
            return res.end(JSON.stringify(j))
          } catch (e) {
            res.statusCode = 502
            return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }))
          }
        })
      })
    }
    return {
      name: 'deepface-bridge',
      configureServer: mountRemote,
      configurePreviewServer: mountRemote,
      api: {
        analyze: remoteAnalyze,
        status: remoteStatus,
        ensureStarted: () => { /* no-op en modo remoto */ },
      },
    }
  }

  let worker = null
  let workerStdoutBuf = ''
  let workerReady = false
  let workerWarming = false
  let workerFatal = ''
  let currentJob = null
  const queue = []
  let nextId = 1
  const pendingById = new Map()

  const failJob = (job, message) => {
    if (!job) return
    if (job.timer) clearTimeout(job.timer)
    job.reject(new Error(message))
  }

  const failAll = (message) => {
    if (currentJob) {
      const j = currentJob
      currentJob = null
      failJob(j, message)
    }
    for (const j of pendingById.values()) failJob(j, message)
    pendingById.clear()
    while (queue.length) failJob(queue.shift(), message)
  }

  const resolveJob = (job, payload) => {
    if (!job) return
    if (job.timer) clearTimeout(job.timer)
    job.resolve(payload)
  }

  const spawnWorker = () => {
    if (worker) return worker
    workerStdoutBuf = ''
    workerReady = false
    workerWarming = false
    workerFatal = ''
    try {
      worker = spawn(python, [DEEPFACE_BRIDGE_SCRIPT, '--serve'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      })
    } catch (e) {
      workerFatal = `No se pudo ejecutar Python (${python}): ${String(e?.message || e)}`
      worker = null
      return null
    }
    worker.stderr.on('data', (d) => {
      const s = d.toString()
      if (s.includes('[deepface_bridge]')) process.stderr.write(s)
    })
    worker.stdout.on('data', (chunk) => {
      workerStdoutBuf += chunk.toString()
      const lines = workerStdoutBuf.split('\n')
      workerStdoutBuf = lines.pop() || ''
      for (const line of lines) {
        const raw = line.trim()
        if (!raw) continue
        let j
        try { j = JSON.parse(raw) } catch {
          if (currentJob) {
            const job = currentJob
            currentJob = null
            failJob(job, 'Respuesta inválida del análisis DeepFace')
          }
          continue
        }
        if (j && typeof j === 'object' && j.event) {
          if (j.event === 'starting') { workerReady = false; workerWarming = false; continue }
          if (j.event === 'ready') {
            workerReady = true
            workerWarming = !!j.warming
            if (!workerWarming) pump()
            continue
          }
          if (j.event === 'fatal') {
            workerFatal = String(j.error || 'DeepFace fatal')
            failAll(workerFatal)
            try { worker?.kill('SIGKILL') } catch { /* ignore */ }
            worker = null
            continue
          }
          continue
        }
        let job = null
        if (j && typeof j === 'object' && j.id != null && pendingById.has(j.id)) {
          job = pendingById.get(j.id)
          pendingById.delete(j.id)
          if (currentJob === job) currentJob = null
        } else if (currentJob) {
          job = currentJob
          currentJob = null
        }
        if (!job) continue
        if (j?.ok === false) failJob(job, j.error || 'DeepFace error')
        else resolveJob(job, j)
      }
      pump()
    })
    worker.on('error', (e) => {
      workerFatal = `No se pudo ejecutar Python (${python}). Instalá Python 3 o definí PYTHON en .env.local. ${e}`
      worker = null
      workerReady = false
      failAll(workerFatal)
    })
    worker.on('close', (code) => {
      const msg = code === 0
        ? 'Proceso DeepFace finalizado'
        : `El proceso Python DeepFace terminó con código ${code}`
      worker = null
      workerReady = false
      workerWarming = false
      failAll(msg)
    })
    return worker
  }

  const pump = () => {
    if (currentJob || queue.length === 0) return
    const proc = spawnWorker()
    if (!proc) {
      failAll(workerFatal || 'DeepFace no disponible')
      return
    }
    if (!workerReady || workerWarming) return
    if (!proc.stdin || proc.stdin.destroyed) {
      failAll('DeepFace no disponible: stdin del worker cerrado')
      return
    }
    const job = queue.shift()
    currentJob = job
    const id = nextId++
    job.id = id
    pendingById.set(id, job)
    job.timer = setTimeout(() => {
      if (pendingById.get(id) === job) pendingById.delete(id)
      if (currentJob === job) currentJob = null
      failJob(job, 'DeepFace demoró demasiado en responder')
      pump()
    }, requestTimeoutMs)
    try {
      proc.stdin.write(`${JSON.stringify({ id, image_base64: job.b64 })}\n`)
    } catch (e) {
      pendingById.delete(id)
      if (currentJob === job) currentJob = null
      failJob(job, `No se pudo enviar imagen al worker DeepFace: ${String(e?.message || e)}`)
      pump()
    }
  }

  const analyze = (b64) => new Promise((resolve, reject) => {
    queue.push({ b64, resolve, reject, timer: null, id: null })
    pump()
  })

  const status = () => ({
    ok: !workerFatal,
    running: !!worker,
    ready: workerReady && !workerWarming,
    warming: workerWarming,
    pending: pendingById.size,
    queued: queue.length,
    error: workerFatal || undefined,
  })

  const ensureStarted = () => {
    if (!worker && !workerFatal) spawnWorker()
  }

  const mount = (server) => {
    // Arranca Python ni bien inicia el dev server: los modelos se cargan en background.
    ensureStarted()

    server.middlewares.use('/api/deepface/status', (req, res, next) => {
      if (req.method !== 'GET') return next()
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.statusCode = 200
      res.end(JSON.stringify(status()))
    })

    server.middlewares.use('/api/deepface', (req, res, next) => {
      if (req.method !== 'POST') return next()
      const chunks = []
      req.on('data', (c) => { chunks.push(c) })
      req.on('end', async () => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        let body
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        } catch {
          res.statusCode = 400
          return res.end(JSON.stringify({ error: 'JSON inválido' }))
        }
        const b64 = (body.image_base64 || '').trim()
        if (!b64) {
          res.statusCode = 400
          return res.end(JSON.stringify({ error: 'image_base64 vacío' }))
        }
        try {
          const j = await analyze(b64)
          res.statusCode = 200
          return res.end(JSON.stringify(j))
        } catch (e) {
          res.statusCode = 500
          return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }))
        }
      })
    })
    server.httpServer?.on?.('close', () => {
      try { worker?.kill('SIGKILL') } catch { /* ignore */ }
      worker = null
      failAll('Worker DeepFace cerrado')
    })
  }
  return {
    name: 'deepface-bridge',
    configureServer: mount,
    configurePreviewServer: mount,
    api: { analyze, status, ensureStarted },
  }
}

/**
 * Combina DeepFace (local) + OpenAI Vision → análisis clínico-estético.
 * Requiere deepfacePlugin (para reusar su worker Python) y la clave OpenAI.
 */
export function faceAnalysisFullPlugin(openaiKey, deepfacePlugin) {
  const buildSystemPrompt = () => (
    `Eres asistente clínico-estético para una clínica médico-estética (España). Análisis asistido por IA de una fotografía de rostro.
Recibes una imagen del paciente y datos objetivos obtenidos con DeepFace (edad estimada, emoción, etc). Devuelve SOLO un JSON válido con esta forma exacta:
{
  "tipoPiel": "seca|mixta|grasa|sensible|madura|normal|indeterminada",
  "fototipo": "I|II|III|IV|V|VI|indeterminado",
  "hidratacion": "baja|media|alta|indeterminada",
  "luminosidad": "apagada|normal|radiante|indeterminada",
  "simetria": "string (descripción breve en español)",
  "arrugas": ["string"],
  "manchas": "string",
  "porosYTextura": "string",
  "ojeras": "string",
  "flacidez": "string",
  "observacionesClinicas": "string",
  "recomendaciones": ["string"],
  "alertas": ["string"],
  "disclaimer": "Análisis estético asistido por IA; no reemplaza valoración médica presencial."
}
Reglas:
- Español (España), tono clínico y claro.
- Describe SOLO lo que sea observable en la foto; si algo no se puede determinar, pon "indeterminada" / "indeterminado" o cadena vacía.
- Recomendaciones: 3 a 6 ítems breves (rutina cosmética, tratamientos sugeridos, cuidados). No recetes fármacos ni dosis.
- Alertas: lesiones sospechosas, asimetrías marcadas, signos que ameriten derivación (si aplica).
- No inventes la edad; usá la edad aportada por DeepFace como contexto.
- NUNCA devuelvas texto fuera del JSON.`
  )

  const callOpenAiVision = async (imageB64, deepfaceData) => {
    if (!openaiKey) throw new Error('Falta OPENAI_API_KEY en el servidor')
    const df = deepfaceData || {}
    const ctx = JSON.stringify({
      edad: df.age,
      genero: df.dominant_gender,
      emocion: df.dominant_emotion,
      etnia: df.dominant_race,
      face_confidence: df.face_confidence,
    })
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          {
            role: 'user',
            content: [
              { type: 'text', text: `Datos DeepFace (contexto objetivo): ${ctx}. Analizá el rostro de la imagen.` },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageB64}`, detail: 'low' } },
            ],
          },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 900,
        temperature: 0.2,
      }),
    })
    const text = await resp.text()
    if (!resp.ok) {
      let detail = text
      try { detail = JSON.parse(text)?.error?.message || text } catch { /* keep raw */ }
      throw new Error(`OpenAI Vision: ${detail}`)
    }
    let parsed
    try { parsed = JSON.parse(text) } catch { throw new Error('Respuesta inválida de OpenAI') }
    const content = parsed?.choices?.[0]?.message?.content || ''
    try { return JSON.parse(content) } catch { throw new Error('El modelo no devolvió JSON válido') }
  }

  const mount = (server) => {
    server.middlewares.use('/api/face-analysis/full', (req, res, next) => {
      if (req.method !== 'POST') return next()
      const chunks = []
      req.on('data', c => chunks.push(c))
      req.on('end', async () => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          const b64 = (body.image_base64 || '').trim()
          if (!b64) {
            res.statusCode = 400
            return res.end(JSON.stringify({ ok: false, error: 'image_base64 vacío' }))
          }
          const includeAi = body.includeAi !== false
          const deepfaceApi = deepfacePlugin?.api
          if (!deepfaceApi?.analyze) {
            res.statusCode = 500
            return res.end(JSON.stringify({ ok: false, error: 'DeepFace no disponible en el servidor' }))
          }
          let df = null
          let dfError = null
          try {
            df = await deepfaceApi.analyze(b64)
          } catch (e) {
            dfError = String(e?.message || e)
          }
          if (!df || df.face_found === false) {
            res.statusCode = 200
            return res.end(JSON.stringify({
              ok: true,
              face_found: false,
              deepface: df || null,
              deepfaceError: dfError,
            }))
          }
          let clinico = null
          let clinicoError = null
          if (includeAi) {
            try { clinico = await callOpenAiVision(b64, df) }
            catch (e) { clinicoError = String(e?.message || e) }
          }
          res.statusCode = 200
          res.end(JSON.stringify({
            ok: true,
            face_found: true,
            deepface: df,
            deepfaceError: dfError,
            clinico,
            clinicoError,
          }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }))
        }
      })
    })
  }
  return {
    name: 'face-analysis-full',
    configureServer: mount,
    configurePreviewServer: mount,
  }
}

/** Solo gerente: crea usuario en Auth + fila en empleados (requiere SUPABASE_SERVICE_ROLE_KEY en .env.local). */
export function adminCreateStaffPlugin(supabaseUrl, serviceRoleKey) {
  const mount = (server) => {
    server.middlewares.use('/api/admin/create-staff', (req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      if (req.method === 'OPTIONS') {
        res.statusCode = 204
        return res.end()
      }
      if (req.method !== 'POST') return next()
      if (!serviceRoleKey || !supabaseUrl) {
        res.statusCode = 503
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        return res.end(JSON.stringify({
          error: 'Falta SUPABASE_SERVICE_ROLE_KEY o VITE_SUPABASE_URL en el entorno del servidor (p. ej. .env.local). Reiniciá npm run dev.',
        }))
      }
      const chunks = []
      req.on('data', (c) => { chunks.push(c) })
      req.on('end', async () => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        try {
          const authHeader = req.headers.authorization || ''
          const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
          if (!token) {
            res.statusCode = 401
            return res.end(JSON.stringify({ error: 'Falta Authorization: Bearer <access_token>' }))
          }
          const admin = createClient(supabaseUrl, serviceRoleKey, {
            auth: { persistSession: false, autoRefreshToken: false },
          })
          const { data: userData, error: userErr } = await admin.auth.getUser(token)
          if (userErr || !userData?.user) {
            res.statusCode = 401
            return res.end(JSON.stringify({ error: 'Sesión inválida o expirada' }))
          }
          const uid = userData.user.id
          const { data: emp, error: empErr } = await admin
            .from('empleados')
            .select('id, rol, clinic_id, es_principal')
            .eq('auth_user_id', uid)
            .maybeSingle()
          if (empErr) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: mapSupabaseSchemaError(empErr.message) }))
          }
          if (!emp || !['gerente', 'encargado'].includes(emp.rol)) {
            res.statusCode = 403
            return res.end(JSON.stringify({ error: 'Solo gerente principal o encargado puede crear cuentas de equipo' }))
          }
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          const email = String(body.email || '').trim()
          const password = String(body.password || '')
          const nombre = String(body.nombre || '').trim()
          const rol = body.rol
          const clinicId = body.clinic_id
          if (!email || !password || !nombre || clinicId == null || clinicId === '') {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: 'Completá email, contraseña, nombre, rol y clínica' }))
          }
          if (!['especialista', 'recepcionista', 'encargado'].includes(rol)) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: 'El rol debe ser especialista, recepcionista o encargado' }))
          }
          if (emp.rol === 'encargado') {
            if (rol === 'encargado') {
              res.statusCode = 403
              return res.end(JSON.stringify({ error: 'El encargado no puede crear otros encargados' }))
            }
            if (+clinicId !== +emp.clinic_id) {
              res.statusCode = 403
              return res.end(JSON.stringify({ error: 'El encargado solo puede crear personal en su clínica' }))
            }
          }
          if (rol === 'encargado' && !emp.es_principal) {
            res.statusCode = 403
            return res.end(JSON.stringify({ error: 'Solo el gerente principal puede crear encargados' }))
          }
          if (password.length < 6) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: 'La contraseña debe tener al menos 6 caracteres' }))
          }
          const { data: created, error: createErr } = await admin.auth.admin.createUser({
            email,
            password,
            email_confirm: true,
          })
          if (createErr) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: createErr.message }))
          }
          const newUid = created.user.id
          const { error: insErr } = await admin.from('empleados').insert({
            clinic_id: +clinicId,
            nombre,
            email,
            rol,
            auth_user_id: newUid,
            es_principal: false,
            activo: true,
          })
          if (insErr) {
            try {
              await admin.auth.admin.deleteUser(newUid)
            } catch { /* ignore */ }
            res.statusCode = 400
            return res.end(JSON.stringify({ error: mapSupabaseSchemaError(insErr.message) }))
          }
          res.end(JSON.stringify({ ok: true, auth_user_id: newUid, email, nombre, rol }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })
    })
  }
  return {
    name: 'admin-create-staff',
    configureServer: mount,
    configurePreviewServer: mount,
  }
}

/** Solo gerente: crea clínica (sucursal o franquicia) */
export function adminCreateClinicPlugin(supabaseUrl, serviceRoleKey) {
  const mount = (server) => {
    server.middlewares.use('/api/admin/create-clinic', (req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      if (req.method === 'OPTIONS') {
        res.statusCode = 204
        return res.end()
      }
      if (req.method !== 'POST') return next()
      if (!serviceRoleKey || !supabaseUrl) {
        res.statusCode = 503
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        return res.end(JSON.stringify({
          error: 'Falta SUPABASE_SERVICE_ROLE_KEY o VITE_SUPABASE_URL en el entorno del servidor. Reiniciá npm run dev.',
        }))
      }
      const chunks = []
      req.on('data', (c) => { chunks.push(c) })
      req.on('end', async () => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        try {
          const authHeader = req.headers.authorization || ''
          const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
          if (!token) {
            res.statusCode = 401
            return res.end(JSON.stringify({ error: 'Falta Authorization: Bearer <access_token>' }))
          }
          const admin = createClient(supabaseUrl, serviceRoleKey, {
            auth: { persistSession: false, autoRefreshToken: false },
          })
          const { data: userData, error: userErr } = await admin.auth.getUser(token)
          if (userErr || !userData?.user) {
            res.statusCode = 401
            return res.end(JSON.stringify({ error: 'Sesión inválida o expirada' }))
          }
          const uid = userData.user.id
          const { data: emp, error: empErr } = await admin
            .from('empleados')
            .select('rol, es_principal')
            .eq('auth_user_id', uid)
            .maybeSingle()
          if (empErr) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: mapSupabaseSchemaError(empErr.message) }))
          }
          if (!emp || emp.rol !== 'gerente' || !emp.es_principal) {
            res.statusCode = 403
            return res.end(JSON.stringify({ error: 'Solo el gerente principal puede crear clínicas' }))
          }
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          const nombre = String(body.nombre || '').trim()
          const modalidad = body.modalidad_negocio === 'franquicia' ? 'franquicia' : 'sucursal'
          const clinicMatrizId = body.clinic_matriz_id == null || body.clinic_matriz_id === '' ? null : +body.clinic_matriz_id
          if (!nombre) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: 'Completá el nombre de la clínica' }))
          }
          if (modalidad === 'franquicia' && (clinicMatrizId == null || Number.isNaN(clinicMatrizId))) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: 'Para franquicia seleccioná clínica matriz' }))
          }
          const payload = {
            nombre,
            modalidad_negocio: modalidad,
            clinic_matriz_id: modalidad === 'franquicia' ? clinicMatrizId : null,
          }
          const { data: ins, error: insErr } = await admin
            .from('clinics')
            .insert(payload)
            .select('id, nombre, modalidad_negocio, clinic_matriz_id')
            .single()
          if (insErr) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: mapSupabaseSchemaError(insErr.message) }))
          }
          res.end(JSON.stringify({ ok: true, clinic: ins }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })
    })
  }
  return {
    name: 'admin-create-clinic',
    configureServer: mount,
    configurePreviewServer: mount,
  }
}

/** Primer gerente: solo si aún no hay ninguno en empleados. Opcional GERENTE_SIGNUP_SECRET en .env.local */
export function bootstrapGerentePlugin(supabaseUrl, serviceRoleKey, signupSecret) {
  const mount = (server) => {
    server.middlewares.use('/api/admin/bootstrap-gerente', (req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      if (req.method === 'OPTIONS') {
        res.statusCode = 204
        return res.end()
      }
      if (req.method !== 'POST') return next()
      if (!serviceRoleKey || !supabaseUrl) {
        res.statusCode = 503
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        return res.end(JSON.stringify({
          error: 'Falta SUPABASE_SERVICE_ROLE_KEY o VITE_SUPABASE_URL. Reiniciá npm run dev.',
        }))
      }
      const chunks = []
      req.on('data', (c) => { chunks.push(c) })
      req.on('end', async () => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          if (signupSecret && String(body.secret || '') !== signupSecret) {
            res.statusCode = 403
            return res.end(JSON.stringify({ error: 'Código de registro inválido' }))
          }
          const email = String(body.email || '').trim()
          const password = String(body.password || '')
          const nombre = String(body.nombre || '').trim()
          const nombreClinica = String(body.nombre_clinica || 'Mi clínica').trim() || 'Mi clínica'
          if (!email || !password || !nombre) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: 'Completá nombre, email y contraseña' }))
          }
          if (password.length < 6) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: 'La contraseña debe tener al menos 6 caracteres' }))
          }
          const admin = createClient(supabaseUrl, serviceRoleKey, {
            auth: { persistSession: false, autoRefreshToken: false },
          })
          const { data: yaHay } = await admin.from('empleados').select('id').eq('rol', 'gerente').limit(1)
          if (yaHay?.length) {
            res.statusCode = 403
            return res.end(JSON.stringify({
              error: 'Ya existe un gerente. Iniciá sesión o pedí acceso al administrador.',
            }))
          }
          const { data: clinicsEx } = await admin.from('clinics').select('id').limit(1)
          let clinicId = clinicsEx?.[0]?.id
          if (clinicId == null) {
            const { data: cIns, error: cErr } = await admin.from('clinics').insert({ nombre: nombreClinica }).select('id').single()
            if (cErr) {
              res.statusCode = 400
              return res.end(JSON.stringify({ error: cErr.message }))
            }
            clinicId = cIns.id
          }
          const { data: created, error: createErr } = await admin.auth.admin.createUser({
            email,
            password,
            email_confirm: true,
          })
          if (createErr) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: createErr.message }))
          }
          const newUid = created.user.id
          const { error: insErr } = await admin.from('empleados').insert({
            clinic_id: clinicId,
            nombre,
            email,
            rol: 'gerente',
            auth_user_id: newUid,
            es_principal: true,
            activo: true,
          })
          if (insErr) {
            try {
              await admin.auth.admin.deleteUser(newUid)
            } catch { /* ignore */ }
            res.statusCode = 400
            return res.end(JSON.stringify({ error: mapSupabaseSchemaError(insErr.message) }))
          }
          res.end(JSON.stringify({ ok: true, email, nombre, clinic_id: clinicId }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })
    })
  }
  return {
    name: 'bootstrap-gerente',
    configureServer: mount,
    configurePreviewServer: mount,
  }
}

export function erpOperationsPlugin(supabaseUrl, serviceRoleKey) {
  const mount = (server) => {
    server.middlewares.use('/api/erp', (req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      if (req.method === 'OPTIONS') {
        res.statusCode = 204
        return res.end()
      }
      /** Con `use('/api/erp', …)` Connect suele dejar `req.url` sin el prefijo; unificamos a `/api/erp/…`. */
      const pathnameRaw = (req.url || '').split('?')[0]
      const pathNorm = pathnameRaw.startsWith('/api/erp')
        ? pathnameRaw
        : `/api/erp${pathnameRaw.startsWith('/') ? pathnameRaw : `/${pathnameRaw}`}`
      if (!serviceRoleKey || !supabaseUrl) {
        res.statusCode = 503
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        return res.end(JSON.stringify({
          error:
            'Falta SUPABASE_SERVICE_ROLE_KEY o VITE_SUPABASE_URL en .env.local. Las APIs /api/erp usan la clave de servicio en el servidor; reiniciá después de configurarlas.',
        }))
      }

      const admin = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })

      const parseBody = () => new Promise(resolve => {
        const chunks = []
        req.on('data', c => chunks.push(c))
        req.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { resolve({}) }
        })
      })

      const withAuth = async () => {
        const authHeader = req.headers.authorization || ''
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
        if (!token) return { error: 'Falta Authorization: Bearer <access_token>', code: 401 }
        const { data: userData, error: userErr } = await admin.auth.getUser(token)
        if (userErr || !userData?.user) return { error: 'Sesión inválida o expirada', code: 401 }
        const uid = userData.user.id
        let { data: emp } = await admin
          .from('empleados')
          .select('id, rol, clinic_id, es_principal, activo, auth_user_id, email')
          .eq('auth_user_id', uid)
          .maybeSingle()
        if (!emp) {
          const email = String(userData.user.email || '').trim().toLowerCase()
          if (email) {
            const { data: byMail } = await admin
              .from('empleados')
              .select('id, rol, clinic_id, es_principal, activo, auth_user_id, email')
              .ilike('email', email)
              .maybeSingle()
            if (byMail?.id && !byMail.auth_user_id) {
              await admin.from('empleados').update({ auth_user_id: uid }).eq('id', byMail.id)
              emp = { ...byMail, auth_user_id: uid }
            } else if (byMail?.id) {
              emp = byMail
            }
          }
        }
        if (!emp?.activo) return { error: 'Empleado inactivo o no registrado', code: 403 }
        return { emp }
      }

      const sendJson = (code, obj) => {
        res.statusCode = code
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify(obj))
      }

      const requireRole = (auth, allowedRoles) => {
        if (!auth?.emp?.rol || !allowedRoles.includes(auth.emp.rol)) {
          return { error: 'No tenés permisos para esta operación', code: 403 }
        }
        return null
      }

      ;(async () => {
        try {
          if (req.method === 'GET' && pathNorm.startsWith('/api/erp/public-booking/options')) {
            const clinicId = +new URL(req.url || '/', 'http://localhost').searchParams.get('clinicId')
            if (!clinicId) return sendJson(400, { error: 'clinicId requerido' })
            const { data: empsPb } = await admin
              .from('empleados')
              .select('id, nombre, rol, especialidad')
              .eq('clinic_id', clinicId)
              .eq('activo', true)
              .order('nombre', { ascending: true })
            const profesionales = (empsPb || []).filter(
              (e) =>
                e.rol === 'especialista' ||
                (e.rol === 'gerente' && String(e.especialidad || '').trim() !== ''),
            )
            const { data: servicios } = await admin
              .from('servicios')
              .select('id, nombre, cat')
              .order('nombre', { ascending: true })
            const { data: disp } = await admin
              .from('agenda_disponibilidad')
              .select('id, empleado_id, dia_semana, hora_desde, hora_hasta, nota, activo')
              .eq('clinic_id', clinicId)
              .eq('activo', true)
              .order('dia_semana', { ascending: true })
              .order('hora_desde', { ascending: true })
            return sendJson(200, {
              ok: true,
              profesionales: (profesionales || []).map(p => ({ id: p.id, nombre: p.nombre || 'Especialista' })),
              servicios: (servicios || []).map(s => ({ id: s.id, nombre: s.nombre || '', cat: s.cat || 'clinico' })),
              disponibilidades: (disp || []).map(d => ({
                id: d.id,
                empleadoId: d.empleado_id,
                diaSemana: d.dia_semana,
                horaDesde: String(d.hora_desde || '').slice(0, 5),
                horaHasta: String(d.hora_hasta || '').slice(0, 5),
                nota: d.nota || '',
                activo: d.activo !== false,
              })),
            })
          }

          if (req.method === 'POST' && pathNorm === '/api/erp/public-booking/create') {
            const body = await parseBody()
            const clinicId = +body.clinicId
            const profesionalId = +body.profesionalId
            const servicioId = +body.servicioId
            const fecha = String(body.fecha || '')
            const hora = String(body.hora || '').slice(0, 5)
            const nombre = String(body.nombre || '').trim()
            const tel = String(body.tel || '').trim()
            if (!clinicId || !profesionalId || !servicioId || !fecha || !hora || !nombre || !tel) {
              return sendJson(400, { error: 'Faltan datos para reservar.' })
            }

            const { data: svc } = await admin.from('servicios').select('id, nombre, cat').eq('id', servicioId).maybeSingle()
            if (!svc?.id) return sendJson(400, { error: 'Servicio inválido.' })

            const { data: empPb } = await admin
              .from('empleados')
              .select('id, rol, especialidad, clinic_id')
              .eq('id', profesionalId)
              .eq('activo', true)
              .maybeSingle()
            const empOk =
              empPb &&
              +empPb.clinic_id === +clinicId &&
              (empPb.rol === 'especialista' ||
                (empPb.rol === 'gerente' && String(empPb.especialidad || '').trim() !== ''))
            if (!empOk) return sendJson(400, { error: 'Profesional no válido para esta reserva.' })

            const dow = new Date(`${fecha}T12:00:00`).getDay()
            const { data: disp } = await admin
              .from('agenda_disponibilidad')
              .select('id')
              .eq('clinic_id', clinicId)
              .eq('empleado_id', profesionalId)
              .eq('dia_semana', dow)
              .eq('activo', true)
              .lte('hora_desde', hora)
              .gt('hora_hasta', hora)
              .limit(1)
            if (!Array.isArray(disp) || disp.length === 0) {
              return sendJson(400, { error: 'Ese horario ya no está disponible.' })
            }

            const { data: existingTurno } = await admin
              .from('turnos')
              .select('id')
              .eq('clinic_id', clinicId)
              .eq('empleado_id', profesionalId)
              .eq('fecha', fecha)
              .eq('hora', hora)
              .not('estado', 'in', '(cancelado)')
              .limit(1)
            if (Array.isArray(existingTurno) && existingTurno.length > 0) {
              return sendJson(400, { error: 'Ese horario ya fue tomado.' })
            }

            let clienteIdResolved = null
            const { data: existente } = await admin
              .from('clientes')
              .select('id')
              .eq('clinic_id', clinicId)
              .ilike('nombre', nombre)
              .order('id', { ascending: true })
              .limit(1)
            if (Array.isArray(existente) && existente[0]?.id) {
              clienteIdResolved = +existente[0].id
              await admin.from('clientes').update({ tel }).eq('id', clienteIdResolved)
            } else {
              const { data: creado } = await admin
                .from('clientes')
                .insert({ clinic_id: clinicId, nombre, tel, email: '', dni: '' })
                .select('id')
                .single()
              clienteIdResolved = creado?.id ? +creado.id : null
            }

            const { error: turnErr } = await admin.from('turnos').insert({
              clinic_id: clinicId,
              cliente: nombre,
              tel,
              fecha,
              hora,
              cat: String(svc.cat || 'clinico'),
              servicio: String(svc.nombre || ''),
              obs: 'Reserva online',
              estado: 'pendiente',
              empleado_id: profesionalId,
              cliente_id: clienteIdResolved,
            })
            if (turnErr) return sendJson(400, { error: turnErr.message })
            return sendJson(200, { ok: true })
          }

          if (req.method === 'GET' && pathNorm.startsWith('/api/erp/bootstrap')) {
            const auth = await withAuth()
            if (auth.error) return sendJson(auth.code, { error: auth.error })
            const { data: clinics } = await admin.from('clinics').select('id, nombre, modalidad_negocio, clinic_matriz_id').order('id')
            const clinicIds = (clinics || []).map(c => c.id)
            const { data: emps } = await admin.from('empleados').select('id, clinic_id, nombre, email, tel, rol, activo, especialidad, comision_pct, color').order('id')
            const { data: clientes } = await admin.from('clientes').select('id, clinic_id, nombre, tel, email, dni, fecha_nacimiento, notas_clinicas, alergias, tratamientos_activos, visitas, fotos, anamnesis, consentimientos, created_at, es_paciente').in('clinic_id', clinicIds).order('id')
            const { data: turnos } = await admin.from('turnos').select('id, clinic_id, cliente_id, cliente, tel, fecha, hora, cat, servicio, obs, estado, empleado_id, servicio_facturado_id, sesion_medica_borrador').in('clinic_id', clinicIds)
            const clienteIds = (clientes || []).map(c => c.id)
            const { data: hist } = clienteIds.length ? await admin.from('historial_clinico').select('id, cliente_id, fecha, tipo, titulo, detalle, profesional').in('cliente_id', clienteIds).order('id') : { data: [] }
            const { data: arts } = await admin.from('articulos').select('id, nombre, cat, unidad, minimo, costo, proveedor, codigo_barras, foto_url')
            const { data: apc } = await admin.from('articulos_por_clinica').select('clinic_id, articulo_id, cantidad').in('clinic_id', clinicIds)
            const { data: movs } = await admin.from('clinic_movimientos').select('id, clinic_id, tipo, fecha, concepto, cat, monto').in('clinic_id', clinicIds)
            const { data: provs } = await admin.from('proveedores').select('id, nombre, contacto, tel, email').order('id')
            const { data: provProd } = await admin.from('proveedor_productos').select('id, proveedor_id, nombre_producto, costo_ref').order('id')
            const { data: pedidos } = await admin.from('pedidos_compra').select('id, clinic_id, proveedor_id, fecha, notas, estado, total_estimado').in('clinic_id', clinicIds).order('id')
            const pedidoIds = (pedidos || []).map(p => p.id)
            const { data: pedidoItems } = pedidoIds.length ? await admin.from('pedido_compra_items').select('id, pedido_id, nombre_producto, cantidad_ordenada, costo_unit').in('pedido_id', pedidoIds) : { data: [] }
            const { data: incid } = await admin.from('incidencias_proveedor').select('id, clinic_id, proveedor_id, pedido_id, producto, esperado, recibido, faltante, malo, lote, nota, fotos_urls, estado, created_at').in('clinic_id', clinicIds).order('id')
            const { data: traslados } = await admin.from('traslados_internos').select('id, origen_clinic_id, destino_clinic_id, articulo_id, producto_nombre, cantidad, estado, nota, creado_at, enviado_at, recibido_at').or(`origen_clinic_id.in.(${clinicIds.join(',')}),destino_clinic_id.in.(${clinicIds.join(',')})`).order('id')
            const { data: srvs } = await admin.from('servicios').select('id, nombre, cat, duracion, precio, sesiones, descripcion, materiales_articulo_ids').order('id')
            let consentRows = []
            if (clinicIds.length) {
              try {
                const { data: cr, error: consentErr } = await admin
                  .from('consentimientos_firmados')
                  .select('id, clinic_id, cliente_id, turno_id, plantilla_slug, titulo, servicio_o_producto, paciente_nombre_snapshot, contenido_html, pdf_storage_path, firmado_at, firmado_por_empleado_id')
                  .in('clinic_id', clinicIds)
                  .order('firmado_at', { ascending: false })
                if (!consentErr) consentRows = cr || []
              } catch {
                consentRows = []
              }
            }

            const artMap = new Map((arts || []).map(a => [a.id, a]))
            const stockLinkSet = new Set()
            const clinicsData = {}
            for (const c of (clinics || [])) clinicsData[c.id] = { turnos: [], stock: [], movimientos: [] }
            for (const t of (turnos || [])) {
              const cd = clinicsData[t.clinic_id]
              if (!cd) continue
              cd.turnos.push({
                id: t.id, pacienteId: t.cliente_id, cliente: t.cliente, tel: t.tel, fecha: t.fecha, hora: t.hora,
                cat: t.cat, servicio: t.servicio, obs: t.obs, estado: t.estado, profesionalId: t.empleado_id, servicioFacturadoId: t.servicio_facturado_id,
                sesionMedicaBorrador: t.sesion_medica_borrador && typeof t.sesion_medica_borrador === 'object' ? t.sesion_medica_borrador : null,
              })
            }
            for (const m of (movs || [])) {
              const cd = clinicsData[m.clinic_id]
              if (!cd) continue
              cd.movimientos.push({ id: m.id, tipo: m.tipo, fecha: m.fecha, concepto: m.concepto, cat: m.cat, monto: +m.monto || 0 })
            }
            for (const row of (apc || [])) {
              const cd = clinicsData[row.clinic_id]
              const a = artMap.get(row.articulo_id)
              if (!cd || !a) continue
              stockLinkSet.add(`${row.clinic_id}:${row.articulo_id}`)
              cd.stock.push({
                id: a.id, nombre: a.nombre, cat: a.cat, unidad: a.unidad, minimo: +a.minimo || 0, costo: +a.costo || 0,
                proveedor: a.proveedor || '', codigoBarras: a.codigo_barras || '', fotoUrl: a.foto_url || '', stock: +row.cantidad || 0,
              })
            }
            // Si un artículo existe en catálogo global pero aún no tiene fila en articulos_por_clinica,
            // lo mostramos con stock 0 para evitar "desaparecidos" en el front.
            for (const c of (clinics || [])) {
              const cd = clinicsData[c.id]
              if (!cd) continue
              for (const a of (arts || [])) {
                const k = `${c.id}:${a.id}`
                if (stockLinkSet.has(k)) continue
                cd.stock.push({
                  id: a.id,
                  nombre: a.nombre,
                  cat: a.cat,
                  unidad: a.unidad,
                  minimo: +a.minimo || 0,
                  costo: +a.costo || 0,
                  proveedor: a.proveedor || '',
                  codigoBarras: a.codigo_barras || '',
                  fotoUrl: a.foto_url || '',
                  stock: 0,
                })
              }
            }

            const provById = new Map()
            for (const p of (provs || [])) provById.set(p.id, { id: p.id, nombre: p.nombre, contacto: p.contacto, tel: p.tel, email: p.email, productos: [] })
            for (const pp of (provProd || [])) {
              const p = provById.get(pp.proveedor_id)
              if (p) p.productos.push({ id: pp.id, nombre: pp.nombre_producto, costo: +pp.costo_ref || 0 })
            }
            const itemsByPedido = new Map()
            for (const it of (pedidoItems || [])) {
              if (!itemsByPedido.has(it.pedido_id)) itemsByPedido.set(it.pedido_id, [])
              itemsByPedido.get(it.pedido_id).push({ nombre: it.nombre_producto, cantidad: +it.cantidad_ordenada || 0, costo: +it.costo_unit || 0 })
            }
            const ownClinicId = auth?.emp?.clinic_id == null ? null : +auth.emp.clinic_id
            const empleadosFiltrados = (emps || []).filter(e => {
              if (auth?.emp?.rol === 'gerente') return true
              if (ownClinicId == null) return false
              return +e.clinic_id === ownClinicId
            })

            return sendJson(200, {
              clinics: clinics || [],
              clinicsData,
              servicios: (srvs || []).map(s => ({
                id: s.id,
                nombre: s.nombre || '',
                cat: s.cat || 'clinico',
                duracion: +s.duracion || 30,
                precio: s.precio == null ? 0 : +s.precio,
                sesiones: +s.sesiones || 1,
                desc: s.descripcion || '',
                materialesStockIds: Array.isArray(s.materiales_articulo_ids) ? s.materiales_articulo_ids : [],
              })),
              empleados: empleadosFiltrados.map(e => ({
                id: e.id,
                clinicId: e.clinic_id,
                nombre: e.nombre || '',
                email: e.email || '',
                tel: e.tel || '',
                cargo: e.rol || 'recepcionista',
                activo: e.activo !== false,
                especialidad: e.especialidad || '',
                comision: e.comision_pct == null ? 0 : (+e.comision_pct || 0),
                color: e.color || '#7C3AED',
                fotoUrl: '',
                documento: '',
                fechaNacimiento: '',
                direccion: '',
                fechaIngreso: '',
                contactoEmergencia: '',
                telEmergencia: '',
                notas: '',
                historial: [],
              })),
              pacientes: (clientes || []).map(c => ({
                id: c.id,
                clinicId: c.clinic_id,
                nombre: c.nombre || '',
                tel: c.tel || '',
                email: c.email || '',
                dni: c.dni || '',
                fechaNacimiento: c.fecha_nacimiento || '',
                notasClinicas: c.notas_clinicas || '',
                alergias: Array.isArray(c.alergias) ? c.alergias : [],
                tratamientosActivos: Array.isArray(c.tratamientos_activos) ? c.tratamientos_activos : [],
                visitas: Array.isArray(c.visitas) ? c.visitas : [],
                fotos: Array.isArray(c.fotos) ? c.fotos : [],
                anamnesis: c.anamnesis && typeof c.anamnesis === 'object' ? c.anamnesis : {},
                consentimientos: Array.isArray(c.consentimientos) ? c.consentimientos : [],
                created_at: c.created_at || null,
                esPaciente: c.es_paciente === true,
              })),
              historialClinico: (hist || []).map(h => ({
                id: h.id,
                pacienteId: h.cliente_id,
                fecha: h.fecha,
                tipo: h.tipo || 'evolucion',
                titulo: h.titulo || '',
                detalle: h.detalle || '',
                profesional: h.profesional || '',
              })),
              consentimientosFirmados: (consentRows || []).map(r => ({
                id: r.id,
                clinicId: r.clinic_id,
                clienteId: r.cliente_id,
                turnoId: r.turno_id,
                plantillaSlug: r.plantilla_slug || '',
                titulo: r.titulo || '',
                servicioOProducto: r.servicio_o_producto || '',
                pacienteNombreSnapshot: r.paciente_nombre_snapshot || '',
                contenidoHtml: r.contenido_html || '',
                pdfStoragePath: r.pdf_storage_path || '',
                firmadoAt: r.firmado_at,
                firmadoPorEmpleadoId: r.firmado_por_empleado_id,
              })),
              proveedores: [...provById.values()],
              pedidosProveedor: (pedidos || []).map(p => ({ id: p.id, clinicId: p.clinic_id, proveedorId: p.proveedor_id, fecha: p.fecha, notas: p.notas, estado: p.estado, total: +p.total_estimado || 0, items: itemsByPedido.get(p.id) || [] })),
              incidenciasProveedor: (incid || []).map(i => ({ id: i.id, clinicId: i.clinic_id, proveedorId: i.proveedor_id, pedidoId: i.pedido_id, producto: i.producto, esperado: +i.esperado || 0, recibido: +i.recibido || 0, faltante: +i.faltante || 0, malo: +i.malo || 0, lote: i.lote || '', nota: i.nota || '', fotos: i.fotos_urls || [], estado: i.estado, creadaAt: i.created_at })),
              trasladosInternos: (traslados || []).map(t => ({ id: t.id, origenClinicId: t.origen_clinic_id, destinoClinicId: t.destino_clinic_id, productoId: t.articulo_id, productoNombre: t.producto_nombre, cantidad: +t.cantidad || 0, estado: t.estado, nota: t.nota || '', creadoAt: t.creado_at, enviadoAt: t.enviado_at, recibidoAt: t.recibido_at })),
            })
          }

          if (req.method === 'POST' && pathNorm === '/api/erp/turno/create') {
            const auth = await withAuth()
            if (auth.error) return sendJson(auth.code, { error: auth.error })
            const denied = requireRole(auth, ['gerente', 'encargado', 'recepcionista', 'especialista'])
            if (denied) return sendJson(denied.code, { error: denied.error })
            const body = await parseBody()
            let clienteIdResolved = body.pacienteId ? +body.pacienteId : null
            const clinicId = +body.clinicId
            const clienteNombre = String(body.cliente || '').trim()
            if (!clienteIdResolved && clinicId > 0 && clienteNombre) {
              const { data: existente } = await admin
                .from('clientes')
                .select('id')
                .eq('clinic_id', clinicId)
                .ilike('nombre', clienteNombre)
                .order('id', { ascending: true })
                .limit(1)
              if (Array.isArray(existente) && existente[0]?.id) {
                clienteIdResolved = +existente[0].id
              } else {
                const { data: creado } = await admin
                  .from('clientes')
                  .insert({
                    clinic_id: clinicId,
                    nombre: clienteNombre,
                    tel: String(body.tel || ''),
                    dni: String(body.dni || ''),
                    email: '',
                  })
                  .select('id')
                  .single()
                if (creado?.id) clienteIdResolved = +creado.id
              }
            }
            const ins = {
              clinic_id: clinicId,
              cliente: clienteNombre,
              tel: String(body.tel || ''),
              fecha: String(body.fecha || ''),
              hora: String(body.hora || ''),
              cat: String(body.cat || 'clinico'),
              servicio: String(body.servicio || ''),
              obs: String(body.obs || ''),
              estado: 'pendiente',
              empleado_id: body.profesionalId ? +body.profesionalId : null,
              cliente_id: clienteIdResolved,
            }
            const { error } = await admin.from('turnos').insert(ins)
            if (error) return sendJson(400, { error: error.message })
            const dniTrim = String(body.dni || '').trim()
            if (dniTrim && clienteIdResolved) {
              await admin.from('clientes').update({ dni: dniTrim }).eq('id', clienteIdResolved)
            }
            return sendJson(200, { ok: true })
          }

          /** Tras la atención: crea o vincula ficha en `clientes` y actualiza `turnos.cliente_id` (idempotente). */
          if (req.method === 'POST' && pathNorm === '/api/erp/turno/ensure-cliente') {
            const auth = await withAuth()
            if (auth.error) return sendJson(auth.code, { error: auth.error })
            const denied = requireRole(auth, ['gerente', 'encargado', 'recepcionista', 'especialista'])
            if (denied) return sendJson(denied.code, { error: denied.error })
            const body = await parseBody()
            const turnoId = +body.turnoId
            if (!turnoId) return sendJson(400, { error: 'turnoId requerido' })
            const mapClienteFront = (c) => ({
              id: c.id,
              clinicId: c.clinic_id,
              nombre: c.nombre || '',
              tel: c.tel || '',
              email: c.email || '',
              dni: c.dni || '',
              fechaNacimiento: c.fecha_nacimiento || '',
              notasClinicas: c.notas_clinicas || '',
              alergias: Array.isArray(c.alergias) ? c.alergias : [],
              tratamientosActivos: Array.isArray(c.tratamientos_activos) ? c.tratamientos_activos : [],
              visitas: Array.isArray(c.visitas) ? c.visitas : [],
              fotos: Array.isArray(c.fotos) ? c.fotos : [],
              anamnesis: c.anamnesis && typeof c.anamnesis === 'object' ? c.anamnesis : {},
              consentimientos: Array.isArray(c.consentimientos) ? c.consentimientos : [],
              created_at: c.created_at || null,
              esPaciente: c.es_paciente === true,
            })
            const { data: trow, error: tErr } = await admin
              .from('turnos')
              .select('id, clinic_id, cliente_id, cliente, tel')
              .eq('id', turnoId)
              .maybeSingle()
            if (tErr || !trow) return sendJson(400, { error: 'Turno no encontrado' })
            if (trow.cliente_id) {
              const { data: crow } = await admin
                .from('clientes')
                .select('id, clinic_id, nombre, tel, email, dni, fecha_nacimiento, notas_clinicas, alergias, tratamientos_activos, visitas, fotos, anamnesis, consentimientos, created_at, es_paciente')
                .eq('id', trow.cliente_id)
                .maybeSingle()
              return sendJson(200, {
                ok: true,
                clienteId: +trow.cliente_id,
                created: false,
                cliente: crow ? mapClienteFront(crow) : null,
              })
            }
            const clienteNombre = String(trow.cliente || '').trim()
            if (!clienteNombre) return sendJson(400, { error: 'El turno no tiene nombre de cliente' })
            const clinicId = +trow.clinic_id
            const { data: existente } = await admin
              .from('clientes')
              .select('id')
              .eq('clinic_id', clinicId)
              .ilike('nombre', clienteNombre)
              .order('id', { ascending: true })
              .limit(1)
            let clienteIdResolved = null
            let created = false
            if (Array.isArray(existente) && existente[0]?.id) {
              clienteIdResolved = +existente[0].id
            } else {
              const { data: creado, error: insErr } = await admin
                .from('clientes')
                .insert({
                  clinic_id: clinicId,
                  nombre: clienteNombre,
                  tel: String(trow.tel || ''),
                  email: '',
                  dni: '',
                })
                .select('id, clinic_id, nombre, tel, email, dni, fecha_nacimiento, notas_clinicas, alergias, tratamientos_activos, visitas, fotos, anamnesis, consentimientos, created_at, es_paciente')
                .single()
              if (insErr || !creado) return sendJson(400, { error: insErr?.message || 'No se pudo crear la ficha del cliente.' })
              clienteIdResolved = +creado.id
              created = true
              const { error: uErr } = await admin.from('turnos').update({ cliente_id: clienteIdResolved }).eq('id', turnoId)
              if (uErr) return sendJson(400, { error: uErr.message })
              return sendJson(200, { ok: true, clienteId: clienteIdResolved, created, cliente: mapClienteFront(creado) })
            }
            const { error: uErr } = await admin.from('turnos').update({ cliente_id: clienteIdResolved }).eq('id', turnoId)
            if (uErr) return sendJson(400, { error: uErr.message })
            const { data: crow } = await admin
              .from('clientes')
              .select('id, clinic_id, nombre, tel, email, dni, fecha_nacimiento, notas_clinicas, alergias, tratamientos_activos, visitas, fotos, anamnesis, consentimientos, created_at, es_paciente')
              .eq('id', clienteIdResolved)
              .maybeSingle()
            return sendJson(200, { ok: true, clienteId: clienteIdResolved, created, cliente: crow ? mapClienteFront(crow) : null })
          }

          /** Al abrir sesión desde área médica (QR/móvil): vincula ficha si hace falta y marca `es_paciente`. */
          if (req.method === 'POST' && pathNorm === '/api/erp/turno/marcar-paciente-area-medica') {
            const auth = await withAuth()
            if (auth.error) return sendJson(auth.code, { error: auth.error })
            const denied = requireRole(auth, ['gerente', 'encargado', 'recepcionista', 'especialista'])
            if (denied) return sendJson(denied.code, { error: denied.error })
            const body = await parseBody()
            const turnoId = +body.turnoId
            if (!turnoId) return sendJson(400, { error: 'turnoId requerido' })
            const { data: trow, error: tErr } = await admin
              .from('turnos')
              .select('id, clinic_id, cliente_id, cliente, tel')
              .eq('id', turnoId)
              .maybeSingle()
            if (tErr || !trow) return sendJson(400, { error: 'Turno no encontrado' })
            let clienteIdResolved = trow.cliente_id ? +trow.cliente_id : null
            const clienteNombre = String(trow.cliente || '').trim()
            const clinicId = +trow.clinic_id
            if (!clienteIdResolved) {
              if (!clienteNombre || !clinicId) {
                return sendJson(400, { error: 'El turno no tiene datos para vincular cliente.' })
              }
              const { data: existente } = await admin
                .from('clientes')
                .select('id')
                .eq('clinic_id', clinicId)
                .ilike('nombre', clienteNombre)
                .order('id', { ascending: true })
                .limit(1)
              if (Array.isArray(existente) && existente[0]?.id) {
                clienteIdResolved = +existente[0].id
              } else {
                const { data: creado, error: insErr } = await admin
                  .from('clientes')
                  .insert({
                    clinic_id: clinicId,
                    nombre: clienteNombre,
                    tel: String(trow.tel || ''),
                    email: '',
                    dni: '',
                  })
                  .select('id')
                  .single()
                if (insErr || !creado?.id) {
                  return sendJson(400, { error: insErr?.message || 'No se pudo crear la ficha del cliente.' })
                }
                clienteIdResolved = +creado.id
              }
              const { error: uErr } = await admin.from('turnos').update({ cliente_id: clienteIdResolved }).eq('id', turnoId)
              if (uErr) return sendJson(400, { error: uErr.message })
            }
            const { error: pErr } = await admin.from('clientes').update({ es_paciente: true }).eq('id', clienteIdResolved)
            if (pErr) return sendJson(400, { error: pErr.message })
            return sendJson(200, { ok: true, clienteId: clienteIdResolved })
          }

          /**
           * Repara datos viejos: turnos con nombre en agenda pero sin `cliente_id`.
           * Crea o reutiliza ficha en `clientes` y actualiza cada turno (idempotente por turno).
           */
          if (req.method === 'POST' && pathNorm === '/api/erp/clientes/backfill-from-turnos') {
            const auth = await withAuth()
            if (auth.error) return sendJson(auth.code, { error: auth.error })
            const denied = requireRole(auth, ['gerente', 'encargado', 'recepcionista', 'especialista'])
            if (denied) return sendJson(denied.code, { error: denied.error })
            const body = await parseBody()
            const bodyClinic = body.clinicId != null && body.clinicId !== '' ? +body.clinicId : null
            const { data: rows, error: qErr } = await admin
              .from('turnos')
              .select('id, clinic_id, cliente_id, cliente, tel')
              .is('cliente_id', null)
            if (qErr) return sendJson(400, { error: qErr.message })
            let turnos = rows || []
            const rol = auth.emp?.rol
            if (rol === 'gerente') {
              if (bodyClinic != null && bodyClinic > 0) turnos = turnos.filter((t) => +t.clinic_id === bodyClinic)
            } else {
              const cid = bodyClinic != null && bodyClinic > 0 ? bodyClinic : auth.emp?.clinic_id
              if (cid == null || +cid <= 0) return sendJson(400, { error: 'Indicá la clínica o asociá tu usuario a una sede.' })
              turnos = turnos.filter((t) => +t.clinic_id === +cid)
            }
            let turnosVinculados = 0
            let fichasCreadas = 0
            for (const t of turnos) {
              const nombre = String(t.cliente || '').trim()
              if (!nombre) continue
              const clinicId = +t.clinic_id
              if (!clinicId) continue
              const { data: existente } = await admin
                .from('clientes')
                .select('id')
                .eq('clinic_id', clinicId)
                .ilike('nombre', nombre)
                .order('id', { ascending: true })
                .limit(1)
              let clienteIdResolved = null
              if (Array.isArray(existente) && existente[0]?.id) {
                clienteIdResolved = +existente[0].id
              } else {
                const { data: creado, error: insErr } = await admin
                  .from('clientes')
                  .insert({
                    clinic_id: clinicId,
                    nombre,
                    tel: String(t.tel || ''),
                    email: '',
                    dni: '',
                  })
                  .select('id')
                  .single()
                if (insErr || !creado?.id) continue
                clienteIdResolved = +creado.id
                fichasCreadas += 1
              }
              const { error: uErr } = await admin.from('turnos').update({ cliente_id: clienteIdResolved }).eq('id', t.id)
              if (!uErr) turnosVinculados += 1
            }
            return sendJson(200, { ok: true, turnosVinculados, fichasCreadas, revisados: turnos.length })
          }

          if (req.method === 'POST' && pathNorm === '/api/erp/cliente/create') {
            const auth = await withAuth()
            if (auth.error) return sendJson(auth.code, { error: auth.error })
            const denied = requireRole(auth, ['gerente', 'encargado', 'recepcionista', 'especialista'])
            if (denied) return sendJson(denied.code, { error: denied.error })
            const body = await parseBody()
            const clinicId = +body.clinicId || +auth.emp?.clinic_id || 1
            const nombre = String(body.nombre || '').trim()
            if (!nombre) return sendJson(400, { error: 'Nombre requerido.' })
            const ins = {
              clinic_id: clinicId,
              nombre,
              tel: String(body.tel || ''),
              email: String(body.email || ''),
              dni: String(body.dni || ''),
            }
            const { data: row, error } = await admin
              .from('clientes')
              .insert(ins)
              .select('id, clinic_id, nombre, tel, email, dni, fecha_nacimiento, notas_clinicas, alergias, tratamientos_activos, visitas, fotos, anamnesis, consentimientos, created_at, es_paciente')
              .single()
            if (error || !row) return sendJson(400, { error: error?.message || 'No se pudo crear cliente.' })
            return sendJson(200, { ok: true, cliente: row })
          }

          if (req.method === 'POST' && pathNorm === '/api/erp/servicio/create') {
            const auth = await withAuth()
            if (auth.error) return sendJson(auth.code, { error: auth.error })
            const denied = requireRole(auth, ['gerente', 'encargado', 'especialista'])
            if (denied) return sendJson(denied.code, { error: denied.error })
            const body = await parseBody()
            const nombre = String(body.nombre || '').trim()
            if (!nombre) return sendJson(400, { error: 'Nombre requerido.' })
            const catRaw = String(body.cat || 'clinico').trim().toLowerCase()
            const cat = ['valoracion', 'clinico', 'facial', 'corporal', 'laser', 'botox'].includes(catRaw) ? catRaw : 'clinico'
            const ins = {
              nombre,
              cat,
              precio: +body.precio || 0,
              duracion: +body.duracion || 30,
              sesiones: +body.sesiones || 1,
              descripcion: String(body.descripcion || ''),
              materiales_articulo_ids: Array.isArray(body.materialesStockIds) ? body.materialesStockIds.map(n => +n).filter(n => n > 0) : [],
            }
            const { data: row, error } = await admin
              .from('servicios')
              .insert(ins)
              .select('id, nombre, cat, duracion, precio, sesiones, descripcion, materiales_articulo_ids')
              .single()
            if (error || !row) return sendJson(400, { error: error?.message || 'No se pudo crear servicio.' })
            return sendJson(200, { ok: true, servicio: row })
          }

          if (req.method === 'POST' && pathNorm === '/api/erp/stock/create') {
            const auth = await withAuth()
            if (auth.error) return sendJson(auth.code, { error: auth.error })
            const denied = requireRole(auth, ['gerente', 'encargado', 'recepcionista'])
            if (denied) return sendJson(denied.code, { error: denied.error })
            const body = await parseBody()
            const { data: art, error: artErr } = await admin.from('articulos').insert({
              nombre: body.nombre, cat: body.cat, unidad: body.unidad, minimo: +body.minimo || 0, costo: +body.costo || 0,
              proveedor: body.proveedor || '', codigo_barras: body.codigoBarras || '', foto_url: body.fotoUrl || '',
            }).select('id').single()
            if (artErr) return sendJson(400, { error: artErr.message })
            const { error: apcErr } = await admin.from('articulos_por_clinica').insert({
              clinic_id: +body.clinicId, articulo_id: art.id, cantidad: +body.stock || 0,
            })
            if (apcErr) return sendJson(400, { error: apcErr.message })
            return sendJson(200, { ok: true })
          }

          if (req.method === 'POST' && pathNorm === '/api/erp/provider/create') {
            const auth = await withAuth()
            if (auth.error) return sendJson(auth.code, { error: auth.error })
            const denied = requireRole(auth, ['gerente', 'encargado', 'recepcionista'])
            if (denied) return sendJson(denied.code, { error: denied.error })
            const body = await parseBody()
            const { data: p, error } = await admin.from('proveedores').insert({
              nombre: body.nombre, contacto: body.contacto || '', tel: body.tel || '', email: body.email || '',
            }).select('id').single()
            if (error) return sendJson(400, { error: error.message })
            const prods = Array.isArray(body.productos) ? body.productos : []
            if (prods.length) {
              const rows = prods.map(x => ({ proveedor_id: p.id, nombre_producto: x.nombre, costo_ref: +x.costo || 0 }))
              await admin.from('proveedor_productos').insert(rows)
            }
            return sendJson(200, { ok: true })
          }

          if (req.method === 'POST' && pathNorm === '/api/erp/pedido/create') {
            const auth = await withAuth()
            if (auth.error) return sendJson(auth.code, { error: auth.error })
            const denied = requireRole(auth, ['gerente', 'encargado', 'recepcionista'])
            if (denied) return sendJson(denied.code, { error: denied.error })
            const body = await parseBody()
            const items = Array.isArray(body.items) ? body.items : []
            const total = items.reduce((a, x) => a + (+x.cantidad || 0) * (+x.costo || 0), 0)
            const { data: p, error } = await admin.from('pedidos_compra').insert({
              clinic_id: +body.clinicId, proveedor_id: +body.proveedorId, fecha: body.fecha, notas: body.notas || '', total_estimado: total, creado_por_emp_id: auth.emp.id,
            }).select('id').single()
            if (error) return sendJson(400, { error: error.message })
            if (items.length) {
              const rows = items.map(it => ({ pedido_id: p.id, nombre_producto: it.nombre, cantidad_ordenada: +it.cantidad || 0, costo_unit: +it.costo || 0 }))
              const { error: itErr } = await admin.from('pedido_compra_items').insert(rows)
              if (itErr) return sendJson(400, { error: itErr.message })
            }
            return sendJson(200, { ok: true })
          }

          if (req.method === 'POST' && pathNorm === '/api/erp/pedido/recepcionar') {
            const auth = await withAuth()
            if (auth.error) return sendJson(auth.code, { error: auth.error })
            const denied = requireRole(auth, ['gerente', 'encargado', 'recepcionista'])
            if (denied) return sendJson(denied.code, { error: denied.error })
            const body = await parseBody()
            const pedidoId = +body.pedidoId
            const { data: pedido } = await admin.from('pedidos_compra').select('id, clinic_id, proveedor_id, estado').eq('id', pedidoId).maybeSingle()
            if (!pedido || pedido.estado !== 'pendiente') return sendJson(400, { error: 'Pedido inválido o ya recepcionado' })
            const fotos = Array.isArray(body.fotos) ? body.fotos : []
            const { data: rec, error: recErr } = await admin.from('recepciones_compra').insert({
              pedido_id: pedidoId, clinic_id: pedido.clinic_id, remito: body.remito || '', observaciones: body.observaciones || '', fotos_urls: fotos, recibido_por_emp_id: auth.emp.id,
            }).select('id').single()
            if (recErr) return sendJson(400, { error: recErr.message })
            const items = Array.isArray(body.items) ? body.items : []
            let huboInc = false
            for (const it of items) {
              const esperada = +it.esperada || 0
              const recibida = +it.recibida || 0
              const mala = +it.mala || 0
              const aceptada = Math.max(0, recibida - mala)
              const faltante = Math.max(0, esperada - recibida)
              const lote = String(it.lote || '')
              const nombre = String(it.nombre || '').trim()
              if (!nombre) continue
              let articuloId = null
              const { data: aEq } = await admin.from('articulos').select('id').eq('nombre', nombre).limit(1)
              if (aEq?.[0]?.id) articuloId = aEq[0].id
              if (!articuloId) {
                const { data: aNew } = await admin.from('articulos').insert({ nombre, cat: 'general', unidad: 'unidades', minimo: 0, costo: +it.costo || 0 }).select('id').single()
                articuloId = aNew?.id || null
              }
              await admin.from('recepcion_items').insert({
                recepcion_id: rec.id, articulo_id: articuloId, nombre_producto: nombre, cantidad_esperada: esperada, cantidad_recibida: recibida, cantidad_mal_estado: mala, lote, nota_calidad: it.nota || '',
              })
              if (aceptada > 0 && articuloId) {
                const { data: apcEq } = await admin.from('articulos_por_clinica').select('cantidad').eq('clinic_id', pedido.clinic_id).eq('articulo_id', articuloId).maybeSingle()
                if (apcEq) {
                  await admin.from('articulos_por_clinica').update({ cantidad: (+apcEq.cantidad || 0) + aceptada }).eq('clinic_id', pedido.clinic_id).eq('articulo_id', articuloId)
                } else {
                  await admin.from('articulos_por_clinica').insert({ clinic_id: pedido.clinic_id, articulo_id: articuloId, cantidad: aceptada })
                }
              }
              if (faltante > 0 || mala > 0) {
                huboInc = true
                await admin.from('incidencias_proveedor').insert({
                  clinic_id: pedido.clinic_id, proveedor_id: pedido.proveedor_id, pedido_id: pedidoId, recepcion_id: rec.id,
                  producto: nombre, esperado: esperada, recibido: recibida, faltante, malo: mala, lote,
                  nota: it.nota || body.observaciones || '', fotos_urls: fotos, estado: 'abierta',
                })
              }
            }
            await admin.from('pedidos_compra').update({ estado: huboInc ? 'recibido_con_incidencia' : 'recibido' }).eq('id', pedidoId)
            return sendJson(200, { ok: true })
          }

          if (req.method === 'POST' && pathNorm === '/api/erp/traslado/solicitar') {
            const auth = await withAuth()
            if (auth.error) return sendJson(auth.code, { error: auth.error })
            const denied = requireRole(auth, ['gerente', 'encargado', 'recepcionista'])
            if (denied) return sendJson(denied.code, { error: denied.error })
            const body = await parseBody()
            const { error } = await admin.from('traslados_internos').insert({
              origen_clinic_id: +body.origenClinicId, destino_clinic_id: +body.destinoClinicId, articulo_id: +body.productoId || null,
              producto_nombre: body.productoNombre, cantidad: +body.cantidad || 0, estado: 'solicitado', nota: body.nota || '', solicitado_por_emp_id: auth.emp.id,
            })
            if (error) return sendJson(400, { error: error.message })
            return sendJson(200, { ok: true })
          }

          if (req.method === 'POST' && pathNorm === '/api/erp/traslado/enviar') {
            const auth = await withAuth()
            if (auth.error) return sendJson(auth.code, { error: auth.error })
            const denied = requireRole(auth, ['gerente', 'encargado'])
            if (denied) return sendJson(denied.code, { error: denied.error })
            const body = await parseBody()
            const id = +body.id
            const { data: tr } = await admin.from('traslados_internos').select('id, origen_clinic_id, articulo_id, cantidad, estado').eq('id', id).maybeSingle()
            if (!tr || tr.estado !== 'solicitado' || !tr.articulo_id) return sendJson(400, { error: 'Traslado inválido' })
            const { data: apc } = await admin.from('articulos_por_clinica').select('cantidad').eq('clinic_id', tr.origen_clinic_id).eq('articulo_id', tr.articulo_id).maybeSingle()
            if (!apc || (+apc.cantidad || 0) < (+tr.cantidad || 0)) return sendJson(400, { error: 'Stock insuficiente en origen' })
            await admin.from('articulos_por_clinica').update({ cantidad: (+apc.cantidad || 0) - (+tr.cantidad || 0) }).eq('clinic_id', tr.origen_clinic_id).eq('articulo_id', tr.articulo_id)
            await admin.from('traslados_internos').update({ estado: 'en_transito', enviado_por_emp_id: auth.emp.id, enviado_at: new Date().toISOString() }).eq('id', id)
            return sendJson(200, { ok: true })
          }

          if (req.method === 'POST' && pathNorm === '/api/erp/traslado/recibir') {
            const auth = await withAuth()
            if (auth.error) return sendJson(auth.code, { error: auth.error })
            const denied = requireRole(auth, ['gerente', 'encargado'])
            if (denied) return sendJson(denied.code, { error: denied.error })
            const body = await parseBody()
            const id = +body.id
            const { data: tr } = await admin.from('traslados_internos').select('id, destino_clinic_id, articulo_id, producto_nombre, cantidad, estado').eq('id', id).maybeSingle()
            if (!tr || tr.estado !== 'en_transito') return sendJson(400, { error: 'Traslado inválido' })
            let articuloId = tr.articulo_id
            if (!articuloId) {
              const { data: aEq } = await admin.from('articulos').select('id').eq('nombre', tr.producto_nombre).limit(1)
              articuloId = aEq?.[0]?.id || null
            }
            if (!articuloId) {
              const { data: aNew } = await admin.from('articulos').insert({ nombre: tr.producto_nombre, cat: 'general', unidad: 'unidades', minimo: 0, costo: 0 }).select('id').single()
              articuloId = aNew?.id || null
            }
            if (!articuloId) return sendJson(400, { error: 'No se pudo resolver artículo' })
            const { data: apc } = await admin.from('articulos_por_clinica').select('cantidad').eq('clinic_id', tr.destino_clinic_id).eq('articulo_id', articuloId).maybeSingle()
            if (apc) {
              await admin.from('articulos_por_clinica').update({ cantidad: (+apc.cantidad || 0) + (+tr.cantidad || 0) }).eq('clinic_id', tr.destino_clinic_id).eq('articulo_id', articuloId)
            } else {
              await admin.from('articulos_por_clinica').insert({ clinic_id: tr.destino_clinic_id, articulo_id: articuloId, cantidad: +tr.cantidad || 0 })
            }
            await admin.from('traslados_internos').update({ estado: 'recibido', recibido_por_emp_id: auth.emp.id, recibido_at: new Date().toISOString() }).eq('id', id)
            return sendJson(200, { ok: true })
          }
        } catch (e) {
          return sendJson(500, { error: String(e?.message || e) })
        }
        return next()
      })()
    })
  }
  return {
    name: 'erp-operations',
    configureServer: mount,
    configurePreviewServer: mount,
  }
}

/** data URL puede incluir parámetros (ej. jsPDF: data:application/pdf;filename=...;base64,...). */
function parseDataUrlForUpload(dataUrl) {
  const s = String(dataUrl || '')
  const idx = s.indexOf(';base64,')
  if (idx < 5 || !s.startsWith('data:')) return null
  const header = s.slice(5, idx)
  const mime = header.split(';')[0].trim()
  const ok =
    mime === 'application/pdf' ||
    /^image\/[a-zA-Z0-9.+-]+$/.test(mime)
  if (!ok) return null
  const b64 = s.slice(idx + ';base64,'.length)
  if (!b64) return null
  return { mime, b64 }
}

export function mediaUploadPlugin(supabaseUrl, serviceRoleKey) {
  const mount = (server) => {
    server.middlewares.use('/api/admin/upload-image', (req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      if (req.method === 'OPTIONS') {
        res.statusCode = 204
        return res.end()
      }
      if (req.method !== 'POST') return next()
      if (!serviceRoleKey || !supabaseUrl) {
        res.statusCode = 503
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        return res.end(JSON.stringify({ error: 'Falta configuración de Supabase server-side.' }))
      }
      const chunks = []
      req.on('data', c => chunks.push(c))
      req.on('end', async () => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        try {
          const authHeader = req.headers.authorization || ''
          const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
          if (!token) {
            res.statusCode = 401
            return res.end(JSON.stringify({ error: 'Falta Authorization: Bearer <access_token>' }))
          }
          const admin = createClient(supabaseUrl, serviceRoleKey, {
            auth: { persistSession: false, autoRefreshToken: false },
          })
          const { data: userData, error: userErr } = await admin.auth.getUser(token)
          if (userErr || !userData?.user) {
            res.statusCode = 401
            return res.end(JSON.stringify({ error: 'Sesión inválida o expirada' }))
          }
          const uid = userData.user.id
          const { data: emp } = await admin.from('empleados').select('id, activo').eq('auth_user_id', uid).maybeSingle()
          if (!emp?.activo) {
            res.statusCode = 403
            return res.end(JSON.stringify({ error: 'Usuario sin permisos para subir imágenes' }))
          }
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          const dataUrl = String(body.dataUrl || '')
          const folder = String(body.folder || 'general').replace(/[^a-zA-Z0-9/_-]/g, '').slice(0, 120) || 'general'
          const parsed = parseDataUrlForUpload(dataUrl)
          if (!parsed) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: 'Formato inválido. Se esperaba data URL de imagen o PDF.' }))
          }
          const { mime, b64 } = parsed
          const ext =
            mime === 'application/pdf'
              ? 'pdf'
              : mime.includes('png')
                ? 'png'
                : mime.includes('webp')
                  ? 'webp'
                  : 'jpg'
          const bytes = Buffer.from(b64, 'base64')
          const maxBytes = mime === 'application/pdf' ? 15 * 1024 * 1024 : 8 * 1024 * 1024
          if (bytes.length > maxBytes) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: mime === 'application/pdf' ? 'El PDF supera el límite de 15MB.' : 'La imagen supera el límite de 8MB.' }))
          }
          const path = `${folder}/${uid}/${Date.now()}-${Math.random().toString(36).slice(2, 9)}.${ext}`
          const up = await admin.storage.from('erp-media').upload(path, bytes, { contentType: mime, upsert: false })
          if (up.error) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: up.error.message }))
          }
          const pub = admin.storage.from('erp-media').getPublicUrl(path)
          res.end(JSON.stringify({ ok: true, url: pub?.data?.publicUrl || '' }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })
    })
    server.middlewares.use('/api/admin/delete-image', (req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      if (req.method === 'OPTIONS') {
        res.statusCode = 204
        return res.end()
      }
      if (req.method !== 'POST') return next()
      if (!serviceRoleKey || !supabaseUrl) {
        res.statusCode = 503
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        return res.end(JSON.stringify({ error: 'Falta configuración de Supabase server-side.' }))
      }
      const chunks = []
      req.on('data', c => chunks.push(c))
      req.on('end', async () => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        try {
          const authHeader = req.headers.authorization || ''
          const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
          if (!token) {
            res.statusCode = 401
            return res.end(JSON.stringify({ error: 'Falta Authorization: Bearer <access_token>' }))
          }
          const admin = createClient(supabaseUrl, serviceRoleKey, {
            auth: { persistSession: false, autoRefreshToken: false },
          })
          const { data: userData, error: userErr } = await admin.auth.getUser(token)
          if (userErr || !userData?.user) {
            res.statusCode = 401
            return res.end(JSON.stringify({ error: 'Sesión inválida o expirada' }))
          }
          const uid = userData.user.id
          const { data: emp } = await admin.from('empleados').select('id, activo').eq('auth_user_id', uid).maybeSingle()
          if (!emp?.activo) {
            res.statusCode = 403
            return res.end(JSON.stringify({ error: 'Usuario sin permisos para borrar imágenes' }))
          }
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          const path = String(body.path || '').trim()
          if (!path || path.includes('..')) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: 'Path inválido' }))
          }
          const rm = await admin.storage.from('erp-media').remove([path])
          if (rm.error) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: rm.error.message }))
          }
          res.end(JSON.stringify({ ok: true }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })
    })
  }
  return {
    name: 'media-upload',
    configureServer: mount,
    configurePreviewServer: mount,
  }
}

// Fin del módulo: `defineConfig` de Vite se quita aquí porque este archivo
// corre como servidor Node standalone. Ver ./server.js para el wiring.
