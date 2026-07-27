import { useState, useEffect, useCallback } from 'react'
import { useStore } from './store'
import ModulesPage from './components/ModulesPage'
import FlowBuilder from './components/FlowBuilder'
import SavedFlows from './components/SavedFlows'
import RunPage from './components/RunPage'
import EnvPage from './components/EnvPage'
import HomePage from './components/HomePage'
import SocialLoginPage from './components/SocialLoginPage'
import { Button, Modal, FormGroup, Input, Toast } from './components/ui'
import styles from './App.module.css'

function getInitialPage() {
  const p = window.history.state?.page
  return p || 'home'
}

export default function App() {
  const [page, setPageState] = useState(getInitialPage)

  const setPage = useCallback((p) => {
    window.history.pushState({ page: p }, '')
    setPageState(p)
  }, [])

  useEffect(() => {
    function onPopState(e) {
      setPageState(e.state?.page || 'home')
    }
    window.addEventListener('popstate', onPopState)
    // 초기 상태 등록 (뒤로가기로 첫 페이지도 복원되도록)
    if (!window.history.state?.page) {
      window.history.replaceState({ page: page }, '')
    }
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const [toast, setToast] = useState({ msg: '', visible: false })
  const [saveModal, setSaveModal] = useState(false)
  const [saveName, setSaveName] = useState('')

  const { flowSteps, flowName, setFlowName, savedFlows, saveFlow, loadFlow, clearFlow, envs, activeEnvId, supaStatus, hydrateFromSupabase,
    collections, activeCollectionId, addCollection, deleteCollection, renameCollection, switchCollection,
    theme, setTheme, applyAuthToken } = useStore()
  const moduleCount = useStore(s => s.modules.length) // 브릿지 재시도 트리거(모듈 시드 완료 감지)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  const [collectionOpen, setCollectionOpen] = useState(false)
  const [renamingId, setRenamingId] = useState(null)
  const [renameVal, setRenameVal] = useState('')
  const [newColModal, setNewColModal] = useState(false)
  const [newColName, setNewColName] = useState('')

  const activeCollection = collections.find(c => c.id === activeCollectionId)

  useEffect(() => { hydrateFromSupabase() }, [])

  useEffect(() => {
    function onKeyDown(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        if (page === 'flow') handleSave()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [page, flowSteps, flowName])
  const [newFlowModal, setNewFlowModal] = useState(false)

  const showToast = useCallback((msg) => {
    setToast({ msg, visible: true })
    setTimeout(() => setToast(t => ({ ...t, visible: false })), 2200)
  }, [])

  // 소셜 로그인 브릿지: oauth-result.html 이 localStorage['ft:pendingToken'] 에 남긴 accessToken 을
  // 읽어 module auth 로 반영 → 모든 플로우에 자동 적용. 적용에 성공한 뒤에만 키를 지운다(1회성).
  // 모듈이 아직 시드/로드되기 전이면 applyAuthToken 이 0 을 반환 → 키를 유지하고, moduleCount 가
  // 늘어나 이 effect 가 재실행될 때 다시 시도한다(하이드레이션/시드 순서 경합 방지).
  useEffect(() => {
    function consumePendingToken() {
      let raw
      try { raw = localStorage.getItem('ft:pendingToken') } catch { return }
      if (!raw) return
      let data
      try { data = JSON.parse(raw) } catch { data = { accessToken: raw } }
      if (!data?.accessToken) {
        try { localStorage.removeItem('ft:pendingToken') } catch { /* 무시 */ }
        return
      }
      const applied = applyAuthToken(data.accessToken)
      if (!applied) return // 모듈이 아직 없음 → 키 유지, 모듈 로드되면 재시도
      try { localStorage.removeItem('ft:pendingToken') } catch { /* 무시 */ }
      showToast(`${data.provider ? data.provider + ' ' : ''}토큰 적용됨 — 모든 플로우에 자동 사용`)
    }
    if (supaStatus === 'ok') consumePendingToken()
    // 다른 탭에서 착지한 경우(현재 탭에 flow-tester 가 열려 있음) 즉시 반영
    function onStorage(e) { if (e.key === 'ft:pendingToken' && e.newValue) consumePendingToken() }
    // 같은 탭에서 OAuth 로 다녀온 뒤 '뒤로가기' 하면 bfcache 로 로그인 전 옛 스냅샷(옛 토큰)이
    // 리마운트 없이 복원되고, persist 미들웨어가 그 옛 상태를 localStorage 에 다시 덮어써
    // 방금 받은 새 토큰이 유실된다. bfcache 복원(persisted) 시엔 새로고침으로 최신 persist 상태 +
    // pending 토큰을 다시 적재해 옛 스냅샷이 이기는 것을 막는다.
    function onPageShow(e) { if (e.persisted) window.location.reload() }
    window.addEventListener('storage', onStorage)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [supaStatus, moduleCount, applyAuthToken, showToast])

  function handleSave() {
    if (flowSteps.length === 0) { showToast('저장할 스텝이 없습니다'); return }
    setSaveName(flowName || '')
    setSaveModal(true)
  }

  function confirmSave() {
    const name = saveName.trim() || '이름 없는 플로우'
    const result = saveFlow(name)
    setFlowName(name)
    setSaveModal(false)
    showToast(result === 'overwrite' ? `"${name}" 덮어씌웠습니다` : `"${name}" 저장됨`)
  }

  function handleLoad(flow) {
    loadFlow(flow)
    setPage('flow')
    showToast(`"${flow.name}" 불러왔습니다`)
  }

  function handleRunSaved(flow) {
    loadFlow(flow)
    setPage('run')
  }

  function handleRunFromBuilder() {
    setPage('run')
  }

  function handleNewFlow() {
    if (flowSteps.length > 0) {
      setNewFlowModal(true)
    } else {
      clearFlow()
      setPage('flow')
    }
  }

  function confirmNewFlow(saveFirst) {
    if (saveFirst) {
      const name = flowName.trim() || '이름 없는 플로우'
      saveFlow(name)
      showToast(`"${name}" 저장됨`)
    }
    clearFlow()
    setNewFlowModal(false)
    setPage('flow')
  }

  const activeEnvName = envs.find(e => e.id === activeEnvId)?.name ?? null

  const navItems = [
    { id: 'modules', label: '모듈 관리', icon: <GridIcon />, badge: useStore(s => s.modules.length) },
    { id: 'flow',    label: '플로우 빌더', icon: <FlowIcon />,  badge: flowSteps.length > 0 ? flowSteps.length : null },
    { id: 'saved',   label: '저장된 플로우', icon: <SaveIcon />,  badge: savedFlows.length || null },
    { id: 'run',     label: '실행 결과', icon: <PlayIcon />, badge: null },
    { id: 'env',     label: '환경변수', icon: <EnvIcon />, badge: activeEnvName },
    { id: 'social',  label: '소셜 로그인', icon: <PlayIcon />, badge: null },
  ]

  return (
    <div className={styles.layout}>
      <aside className={styles.sidebar}>
        <button className={styles.logo} onClick={() => setPage('home')}>
          <div className={styles.logo_title}>FLOW TESTER</div>
          <div className={styles.logo_sub}>슬로그업</div>
        </button>

        {/* ── Collection picker ── */}
        <div className={styles.col_section}>
          <div className={styles.col_label}>컬렉션</div>
          <button className={styles.col_current} onClick={() => setCollectionOpen(o => !o)}>
            <FolderIcon />
            <span className={styles.col_name}>{activeCollection?.name ?? '...'}</span>
            <ChevronIcon open={collectionOpen} />
          </button>
          {collectionOpen && (
            <div className={styles.col_dropdown}>
              {collections.map(c => (
                <div key={c.id} className={[styles.col_item, c.id === activeCollectionId ? styles.col_item_active : ''].join(' ')}>
                  {renamingId === c.id ? (
                    <input
                      className={styles.col_rename_input}
                      value={renameVal}
                      autoFocus
                      onChange={e => setRenameVal(e.target.value)}
                      onBlur={() => { renameCollection(c.id, renameVal.trim() || c.name); setRenamingId(null) }}
                      onKeyDown={e => {
                        if (e.key === 'Enter') { renameCollection(c.id, renameVal.trim() || c.name); setRenamingId(null) }
                        if (e.key === 'Escape') setRenamingId(null)
                      }}
                    />
                  ) : (
                    <button className={styles.col_item_name} onClick={() => { switchCollection(c.id); setCollectionOpen(false) }}>
                      {c.name}
                    </button>
                  )}
                  <div className={styles.col_item_actions}>
                    <button title="이름 변경" onClick={() => { setRenamingId(c.id); setRenameVal(c.name) }}>✎</button>
                    {collections.length > 1 && (
                      <button title="삭제" onClick={() => { if (window.confirm(`"${c.name}" 컬렉션을 삭제할까요?\n포함된 모든 모듈, 플로우, 환경이 삭제됩니다.`)) deleteCollection(c.id) }}>×</button>
                    )}
                  </div>
                </div>
              ))}
              <button className={styles.col_add} onClick={() => { setNewColName(''); setNewColModal(true) }}>
                + 새 컬렉션
              </button>
            </div>
          )}
        </div>

        <nav className={styles.nav}>
          <div className={styles.nav_section_title}>메뉴</div>
          {navItems.map(item => (
            <button
              key={item.id}
              className={[styles.nav_item, page === item.id ? styles.nav_active : ''].join(' ')}
              onClick={() => setPage(item.id)}
            >
              {item.icon}
              <span>{item.label}</span>
              {item.badge != null && <span className={styles.badge}>{item.badge}</span>}
            </button>
          ))}

          <div className={styles.nav_divider} />

          <button className={styles.new_btn} onClick={handleNewFlow}>
            <PlusIcon /> 새 플로우
          </button>

          {page === 'flow' && (
            <button className={styles.save_btn} onClick={handleSave}>
              <SaveIconSmall /> 플로우 저장
              <span className={styles.save_kbd}>⌘S</span>
            </button>
          )}

          <div className={styles.nav_divider} />

          <button className={styles.theme_toggle} onClick={() => setTheme(theme === 'dark' ? 'beige' : 'dark')}>
            {theme === 'dark' ? <MoonIcon /> : <SunIcon />}
            <span>{theme === 'dark' ? '다크 모드' : '베이지 모드'}</span>
            <div className={styles.theme_switch}>
              <div className={styles.theme_knob} data-active={theme === 'beige'} />
            </div>
          </button>

          <div className={styles.supa_status} data-status={supaStatus}>
            <CloudIcon status={supaStatus} />
            <span>{supaStatus === 'loading' ? '동기화 중...' : supaStatus === 'error' ? 'Supabase 오류' : supaStatus === 'ok' ? 'Supabase 연결됨' : 'Supabase'}</span>
            {supaStatus === 'error' && <button className={styles.retry_btn} onClick={hydrateFromSupabase}>재시도</button>}
          </div>
        </nav>
      </aside>

      <main className={styles.main}>
        {page === 'home'    && <HomePage onNavigate={setPage} />}
        {page === 'modules' && <ModulesPage />}
        {page === 'flow'    && <FlowBuilder onRun={handleRunFromBuilder} />}
        {page === 'saved'   && <SavedFlows onLoad={handleLoad} onRun={handleRunSaved} />}
        {page === 'run'     && <RunPage onGoToFlow={() => setPage('flow')} />}
        {page === 'env'     && <EnvPage />}
        {page === 'social'  && <SocialLoginPage />}
      </main>

      {/* Save modal */}
      <Modal open={saveModal} onClose={() => setSaveModal(false)} title="플로우 저장">
        <FormGroup label="플로우 이름">
          <Input
            value={saveName}
            onChange={e => setSaveName(e.target.value)}
            placeholder="예: 회원가입 → 주문 플로우"
            autoFocus
            onKeyDown={e => e.key === 'Enter' && confirmSave()}
          />
        </FormGroup>
        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <Button style={{ flex: 1 }} onClick={() => setSaveModal(false)}>취소</Button>
          <Button variant="primary" style={{ flex: 1 }} onClick={confirmSave}>저장</Button>
        </div>
      </Modal>

      {/* New flow modal */}
      <Modal open={newFlowModal} onClose={() => setNewFlowModal(false)} title="새 플로우">
        <p style={{ fontSize: 13, color: 'var(--text2)', margin: '4px 0 20px', lineHeight: 1.6 }}>
          현재 플로우 <strong style={{ color: 'var(--text)' }}>{flowName || '(이름 없음)'}</strong>에
          {' '}{flowSteps.length}개 스텝이 있습니다.<br />
          <span style={{ color: 'var(--text3)', fontSize: 12 }}>저장하지 않으면 사라집니다.</span>
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            style={{ flex: 1, padding: '9px', borderRadius: 'var(--radius)', border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text2)', cursor: 'pointer', fontSize: 13 }}
            onClick={() => setNewFlowModal(false)}
          >취소</button>
          <button
            style={{ flex: 1, padding: '9px', borderRadius: 'var(--radius)', border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text2)', cursor: 'pointer', fontSize: 13 }}
            onClick={() => confirmNewFlow(false)}
          >저장 안 함</button>
          <button
            style={{ flex: 1, padding: '9px', borderRadius: 'var(--radius)', border: '1px solid var(--purple-border)', background: 'var(--purple-bg)', color: 'var(--purple2)', cursor: 'pointer', fontSize: 13, fontWeight: 500 }}
            onClick={() => confirmNewFlow(true)}
          >저장 후 새로 만들기</button>
        </div>
      </Modal>

      {/* New collection modal */}
      <Modal open={newColModal} onClose={() => setNewColModal(false)} title="새 컬렉션">
        <FormGroup label="컬렉션 이름">
          <Input
            value={newColName}
            onChange={e => setNewColName(e.target.value)}
            placeholder="예: 쇼핑몰 API, 사내 서비스"
            autoFocus
            onKeyDown={e => {
              if (e.key === 'Enter' && newColName.trim()) {
                addCollection(newColName.trim())
                setNewColModal(false)
                setCollectionOpen(false)
              }
            }}
          />
        </FormGroup>
        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <Button style={{ flex: 1 }} onClick={() => setNewColModal(false)}>취소</Button>
          <Button variant="primary" style={{ flex: 1 }} onClick={() => {
            if (!newColName.trim()) return
            addCollection(newColName.trim())
            setNewColModal(false)
            setCollectionOpen(false)
          }}>만들기</Button>
        </div>
      </Modal>

      <Toast message={toast.msg} visible={toast.visible} />
    </div>
  )
}

function GridIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
}
function FlowIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><line x1="12" y1="7" x2="5" y2="17"/><line x1="12" y1="7" x2="19" y2="17"/></svg>
}
function SaveIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
}
function SaveIconSmall() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/></svg>
}
function PlayIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
}
function PlusIcon() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
}
function EnvIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"/></svg>
}
function FolderIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
}
function ChevronIcon({ open }) {
  return <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}><polyline points="6 9 12 15 18 9"/></svg>
}
function CloudIcon({ status }) {
  const color = status === 'ok' ? 'var(--green)' : status === 'error' ? 'var(--red)' : 'var(--text3)'
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>
}

function SunIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
}

function MoonIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
}
