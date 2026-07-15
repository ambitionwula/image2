import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'

const ImageMaskEditor = forwardRef(function ImageMaskEditor({ item }, ref) {
  const canvasRef = useRef(null)
  const imageRef = useRef(null)
  const [brushSize, setBrushSize] = useState(42)
  const [strokes, setStrokes] = useState([])
  const [drawing, setDrawing] = useState(false)
  const currentStroke = useRef(null)

  useEffect(() => {
    setStrokes([])
    if (!item) return
    const img = new Image()
    img.onload = () => { imageRef.current = img; draw(null, []) }
    img.src = item.url
  }, [item?.id])

  useEffect(() => { draw() }, [strokes, brushSize])

  function dimensions() {
    const img = imageRef.current
    if (!img) return null
    const maxWidth = 1040
    const maxHeight = 480
    const scale = Math.min(maxWidth / img.naturalWidth, maxHeight / img.naturalHeight, 1)
    return { width: Math.round(img.naturalWidth * scale), height: Math.round(img.naturalHeight * scale), naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight }
  }

  function draw(extraStroke = null, savedStrokes = strokes) {
    const canvas = canvasRef.current
    const img = imageRef.current
    const dims = dimensions()
    if (!canvas || !img || !dims) return
    canvas.width = dims.width
    canvas.height = dims.height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0, dims.width, dims.height)
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    for (const stroke of [...savedStrokes, ...(extraStroke ? [extraStroke] : [])]) {
      if (!stroke?.points?.length) continue
      ctx.strokeStyle = 'rgba(221, 67, 45, .58)'
      ctx.fillStyle = 'rgba(221, 67, 45, .58)'
      ctx.lineWidth = stroke.size
      ctx.beginPath()
      ctx.arc(stroke.points[0].x, stroke.points[0].y, stroke.size / 2, 0, Math.PI * 2)
      ctx.fill()
      ctx.beginPath(); ctx.moveTo(stroke.points[0].x, stroke.points[0].y)
      stroke.points.slice(1).forEach(p => ctx.lineTo(p.x, p.y))
      ctx.stroke()
    }
  }

  function point(e) {
    const rect = canvasRef.current.getBoundingClientRect()
    return { x: (e.clientX - rect.left) * canvasRef.current.width / rect.width, y: (e.clientY - rect.top) * canvasRef.current.height / rect.height }
  }

  function start(e) {
    e.currentTarget.setPointerCapture(e.pointerId)
    currentStroke.current = { size: brushSize, points: [point(e)] }
    setDrawing(true); draw(currentStroke.current)
  }
  function move(e) {
    if (!drawing || !currentStroke.current) return
    currentStroke.current.points.push(point(e)); draw(currentStroke.current)
  }
  function end() {
    if (!currentStroke.current) return
    const completedStroke = currentStroke.current
    setStrokes(old => [...old, completedStroke])
    currentStroke.current = null; setDrawing(false)
  }

  useImperativeHandle(ref, () => ({
    hasMask: () => strokes.length > 0,
    async getMask() {
      if (!strokes.length || !imageRef.current) return null
      const img = imageRef.current
      const visible = canvasRef.current
      const mask = document.createElement('canvas')
      mask.width = img.naturalWidth; mask.height = img.naturalHeight
      const ctx = mask.getContext('2d')
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, mask.width, mask.height)
      ctx.globalCompositeOperation = 'destination-out'
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'
      const sx = mask.width / visible.width, sy = mask.height / visible.height
      for (const stroke of strokes) {
        if (!stroke?.points?.length) continue
        const size = stroke.size * Math.max(sx, sy)
        ctx.lineWidth = size
        const first = stroke.points[0]
        ctx.beginPath(); ctx.arc(first.x * sx, first.y * sy, size / 2, 0, Math.PI * 2); ctx.fill()
        ctx.beginPath(); ctx.moveTo(first.x * sx, first.y * sy)
        stroke.points.slice(1).forEach(p => ctx.lineTo(p.x * sx, p.y * sy)); ctx.stroke()
      }
      return new Promise(resolve => mask.toBlob(resolve, 'image/png'))
    },
  }), [strokes])

  if (!item) return null
  return <div className="mask-editor">
    <div className="editor-toolbar">
      <div><b>局部编辑画笔</b><span>涂红需要修改的区域；不涂抹则编辑整张图片</span></div>
      <label>画笔大小 <input type="range" min="10" max="140" value={brushSize} onChange={e => setBrushSize(Number(e.target.value))} /><strong>{brushSize}</strong></label>
      <button disabled={!strokes.length} onClick={() => setStrokes(s => s.slice(0, -1))}>撤销</button>
      <button disabled={!strokes.length} onClick={() => setStrokes([])}>清空</button>
    </div>
    <div className="canvas-stage"><canvas ref={canvasRef} onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} /></div>
  </div>
})

export default ImageMaskEditor
