/**
 * dsh-key-switch — 客户端半边。
 *
 * 1) 设置页「API 密钥」：密钥池（增删改、全局默认切换、路由提醒）。
 * 2) 对话输入框上方的「密钥」小胶囊：**按会话**选 key —— 它调用本插件宿主端的
 *    /bind，宿主再用 harness 自己的 `sessionController.selectModel()` 把该会话切到
 *    `dsh-key-<id>` 路由，模型保持不变。选择写在会话日志里（model/selection），
 *    所以刷新、重开、切回来都还在。
 * 3) 把「当前会话 id / 当前 key」发布到 window.__DSH_KEY_SWITCH__ 并派发
 *    `dsh-key-switch:active` 事件，余额挂件（dsh-whale-widget）据此显示对应 key 的余额。
 *
 * 数据只走本插件的同源 JSON API（/dsh-key-switch-api/*），响应里的 key 一律
 * 是脱敏值（****后四位）；明文密钥永远不会进入浏览器。
 *
 * 注册的模块 id 必须是包名（dsh-key-switch），与 dsh.client 清单一致，
 * 否则 ModuleLoader 会报 "loaded without registering"。
 */
window.__ModuleLoader__.load({
  id: 'dsh-key-switch',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const API = '/dsh-key-switch-api'
    const CSS_ID = 'dsh-key-switch/settings.css'
    const ACTIVE_EVENT = 'dsh-key-switch:active'
    const GLOBAL_KEY_ID = ''

    const CSS = [
      '.dks{display:flex;flex-direction:column;gap:16px;padding:6px 0;font-size:13px;color:var(--dsw-alias-label-primary);max-width:720px}',
      '.dks-block{display:flex;flex-direction:column;gap:10px}',
      '.dks-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}',
      '.dks-title{font-size:16px;font-weight:600;line-height:24px}',
      '.dks-sub{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:18px}',
      '.dks-mask{font-family:ui-monospace,Consolas,monospace;padding:2px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);letter-spacing:.5px}',
      '.dks-badge{font-size:11px;padding:1px 8px;border-radius:999px;background:color-mix(in srgb, #12b76a 14%, transparent);color:#12b76a;font-weight:600}',
      '.dks-warn{font-size:12px;line-height:18px;color:#b26a00;background:color-mix(in srgb, #f2d8b3 30%, transparent);border:1px solid color-mix(in srgb, #f2d8b3 60%, transparent);border-radius:8px;padding:8px 10px}',
      '.dks-card{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);flex-wrap:wrap}',
      '.dks-card.on{border-color:color-mix(in srgb, #12b76a 45%, transparent)}',
      '.dks-dot{width:8px;height:8px;border-radius:50%;background:#c9ccd1;flex:none}',
      '.dks-dot.on{background:#12b76a}',
      '.dks-note{min-width:60px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}',
      '.dks-actions{margin-left:auto;display:flex;gap:6px;flex:none}',
      '.dks-btn{height:28px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px;font-family:inherit}',
      '.dks-btn:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dks-btn.primary{background:#1f2328;color:#fff;border-color:transparent;font-weight:600}',
      '.dks-btn.danger{color:#d64545;border-color:color-mix(in srgb, #d64545 35%, transparent)}',
      '.dks-btn:disabled{opacity:.5;cursor:default}',
      '.dks-input{height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;font-family:inherit;box-sizing:border-box}',
      '.dks-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.dks-form{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.dks-form .dks-input.key{flex:1;min-width:200px}',
      '.dks-form .dks-input.note{width:160px}',
      '.dks-msg{font-size:12px;padding:6px 10px;border-radius:7px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:pre-wrap}',
      '.dks-msg.err{color:#d64545;border-color:color-mix(in srgb, #d64545 30%, transparent)}',
      '.dks-empty{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      // —— 输入框上方的会话级密钥胶囊 ——
      '.dksk{position:relative;display:inline-flex;align-items:center;justify-content:flex-end;width:100%}',
      '.dksk-pill{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;font-family:inherit;cursor:pointer;max-width:260px}',
      '.dksk-pill:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dksk-pill .dot{width:6px;height:6px;border-radius:50%;background:#c9ccd1;flex:none}',
      '.dksk-pill.on .dot{background:#12b76a}',
      '.dksk-pill .label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dksk-menu{position:absolute;right:0;bottom:calc(100% + 6px);z-index:60;min-width:220px;max-width:320px;padding:6px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-menu, var(--dsw-alias-bg-layer-1));box-shadow:0 10px 28px rgba(15,25,60,.18);display:flex;flex-direction:column;gap:2px}',
      '.dksk-item{display:flex;align-items:center;gap:8px;padding:7px 9px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;font-family:inherit;cursor:pointer;text-align:left;width:100%}',
      '.dksk-item:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dksk-item .name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dksk-item .tail{color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,Consolas,monospace;font-size:11px}',
      '.dksk-item.cur{background:color-mix(in srgb, #12b76a 12%, transparent)}',
      '.dksk-item:disabled{opacity:.55;cursor:default}',
      '.dksk-hint{padding:2px 9px 6px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
      '.dksk-err{padding:4px 9px 6px;color:#d64545;font-size:11px;line-height:16px}',
      // —— 模型名旁的 1017 角标（接管内置 ui-deepseek-model-label-1017）——
      '.dks-ml{display:inline-flex;align-items:center;gap:4px;white-space:nowrap;vertical-align:baseline}',
      '.dks-tag{display:inline-flex;align-items:center;height:16px;padding:0 5px;border-radius:999px;background:color-mix(in srgb, var(--dsw-alias-state-business-primary, #3b6cf6) 14%, transparent);color:var(--dsw-alias-state-business-primary, #3b6cf6);font-size:10px;font-weight:600;line-height:1}',
    ].join('')

    function ensureCss() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css="' + CSS_ID + '"]')) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-key-switch'
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    async function rpc(action, body, query) {
      const isRead = action === 'state'
      let url = API + '/' + action
      if (isRead && query) {
        const search = new URLSearchParams()
        for (const [k, v] of Object.entries(query)) if (v) search.set(k, v)
        const text = search.toString()
        if (text) url += '?' + text
      }
      const res = await fetch(url, {
        method: isRead ? 'GET' : 'POST',
        headers: isRead ? {} : { 'content-type': 'application/json' },
        body: isRead ? undefined : JSON.stringify(body || {}),
        cache: 'no-store',
      })
      let data = null
      try {
        data = await res.json()
      } catch (e) {
        data = null
      }
      if (!res.ok || (data && data.error)) {
        throw new Error((data && data.error) || ('HTTP ' + res.status))
      }
      return data
    }

    function h(tag, props, ...children) {
      return React.createElement(tag, props, ...children)
    }

    // ---- 共享小工具 ---------------------------------------------------------

    function keyRouteOf(state, id) {
      if (!state || !state.keys) return ''
      const hit = state.keys.find((k) => k.id === id)
      return hit ? hit.route : ''
    }

    function keyFromProvider(state, provider) {
      if (!state || !state.keys || !provider) return null
      return state.keys.find((k) => k.route === provider) || null
    }

    /** 把「当前会话 + 当前 key」发布给同页的余额挂件。 */
    function publishActive(detail) {
      try {
        window.__DSH_KEY_SWITCH__ = detail
        window.dispatchEvent(new CustomEvent(ACTIVE_EVENT, { detail }))
      } catch (e) { /* 非浏览器环境忽略 */ }
    }

    // ---- 设置页：密钥池 -----------------------------------------------------

    function KeyCard(props) {
      const k = props.item
      const [editing, setEditing] = React.useState(false)
      const [note, setNote] = React.useState(k.note)
      const [confirming, setConfirming] = React.useState(false)

      React.useEffect(() => { setNote(k.note) }, [k.note])

      if (editing) {
        return h('div', { className: 'dks-card' + (k.active ? ' on' : '') },
          h('span', { className: 'dks-dot' + (k.active ? ' on' : '') }),
          h('input', {
            className: 'dks-input',
            value: note,
            placeholder: '备注',
            onChange: (e) => setNote(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter') props.onRename(k.id, note)
              if (e.key === 'Escape') setEditing(false)
            },
          }),
          h('div', { className: 'dks-actions' },
            h('button', { className: 'dks-btn primary', onClick: () => props.onRename(k.id, note), disabled: props.busy }, '保存'),
            h('button', { className: 'dks-btn', onClick: () => setEditing(false) }, '取消')))
      }

      return h('div', { className: 'dks-card' + (k.active ? ' on' : '') },
        h('span', { className: 'dks-dot' + (k.active ? ' on' : '') }),
        h('span', { className: 'dks-note' }, k.note),
        h('span', { className: 'dks-mask' }, k.masked),
        k.active ? h('span', { className: 'dks-badge' }, '全局默认') : null,
        h('div', { className: 'dks-actions' },
          k.active ? null : h('button', {
            className: 'dks-btn primary',
            disabled: props.busy,
            onClick: () => props.onActivate(k.id),
          }, '设为全局'),
          h('button', { className: 'dks-btn', onClick: () => setEditing(true) }, '改名'),
          confirming
            ? h('button', {
              className: 'dks-btn danger',
              disabled: props.busy,
              onClick: () => { setConfirming(false); props.onRemove(k.id) },
            }, '确认删除')
            : h('button', {
              className: 'dks-btn danger',
              disabled: props.busy,
              onClick: () => setConfirming(true),
            }, '删除')))
    }

    function Panel() {
      const [data, setData] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState('')
      const [err, setErr] = React.useState(false)
      const [keyInput, setKeyInput] = React.useState('')
      const [noteInput, setNoteInput] = React.useState('')

      const load = React.useCallback(async () => {
        try {
          const next = await rpc('state')
          setData(next)
        } catch (e) {
          setErr(true)
          setMsg('加载失败：' + (e && e.message ? e.message : String(e)))
        }
      }, [])

      React.useEffect(() => { load() }, [load])

      const run = React.useCallback(async (action, body, okText) => {
        setBusy(true)
        setErr(false)
        setMsg('')
        try {
          const next = await rpc(action, body)
          setData(next)
          if (okText) setMsg(okText)
          return next
        } catch (e) {
          setErr(true)
          setMsg('操作失败：' + (e && e.message ? e.message : String(e)))
          return null
        } finally {
          setBusy(false)
        }
      }, [])

      const activate = (id) => {
        const item = data && data.keys ? data.keys.find((k) => k.id === id) : null
        run('activate', { id }, item ? ('「' + item.note + '」已设为全局默认，下一次模型调用即生效（已单独选 key 的会话不受影响）') : '已切换')
      }

      const remove = (id) => run('remove', { id }, '已从密钥池移除（正在使用它的会话会退回全局默认）')

      const rename = (id, note) => {
        if (!note || !note.trim()) {
          setErr(true)
          setMsg('备注不能为空')
          return
        }
        run('rename', { id, note }, '备注已保存')
      }

      const adopt = () => run('adopt', {}, '已把当前生效的 key 收进密钥池')

      const useRoute = () => run('use-route', {},
        '已把新会话的默认模型切到 DeepSeek（API key）路由。当前这个会话请仍在右下角模型选择器里选「DeepSeek」')

      const add = async () => {
        if (!keyInput.trim()) {
          setErr(true)
          setMsg('请填写 API 密钥')
          return
        }
        const next = await run('add', { key: keyInput.trim(), note: noteInput.trim() }, '已添加')
        if (next) {
          setKeyInput('')
          setNoteInput('')
        }
      }

      const live = data && data.live ? data.live : { masked: '', configured: false, inPool: false, note: '' }
      const route = data && data.route ? data.route : { provider: '', expected: 'deepseek-official' }
      const keys = data && data.keys ? data.keys : []
      const wrongRoute = !!(route.provider && route.provider !== route.expected)

      return h('div', { className: 'dks' },
        h('div', { className: 'dks-block' },
          h('div', { className: 'dks-head' },
            h('span', { className: 'dks-title' }, '全局默认（新会话 / 未单独选 key 的会话）'),
            h('span', { className: 'dks-mask' }, live.masked || '（未配置）'),
            live.note ? h('span', { className: 'dks-sub' }, '备注：' + live.note) : null,
            !live.configured ? h('span', { className: 'dks-sub' }, '还没有可用的 key') : null),
          h('div', { className: 'dks-sub' },
            '凭据引用 ' + (data ? data.ref : 'DEEPSEEK_API_KEY') + '　·　密钥以凭据记录形式存放在 harness 凭据文件里，页面只显示后四位'),
          h('div', { className: 'dks-sub' },
            '单个会话用哪把 key，在对话输入框上方的「密钥」胶囊里选；选择写进该会话自己的日志，刷新/重开都保留。'),
          data && data.routesError ? h('div', { className: 'dks-warn' }, data.routesError) : null,
          wrongRoute
            ? h('div', { className: 'dks-warn' },
              h('div', null,
                '默认模型走的是 ' + route.provider + (route.model ? ' / ' + route.model : '') +
                '（账号登录）路由，换 API key 对它无效。当前会话请在右下角模型选择器里选「DeepSeek」。'),
              h('div', { style: { marginTop: '8px' } },
                h('button', { className: 'dks-btn primary', disabled: busy, onClick: useRoute }, '把新会话默认模型切到「DeepSeek」')))
            : null),

        h('div', { className: 'dks-block' },
          h('div', { className: 'dks-head' }, h('span', { className: 'dks-title' }, '密钥池')),
          keys.length === 0
            ? h('div', { className: 'dks-empty' }, '还没有收录任何密钥。把常用 key 加进来，之后一键切换。')
            : h('div', { className: 'dks-block' }, keys.map((k) => h(KeyCard, {
              key: k.id,
              item: k,
              busy,
              onActivate: activate,
              onRemove: remove,
              onRename: rename,
            }))),
          live.configured && !live.inPool
            ? h('div', { className: 'dks-form' },
              h('button', { className: 'dks-btn', disabled: busy, onClick: adopt }, '把当前全局 key 收进池'))
            : null),

        h('div', { className: 'dks-block' },
          h('div', { className: 'dks-head' }, h('span', { className: 'dks-title' }, '添加密钥')),
          h('div', { className: 'dks-form' },
            h('input', {
              className: 'dks-input key',
              type: 'password',
              value: keyInput,
              placeholder: '粘贴 sk-… 密钥',
              autoComplete: 'new-password',
              onChange: (e) => setKeyInput(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') add() },
            }),
            h('input', {
              className: 'dks-input note',
              value: noteInput,
              placeholder: '备注（个人 / 团队）',
              onChange: (e) => setNoteInput(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') add() },
            }),
            h('button', { className: 'dks-btn primary', disabled: busy, onClick: add }, '添加'))),

        msg ? h('div', { className: 'dks-msg' + (err ? ' err' : '') }, msg) : null)
    }

    // ---- 输入框上方：本会话密钥 --------------------------------------------

    function SessionKeyPill(props) {
      const sessionId = props.sessionId
      const projection = typeof props.useProjection === 'function' ? props.useProjection('modelSelection') : undefined
      const [data, setData] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [err, setErr] = React.useState('')

      const load = React.useCallback(async (id) => {
        if (!id) return null
        try {
          const next = await rpc('state', null, { sessionId: id })
          setData(next)
          return next
        } catch (e) {
          setErr(e && e.message ? e.message : String(e))
          return null
        }
      }, [])

      React.useEffect(() => { void load(sessionId) }, [load, sessionId])

      const selectedProvider = projection && (projection.next || projection.lastUsed)
        ? (projection.next || projection.lastUsed).provider
        : (data && data.session ? data.session.provider : '')

      const baseProvider = data ? data.provider : 'deepseek-official'
      const current = keyFromProvider(data, selectedProvider)
      const managed = !selectedProvider || selectedProvider === baseProvider || !!current
      const keyId = current ? current.id : (selectedProvider === baseProvider || !selectedProvider ? GLOBAL_KEY_ID : null)

      // 发布给余额挂件：会话 + 当前 key（provider 变化也要发，挂件会立即重取余额）。
      React.useEffect(() => {
        if (!sessionId) return
        publishActive({
          sessionId,
          provider: selectedProvider || '',
          keyId: keyId === null ? '' : keyId,
          note: current ? current.note : (selectedProvider === baseProvider || !selectedProvider ? '全局默认' : ''),
        })
      }, [sessionId, selectedProvider, keyId, current])

      const choose = async (id) => {
        setBusy(true)
        setErr('')
        try {
          const next = await rpc('bind', { sessionId, id: id || null })
          setData(next)
          setOpen(false)
          try { props.onChanged && props.onChanged(next) } catch (e) { /* 忽略 */ }
        } catch (e) {
          setErr(e && e.message ? e.message : String(e))
        } finally {
          setBusy(false)
        }
      }

      if (!managed || !sessionId) return null
      if (!data) return null

      const keys = data.keys || []
      const label = current
        ? current.note
        : (selectedProvider === baseProvider || !selectedProvider ? '全局默认' : '未托管')
      const masked = current ? current.masked : data.live.masked

      return h('div', { className: 'dksk' },
        h('button', {
          className: 'dksk-pill' + (current || selectedProvider === baseProvider ? ' on' : ''),
          title: '本会话使用的 API key：' + label + (masked ? '（' + masked + '）' : '') + '　点击切换',
          onClick: () => { setOpen((v) => !v); if (!open) void load(sessionId) },
        },
        h('span', { className: 'dot' }),
        h('span', { className: 'label' }, '密钥 · ' + label),
        h('span', { style: { fontSize: '10px', opacity: .7 } }, '▾')),

        open
          ? h('div', { className: 'dksk-menu' },
            h('div', { className: 'dksk-hint' }, '只影响这个会话；模型保持不变'),
            h('button', {
              className: 'dksk-item' + (keyId === GLOBAL_KEY_ID ? ' cur' : ''),
              disabled: busy,
              onClick: () => choose(null),
            },
            h('span', { className: 'name' }, '跟随全局默认'),
            h('span', { className: 'tail' }, data.live.masked || '未配置')),
            keys.map((k) => h('button', {
              key: k.id,
              className: 'dksk-item' + (keyId === k.id ? ' cur' : ''),
              disabled: busy || !k.routed,
              title: k.routed ? '' : '该 key 的会话路由尚未注册（检查基础 DeepSeek API key 路由）',
              onClick: () => choose(k.id),
            },
            h('span', { className: 'name' }, k.note),
            h('span', { className: 'tail' }, k.masked))),
            keys.length === 0 ? h('div', { className: 'dksk-hint' }, '密钥池是空的，请到「设置 → API 密钥」添加') : null,
            err ? h('div', { className: 'dksk-err' }, err) : null)
          : null)
    }

    // ---- 模型名旁的 1017 角标 ----------------------------------------------
    //
    // 内置的 ui-deepseek-model-label-1017 把角标写死给 provider.id ∈ {deepseek-official,
    // deepseek-account}；会话级 key 路由有自己的 provider id（dsh-key-*），所以那些条目
    // 只会显示裸名 "DeepSeek-V4.1-Flash"。这里在同一个 slot 里重建同样的装饰（并在 profile
    // 里关闭内置那一条），把 dsh-key-* 也纳入；其它来源的模型名原样返回。
    const FLASH_NAME = 'DeepSeek-V4.1-Flash'

    function isDeepSeekProvider(id) {
      const text = typeof id === 'string' ? id : ''
      if (text === 'deepseek-official' || text === 'deepseek-account') return true
      return text.indexOf('dsh-key-') === 0
    }

    function ModelLabel(props) {
      const provider = props.provider
      const model = props.model
      const name = model && model.name ? model.name : ''
      if (!provider || !model) return name
      if (!isDeepSeekProvider(provider.id)) return name
      if (model.id !== 'deepseek-flash' || name !== FLASH_NAME) return name
      return h('span', { className: 'dks-ml' },
        h('span', null, name),
        h('span', { className: 'dks-tag' }, '1017'))
    }

    // ---- 注册 --------------------------------------------------------------

    function apply(ctx) {
      ensureCss()

      const slots = ctx.get('slots')
      if (slots !== undefined) {
        slots.inject('conversation.input.model.label', () => slots.register({
          name: 'conversation.input.model.label',
        }, ModelLabel))

        slots.inject('settings.section', () => slots.register({
          name: 'settings.section',
          id: 'api-keys',
          order: 26,
          label: 'API 密钥',
        }, () => React.createElement(Panel, null)))

        slots.inject('conversation.composer.dock', () => slots.register({
          name: 'conversation.composer.dock',
          id: 'dsh-key-switch',
          order: 5,
        }, (props) => React.createElement(SessionKeyPill, props)))
      }

      // 兜底：即使输入框插槽还没挂上（首页/空会话），也把“当前会话”告诉余额挂件。
      try {
        ctx.inject(['uiSession'], (child) => {
          const source = child.uiSession && child.uiSession.current
          if (!source || typeof source.subscribe !== 'function') return
          const push = () => {
            const value = source.getSnapshot()
            const sessionId = value && value.props ? value.props.sessionId : ''
            if (!sessionId) return
            const prev = window.__DSH_KEY_SWITCH__
            if (prev && prev.sessionId === sessionId) return
            publishActive({ sessionId, provider: '', keyId: '', note: '' })
          }
          push()
          const stop = source.subscribe(push)
          child.effect(() => () => { try { stop() } catch (e) { /* 忽略 */ } })
        })
      } catch (e) { /* 旧版没有 uiSession 时跳过 */ }
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
