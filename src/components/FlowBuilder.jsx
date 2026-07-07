import { useState, useRef, useEffect, useMemo } from 'react'
import { useStore } from '../store'
import { computeExecutionOrder } from '../flowUtils'
import { Button, MethodBadge, Modal } from './ui'
import styles from './FlowBuilder.module.css'

const NODE_W    = 292
const PORT_IN_Y = 52   // input port y-offset from node top (SVG anchor)
const PORT_OK_Y = 72   // success port y-offset

// ── Shared utilities (used by FlowBuilder + SidePanel) ────────────
function getResponseKeys(api) {
  const fromSchema = Object.keys(api.response || {})
  if (fromSchema.length > 0) return fromSchema
  const ex = api.responseExample
  if (ex && typeof ex === 'object' && !Array.isArray(ex)) return Object.keys(ex)
  return []
}

function flattenObject(obj, prefix = '', depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 3) return {}
  const result = {}
  // 배열은 첫 요소를 인덱스 0 으로 펼침 → rows.0._id 형태로 바인딩 가능
  const entries = Array.isArray(obj) ? (obj.length ? [['0', obj[0]]] : []) : Object.entries(obj)
  for (const [k, v] of entries) {
    const key = prefix ? `${prefix}.${k}` : k
    result[key] = v
    if (v && typeof v === 'object' && depth < 3)
      Object.assign(result, flattenObject(v, key, depth + 1))
  }
  return result
}

function formatPreviewVal(v) {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'object') return Array.isArray(v) ? `[…${v.length}]` : '{…}'
  const s = String(v)
  return s.length > 28 ? s.slice(0, 28) + '…' : s
}

// ── Auto-mapping ───────────────────────────────────────────────────
function scoreMatch(inputKey, candidatePath, stepName = '') {
  const leaf = candidatePath.split('.').at(-1) || candidatePath
  const iLow = inputKey.toLowerCase()
  const lLow = leaf.toLowerCase()
  let score = 0
  if (iLow === lLow) score += 100                               // 완전 일치 (leaf)
  else if (iLow === candidatePath.toLowerCase()) score += 90   // full path 일치
  else if (iLow.includes(lLow) || lLow.includes(iLow)) score += 50 // 포함 관계
  if (inputKey.endsWith('Id') && leaf.endsWith('Id')) score += 30  // Id suffix
  if (stepName.toLowerCase().includes('create') && iLow.includes('id')) score += 10
  return score
}

function computeAutoMappings(params, execOrder, selectedExecIdx, getApiById, lastRunResponses) {
  if (!selectedExecIdx) return []
  const results = []
  for (let pi = 0; pi < params.length; pi++) {
    const p = params[pi]
    if (p.binding) continue
    const scored = []
    for (let ei = 0; ei < selectedExecIdx; ei++) {
      const s = execOrder[ei]
      if (s.type === 'header-config') continue
      const info = getApiById(s.aid)
      if (!info) continue
      const run = lastRunResponses?.[s.id]
      const keys = run?.body ? Object.keys(flattenObject(run.body)) : getResponseKeys(info.api)
      for (const key of keys) {
        const sc = scoreMatch(p.key, key, info.api.name)
        if (sc > 0) scored.push({ label: `step${ei + 1}.${key}`, score: sc })
      }
    }
    scored.sort((a, b) => b.score - a.score)
    const best = scored[0] ?? null
    results.push({
      paramIdx: pi,
      paramKey: p.key,
      best,
      suggestions: scored.slice(0, 3),
      autoApply: !!best && best.score > 70,
    })
  }
  return results
}

export default function FlowBuilder({ onRun }) {
  const {
    modules, flowSteps, flowName, connections,
    setFlowName, addFlowStep, removeFlowStep,
    addConnection, removeConnection,
    updateParam, bindParam,
    toggleParamArrayMode, addParamArrayItem, removeParamArrayItem, updateParamArrayItem, bindParamArrayItem,
    addStepHeader, removeStepHeader, updateStepHeader, bindStepHeader, toggleExcludeHeader,
    updateBodyMode, updateBodyRaw, updateStepPos,
    addHeaderConfigStep,
    addHeaderConfigEntry, addHeaderConfigEntryWith, removeHeaderConfigEntry, updateHeaderConfigEntry, bindHeaderConfigEntry,
    clearFlow, importFlow, pasteFlowStep, getApiById,
    apiPresets, saveApiPreset, updateApiPreset, deleteApiPreset, loadApiPreset, lastUsedPresetId,
    lastRunResponses,
  } = useStore()

  const [selectedId, setSelectedId]     = useState(null)
  const [panelTab, setPanelTab]         = useState('params')
  const [filterModule, setFilterModule] = useState('all')
  const [searchQuery, setSearchQuery]   = useState('')
  const [expandedLibGroups, setExpandedLibGroups] = useState({}) // API 라이브러리 태그 그룹 접기 상태
  const [bindModal, setBindModal]       = useState(null)
  const [hbStep, setHbStep]             = useState(1)
  const [hbName, setHbName]             = useState('')
  const [bbStep, setBbStep]             = useState(1)
  const [bbField, setBbField]           = useState('')
  const [dragOver, setDragOver]         = useState(false)
  const [dragConn, setDragConn]         = useState(null) // {fromId, fromX, fromY, curX, curY}
  const [importOpen, setImportOpen]     = useState(false)
  const [importTab, setImportTab]       = useState('form')  // 'form' | 'json'
  const [importText, setImportText]     = useState('')
  const [importErrors, setImportErrors] = useState([])
  const [formName, setFormName]         = useState('')
  const [formSteps, setFormSteps]       = useState([{ id: 0, api: '', save: [], use: [] }])

  const canvasRef    = useRef(null)
  const hoverPortRef = useRef(null) // step.id of the port_in being hovered during conn drag
  const hoverOutPortRef = useRef(null) // step.id of the port_out being hovered during backward drag
  const clipboardRef = useRef(null) // copied step snapshot

  // Migrate old steps without x/y
  useEffect(() => {
    flowSteps.forEach((step, idx) => {
      if (step.x === undefined) updateStepPos(step.id, 80, 60 + idx * 300)
    })
  }, []) // eslint-disable-line

  // ── Copy / Paste shortcut ─────────────────────────────────────────
  useEffect(() => {
    function onKeyDown(e) {
      const isMod = e.metaKey || e.ctrlKey
      if (!isMod) return
      // 입력 필드에 포커스가 있으면 기본 동작 허용
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      if (e.key === 'c' && selectedId) {
        const step = flowSteps.find(s => s.id === selectedId)
        if (step) {
          clipboardRef.current = JSON.parse(JSON.stringify(step)) // deep copy
          e.preventDefault()
        }
      }
      if (e.key === 'v' && clipboardRef.current) {
        e.preventDefault()
        pasteFlowStep(clipboardRef.current)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedId, flowSteps, pasteFlowStep])

  // ── Execution order ───────────────────────────────────────────────
  const execOrder = useMemo(() => computeExecutionOrder(flowSteps, connections), [flowSteps, connections])
  const execPos   = useMemo(() => {
    const m = {}
    execOrder.forEach((s, i) => { m[s.id] = i + 1 })
    return m
  }, [execOrder])

  // ── Derived selection state ───────────────────────────────────────
  const selStep      = selectedId ? flowSteps.find(s => s.id === selectedId) ?? null : null
  const selectedIdx  = selStep ? flowSteps.indexOf(selStep) : null            // array idx (for store calls)
  const selectedExecIdx = selStep && execPos[selStep.id] != null ? execPos[selStep.id] - 1 : null // 0-indexed exec pos
  const selInfo      = selStep ? getApiById(selStep.aid) : null

  // ── Library filter ────────────────────────────────────────────────
  const filteredModules = modules
    .filter(m => filterModule === 'all' || m.id === filterModule)
    .map(m => ({
      ...m,
      apis: searchQuery.trim()
        ? m.apis.filter(a =>
            a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            a.path.toLowerCase().includes(searchQuery.toLowerCase()))
        : m.apis,
    }))
    .filter(m => m.apis.length > 0)

  // ── Drag from library ─────────────────────────────────────────────
  function onChipDragStart(e, mid, aid) {
    e.dataTransfer.effectAllowed = 'copy'
    e.dataTransfer.setData('chip', JSON.stringify({ mid, aid }))
  }

  function onCanvasDrop(e) {
    e.preventDefault()
    setDragOver(false)
    const rect = canvasRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left + canvasRef.current.scrollLeft - NODE_W / 2
    const y = e.clientY - rect.top  + canvasRef.current.scrollTop  - 55

    if (e.dataTransfer.getData('hconfig')) {
      addHeaderConfigStep(Math.max(16, x), Math.max(16, y))
      return
    }
    const raw = e.dataTransfer.getData('chip')
    if (!raw) return
    const { mid, aid } = JSON.parse(raw)
    addFlowStep(mid, aid, Math.max(16, x), Math.max(16, y))
  }

  // ── Node drag to reposition ───────────────────────────────────────
  function handleNodeMove(ev, step, sx, sy, smx, smy) {
    const isTouch = ev.type.startsWith('touch')
    const clientX = isTouch ? ev.touches[0].clientX : ev.clientX
    const clientY = isTouch ? ev.touches[0].clientY : ev.clientY
    updateStepPos(step.id, Math.max(0, sx + clientX - smx), Math.max(0, sy + clientY - smy))
  }

  function onNodeHeaderDown(e, step) {
    if (e.type === 'mousedown' && e.button !== 0) return
    if (e.cancelable) e.preventDefault()
    e.stopPropagation()

    const isTouch = e.type === 'touchstart'
    const sx = step.x ?? 80, sy = step.y ?? 80
    const smx = isTouch ? e.touches[0].clientX : e.clientX
    const smy = isTouch ? e.touches[0].clientY : e.clientY

    const move = ev => handleNodeMove(ev, step, sx, sy, smx, smy)
    const up   = ()  => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      window.removeEventListener('touchmove', move)
      window.removeEventListener('touchend', up)
    }
    window.addEventListener(isTouch ? 'touchmove' : 'mousemove', move, { passive: false })
    window.addEventListener(isTouch ? 'touchend' : 'mouseup', up)
  }

  // ── Connection port drag ──────────────────────────────────────────
  function onPortOutDown(e, step) {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const rect = canvasRef.current.getBoundingClientRect()
    const fromX = (step.x ?? 0) + NODE_W
    const fromY = (step.y ?? 0) + PORT_OK_Y
    setDragConn({
      fromId: step.id, fromSide: 'out', fromX, fromY,
      curX: e.clientX - rect.left + canvasRef.current.scrollLeft,
      curY: e.clientY - rect.top  + canvasRef.current.scrollTop,
    })
    const move = ev => {
      const r = canvasRef.current.getBoundingClientRect()
      const isTouch = ev.type.startsWith('touch')
      const clientX = isTouch ? ev.touches[0].clientX : ev.clientX
      const clientY = isTouch ? ev.touches[0].clientY : ev.clientY
      setDragConn(d => d ? {
        ...d,
        curX: clientX - r.left + canvasRef.current.scrollLeft,
        curY: clientY - r.top  + canvasRef.current.scrollTop,
      } : null)
    }
    const up = (ev) => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      window.removeEventListener('touchmove', move)
      window.removeEventListener('touchend', up)

      const toId = hoverPortRef.current
      if (toId && toId !== step.id) {
        addConnection(step.id, toId)
      } else {
        // Fallback: If dropped on a node (not exactly on a port), try to connect to that node
        const r = canvasRef.current.getBoundingClientRect()
        const isTouch = ev.type?.startsWith('touch')
        const clientX = isTouch ? ev.changedTouches[0].clientX : ev.clientX
        const clientY = isTouch ? ev.changedTouches[0].clientY : ev.clientY
        const el = document.elementFromPoint(clientX, clientY)
        const nodeEl = el?.closest('.' + styles.node)
        if (nodeEl) {
          // This is a bit hacky but works for small projects: find node by index or something
          // Or just rely on hoverPortRef being set by the node's hover handlers
          // (Actually, the node itself should have onMouseEnter for the whole node during drag)
        }
      }

      hoverPortRef.current = null
      setDragConn(null)
    }
    window.addEventListener(e.type === 'touchstart' ? 'touchmove' : 'mousemove', move, { passive: false })
    window.addEventListener(e.type === 'touchstart' ? 'touchend' : 'mouseup', up)
  }

  function onPortInDown(e, step) {
    if (e.type === 'mousedown' && e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const rect = canvasRef.current.getBoundingClientRect()
    const isTouch = e.type === 'touchstart'
    const startX = isTouch ? e.touches[0].clientX : e.clientX
    const startY = isTouch ? e.touches[0].clientY : e.clientY

    const fromX = (step.x ?? 0)
    const fromY = (step.y ?? 0) + PORT_IN_Y
    setDragConn({
      fromId: step.id, fromSide: 'in', fromX, fromY,
      curX: startX - rect.left + canvasRef.current.scrollLeft,
      curY: startY - rect.top  + canvasRef.current.scrollTop,
    })
    const move = ev => {
      const r = canvasRef.current.getBoundingClientRect()
      const isTe = ev.type.startsWith('touch')
      const clientX = isTe ? ev.touches[0].clientX : ev.clientX
      const clientY = isTe ? ev.touches[0].clientY : ev.clientY
      setDragConn(d => d ? {
        ...d,
        curX: clientX - r.left + canvasRef.current.scrollLeft,
        curY: clientY - r.top  + canvasRef.current.scrollTop,
      } : null)
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      window.removeEventListener('touchmove', move)
      window.removeEventListener('touchend', up)

      const outId = hoverOutPortRef.current
      if (outId && outId !== step.id) addConnection(outId, step.id)
      hoverOutPortRef.current = null
      setDragConn(null)
    }
    window.addEventListener(isTouch ? 'touchmove' : 'mousemove', move, { passive: false })
    window.addEventListener(isTouch ? 'touchend' : 'mouseup', up)
  }

  // ── Bind modal ────────────────────────────────────────────────────
  function openBind(type, paramIdx, opts = {}) {
    if (!selStep || selectedExecIdx === null) return
    // Default header-bind step: last API step before this one in exec order
    let defaultStep = 1
    for (let i = selectedExecIdx - 1; i >= 0; i--) {
      if (execOrder[i].type !== 'header-config') { defaultStep = i + 1; break }
    }
    setHbStep(defaultStep)
    setBbStep(defaultStep)
    if (type === 'hconfig') setHbName(selStep.headers?.[paramIdx]?.key || '')
    else setHbName('')
    setBbField('')
    setBindModal({ stepArrayIdx: selectedIdx, stepExecIdx: selectedExecIdx, type, idx: paramIdx, ...opts })
  }

  function applyBind(fromExecIdx, key) {
    if (!bindModal) return
    const label = `step${fromExecIdx + 1}.${key}`
    if (bindModal.type === 'header') {
      bindStepHeader(bindModal.stepArrayIdx, bindModal.idx, label)
    } else if (bindModal.type === 'hconfig') {
      const hcStep = execOrder[bindModal.stepExecIdx]
      const entry = hcStep?.headers?.[bindModal.idx]
      const existingVal = entry?.binding ? '' : (entry?.val || '')
      if (existingVal.trim()) {
        updateHeaderConfigEntry(hcStep.id, bindModal.idx, 'val', `${existingVal}{${label}}`)
      } else {
        bindHeaderConfigEntry(hcStep.id, bindModal.idx, label)
      }
    } else if (bindModal.itemIdx !== undefined) {
      bindParamArrayItem(bindModal.stepArrayIdx, bindModal.idx, bindModal.itemIdx, label)
    } else {
      bindParam(bindModal.stepArrayIdx, bindModal.idx, label)
    }
    setBindModal(null)
  }

  function applyHeaderBind() {
    if (!bindModal || !hbName.trim()) return
    applyBind(hbStep - 1, `header.${hbName.trim()}`)
    setBindModal(null)
  }

  function applyBodyBind() {
    if (!bindModal || !bbField.trim()) return
    applyBind(bbStep - 1, bbField.trim())
    setBindModal(null)
  }

  // 현재 param 값에 {stepN.field} 템플릿을 삽입 (전체 대체 아닌 추가)
  function applyTemplateInsert(fromExecIdx, key) {
    if (!bindModal) return
    const token = `{step${fromExecIdx + 1}.${key}}`
    
    if (bindModal.type === 'hconfig') {
      const hcStep = execOrder[bindModal.stepExecIdx]
      const entry = hcStep?.headers?.[bindModal.idx]
      const cur = entry?.binding ? '' : (entry?.val || '')
      updateHeaderConfigEntry(hcStep.id, bindModal.idx, 'val', cur ? cur + token : token)
    } else if (bindModal.type === 'header') {
      const step = flowSteps[bindModal.stepArrayIdx]
      const cur = step.reqHeaders?.[bindModal.idx]?.val ?? ''
      updateStepHeader(bindModal.stepArrayIdx, bindModal.idx, 'val', cur ? cur + token : token)
    } else {
      const step = flowSteps[bindModal.stepArrayIdx]
      const cur = step.params?.[bindModal.idx]?.val ?? ''
      updateParam(bindModal.stepArrayIdx, bindModal.idx, cur ? cur + token : token)
    }
    setBindModal(null)
  }

  const bindStep = bindModal ? execOrder[bindModal.stepExecIdx] : null
  const bindPrevExecSteps = bindModal ? execOrder.slice(0, bindModal.stepExecIdx) : []
  // API 스텝만 (header-config 제외), execIdx 포함
  const bindApiSteps = bindPrevExecSteps
    .map((s, execIdx) => ({ step: s, execIdx }))
    .filter(({ step }) => step.type !== 'header-config')

  // ── SVG connections ───────────────────────────────────────────────
  const svgConnections = connections.map(c => {
    const from = flowSteps.find(s => s.id === c.fromId)
    const to   = flowSteps.find(s => s.id === c.toId)
    if (!from || !to) return null
    const x1 = (from.x ?? 0) + NODE_W, y1 = (from.y ?? 0) + PORT_OK_Y
    const x2 =  to.x   ?? 0,           y2 = (to.y   ?? 0) + PORT_IN_Y
    const cx = (x1 + x2) / 2
    return { id: c.id, d: `M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}` }
  }).filter(Boolean)

  return (
    <div className={styles.page}>
      {/* ── Topbar ── */}
      <div className={styles.topbar}>
        <div className={styles.topbar_left}>
          <div>
            <div className={styles.title}>플로우 빌더</div>
            <div className={styles.sub}>API를 캔버스에 드래그 · 포트 드래그로 연결</div>
          </div>
          <input
            className={styles.flow_name}
            value={flowName}
            onChange={e => setFlowName(e.target.value)}
            placeholder="플로우 이름..."
          />
        </div>
        <div className={styles.topbar_actions}>
          <Button size="sm" onClick={() => { setImportTab('form'); setFormName(''); setFormSteps([{ id: 0, api: '', save: [], use: [] }]); setImportText(''); setImportErrors([]); setImportOpen(true) }}>
            <ImportIcon /> 가져오기
          </Button>
          <Button size="sm" onClick={clearFlow}>초기화</Button>
          <Button size="sm" variant="success" onClick={onRun}>
            <PlayIcon /> 실행
          </Button>
        </div>
      </div>

      <div className={styles.body}>
        {/* ── Library ── */}
        <div className={styles.library}>
          <div className={styles.lib_title}>유틸리티</div>
          <div
            className={styles.lib_hconfig_item}
            draggable
            onDragStart={e => {
              e.dataTransfer.effectAllowed = 'copy'
              e.dataTransfer.setData('hconfig', 'true')
            }}
          >
            <ConfigIcon />
            <div className={styles.lib_info}>
              <div className={styles.lib_name}>헤더 설정 박스</div>
              <div className={styles.lib_path}>공통 헤더 주입</div>
            </div>
          </div>
          <div className={styles.lib_divider} />
          <div className={styles.lib_title}>API 라이브러리</div>
          <div className={styles.lib_search_bar}>
            <select className={styles.lib_mod_sel} value={filterModule} onChange={e => setFilterModule(e.target.value)}>
              <option value="all">전체 모듈</option>
              {modules.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            <div className={styles.lib_search_wrap}>
              <SearchIcon />
              <input
                className={styles.lib_search_input}
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="API명, 경로 검색"
              />
              {searchQuery && <button className={styles.lib_search_clear} onClick={() => setSearchQuery('')}>×</button>}
            </div>
          </div>
          {filteredModules.length === 0 && <div className={styles.lib_empty}>검색 결과 없음</div>}
          {filteredModules.map(mod => {
            // swagger 태그별로 그룹핑
            const groups = {}
            mod.apis.forEach(api => {
              const tag = api.tags?.[0] || '기타'
              ;(groups[tag] || (groups[tag] = [])).push(api)
            })
            const searching = !!searchQuery.trim()
            return (
              <div key={mod.id} className={styles.lib_section}>
                <div className={styles.lib_mod_label}>{mod.name}</div>
                {Object.entries(groups).map(([tag, apis]) => {
                  const gkey = mod.id + '|' + tag
                  const open = searching || !!expandedLibGroups[gkey] // 검색 중엔 자동 펼침
                  const desc = mod.tagMeta?.[tag]
                  return (
                    <div key={tag}>
                      <div
                        onClick={() => setExpandedLibGroups(p => ({ ...p, [gkey]: !p[gkey] }))}
                        title={desc || tag}
                        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--text2)', userSelect: 'none' }}
                      >
                        <span style={{ fontSize: 9, color: 'var(--text3)', width: 10 }}>{open ? '▼' : '▶'}</span>
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tag}</span>
                        <span style={{ fontSize: 11, color: 'var(--text3)', background: 'var(--sand)', borderRadius: 8, padding: '0 6px' }}>{apis.length}</span>
                      </div>
                      {open && apis.map(api => (
                        <div key={api.id} className={styles.lib_item} draggable onDragStart={e => onChipDragStart(e, mod.id, api.id)}>
                          <MethodBadge method={api.method} />
                          <div className={styles.lib_info}>
                            <div className={styles.lib_name}>{api.name}</div>
                            <div className={styles.lib_path}>{api.path}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>

        {/* ── Canvas ── */}
        <div
          className={[styles.canvas_wrap, dragOver ? styles.canvas_over : ''].join(' ')}
          ref={canvasRef}
          onDragOver={e => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onCanvasDrop}
          onClick={() => setSelectedId(null)}
        >
          <div className={styles.canvas_inner}>
            {/* SVG layer */}
            <svg className={styles.conn_svg}>
              <defs>
                <marker id="arrowOk" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
                  <path d="M0,0 L7,3.5 L0,7 Z" fill="var(--green)" opacity="0.8" />
                </marker>
              </defs>

              {/* Explicit connections — click to delete */}
              {svgConnections.map(p => (
                <g key={p.id}
                  onClick={e => { e.stopPropagation(); removeConnection(p.id) }}
                  className={styles.conn_group}
                >
                  {/* Wide transparent hit area */}
                  <path d={p.d} fill="none" stroke="transparent" strokeWidth="16" style={{ cursor: 'pointer' }} />
                  {/* Visible line */}
                  <path d={p.d} fill="none"
                    stroke="var(--green)" strokeWidth="2" strokeOpacity="0.75"
                    markerEnd="url(#arrowOk)"
                    style={{ pointerEvents: 'none' }}
                  />
                </g>
              ))}

              {/* Drag-in-progress preview */}
              {dragConn && (() => {
                const cx = (dragConn.fromX + dragConn.curX) / 2
                return (
                  <path
                    d={`M${dragConn.fromX},${dragConn.fromY} C${cx},${dragConn.fromY} ${cx},${dragConn.curY} ${dragConn.curX},${dragConn.curY}`}
                    fill="none" stroke="var(--green)" strokeWidth="2"
                    strokeDasharray="7 4" strokeOpacity="0.55"
                    style={{ pointerEvents: 'none' }}
                  />
                )
              })()}
            </svg>

            {flowSteps.length === 0 && (
              <div className={styles.canvas_empty}>
                <EmptyIcon />
                <span>왼쪽에서 API를 드래그하세요</span>
              </div>
            )}

            {flowSteps.map((step, idx) => {
              const stepNum = execPos[step.id] ?? (idx + 1)
              if (step.type === 'header-config') {
                return (
                  <HeaderConfigNode
                    key={step.id}
                    step={step}
                    stepNum={stepNum}
                    selected={selectedId === step.id}
                    onClick={e => { e.stopPropagation(); setSelectedId(step.id) }}
                    onRemove={e => { e.stopPropagation(); removeFlowStep(idx); if (selectedId === step.id) setSelectedId(null) }}
                    onHeaderDown={e => onNodeHeaderDown(e, step)}
                    onTouchStart={e => onNodeHeaderDown(e, step)}
                    onPortOutDown={e => onPortOutDown(e, step)}
                    onPortInDown={e => onPortInDown(e, step)}
                    onPortInEnter={() => { hoverPortRef.current = step.id }}
                    onPortInLeave={() => { if (hoverPortRef.current === step.id) hoverPortRef.current = null }}
                    onPortOutEnter={() => { hoverOutPortRef.current = step.id }}
                    onPortOutLeave={() => { if (hoverOutPortRef.current === step.id) hoverOutPortRef.current = null }}
                    draggingConn={!!dragConn && dragConn.fromId !== step.id}
                    dragConnSide={dragConn?.fromSide}
                  />
                )
              }
              const info = getApiById(step.aid)
              if (!info) {
                return (
                  <div
                    key={step.id}
                    className={styles.node_ghost}
                    style={{ left: step.x ?? 80, top: step.y ?? 80, width: NODE_W }}
                    onMouseDown={e => onNodeHeaderDown(e, step)}
                  >
                    <span className={styles.node_ghost_label}>삭제된 API</span>
                    <button
                      className={styles.node_close}
                      onClick={e => { e.stopPropagation(); removeFlowStep(idx); if (selectedId === step.id) setSelectedId(null) }}
                    >×</button>
                  </div>
                )
              }
              return (
                <CanvasNode
                  key={step.id}
                  step={step}
                  stepNum={stepNum}
                  api={info.api}
                  mod={info.module}
                  selected={selectedId === step.id}
                  onClick={e => { e.stopPropagation(); setSelectedId(step.id); setPanelTab('params') }}
                  onRemove={e => { e.stopPropagation(); removeFlowStep(idx); if (selectedId === step.id) setSelectedId(null) }}
                  onHeaderDown={e => onNodeHeaderDown(e, step)}
                  onTouchStart={e => onNodeHeaderDown(e, step)}
                  onPortOutDown={e => onPortOutDown(e, step)}
                  onPortInDown={e => onPortInDown(e, step)}
                  onPortInEnter={() => { hoverPortRef.current = step.id }}
                  onPortInLeave={() => { if (hoverPortRef.current === step.id) hoverPortRef.current = null }}
                  onPortOutEnter={() => { hoverOutPortRef.current = step.id }}
                  onPortOutLeave={() => { if (hoverOutPortRef.current === step.id) hoverOutPortRef.current = null }}
                  draggingConn={!!dragConn && dragConn.fromId !== step.id}
                  dragConnSide={dragConn?.fromSide}
                />
              )
            })}
          </div>
        </div>

        {/* ── Side panels ── */}
        {selStep && selStep.type === 'header-config' && (
          <HeaderConfigPanel
            step={selStep}
            idx={selectedIdx}
            execPos={execPos}
            flowSteps={flowSteps}
            modules={modules}
            getApiById={getApiById}
            onClose={() => setSelectedId(null)}
            onAddEntry={() => addHeaderConfigEntry(selStep.id)}
            onAddEntryWith={entry => addHeaderConfigEntryWith(selStep.id, entry)}
            onRemoveEntry={i => removeHeaderConfigEntry(selStep.id, i)}
            onUpdateEntry={(i, f, v) => updateHeaderConfigEntry(selStep.id, i, f, v)}
            onBind={i => openBind('hconfig', i)}
          />
        )}
        {selStep && selStep.type !== 'header-config' && selInfo && (() => {
          // 연결 그래프 상 조상 header-config 스텝에서 오는 상속 헤더 계산
          const prevMap = {}
          for (const c of connections) prevMap[c.toId] = c.fromId
          const inheritedHeaders = []
          const seen = new Set()
          let cur = prevMap[selStep.id]
          const visited = new Set()
          while (cur && !visited.has(cur)) {
            visited.add(cur)
            const s = flowSteps.find(f => f.id === cur)
            if (s?.type === 'header-config') {
              ;(s.headers || []).filter(h => h.key && !seen.has(h.key)).forEach(h => {
                seen.add(h.key)
                inheritedHeaders.push(h)
              })
            }
            cur = prevMap[cur]
          }
          return (
          <SidePanel
            step={selStep}
            idx={selectedIdx}
            api={selInfo.api}
            mod={selInfo.module}
            tab={panelTab}
            onTabChange={setPanelTab}
            onClose={() => setSelectedId(null)}
            flowSteps={flowSteps}
            getApiById={getApiById}
            onUpdateParam={(pi, val) => updateParam(selectedIdx, pi, val)}
            onBind={pi => openBind('param', pi)}
            onToggleArrayMode={(pi) => toggleParamArrayMode(selectedIdx, pi)}
            onAddArrayItem={(pi) => addParamArrayItem(selectedIdx, pi)}
            onRemoveArrayItem={(pi, ii) => removeParamArrayItem(selectedIdx, pi, ii)}
            onUpdateArrayItem={(pi, ii, val) => updateParamArrayItem(selectedIdx, pi, ii, val)}
            onBindArrayItem={(pi, ii) => openBind('param', pi, { itemIdx: ii })}
            onAddHeader={() => addStepHeader(selectedIdx)}
            onRemoveHeader={hi => removeStepHeader(selectedIdx, hi)}
            onUpdateHeader={(hi, f, v) => updateStepHeader(selectedIdx, hi, f, v)}
            onBindHeader={hi => openBind('header', hi)}
            onBodyModeChange={mode => updateBodyMode(selectedIdx, mode)}
            onBodyRawChange={val => updateBodyRaw(selectedIdx, val)}
            apiPresets={apiPresets.filter(p => p.aid === selInfo.api.id)}
            aid={selInfo.api.id}
            onSavePreset={(name) => saveApiPreset(selInfo.api.id, selInfo.module.id, name, selStep)}
            onUpdatePreset={(id) => updateApiPreset(id, selStep)}
            onLoadPreset={(preset) => loadApiPreset(selectedIdx, preset)}
            onDeletePreset={deleteApiPreset}
            inheritedHeaders={inheritedHeaders}
            excludedHeaders={selStep.excludedHeaders || []}
            onToggleExcludeHeader={(key) => toggleExcludeHeader(selStep.id, key)}
            execOrder={execOrder}
            selectedExecIdx={selectedExecIdx}
            lastRunResponses={lastRunResponses}
            onApplyBind={(pi, label) => bindParam(selectedIdx, pi, label)}
          />
          )
        })()}
      </div>

      {/* ── Bind Modal ── */}
      <Modal
        open={!!bindModal}
        onClose={() => setBindModal(null)}
        maxWidth={600}
        title={(() => {
          if (!bindModal || !bindStep) return ''
          if (bindModal.type === 'hconfig') {
            const h = bindStep.headers?.[bindModal.idx]
            return `"${h?.key || '비어 있는 헤더'}" 헤더 값 연결`
          }
          if (bindModal.type === 'header') {
            const h = bindStep.reqHeaders?.[bindModal.idx]
            return `헤더 "${h?.key || '비어 있는 헤더'}" 값 연결`
          }
          const p = bindStep.params?.[bindModal.idx]
          return `"${p?.key || '비어 있는'}" 파라미터에 연결`
        })()}
      >
        <BindSheet
          apiSteps={bindApiSteps}
          type={bindModal?.type}
          bbStep={bbStep} onBbStep={setBbStep}
          bbField={bbField} onBbField={setBbField}
          hbStep={hbStep} onHbStep={setHbStep}
          hbName={hbName} onHbName={setHbName}
          getApiById={getApiById}
          lastRunResponses={lastRunResponses}
          onApplyBind={applyBind}
          onApplyBodyBind={applyBodyBind}
          onApplyHeaderBind={applyHeaderBind}
          onTemplateInsert={applyTemplateInsert}
        />
        <Button style={{ width: '100%', marginTop: 12 }} onClick={() => setBindModal(null)}>취소</Button>
      </Modal>

      {/* ── Import modal ── */}
      {importOpen && (
        <ImportModal
          modules={modules}
          tab={importTab}
          onTabChange={tab => {
            if (tab === 'json') {
              setImportText(JSON.stringify(formToData(formName, formSteps), null, 2))
            } else {
              try {
                const d = JSON.parse(importText)
                const { name, steps } = dataToForm(d)
                setFormName(name); setFormSteps(steps)
              } catch {}
            }
            setImportErrors([])
            setImportTab(tab)
          }}
          formName={formName} onFormName={setFormName}
          formSteps={formSteps} onFormSteps={setFormSteps}
          importText={importText} onImportText={t => { setImportText(t); setImportErrors([]) }}
          errors={importErrors}
          onClose={() => setImportOpen(false)}
          onImport={() => {
            let parsed
            if (importTab === 'form') {
              parsed = formToData(formName, formSteps)
            } else {
              try { parsed = JSON.parse(importText) } catch { setImportErrors(['JSON 형식이 올바르지 않아요']); return }
            }
            const result = importFlow(parsed)
            if (result?.ok === false) { setImportErrors(result.errors); return }
            setImportOpen(false)
          }}
        />
      )}
    </div>
  )
}

// ── Import helpers ─────────────────────────────────────────────────
function formToData(name, steps) {
  return {
    ...(name ? { name } : {}),
    flow: steps.map(s => {
      const item = { api: s.api }
      const saves = s.save.filter(sv => sv.var && sv.path)
      const uses  = s.use.filter(u => u.key && u.val)
      if (saves.length) item.save = Object.fromEntries(saves.map(sv => [sv.var, sv.path.startsWith('$.') ? sv.path : `$.${sv.path}`]))
      if (uses.length)  item.use  = Object.fromEntries(uses.map(u  => [u.key, u.val]))
      return item
    }),
  }
}
function dataToForm(data) {
  return {
    name: data.name || '',
    steps: (data.flow || []).map((item, i) => ({
      id: i,
      api: item.api || '',
      save: Object.entries(item.save || {}).map(([v, p]) => ({ var: v, path: p })),
      use:  Object.entries(item.use  || {}).map(([k, v]) => ({ key: k, val: v })),
    })),
  }
}

// ── Import Modal ───────────────────────────────────────────────────
function ImportModal({ modules, tab, onTabChange, formName, onFormName, formSteps, onFormSteps,
  importText, onImportText, errors, onClose, onImport }) {

  const allApis = modules.flatMap(m => m.apis.map(a => ({ label: `${a.name}`, sub: `${m.name} · ${a.method} ${a.path}`, value: a.name })))

  function updateStep(idx, patch) {
    onFormSteps(prev => prev.map((s, i) => i === idx ? { ...s, ...patch } : s))
  }
  function addStep() {
    onFormSteps(prev => [...prev, { id: Date.now(), api: '', save: [], use: [] }])
  }
  function removeStep(idx) {
    onFormSteps(prev => prev.filter((_, i) => i !== idx))
  }

  function addSave(idx)            { updateStep(idx, { save: [...formSteps[idx].save, { var: '', path: '' }] }) }
  function removeSave(idx, si)     { updateStep(idx, { save: formSteps[idx].save.filter((_, i) => i !== si) }) }
  function updateSave(idx, si, f, v) { updateStep(idx, { save: formSteps[idx].save.map((s, i) => i === si ? { ...s, [f]: v } : s) }) }

  function addUse(idx)             { updateStep(idx, { use: [...formSteps[idx].use, { key: '', val: '' }] }) }
  function removeUse(idx, ui)      { updateStep(idx, { use: formSteps[idx].use.filter((_, i) => i !== ui) }) }
  function updateUse(idx, ui, f, v){ updateStep(idx, { use: formSteps[idx].use.map((u, i) => i === ui ? { ...u, [f]: v } : u) }) }

  return (
    <div className={styles.import_overlay}>
      <div className={styles.import_modal}>
        {/* Header */}
        <div className={styles.import_head}>
          <span className={styles.import_title}>플로우 가져오기</span>
          <div className={styles.import_tabs}>
            <button className={[styles.import_tab, tab === 'form' ? styles.import_tab_on : ''].join(' ')} onClick={() => onTabChange('form')}>폼</button>
            <button className={[styles.import_tab, tab === 'json' ? styles.import_tab_on : ''].join(' ')} onClick={() => onTabChange('json')}>JSON</button>
          </div>
        </div>

        {tab === 'form' ? (
          <div className={styles.import_form_scroll}>
            {/* Flow name */}
            <input
              className={styles.import_name_input}
              value={formName}
              onChange={e => onFormName(e.target.value)}
              placeholder="플로우 이름 (선택)"
            />

            {formSteps.map((step, idx) => (
              <div key={step.id} className={styles.ifs_card}>
                <div className={styles.ifs_head}>
                  <span className={styles.ifs_num}>스텝 {idx + 1}</span>
                  {formSteps.length > 1 && (
                    <button className={styles.ifs_remove} onClick={() => removeStep(idx)}>×</button>
                  )}
                </div>

                {/* API select */}
                <div className={styles.ifs_row}>
                  <span className={styles.ifs_label}>API</span>
                  <div className={styles.ifs_api_wrap}>
                    <input
                      className={styles.ifs_api_input}
                      list={`api-list-${idx}`}
                      value={step.api}
                      onChange={e => updateStep(idx, { api: e.target.value })}
                      placeholder="API 이름 입력 또는 선택"
                    />
                    <datalist id={`api-list-${idx}`}>
                      {allApis.map((a, i) => <option key={i} value={a.label}>{a.sub}</option>)}
                    </datalist>
                  </div>
                </div>

                {/* Save */}
                {step.save.length > 0 && (
                  <div className={styles.ifs_section}>
                    <span className={styles.ifs_section_label}>저장</span>
                    {step.save.map((sv, si) => (
                      <div key={si} className={styles.ifs_kv_row}>
                        <input className={styles.ifs_kv_key} value={sv.var} onChange={e => updateSave(idx, si, 'var', e.target.value)} placeholder="변수명" />
                        <span className={styles.ifs_kv_arrow}>←</span>
                        <input className={styles.ifs_kv_val} value={sv.path} onChange={e => updateSave(idx, si, 'path', e.target.value)} placeholder="$.data.token" />
                        <button className={styles.ifs_kv_remove} onClick={() => removeSave(idx, si)}>×</button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Use (headers) */}
                {step.use.length > 0 && (
                  <div className={styles.ifs_section}>
                    <span className={styles.ifs_section_label}>헤더</span>
                    {step.use.map((u, ui) => (
                      <div key={ui} className={styles.ifs_kv_row}>
                        <input className={styles.ifs_kv_key} value={u.key} onChange={e => updateUse(idx, ui, 'key', e.target.value)} placeholder="Authorization" />
                        <span className={styles.ifs_kv_arrow}>=</span>
                        <input className={styles.ifs_kv_val} value={u.val} onChange={e => updateUse(idx, ui, 'val', e.target.value)} placeholder={`Bearer {{token}}`} />
                        <button className={styles.ifs_kv_remove} onClick={() => removeUse(idx, ui)}>×</button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Add buttons */}
                <div className={styles.ifs_add_row}>
                  <button className={styles.ifs_add_btn} onClick={() => addSave(idx)}>+ 저장</button>
                  <button className={styles.ifs_add_btn} onClick={() => addUse(idx)}>+ 헤더</button>
                </div>

                {idx < formSteps.length - 1 && <div className={styles.ifs_connector}>↓</div>}
              </div>
            ))}

            <button className={styles.ifs_add_step} onClick={addStep}>+ 스텝 추가</button>
          </div>
        ) : (
          <textarea
            className={styles.import_textarea}
            value={importText}
            onChange={e => onImportText(e.target.value)}
            placeholder={IMPORT_PLACEHOLDER}
            spellCheck={false}
          />
        )}

        {errors.length > 0 && (
          <div className={styles.import_errors}>
            {errors.map((e, i) => <div key={i}>⚠ {e}</div>)}
          </div>
        )}
        <div className={styles.import_actions}>
          <Button size="sm" onClick={onClose}>취소</Button>
          <Button size="sm" variant="primary" onClick={onImport}>가져오기</Button>
        </div>
      </div>
    </div>
  )
}

const IMPORT_PLACEHOLDER = `{
  "name": "로그인 후 유저 조회",
  "flow": [
    {
      "api": "login",
      "save": { "token": "$.data.accessToken" }
    },
    {
      "api": "getUser",
      "use": { "Authorization": "Bearer {{token}}" }
    }
  ]
}`

// ── Header Config Canvas Node ──────────────────────────────────────
function HeaderConfigNode({ step, stepNum, selected, onClick, onRemove, onHeaderDown, onTouchStart,
  onPortOutDown, onPortInDown, onPortInEnter, onPortInLeave, onPortOutEnter, onPortOutLeave, draggingConn, dragConnSide }) {
  const entries = (step.headers || []).filter(h => h.key)
  return (
    <div
      className={[styles.node, styles.hc_node, selected ? styles.node_sel : ''].join(' ')}
      style={{ left: step.x ?? 80, top: step.y ?? 80, width: NODE_W }}
      onClick={onClick}
    >
      <div
        className={[styles.port_in, (draggingConn && dragConnSide === 'out') ? styles.port_in_droppable : ''].join(' ')}
        onMouseDown={onPortInDown}
        onMouseEnter={onPortInEnter}
        onMouseLeave={onPortInLeave}
      />
      <div
        className={[styles.node_head, styles.hc_head].join(' ')}
        onMouseDown={onHeaderDown}
        onTouchStart={onTouchStart}
      >
        <ConfigIcon />
        <span className={styles.node_title}>헤더 설정</span>
        <span className={styles.node_step}>#{stepNum}</span>
        <button className={styles.node_close} onClick={onRemove}>×</button>
      </div>
      <div className={styles.hc_entries}>
        {entries.length === 0
          ? <span className={styles.hc_empty_text}>헤더 없음 — 클릭해서 설정</span>
          : entries.slice(0, 4).map((h, i) => (
            <div key={i} className={styles.hc_entry_row}>
              <span className={styles.hc_entry_key}>{h.key}</span>
              <span className={styles.hc_entry_val}>{h.binding ? '(연결됨)' : h.val || '—'}</span>
            </div>
          ))
        }
        {entries.length > 4 && <span className={styles.hc_more}>+{entries.length - 4}개 더</span>}
      </div>
      <div className={styles.node_ports}>
        <div className={styles.port_send}><WaveIcon /> Output</div>
        <div className={styles.port_outputs}>
          <div
            className={[styles.port_ok, (draggingConn && dragConnSide === 'in') ? styles.port_out_droppable : ''].join(' ')}
            onMouseEnter={onPortOutEnter}
            onMouseLeave={onPortOutLeave}
          >
            Output
            <span
              className={[styles.dot_ok, (draggingConn && dragConnSide === 'in') ? styles.dot_ok_droppable : ''].join(' ')}
              onMouseDown={onPortOutDown}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Header Config Side Panel ───────────────────────────────────────
function HeaderConfigPanel({ step, idx, execPos, flowSteps, modules = [], getApiById, onClose,
  onAddEntry, onAddEntryWith, onRemoveEntry, onUpdateEntry, onBind }) {
  const entries = step.headers || []
  const [schemeOpen, setSchemeOpen] = useState(true)

  // 모듈별 보안 스킴 (auths가 있는 모듈만)
  const modulesWithAuth = modules.filter(m => (m.auths || []).some(a => a.key))
  // 이미 entries에 있는 key 집합
  const addedKeys = new Set(entries.map(e => e.key).filter(Boolean))

  return (
    <div className={styles.panel} onClick={e => e.stopPropagation()}>
      <div className={styles.panel_head}>
        <div className={styles.panel_title}>
          <ConfigIcon />
          <span>헤더 설정 박스</span>
        </div>
        <button className={styles.panel_close} onClick={onClose}>×</button>
      </div>
      <div className={[styles.panel_url, styles.hc_desc].join(' ')}>
        이 박스 이후의 모든 API 요청에 아래 헤더가 자동으로 포함됩니다
      </div>

      {/* ── 모듈별 보안 스킴 섹션 ── */}
      {modulesWithAuth.length > 0 && (
        <div className={styles.scheme_section}>
          <button className={styles.scheme_toggle} onClick={() => setSchemeOpen(o => !o)}>
            <LockIcon />
            <span>감지된 보안 스킴</span>
            <span className={styles.scheme_count}>{modulesWithAuth.reduce((s, m) => s + (m.auths||[]).filter(a=>a.key).length, 0)}</span>
            <ChevronSmallIcon open={schemeOpen} />
          </button>
          {schemeOpen && (
            <div className={styles.scheme_body}>
              {modulesWithAuth.map(mod => (
                <div key={mod.id} className={styles.scheme_mod_group}>
                  <div className={styles.scheme_mod_name}>{mod.name}</div>
                  {(mod.auths || []).filter(a => a.key).map((auth, ai) => {
                    const already = addedKeys.has(auth.key)
                    return (
                    <div key={ai} className={styles.scheme_row}>
                      <span className={styles.scheme_type_badge} data-type={auth.schemeType || 'apiKey'}>
                        {schemeTypeLabel(auth.schemeType)}
                      </span>
                      <span className={styles.scheme_name}>{auth.schemeName || auth.key}</span>
                      <span className={styles.scheme_arrow}>→</span>
                      <span className={styles.scheme_header_key}>{auth.key}</span>
                      {auth.hint && <span className={styles.scheme_hint}>{auth.hint}</span>}
                      <button
                        className={[styles.scheme_add_btn, already ? styles.scheme_add_btn_done : ''].join(' ')}
                        disabled={already}
                        onClick={() => onAddEntryWith({ key: auth.key, hint: auth.hint || null, mid: mod.id, schemeName: auth.schemeName || null, schemeType: auth.schemeType || null })}
                      >
                        {already ? '추가됨' : '+ 추가'}
                      </button>
                    </div>
                    )
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className={styles.panel_body}>
        <div className={styles.table_head}>
          <span>Key</span><span>Value</span>
        </div>
        {entries.map((h, i) => {
          const isBearerScheme = h.schemeType === 'http bearer' || h.hint === 'Bearer'
          const needsBearer = isBearerScheme && h.val && !h.val.startsWith('Bearer ') && !h.binding
          const isJWTInWrongKey = h.val?.startsWith('ey') && h.key !== 'Authorization'
          
          // JWT Validation Logic
          const tokenBody = h.val?.replace(/^Bearer\s+/i, '') || ''
          const isDuplicatedJWT = (tokenBody.match(/eyJ/g) || []).length > 1
          const dotCount = (tokenBody.match(/\./g) || []).length
          const isInvalidJWTStructure = tokenBody.startsWith('ey') && dotCount !== 2 && !isDuplicatedJWT

          return (
            <div key={i} className={styles.hrow}>
              <HeaderKeyInput
                value={h.key}
                onChange={v => onUpdateEntry(i, 'key', v)}
                warning={isJWTInWrongKey ? 'JWT는 보통 Authorization 헤더에 사용합니다' : null}
              />
              <div style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'center' }}>
                <input
                  className={[styles.pval, h.binding ? styles.pval_bound : !h.val && h.hint ? styles.pval_hint : ''].join(' ')}
                  value={h.binding || h.val}
                  placeholder={h.hint ? `${h.hint} <토큰 입력 또는 연결>` : 'Value'}
                  onChange={e => onUpdateEntry(i, 'val', e.target.value)}
                  style={{ width: '100%' }}
                />
                
                {needsBearer && (
                  <button 
                    className={styles.auth_guide_btn} 
                    title="Bearer 접두어 추가"
                    onClick={() => onUpdateEntry(i, 'val', 'Bearer ' + h.val)}
                  >
                    <AlertIcon />
                  </button>
                )}

                {isDuplicatedJWT && (
                  <div className={styles.auth_warn_tooltip} style={{ background: 'var(--red-bg)', borderColor: 'var(--red-border)', color: 'var(--red)' }}>
                    토큰이 중복 입력된 것 같습니다 (eyJ 패턴 반복)
                  </div>
                )}
                {isInvalidJWTStructure && (
                  <div className={styles.auth_warn_tooltip}>
                    JWT 형식이 올바르지 않습니다 (구분자 '.' 부족/과다)
                  </div>
                )}
              </div>

              {h.hint && !h.val && !h.binding && <span className={styles.hc_auto_badge}>자동감지</span>}
              <button className={[styles.pbind, (h.binding || h.val?.includes('{step')) ? styles.pbind_on : ''].join(' ')}
                onClick={() => onBind(i)}>
                {(h.binding || h.val?.includes('{step')) ? '연결됨' : '연결'}
              </button>
              {h.binding && <button className={styles.pbind_clear} onClick={() => onUpdateEntry(i, 'val', '')} title="연결 해제">×</button>}
              <button className={styles.hremove} onClick={() => onRemoveEntry(i)}>×</button>
            </div>
          )
        })}
        <button className={styles.hadd} onClick={onAddEntry}>+ 헤더 추가</button>
      </div>
    </div>
  )
}

function schemeTypeLabel(type) {
  switch (type) {
    case 'http bearer':    return 'Bearer'
    case 'http basic':     return 'Basic'
    case 'apiKey':         return 'API Key'
    case 'oauth2':         return 'OAuth2'
    case 'openIdConnect':  return 'OIDC'
    default:               return type || 'Auth'
  }
}

// ── Canvas Node ────────────────────────────────────────────────────
function CanvasNode({ step, stepNum, api, mod, selected, onClick, onRemove, onHeaderDown, onTouchStart,
  onPortOutDown, onPortInDown, onPortInEnter, onPortInLeave, onPortOutEnter, onPortOutLeave, draggingConn, dragConnSide }) {
  return (
    <div
      className={[styles.node, selected ? styles.node_sel : ''].join(' ')}
      style={{ left: step.x ?? 80, top: step.y ?? 80, width: NODE_W }}
      onClick={onClick}
    >
      {/* Input port (left) */}
      <div
        className={[styles.port_in, (draggingConn && dragConnSide === 'out') ? styles.port_in_droppable : ''].join(' ')}
        onMouseDown={onPortInDown}
        onMouseEnter={onPortInEnter}
        onMouseLeave={onPortInLeave}
      />

      {/* Header — drag handle */}
      <div className={styles.node_head} onMouseDown={onHeaderDown} onTouchStart={onTouchStart}>
        <HttpIcon />
        <span className={styles.node_title}>{api.name}</span>
        <span className={styles.node_step}>#{stepNum}</span>
        <button className={styles.node_close} onClick={onRemove}>×</button>
      </div>

      {/* Meta */}
      <div className={styles.node_meta}>
        <span className={styles.node_mod}>{mod.name}</span>
        <span className={styles.node_sep}>·</span>
        <MethodBadge method={api.method} />
        <span className={styles.node_path}>{api.path}</span>
      </div>

      {/* Ports row */}
      <div className={styles.node_ports}>
        <div className={styles.port_send}>
          <WaveIcon /> Send
        </div>
        <div className={styles.port_outputs}>
          <div
            className={[styles.port_ok, (draggingConn && dragConnSide === 'in') ? styles.port_out_droppable : ''].join(' ')}
            onMouseEnter={onPortOutEnter}
            onMouseLeave={onPortOutLeave}
          >
            Success
            <span
              className={[styles.dot_ok, (draggingConn && dragConnSide === 'in') ? styles.dot_ok_droppable : ''].join(' ')}
              onMouseDown={onPortOutDown}
            />
          </div>
          <div className={styles.port_err}>
            Fail <span className={styles.dot_err} />
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Header UI Helpers ────────────────────────────────────────────────
const COMMON_HEADERS = [
  { key: 'Authorization', label: 'Auth' },
  { key: 'Content-Type', label: 'Type' },
  { key: 'Accept', label: 'Accept' },
  { key: 'X-Access-Token', label: 'Token' },
  { key: 'Cookie', label: 'Cookie' },
]

function HeaderKeyInput({ value, onChange, warning }) {
  const [open, setOpen] = useState(false)
  
  return (
    <div className={styles.hkey_wrap}>
      <input 
        className={styles.hkey} 
        value={value} 
        placeholder="Key"
        onChange={e => onChange(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 200)}
      />
      
      {open && (
        <div className={styles.hkey_suggest}>
          {COMMON_HEADERS.map(h => (
            <button key={h.key} className={styles.hkey_suggest_item} onClick={() => onChange(h.key)}>
              <span>{h.key}</span>
              <span className={styles.hkey_suggest_label}>{h.label}</span>
            </button>
          ))}
        </div>
      )}
      
      {warning && (
        <div className={styles.auth_warn_tooltip}>
          {warning}
        </div>
      )}
    </div>
  )
}

function AlertIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
}

// ── Side Panel ─────────────────────────────────────────────────────
function SidePanel({
  step, idx, api, mod, tab, onTabChange, onClose,
  flowSteps, getApiById,
  onUpdateParam, onBind,
  onAddHeader, onRemoveHeader, onUpdateHeader, onBindHeader,
  onBodyModeChange, onBodyRawChange,
  onToggleArrayMode, onAddArrayItem, onRemoveArrayItem, onUpdateArrayItem, onBindArrayItem,
  apiPresets, aid, onSavePreset, onUpdatePreset, onLoadPreset, onDeletePreset,
  inheritedHeaders = [], excludedHeaders = [], onToggleExcludeHeader,
  execOrder = [], selectedExecIdx = null, lastRunResponses = {}, onApplyBind,
}) {
  const isBodyMethod = ['POST', 'PUT', 'PATCH'].includes(api.method)
  const tabs = ['params', 'headers', ...(isBodyMethod ? ['body'] : []), 'examples']
  const tabLabel = { params: 'Query Params', headers: 'Headers', body: 'Body', examples: '예시' }

  const reqEx  = api.requestExample  ?? null
  const resEx  = api.responseExample ?? null
  const hasEx  = reqEx != null || resEx != null

  const [autoMapResult, setAutoMapResult] = useState(null)

  // 탭 바뀌면 결과 초기화
  const prevTabRef = useRef(tab)
  if (prevTabRef.current !== tab) { prevTabRef.current = tab; if (autoMapResult) setAutoMapResult(null) }

  const hasPrevSteps = selectedExecIdx !== null && selectedExecIdx > 0 &&
    execOrder.slice(0, selectedExecIdx).some(s => s.type !== 'header-config')
  const hasUnboundParams = step.params.some(p => !p.binding)

  function runAutoMap() {
    const results = computeAutoMappings(step.params, execOrder, selectedExecIdx, getApiById, lastRunResponses)
    // 자동 매핑 (threshold > 70)
    for (const r of results) {
      if (r.autoApply && r.best) onApplyBind(r.paramIdx, r.best.label)
    }
    setAutoMapResult(results)
  }

  function fillRawWithExample() {
    if (reqEx == null) return
    onBodyModeChange('raw')
    onBodyRawChange(JSON.stringify(reqEx, null, 2))
  }

  return (
    <div className={styles.panel} onClick={e => e.stopPropagation()}>
      <div className={styles.panel_head}>
        <div className={styles.panel_title}>
          <MethodBadge method={api.method} />
          <span>{api.name}</span>
        </div>
        <button className={styles.panel_close} onClick={onClose}>×</button>
      </div>

      <div className={styles.panel_url}>
        <span className={styles.panel_url_base}>{mod.url}</span>
        <span className={styles.panel_url_path}>{api.path}</span>
      </div>

      <PresetBar
        presets={apiPresets}
        aid={aid}
        onSave={onSavePreset}
        onUpdate={onUpdatePreset}
        onLoad={onLoadPreset}
        onDelete={onDeletePreset}
      />

      <div className={styles.panel_tabs}>
        {tabs.map(t => (
          <button key={t}
            className={[styles.ptab, tab === t ? styles.ptab_active : ''].join(' ')}
            onClick={() => onTabChange(t)}
          >
            {tabLabel[t]}
            {t === 'examples' && hasEx && <span className={styles.ptab_dot} />}
          </button>
        ))}
      </div>

      <div className={styles.panel_body}>
        {tab === 'params' && (
          step.params.length === 0
            ? <div className={styles.panel_empty}>이 API에 파라미터가 없습니다</div>
            : <>
              {hasPrevSteps && hasUnboundParams && (
                <div className={styles.automap_bar}>
                  <button className={styles.automap_btn} onClick={runAutoMap}>
                    <AutoMapIcon /> 자동 매핑
                  </button>
                </div>
              )}
              {autoMapResult && <AutoMapPanel results={autoMapResult} onApply={onApplyBind} />}
              {step.params.map((p, pi) => {
              const enumVals = api.params.find(ap => ap.key === p.key)?.enum ?? null
              return (
              <div key={p.key} className={styles.param_group}>
                <div className={styles.prow}>
                  <span className={styles.pkey}>{p.key}</span>
                  {!p.items && (
                    <>
                      {enumVals && !p.binding ? (
                        <select
                          className={styles.pval}
                          value={p.val}
                          onChange={e => onUpdateParam(pi, e.target.value)}
                        >
                          <option value="">선택...</option>
                          {enumVals.map(v => (
                            <option key={String(v)} value={String(v)}>{String(v)}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          className={[styles.pval, p.binding ? styles.pval_bound : ''].join(' ')}
                          value={p.binding || p.val}
                          placeholder="값 입력"
                          onChange={e => onUpdateParam(pi, e.target.value)}
                        />
                      )}
                      <button className={[styles.pbind, p.binding ? styles.pbind_on : ''].join(' ')} onClick={() => onBind(pi)}>
                        {p.binding ? '연결됨' : '연결'}
                      </button>
                      {p.binding && <button className={styles.pbind_clear} onClick={() => onUpdateParam(pi, '')} title="연결 해제">×</button>}
                    </>
                  )}
                  {(p.items || api.params.find(ap => ap.key === p.key)?.type === 'array') && (
                    <button
                      className={[styles.array_toggle, p.items ? styles.array_toggle_on : ''].join(' ')}
                      onClick={() => onToggleArrayMode(pi)}
                      title={p.items ? '리스트 모드 끄기' : '리스트 모드'}
                    >[ ]</button>
                  )}
                </div>
                {p.items && (
                  <div className={styles.array_items}>
                    {p.items.map((item, ii) => (
                      <div key={ii} className={styles.array_item_row}>
                        <span className={styles.array_idx}>{ii + 1}</span>
                        <input
                          className={[styles.pval, item.binding ? styles.pval_bound : ''].join(' ')}
                          value={item.binding || item.val}
                          placeholder="값 입력"
                          onChange={e => onUpdateArrayItem(pi, ii, e.target.value)}
                        />
                        <button className={[styles.pbind, item.binding ? styles.pbind_on : ''].join(' ')} onClick={() => onBindArrayItem(pi, ii)}>
                          {item.binding ? '연결됨' : '연결'}
                        </button>
                        {item.binding && <button className={styles.pbind_clear} onClick={() => onUpdateArrayItem(pi, ii, '')} title="연결 해제">×</button>}
                        <button className={styles.hremove} onClick={() => onRemoveArrayItem(pi, ii)}>×</button>
                      </div>
                    ))}
                    <button className={styles.hadd} onClick={() => onAddArrayItem(pi)}>+ 항목 추가</button>
                  </div>
                )}
              </div>
              )
            })}
            </>
        )}

        {tab === 'headers' && (<>
          <div className={styles.table_head}>
            <span>Key</span><span>Value</span>
          </div>
          {(step.reqHeaders || []).map((h, hi) => (
            <div key={hi} className={styles.hrow}>
              <input className={styles.hkey} value={h.key} placeholder="Key"
                onChange={e => onUpdateHeader(hi, 'key', e.target.value)} />
              <input
                className={[styles.pval, h.binding ? styles.pval_bound : ''].join(' ')}
                value={h.binding || h.val} placeholder="Value"
                onChange={e => onUpdateHeader(hi, 'val', e.target.value)}
              />
              <button className={[styles.pbind, h.binding ? styles.pbind_on : ''].join(' ')} onClick={() => onBindHeader(hi)}>
                {h.binding ? '연결됨' : '연결'}
              </button>
              {h.binding && <button className={styles.pbind_clear} onClick={() => onUpdateHeader(hi, 'val', '')} title="연결 해제">×</button>}
              <button className={styles.hremove} onClick={() => onRemoveHeader(hi)}>×</button>
            </div>
          ))}
          <button className={styles.hadd} onClick={onAddHeader}>+ 헤더 추가</button>
          {inheritedHeaders.length > 0 && (
            <>
              <div className={styles.inherited_title}>헤더 설정에서 상속</div>
              {inheritedHeaders.map(h => {
                const excluded = excludedHeaders.includes(h.key)
                return (
                  <div key={h.key} className={[styles.hrow, excluded ? styles.inherited_excluded : styles.inherited_row].join(' ')}>
                    <span className={styles.hkey} style={{ flex: 1, opacity: excluded ? 0.4 : 1 }}>{h.key}</span>
                    <span className={styles.inherited_val}>{h.binding || h.val || '—'}</span>
                    <button
                      className={styles.hremove}
                      title={excluded ? '다시 포함' : '이 API에서 제외'}
                      onClick={() => onToggleExcludeHeader(h.key)}
                      style={{ color: excluded ? 'var(--text3)' : undefined }}
                    >{excluded ? '↩' : '×'}</button>
                  </div>
                )
              })}
            </>
          )}
        </>)}

        {tab === 'body' && isBodyMethod && (<>
          <div className={styles.body_mode_row}>
            {['params', 'raw'].map(m => (
              <label key={m} className={styles.body_mode_opt}>
                <input type="radio" name={`bm-${step.id}`} value={m}
                  checked={(step.bodyMode || 'params') === m}
                  onChange={() => onBodyModeChange(m)}
                />
                {m === 'params' ? '구조화 (Key-Value)' : 'Raw JSON'}
              </label>
            ))}
          </div>

          {(step.bodyMode || 'params') === 'params'
            ? step.params.length === 0
              ? <div className={styles.panel_empty}>바디 파라미터 없음</div>
              : step.params.map((p, pi) => {
                const enumVals = api.params.find(ap => ap.key === p.key)?.enum ?? null
                return (
                <div key={p.key} className={styles.param_group}>
                  <div className={styles.prow}>
                    <span className={styles.pkey}>{p.key}</span>
                    {!p.items && (
                      <>
                        {enumVals && !p.binding ? (
                          <select
                            className={styles.pval}
                            value={p.val}
                            onChange={e => onUpdateParam(pi, e.target.value)}
                          >
                            <option value="">선택...</option>
                            {enumVals.map(v => (
                              <option key={String(v)} value={String(v)}>{String(v)}</option>
                            ))}
                          </select>
                        ) : (
                          <input
                            className={[styles.pval, p.binding ? styles.pval_bound : ''].join(' ')}
                            value={p.binding || p.val} placeholder="값 입력"
                            onChange={e => onUpdateParam(pi, e.target.value)}
                          />
                        )}
                        <button className={[styles.pbind, p.binding ? styles.pbind_on : ''].join(' ')} onClick={() => onBind(pi)}>
                          {p.binding ? '연결됨' : '연결'}
                        </button>
                      </>
                    )}
                    <button
                      className={[styles.array_toggle, p.items ? styles.array_toggle_on : ''].join(' ')}
                      onClick={() => onToggleArrayMode(pi)}
                      title={p.items ? '리스트 모드 끄기' : '리스트 모드'}
                    >[ ]</button>
                  </div>
                  {p.items && (
                    <div className={styles.array_items}>
                      {p.items.map((item, ii) => (
                        <div key={ii} className={styles.array_item_row}>
                          <span className={styles.array_idx}>{ii + 1}</span>
                          <input
                            className={[styles.pval, item.binding ? styles.pval_bound : ''].join(' ')}
                            value={item.binding || item.val}
                            placeholder="값 입력"
                            onChange={e => onUpdateArrayItem(pi, ii, e.target.value)}
                          />
                          <button className={[styles.pbind, item.binding ? styles.pbind_on : ''].join(' ')} onClick={() => onBindArrayItem(pi, ii)}>
                            {item.binding ? '연결됨' : '연결'}
                          </button>
                          <button className={styles.hremove} onClick={() => onRemoveArrayItem(pi, ii)}>×</button>
                        </div>
                      ))}
                      <button className={styles.hadd} onClick={() => onAddArrayItem(pi)}>+ 항목 추가</button>
                    </div>
                  )}
                </div>
                )
              })
            : <textarea
                className={styles.body_raw}
                value={step.bodyRaw || ''}
                onChange={e => onBodyRawChange(e.target.value)}
                placeholder={'{\n  "key": "value"\n}'}
                spellCheck={false}
              />
          }
        </>)}

        {tab === 'examples' && (
          !hasEx
            ? <div className={styles.panel_empty}>Swagger에 예시 데이터가 없습니다</div>
            : <>
              {reqEx != null && (
                <ExampleBlock
                  label="예시 요청 (Request Body)"
                  data={reqEx}
                  action={isBodyMethod
                    ? <button className={styles.ex_fill_btn} onClick={fillRawWithExample}>Body에 채우기</button>
                    : null}
                />
              )}
              {resEx != null && (
                <ExampleBlock label="예시 응답 (Response)" data={resEx} />
              )}
            </>
        )}
      </div>
    </div>
  )
}

function PresetBar({ presets, aid, onSave, onUpdate, onLoad, onDelete }) {
  const [saving, setSaving] = useState(false)
  const [name, setName]     = useState('')
  const latestId = presets[presets.length - 1]?.id ?? ''
  const [selId, setSelId]   = useState(latestId)
  const prevAidRef = useRef(aid)
  useEffect(() => {
    if (prevAidRef.current !== aid) {
      prevAidRef.current = aid
      setSelId(presets[presets.length - 1]?.id ?? '')
    }
  }, [aid, presets])

  const selected = presets.find(p => p.id === selId) ?? null

  function handleSave() {
    const n = name.trim()
    if (!n) return
    const newId = onSave(n)
    if (newId) setSelId(newId)
    setName('')
    setSaving(false)
  }

  function handleDelete() {
    if (!selected) return
    if (!window.confirm(`"${selected.name}" 프리셋을 삭제할까요?`)) return
    onDelete(selId)
    setSelId(presets.filter(p => p.id !== selId).at(-1)?.id ?? '')
  }

  if (saving) {
    return (
      <div className={styles.preset_bar}>
        <input
          className={styles.preset_name_input}
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="프리셋 이름..."
          autoFocus
          onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') setSaving(false) }}
        />
        <button className={styles.preset_btn_primary} onClick={handleSave}>추가</button>
        <button className={styles.preset_btn} onClick={() => setSaving(false)}>취소</button>
      </div>
    )
  }

  return (
    <div className={styles.preset_bar}>
      <BookmarkIcon />
      <select
        className={styles.preset_select}
        value={selId}
        onChange={e => {
          const id = e.target.value
          setSelId(id)
          const p = presets.find(p => p.id === id)
          if (p) onLoad(p)
        }}
      >
        <option value="">{presets.length === 0 ? '저장된 프리셋 없음' : '프리셋 선택...'}</option>
        {presets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <div className={styles.preset_icon_group}>
        <button className={styles.preset_icon_btn} onClick={() => setSaving(true)} title="새 프리셋 추가">
          <PresetAddIcon />
        </button>
        {selected && (
          <>
            <button className={styles.preset_icon_btn} onClick={() => onUpdate(selId)} title="현재 값으로 업데이트">
              <PresetUpdateIcon />
            </button>
            <button className={styles.preset_icon_btn} onClick={handleDelete} title="프리셋 삭제" data-danger="true">
              <PresetDeleteIcon />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function ExampleBlock({ label, data, action }) {
  const [copied, setCopied] = useState(false)
  const text = JSON.stringify(data, null, 2)
  function copy() {
    navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
  }
  return (
    <div className={styles.ex_block}>
      <div className={styles.ex_head}>
        <span className={styles.ex_label}>{label}</span>
        <div className={styles.ex_actions}>
          {action}
          <button className={styles.ex_copy_btn} onClick={copy}>{copied ? '복사됨 ✓' : '복사'}</button>
        </div>
      </div>
      <pre className={styles.ex_pre}>{text}</pre>
    </div>
  )
}

// ── Bind Sheet ─────────────────────────────────────────────────────
function BindSheet({
  apiSteps, type,
  bbStep, onBbStep, bbField, onBbField,
  hbStep, onHbStep, hbName, onHbName,
  getApiById, lastRunResponses,
  onApplyBind, onApplyBodyBind, onApplyHeaderBind, onTemplateInsert,
}) {
  if (apiSteps.length === 0)
    return <div className={styles.bind_empty_msg}>이전 API 스텝이 없습니다</div>

  // 현재 선택된 바디 스텝
  const selBody = apiSteps.find(({ execIdx }) => execIdx === bbStep - 1) ?? apiSteps.at(-1)
  const selBodyInfo = selBody ? getApiById(selBody.step.aid) : null
  const run = selBody ? lastRunResponses?.[selBody.step.id] : null
  const runFields = run?.body ? flattenObject(run.body) : null
  const exFields = !runFields && selBodyInfo?.api.responseExample
    && typeof selBodyInfo.api.responseExample === 'object'
    && !Array.isArray(selBodyInfo.api.responseExample)
    ? flattenObject(selBodyInfo.api.responseExample) : null
  const bodyKeys = selBody && selBodyInfo
    ? (runFields ? Object.keys(runFields) : getResponseKeys(selBodyInfo.api))
    : []

  const stepOptions = apiSteps.map(({ step, execIdx }) => (
    <option key={step.id} value={execIdx + 1}>
      step{execIdx + 1} — {getApiById(step.aid)?.api.name ?? '?'}
    </option>
  ))

  const bodySection = (
    <div className={styles.bind_section}>
      <div className={styles.bind_section_label}>응답 바디</div>
      <select className={styles.bind_step_sel} value={bbStep} onChange={e => onBbStep(Number(e.target.value))}>
        {stepOptions}
      </select>
      <div className={styles.bind_field_list}>
        {bodyKeys.length === 0
          ? <div className={styles.bind_no_fields}>Swagger 예시 없음 — 직접 입력하세요</div>
          : bodyKeys.map(k => (
            <div key={k} className={styles.bind_item}>
              <div className={styles.bind_item_main} onClick={() => onApplyBind(selBody.execIdx, k)}>
                <span className={styles.bind_path}>{k}</span>
                {runFields
                  ? <span className={styles.bind_val}>{formatPreviewVal(runFields[k])}</span>
                  : exFields?.[k] !== undefined
                    ? <span className={styles.bind_ex}>{formatPreviewVal(exFields[k])}</span>
                    : null}
              </div>
              <button className={styles.bind_insert_btn} onClick={() => onTemplateInsert(selBody.execIdx, k)}>+ 추가</button>
            </div>
          ))
        }
      </div>
      <div className={styles.bind_direct_row}>
        <input
          className={styles.bind_direct_input}
          value={bbField}
          onChange={e => onBbField(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && onApplyBodyBind()}
          placeholder="직접 입력 (예: data.token)"
        />
        <Button size="sm" variant="primary" onClick={onApplyBodyBind}>연결</Button>
      </div>
    </div>
  )

  const headerSection = (
    <div className={styles.bind_section}>
      <div className={styles.bind_section_label}>응답 헤더</div>
      <div className={styles.bind_header_row}>
        <select className={styles.bind_step_sel} value={hbStep} onChange={e => onHbStep(Number(e.target.value))}>
          {stepOptions}
        </select>
        <input
          className={styles.bind_direct_input}
          value={hbName}
          onChange={e => onHbName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && onApplyHeaderBind()}
          placeholder="헤더명 (예: Authorization)"
          autoFocus={type === 'hconfig'}
        />
        <Button size="sm" variant="primary" onClick={onApplyHeaderBind}>연결</Button>
      </div>
    </div>
  )

  return type === 'hconfig'
    ? <>{headerSection}{bodySection}</>
    : <>{bodySection}{headerSection}</>
}

// ── Auto Map Panel ─────────────────────────────────────────────────
function AutoMapPanel({ results, onApply }) {
  if (results.length === 0)
    return <div className={styles.automap_empty}>매핑할 파라미터가 없거나 이미 모두 연결됐습니다.</div>

  return (
    <div className={styles.automap_panel}>
      {results.map(r => {
        if (r.autoApply && r.best) {
          return (
            <div key={r.paramIdx} className={[styles.automap_item, styles.automap_item_ok].join(' ')}>
              <span className={styles.automap_icon_ok}>✓</span>
              <span className={styles.automap_key}>{r.paramKey}</span>
              <span className={styles.automap_arrow}>←</span>
              <span className={styles.automap_label}>{r.best.label}</span>
              <span className={styles.automap_score}>{r.best.score}점</span>
            </div>
          )
        }
        if (r.suggestions.length > 0) {
          return (
            <div key={r.paramIdx} className={[styles.automap_item, styles.automap_item_warn].join(' ')}>
              <span className={styles.automap_icon_warn}>⚠</span>
              <span className={styles.automap_key}>{r.paramKey}</span>
              <div className={styles.automap_sugs}>
                {r.suggestions.map((s, i) => (
                  <button key={i} className={styles.automap_sug_btn} onClick={() => onApply(r.paramIdx, s.label)}>
                    {s.label}
                    <span className={styles.automap_sug_score}>{s.score}</span>
                  </button>
                ))}
              </div>
            </div>
          )
        }
        return (
          <div key={r.paramIdx} className={[styles.automap_item, styles.automap_item_none].join(' ')}>
            <span className={styles.automap_icon_none}>–</span>
            <span className={styles.automap_key}>{r.paramKey}</span>
            <span className={styles.automap_label_none}>매핑 후보 없음</span>
          </div>
        )
      })}
    </div>
  )
}

// ── Icons ──────────────────────────────────────────────────────────
function PlayIcon() {
  return <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
}
function ImportIcon() {
  return <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 3v12M8 11l4 4 4-4"/><path d="M4 17v2a1 1 0 001 1h14a1 1 0 001-1v-2"/></svg>
}
function PresetAddIcon() {
  return <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
}
function PresetUpdateIcon() {
  return <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/></svg>
}
function PresetDeleteIcon() {
  return <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>
}
function SearchIcon() {
  return <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ flexShrink: 0 }}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
}
function HttpIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ flexShrink: 0, opacity: 0.7 }}>
      <rect x="2" y="7" width="20" height="10" rx="2"/>
      <path d="M6 12h3M9 10v4M13 10v4M13 12h3" strokeLinecap="round"/>
    </svg>
  )
}
function WaveIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
      <path d="M2 12 Q5 6 8 12 Q11 18 14 12 Q17 6 20 12 Q21.5 15 22 12" strokeLinecap="round"/>
    </svg>
  )
}
function ConfigIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.07 4.93A10 10 0 1 0 4.93 19.07M19.07 4.93l-3.4 3.4M4.93 19.07l3.4-3.4"/>
    </svg>
  )
}
function BookmarkIcon() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0, color: 'var(--text3)' }}><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
}
function LockIcon() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
}
function ChevronSmallIcon({ open }) {
  return <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s', marginLeft: 'auto' }}><polyline points="6 9 12 15 18 9"/></svg>
}
function AutoMapIcon() {
  return <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 2a10 10 0 0 1 7.38 16.74"/><path d="M12 22a10 10 0 0 1-7.38-16.74"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
}
function EmptyIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.25">
      <rect x="3" y="8" width="8" height="8" rx="1.5"/>
      <rect x="13" y="8" width="8" height="8" rx="1.5"/>
      <line x1="11" y1="12" x2="13" y2="12"/>
      <path d="M7 8V6a2 2 0 0 1 4 0v2"/>
    </svg>
  )
}
