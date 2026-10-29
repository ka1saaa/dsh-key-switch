# dsh-key-switch

给 DeepSeek Harness 的**多 API key 池**插件：在 **设置 → API 密钥** 里维护多把 key；
在**对话输入框上方**给**每个会话**单独选一把 key —— 选完写进会话日志（`model/selection`），
刷新、重开、切回来都还在；配合 `dsh-whale-widget` 余额挂件，挂件会显示**当前会话那把 key** 的余额。

## 功能

- **密钥池**：维护任意多把 key，每把带备注（项目 / 个人 / 团队…）
- **会话级选择**：输入框上方的「密钥 · <备注>」胶囊，一键把**这个会话**切到某把 key，模型保持不变
- **跟随全局**：不单独选时用「全局默认」，新会话也用它（“设为全局”按钮）
- **收录当前 key**：文件里已经在用但还没进池的 key，一键收进来
- **备注改名 / 删除**：删条目不会清掉正在生效的全局凭据；在线会话与默认模型会自动挪回 DeepSeek 路由
- **路由提醒**：默认模型走 `deepseek-account`（账号登录）时黄条提示「换 API key 对它无效」
- **只给脱敏值**：所有接口只返回 `****后四位`，明文密钥永远不进浏览器
- **模型名 1017 角标**：接管内置 `ui-deepseek-model-label-1017`，让会话级 key 路由的
  `DeepSeek-V4.1-Flash` 也带 `1017`（内置那条只认 `deepseek-official`/`deepseek-account`）

## 每个会话一把 key 是怎么做到的

1. **每把 key 一条 provider 路由**：池里每把 key 注册成 `dsh-key-<id>` 的 provider，
   适配器是基础 DeepSeek 适配器的视图，只把 `options().apiKeyEnv` 换成本 key 自己的凭据引用
   （`DSH_KEY_SWITCH_KEY_<ID>`）。鉴权仍由 DeepSeek provider 自己的 `resolveAuth` 完成，
   所以**并发会话各用各的 key，不会串**。
2. **会话选择复用 harness 自带的「会话级模型选择」**：胶囊调用宿主的
   `sessionController.selectModel({ sessionId, provider: 'dsh-key-…', model })`，
   它会往该会话日志写 `model/selection` —— 天然持久化、跟随会话、不需要插件自己存状态。
3. **余额挂件**：胶囊把「当前会话 / 当前 key / 备注」发布到 `window.__DSH_KEY_SWITCH__`
   并派发 `dsh-key-switch:active`；改造后的 `dsh-whale-widget` 取余额时带上 `keyId`，
   宿主通过本插件暴露的 `ctx.dshKeySwitch.keyById()` 找到那把 key 的凭据再查余额。

   挂件是第三方插件（`MeteorNOX/DeepSeek-Balance-Whale-Widget`），本仓库**不包含它的素材**；
   需要改哪几行见 [docs/whale-widget-integration.md](docs/whale-widget-integration.md)。

## 安装

```powershell
# 1) 把包放进 profile 的 node_modules（或做成目录 junction，见下）
copy-item -Recurse . "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-key-switch"
```

`cordis.patch.yml` 末尾加：

```yaml
- insert:
    - id: dsh-key-switch
      name: dsh-key-switch
```

纯 `insert` 会热挂载，不用重启；改完 `lib/*.js` 后 touch 一下 profile 的 `cordis.patch.yml`
即可让宿主半边重新加载（客户端半边需要刷新页面）。

### 可选：让模型名带 1017 角标

内置的角标只认 `deepseek-official` / `deepseek-account`，会话级 key 路由会丢角标，
所以本插件在同一个 slot 里重建了它。需要**关掉内置那条**（否则 `single` slot 会冲突）：

```yaml
- id: ui-deepseek-model-label-1017
  disabled: true
```

## 配置

```yaml
- id: dsh-key-switch
  name: dsh-key-switch
  config:
    ref: DEEPSEEK_API_KEY       # 全局默认 key 的凭据引用
    provider: deepseek-official # 会话级路由派生自哪个 provider（必须是 API key 路由）
```

## 数据存哪

密钥存 harness 凭据文件（`~/.dsh/.credentials.yaml`）：

```yaml
records:
  dsh-key-switch/key-1a2b3c4d:      # 池条目：备注 / 密钥 / 创建时间
    kind: grant
    payload: { note: 项目, secret: sk-…, ref: DSH_KEY_SWITCH_KEY_1A2B3C4D, createdAt: … }
refs:
  DSH_KEY_SWITCH_KEY_1A2B3C4D: sk-…  # 该 key 的 provider 路由鉴权用的引用
  DEEPSEEK_API_KEY: sk-…             # 全局默认
```

要点：

- **删除池条目**会删记录 + 删除它自己的引用，但**不动**全局 `DEEPSEEK_API_KEY`。
- **改名只写备注**：密钥以记录里的现值为准，绝不从列表快照回写（防止缓存过期时把别的 key 写进来）。

## 接口

同源 JSON，只接受回环地址（同时校验 `remoteAddress` 与 `Host` 头）：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/dsh-key-switch-api/state?sessionId=` | 池 + 全局值（脱敏）+ 指定会话的当前 key |
| POST | `/dsh-key-switch-api/add` | `{ key, note }` |
| POST | `/dsh-key-switch-api/activate` | `{ id }` 设为全局默认 |
| POST | `/dsh-key-switch-api/bind` | `{ sessionId, id \| null }` 会话级选中 / 跟随全局 |
| POST | `/dsh-key-switch-api/remove` | `{ id }` |
| POST | `/dsh-key-switch-api/rename` | `{ id, note }` |
| POST | `/dsh-key-switch-api/adopt` | 把当前全局 key 收进池 |
| POST | `/dsh-key-switch-api/use-route` | 把新会话默认模型切到 API key 路由 |

## 卸载

1. 从 `cordis.patch.yml` 删掉 `dsh-key-switch` 那条 insert（热卸载）；
2. 删 `~/.dsh/profiles/desktop/node_modules/dsh-key-switch`；
3. 可选：清掉 `.credentials.yaml` 里 `dsh-key-switch/` 开头的 records 与 `DSH_KEY_SWITCH_` 开头的 refs；
4. 已绑定到 `dsh-key-*` 路由的会话/默认模型会变成“模型不可用”，改回 `DeepSeek` 即可。

## 测试

```powershell
node --test test/host.test.mjs test/client.test.mjs
```

## 已知边界

- 只换 API key 路由的凭据；`deepseek-account` 账号登录那条不走这个机制。
- 每把 key 会在模型选择器里多出一个 provider 分组（`DeepSeek · <备注>`），这是会话级隔离的代价。
- 会话级选择是 harness 的 `model/selection` 事件：如果之后换了 provider 分组（比如手动选回 `deepseek-official`），
  该会话就回到「跟随全局」。

## 许可

[MIT](LICENSE)。本仓库不含任何 API key；密钥只存在于 harness 的 `~/.dsh/.credentials.yaml`。
