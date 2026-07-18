import express from 'express'
import multer from 'multer'
import { jsonrepair } from 'jsonrepair'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const app = express()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } })
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const execFileAsync = promisify(execFile)

app.use(express.json({ limit: '50mb' }))

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

async function availableModels(baseUrl, apiKey) {
  const response = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  })
  const data = await parseResponse(response)
  return Array.isArray(data?.data) ? data.data.map(item => item?.id).filter(Boolean) : []
}

function chooseVisionModel(models, preferred) {
  if (preferred && models.includes(preferred)) return preferred
  const candidates = models.filter(id => !/image|dall|flux|seedream|ideogram|recraft/i.test(id))
  const priorities = [
    /gpt-5/i, /gpt-4\.1/i, /gpt-4o/i, /gemini.*(?:pro|flash)/i,
    /claude.*(?:sonnet|opus|haiku)/i, /qwen.*(?:vl|vision)/i,
  ]
  for (const pattern of priorities) {
    const match = candidates.find(id => pattern.test(id))
    if (match) return match
  }
  return candidates[0] || ''
}

function parseModelJson(content) {
  if (typeof content !== 'string' || !content.trim()) throw new Error('文案模型没有返回分析内容')
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  try { return JSON.parse(cleaned) } catch {}
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start >= 0 && end > start) {
    const candidate = cleaned.slice(start, end + 1)
    try { return JSON.parse(candidate) } catch {}
    try { return JSON.parse(jsonrepair(candidate)) } catch {}
  }
  if (start >= 0) {
    try { return JSON.parse(jsonrepair(cleaned.slice(start))) } catch {}
  }
  try { return JSON.parse(jsonrepair(cleaned)) } catch {}
  throw new Error('文案模型返回的格式无法解析，请重试')
}

app.get('/api/health', (_, res) => res.json({ ok: true }))

app.post('/api/select-directory', async (_, res) => {
  try {
    if (process.platform !== 'win32') {
      throw new Error('当前浏览器版本暂时只支持在 Windows 中打开系统文件夹选择器')
    }
    const script = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$dialog.Description = '选择生成图片自动保存文件夹'",
      '$dialog.ShowNewFolderButton = $true',
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.SelectedPath) }',
    ].join('; ')
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 120000,
    })
    res.json({ ok: true, directory: stdout.trim() })
  } catch (error) {
    res.status(500).json({ ok: false, error: { message: error.message } })
  }
})

function safeFilename(value) {
  return value.toString().replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').replace(/\s+/g, '-').slice(0, 100)
}

app.post('/api/save-image', async (req, res) => {
  try {
    const directory = (req.body?.directory || '').toString().trim()
    const image = (req.body?.image || '').toString()
    const category = safeFilename(req.body?.category || '其他创作')
    const filename = safeFilename(req.body?.filename || `image-${Date.now()}`)
    if (!directory) throw new Error('请先设置图片保存目录')
    if (!path.isAbsolute(directory)) throw new Error('保存目录必须是完整的绝对路径')
    if (!image) throw new Error('没有可保存的图片数据')

    let buffer
    let extension = 'png'
    if (/^data:image\//i.test(image)) {
      const match = image.match(/^data:image\/([^;,]+);base64,(.+)$/s)
      if (!match) throw new Error('无法识别 Base64 图片数据')
      extension = safeFilename(match[1].replace('jpeg', 'jpg'))
      buffer = Buffer.from(match[2], 'base64')
    } else if (/^https?:\/\//i.test(image)) {
      const response = await fetch(image)
      if (!response.ok) throw new Error(`下载生成图片失败（${response.status}）`)
      const contentType = response.headers.get('content-type') || ''
      const type = contentType.match(/^image\/([^;]+)/i)?.[1]
      if (type) extension = safeFilename(type.replace('jpeg', 'jpg'))
      buffer = Buffer.from(await response.arrayBuffer())
    } else {
      throw new Error('图片地址格式不受支持')
    }

    const targetDirectory = path.join(directory, category)
    await fs.mkdir(targetDirectory, { recursive: true })
    const targetPath = path.join(targetDirectory, `${filename}.${extension}`)
    await fs.writeFile(targetPath, buffer)
    res.json({ ok: true, path: targetPath })
  } catch (error) {
    res.status(400).json({ ok: false, error: { message: error.message } })
  }
})

app.post('/api/test', async (req, res) => {
  try {
    const { baseUrl, apiKey } = config(req)
    const model = (req.body?.model || '').toString().trim()
    const copyModel = (req.body?.copyModel || '').toString().trim()
    const startedAt = Date.now()
    const response = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    })
    const data = await parseResponse(response)
    const models = Array.isArray(data?.data) ? data.data.map(item => item?.id).filter(Boolean) : []
    const imageModels = models.filter(id => /image|dall|flux|seedream|ideogram|recraft/i.test(id))
    const textModels = models.filter(id => !imageModels.includes(id))
    const modelAvailable = model ? models.includes(model) : null
    const copyModelAvailable = copyModel ? models.includes(copyModel) : null
    res.json({
      ok: true,
      latency: Date.now() - startedAt,
      model,
      modelAvailable,
      copyModel,
      copyModelAvailable,
      modelsCount: models.length,
      imageModels,
      textModels,
      message: modelAvailable === false
        ? `连接和鉴权正常，但模型列表中没有图片模型 ${model}`
        : copyModelAvailable === false
          ? `图片模型正常，但模型列表中没有文案分析模型 ${copyModel}`
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

app.post('/api/ecommerce-analyze', upload.array('image', 6), async (req, res) => {
  try {
    const images = req.files || []
    if (!images.length) throw new Error('请至少上传一张商品图片')
    const { baseUrl, apiKey } = config(req)
    const preferredModel = (req.body.model || 'gpt-5.6').toString()
    const mainCount = Math.max(1, Math.min(10, Number(req.body.mainCount) || 7))
    const skuCount = Math.max(0, Math.min(10, Number(req.body.skuCount) || 0))
    const detailCount = Math.max(1, Math.min(30, Number(req.body.detailCount) || 12))
    const allowedSizes = new Set(['1024x1024', '1536x1024', '1024x1536', '512x512', '1024x1792', '1024x2048', '1024x2560'])
    const mainSize = allowedSizes.has(req.body.mainSize) ? req.body.mainSize : '1024x1024'
    const skuSize = allowedSizes.has(req.body.skuSize) ? req.body.skuSize : '1024x1024'
    const detailSize = allowedSizes.has(req.body.detailSize) ? req.body.detailSize : '1024x1536'
    const detailWithProductCount = Math.round(detailCount * 0.6)
    const detailWithoutProductCount = detailCount - detailWithProductCount
    const languageMap = {
      'zh-CN': '简体中文', 'zh-TW': '繁體中文', en: 'English', ja: '日本語', ko: '한국어',
      es: 'Español', 'pt-BR': 'Português do Brasil', fr: 'Français', de: 'Deutsch', it: 'Italiano',
      nl: 'Nederlands', pl: 'Polski', ru: 'Русский', uk: 'Українська', tr: 'Türkçe', ar: 'العربية',
      he: 'עברית', hi: 'हिन्दी', th: 'ไทย', vi: 'Tiếng Việt', id: 'Bahasa Indonesia',
      ms: 'Bahasa Melayu', fil: 'Filipino', sv: 'Svenska', da: 'Dansk', no: 'Norsk',
    }
    const languageCode = (req.body.language || 'zh-CN').toString()
    const targetLanguage = languageMap[languageCode] || '简体中文'
    const productDescription = (req.body.productDescription || '').toString().trim().slice(0, 1000)
    const descriptionGuidance = productDescription
      ? `用户已经人工确认了以下商品信息，可信度高于仅凭图片进行的品类猜测。你必须以此作为商品身份、用途和关键特征的主要依据，并用图片补充外观细节；即使外形容易被误认为其他商品，也不得擅自改变品类。\n【用户商品描述】\n${productDescription}\n【描述结束】`
      : '用户没有提供人工商品描述，请谨慎根据图片识别品类；无法确认时必须写入 uncertainties，不得武断判断。'
    const models = await availableModels(baseUrl, apiKey)
    const model = chooseVisionModel(models, preferredModel)
    if (!model) throw new Error('当前令牌没有可用于商品图片分析的文本模型')
    const imageContent = images.map(file => ({
      type: 'image_url',
      image_url: { url: `data:${file.mimetype};base64,${file.buffer.toString('base64')}` },
    }))
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        max_tokens: 16000,
        messages: [
          { role: 'system', content: `你是资深爆款电商操盘手、视觉策划和商品文案编辑。用户只提供商品图片，你必须主动识别商品品类、视觉特征、潜在人群、使用场景、消费情绪和购买动机。严格区分图片可见事实和推测，禁止虚构材质、尺寸、成分、功效、认证、价格、销量、排名、SKU 规格或品牌背书；无法确认的内容放入 uncertainties。输出纯 JSON，字段必须为：productSummary 字符串、targetAudience 字符串、sellingPoints 字符串数组、titles 字符串数组、mainImageCopy 字符串数组、mainImagePrompts 字符串数组、skuImagePrompts 字符串数组、detailImagePrompts 字符串数组、uncertainties 字符串数组。必须严格输出 ${mainCount} 条 mainImagePrompts、${skuCount} 条 skuImagePrompts、${detailCount} 条 detailImagePrompts。所有分析、标题、卖点、说明文案和生图提示词必须使用 ${targetLanguage}；图片中要求呈现的文字也必须明确使用 ${targetLanguage}，禁止混入其他语言。每条都是可直接交给图片编辑模型的完整提示词。

分类规则：
1. mainImagePrompts：每条提示词必须明确要求使用 ${mainSize} 画布，整套主图尺寸完全一致。覆盖白底主图、核心利益点、使用场景、产品细节、氛围展示等不同角度。可以有少量简短主标题，但必须突出商品本身。
2. skuImagePrompts：每条提示词必须明确要求使用 ${skuSize} 画布，整套 SKU 图尺寸完全一致。必须生成纯商品图片。严禁任何文字、字母、数字、价格、参数、标签、表格、边框、按钮、色块说明、SKU 卡片、占位线或界面元素；只展示参考图中真实可见的商品款式，使用干净纯色或透明感背景、统一角度和清晰产品摄影。若只有一个款式，就通过正面、侧面、俯视、组合陈列等角度形成 SKU 图，不得虚构颜色和规格。
3. detailImagePrompts：每条提示词必须明确要求严格使用 ${detailSize} 画布，整套详情图的尺寸和比例必须完全一致，禁止输出其他宽高比。必须生成完成度高的图文详情页，不能只预留空白、占位框或指示线。严格规划 ${detailWithProductCount} 张展示商品的详情图和 ${detailWithoutProductCount} 张不展示商品的关联元素详情图；数组中每条提示词开头必须明确使用“【展示商品】”或“【关联元素】”标记，并保证数量准确。
   - 【展示商品】：画面中出现完整商品或有效商品细节，依次覆盖品牌首屏、完整商品加局部细节、核心卖点证据、真实使用场景、使用方式、包装展示等。商品局部特写不能占满整张图，必须同时出现完整商品参照。
   - 【关联元素】：画面中严禁出现商品本体，也不要出现相似替代商品。使用与商品相关的生活场景、人物动作、原料或材质氛围、环境细节、用户痛点、情绪画面、搭配物件来承接叙事。例如杯具可展示清晨阳光、咖啡豆、书本、办公桌、通勤包、阅读角或放松氛围，但不出现杯子。此类图片应作为详情页的视觉过渡和情绪铺垫。
   整套依次使用品牌首屏、生活场景、痛点与解决方案、商品细节、核心卖点、多场景适配、使用步骤、情绪氛围、购买收口等不同主题。优先采用类似杂志广告的成熟版式，不得出现无意义空白线框。每张详情图要明确写出需要在图片中真实呈现的 1 个简短主标题和 2–4 条短说明，并指定清晰可读的排版位置、字号层级和图文关系；不要生成长段文字。文案只能描述图片可确认的外观、场景和通用使用价值，未知参数用中性表达，不得虚构。

所有图片必须严格保持参考商品的造型、比例、颜色、结构、商标和包装文字一致。` },
          { role: 'user', content: [
            { type: 'text', text: `${descriptionGuidance}\n\n请分析商品图片并规划完整电商套图：商品主图 ${mainCount} 张（${mainSize}）、SKU 图 ${skuCount} 张（${skuSize}）、详情图 ${detailCount} 张（${detailSize}）。目标内容语言是 ${targetLanguage}。每张图的提示词必须用途不同、前后连贯且可以直接生成。所有分析、卖点、标题和生图提示词必须始终保持与人工确认的商品身份一致。不要向用户提问。` },
            ...imageContent,
          ] },
        ],
      }),
    })
    const data = await parseResponse(response)
    const content = data?.choices?.[0]?.message?.content
    const result = parseModelJson(content)
    res.json({ ...result, analyzedBy: model, requestedModel: preferredModel })
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
