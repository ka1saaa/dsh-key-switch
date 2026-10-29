# 让 dsh-whale-widget 显示“当前会话那把 key”的余额

`dsh-whale-widget`（小鲸鱼余额挂件）默认只查全局 `DEEPSEEK_API_KEY`。本插件会做两件事：

1. 把「当前会话 / 当前 key / 备注」发布到浏览器：`window.__DSH_KEY_SWITCH__ = { sessionId, keyId, provider, note }`，
   并派发 `dsh-key-switch:active` 事件；
2. 对外暴露 `ctx.dshKeySwitch` 服务：`keyById(keyId)` / `keyForSession(sessionId)` 返回
   `{ keyId, note, label, ref }`（`ref` 是该 key 的凭据引用）。

挂件按下面的方式小改即可（本仓库不包含挂件本体——它是第三方插件，素材不在 MIT 范围内）：

## 宿主 `lib/index.js`

- 余额缓存按 key 分桶（一个全局缓存改成 `Map<keyId, payload>`）。
- 取余额前解析目标 key：

```js
async function balanceKeyTarget(keyId, sessionId) {
  const svc = ctx.get('dshKeySwitch')
  if (!svc) return { ref: 'DEEPSEEK_API_KEY', keyId: '', keyNote: '' }
  if (keyId && svc.keyById) {
    const t = await svc.keyById(keyId).catch(() => null)
    if (t && t.ref) return { ref: t.ref, keyId: t.keyId, keyNote: t.label || t.note }
  }
  if (sessionId && svc.keyForSession) {
    const t = await svc.keyForSession(sessionId).catch(() => null)
    if (t && t.ref) return { ref: t.ref, keyId: t.keyId, keyNote: t.label || t.note }
  }
  return { ref: 'DEEPSEEK_API_KEY', keyId: '', keyNote: '' }
}
```

- `credentials.resolve(target.ref)` 代替写死的 `DEEPSEEK_API_KEY`；
- 指定了 key 时**不要**回退账号登录余额（否则会把账号余额冒充成该 key 的）；
- `/dsh-whale/balance.json` 接受 `?keyId=&sessionId=`，回包带上 `keyId` / `keyNote`。

## 前端 `assets/whale-widget.js`

- 取余额时带上：

```js
const s = window.__DSH_KEY_SWITCH__
const q = new URLSearchParams(manual ? { refresh: '1' } : {})
if (s?.keyId) q.set('keyId', s.keyId)
if (s?.sessionId) q.set('sessionId', s.sessionId)
fetch('/dsh-whale/balance.json?' + q, { cache: 'no-store' })
```

- 监听 `window.addEventListener('dsh-key-switch:active', () => refresh(true))`，切会话立即刷新；
- 用回包的 `keyNote` 在菜单底部显示「密钥 · 备注」，避免看错余额属于哪把 key。

## 安装方式

把改好的挂件放进 profile 的 `node_modules/dsh-whale-widget`（或做目录 junction），
它仍按 `dsh-whale-widget` 这个名字被 `dsh.profile.bundles` 加载，不需要改 id。
