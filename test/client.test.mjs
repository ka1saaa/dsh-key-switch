/**
 * dsh-key-switch 客户端半边测试：不启浏览器，只验证 bundle 契约。
 *  - 以 window.__ModuleLoader__.load({ id }) 注册，且 id 等于包名
 *  - factory 物化后导出 apply / inject
 *  - apply 注册 settings.section、输入框上方的会话密钥胶囊、模型名 1017 角标
 *
 * 运行：node --test test/client.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))

async function loadBundle() {
  const source = await readFile(join(here, '..', 'lib', 'client.js'), 'utf8')
  let registered = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(config) { registered = config },
      },
      dispatchEvent() {},
    },
    document: undefined,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail } },
    console,
    fetch: async () => { throw new Error('testing: no network') },
    URLSearchParams,
  }
  vm.createContext(sandbox)
  new vm.Script(source, { filename: 'lib/client.js' }).runInContext(sandbox)
  assert.ok(registered, '必须调用 window.__ModuleLoader__.load')
  return registered
}

test('bundle 以包名注册', async () => {
  const bundle = await loadBundle()
  assert.equal(bundle.id, 'dsh-key-switch')
  assert.equal(typeof bundle.factory, 'function')
})

test('factory 导出 apply / inject', async () => {
  const bundle = await loadBundle()
  const reactStub = { createElement: () => ({ type: 'stub' }) }
  const mod = bundle.factory((id) => {
    if (id === 'react') return reactStub
    throw new Error('unexpected require: ' + id)
  })
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual([...mod.inject], ['slots'])
})

test('apply 注册设置页 / 会话胶囊 / 模型角标', async () => {
  const bundle = await loadBundle()
  const reactStub = { createElement: (t, p, ...c) => ({ type: t, props: p, children: c }) }
  const mod = bundle.factory((id) => (id === 'react' ? reactStub : null))

  const registered = new Map()
  const slots = {
    inject(type, cb) {
      registered.set(type, [])
      cb()
    },
    register(def, component) {
      registered.get(def.name).push({ def, component })
      return { dispose() {} }
    },
  }
  const ctx = { get: (n) => (n === 'slots' ? slots : undefined) }
  mod.apply(ctx)

  const settings = registered.get('settings.section')
  assert.equal(settings.length, 1)
  assert.equal(settings[0].def.id, 'api-keys')
  assert.equal(settings[0].def.order, 26)
  assert.equal(settings[0].def.label, 'API 密钥')
  assert.equal(typeof settings[0].component, 'function')

  const dock = registered.get('conversation.composer.dock')
  assert.equal(dock.length, 1)
  assert.equal(dock[0].def.id, 'dsh-key-switch')
  assert.equal(typeof dock[0].component, 'function')

  assert.equal(registered.get('conversation.input.model.label').length, 1)
})

test('模型角标只给 DeepSeek 路由的 V4.1-Flash 打 1017', async () => {
  const bundle = await loadBundle()
  const reactStub = { createElement: (t, p, ...c) => ({ type: t, props: p, children: c }) }
  const mod = bundle.factory((id) => (id === 'react' ? reactStub : null))

  let label = null
  const slots = {
    inject(type, cb) { cb() },
    register(def, component) { if (def.name === 'conversation.input.model.label') label = component; return { dispose() {} } },
  }
  mod.apply({ get: (n) => (n === 'slots' ? slots : undefined) })
  assert.equal(typeof label, 'function')

  const flash = { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }
  const prose = { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }

  // 基础路由 / 账号路由 / 会话级 key 路由都要有角标
  for (const id of ['deepseek-official', 'deepseek-account', 'dsh-key-abc']) {
    const out = label({ provider: { id }, model: flash })
    assert.equal(out.type, 'span')
    assert.equal(out.children[1].children[0], '1017')
  }
  // 其它模型、其它 provider、名字不符：原样返回名字
  assert.equal(label({ provider: { id: 'dsh-key-abc' }, model: prose }), 'DeepSeek-V4-Pro')
  assert.equal(label({ provider: { id: 'other' }, model: flash }), 'DeepSeek-V4.1-Flash')
  assert.equal(label({ provider: { id: 'deepseek-official' }, model: { id: 'deepseek-flash', name: '改名了' } }), '改名了')
})

test('没有 slots 服务时安静退出', async () => {
  const bundle = await loadBundle()
  const mod = bundle.factory(() => ({ createElement: () => null }))
  mod.apply({ get: () => undefined })
})
