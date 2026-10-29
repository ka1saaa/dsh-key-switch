/**
 * dsh-key-switch — 为 DeepSeek Harness 提供「每个提供商多把 API key + 一键切换」，
 * 并支持**每个会话使用不同的 API key**。
 *
 * 设计要点：
 *  - 密钥池里的 key 不以任何自有文件落盘，而是存进 harness 自己的凭据 seam：
 *    `ctx.credentials.modifyRecord()`，scope = 本插件名，id = 池条目。
 *  - 每把 key 在 `credentials` 里另有一条「引用」镜像（refs 段，名字由本插件生成），
 *    这是**会话级路由**需要的：DeepSeek provider 的鉴权会按连接的 apiKeyEnv 去
 *    `credentials.resolve(ref)`，所以只要给每个 key 一个自己的 ref，就能让同一个
 *    provider 适配器在 N 条路由上分别用 N 把 key —— 且互不串线（并发安全）。
 *  - 会话级选择**复用 harness 自己的「会话级模型选择」**（`sessionController.selectModel`，
 *    它会往会话日志写 `model/selection` 事件，天然持久化、跟随会话）：
 *    选 key ⇔ 把该会话的路由切到 `dsh-key-<id>`，模型保持不变。
 *    这样不需要任何“请求时临时改全局凭据”的竞态写法，也不需要旁路状态文件。
 *  - 只暴露脱敏值（****后四位）给浏览器；任何 RPC 都不返回明文密钥。
 *
 * 服务端路由（同源 JSON，仅回环地址可达）：
 *   GET  /dsh-key-switch-api/state     池 + 全局值 + 指定会话的当前 key + 路由提醒
 *   POST /dsh-key-switch-api/add       { key, note }
 *   POST /dsh-key-switch-api/activate  { id }   切换“全局默认”key（新会话 / 未绑定会话）
 *   POST /dsh-key-switch-api/remove    { id }
 *   POST /dsh-key-switch-api/rename    { id, note }
 *   POST /dsh-key-switch-api/adopt     把当前生效的全局 key 收进池
 *   POST /dsh-key-switch-api/bind      { sessionId, id|null }  会话级选中/取消（null = 跟随全局）
 *   POST /dsh-key-switch-api/use-route 把新会话默认模型切到 API key 路由
 *
 * 对外服务：`ctx.dshKeySwitch`（余额挂件等插件用来查“某会话现在用哪把 key”）。
 *
 * @module dsh-key-switch
 */

import { randomBytes } from 'node:crypto'

export const name = 'dsh-key-switch'

/** 服务依赖：没有 webServer 无法给设置页提供 API；没有 credentials 无法切 key。 */
export const inject = ['webServer', 'credentials']

const SCOPE = 'dsh-key-switch'
const API = '/dsh-key-switch-api'
const DEFAULT_REF = 'DEEPSEEK_API_KEY'
const DEFAULT_PROVIDER = 'deepseek-official'

/** key 值必须是可放进 HTTP 头的可打印 ASCII（与 @deepseek-ai/dsh-llm 的 normalizeApiKey 一致）。 */
const LEGAL_KEY = /^[\x21-\x7E]+$/
const RECORD_ID = /^[a-z][a-z0-9-]*$/
/** 凭据引用名的字符集（与 dsh-credentials 的 REF_PATTERN 一致）。 */
const REF_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
/** 路由 id：小写连字符，便于在模型选择器与会话日志里辨认。 */
const ROUTE_PREFIX = 'dsh-key-'
const ROUTE_ID = /^dsh-key-[a-z0-9-]+$/

function mask(value) {
  if (!value) return ''
  if (value.length <= 4) return '****'
  return '****' + value.slice(-4)
}

/**
 * 展示用标签：备注 + 脱敏后四位。
 * 备注若是坏字符串（历史缓存事故会留下 GBK 乱码/孤立代理项），就退化成“未命名”，
 * 至少让「这是哪把 key」永远可以由后四位确认。
 */
function labelOf(entry) {
  const note = typeof entry.note === 'string' ? entry.note : ''
  const usable = note.length > 0 && (typeof note.isWellFormed !== 'function' || note.isWellFormed())
  return (usable ? note : '未命名') + ' · ' + mask(entry.secret)
}

function makeId() {
  return 'key-' + randomBytes(4).toString('hex')
}

function credentialKey(id) {
  return SCOPE + '/' + id
}

/** 池条目 id → 会话路由 id（`key-1a2b3c4d` → `dsh-key-1a2b3c4d`）。 */
function routeOfId(id) {
  return ROUTE_PREFIX + String(id).replace(/^key-/, '')
}

/** 池条目 id → 凭据引用名（`key-1a2b3c4d` → `DSH_KEY_SWITCH_KEY_1A2B3C4D`）。 */
function refOfId(id) {
  return 'DSH_KEY_SWITCH_' + String(id).replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()
}

function poolIdOfRoute(route) {
  const routeId = String(route || '')
  if (!ROUTE_ID.test(routeId)) return ''
  return 'key-' + routeId.slice(ROUTE_PREFIX.length)
}

function hostIsLoopback(req) {
  const remote = req.socket && req.socket.remoteAddress
  if (remote && remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') return false
  const raw = String((req.headers && req.headers.host) || '')
  if (!raw) return true
  let host = raw
  if (host.startsWith('[')) host = host.slice(0, host.indexOf(']') + 1)
  else if (host.includes(':')) host = host.slice(0, host.lastIndexOf(':'))
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
}

function json(res, value, status = 200) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1024 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return resolve({})
      try {
        const value = JSON.parse(text)
        resolve(value && typeof value === 'object' && !Array.isArray(value) ? value : {})
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** 把一个基础 provider 的适配器包成「只把 apiKeyEnv 换成指定凭据引用」的路由适配器。
 *
 * 做法：Proxy 一个只覆盖 `dependencies.options()` / `dependencies.discoverModels` /
 * `providerInfo()` 的视图，其余方法原样委托给基础适配器实例（同一个 file store、
 * 同一套重试策略、同一份模型表）。鉴权仍由基础 provider 自己的 resolveAuth 完成 ——
 * 它读连接上的 `apiKeyEnv`，于是每条路由各取各的 ref，互不干扰。
 *
 * @param baseAdapter - 已注册在基础 provider 上的适配器实例。
 * @param options - `{ ref, name, provider }`。
 * @returns 供 `llm.registerAdapter()` 使用的适配器视图。
 */
function perKeyAdapter(baseAdapter, options) {
  const { ref, name } = options
  const baseDeps = baseAdapter.dependencies
  if (!baseDeps || typeof baseDeps.options !== 'function') {
    throw new Error('基础 provider 适配器没有暴露 dependencies.options()，无法派生会话级 key 路由')
  }
  /** 同一份模型表对每条 key 路由都适用；不复用基础 discoverModels（它会用全局 key 探活）。 */
  const modelEntries = (providerId) => {
    const connection = baseDeps.options()
    const models = Array.isArray(connection.models) ? connection.models : []
    return models.map((model) => ({
      provider: providerId,
      id: model.id,
      name: model.name || model.id,
      ...(model.description === undefined ? {} : { description: model.description }),
      inputModalities: model.inputModalities || ['text'],
    }))
  }
  const dependencies = new Proxy(baseDeps, {
    get(target, property, receiver) {
      if (property === 'options') return () => ({ ...target.options(), apiKeyEnv: ref })
      if (property === 'discoverModels') return async (providerId) => modelEntries(providerId)
      return Reflect.get(target, property, receiver)
    },
  })
  return new Proxy(baseAdapter, {
    get(target, property, receiver) {
      if (property === 'dependencies') return dependencies
      if (property === 'providerInfo') return (id) => ({ id, name })
      return Reflect.get(target, property, receiver)
    },
  })
}

export function apply(ctx, config) {
  const ref = (config && typeof config.ref === 'string' && config.ref) || DEFAULT_REF
  const provider = (config && typeof config.provider === 'string' && config.provider) || DEFAULT_PROVIDER

  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    console.warn('[dsh-key-switch] credentials 服务不可用，插件未启用')
    return
  }

  // ---- 凭据记录（密钥池本体）----------------------------------------------

  async function listPool() {
    let records = []
    try {
      records = await credentials.listRecords()
    } catch (e) {
      console.warn('[dsh-key-switch] listRecords 失败:', e && e.message)
      return []
    }
    const mine = records
      .map((r) => String(r && r.key))
      .filter((k) => k.startsWith(SCOPE + '/'))
    const out = []
    for (const key of mine) {
      const id = key.slice(SCOPE.length + 1)
      if (!RECORD_ID.test(id)) continue
      let record = null
      try {
        record = await credentials.readRecord(key)
      } catch (e) {
        continue
      }
      const payload = record && record.payload && typeof record.payload === 'object' ? record.payload : {}
      const secret = typeof payload.secret === 'string' ? payload.secret : ''
      if (!secret) continue
      out.push({
        id,
        note: typeof payload.note === 'string' && payload.note ? payload.note : '未命名',
        secret,
        createdAt: typeof payload.createdAt === 'number' ? payload.createdAt : 0,
        route: routeOfId(id),
        ref: refOfId(id),
      })
    }
    out.sort((a, b) => a.createdAt - b.createdAt)
    return out
  }

  /** 把 key 同步到它自己的凭据引用上（供 provider 路由鉴权使用）。失败不致命。 */
  async function mirrorRef(id, secret) {
    const name = refOfId(id)
    if (!REF_NAME.test(name)) return false
    try {
      const hit = await credentials.resolve(name)
      if (hit && hit.value === secret) return true
      await credentials.set(name, secret)
      return true
    } catch (e) {
      console.warn('[dsh-key-switch] 写凭据引用失败:', e && e.message)
      return false
    }
  }

  /**
   * 写一条池条目。
   *
   * `secret === undefined` 表示“只改备注”：密钥以 `modifyRecord` 拿到的**当前值**为准，
   * 绝不从调用方（列表快照）回写 —— 否则一旦列表来自过期/异常的凭据缓存，
   * 一次改名就能把另一把 key 的密钥写进这条记录（真踩过）。
   */
  async function writePoolEntry(id, note, secret) {
    const name = refOfId(id)
    let saved = ''
    await credentials.modifyRecord(credentialKey(id), async (current) => {
      const payload = current && current.payload && typeof current.payload === 'object' ? current.payload : {}
      const nextSecret = secret === undefined
        ? (typeof payload.secret === 'string' ? payload.secret : '')
        : secret
      if (!nextSecret) throw new Error('密钥不存在')
      saved = nextSecret
      return {
        kind: 'grant',
        payload: {
          note,
          secret: nextSecret,
          ref: name,
          createdAt: typeof payload.createdAt === 'number' ? payload.createdAt : Date.now(),
        },
      }
    })
    if (saved) await mirrorRef(id, saved)
  }

  async function removePoolEntry(id) {
    await credentials.deleteRecord(credentialKey(id))
    try {
      if (typeof credentials.unset === 'function') await credentials.unset(refOfId(id))
    } catch (e) {
      console.warn('[dsh-key-switch] 删除凭据引用失败:', e && e.message)
    }
  }

  async function currentSecret() {
    try {
      const hit = await credentials.resolve(ref)
      return hit && typeof hit.value === 'string' ? hit.value : ''
    } catch (e) {
      return ''
    }
  }

  // ---- 每把 key 一条 provider 路由（会话级隔离的关键）-----------------------

  /** 会话路由注册表：keyId → { handle, name, route }。 */
  const registrations = new Map()
  /** 最近的注册失败原因（给页面提示，不刷日志）。 */
  let routesError = ''

  function llm() {
    const service = ctx.get('llm')
    return service && typeof service.registerAdapter === 'function' ? service : undefined
  }

  function baseAdapter() {
    const service = llm()
    if (!service) return undefined
    const map = service.adapters
    if (!map || typeof map.get !== 'function') return undefined
    const entry = map.get(provider)
    return entry && entry.adapter ? entry.adapter : undefined
  }

  /** 让注册表与密钥池一致：新增的路由注册，删掉的注销，改名的刷新展示名。 */
  function reconcileRoutes(pool) {
    const service = llm()
    if (!service) {
      routesError = '当前部署没有 llm 服务'
      return
    }
    const base = baseAdapter()
    if (!base) {
      routesError = '没有找到 provider「' + provider + '」的适配器（需要先配置好 DeepSeek 的 API key 路由）'
      return
    }
    routesError = ''
    const alive = new Set(pool.map((k) => k.id))
    for (const [id, entry] of [...registrations]) {
      if (alive.has(id)) continue
      try { entry.handle() } catch (e) { /* 已释放 */ }
      registrations.delete(id)
    }
    for (const keyEntry of pool) {
      const existing = registrations.get(keyEntry.id)
      if (existing) {
        if (existing.name !== keyEntry.note) {
          try {
            existing.handle.replace([keyEntry.route])
            existing.name = keyEntry.note
          } catch (e) {
            console.warn('[dsh-key-switch] 刷新路由失败:', e && e.message)
          }
        }
        continue
      }
      try {
        const adapter = perKeyAdapter(base, {
          ref: keyEntry.ref,
          name: 'DeepSeek · ' + keyEntry.note,
          provider,
        })
        const handle = service.registerAdapter([keyEntry.route], adapter)
        registrations.set(keyEntry.id, { handle, name: keyEntry.note, route: keyEntry.route, adapter })
      } catch (e) {
        routesError = '会话级 key 路由注册失败：' + (e && e.message ? e.message : String(e))
        console.warn('[dsh-key-switch] ' + routesError)
      }
    }
  }

  // ---- 会话当前 key ---------------------------------------------------------

  function sessionById(sessionId) {
    const sessions = ctx.get('sessions')
    if (!sessions || typeof sessions.get !== 'function') return undefined
    try {
      return sessions.get(String(sessionId))
    } catch (e) {
      return undefined
    }
  }

  /** 会话当前「将要使用」的模型选择：优先会话投影，其次最近一次请求头，最后全局默认。 */
  function sessionSelection(sessionId) {
    const session = sessionById(sessionId)
    if (session !== undefined) {
      const projections = ctx.get('sessionProjections')
      if (projections && typeof projections.stateOf === 'function') {
        try {
          const state = projections.stateOf(session, 'modelSelection')
          const picked = state ? (state.pending || state.lastUsed) : null
          if (picked && picked.provider) {
            return {
              provider: picked.provider,
              model: picked.model,
              ...(picked.reasoningEffort === undefined ? {} : { reasoningEffort: picked.reasoningEffort }),
            }
          }
        } catch (e) { /* 投影未注册时退回请求头 */ }
      }
      try {
        const header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
        const cfg = header && header.config
        if (cfg && cfg.provider) {
          return {
            provider: cfg.provider,
            model: cfg.model,
            ...(cfg.reasoningEffort === undefined ? {} : { reasoningEffort: cfg.reasoningEffort }),
          }
        }
      } catch (e) { /* 没有请求头就继续退到全局默认 */ }
    }
    const adm = ctx.get('agentDefaultModel')
    if (adm && typeof adm.currentSelection === 'function') {
      try {
        const sel = adm.currentSelection()
        if (sel && sel.provider) return { provider: sel.provider, model: sel.model || '' }
      } catch (e) { /* 忽略 */ }
    }
    return null
  }

  function keyForProvider(pool, selectedProvider) {
    const id = poolIdOfRoute(selectedProvider)
    if (!id) return null
    return pool.find((k) => k.id === id) || null
  }

  /** 会话的当前 key 摘要（null = 跟随全局）。 */
  function keyForSession(pool, sessionId) {
    const selection = sessionSelection(sessionId)
    const keyEntry = selection ? keyForProvider(pool, selection.provider) : null
    return { selection, key: keyEntry }
  }

  function currentRoute() {
    try {
      const adm = ctx.get('agentDefaultModel')
      if (adm && typeof adm.currentSelection === 'function') {
        const sel = adm.currentSelection()
        if (sel && typeof sel.provider === 'string') return { provider: sel.provider, model: sel.model || '' }
      }
    } catch (e) { /* 没有这个服务时静默 */ }
    return { provider: '', model: '' }
  }

  /** 目标路由上可用的模型：优先沿用当前模型 id，否则取该路由目录里的第一个。 */
  async function targetModel(wanted, providerId) {
    const service = llm()
    let ids = []
    if (service && typeof service.listModels === 'function') {
      try {
        const models = await service.listModels(providerId || provider)
        ids = (models || []).map((m) => (typeof m === 'string' ? m : m && (m.id || m.model))).filter(Boolean)
      } catch (e) { ids = [] }
    }
    if (ids.length === 0) return wanted || ''
    if (wanted && ids.indexOf(wanted) >= 0) return wanted
    return ids[0]
  }

  async function snapshot(sessionId) {
    const pool = await listPool()
    reconcileRoutes(pool)
    const live = await currentSecret()
    let writable = false
    try {
      const info = await credentials.describe(ref)
      writable = !!(info && info.writable)
    } catch (e) { /* 读不到就按不可写报告 */ }
    const inPool = pool.find((k) => k.secret === live)
    const route = currentRoute()
    let session = null
    if (sessionId) {
      const found = keyForSession(pool, sessionId)
      const selection = found.selection
      session = {
        sessionId: String(sessionId),
        provider: selection ? selection.provider : '',
        model: selection ? selection.model : '',
        keyId: found.key ? found.key.id : null,
        note: found.key ? found.key.note : null,
        // 会话仍走基础 provider ⇒ 用“全局默认”那把；走其它 provider ⇒ 本插件管不到。
        followsGlobal: !found.key && (selection ? selection.provider === provider : true),
        managed: !!found.key || (selection ? selection.provider === provider : true),
      }
    }
    return {
      ref,
      provider,
      routable: registrations.size > 0 || pool.length === 0,
      routesError,
      live: { masked: mask(live), configured: !!live, inPool: !!inPool, note: inPool ? inPool.note : '' },
      writable,
      route: {
        provider: route.provider,
        model: route.model,
        expected: provider,
        switched: route.provider === provider,
        canSwitch: !!route.provider && route.provider !== provider,
      },
      session,
      keys: pool.map((k) => ({
        id: k.id,
        note: k.note,
        masked: mask(k.secret),
        route: k.route,
        active: k.secret === live,
        routed: registrations.has(k.id),
      })),
    }
  }

  /** 某条 key 路由被移除后，把还指着它的默认模型 / 在线会话挪回基础 provider，避免“模型不可用”。 */
  async function releaseRoute(route) {
    if (!route) return
    try {
      const adm = ctx.get('agentDefaultModel')
      const cur = adm && typeof adm.currentSelection === 'function' ? adm.currentSelection() : null
      if (cur && cur.provider === route && adm && typeof adm.saveSelection === 'function') {
        const model = await targetModel(cur.model, provider)
        if (model) await adm.saveSelection({ provider, model })
      }
    } catch (e) { /* 默认模型挪不动也不该阻断删除 */ }
    const controller = ctx.get('sessionController')
    const sessions = ctx.get('sessions')
    if (!controller || typeof controller.selectModel !== 'function' || !sessions || typeof sessions.list !== 'function') return
    let live = []
    try { live = sessions.list() } catch (e) { return }
    for (const session of live) {
      const id = session && session.id
      if (!id) continue
      const selection = sessionSelection(id)
      if (!selection || selection.provider !== route) continue
      try {
        const model = await targetModel(selection.model, provider)
        if (model) await controller.selectModel({ sessionId: id, provider, model })
      } catch (e) { /* 单个会话失败不影响删除 */ }
    }
  }

  async function bindSession(sessionId, keyId) {
    if (!sessionId) throw new Error('缺少会话 id')
    const controller = ctx.get('sessionController')
    if (!controller || typeof controller.selectModel !== 'function') {
      throw new Error('当前部署没有会话模型服务，无法把密钥绑定到会话')
    }
    const pool = await listPool()
    const found = keyForSession(pool, sessionId)
    const selection = found.selection || { provider, model: '' }
    let keyEntry = null
    if (keyId) {
      keyEntry = pool.find((k) => k.id === keyId)
      if (!keyEntry) throw new Error('密钥不存在')
    }
    const targetProvider = keyEntry ? keyEntry.route : provider
    const model = await targetModel(selection.model, targetProvider)
    if (!model) throw new Error('目标路由没有可用模型')
    const request = {
      sessionId: String(sessionId),
      provider: targetProvider,
      model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    }
    await controller.selectModel(request)
    return snapshot(sessionId)
  }

  // ---- RPC ----------------------------------------------------------------

  async function handle(action, args) {
    switch (action) {
      case 'state':
        return snapshot(args.sessionId)

      case 'add': {
        const key = typeof args.key === 'string' ? args.key.trim() : ''
        if (!key) throw new Error('密钥不能为空')
        if (!LEGAL_KEY.test(key)) throw new Error('密钥只能包含可打印 ASCII 字符（不能有空格、中文、换行）')
        const note = typeof args.note === 'string' ? args.note.trim().slice(0, 40) : ''
        const pool = await listPool()
        const exist = pool.find((k) => k.secret === key)
        if (exist) {
          await writePoolEntry(exist.id, note || exist.note, key)
          return snapshot(args.sessionId)
        }
        await writePoolEntry(makeId(), note || '未命名', key)
        return snapshot(args.sessionId)
      }

      case 'activate': {
        const id = String(args.id || '')
        if (!RECORD_ID.test(id)) throw new Error('无效的密钥 id')
        const pool = await listPool()
        const hit = pool.find((k) => k.id === id)
        if (!hit) throw new Error('密钥不存在')
        await credentials.set(ref, hit.secret)
        return snapshot(args.sessionId)
      }

      case 'remove': {
        const id = String(args.id || '')
        if (!RECORD_ID.test(id)) throw new Error('无效的密钥 id')
        const route = routeOfId(id)
        await removePoolEntry(id)
        reconcileRoutes(await listPool())
        await releaseRoute(route)
        return snapshot(args.sessionId)
      }

      case 'rename': {
        const id = String(args.id || '')
        if (!RECORD_ID.test(id)) throw new Error('无效的密钥 id')
        const note = typeof args.note === 'string' ? args.note.trim().slice(0, 40) : ''
        if (!note) throw new Error('备注不能为空')
        const pool = await listPool()
        if (!pool.some((k) => k.id === id)) throw new Error('密钥不存在')
        // 只改备注，密钥保留记录里的现值（见 writePoolEntry 的说明）。
        await writePoolEntry(id, note, undefined)
        return snapshot(args.sessionId)
      }

      case 'adopt': {
        const live = await currentSecret()
        if (!live) throw new Error('当前没有生效的密钥可收录')
        const pool = await listPool()
        if (pool.some((k) => k.secret === live)) return snapshot(args.sessionId)
        await writePoolEntry(makeId(), '当前', live)
        return snapshot(args.sessionId)
      }

      case 'bind': {
        return bindSession(String(args.sessionId || ''), args.id ? String(args.id) : null)
      }

      // 把默认模型切到本插件管理的这条 API key 路由（写 profile 的 agent-default-model）。
      case 'use-route': {
        const adm = ctx.get('agentDefaultModel')
        if (!adm || typeof adm.saveSelection !== 'function') {
          throw new Error('当前部署没有可写的默认模型配置')
        }
        const cur = currentRoute()
        const model = await targetModel(cur.model, provider)
        if (!model) throw new Error('目标路由没有可用模型')
        await adm.saveSelection({ provider, model })
        return snapshot(args.sessionId)
      }

      default:
        throw new Error('未知操作')
    }
  }

  // ---- 路由 ---------------------------------------------------------------

  const makeRoute = (action) => async (req, res) => {
    if (!hostIsLoopback(req)) return json(res, { error: 'forbidden' }, 403)
    const isRead = action === 'state'
    if (isRead ? req.method !== 'GET' : req.method !== 'POST') {
      return json(res, { error: 'method not allowed' }, 405)
    }
    try {
      const args = isRead ? {} : await readBody(req)
      if (isRead) {
        try {
          const url = new URL(req.url || '/', 'http://localhost')
          const sessionId = url.searchParams.get('sessionId')
          if (sessionId) args.sessionId = sessionId
        } catch (e) { /* 没有查询串 */ }
      }
      json(res, await handle(action, args))
    } catch (e) {
      json(res, { error: e && e.message ? e.message : String(e) }, 400)
    }
  }

  for (const action of ['state', 'add', 'activate', 'remove', 'rename', 'adopt', 'bind', 'use-route']) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: API + '/' + action,
      handler: makeRoute(action),
    }))
  }

  // ---- 对外服务（余额挂件等）---------------------------------------------

  ctx.provide('dshKeySwitch', {
    provider,
    ref,
    routeOf: (id) => routeOfId(id),
    /** 某会话当前实际使用的 key；null = 跟随全局 / 本插件管不到 / 会话不在内存里（不猜）。 */
    async keyForSession(sessionId) {
      if (!sessionId) return null
      // 只有活跃会话才读得到它自己的选择；不在内存里的会话退回“全局默认”会把
      // 默认 key 冒充成那个会话的 key，所以这里直接给 null。
      if (sessionById(sessionId) === undefined) return null
      const pool = await listPool()
      const found = keyForSession(pool, sessionId)
      if (!found.key) return null
      return { keyId: found.key.id, note: found.key.note, label: labelOf(found.key), ref: found.key.ref }
    },
    /** 按池条目 id 取 key 的凭据引用（余额挂件按会话 key 取余额时用）。 */
    async keyById(id) {
      const wanted = String(id || '')
      if (!RECORD_ID.test(wanted)) return null
      const pool = await listPool()
      const hit = pool.find((k) => k.id === wanted)
      if (!hit) return null
      return { keyId: hit.id, note: hit.note, label: labelOf(hit), ref: hit.ref }
    },
    /** 全局默认 key 的凭据引用。 */
    globalRef() {
      return ref
    },
    async state(sessionId) {
      return snapshot(sessionId)
    },
  })

  // 启动时补齐引用镜像并注册路由（老版本池条目没有 ref，需要迁移）。
  let disposed = false
  let retryTimer = null
  async function syncPool() {
    try {
      const pool = await listPool()
      for (const keyEntry of pool) {
        if (disposed) return
        await mirrorRef(keyEntry.id, keyEntry.secret)
      }
      if (disposed) return
      // 写引用可能触发凭据文档重读，重新列一次再注册，避免用到旧快照上的备注。
      reconcileRoutes(await listPool())
    } catch (e) {
      console.warn('[dsh-key-switch] 启动同步失败:', e && e.message)
    }
  }
  ctx.effect(() => () => {
    disposed = true
    if (retryTimer !== null) clearTimeout(retryTimer)
  })
  void syncPool()
  // 热重载时凭据服务可能稍后才重新读取文档；再补一次，保证路由展示名与池一致。
  retryTimer = setTimeout(() => {
    retryTimer = null
    if (!disposed) void listPool().then((pool) => { if (!disposed) reconcileRoutes(pool) }, () => {})
  }, 2000)
  if (retryTimer && typeof retryTimer.unref === 'function') retryTimer.unref()
}
