/**
 * Resolve a template string that may contain {step1.fieldName} expressions.
 * e.g. "Bearer {step1.accessToken}" → "Bearer eyJ..."
 */
export function resolveTemplate(str, resolveBinding) {
  if (!str || !str.includes('{')) return str
  return str.replace(/\{(step\d+\.[^}]+)\}/g, (_, expr) => {
    const resolved = resolveBinding(expr)
    return resolved !== undefined && resolved !== null ? String(resolved) : ''
  })
}

/**
 * 객체·배열 안쪽 문자열까지 치환한다.
 * 중첩 객체를 값으로 주는 파라미터(items, statuses 등)는 문자열이 아니라서
 * resolveTemplate 만으로는 내부의 {stepN.path} 가 그대로 전송된다.
 */
export function resolveTemplateDeep(v, resolveBinding) {
  if (typeof v === 'string') return resolveTemplate(v, resolveBinding)
  if (Array.isArray(v)) return v.map(x => resolveTemplateDeep(x, resolveBinding))
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, resolveTemplateDeep(x, resolveBinding)])
    )
  }
  return v
}

/**
 * Compute execution order from flowSteps + connections.
 * If no connections: returns steps in Y-sorted order (top → bottom).
 * If connections exist: follows the connection chain, then appends isolated nodes.
 */
export function computeExecutionOrder(steps, connections) {
  if (!connections || connections.length === 0) return [...steps]

  const nextMap = {}          // fromId → toId
  const hasIncoming = new Set() // ids that have an incoming connection

  for (const c of connections) {
    nextMap[c.fromId] = c.toId
    hasIncoming.add(c.toId)
  }

  const connectedIds = new Set(connections.flatMap(c => [c.fromId, c.toId]))

  const stepSort = (a, b) => {
    // 1. Primary: Y coordinate (with 20px threshold to treat nodes on same level similarly)
    const ay = a.y || 0, by = b.y || 0
    if (Math.abs(ay - by) > 20) return ay - by
    
    // 2. Secondary: Creation order (dragged from library order)
    const ac = a.createdAt || 0, bc = b.createdAt || 0
    if (ac !== bc) return ac - bc
    
    // 3. Tertiary: X coordinate
    return (a.x || 0) - (b.x || 0)
  }

  // Chain heads: part of a connection but have no incoming edge
  const heads = steps
    .filter(s => connectedIds.has(s.id) && !hasIncoming.has(s.id))
    .sort(stepSort)

  // Isolated: not in any connection
  const isolated = steps
    .filter(s => !connectedIds.has(s.id))
    .sort(stepSort)

  const chain = []
  const visited = new Set()

  for (const head of heads) {
    let cur = head
    while (cur && !visited.has(cur.id)) {
      visited.add(cur.id)
      chain.push(cur)
      const nextId = nextMap[cur.id]
      cur = nextId ? steps.find(s => s.id === nextId) : null
    }
  }

  if (isolated.length === 0) return chain

  // Merge isolated nodes into the chain by weight (spatial + time)
  const result = [...chain]
  for (const iso of isolated.sort(stepSort)) {
    const insertIdx = result.findIndex(s => stepSort(iso, s) < 0)
    if (insertIdx === -1) result.push(iso)
    else result.splice(insertIdx, 0, iso)
  }
  return result
}
