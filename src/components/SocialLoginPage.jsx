import { useState } from 'react'
import styles from './SocialLoginPage.module.css'

// 서버가 OAuth 핸드셰이크 전체를 소유(redirect-callback). 이 페이지는 '개시'만 한다:
// state 발급 → 브라우저를 provider 개시 URL 로 이동 → 실 로그인 → 서버가 APP_DEEPLINK_BASE
// (oauth-result.html)로 redirect. 착지 페이지에서 memberNo/accessToken/isNewUser 확인.
// flow-tester 는 dev API 도메인(/flow-tester)에서 서빙 → origin 이 곧 API 호스트(same-origin).
const API = typeof window !== 'undefined' ? window.location.origin : ''
const V5 = '/api/v5/app'
const PROVIDERS = ['kakao', 'naver', 'google', 'apple']

async function post(path, body, token) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept-Language': 'ko',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: JSON.stringify(body || {}),
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json }
}

function launch(provider, state) {
  window.location.href = `${API}${V5}/oauth/providers/${provider}?state=${encodeURIComponent(state)}`
}

export default function SocialLoginPage() {
  const [pushToken, setPushToken] = useState('flow-tester')
  const [appVersion, setAppVersion] = useState('1.0.0')
  const [agreeAll, setAgreeAll] = useState(true)
  const [token, setToken] = useState('') // 연동/탈퇴/해제용 accessToken (착지 페이지에서 복사)
  const [reason, setReason] = useState('NO_LONGER_NEED_DIGITAL_KEY')
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState([])
  const push = (m) => setLog((l) => [{ t: new Date().toLocaleTimeString(), m }, ...l])

  // 1) 가입/로그인 (public) — 최초=가입(회원번호 발급), 재호출=로그인
  async function authStart(provider) {
    setBusy(true)
    try {
      let agreementIds = []
      if (agreeAll) {
        const terms = await fetch(`${API}${V5}/terms`, { headers: { 'Accept-Language': 'ko' } })
          .then((r) => r.json())
          .catch(() => ({}))
        agreementIds = (terms.rows || []).map((t) => t._id).filter(Boolean)
        push(`약관 ${agreementIds.length}건 동의`)
      }
      const r = await post(`${V5}/oauth/state/auth`, { pushToken, appVersion, agreementIds })
      const state = r.json?.row?.state
      if (r.status !== 200 || !state) {
        return push(`state/auth 오류 ${r.status}: ${r.json?.message || 'OAUTH_STATE_SECRET 미설정?'}`)
      }
      push(`${provider} 개시 → 실 로그인 후 oauth-result.html 착지`)
      launch(provider, state)
    } finally {
      setBusy(false)
    }
  }

  // 2/3) 연동(link)·탈퇴(withdraw) — Bearer 필요. 콜백에서 재-OAuth 본인확인 후 처리.
  async function sessionStart(provider, mode) {
    if (!token) return push('accessToken 필요 — 먼저 가입/로그인 후 착지 페이지에서 복사')
    setBusy(true)
    try {
      const body = mode === 'withdraw' ? { mode, reason } : { mode }
      const r = await post(`${V5}/oauth/state/session`, body, token)
      const state = r.json?.row?.state
      if (r.status !== 200 || !state) {
        return push(`state/session(${mode}) 오류 ${r.status}: ${r.json?.message || ''}`)
      }
      push(`${mode} 개시(${provider}) → 실 로그인 후 착지 (linked/withdrawn)`)
      launch(provider, state)
    } finally {
      setBusy(false)
    }
  }

  // 4) 연동 해제 (Bearer, redirect 없음 — 인라인 결과)
  async function unlink(provider) {
    if (!token) return push('accessToken 필요')
    setBusy(true)
    try {
      const r = await post(`${V5}/customer/me/accounts/${provider}/unlink`, {}, token)
      push(r.status === 200 ? `${provider} 연동 해제 성공 ✅` : `연동 해제 오류 ${r.status}: ${r.json?.message || ''}`)
    } finally {
      setBusy(false)
    }
  }

  const snsBtns = (onClick) =>
    PROVIDERS.map((p) => (
      <button key={p} className={`${styles.sns} ${styles[p]}`} disabled={busy} onClick={() => onClick(p)}>
        {p.toUpperCase()}
      </button>
    ))

  return (
    <div className={styles.wrap}>
      <h1 className={styles.title}>소셜 로그인 테스트 (실 OAuth)</h1>
      <p className={styles.desc}>
        서버가 OAuth 핸드셰이크를 소유합니다. 버튼 → state 발급 → 실 provider 로그인 → 결과는 <b>oauth-result.html</b> 에 착지.
        연동/탈퇴/해제는 착지 페이지에서 받은 accessToken 을 아래에 붙여넣고 사용하세요.
      </p>

      <section className={styles.card}>
        <div className={styles.step}>1. 가입 / 로그인 (최초=가입, 재호출=로그인)</div>
        <div className={styles.row}>
          <input className={styles.in} value={pushToken} onChange={(e) => setPushToken(e.target.value)} placeholder="pushToken" />
          <input className={styles.in} value={appVersion} onChange={(e) => setAppVersion(e.target.value)} placeholder="appVersion" style={{ maxWidth: 120 }} />
        </div>
        <label className={styles.row} style={{ cursor: 'pointer' }}>
          <input type="checkbox" checked={agreeAll} onChange={(e) => setAgreeAll(e.target.checked)} />
          <span style={{ fontSize: 13 }}>약관 전체 동의 (GET /terms 전체 _id)</span>
        </label>
        <div className={styles.btnRow} style={{ marginTop: 12 }}>{snsBtns(authStart)}</div>
      </section>

      <section className={styles.card}>
        <div className={styles.step}>accessToken (연동/탈퇴/해제용 — 착지 페이지에서 복사)</div>
        <div className={styles.row}>
          <input className={styles.in} value={token} onChange={(e) => setToken(e.target.value)} placeholder="Bearer 없이 accessToken 원문" />
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.step}>2. 계정 연동 (link — 로그인 상태에서 다른 provider 연결)</div>
        <div className={styles.btnRow}>{snsBtns((p) => sessionStart(p, 'link'))}</div>
      </section>

      <section className={styles.card}>
        <div className={styles.step}>3. 회원 탈퇴 (withdraw — 연결된 provider로 본인확인)</div>
        <div className={styles.row}>
          <input className={styles.in} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="탈퇴 사유(reason)" />
        </div>
        <div className={styles.btnRow} style={{ marginTop: 10 }}>{snsBtns((p) => sessionStart(p, 'withdraw'))}</div>
      </section>

      <section className={styles.card}>
        <div className={styles.step}>4. 연동 해제 (unlink — OAuth 없이 즉시)</div>
        <div className={styles.btnRow}>{snsBtns(unlink)}</div>
        <div className={styles.mono}>* 계정이 1개뿐이면 최소 1개 유지 규칙으로 해제 불가</div>
      </section>

      <section className={styles.card}>
        <div className={styles.step}>로그</div>
        <div className={styles.logbox}>
          {log.map((l, i) => (
            <div key={i} className={styles.logline}>
              <span>{l.t}</span>
              {l.m}
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
