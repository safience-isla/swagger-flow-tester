import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { resolveVars, normalizeUrl } from './envUtils'
import { supabase } from './supabase'
import { DEFAULT_FLOWS } from './defaultFlows'

// ── Supabase sync helpers (fire-and-forget) ──────────────────────────────────
function sbUpsertModule(m, cid) {
  if (!m) return
  supabase.from('modules').upsert({
    id: m.id, name: m.name, url: m.url,
    status: m.status, apis: m.apis ?? [], auths: m.auths ?? [],
    collection_id: cid,
  }).then(({ error }) => { if (error) console.warn('[sb] module upsert:', error.message) })
}
function sbDeleteModule(id) {
  supabase.from('modules').delete().eq('id', id)
    .then(({ error }) => { if (error) console.warn('[sb] module delete:', error.message) })
}
function sbUpsertFlow(f, cid) {
  if (!f) return
  supabase.from('saved_flows').upsert({
    id: f.id, name: f.name,
    steps: f.steps ?? [], connections: f.connections ?? [],
    step_count: f.stepCount ?? 0, module_names: f.moduleNames ?? [],
    saved_at: f.savedAt ?? null,
    collection_id: cid,
  }).then(({ error }) => { if (error) console.warn('[sb] flow upsert:', error.message) })
}
function sbDeleteFlow(id) {
  supabase.from('saved_flows').delete().eq('id', id)
    .then(({ error }) => { if (error) console.warn('[sb] flow delete:', error.message) })
}
function sbUpsertEnv(e, cid) {
  if (!e) return
  supabase.from('environments').upsert({ id: e.id, name: e.name, vars: e.vars ?? [], collection_id: cid })
    .then(({ error }) => { if (error) console.warn('[sb] env upsert:', error.message) })
}
function sbDeleteEnv(id) {
  supabase.from('environments').delete().eq('id', id)
    .then(({ error }) => { if (error) console.warn('[sb] env delete:', error.message) })
}
function sbSetSetting(key, value) {
  supabase.from('app_settings').upsert({ key, value: value ?? null })
    .then(({ error }) => { if (error) console.warn('[sb] setting upsert:', error.message) })
}
function sbUpsertPreset(p, cid) {
  if (!p) return
  supabase.from('api_presets').upsert({
    id: p.id, aid: p.aid, mid: p.mid, name: p.name,
    params: p.params ?? [], body_mode: p.bodyMode ?? 'params',
    body_raw: p.bodyRaw ?? '', req_headers: p.reqHeaders ?? [],
    collection_id: cid,
  }).then(({ error }) => { if (error) console.warn('[sb] preset upsert:', error.message) })
}
function sbDeletePreset(id) {
  supabase.from('api_presets').delete().eq('id', id)
    .then(({ error }) => { if (error) console.warn('[sb] preset delete:', error.message) })
}
function sbUpsertCollection(c) {
  if (!c) return
  supabase.from('collections').upsert({ id: c.id, name: c.name })
    .then(({ error }) => { if (error) console.warn('[sb] collection upsert:', error.message) })
}
function sbDeleteCollection(id) {
  supabase.from('collections').delete().eq('id', id)
    .then(({ error }) => { if (error) console.warn('[sb] collection delete:', error.message) })
}

// ── Swagger fetching ──────────────────────────────────────────────────────────
async function fetchSwaggerApis(baseUrl, moduleId) {
  let cleanBase = baseUrl.trim().replace(/\/$/, '')
  
  // 사용자가 실수로 Swagger UI 주소까지 입력한 경우 자동으로 잘라냄
  // 예: http://localhost:3000/api-docs -> http://localhost:3000
  const swaggerUiPaths = ['/api-docs', '/swagger-ui', '/swagger-ui.html', '/swagger']
  for (const p of swaggerUiPaths) {
    if (cleanBase.toLowerCase().endsWith(p)) {
      cleanBase = cleanBase.slice(0, -p.length)
      break
    }
  }

  const candidates = ['/v3/api-docs', '/api-docs-json', '/v2/api-docs', '/api-docs', '/swagger.json', '/api/app-docs-json']
  
  for (const path of candidates) {
    const url = cleanBase + path
    try {
      console.log(`[Swagger] Fetching: ${url}`)
      const res = await fetch(url)
      
      if (!res.ok) {
        console.warn(`[Swagger] ${url} -> status ${res.status}`)
        continue
      }
      
      const ct = (res.headers.get('content-type') || '').toLowerCase()
      // HTML일 경우(UI 페이지인 경우) 건너뜀
      if (ct.includes('text/html')) {
        console.warn(`[Swagger] ${url} returned HTML. Skipping...`)
        continue
      }

      const data = await res.json()
      // JSON 형식이지만 Swagger 데이터가 아닌 경우 (데이터 안에 paths나 openapi/swagger 필드가 있어야 함)
      if (!data.paths && !data.swagger && !data.openapi) {
        console.warn(`[Swagger] ${url} returned JSON but not a valid Swagger spec.`)
        continue
      }

      console.log(`[Swagger] Successfully loaded from ${url}`)
      const parsed = parseSwagger(data, moduleId)
      return { ...parsed, cleanBase }
    } catch (err) {
      // CORS 오류인 경우 여기서 잡힘
      console.error(`[Swagger] Error fetching from ${url}:`, err.message)
    }
  }
  return null
}

// 모듈ID + 메서드 + 경로 기반 안정적인 API ID (새로고침해도 변하지 않음)
function stableApiId(moduleId, method, path) {
  const str = moduleId + '|' + method.toUpperCase() + '|' + path
  let h = 0
  for (let i = 0; i < str.length; i++) { h = Math.imul(31, h) + str.charCodeAt(i) | 0 }
  return 'a' + (h >>> 0).toString(36)
}

// $ref 해석: '#/components/schemas/Foo' → 실제 스키마 객체
function resolveRef(schema, data) {
  if (!schema || typeof schema.$ref !== 'string') return schema
  const path = schema.$ref.replace(/^#\//, '').split('/')
  let cur = data
  for (const seg of path) {
    cur = cur?.[decodeURIComponent(seg.replace(/~1/g, '/').replace(/~0/g, '~'))]
    if (cur == null) return null
  }
  return cur
}

function parseSwaggerSecuritySchemes(data) {
  const detected = []
  const seen = new Set()
  const v3Schemes = data.components?.securitySchemes || {}
  for (const [name, scheme] of Object.entries(v3Schemes)) {
    if (scheme.type === 'http' && scheme.scheme?.toLowerCase() === 'bearer') {
      if (!seen.has('Authorization')) { detected.push({ key: 'Authorization', val: '', hint: 'Bearer', schemeName: name, schemeType: 'http bearer' }); seen.add('Authorization') }
    } else if (scheme.type === 'http' && scheme.scheme?.toLowerCase() === 'basic') {
      if (!seen.has('Authorization')) { detected.push({ key: 'Authorization', val: '', hint: 'Basic', schemeName: name, schemeType: 'http basic' }); seen.add('Authorization') }
    } else if (scheme.type === 'apiKey' && scheme.in === 'header' && scheme.name) {
      if (!seen.has(scheme.name)) { detected.push({ key: scheme.name, val: '', hint: 'apiKey', schemeName: name, schemeType: 'apiKey' }); seen.add(scheme.name) }
    } else if (scheme.type === 'oauth2') {
      if (!seen.has('Authorization')) { detected.push({ key: 'Authorization', val: '', hint: 'Bearer', schemeName: name, schemeType: 'oauth2' }); seen.add('Authorization') }
    } else if (scheme.type === 'openIdConnect') {
      if (!seen.has('Authorization')) { detected.push({ key: 'Authorization', val: '', hint: 'Bearer', schemeName: name, schemeType: 'openIdConnect' }); seen.add('Authorization') }
    }
  }
  const v2Defs = data.securityDefinitions || {}
  for (const [name, scheme] of Object.entries(v2Defs)) {
    if (scheme.type === 'apiKey' && scheme.in === 'header' && scheme.name) {
      if (!seen.has(scheme.name)) { detected.push({ key: scheme.name, val: '', hint: 'apiKey', schemeName: name, schemeType: 'apiKey' }); seen.add(scheme.name) }
    } else if (scheme.type === 'oauth2') {
      if (!seen.has('Authorization')) { detected.push({ key: 'Authorization', val: '', hint: 'Bearer', schemeName: name, schemeType: 'oauth2' }); seen.add('Authorization') }
    } else if (scheme.type === 'basic') {
      if (!seen.has('Authorization')) { detected.push({ key: 'Authorization', val: '', hint: 'Basic', schemeName: name, schemeType: 'http basic' }); seen.add('Authorization') }
    }
  }
  return detected
}

// content map에서 application/json* 첫 매칭 반환
function pickJsonContent(content) {
  if (!content) return null
  // application/json 우선, 그 다음 application/json;* 변형, 마지막으로 */* fallback
  const entry = content['application/json']
    ?? Object.entries(content).find(([k]) => k.startsWith('application/json'))?.[1]
    ?? content['*/*']
    ?? null
  // binary 포맷은 JSON 예시 불필요
  if (entry?.schema?.format === 'binary' || entry?.schema?.format === 'byte') return null
  return entry
}

function extractRequestExample(op, data) {
  const bodyContent = pickJsonContent(op.requestBody?.content)
  if (bodyContent) {
    const schema = resolveRef(bodyContent.schema, data) ?? bodyContent.schema
    const ex = bodyContent.example
      ?? bodyContent.examples?.[Object.keys(bodyContent.examples ?? {})[0]]?.value
      ?? schema?.example
      ?? buildExampleFromSchema(schema, data)
    if (ex != null) return ex
  }
  // Swagger v2 body param
  const bodyParam = (op.parameters || []).find(p => p.in === 'body')
  if (bodyParam) {
    const schema = resolveRef(bodyParam.schema, data) ?? bodyParam.schema
    return bodyParam.example ?? schema?.example ?? buildExampleFromSchema(schema, data) ?? null
  }
  return null
}

function extractResponseExample(op, data) {
  const responses = op.responses || {}
  const code = ['200', '201', '202', '204'].find(c => responses[c]) ?? Object.keys(responses)[0]
  if (!code) return null
  const resp = resolveRef(responses[code], data) ?? responses[code]
  if (!resp) return null
  const rc = pickJsonContent(resp.content)
  if (rc) {
    const schema = resolveRef(rc.schema, data) ?? rc.schema
    return rc.example
      ?? rc.examples?.[Object.keys(rc.examples ?? {})[0]]?.value
      ?? schema?.example
      ?? buildExampleFromSchema(schema, data)
      ?? null
  }
  // Swagger v2
  const schema = resolveRef(resp.schema, data) ?? resp.schema
  return resp.examples?.['application/json']
    ?? schema?.example
    ?? buildExampleFromSchema(schema, data)
    ?? null
}

function buildExampleFromSchema(schema, data, depth = 0) {
  if (!schema || depth > 6) return null
  schema = resolveRef(schema, data) ?? schema
  if (!schema) return null
  if (schema.example != null) return schema.example
  // allOf: 프로퍼티 병합
  if (schema.allOf) {
    const merged = {}
    for (const sub of schema.allOf) {
      const ex = buildExampleFromSchema(sub, data, depth + 1)
      if (ex && typeof ex === 'object' && !Array.isArray(ex)) Object.assign(merged, ex)
    }
    return Object.keys(merged).length > 0 ? merged : null
  }
  // oneOf / anyOf: 첫 번째 옵션 사용
  if (schema.oneOf || schema.anyOf) {
    const options = schema.oneOf ?? schema.anyOf
    for (const opt of options) {
      const ex = buildExampleFromSchema(opt, data, depth + 1)
      if (ex != null) return ex
    }
    return null
  }
  if (schema.type === 'object' || schema.properties) {
    const props = schema.properties || {}
    const obj = {}
    for (const [k, v] of Object.entries(props)) {
      const resolved = resolveRef(v, data) ?? v
      obj[k] = buildExampleFromSchema(resolved, data, depth + 1) ?? exampleScalar(resolved)
    }
    return Object.keys(obj).length > 0 ? obj : null
  }
  if (schema.type === 'array' || schema.items) {
    const items = schema.items ? (resolveRef(schema.items, data) ?? schema.items) : null
    const item = items ? (buildExampleFromSchema(items, data, depth + 1) ?? exampleScalar(items)) : ''
    return [item]
  }
  // 스칼라 타입이거나 타입 없는 경우
  const scalar = exampleScalar(schema)
  return scalar !== '' ? scalar : null
}

function exampleScalar(schema = {}) {
  if (schema.example != null) return schema.example
  if (schema.enum?.length) return schema.enum[0]
  switch (schema.type) {
    case 'integer': case 'number': return 0
    case 'boolean': return false
    default: return ''
  }
}

// 응답 스키마에서 바인딩 가능한 필드 목록 추출
function extractResponseFields(op, data) {
  const responses = op.responses || {}
  const code = ['200', '201', '202', '204'].find(c => responses[c]) ?? Object.keys(responses)[0]
  if (!code) return {}
  const resp = resolveRef(responses[code], data) ?? responses[code]
  if (!resp) return {}
  const schema = (() => {
    const rc = pickJsonContent(resp.content)
    if (rc) return resolveRef(rc.schema, data) ?? rc.schema
    return resolveRef(resp.schema, data) ?? resp.schema
  })()
  if (!schema) return {}
  return flattenSchemaFields(schema, data, '', 0)
}

function flattenSchemaFields(schema, data, prefix, depth) {
  if (!schema || depth > 3) return {}
  schema = resolveRef(schema, data) ?? schema
  const fields = {}
  if (schema.allOf) {
    for (const sub of schema.allOf) Object.assign(fields, flattenSchemaFields(sub, data, prefix, depth))
    return fields
  }
  const props = schema.properties || (schema.type === 'object' ? {} : null)
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      const key = prefix ? `${prefix}.${k}` : k
      fields[key] = true
      const resolved = resolveRef(v, data) ?? v
      if (resolved.type === 'object' || resolved.properties || resolved.allOf) {
        Object.assign(fields, flattenSchemaFields(resolved, data, key, depth + 1))
      }
    }
  }
  return fields
}

function parseSwagger(data, moduleId = '') {
  const apis = []
  const paths = data.paths || {}
  const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch']
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (!HTTP_METHODS.includes(method)) continue
      // query/path params — enum, type 포함
      const params = (op.parameters || []).filter(p => p.in !== 'header').map(p => {
        const schema = resolveRef(p.schema, data) ?? p.schema ?? p
        const enums = schema?.enum ?? p.enum ?? null
        const type = schema?.type ?? p.type ?? null
        return { key: p.name, ...(enums ? { enum: enums } : {}), ...(type ? { type } : {}), ...(p.required ? { required: true } : {}) }
      })
      // body params from requestBody schema ($ref 해석 포함)
      const rawBodySchema = pickJsonContent(op.requestBody?.content)?.schema
      const bodySchema = resolveRef(rawBodySchema, data) ?? rawBodySchema
      function pushBodyProp(k, propSchema, requiredList) {
        if (params.find(p => p.key === k)) return
        const resolved = resolveRef(propSchema, data) ?? propSchema
        const enums = resolved?.enum ?? null
        const type = resolved?.type ?? null
        const required = Array.isArray(requiredList) && requiredList.includes(k)
        params.push({ key: k, ...(enums ? { enum: enums } : {}), ...(type ? { type } : {}), ...(required ? { required: true } : {}) })
      }
      if (bodySchema?.properties) {
        Object.entries(bodySchema.properties).forEach(([k, v]) => pushBodyProp(k, v, bodySchema.required))
      } else if (bodySchema?.allOf) {
        for (const sub of bodySchema.allOf) {
          const resolved = resolveRef(sub, data) ?? sub
          Object.entries(resolved.properties || {}).forEach(([k, v]) => pushBodyProp(k, v, resolved.required))
        }
      }
      apis.push({
        id: stableApiId(moduleId, method, path),
        method: method.toUpperCase(), path,
        name: op.summary || op.operationId || path,
        tags: op.tags || [],
        summary: op.summary || '',
        params,
        response: extractResponseFields(op, data),
        requestExample: extractRequestExample(op, data),
        responseExample: extractResponseExample(op, data),
      })
    }
  }
  const tagMeta = {}
  if (data.tags && Array.isArray(data.tags)) {
    data.tags.forEach(t => {
      if (t.name) tagMeta[t.name] = t.description || ''
    })
  }
  return { apis, detectedAuths: parseSwaggerSecuritySchemes(data), tagMeta }
}

// ── Store ─────────────────────────────────────────────────────────────────────
export const useStore = create(
  persist(
    (set, get) => ({

      // ── Collections ───────────────────────────────────────────────────────
      collections: [],
      activeCollectionId: null,

      // ── Theme ────────────────────────────────────────────────────────────
      theme: 'beige', // 'dark' | 'beige'
      setTheme: (t) => set({ theme: t }),

      addCollection: async (name) => {
        const id = 'col_' + Date.now()
        const col = { id, name }
        set(s => ({ collections: [...s.collections, col] }))
        sbUpsertCollection(col)
        await get().switchCollection(id)
      },

      deleteCollection: async (id) => {
        const { collections, activeCollectionId } = get()
        if (collections.length <= 1) return
        set(s => ({ collections: s.collections.filter(c => c.id !== id) }))
        sbDeleteCollection(id)
        if (activeCollectionId === id) {
          const remaining = collections.filter(c => c.id !== id)
          await get().switchCollection(remaining[0].id)
        }
      },

      renameCollection: (id, name) => {
        set(s => ({ collections: s.collections.map(c => c.id === id ? { ...c, name } : c) }))
        const col = get().collections.find(c => c.id === id)
        if (col) sbUpsertCollection(col)
      },

      switchCollection: async (id) => {
        set({
          activeCollectionId: id,
          modules: [], savedFlows: [], envs: [], apiPresets: [],
          activeEnvId: null, flowSteps: [], connections: [], flowName: '',
          supaStatus: 'loading',
        })
        sbSetSetting('activeCollectionId', id)
        await get()._loadCollectionData(id, null)
      },

      // ── Supabase sync status ──────────────────────────────────────────────
      supaStatus: 'idle', // 'idle' | 'loading' | 'ok' | 'error'

      hydrateFromSupabase: async () => {
        set({ supaStatus: 'loading' })
        try {
          // 1. 컬렉션 목록 로드
          const colsRes = await supabase.from('collections').select('*').order('created_at')
          if (colsRes.error) { set({ supaStatus: 'error' }); return }

          let collections = (colsRes.data || []).map(c => ({ id: c.id, name: c.name }))

          // 컬렉션이 없으면 기본 컬렉션 생성
          if (collections.length === 0) {
            const def = { id: 'col_default', name: '기본 컬렉션' }
            await supabase.from('collections').upsert(def)
            collections = [def]
          }

          // 2. 활성 컬렉션 결정
          const settingsRes = await supabase.from('app_settings').select('*')
          const settings = Object.fromEntries((settingsRes.data || []).map(s => [s.key, s.value]))
          let activeCollectionId = get().activeCollectionId || settings['activeCollectionId'] || collections[0].id
          if (!collections.find(c => c.id === activeCollectionId)) activeCollectionId = collections[0].id

          set({ collections, activeCollectionId })

          // 3. 활성 컬렉션 데이터 로드
          await get()._loadCollectionData(activeCollectionId, settings)
        } catch (err) {
          console.warn('[sb] hydrate exception:', err)
          set({ supaStatus: 'error' })
        }
      },

      _loadCollectionData: async (cid, cachedSettings) => {
        // 재시드 전 기존 모듈의 인증 헤더 값(로그인으로 받은 토큰 등)을 이름 기준으로 보존
        const prevAuthsByName = new Map((get().modules || []).map(m => [m.name, m.auths || []]))
        const [modsRes, flowsRes, envsRes, settingsRes, presetsRes] = await Promise.all([
          supabase.from('modules').select('*').eq('collection_id', cid),
          supabase.from('saved_flows').select('*').eq('collection_id', cid),
          supabase.from('environments').select('*').eq('collection_id', cid),
          cachedSettings ? Promise.resolve({ data: Object.entries(cachedSettings).map(([key, value]) => ({ key, value })) })
            : supabase.from('app_settings').select('*'),
          supabase.from('api_presets').select('*').eq('collection_id', cid),
        ])
        if (modsRes.error || flowsRes.error || envsRes.error) {
          set({ supaStatus: 'error' }); return
        }
        const modules = (modsRes.data || []).map(m => ({
          id: m.id, name: m.name, url: m.url,
          status: m.status ?? 'ok', apis: m.apis ?? [], auths: m.auths ?? [],
        }))
        const savedFlows = (flowsRes.data || [])
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
          .map(f => ({
            id: f.id, name: f.name,
            steps: f.steps ?? [], connections: f.connections ?? [],
            stepCount: f.step_count ?? 0, moduleNames: f.module_names ?? [],
            savedAt: f.saved_at ?? '',
          }))
        const envs = (envsRes.data || []).map(e => ({ id: e.id, name: e.name, vars: e.vars ?? [] }))
        const settings = Object.fromEntries((settingsRes.data || []).map(s => [s.key, s.value]))
        const activeEnvId = settings[`activeEnvId_${cid}`] ?? settings['activeEnvId'] ?? (envs[0]?.id ?? null)

        const validMids = new Set(modules.map(m => m.id))
        const currentFlowSteps = get().flowSteps
        const validFlowSteps = currentFlowSteps.filter(s => s.type === 'header-config' || validMids.has(s.mid))
        const validIds = new Set(validFlowSteps.map(s => s.id))
        const validConnections = get().connections.filter(c => validIds.has(c.fromId) && validIds.has(c.toId))

        const apiPresets = presetsRes.error
          ? []
          : (presetsRes.data || []).map(p => ({
              id: p.id, aid: p.aid, mid: p.mid, name: p.name,
              params: p.params ?? [], bodyMode: p.body_mode ?? 'params',
              bodyRaw: p.body_raw ?? '', reqHeaders: p.req_headers ?? [],
              savedAt: p.created_at ?? '',
            }))

        set({ modules, savedFlows, envs, activeEnvId, apiPresets, supaStatus: 'ok',
          flowSteps: validFlowSteps, connections: validConnections })

        // 기본 모듈 시드: 등록된 모듈이 없으면 현재 origin(= same-origin API 서버)을 자동 등록.
        // dev(/flow-tester/)·로컬 어디서 열어도 window.location.origin 이 곧 API 호스트라 바로 연결됨.
        // ponytail: origin 기반이라 하드코딩 없음. 다른 백엔드에 쓰려면 이 모듈을 지우거나 URL 수정.
        if (modules.length === 0 && typeof window !== 'undefined' && window.location?.origin) {
          await get().addModule('mobis-app', window.location.origin)
          // 이전 세션의 인증 헤더 값(토큰) 복원 → 새로고침 후에도 전역 Authorization 유지
          const seeded = get().modules.find(m => m.name === 'mobis-app')
          const prevAuths = prevAuthsByName.get('mobis-app')
          if (seeded && prevAuths) {
            prevAuths.forEach(a => { if (a.key && a.val) get().setModuleAuthValue(seeded.id, a.key, a.val) })
          }
          get().seedDefaultFlows() // 모듈 apis 로드 후 기본 플로우(회원가입/로그인) 저장
        }
      },

      // 기본 플로우(회원가입/로그인)를 저장된 플로우에 시드. 이미 있으면 건너뜀.
      seedDefaultFlows: () => {
        const existing = new Set(get().savedFlows.map(f => f.name))
        const toSeed = DEFAULT_FLOWS.filter(f => !existing.has(f.data.name))
        if (toSeed.length === 0) return
        const prev = { steps: get().flowSteps, connections: get().connections, name: get().flowName }
        for (const f of toSeed) {
          const res = get().importFlow(f.data) // 현재 모듈 apis 기준으로 resolve → flowSteps 세팅
          if (res?.ok) get().saveFlow(f.data.name)
        }
        set({ flowSteps: prev.steps, connections: prev.connections, flowName: prev.name }) // 빌더 원복
      },

      // ── Modules ───────────────────────────────────────────────────────────
      modules: [],
      addModule: async (name, url) => {
        const id = 'm' + Date.now()
        const { activeCollectionId } = get()
        set(s => ({ modules: [...s.modules, { id, name, url, status: 'loading', apis: [] }] }))
        const resolvedUrl = normalizeUrl(get().resolveEnvVars(url))
        const result = await fetchSwaggerApis(resolvedUrl, id)
        set(s => ({
          modules: s.modules.map(m => {
            if (m.id !== id) return m
            const ok = result !== null
            const existingAuths = m.auths || []
            const auths = ok && existingAuths.length === 0 ? (result.detectedAuths || []) : existingAuths
            return {
              ...m,
              url: result?.cleanBase || m.url, // 자동 정리된 URL 반영
              apis: result?.apis ?? [],
              tagMeta: result?.tagMeta ?? {},
              status: ok ? 'ok' : 'error',
              auths
            }
          })
        }))
        sbUpsertModule(get().modules.find(m => m.id === id), activeCollectionId)
      },
      removeModule: (id) => {
        set(s => ({ modules: s.modules.filter(m => m.id !== id) }))
        sbDeleteModule(id)
      },
      updateModule: (id, patch) => {
        set(s => ({ modules: s.modules.map(m => m.id === id ? { ...m, ...patch } : m) }))
        sbUpsertModule(get().modules.find(m => m.id === id), get().activeCollectionId)
      },
      renameModule: (id, name) => {
        set(s => ({ modules: s.modules.map(m => m.id === id ? { ...m, name } : m) }))
        sbUpsertModule(get().modules.find(m => m.id === id), get().activeCollectionId)
      },
      refreshModule: async (id) => {
        const mod = get().modules.find(m => m.id === id)
        if (!mod) return
        const oldApis = mod.apis || []
        set(s => ({ modules: s.modules.map(m => m.id === id ? { ...m, status: 'loading' } : m) }))
        const resolvedUrl = normalizeUrl(get().resolveEnvVars(mod.url))
        const result = await fetchSwaggerApis(resolvedUrl, id)
        set(s => ({
          modules: s.modules.map(m => {
            if (m.id !== id) return m
            const ok = result !== null
            const existingAuths = m.auths || []
            let newAuths = existingAuths
            if (ok && result.detectedAuths?.length > 0) {
              const existingKeys = new Set(existingAuths.map(a => a.key).filter(Boolean))
              const toAdd = result.detectedAuths.filter(a => a.key && !existingKeys.has(a.key))
              newAuths = existingAuths.map(a => {
                const detected = result.detectedAuths.find(d => d.key === a.key)
                return detected ? { ...a, hint: detected.hint } : a
              })
              newAuths = [...newAuths, ...toAdd]
            }
            return {
              ...m,
              url: result?.cleanBase || m.url, // 자동 정리된 URL 반영
              apis: result?.apis ?? m.apis,
              tagMeta: result?.tagMeta ?? {},
              status: ok ? 'ok' : 'error',
              auths: newAuths
            }
          })
        }))

        // API ID가 바뀐 경우 프리셋의 aid도 마이그레이션
        if (result?.apis) {
          const idMap = {} // oldId → newId
          for (const oldApi of oldApis) {
            const matched = result.apis.find(a => a.method === oldApi.method && a.path === oldApi.path)
            if (matched && matched.id !== oldApi.id) idMap[oldApi.id] = matched.id
          }
          if (Object.keys(idMap).length > 0) {
            set(s => ({
              apiPresets: s.apiPresets.map(p =>
                idMap[p.aid] ? { ...p, aid: idMap[p.aid] } : p
              )
            }))
            // Supabase에도 반영
            get().apiPresets
              .filter(p => Object.values(idMap).includes(p.aid))
              .forEach(p => sbUpsertPreset(p, get().activeCollectionId))
          }
        }

        sbUpsertModule(get().modules.find(m => m.id === id), get().activeCollectionId)
      },

      // ── Module auth headers ───────────────────────────────────────────────
      addModuleAuth: (mid) => {
        set(s => ({ modules: s.modules.map(m => m.id !== mid ? m : { ...m, auths: [...(m.auths || []), { key: '', val: '' }] }) }))
        sbUpsertModule(get().modules.find(m => m.id === mid), get().activeCollectionId)
      },
      removeModuleAuth: (mid, idx) => {
        set(s => ({ modules: s.modules.map(m => m.id !== mid ? m : { ...m, auths: (m.auths || []).filter((_, i) => i !== idx) }) }))
        sbUpsertModule(get().modules.find(m => m.id === mid), get().activeCollectionId)
      },
      updateModuleAuth: (mid, idx, field, val) => {
        set(s => ({ modules: s.modules.map(m => m.id !== mid ? m : { ...m, auths: (m.auths || []).map((a, i) => i !== idx ? a : { ...a, [field]: val }) }) }))
        sbUpsertModule(get().modules.find(m => m.id === mid), get().activeCollectionId)
      },
      // 모듈 전역 인증 헤더 값 설정 (key 있으면 갱신, 없으면 추가). 실행 중 setAuth 로 토큰 주입용.
      setModuleAuthValue: (mid, key, val) => {
        set(s => ({ modules: s.modules.map(m => {
          if (m.id !== mid) return m
          const auths = m.auths ? [...m.auths] : []
          const i = auths.findIndex(a => a.key === key)
          if (i >= 0) auths[i] = { ...auths[i], val }
          else auths.push({ key, val })
          return { ...m, auths }
        }) }))
        sbUpsertModule(get().modules.find(m => m.id === mid), get().activeCollectionId)
      },
      // 소셜 로그인 등으로 받은 accessToken 을 대상 모듈의 전역 Authorization 으로 반영.
      // raw 토큰 원문 저장(Bearer 는 실행 시 RunPage 가 부착) → 빌더·저장된 플로우 모든 스텝에 자동 적용.
      // 대상 = origin 이 앱과 같은 모듈(없으면 전체). hint/schemeType 명시로 Bearer 부착 보장.
      // 반환: 적용된 모듈 수. 0 이면 아직 모듈이 없음 → 호출측이 pending 토큰을 유지하고 재시도해야 함.
      applyAuthToken: (rawToken) => {
        if (!rawToken) return 0
        const token = String(rawToken).replace(/^Bearer\s+/i, '')
        const appOrigin = typeof window !== 'undefined' ? window.location.origin : ''
        const sameOrigin = (m) => {
          try { return new URL(normalizeUrl(get().resolveEnvVars(m.url))).origin === appOrigin }
          catch { return false }
        }
        let targets = get().modules.filter(sameOrigin)
        if (targets.length === 0) targets = get().modules
        if (targets.length === 0) return 0 // 모듈이 아직 로드/시드되지 않음
        const targetIds = new Set(targets.map(t => t.id))
        set(s => ({ modules: s.modules.map(m => {
          if (!targetIds.has(m.id)) return m
          const auths = m.auths ? [...m.auths] : []
          const patch = { key: 'Authorization', val: token, hint: 'Bearer', schemeType: 'http bearer' }
          const i = auths.findIndex(a => a.key === 'Authorization')
          if (i >= 0) auths[i] = { ...auths[i], ...patch }
          else auths.push(patch)
          return { ...m, auths }
        }) }))
        targetIds.forEach(id => sbUpsertModule(get().modules.find(m => m.id === id), get().activeCollectionId))
        return targetIds.size
      },

      // 저장된 전역 Authorization 토큰 삭제(로그아웃). 모든 모듈 auth 의 Authorization 값을 비우고
      // Supabase/localStorage 에 반영 + 브릿지 pending 토큰도 제거. 반환: 값을 지운 모듈 수.
      clearAuthToken: () => {
        const ids = []
        set(s => ({ modules: s.modules.map(m => {
          const auths = m.auths || []
          const i = auths.findIndex(a => a.key === 'Authorization' && a.val)
          if (i < 0) return m
          ids.push(m.id)
          const next = [...auths]
          next[i] = { ...next[i], val: '' }
          return { ...m, auths: next }
        }) }))
        ids.forEach(id => sbUpsertModule(get().modules.find(m => m.id === id), get().activeCollectionId))
        try { localStorage.removeItem('ft:pendingToken') } catch { /* 무시 */ }
        return ids.length
      },

      // ── Environments ──────────────────────────────────────────────────────
      envs: [],
      activeEnvId: null,
      addEnv: (name) => {
        const id = 'e' + Date.now()
        const cid = get().activeCollectionId
        set(s => {
          const isFirst = s.envs.length === 0
          return { envs: [...s.envs, { id, name, vars: [] }], activeEnvId: isFirst ? id : s.activeEnvId }
        })
        sbUpsertEnv({ id, name, vars: [] }, cid)
        if (get().envs.length === 1) sbSetSetting(`activeEnvId_${cid}`, id)
      },
      removeEnv: (id) => {
        const cid = get().activeCollectionId
        set(s => {
          const remaining = s.envs.filter(e => e.id !== id)
          const newActive = s.activeEnvId === id ? (remaining[0]?.id ?? null) : s.activeEnvId
          return { envs: remaining, activeEnvId: newActive }
        })
        sbDeleteEnv(id)
        sbSetSetting(`activeEnvId_${cid}`, get().activeEnvId)
      },
      renameEnv: (id, name) => {
        set(s => ({ envs: s.envs.map(e => e.id === id ? { ...e, name } : e) }))
        sbUpsertEnv(get().envs.find(e => e.id === id), get().activeCollectionId)
      },
      setActiveEnv: (id) => {
        const cid = get().activeCollectionId
        set({ activeEnvId: id })
        sbSetSetting(`activeEnvId_${cid}`, id)
      },
      addEnvVar: (envId) => {
        set(s => ({ envs: s.envs.map(e => e.id !== envId ? e : { ...e, vars: [...(e.vars || []), { key: '', val: '' }] }) }))
        sbUpsertEnv(get().envs.find(e => e.id === envId), get().activeCollectionId)
      },
      removeEnvVar: (envId, idx) => {
        set(s => ({ envs: s.envs.map(e => e.id !== envId ? e : { ...e, vars: (e.vars || []).filter((_, i) => i !== idx) }) }))
        sbUpsertEnv(get().envs.find(e => e.id === envId), get().activeCollectionId)
      },
      updateEnvVar: (envId, idx, field, val) => {
        set(s => ({ envs: s.envs.map(e => e.id !== envId ? e : { ...e, vars: (e.vars || []).map((v, i) => i !== idx ? v : { ...v, [field]: val }) }) }))
        sbUpsertEnv(get().envs.find(e => e.id === envId), get().activeCollectionId)
      },
      resolveEnvVars: (str) => {
        const { envs, activeEnvId } = get()
        const env = envs.find(e => e.id === activeEnvId)
        return env ? resolveVars(str, env.vars) : str
      },

      // ── Flow steps (transient) ─────────────────────────────────────────────
      flowSteps: [],
      flowName: '',
      setFlowName: (name) => set({ flowName: name }),
      addFlowStep: (mid, aid, dropX, dropY) => {
        const { modules, flowSteps } = get()
        const mod = modules.find(m => m.id === mid)
        const api = mod?.apis.find(a => a.id === aid)
        if (!api) return
        const x = dropX !== undefined ? dropX : 80
        const y = dropY !== undefined ? dropY : 60 + flowSteps.length * 300
        set(s => ({
          flowSteps: [...s.flowSteps, {
            id: 's' + Date.now(), mid, aid,
            params: api.params.map(p => ({ key: p.key, val: '', binding: null })),
            reqHeaders: [], bodyMode: 'params', bodyRaw: '', x, y, excludedHeaders: [],
            createdAt: Date.now(),
          }]
        }))
      },
      pasteFlowStep: (snapshot, offsetX = 40, offsetY = 40) => {
        set(s => ({
          flowSteps: [...s.flowSteps, {
            ...snapshot,
            id: 's' + Date.now(),
            x: (snapshot.x ?? 80) + offsetX,
            y: (snapshot.y ?? 80) + offsetY,
            createdAt: Date.now(),
          }]
        }))
      },
      addHeaderConfigStep: (dropX, dropY) => {
        const { flowSteps, modules } = get()
        const x = dropX ?? 400
        const y = dropY ?? 60 + flowSteps.length * 300
        const seen = new Set()
        const headers = []
        for (const mod of modules) {
          for (const auth of (mod.auths || [])) {
            if (auth.key && !seen.has(auth.key)) {
              headers.push({ key: auth.key, val: '', binding: null, hint: auth.hint || null, mid: mod.id, schemeName: auth.schemeName || null, schemeType: auth.schemeType || null })
              seen.add(auth.key)
            }
          }
        }
        if (headers.length === 0) headers.push({ key: '', val: '', binding: null })
        set(s => ({
          flowSteps: [...s.flowSteps, { id: 's' + Date.now(), type: 'header-config', x, y, headers, createdAt: Date.now() }]
        }))
      },
      addHeaderConfigEntry: (stepId) => set(s => ({
        flowSteps: s.flowSteps.map(step => step.id !== stepId ? step : {
          ...step, headers: [...(step.headers || []), { key: '', val: '', binding: null }]
        })
      })),
      addHeaderConfigEntryWith: (stepId, entry) => set(s => ({
        flowSteps: s.flowSteps.map(step => step.id !== stepId ? step : {
          ...step, headers: [...(step.headers || []), { val: '', binding: null, ...entry }]
        })
      })),
      removeHeaderConfigEntry: (stepId, idx) => set(s => ({
        flowSteps: s.flowSteps.map(step => step.id !== stepId ? step : {
          ...step, headers: (step.headers || []).filter((_, i) => i !== idx)
        })
      })),
      updateHeaderConfigEntry: (stepId, idx, field, val) => set(s => ({
        flowSteps: s.flowSteps.map(step => step.id !== stepId ? step : {
          ...step, headers: (step.headers || []).map((h, i) =>
            i !== idx ? h : { ...h, [field]: val, ...(field === 'val' ? { binding: null } : {}) }
          )
        })
      })),
      bindHeaderConfigEntry: (stepId, idx, label) => set(s => ({
        flowSteps: s.flowSteps.map(step => step.id !== stepId ? step : {
          ...step, headers: (step.headers || []).map((h, i) =>
            i !== idx ? h : { ...h, val: label, binding: label }
          )
        })
      })),
      updateStepPos: (stepId, x, y) => set(s => ({
        flowSteps: s.flowSteps.map(step => step.id === stepId ? { ...step, x, y } : step)
      })),
      updateBodyMode: (stepIdx, mode) => set(s => ({
        flowSteps: s.flowSteps.map((step, i) => i !== stepIdx ? step : { ...step, bodyMode: mode })
      })),
      updateBodyRaw: (stepIdx, val) => set(s => ({
        flowSteps: s.flowSteps.map((step, i) => i !== stepIdx ? step : { ...step, bodyRaw: val })
      })),
      removeFlowStep: (idx) => set(s => {
        const steps = [...s.flowSteps]; steps.splice(idx, 1); return { flowSteps: steps }
      }),
      reorderFlowStep: (from, to) => set(s => {
        const steps = [...s.flowSteps]
        const [moved] = steps.splice(from, 1)
        steps.splice(to, 0, moved)
        return { flowSteps: steps }
      }),
      updateParam: (stepIdx, paramIdx, val) => set(s => ({
        flowSteps: s.flowSteps.map((step, si) => si !== stepIdx ? step : {
          ...step, params: step.params.map((p, pi) => pi !== paramIdx ? p : { ...p, val, binding: null })
        })
      })),
      bindParam: (stepIdx, paramIdx, label) => set(s => ({
        flowSteps: s.flowSteps.map((step, si) => si !== stepIdx ? step : {
          ...step, params: step.params.map((p, pi) => pi !== paramIdx ? p : { ...p, val: label, binding: label })
        })
      })),

      // ── 배열 파라미터 ─────────────────────────────────────────────────────
      toggleParamArrayMode: (stepIdx, paramIdx) => set(s => ({
        flowSteps: s.flowSteps.map((step, si) => si !== stepIdx ? step : {
          ...step, params: step.params.map((p, pi) => {
            if (pi !== paramIdx) return p
            if (p.items) return { ...p, items: null, val: '', binding: null }
            return { ...p, items: [{ val: p.val || '', binding: p.binding || null }], val: '', binding: null }
          })
        })
      })),
      addParamArrayItem: (stepIdx, paramIdx) => set(s => ({
        flowSteps: s.flowSteps.map((step, si) => si !== stepIdx ? step : {
          ...step, params: step.params.map((p, pi) => pi !== paramIdx ? p : {
            ...p, items: [...(p.items || []), { val: '', binding: null }]
          })
        })
      })),
      removeParamArrayItem: (stepIdx, paramIdx, itemIdx) => set(s => ({
        flowSteps: s.flowSteps.map((step, si) => si !== stepIdx ? step : {
          ...step, params: step.params.map((p, pi) => pi !== paramIdx ? p : {
            ...p, items: (p.items || []).filter((_, ii) => ii !== itemIdx)
          })
        })
      })),
      updateParamArrayItem: (stepIdx, paramIdx, itemIdx, val) => set(s => ({
        flowSteps: s.flowSteps.map((step, si) => si !== stepIdx ? step : {
          ...step, params: step.params.map((p, pi) => pi !== paramIdx ? p : {
            ...p, items: (p.items || []).map((item, ii) => ii !== itemIdx ? item : { val, binding: null })
          })
        })
      })),
      bindParamArrayItem: (stepIdx, paramIdx, itemIdx, label) => set(s => ({
        flowSteps: s.flowSteps.map((step, si) => si !== stepIdx ? step : {
          ...step, params: step.params.map((p, pi) => pi !== paramIdx ? p : {
            ...p, items: (p.items || []).map((item, ii) => ii !== itemIdx ? item : { val: label, binding: label })
          })
        })
      })),

      toggleExcludeHeader: (stepId, key) => set(s => ({
        flowSteps: s.flowSteps.map(step => {
          if (step.id !== stepId) return step
          const ex = step.excludedHeaders || []
          return { ...step, excludedHeaders: ex.includes(key) ? ex.filter(k => k !== key) : [...ex, key] }
        })
      })),

      addStepHeader: (stepIdx) => set(s => ({
        flowSteps: s.flowSteps.map((step, i) => i !== stepIdx ? step : {
          ...step, reqHeaders: [...(step.reqHeaders || []), { key: '', val: '', binding: null }]
        })
      })),
      removeStepHeader: (stepIdx, hi) => set(s => ({
        flowSteps: s.flowSteps.map((step, i) => i !== stepIdx ? step : {
          ...step, reqHeaders: (step.reqHeaders || []).filter((_, j) => j !== hi)
        })
      })),
      updateStepHeader: (stepIdx, hi, field, val) => set(s => ({
        flowSteps: s.flowSteps.map((step, i) => i !== stepIdx ? step : {
          ...step, reqHeaders: (step.reqHeaders || []).map((h, j) =>
            j !== hi ? h : { ...h, [field]: val, ...(field === 'val' ? { binding: null } : {}) }
          )
        })
      })),
      bindStepHeader: (stepIdx, hi, label) => set(s => ({
        flowSteps: s.flowSteps.map((step, i) => i !== stepIdx ? step : {
          ...step, reqHeaders: (step.reqHeaders || []).map((h, j) =>
            j !== hi ? h : { ...h, val: label, binding: label }
          )
        })
      })),

      // ── Connections ───────────────────────────────────────────────────────
      connections: [],
      addConnection: (fromId, toId) => set(s => {
        if (fromId === toId) return s
        const filtered = s.connections.filter(c => c.fromId !== fromId).filter(c => c.toId !== toId)
        return { connections: [...filtered, { id: 'c' + Date.now(), fromId, toId }] }
      }),
      removeConnection: (id) => set(s => ({ connections: s.connections.filter(c => c.id !== id) })),
      clearFlow: () => set({ flowSteps: [], flowName: '', connections: [] }),

      // ── Import flow from compact JSON ─────────────────────────────────────
      importFlow: (data) => {
        const { modules } = get()
        const allApis = []
        for (const mod of modules) {
          for (const api of mod.apis) allApis.push({ mod, api })
        }
        function findApi(name) {
          const lower = name.toLowerCase()
          return (
            allApis.find(({ api }) => api.name === name) ||
            allApis.find(({ api }) => api.name.toLowerCase() === lower) ||
            allApis.find(({ api }) => api.path.toLowerCase().includes(lower)) ||
            null
          )
        }

        const steps = data.flow || []
        const newSteps = []
        const newConnections = []
        const varRegistry = {} // varName → "stepN.dot.path"
        const errors = []

        steps.forEach((item, idx) => {
          const match = findApi(item.api)
          if (!match) { errors.push(`"${item.api}" API를 찾을 수 없어요`); return }
          const { mod, api } = match

          // Build step-level request headers from `use`
          const reqHeaders = []
          if (item.use) {
            for (const [key, rawVal] of Object.entries(item.use)) {
              const val = String(rawVal).replace(/\{\{(\w+)\}\}/g, (_, vName) =>
                varRegistry[vName] ? `{${varRegistry[vName]}}` : `{{${vName}}}`
              )
              reqHeaders.push({ key, val, binding: null })
            }
          }

          // params: values(리터럴 기본값) + bind(이전 스텝 응답값 연결)
          const params = api.params.map(p => ({
            key: p.key,
            val: item.values && p.key in item.values ? item.values[p.key] : '', // 리터럴 기본값(문자/불리언 등)
            binding: null,
          }))
          if (item.bind) {
            for (const [pKey, rawVal] of Object.entries(item.bind)) {
              const binding = String(rawVal).replace(/\{\{(\w+)\}\}/g, (_, vName) => varRegistry[vName] ?? '')
              const param = params.find(p => p.key === pKey)
              if (param && binding) param.binding = binding
            }
          }

          const stepId = 's' + (Date.now() + idx)
          newSteps.push({
            id: stepId,
            mid: mod.id,
            aid: api.id,
            params,
            reqHeaders,
            // setAuth: 이 스텝 응답값을 모듈 전역 인증 헤더로 저장 (예: { Authorization: '$.row.accessToken' })
            ...(item.setAuth ? { setAuth: item.setAuth } : {}),
            bodyMode: 'params',
            bodyRaw: '',
            x: 80 + idx * 340,
            y: 100,
            excludedHeaders: [],
          })

          // Register saved variables AFTER building current step's headers
          // (save refs the response of this step, used by later steps)
          if (item.save) {
            for (const [vName, path] of Object.entries(item.save)) {
              const cleanPath = path.replace(/^\$\./, '')
              varRegistry[vName] = `step${idx + 1}.${cleanPath}`
            }
          }

          if (idx > 0 && newSteps[idx - 1]) {
            newConnections.push({
              id: 'c' + (Date.now() + idx),
              fromId: newSteps[idx - 1].id,
              toId: stepId,
            })
          }
        })

        if (errors.length) return { ok: false, errors }
        set({ flowSteps: newSteps, connections: newConnections, flowName: data.name || '' })
        return { ok: true }
      },

      loadFlow: (flow) => set({
        flowSteps: JSON.parse(JSON.stringify(flow.steps)),
        connections: JSON.parse(JSON.stringify(flow.connections || [])),
        flowName: flow.name,
      }),

      // ── Saved flows ───────────────────────────────────────────────────────
      savedFlows: [],
      saveFlow: (name) => {
        const { flowSteps, connections, savedFlows, modules, activeCollectionId } = get()
        const idx = savedFlows.findIndex(f => f.name === name)
        const flow = {
          id: idx >= 0 ? savedFlows[idx].id : 'f' + Date.now(),
          name,
          steps: JSON.parse(JSON.stringify(flowSteps)),
          connections: JSON.parse(JSON.stringify(connections)),
          savedAt: new Date().toLocaleString('ko-KR', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
          stepCount: flowSteps.length,
          moduleNames: [...new Set(flowSteps.map(s => {
            const mod = modules.find(m => m.id === s.mid)
            return mod?.name || '?'
          }))]
        }
        if (idx >= 0) {
          set(s => ({ savedFlows: s.savedFlows.map((f, i) => i === idx ? flow : f) }))
        } else {
          set(s => ({ savedFlows: [flow, ...s.savedFlows] }))
        }
        sbUpsertFlow(flow, activeCollectionId)
        return idx >= 0 ? 'overwrite' : 'new'
      },
      deleteSavedFlow: (id) => {
        set(s => ({ savedFlows: s.savedFlows.filter(f => f.id !== id) }))
        sbDeleteFlow(id)
      },
      duplicateFlow: (id) => {
        const { savedFlows } = get()
        const src = savedFlows.find(f => f.id === id)
        if (!src) return
        // 새 step/connection ID 매핑
        const idMap = {}
        const newSteps = src.steps.map(s => {
          const newId = 's' + Date.now() + '_' + Math.random().toString(36).slice(2)
          idMap[s.id] = newId
          return { ...s, id: newId }
        })
        const newConns = (src.connections || []).map(c => ({
          id: 'c' + Date.now() + '_' + Math.random().toString(36).slice(2),
          fromId: idMap[c.fromId] ?? c.fromId,
          toId:   idMap[c.toId]   ?? c.toId,
        }))
        const flow = {
          id: 'f' + Date.now(),
          name: src.name + ' (복사)',
          steps: newSteps,
          connections: newConns,
          stepCount: src.stepCount,
          moduleNames: src.moduleNames,
          savedAt: new Date().toLocaleString('ko-KR', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
        }
        set(s => ({ savedFlows: [flow, ...s.savedFlows] }))
        sbUpsertFlow(flow, get().activeCollectionId)
      },

      // ── API 요청값 프리셋 ─────────────────────────────────────────────────
      apiPresets: [],
      lastUsedPresetId: {}, // { [aid]: presetId }
      saveApiPreset: (aid, mid, name, step) => {
        const id = 'p' + Date.now()
        const preset = {
          id, aid, mid, name,
          params: JSON.parse(JSON.stringify(step.params || [])),
          bodyMode: step.bodyMode || 'params',
          bodyRaw: step.bodyRaw || '',
          reqHeaders: JSON.parse(JSON.stringify(step.reqHeaders || [])),
          savedAt: new Date().toLocaleString('ko-KR', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
        }
        set(s => ({ apiPresets: [...s.apiPresets, preset] }))
        sbUpsertPreset(preset, get().activeCollectionId)
        return id
      },
      updateApiPreset: (id, step) => {
        set(s => ({
          apiPresets: s.apiPresets.map(p => p.id !== id ? p : {
            ...p,
            params: JSON.parse(JSON.stringify(step.params || [])),
            bodyMode: step.bodyMode || 'params',
            bodyRaw: step.bodyRaw || '',
            reqHeaders: JSON.parse(JSON.stringify(step.reqHeaders || [])),
            savedAt: new Date().toLocaleString('ko-KR', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
          })
        }))
        const updated = get().apiPresets.find(p => p.id === id)
        if (updated) sbUpsertPreset(updated, get().activeCollectionId)
      },
      deleteApiPreset: (id) => {
        set(s => ({ apiPresets: s.apiPresets.filter(p => p.id !== id) }))
        sbDeletePreset(id)
      },
      loadApiPreset: (stepIdx, preset) => set(s => ({
        lastUsedPresetId: { ...s.lastUsedPresetId, [preset.aid]: preset.id },
        flowSteps: s.flowSteps.map((step, i) => {
          if (i !== stepIdx) return step
          return {
            ...step,
            params: step.params.map(p => {
              const saved = preset.params.find(pp => pp.key === p.key)
              return saved ? { ...p, val: saved.val, binding: saved.binding ?? null } : p
            }),
            bodyMode: preset.bodyMode || step.bodyMode,
            bodyRaw: preset.bodyRaw ?? step.bodyRaw,
            reqHeaders: preset.reqHeaders?.length
              ? JSON.parse(JSON.stringify(preset.reqHeaders))
              : step.reqHeaders,
          }
        })
      })),

      // ── 마지막 실행 응답 (세션용, 미저장) ────────────────────────────────────
      lastRunResponses: {}, // { [stepId]: { body: {}, headers: {} } }
      setLastRunResponse: (stepId, body, headers) => set(s => ({
        lastRunResponses: { ...s.lastRunResponses, [stepId]: { body: body ?? {}, headers: headers ?? {} } }
      })),
      clearLastRunResponses: () => set({ lastRunResponses: {} }),

      // ── Helper ────────────────────────────────────────────────────────────
      getApiById: (aid) => {
        const { modules } = get()
        for (const m of modules) {
          const api = m.apis.find(a => a.id === aid)
          if (api) return { api, module: m }
        }
        return null
      },
    }),
    {
      name: 'swagger-flow-tester',
      version: 1,
      migrate: (state) => ({ ...state, modules: [] }),
      partialize: (s) => ({
        collections: s.collections, activeCollectionId: s.activeCollectionId,
        modules: s.modules, savedFlows: s.savedFlows,
        flowSteps: s.flowSteps, flowName: s.flowName, connections: s.connections,
        envs: s.envs, activeEnvId: s.activeEnvId, apiPresets: s.apiPresets, lastUsedPresetId: s.lastUsedPresetId,
        theme: s.theme,
      }),
    }
  )
)
