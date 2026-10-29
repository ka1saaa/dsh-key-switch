/**
 * dsh-key-switch 宿主端单元测试（无需启动 DSH）。
 * 用假 ctx 模拟 credentials / llm / sessions / sessionController / webServer 接缝，
 * 验证：密钥池语义、每把 key 一条 provider 路由、会话级绑定、改名不碰密钥、路由守卫。
 *
 * 运行：node --test test/host.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject, name } from '../lib/index.js'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const BASE_MODELS = [
  { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
]

function makeHarness(initial = {}) {
  const refs = new Map(Object.entries(initial))
  const records = new Map()
  const routes = new Map()
  const provided = {}
  const registered = new Map()

  const credentials = {
    async listRecords() {
      return [...records.keys()].map((key) => ({ key, kind: 'grant' }))
    },
    async readRecord(key) {
      return records.get(key)
    },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key))
      if (next !== undefined) records.set(key, next)
      return next
    },
    async deleteRecord(key) {
      records.delete(key)
    },
    async resolve(ref) {
      return refs.has(ref) ? { value: refs.get(ref), source: 'store' } : undefined
    },
    async describe(ref) {
      return { configured: refs.has(ref), writable: true }
    },
    async set(ref, value) {
      refs.set(ref, value)
    },
    async unset(ref) {
      refs.delete(ref)
    },
  }

  const baseAdapter = {
    dependencies: {
      options: () => ({
        baseURL: 'https://api.deepseek.com/anthropic',
        models: BASE_MODELS,
        apiKeyEnv: 'DEEPSEEK_API_KEY',
      }),
      resolveAuth: async () => ({ headers: {} }),
    },
    providerInfo: (provider) => ({ id: provider, name: 'DeepSeek' }),
  }

  const llm = {
    adapters: new Map([['deepseek-official', { provider: { id: 'deepseek-official' }, adapter: baseAdapter }]]),
    registerAdapter(providers, adapter) {
      for (const provider of providers) {
        if (registered.has(provider)) throw new Error('duplicate adapter for ' + provider)
        registered.set(provider, { adapter, provider: adapter.providerInfo(provider) })
      }
      const handle = () => { for (const provider of providers) registered.delete(provider) }
      handle.replace = (next) => {
        for (const provider of providers) registered.delete(provider)
        for (const provider of next) registered.set(provider, { adapter, provider: adapter.providerInfo(provider) })
      }
      return handle
    },
    listProviders() {
      return [...registered.values()].map((entry) => ({ ...entry.provider }))
    },
    async listModels(provider) {
      if (provider === 'deepseek-official') return BASE_MODELS.map((m) => ({ ...m, provider }))
      const entry = registered.get(provider)
      if (!entry) return []
      const models = entry.adapter.dependencies.discoverModels
        ? await entry.adapter.dependencies.discoverModels(provider)
        : []
      return models
    },
  }

  const selection = { pending: null, lastUsed: null }
  const session = { id: 's1', requestHeader: () => undefined }
  const sessions = {
    get: (id) => (id === 's1' ? session : undefined),
    list: () => [session],
  }
  const sessionProjections = {
    stateOf: (s, key) => (key === 'modelSelection' ? selection : undefined),
  }
  const selections = []
  const sessionController = {
    async selectModel(request) {
      selections.push(request)
      selection.pending = { provider: request.provider, model: request.model }
      return { selected: { provider: request.provider, model: request.model } }
    },
  }

  const saves = []
  const services = {
    credentials,
    llm,
    sessions,
    sessionProjections,
    sessionController,
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
      saveSelection: async (sel) => { saves.push(sel) },
    },
  }

  const ctx = {
    get: (n) => (services[n] !== undefined ? services[n] : provided[n]),
    effect: (fn) => fn(),
    provide: (n, value) => { provided[n] = value },
    webServer: {
      register(route) {
        if (routes.has(route.path)) throw new Error('duplicate route ' + route.path)
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }

  return { ctx, refs, records, routes, saves, services, registered, selections, selection, provided }
}

function fakeRes() {
  const res = {
    status: 200,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers || {}
      return this
    },
    end(body) {
      this.body = body || ''
    },
  }
  return res
}

function fakeReq({ method = 'GET', url = '/', host = '127.0.0.1', body, remote = '127.0.0.1' } = {}) {
  const handlers = {}
  const req = {
    method,
    url,
    headers: host ? { host } : {},
    socket: { remoteAddress: remote },
    on(event, fn) {
      handlers[event] = fn
      return req
    },
    destroy() {},
  }
  process.nextTick(() => {
    if (body !== undefined && handlers.data) handlers.data(Buffer.from(body))
    if (handlers.end) handlers.end()
  })
  return req
}

async function call(routes, action, opts = {}) {
  const route = routes.get('/dsh-key-switch-api/' + action)
  assert.ok(route, 'route ' + action + ' 未注册')
  const res = fakeRes()
  await route.handler(fakeReq(opts), res)
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null }
}

const KEY_A = 'sk-test-placeholder-0001'
const KEY_B = 'sk-test-placeholder-0002'

test('导出契约', () => {
  assert.equal(name, 'dsh-key-switch')
  assert.deepEqual(inject, ['webServer', 'credentials'])
})

test('注册 8 条精确路由', async () => {
  const { ctx, routes } = makeHarness()
  apply(ctx, {})
  await tick()
  assert.deepEqual([...routes.keys()].sort(), [
    '/dsh-key-switch-api/activate',
    '/dsh-key-switch-api/add',
    '/dsh-key-switch-api/adopt',
    '/dsh-key-switch-api/bind',
    '/dsh-key-switch-api/remove',
    '/dsh-key-switch-api/rename',
    '/dsh-key-switch-api/state',
    '/dsh-key-switch-api/use-route',
  ])
})

test('state 只给脱敏值', async () => {
  const { ctx, routes } = makeHarness({ DEEPSEEK_API_KEY: KEY_A })
  apply(ctx, {})
  const { status, json } = await call(routes, 'state')
  assert.equal(status, 200)
  assert.equal(json.live.masked, '****0001')
  assert.equal(json.live.configured, true)
  assert.equal(json.keys.length, 0)
  assert.ok(!JSON.stringify(json).includes(KEY_A), '响应里不能出现明文密钥')
})

test('添加会给每把 key 建独立凭据引用 + 会话路由', async () => {
  const h = makeHarness({ DEEPSEEK_API_KEY: KEY_A })
  apply(h.ctx, {})
  const { json } = await call(h.routes, 'add', { method: 'POST', body: JSON.stringify({ key: KEY_B, note: '团队' }) })
  const item = json.keys[0]
  assert.equal(item.note, '团队')
  assert.equal(item.routed, true)
  assert.equal(h.refs.get(item.route.replace('dsh-key-', 'DSH_KEY_SWITCH_KEY_').toUpperCase()), KEY_B)
  assert.ok(h.registered.has(item.route), 'provider 路由必须真的注册')
  assert.equal(h.registered.get(item.route).adapter.providerInfo(item.route).name, 'DeepSeek · 团队')
})

test('adopt / activate / 删除', async () => {
  const h = makeHarness({ DEEPSEEK_API_KEY: KEY_A })
  apply(h.ctx, {})

  let r = await call(h.routes, 'adopt', { method: 'POST', body: '{}' })
  assert.equal(r.json.keys.length, 1)
  assert.equal(r.json.keys[0].note, '当前')
  assert.equal(r.json.keys[0].active, true)

  r = await call(h.routes, 'add', { method: 'POST', body: JSON.stringify({ key: KEY_B, note: '团队' }) })
  const idB = r.json.keys.find((k) => k.note === '团队').id
  assert.equal(h.refs.get('DEEPSEEK_API_KEY'), KEY_A, '添加不该动全局值')

  r = await call(h.routes, 'activate', { method: 'POST', body: JSON.stringify({ id: idB }) })
  assert.equal(h.refs.get('DEEPSEEK_API_KEY'), KEY_B, 'activate 必须写进 credentials')
  assert.equal(r.json.live.note, '团队')

  r = await call(h.routes, 'remove', { method: 'POST', body: JSON.stringify({ id: idB }) })
  assert.equal(r.json.keys.length, 1)
  assert.equal(h.refs.get('DEEPSEEK_API_KEY'), KEY_B, '删除池条目不能清掉全局凭据')
  assert.equal(h.registered.has('dsh-key-' + idB.replace(/^key-/, '')), false, '删除要注销会话路由')
  assert.equal(h.refs.has('DSH_KEY_SWITCH_KEY_' + idB.replace(/^key-/, '').toUpperCase()), false, '删除要清掉引用')
})

test('改名只动备注，不动密钥（回归：缓存过期时不能回写别的 key）', async () => {
  const h = makeHarness({ DEEPSEEK_API_KEY: KEY_A })
  apply(h.ctx, {})
  const { json } = await call(h.routes, 'add', { method: 'POST', body: JSON.stringify({ key: KEY_B, note: '一' }) })
  const id = json.keys[0].id
  const keyBefore = h.records.get('dsh-key-switch/' + id).payload.secret

  const r = await call(h.routes, 'rename', { method: 'POST', body: JSON.stringify({ id, note: '二' }) })
  assert.equal(r.json.keys[0].note, '二')
  assert.equal(h.records.get('dsh-key-switch/' + id).payload.secret, keyBefore)
})

test('bind：把会话切到该 key 的 provider 路由，模型不变', async () => {
  const h = makeHarness({ DEEPSEEK_API_KEY: KEY_A })
  apply(h.ctx, {})
  const { json } = await call(h.routes, 'add', { method: 'POST', body: JSON.stringify({ key: KEY_B, note: '团队' }) })
  const id = json.keys[0].id
  const route = 'dsh-key-' + id.replace(/^key-/, '')

  const r = await call(h.routes, 'bind', { method: 'POST', body: JSON.stringify({ sessionId: 's1', id }) })
  assert.equal(r.status, 200)
  assert.equal(h.selections.length, 1)
  assert.equal(h.selections[0].provider, route)
  assert.equal(h.selections[0].model, 'deepseek-flash')
  assert.equal(r.json.session.keyId, id)
  assert.equal(r.json.session.note, '团队')

  const back = await call(h.routes, 'bind', { method: 'POST', body: JSON.stringify({ sessionId: 's1', id: null }) })
  assert.equal(h.selections[1].provider, 'deepseek-official')
  assert.equal(back.json.session.followsGlobal, true)
})

test('bind：没有 sessionController 时 400', async () => {
  const h = makeHarness({ DEEPSEEK_API_KEY: KEY_A })
  delete h.services.sessionController
  h.ctx.get = (n) => h.services[n]
  apply(h.ctx, {})
  const r = await call(h.routes, 'bind', { method: 'POST', body: JSON.stringify({ sessionId: 's1', id: null }) })
  assert.equal(r.status, 400)
  assert.match(r.json.error, /会话模型服务/)
})

test('对外服务：keyById / keyForSession 只认活跃会话', async () => {
  const h = makeHarness({ DEEPSEEK_API_KEY: KEY_A })
  apply(h.ctx, {})
  const { json } = await call(h.routes, 'add', { method: 'POST', body: JSON.stringify({ key: KEY_B, note: '团队' }) })
  const id = json.keys[0].id
  const svc = h.provided.dshKeySwitch
  assert.ok(svc)
  const target = await svc.keyById(id)
  assert.equal(target.keyId, id)
  assert.equal(target.note, '团队')
  assert.match(target.ref, /^DSH_KEY_SWITCH_/)
  assert.equal(await svc.keyForSession('not-live'), null, '非活跃会话不能猜成全局默认 key')
})

test('非法输入与守卫', async () => {
  const h = makeHarness()
  apply(h.ctx, {})
  assert.equal((await call(h.routes, 'add', { method: 'POST', body: '{}' })).status, 400)
  assert.equal((await call(h.routes, 'add', { method: 'POST', body: JSON.stringify({ key: 'sk-有中文' }) })).status, 400)
  assert.equal((await call(h.routes, 'activate', { method: 'POST', body: JSON.stringify({ id: '../x' }) })).status, 400)
  assert.equal((await call(h.routes, 'state', { host: 'evil.example' })).status, 403)
  assert.equal((await call(h.routes, 'add', { method: 'GET' })).status, 405)
  assert.equal((await call(h.routes, 'state', { method: 'POST', body: '{}' })).status, 405)
  assert.equal((await call(h.routes, 'add', { method: 'POST', body: '{oops' })).status, 400)
})

test('state 带 sessionId 时报告该会话的 key', async () => {
  const h = makeHarness({ DEEPSEEK_API_KEY: KEY_A })
  apply(h.ctx, {})
  const { json } = await call(h.routes, 'add', { method: 'POST', body: JSON.stringify({ key: KEY_B, note: '团队' }) })
  const id = json.keys[0].id
  await call(h.routes, 'bind', { method: 'POST', body: JSON.stringify({ sessionId: 's1', id }) })
  const r = await call(h.routes, 'state', { url: '/dsh-key-switch-api/state?sessionId=s1' })
  assert.equal(r.json.session.keyId, id)
  assert.equal(r.json.session.provider, 'dsh-key-' + id.replace(/^key-/, ''))
})

test('use-route：把默认模型切到 API key 路由', async () => {
  const h = makeHarness()
  h.services.agentDefaultModel.currentSelection = () => ({ provider: 'deepseek-account', model: 'deepseek-flash' })
  apply(h.ctx, {})
  const { status } = await call(h.routes, 'use-route', { method: 'POST', body: '{}' })
  assert.equal(status, 200)
  assert.deepEqual(h.saves, [{ provider: 'deepseek-official', model: 'deepseek-flash' }])
})

test('路由提醒：账号路由要提示 key 不生效', async () => {
  const h = makeHarness()
  h.services.agentDefaultModel.currentSelection = () => ({ provider: 'deepseek-account', model: 'deepseek-flash' })
  apply(h.ctx, {})
  const { json } = await call(h.routes, 'state')
  assert.equal(json.route.provider, 'deepseek-account')
  assert.equal(json.route.expected, 'deepseek-official')
  assert.equal(json.route.canSwitch, true)
})
