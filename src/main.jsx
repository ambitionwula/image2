import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import ImageMaskEditor from './ImageMaskEditor'
import './styles.css'

const defaults = {
  baseUrl: 'http://localhost:3000/v1', apiKey: '', model: 'image-2',
  size: '1024x1024', quality: 'standard', format: 'url',
}

const Icon = ({ children }) => <span className="icon">{children}</span>

function getImage(item) {
  if (item?.url) return item.url
  if (item?.b64_json) return `data:image/png;base64,${item.b64_json}`
  return ''
}

function friendlyError(message) {
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
  const [mode, setMode] = useState('generate')
  const [prompt, setPrompt] = useState('')
  const [count, setCount] = useState(1)
  const [sources, setSources] = useState([])
  const [activeSource, setActiveSource] = useState(0)
  const [results, setResults] = useState([])
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [error, setError] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const maskEditorRef = useRef(null)

  useEffect(() => localStorage.setItem('image-studio-settings', JSON.stringify(settings)), [settings])

  const headers = useMemo(() => ({ 'x-base-url': settings.baseUrl, 'x-api-key': settings.apiKey }), [settings])

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
        body: JSON.stringify({ model: settings.model }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data?.error?.message || '接口测试失败')
      setTestResult({
        ...data,
        message: data.modelAvailable === false
          ? `接口可连接，API Key 有效，但当前令牌看不到模型“${settings.model}”。请在 NewAPI 中为令牌所属分组配置该模型渠道，或从下方可用模型中选择。`
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
    setRunning(true); setError(''); setProgress({ done: 0, total: count })
    for (let i = 0; i < count; i++) {
      try {
        let response
        if (mode === 'generate') {
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
        const data = await response.json()
        if (!response.ok) throw new Error(data?.error?.message || '生成失败')
        const additions = (data.data || []).map((item, n) => ({
          id: `${Date.now()}-${i}-${n}`, src: getImage(item), prompt, mode, createdAt: new Date(),
        })).filter(x => x.src)
        if (!additions.length) throw new Error('接口没有返回可识别的图片数据')
        setResults(old => [...additions, ...old])
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

  return <div className="app-shell">
    <header>
      <div className="brand"><div className="brand-mark">造</div><div><b>造像所</b><small>LOCAL IMAGE LAB</small></div></div>
      <button className="ghost" onClick={() => setSettingsOpen(true)}><Icon>⚙</Icon> 接口设置</button>
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

        <div className="prompt-wrap">
          <textarea value={prompt} onChange={e => setPrompt(e.target.value)} placeholder={mode === 'generate' ? '描述你想创造的画面，例如：雨后的东京街头，霓虹倒映在湿润路面，电影感摄影……' : '描述想如何修改，例如：把天空改成绚丽晚霞，保持人物和构图不变……'} />
          <span className="char-count">{prompt.length}</span>
        </div>

        <div className="controls">
          <label><span>画面尺寸</span><select value={settings.size} onChange={e => setSettings(s => ({ ...s, size: e.target.value }))}><option>1024x1024</option><option>1536x1024</option><option>1024x1536</option><option>512x512</option></select></label>
          <label><span>生成数量</span><select value={count} onChange={e => setCount(Number(e.target.value))}>{[1,2,3,4,5,6,8,10].map(n => <option key={n} value={n}>{n} 张（依次）</option>)}</select></label>
          <label><span>质量</span><select value={settings.quality} onChange={e => setSettings(s => ({ ...s, quality: e.target.value }))}><option value="standard">标准</option><option value="hd">高清</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
          <button className="create" disabled={running} onClick={run}>{running ? `生成中 ${progress.done}/${progress.total}` : <><Icon>✦</Icon>{mode === 'generate' ? '开始创造' : '开始编辑'}</>}</button>
        </div>
        {error && <div className="error">{error}</div>}
      </section>

      <section className="gallery-section">
        <div className="section-title"><div><span>YOUR CREATIONS</span><h2>创作记录</h2></div>{results.length > 0 && <button className="text-btn" onClick={() => setResults([])}>清空记录</button>}</div>
        {results.length === 0 ? <div className="empty"><div>◇</div><p>灵感正在等待发生</p><span>生成的作品会出现在这里</span></div> : <div className="gallery">{results.map(item => <article key={item.id}>
          <img src={item.src} alt={item.prompt} />
          <div className="card-info"><p>{item.prompt}</p><div><button onClick={() => useForEdit(item)}>编辑</button><button onClick={() => download(item)}>下载 ↓</button></div></div>
        </article>)}</div>}
      </section>
    </main>

    {settingsOpen && <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && setSettingsOpen(false)}><div className="modal">
      <div className="modal-head"><div><span>CONNECTION</span><h2>接口设置</h2></div><button onClick={() => setSettingsOpen(false)}>×</button></div>
      <label><span>NewAPI Base URL</span><input value={settings.baseUrl} onChange={e => setSettings(s => ({ ...s, baseUrl: e.target.value }))} placeholder="http://localhost:3000/v1" /></label>
      <label><span>API Key</span><input type="password" value={settings.apiKey} onChange={e => setSettings(s => ({ ...s, apiKey: e.target.value }))} placeholder="sk-..." /></label>
      <label><span>图片模型</span><input value={settings.model} onChange={e => { setSettings(s => ({ ...s, model: e.target.value })); setTestResult(null) }} placeholder="image-2" /></label>
      <label><span>返回格式</span><select value={settings.format} onChange={e => setSettings(s => ({ ...s, format: e.target.value }))}><option value="url">URL</option><option value="b64_json">Base64（更适合本地）</option></select></label>
      {testResult && <div className={'test-result ' + (testResult.ok && testResult.modelAvailable !== false ? 'success' : 'warning')}>
        <b>{testResult.ok ? (testResult.modelAvailable === false ? '模型不可用' : '测试通过') : '测试失败'}</b>
        <p>{testResult.message}</p>
        {testResult.latency !== undefined && <small>响应时间：{testResult.latency} ms · 接口返回 {testResult.modelsCount} 个模型</small>}
        {testResult.imageModels?.length > 0 && <div className="model-list"><span>可能可用的图片模型：</span>{testResult.imageModels.map(id => <button key={id} onClick={() => setSettings(s => ({ ...s, model: id }))}>{id}</button>)}</div>}
      </div>}
      <p className="privacy">配置仅保存在当前浏览器的 localStorage，并通过本机服务转发。</p>
      <div className="modal-actions"><button className="test-button" disabled={testing} onClick={testConnection}>{testing ? '正在测试…' : '测试接口'}</button><button className="save" onClick={() => { setSettingsOpen(false); setError('') }}>保存设置</button></div>
    </div></div>}
  </div>
}

createRoot(document.getElementById('root')).render(<App />)
