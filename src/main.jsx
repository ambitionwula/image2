import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import ImageMaskEditor from './ImageMaskEditor'
import EcommercePlanner from './EcommercePlanner'
import './styles.css'

const defaults = {
  baseUrl: 'https://newapi.smartlifemarketing.com/v1', apiKey: '', model: 'gpt-image-2', copyModel: 'gpt-5.6-sol',
  size: '1024x1024', quality: 'standard', format: 'url', autoSave: false, saveDirectory: '',
}

const defaultBilling = { imagePrice: 0.3, copyPrice: 0.1, imageCount: 0, copyCount: 0 }
const generationConcurrency = 2
const commerceRetryDelay = 1500

async function runWithConcurrency(items, limit, worker) {
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++
      await worker(items[index], index)
    }
  })
  await Promise.all(workers)
}

function isRetryableTimeout(message = '') {
  return /\b524\b|timeout|timed out|ETIMEDOUT|ECONNRESET|socket hang up|fetch failed/i.test(message)
}

const Icon = ({ children }) => <span className="icon">{children}</span>

function getImage(item) {
  if (item?.url) return item.url
  if (item?.b64_json) return `data:image/png;base64,${item.b64_json}`
  return ''
}

async function readJsonResponse(response) {
  const text = await response.text()
  if (!text) {
    throw new Error(`本地服务没有返回内容（HTTP ${response.status}）`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`本地服务返回了无法识别的内容（HTTP ${response.status}）`)
  }
}

function friendlyError(message) {
  if (isRetryableTimeout(message)) return '接口服务器响应超时，系统已自动重试；请稍后再次尝试失败的图片。'
  if (/No available channel for model/i.test(message)) {
    const group = message.match(/under group\s+([^\s(]+)/i)?.[1]
    return `NewAPI 已连接，但${group ? `令牌分组“${group}”` : '当前令牌分组'}没有该模型的可用渠道。请点击“测试接口”选择可用图片模型，或在 NewAPI 后台为该分组启用对应渠道。`
  }
  if (/401|unauthorized|invalid.*key/i.test(message)) return 'API Key 无效或没有访问权限，请检查接口设置。'
  if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(message)) return '无法连接 NewAPI，请检查 Base URL、端口以及 NewAPI 服务是否已启动。'
  return message
}

function App() {
  const [settings, setSettings] = useState(() => ({ ...defaults, ...JSON.parse(localStorage.getItem('image-studio-settings') || '{}') }))
  const [settingsLoaded, setSettingsLoaded] = useState(() => !window.desktopStorage?.loadSettings)
  const [mode, setMode] = useState('generate')
  const [prompt, setPrompt] = useState('')
  const [count, setCount] = useState(1)
  const [sources, setSources] = useState([])
  const [activeSource, setActiveSource] = useState(0)
  const [resultsByMode, setResultsByMode] = useState({ generate: [], edit: [], commerce: [] })
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [error, setError] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [billingOpen, setBillingOpen] = useState(false)
  const [billing, setBilling] = useState(() => {
    try { return { ...defaultBilling, ...JSON.parse(localStorage.getItem('image-studio-billing') || '{}') } }
    catch { return defaultBilling }
  })
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [selectingDirectory, setSelectingDirectory] = useState(false)
  const maskEditorRef = useRef(null)
  const commerceAbortRef = useRef(new Set())
  const commercePauseRef = useRef(false)

  useEffect(() => {
    if (!window.desktopStorage?.loadSettings) return
    let active = true
    window.desktopStorage.loadSettings()
      .then(saved => {
        if (active && saved && Object.keys(saved).length) setSettings(current => ({ ...current, ...saved }))
      })
      .finally(() => { if (active) setSettingsLoaded(true) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!settingsLoaded) return
    localStorage.setItem('image-studio-settings', JSON.stringify(settings))
    window.desktopStorage?.saveSettings?.(settings).catch(() => {})
  }, [settings, settingsLoaded])
  useEffect(() => localStorage.setItem('image-studio-billing', JSON.stringify(billing)), [billing])

  const headers = useMemo(() => ({ 'x-base-url': settings.baseUrl, 'x-api-key': settings.apiKey }), [settings])

  function addImageCharge(quantity) {
    if (quantity) setBilling(old => ({ ...old, imageCount: old.imageCount + quantity }))
  }

  function addCopyCharge() {
    setBilling(old => ({ ...old, copyCount: old.copyCount + 1 }))
  }

  async function chooseSaveDirectory() {
    setSelectingDirectory(true)
    try {
      let directory = ''
      if (window.desktopStorage?.selectDirectory) {
        directory = await window.desktopStorage.selectDirectory()
      } else {
        const response = await fetch('/api/select-directory', { method: 'POST' })
        const data = await readJsonResponse(response)
        if (!response.ok) throw new Error(data?.error?.message || '无法打开文件夹选择器')
        directory = data.directory
      }
      if (directory) setSettings(old => ({ ...old, saveDirectory: directory }))
    } catch (e) {
      setError(`选择保存文件夹失败：${e.message}`)
    } finally {
      setSelectingDirectory(false)
    }
  }

  async function autoSaveItem(item) {
    if (!settings.autoSave || !settings.saveDirectory || !item.src) return item
    const categoryNames = { main: '商品主图', sku: 'SKU图', detail: '商品详情图' }
    const category = categoryNames[item.commerceCategory] || (item.mode === 'edit' ? '图片编辑' : '文字生图')
    const label = item.commerceLabel || (item.mode === 'edit' ? '图片编辑' : '文字生图')
    try {
      const response = await fetch('/api/save-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directory: settings.saveDirectory, image: item.src, category, filename: `${label}-${Date.now()}` }),
      })
      const data = await readJsonResponse(response)
      if (!response.ok) throw new Error(data?.error?.message || '自动保存失败')
      return { ...item, savedPath: data.path }
    } catch (e) {
      return { ...item, saveError: e.message }
    }
  }

  async function testConnection() {
    if (!settings.baseUrl || !settings.apiKey) {
      setTestResult({ ok: false, message: '请先填写 Base URL 和 API Key' })
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const response = await fetch('/api/test', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: settings.model, copyModel: settings.copyModel }),
      })
      const data = await readJsonResponse(response)
      if (!response.ok) throw new Error(data?.error?.message || '接口测试失败')
      setTestResult({
        ...data,
        message: data.modelAvailable === false
          ? `接口可连接，但当前令牌看不到图片模型“${settings.model}”。`
          : data.copyModelAvailable === false
            ? `图片模型可用，但当前令牌看不到文案分析模型“${settings.copyModel}”。请从下方文本模型中选择。`
            : data.message,
      })
    } catch (e) {
      setTestResult({ ok: false, message: friendlyError(e.message) })
    } finally {
      setTesting(false)
    }
  }

  function selectFiles(fileList) {
    const files = Array.from(fileList || []).filter(file => file.type.startsWith('image/'))
    if (!files.length) return setError('请选择图片文件')
    setSources(old => [...old, ...files.slice(0, Math.max(0, 10 - old.length)).map(file => ({ file, url: URL.createObjectURL(file), id: crypto.randomUUID() }))])
    setError('')
  }

  function openCommercePrompt(files, value) {
    sources.forEach(item => URL.revokeObjectURL(item.url))
    setSources(files.slice(0, 10).map(file => ({ file, url: URL.createObjectURL(file), id: crypto.randomUUID() })))
    setActiveSource(0)
    setPrompt(value)
    setMode('edit')
    window.scrollTo({ top: 260, behavior: 'smooth' })
  }

  async function generateCommerceSet(files, jobs) {
    if (!settings.baseUrl || !settings.apiKey) { setSettingsOpen(true); return setError('请先完成接口设置') }
    if (!files.length || !jobs.length) return
    const pendingJobs = jobs.filter(job => !resultsByMode.commerce.some(item => item.commerceCategory === job.category && item.commerceLabel === job.label))
    if (!pendingJobs.length) return setError('这套电商图片已经全部生成完成')
    commercePauseRef.current = false
    setRunning(true); setError(''); setProgress({ done: jobs.length - pendingJobs.length, total: jobs.length })
    commerceAbortRef.current.clear()
    await runWithConcurrency(pendingJobs, generationConcurrency, async (job, i) => {
      if (commercePauseRef.current) return
      let completed = false
      let controller
      try {
        controller = new AbortController()
        commerceAbortRef.current.add(controller)
        const jobSize = job.size || (job.category === 'detail' ? '1024x1536' : '1024x1024')
        const [jobWidth, jobHeight] = jobSize.split('x').map(Number)
        const ratioDescription = jobWidth === jobHeight ? '1:1 正方形' : jobWidth > jobHeight ? '横版' : '竖版'
        const categoryRules = job.category === 'detail'
          ? `\n\n【详情图强制质量规范】画布必须严格为 ${jobWidth}×${jobHeight} 像素、${ratioDescription}比例，禁止输出其他宽高比。生成一张完成度高的电商详情页，不是草稿或占位模板。所有核心商品、文字和版式内容必须放在安全区域内，不能超出画布或被裁切。画面必须具有明确的视觉焦点、真实场景或有效细节证据。禁止空白占位框、无意义横线、指示线、线框图、网页 UI、按钮、表格外壳和未完成模板。采用成熟商业设计：统一色调、清晰网格、足够留白但不能大面积空洞、图片与文字比例协调。图片内只呈现 1 个醒目主标题和 2–4 条简短说明，所有可见文字必须使用 ${job.language || 'zh-CN'} 对应的目标语言，文字清晰、无乱码、层级明确，禁止混入其他语言；不要堆砌长段落。${job.includeProduct === false ? '这是一张关联元素详情图：画面中严禁出现商品本体或相似替代商品，应使用相关生活场景、环境、人物动作、材质氛围或搭配元素完成叙事。' : '这是一张展示商品的详情图：商品必须完整可辨认；如果使用局部特写，画面中必须同时保留完整商品作为参照。'} 优先使用多场景叙事、完整视觉证据和前后连续的详情页版式。`
          : job.category === 'sku'
            ? `\n\n【SKU 图强制规范】画布必须严格为 ${jobWidth}×${jobHeight} 像素、${ratioDescription}比例，禁止输出其他宽高比。只生成纯商品摄影图，完整展示商品。禁止出现任何文字、字母、数字、参数、标签、价格、边框、按钮、色块说明、占位线、拼贴模板或网页界面。背景干净统一，商品边缘清晰，比例准确，商品完整位于安全区域内且不能被裁切。整套 SKU 图必须保持相同画布尺寸、商品缩放比例、留白范围和视觉重心。`
            : `\n\n【主图强制质量规范】画布必须严格为 ${jobWidth}×${jobHeight} 像素、${ratioDescription}比例，禁止输出其他宽高比。商品必须完整、清晰并保持参考图一致，所有商品和文字必须位于安全区域内，不能超出画布或被裁切。构图成熟、商业摄影质感强，避免无意义空白、模板线框和商品变形。整套主图必须保持相同画布尺寸、主体缩放范围和视觉重心。`
        const finalPrompt = job.prompt + categoryRules
        let data
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            if (attempt > 0) {
              await new Promise(resolve => window.setTimeout(resolve, commerceRetryDelay))
              if (commercePauseRef.current) return
            }
            let response
            if (job.category === 'detail' && job.includeProduct === false) {
              response = await fetch('/api/generate', {
                method: 'POST', signal: controller.signal,
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: settings.model, prompt: finalPrompt, n: 1, size: jobSize, quality: 'high', response_format: settings.format }),
              })
            } else {
              const form = new FormData()
              files.forEach(file => form.append('image', file))
              form.append('model', settings.model)
              form.append('prompt', finalPrompt)
              form.append('n', '1')
              form.append('size', jobSize)
              form.append('quality', 'high')
              form.append('response_format', settings.format)
              response = await fetch('/api/edit', { method: 'POST', headers, body: form, signal: controller.signal })
            }
            data = await readJsonResponse(response)
            if (!response.ok) throw new Error(data?.error?.message || '电商图片生成失败')
            break
          } catch (requestError) {
            if (requestError.name === 'AbortError' || commercePauseRef.current) throw requestError
            if (attempt === 0 && isRetryableTimeout(requestError.message)) continue
            throw requestError
          }
        }
        const additions = (data.data || []).map((item, n) => ({
          id: `commerce-${Date.now()}-${i}-${n}`,
          src: getImage(item), prompt: job.prompt, mode: 'commerce', commerceCategory: job.category,
          commerceLabel: job.label, commerceSize: jobSize, createdAt: new Date(),
        })).filter(item => item.src)
        if (!additions.length) throw new Error('接口没有返回可识别的图片数据')
        const savedAdditions = await Promise.all(additions.map(autoSaveItem))
        setResultsByMode(old => ({ ...old, commerce: [...savedAdditions, ...old.commerce] }))
        addImageCharge(additions.length)
        const saveFailure = savedAdditions.find(item => item.saveError)
        if (saveFailure) setError(`图片已生成，但自动保存失败：${saveFailure.saveError}`)
        completed = true
      } catch (e) {
        if (e.name === 'AbortError' || commercePauseRef.current) return
        setError(`电商套图第 ${i + 1} 张失败：${friendlyError(e.message)}`)
      } finally {
        if (controller) commerceAbortRef.current.delete(controller)
        if (completed) setProgress(old => ({ ...old, done: old.done + 1 }))
      }
    })
    commerceAbortRef.current.clear()
    setRunning(false)
    window.setTimeout(() => document.querySelector('.gallery-section')?.scrollIntoView({ behavior: 'smooth' }), 150)
  }

  function pauseCommerceGeneration() {
    commercePauseRef.current = true
    commerceAbortRef.current.forEach(controller => controller.abort())
    commerceAbortRef.current.clear()
    setRunning(false)
    setError('生成已暂停，已完成的图片会保留；再次点击“继续生成剩余图片”即可续传。')
  }

  function removeSource(index) {
    setSources(old => {
      URL.revokeObjectURL(old[index].url)
      return old.filter((_, i) => i !== index)
    })
    setActiveSource(current => Math.max(0, current > index ? current - 1 : Math.min(current, sources.length - 2)))
  }

  async function run() {
    if (!prompt.trim()) return setError('请输入画面描述或编辑指令')
    if (!settings.baseUrl || !settings.apiKey) { setSettingsOpen(true); return setError('请先完成接口设置') }
    if (mode === 'edit' && !sources.length) return setError('请先上传要编辑的图片')
    const runMode = mode
    setRunning(true); setError(''); setProgress({ done: 0, total: count })
    for (let i = 0; i < count; i++) {
      try {
        let response
        if (runMode === 'generate') {
          response = await fetch('/api/generate', {
            method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: settings.model, prompt: prompt.trim(), n: 1, size: settings.size, quality: settings.quality, response_format: settings.format }),
          })
        } else {
          const form = new FormData()
          const orderedSources = [sources[activeSource], ...sources.filter((_, index) => index !== activeSource)]
          orderedSources.forEach(item => form.append('image', item.file))
          const mask = await maskEditorRef.current?.getMask()
          if (mask) form.append('mask', mask, 'mask.png')
          form.append('model', settings.model)
          form.append('prompt', prompt.trim())
          form.append('n', '1')
          form.append('size', settings.size)
          form.append('response_format', settings.format)
          response = await fetch('/api/edit', { method: 'POST', headers, body: form })
        }
        const data = await readJsonResponse(response)
        if (!response.ok) throw new Error(data?.error?.message || '生成失败')
        const additions = (data.data || []).map((item, n) => ({
          id: `${Date.now()}-${i}-${n}`, src: getImage(item), prompt, mode: runMode, createdAt: new Date(),
        })).filter(x => x.src)
        if (!additions.length) throw new Error('接口没有返回可识别的图片数据')
        const savedAdditions = await Promise.all(additions.map(autoSaveItem))
        setResultsByMode(old => ({ ...old, [runMode]: [...savedAdditions, ...old[runMode]] }))
        addImageCharge(additions.length)
        const saveFailure = savedAdditions.find(item => item.saveError)
        if (saveFailure) setError(`图片已生成，但自动保存失败：${saveFailure.saveError}`)
      } catch (e) {
        setError(`第 ${i + 1} 张失败：${friendlyError(e.message)}`)
        break
      } finally {
        setProgress(p => ({ ...p, done: p.done + 1 }))
      }
    }
    setRunning(false)
  }

  async function download(item) {
    try {
      const blob = await fetch(item.src).then(r => r.blob())
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = `image-${item.id}.png`; a.click()
      URL.revokeObjectURL(url)
    } catch { window.open(item.src, '_blank') }
  }

  function useForEdit(item) {
    fetch(item.src).then(r => r.blob()).then(blob => {
      const file = new File([blob], 'generated-image.png', { type: blob.type || 'image/png' })
      selectFiles([file]); setMode('edit'); window.scrollTo({ top: 0, behavior: 'smooth' })
    }).catch(() => setError('无法读取该图片用于编辑，请先下载后上传'))
  }

  const results = resultsByMode[mode] || []

  function clearCurrentResults() {
    setResultsByMode(old => ({ ...old, [mode]: [] }))
  }

  const imageCost = billing.imageCount * billing.imagePrice
  const copyCost = billing.copyCount * billing.copyPrice
  const totalCost = imageCost + copyCost

  return <div className="app-shell">
    <header>
      <div className="brand"><div className="brand-mark">造</div><div><b>造像所</b><small>LOCAL IMAGE LAB</small></div></div>
      <div className="header-actions"><button className="ghost billing-trigger" onClick={() => setBillingOpen(true)}><Icon>¥</Icon> 模拟计费 <small>¥{totalCost.toFixed(2)}</small></button><button className="ghost" onClick={() => setSettingsOpen(true)}><Icon>⚙</Icon> 接口设置</button></div>
    </header>

    <main>
      <section className="hero">
        <span className="eyebrow">AI IMAGE WORKSPACE</span>
        <h1>让想象，<em>清晰可见。</em></h1>
        <p>在本地完成图片生成与创意编辑。你的密钥与工作流由你掌控。</p>
      </section>

      <section className="workspace">
        <div className="tabs">
          <button className={mode === 'generate' ? 'active' : ''} onClick={() => setMode('generate')}><Icon>✦</Icon> 文字生图</button>
          <button className={mode === 'edit' ? 'active' : ''} onClick={() => setMode('edit')}><Icon>◩</Icon> 图片编辑</button>
          <button className={mode === 'commerce' ? 'active' : ''} onClick={() => setMode('commerce')}><Icon>◆</Icon> 电商策划</button>
        </div>

        <div hidden={mode !== 'commerce'}>
          <EcommercePlanner headers={headers} settings={settings} generating={running} progress={progress} onPause={pauseCommerceGeneration} onOpenSettings={() => setSettingsOpen(true)} onEditPrompt={openCommercePrompt} onGenerateSet={generateCommerceSet} onCopyGenerated={addCopyCharge} />
        </div>

        {mode === 'edit' && <div className="upload-row">
          {sources.length === 0 ? <label className="dropzone" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); selectFiles(e.dataTransfer.files) }}>
            <input type="file" accept="image/*" multiple onChange={e => selectFiles(e.target.files)} />
            <><b>＋</b><span>点击或拖入图片</span><small>可同时选择多张；第一张作为主图，其余作为参考图</small></>
          </label> : <>
            <ImageMaskEditor ref={maskEditorRef} item={sources[activeSource]} />
            <div className="source-strip">
              {sources.map((item, index) => <div className={'source-thumb ' + (index === activeSource ? 'active' : '')} key={item.id} onClick={() => setActiveSource(index)}>
                <img src={item.url} /><span>{index === activeSource ? '编辑主图' : `参考图 ${index}`}</span><button onClick={e => { e.stopPropagation(); removeSource(index) }}>×</button>
              </div>)}
              {sources.length < 10 && <label className="add-source"><input type="file" accept="image/*" multiple onChange={e => selectFiles(e.target.files)} /><b>＋</b><span>添加参考图</span></label>}
            </div>
            <p className="editor-tip">点击缩略图可切换要修改的主图。提交时，主图会排在第一张，其他图片用于提供人物、风格或产品参考。</p>
          </>}
        </div>}

        {mode !== 'commerce' && <div className="prompt-wrap">
          <textarea value={prompt} onChange={e => setPrompt(e.target.value)} placeholder={mode === 'generate' ? '描述你想创造的画面，例如：雨后的东京街头，霓虹倒映在湿润路面，电影感摄影……' : '描述想如何修改，例如：把天空改成绚丽晚霞，保持人物和构图不变……'} />
          <span className="char-count">{prompt.length}</span>
        </div>}

        {mode !== 'commerce' && <div className="controls">
          <label><span>画面尺寸</span><select value={settings.size} onChange={e => setSettings(s => ({ ...s, size: e.target.value }))}><option>1024x1024</option><option>1536x1024</option><option>1024x1536</option><option>512x512</option></select></label>
          <label><span>生成数量</span><select value={count} onChange={e => setCount(Number(e.target.value))}>{[1,2,3,4,5,6,8,10].map(n => <option key={n} value={n}>{n} 张（依次）</option>)}</select></label>
          <label><span>质量</span><select value={settings.quality} onChange={e => setSettings(s => ({ ...s, quality: e.target.value }))}><option value="standard">标准</option><option value="hd">高清</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
          <button className="create" disabled={running} onClick={run}>{running ? <span className="ai-thinking"><i />AI 正在思考中 <small>{progress.done}/{progress.total}</small></span> : <><Icon>✦</Icon>{mode === 'generate' ? '开始创造' : '开始编辑'}</>}</button>
        </div>}
        {error && <div className="error">{error}</div>}
      </section>

      <section className="gallery-section">
        <div className="section-title"><div><span>YOUR CREATIONS</span><h2>{mode === 'generate' ? '文字生图记录' : mode === 'edit' ? '图片编辑记录' : '电商策划记录'}</h2></div>{results.length > 0 && <button className="text-btn" onClick={clearCurrentResults}>清空当前记录</button>}</div>
        {results.length === 0 ? <div className="empty"><div>◇</div><p>灵感正在等待发生</p><span>生成的作品会出现在这里</span></div> : <>
          {[['main', '商品主图'], ['sku', 'SKU 图'], ['detail', '商品详情图']].map(([category, title]) => {
            const items = results.filter(item => item.commerceCategory === category)
            if (!items.length) return null
            return <div className={`result-group ${category}`} key={category}><div className="result-group-title"><h3>{title}</h3><span>{items.length} 张</span></div><div className="gallery">{items.map(item => <article key={item.id}>
              <img src={item.src} alt={item.prompt} style={item.commerceSize ? { aspectRatio: item.commerceSize.replace('x', ' / ') } : undefined} />
              <div className="card-info"><b>{item.commerceLabel}</b>{category !== 'sku' && <p>{item.prompt}</p>}{item.savedPath && <small className="saved-mark">✓ 已保存到本地</small>}{item.saveError && <small className="save-failed">保存失败</small>}<div><button onClick={() => useForEdit(item)}>编辑</button><button onClick={() => download(item)}>下载 ↓</button></div></div>
            </article>)}</div></div>
          })}
          {results.some(item => !item.commerceCategory) && <div className="result-group"><div className="result-group-title"><h3>{mode === 'edit' ? '图片编辑' : '文字生图'}</h3><span>{results.filter(item => !item.commerceCategory).length} 张</span></div><div className="gallery">{results.filter(item => !item.commerceCategory).map(item => <article key={item.id}>
            <img src={item.src} alt={item.prompt} /><div className="card-info"><p>{item.prompt}</p>{item.savedPath && <small className="saved-mark">✓ 已保存到本地</small>}{item.saveError && <small className="save-failed">保存失败</small>}<div><button onClick={() => useForEdit(item)}>编辑</button><button onClick={() => download(item)}>下载 ↓</button></div></div>
          </article>)}</div></div>}
        </>}
      </section>
    </main>

    {billingOpen && <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && setBillingOpen(false)}><div className="modal billing-modal">
      <div className="modal-head"><div><span>SIMULATED BILLING</span><h2>模拟计费</h2></div><button onClick={() => setBillingOpen(false)}>×</button></div>
      <div className="billing-notice"><b>仅供本地模拟</b><p>这里不会发起真实扣款，也不代表模型服务商的实际账单。</p></div>
      <div className="billing-prices">
        <label><span>每张图片价格（元）</span><input type="number" min="0" step="0.01" value={billing.imagePrice} onChange={e => setBilling(old => ({ ...old, imagePrice: Math.max(0, Number(e.target.value) || 0) }))} /></label>
        <label><span>每次文案价格（元）</span><input type="number" min="0" step="0.01" value={billing.copyPrice} onChange={e => setBilling(old => ({ ...old, copyPrice: Math.max(0, Number(e.target.value) || 0) }))} /></label>
      </div>
      <div className="billing-lines">
        <div><span>图片生成</span><small>{billing.imageCount} 张 × ¥{billing.imagePrice.toFixed(2)}</small><b>¥{imageCost.toFixed(2)}</b></div>
        <div><span>文案生成</span><small>{billing.copyCount} 次 × ¥{billing.copyPrice.toFixed(2)}</small><b>¥{copyCost.toFixed(2)}</b></div>
      </div>
      <div className="billing-total"><span>模拟累计费用</span><b>¥{totalCost.toFixed(2)}</b></div>
      <p className="privacy">仅成功返回的图片和文案会计入统计。价格和累计数量保存在当前电脑，不包含 API Key。</p>
      <button className="clear-billing" onClick={() => { if (window.confirm('确定清空模拟计费记录吗？价格设置将保留。')) setBilling(old => ({ ...old, imageCount: 0, copyCount: 0 })) }}>清空计费记录</button>
    </div></div>}

    {settingsOpen && <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && setSettingsOpen(false)}><div className="modal">
      <div className="modal-head"><div><span>CONNECTION</span><h2>接口设置</h2></div><button onClick={() => setSettingsOpen(false)}>×</button></div>
      <label><span>NewAPI Base URL</span><input value={settings.baseUrl} onChange={e => setSettings(s => ({ ...s, baseUrl: e.target.value }))} placeholder="http://localhost:3000/v1" /></label>
      <label><span>API Key</span><input type="password" value={settings.apiKey} onChange={e => setSettings(s => ({ ...s, apiKey: e.target.value }))} placeholder="sk-..." /></label>
      <label><span>图片模型</span><input value={settings.model} onChange={e => { setSettings(s => ({ ...s, model: e.target.value })); setTestResult(null) }} placeholder="image-2" /></label>
      <label><span>文案分析模型</span><input value={settings.copyModel || ''} onChange={e => setSettings(s => ({ ...s, copyModel: e.target.value }))} placeholder="gpt-5.6" /></label>
      <label><span>返回格式</span><select value={settings.format} onChange={e => setSettings(s => ({ ...s, format: e.target.value }))}><option value="url">URL</option><option value="b64_json">Base64（更适合本地）</option></select></label>
      <div className="storage-settings">
        <div><span>数据保存</span><b>生成图片自动保存到本地</b></div>
        <label className="autosave-toggle"><input type="checkbox" checked={Boolean(settings.autoSave)} onChange={e => setSettings(s => ({ ...s, autoSave: e.target.checked }))} /><span>{settings.autoSave ? '已开启自动保存' : '未开启自动保存'}</span></label>
        <div className="directory-picker"><input value={settings.saveDirectory || ''} onChange={e => setSettings(s => ({ ...s, saveDirectory: e.target.value }))} placeholder="例如：D:\\电商图片" /><button type="button" onClick={chooseSaveDirectory} disabled={selectingDirectory}>{selectingDirectory ? '正在选择…' : '选择文件夹'}</button></div>
        <small>点击“选择文件夹”可打开系统目录选择器。系统会按文字生图、图片编辑、商品主图、SKU图和商品详情图分别创建子文件夹。</small>
      </div>
      {testResult && <div className={'test-result ' + (testResult.ok && testResult.modelAvailable !== false && testResult.copyModelAvailable !== false ? 'success' : 'warning')}>
        <b>{testResult.ok ? (testResult.modelAvailable === false || testResult.copyModelAvailable === false ? '部分模型不可用' : '测试通过') : '测试失败'}</b>
        <p>{testResult.message}</p>
        {testResult.latency !== undefined && <small>响应时间：{testResult.latency} ms · 接口返回 {testResult.modelsCount} 个模型</small>}
        {testResult.imageModels?.length > 0 && <div className="model-list"><span>可能可用的图片模型：</span>{testResult.imageModels.map(id => <button key={id} onClick={() => setSettings(s => ({ ...s, model: id }))}>{id}</button>)}</div>}
        {testResult.textModels?.length > 0 && <div className="model-list"><span>可用于文案分析的文本模型：</span>{testResult.textModels.map(id => <button key={id} onClick={() => setSettings(s => ({ ...s, copyModel: id }))}>{id}</button>)}</div>}
      </div>}
      <p className="privacy">配置仅保存在当前浏览器的 localStorage，并通过本机服务转发。</p>
      <div className="modal-actions"><button className="test-button" disabled={testing} onClick={testConnection}>{testing ? <span className="ai-thinking"><i />正在连接接口</span> : '测试接口'}</button><button className="save" onClick={() => { setSettingsOpen(false); setError('') }}>保存设置</button></div>
    </div></div>}
  </div>
}

createRoot(document.getElementById('root')).render(<App />)
