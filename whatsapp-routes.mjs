import express from 'express'
import { createClient } from '@supabase/supabase-js'
import QRCode from 'qrcode'

function nowTs() {
  return Date.now()
}

function safeStr(v) {
  return String(v || '').trim()
}

export function createWhatsAppRouter({ supabaseUrl, serviceRoleKey }) {
  const router = express.Router()
  router.use(express.json({ limit: '10mb' }))

  const sessions = new Map()
  const messagesByConversation = new Map()

  const admin = (supabaseUrl && serviceRoleKey)
    ? createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
    : null

  router.get('/qr', async (_req, res) => {
    try {
      const raw = `whatsapp:qr:${nowTs()}`
      const dataUrl = await QRCode.toDataURL(raw, { margin: 1, width: 512 })
      res.json({ ok: true, data: { qr: dataUrl, raw } })
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) })
    }
  })

  router.post('/connect-real', (req, res) => {
    try {
      const userId = safeStr(req.body?.userId) || 'default'
      const phoneNumber = safeStr(req.body?.phoneNumber)
      const accessToken = safeStr(req.body?.accessToken)
      sessions.set(userId, {
        connected: true,
        connectedAt: new Date().toISOString(),
        phoneNumber,
        accessTokenMasked: accessToken ? `${accessToken.slice(0, 4)}***` : '',
      })
      res.json({ ok: true, connectionStatus: 'connected', userId, phoneNumber })
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) })
    }
  })

  router.post('/connect', (req, res) => {
    req.url = '/connect-real'
    router.handle(req, res)
  })

  router.post('/extract-real-contacts', async (req, res) => {
    try {
      if (!admin) {
        return res.status(400).json({ ok: false, error: 'Falta VITE_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en backend' })
      }
      const clinicIdRaw = req.body?.clinicId
      let q = admin.from('clientes').select('id, clinic_id, nombre, tel, email').order('id', { ascending: false }).limit(500)
      if (clinicIdRaw != null && clinicIdRaw !== '') q = q.eq('clinic_id', Number(clinicIdRaw))
      const { data, error } = await q
      if (error) return res.status(400).json({ ok: false, error: error.message })

      const rows = (data || []).map((c) => ({
        id: `wa_${c.id}`,
        contactId: c.id,
        contactName: safeStr(c.nombre) || `Cliente ${c.id}`,
        phoneNumber: safeStr(c.tel),
        email: safeStr(c.email),
        clinicId: c.clinic_id ?? null,
        conversationId: `wa_${c.id}`,
      }))
      res.json({
        ok: true,
        totalContacts: rows.length,
        extractedContacts: rows.length,
        results: rows,
      })
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) })
    }
  })

  router.get('/get_conversations', async (req, res) => {
    try {
      if (!admin) return res.json({ success: true, conversations: [], needsQr: false })
      const clinicIdRaw = req.query?.clinicId
      let q = admin.from('clientes').select('id, clinic_id, nombre, tel').order('id', { ascending: false }).limit(200)
      if (clinicIdRaw != null && clinicIdRaw !== '') q = q.eq('clinic_id', Number(clinicIdRaw))
      const { data, error } = await q
      if (error) return res.status(400).json({ success: false, error: error.message, conversations: [] })

      const conversations = (data || []).map((c) => {
        const convId = `wa_${c.id}`
        const msgs = messagesByConversation.get(convId) || []
        const last = msgs[msgs.length - 1]
        return {
          id: convId,
          externalId: convId,
          name: safeStr(c.nombre) || `Cliente ${c.id}`,
          lastMessage: safeStr(last?.body),
          timestamp: Number(last?.timestamp || 0),
          unread: 0,
          online: false,
          aiActive: false,
          phoneNumber: safeStr(c.tel),
        }
      })
      res.json({ success: true, conversations, needsQr: false })
    } catch (e) {
      res.status(500).json({ success: false, conversations: [], error: String(e?.message || e) })
    }
  })

  router.get('/get_messages', (req, res) => {
    try {
      const conversationId = safeStr(req.query?.conversationId)
      if (!conversationId) return res.json([])
      const msgs = messagesByConversation.get(conversationId) || []
      res.json(msgs)
    } catch (_e) {
      res.json([])
    }
  })

  router.post('/send_message', (req, res) => {
    try {
      const conversationId = safeStr(req.body?.conversationId)
      const textContent = safeStr(req.body?.textContent)
      if (!conversationId || !textContent) return res.status(400).json({ success: false, error: 'conversationId y textContent son obligatorios' })
      const msg = {
        id: `msg_${nowTs()}_${Math.random().toString(36).slice(2, 8)}`,
        body: textContent,
        sender_type: safeStr(req.body?.senderType) || 'you',
        timestamp: nowTs(),
        attachments: Array.isArray(req.body?.attachments) ? req.body.attachments : [],
      }
      const current = messagesByConversation.get(conversationId) || []
      current.push(msg)
      messagesByConversation.set(conversationId, current)
      res.json({ success: true, message: msg })
    } catch (e) {
      res.status(500).json({ success: false, error: String(e?.message || e) })
    }
  })

  router.post('/sync-messages', (_req, res) => {
    res.json({ success: true, synced: true })
  })

  return router
}
