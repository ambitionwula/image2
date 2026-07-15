import express from 'express'
import multer from 'multer'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const app = express()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } })
const __dirname = path.dirname(fileURLToPath(import.meta.url))

app.use(express.json({ limit: '2mb' }))

function config(req) {
  const baseUrl = (req.headers['x-base-url'] || process.env.NEWAPI_BASE_URL || '').toString().replace(/\/$/, '')
  const apiKey = (req.headers['x-api-key'] || process.env.NEWAPI_API_KEY || '').toString()
  if (!baseUrl) throw new Error('请先填写 NewAPI Base URL')
  if (!apiKey) throw new Error('请先填写 API Key')
  return { baseUrl, apiKey }
}

async function parseResponse(response) {
  const text = await response.text()
  let data
  try { data = JSON.parse(text) } catch { data = { error: { message: text || `HTTP ${response.status}` } } }
  if (!response.ok) throw new Error(data?.error?.message || data?.message || `请求失败（${response.status}）`)
  return data
}

app.get('/api/health', (_, res) => res.json({ ok: true }))

app.post('/api/test', async (req, res) => {
  try {
    const { baseUrl, apiKey } = config(req)
    const model = (req.body?.model || '').toString().trim()
    const startedAt = Date.now()
    const response = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    })
    const data = await parseResponse(response)
    const models = Array.isArray(data?.data) ? data.data.map(item => item?.id).filter(Boolean) : []
    const imageModels = models.filter(id => /image|dall|flux|seedream|ideogram|recraft/i.test(id))
    const modelAvailable = model ? models.includes(model) : null
    res.json({
      ok: true,
      latency: Date.now() - startedAt,
      model,
      modelAvailable,
      modelsCount: models.length,
      imageModels,
      message: modelAvailable === false
        ? `连接和鉴权正常，但模型列表中没有 ${model}`
        : '连接、鉴权和模型检查正常',
    })
  } catch (error) {
    res.status(400).json({ ok: false, error: { message: error.message } })
  }
})

app.post('/api/generate', async (req, res) => {
  try {
    const { baseUrl, apiKey } = config(req)
    const response = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    })
    res.json(await parseResponse(response))
  } catch (error) {
    res.status(400).json({ error: { message: error.message } })
  }
})

app.post('/api/edit', upload.fields([
  { name: 'image', maxCount: 10 },
  { name: 'mask', maxCount: 1 },
]), async (req, res) => {
  try {
    const images = req.files?.image || []
    const mask = req.files?.mask?.[0]
    if (!images.length) throw new Error('请选择要编辑的图片')
    const { baseUrl, apiKey } = config(req)
    const form = new FormData()
    for (const file of images) {
      form.append(images.length > 1 ? 'image[]' : 'image', new Blob([file.buffer], { type: file.mimetype }), file.originalname)
    }
    if (mask) form.append('mask', new Blob([mask.buffer], { type: 'image/png' }), 'mask.png')
    for (const [key, value] of Object.entries(req.body)) {
      if (value !== undefined && value !== '') form.append(key, value)
    }
    const response = await fetch(`${baseUrl}/images/edits`, {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form,
    })
    res.json(await parseResponse(response))
  } catch (error) {
    res.status(400).json({ error: { message: error.message } })
  }
})

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'dist')))
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next()
    res.sendFile(path.join(__dirname, 'dist', 'index.html'))
  })
}

export function startServer(port = Number(process.env.PORT || 8787)) {
  const server = app.listen(port, '127.0.0.1', () => {
    const actualPort = server.address().port
    console.log(`Image Studio API: http://127.0.0.1:${actualPort}`)
  })
  return server
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) startServer()
