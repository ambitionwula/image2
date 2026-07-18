import { useEffect, useRef, useState } from 'react'

const emptyResult = {
  productSummary: '',
  targetAudience: '',
  sellingPoints: [],
  titles: [],
  mainImageCopy: [],
  mainImagePrompt: '',
  sceneImagePrompts: [],
  detailSections: [],
  mainImagePrompts: [],
  skuImagePrompts: [],
  detailImagePrompts: [],
  uncertainties: [],
  analyzedBy: '',
}

const languages = [
  ['zh-CN', '简体中文'], ['zh-TW', '繁體中文'], ['en', 'English'],
  ['ja', '日本語'], ['ko', '한국어'], ['es', 'Español'], ['pt-BR', 'Português (Brasil)'],
  ['fr', 'Français'], ['de', 'Deutsch'], ['it', 'Italiano'], ['nl', 'Nederlands'],
  ['pl', 'Polski'], ['ru', 'Русский'], ['uk', 'Українська'], ['tr', 'Türkçe'],
  ['ar', 'العربية'], ['he', 'עברית'], ['hi', 'हिन्दी'], ['th', 'ไทย'],
  ['vi', 'Tiếng Việt'], ['id', 'Bahasa Indonesia'], ['ms', 'Bahasa Melayu'],
  ['fil', 'Filipino'], ['sv', 'Svenska'], ['da', 'Dansk'], ['no', 'Norsk'],
]

const sizeOptions = ['1024x1024', '1536x1024', '1024x1536', '512x512']
const detailSizeOptions = [
  ['1024x1024', '1024×1024 方图'],
  ['1536x1024', '1536×1024 横图'],
  ['1024x1536', '1024×1536 标准竖图'],
  ['1024x1792', '1024×1792 长竖图（需模型支持）'],
  ['1024x2048', '1024×2048 2:1 长图（需模型支持）'],
  ['1024x2560', '1024×2560 超长图（需模型支持）'],
]

async function readJson(response) {
  const text = await response.text()
  if (!text) throw new Error(`本地服务没有返回内容（HTTP ${response.status}）`)
  try { return JSON.parse(text) } catch { throw new Error(`接口返回内容无法识别（HTTP ${response.status}）`) }
}

export default function EcommercePlanner({ headers, settings, onEditPrompt, onGenerateSet, onPause, generating, progress, onOpenSettings, onCopyGenerated }) {
  const [files, setFiles] = useState([])
  const [productDescription, setProductDescription] = useState('')
  const filesRef = useRef([])
  const [result, setResult] = useState(emptyResult)
  const [counts, setCounts] = useState({ main: 7, sku: 4, detail: 12 })
  const [sizes, setSizes] = useState(() => {
    try { return { main: '1024x1024', sku: '1024x1024', detail: '1024x1536', ...JSON.parse(localStorage.getItem('image-studio-commerce-sizes') || '{}') } }
    catch { return { main: '1024x1024', sku: '1024x1024', detail: '1024x1536' } }
  })
  const [language, setLanguage] = useState(() => localStorage.getItem('image-studio-commerce-language') || 'zh-CN')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const analyzeAbortRef = useRef(null)

  useEffect(() => { filesRef.current = files }, [files])
  useEffect(() => () => {
    analyzeAbortRef.current?.abort()
    filesRef.current.forEach(item => URL.revokeObjectURL(item.url))
  }, [])
  useEffect(() => localStorage.setItem('image-studio-commerce-language', language), [language])
  useEffect(() => localStorage.setItem('image-studio-commerce-sizes', JSON.stringify(sizes)), [sizes])

  function addFiles(fileList) {
    const additions = Array.from(fileList || []).filter(file => file.type.startsWith('image/')).slice(0, Math.max(0, 6 - files.length))
    setFiles(old => [...old, ...additions.map(file => ({ file, url: URL.createObjectURL(file), id: crypto.randomUUID() }))])
  }

  function removeFile(id) {
    setFiles(old => {
      const item = old.find(file => file.id === id)
      if (item) URL.revokeObjectURL(item.url)
      return old.filter(file => file.id !== id)
    })
  }

  async function analyze() {
    if (!settings.baseUrl || !settings.apiKey) { onOpenSettings(); return }
    if (!files.length) return setError('请至少上传一张清晰的商品图片')
    const controller = new AbortController()
    analyzeAbortRef.current = controller
    setRunning(true); setError('')
    try {
      const form = new FormData()
      files.forEach(item => form.append('image', item.file))
      form.append('model', settings.copyModel || 'gpt-5.6')
      form.append('mainCount', String(counts.main))
      form.append('skuCount', String(counts.sku))
      form.append('detailCount', String(counts.detail))
      form.append('mainSize', sizes.main)
      form.append('skuSize', sizes.sku)
      form.append('detailSize', sizes.detail)
      form.append('language', language)
      form.append('productDescription', productDescription.trim())
      const response = await fetch('/api/ecommerce-analyze', { method: 'POST', headers, body: form, signal: controller.signal })
      const data = await readJson(response)
      if (!response.ok) throw new Error(data?.error?.message || '商品分析失败')
      setResult({ ...emptyResult, ...data })
      onCopyGenerated?.()
    } catch (e) {
      setError(e.name === 'AbortError' ? '分析已暂停。再次点击“开始爆款分析”将重新分析，本次不计入模拟费用。' : e.message)
    } finally {
      analyzeAbortRef.current = null
      setRunning(false)
    }
  }

  function pauseAnalysis() {
    analyzeAbortRef.current?.abort()
  }

  function update(key, value) { setResult(old => ({ ...old, [key]: value })) }
  const listText = key => (result[key] || []).join('\n')
  const updateList = (key, value) => update(key, value.split('\n').map(item => item.trim()).filter(Boolean))
  const enrichPrompt = prompt => productDescription.trim()
    ? `【人工确认的商品描述】${productDescription.trim()}。必须保持该商品身份和用途，不得识别或生成成其他品类。\n\n${prompt}`
    : prompt
  const jobs = [
    ...(result.mainImagePrompts || []).map((prompt, index) => ({ category: 'main', label: `商品主图 ${index + 1}`, prompt: enrichPrompt(prompt), language, size: sizes.main })),
    ...(result.skuImagePrompts || []).map((prompt, index) => ({ category: 'sku', label: `SKU 图 ${index + 1}`, prompt: enrichPrompt(prompt), language, size: sizes.sku })),
    ...(result.detailImagePrompts || []).map((prompt, index) => ({
      category: 'detail', label: `详情图 ${index + 1}`, prompt: enrichPrompt(prompt), language, size: sizes.detail,
      includeProduct: !/^\s*【关联元素】/.test(prompt),
    })),
  ].filter(job => job.prompt)

  return <div className="commerce-planner">
    <div className="commerce-intro">
      <div><span>ECOMMERCE COPILOT</span><h2>AI 爆款商品策划</h2><p>只需上传商品图，AI 自动识别品类、人群和消费热点，直接输出卖点、文案与生图方案。</p></div>
      <div className="commerce-intro-actions"><label><span>内容语言</span><select value={language} disabled={running} onChange={e => setLanguage(e.target.value)}>{languages.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><div className="analyze-action">{running ? <button className="pause-analysis" onClick={pauseAnalysis}>Ⅱ 暂停分析</button> : <button className="analyze-button" onClick={analyze}>✦ 开始爆款分析</button>}{running && <div className="analyze-thinking"><span className="ai-thinking"><i />AI 正在思考中</span><small>暂停会取消本次请求，不计入模拟费用</small></div>}</div></div>
    </div>

    <div className="commerce-grid">
      <div className="commerce-inputs">
        <label className="commerce-upload"><input type="file" accept="image/*" multiple onChange={e => { addFiles(e.target.files); e.target.value = '' }} /><b>＋</b><span>上传商品图</span><small>无需填写资料，支持主图、包装和细节图，最多 6 张</small></label>
        {files.length > 0 && <div className="commerce-images">{files.map(item => <div key={item.id}><img src={item.url} alt="商品参考" /><button onClick={() => removeFile(item.id)}>×</button></div>)}</div>}
        <label className="product-description"><span>商品描述（建议填写）</span><textarea value={productDescription} onChange={e => setProductDescription(e.target.value)} maxLength={1000} placeholder="例如：这是一个手持捶背锤，用于日常敲打按摩放松，不是扇子。请补充商品名称、用途、材质或容易被误认的特征。" /><small>人工描述会优先于 AI 的图片猜测，可有效减少品类识别错误。</small></label>
        <div className="image-counts">
          <b>套图数量</b><p>AI 会根据数量规划不同用途和构图，不会简单重复提示词。</p>
          <div>
            <label><span>商品主图</span><input type="number" min="1" max="10" value={counts.main} onChange={e => setCounts(old => ({ ...old, main: Math.max(1, Math.min(10, Number(e.target.value) || 1)) }))} /><small>1–10 张</small></label>
            <label><span>SKU 图</span><input type="number" min="0" max="10" value={counts.sku} onChange={e => setCounts(old => ({ ...old, sku: Math.max(0, Math.min(10, Number(e.target.value) || 0)) }))} /><small>0–10 张</small></label>
            <label><span>详情图</span><input type="number" min="1" max="30" value={counts.detail} onChange={e => setCounts(old => ({ ...old, detail: Math.max(1, Math.min(30, Number(e.target.value) || 1)) }))} /><small>1–30 张</small></label>
          </div>
          <strong>计划生成 {counts.main + counts.sku + counts.detail} 张图片</strong>
        </div>
        <div className="image-sizes">
          <b>套图尺寸</b><p>三类图片可以分别设置，生成和展示会使用对应尺寸。</p>
          <div>{[['main', '商品主图'], ['sku', 'SKU 图'], ['detail', '详情图']].map(([key, label]) => <label key={key}><span>{label}</span><select value={sizes[key]} onChange={e => setSizes(old => ({ ...old, [key]: e.target.value }))}>{key === 'detail' ? detailSizeOptions.map(([value, text]) => <option value={value} key={value}>{text}</option>) : sizeOptions.map(size => <option value={size} key={size}>{size}</option>)}</select></label>)}</div>
          <small className="size-warning">详情图超过 1024×1536 的规格需要当前图片模型支持；系统会按所选尺寸原样提交，不会拉伸生成结果。</small>
        </div>
        <div className="auto-analysis-note"><b>AI 将自动完成</b><p>识别商品与品类 · 推断核心人群 · 挖掘情绪价值与消费热点 · 提炼差异化卖点 · 生成爆款标题 · 规划主图与详情页</p><small>图片中无法确认的材质、参数、功效和认证不会被当作事实。</small></div>
        {error && <div className="commerce-error">{error}</div>}
      </div>

      <div className="commerce-output">
        {!result.productSummary && !running ? <div className="commerce-empty"><b>◇</b><p>分析结果会显示在这里</p><span>建议上传正面、侧面、包装和细节图片</span></div> : <>
          {result.analyzedBy && <div className="analysis-model">本次由 <b>{result.analyzedBy}</b> 完成分析{result.requestedModel && result.requestedModel !== result.analyzedBy ? `（已自动替代不可用的 ${result.requestedModel}）` : ''}</div>}
          <label><span>商品视觉分析</span><textarea value={result.productSummary} onChange={e => update('productSummary', e.target.value)} /></label>
          <label><span>热点人群与购买动机</span><textarea value={result.targetAudience} onChange={e => update('targetAudience', e.target.value)} /></label>
          <label><span>爆款核心卖点（每行一条）</span><textarea value={listText('sellingPoints')} onChange={e => updateList('sellingPoints', e.target.value)} /></label>
          <label><span>高点击标题建议（每行一条）</span><textarea value={listText('titles')} onChange={e => updateList('titles', e.target.value)} /></label>
          <label><span>主图钩子文案（每行一条）</span><textarea value={listText('mainImageCopy')} onChange={e => updateList('mainImageCopy', e.target.value)} /></label>
          <div className="prompt-category main"><div><b>商品主图方案</b><span>{result.mainImagePrompts?.length || 0} 张</span></div><textarea className="detail-editor" value={listText('mainImagePrompts')} onChange={e => updateList('mainImagePrompts', e.target.value)} /></div>
          <div className="prompt-category sku"><div><b>SKU 图方案</b><span>{result.skuImagePrompts?.length || 0} 张</span></div><textarea className="detail-editor" value={listText('skuImagePrompts')} onChange={e => updateList('skuImagePrompts', e.target.value)} /></div>
          <div className="prompt-category detail"><div><b>商品详情图方案</b><span>{result.detailImagePrompts?.length || 0} 张</span></div><textarea className="detail-editor" value={listText('detailImagePrompts')} onChange={e => updateList('detailImagePrompts', e.target.value)} /></div>
          {jobs[0] && <button className="edit-first-prompt" onClick={() => onEditPrompt(files.map(item => item.file), jobs[0].prompt)}>先送第 1 张到图片编辑 →</button>}
          <div className="commerce-workflow">
            <div><b>一键生成并分类归档</b><p>{result.mainImagePrompts?.length || 0} 张主图 · {result.skuImagePrompts?.length || 0} 张 SKU 图 · {result.detailImagePrompts?.length || 0} 张详情图，生成后自动放入对应区域。</p></div>
            <div className="generation-actions">{generating ? <><div className="batch-thinking"><span className="ai-thinking"><i />AI 正在并行生成</span><small>已完成 {progress.done}/{progress.total} 张 · 同时最多 2 张 · 超时自动重试</small></div><button className="pause-generation" onClick={onPause}>Ⅱ 暂停生成</button></> : <button disabled={!jobs.length} onClick={() => onGenerateSet(files.map(item => item.file), jobs)}>✦ 生成 / 继续剩余（{jobs.length} 张）</button>}</div>
          </div>
          {result.uncertainties?.length > 0 && <div className="uncertainties"><b>需要人工确认</b>{result.uncertainties.map((item, index) => <p key={index}>· {item}</p>)}</div>}
        </>}
      </div>
    </div>
  </div>
}
