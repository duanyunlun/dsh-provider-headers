# dsh-provider-headers

[English](README.en.md) | 中文

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的**模型设置页**加上"自定义请求头"编辑器：在每一个 pi-ai 提供方的卡片里直接增删请求头，并把 `${sessionId}` 按会话展开。

**不修改任何 dsh 源码，也不修改打包好的应用。** 全部通过 dsh 的插件机制完成：UI 走模型设置页官方预留的扩展槽，配置写进 Harness 自带的字段，卸载后完全还原。

## 它解决什么问题

dsh 本身就支持按提供方配置请求头——`llm-pi-ai.providers.<路由>.headers`。它会被：

- 合并进该路由的**模型请求**（`packages/llm/llm-pi-ai/src/adapter.ts`）
- 合并进该路由的**「获取可用模型」请求**（`packages/llm/llm-pi-ai/src/discovery.ts`）

但这个字段只在 `settings.yaml` 里手写，模型设置页没有入口（`packages/client/ui-settings-models/README.md` 明确写了这一点，页面上的提示也让你"直接编辑 settings.yaml"）。

本插件补上这个入口，并额外解决一件原生配置做不到的事：**值随会话变化**。

## 安装

需要 Node.js `^22.19.0 || >=24.0.0` 和 pnpm。

```sh
# 已发布到 npm 后
dsh plugin --profile desktop add dsh-provider-headers

# 从本地目录安装
dsh plugin --profile desktop add /path/to/dsh-provider-headers

# 或者先打包再装
npm pack
dsh plugin --profile desktop add ./dsh-provider-headers-0.1.0.tgz
```

把 `desktop` 换成你实际使用的 profile 名（`dsh` 默认 profile 是 `web`）。装完**重启该 profile**，插件的浏览器半才会被页面加载。

本包声明了 `dsh.bundle.patch`，因此它作为 **bundle 插件**进入 profile 的 `dsh.profile.bundles` 层栈——不需要手工写挂载行，**设置页也能直接启用 / 禁用 / 卸载它**。

卸载：

```sh
dsh plugin --profile desktop remove dsh-provider-headers
```

已写进 `settings.yaml` 的请求头不会被主动删除。

## 进入插件市场

npm 上的包本身不会自动出现在市场的设置页里。市场索引由第三方仓库 [DSH-Plugins-Marketplace](https://github.com/bradeGithub/DSH-Plugins-Marketplace) 维护，按 GitHub 的 **`dsh-plugin`** topic 全量抓取（约 3100 条）：

1. 把本仓库推到 GitHub。
2. 打上 `dsh-plugin` topic；再加 `deepseek-harness-plugin`、`request-headers` 提升搜索命中。
3. 在 `package.json` 补 `repository` / `homepage` / `bugs`——安装器的"已安装判定"会做包名与 repository 的双向匹配。

索引抓取有延迟，仓库建好不会立刻出现。安装器在 npm 已发布时优先走 npm。

## 使用

1. 打开 **设置 → 模型**。
2. 展开任意一个 pi-ai 提供方（DeepSeek 官方、内置第三方、自定义提供方都算）。
3. 卡片里会出现 **「自定义请求头（N）」**，展开后按 `名称` / `值` 逐行填写。
4. 点 **保存**。写入位置就是 Harness 原生的那个字段。

### 以 OpenCode Go 为例

OpenCode 从 09/05 起要求所有推理请求带 `x-opencode-session`，且需要一个**每会话稳定**的 ID。在 `opencode-go` 卡片里加一行：

| 名称 | 值 |
|---|---|
| `x-opencode-session` | `${sessionId}` |

保存后，每个会话的请求都会带上属于它自己的 ID。落在 `settings.yaml` 里是这样：

```yaml
llm-pi-ai:
  providers:
    opencode-go:
      apiKeyEnv: OPENCODE_GO_API_KEY
      headers:
        x-opencode-session: ${sessionId}
```

也可以完全不写占位符，填一个固定值——那部分由 Harness 原生逻辑处理，插件不参与。

## `${sessionId}` 是怎么生效的

Harness 无法自己展开它：一个提供方 profile 按路由解析一次，同一路由下所有会话共用同一个值。

所以插件的宿主半做了两件事：

1. 监听 `llm/stream` 瀑布，把**一次**流式调用放进一个携带该调用会话 ID 的 `AsyncLocalStorage` 作用域。
2. 在插件生命周期内包装 `globalThis.fetch`；只有落在上述作用域内的请求才会被附加展开后的请求头。

作用域之外的任何请求原样透传给原来的 `fetch`，其他插件后装的 wrapper 也不会被本插件卸载时覆盖掉。

只有**值里含占位符**的请求头走这条路径；固定值的请求头仍然走 Harness 原生逻辑。

## 配置

```yaml
- id: model-headers
  config:
    dynamic: true      # 默认 true；设为 false 则完全不安装 fetch 包装与监听器
    hosts: []          # 默认空 = 作用域内所有主机；填写则按主机后缀收窄
```

## 已知限制

- **只覆盖 pi-ai 路由。** `llm-deepseek` 的 `Config` 里根本没有 `headers` 字段（请求头是硬编码的），所以 DeepSeek 官方路由的卡片不会出现这个编辑器，需要先改 Harness 本体。
- **`user-agent` 不能覆盖。** 它是 Harness 的归属标识，原生路径与插件路径都会跳过它。
- **`${sessionId}` 只覆盖流式模型请求。** 「获取可用模型」是一次由 UI 触发的一次性请求，不经过 `llm/stream`，因此那里仍然发送字面量。固定值不受影响。
- **编辑器渲染在卡片里、「编辑」表单之外**，因为模型设置页只开放了这一个槽位。
- 请求头的值以普通文本存在 `settings.yaml`，**不会被脱敏**。不要把密钥写进请求头，用 Harness 的凭据字段（`apiKeyEnv`）。

## 开发与验证

```sh
npm test
```

两组检查都不依赖 dsh 运行时：

- `test/verify.mjs` —— 宿主半：假 ctx + 记录型 `fetch`，验证展开确实到达了线上请求、并发会话互不串号、保留名不被附加、作用域外的请求不受影响、以及卸载能还原 `fetch`。
- `test/verify-client.mjs` —— 浏览器半：把 `client.js` 当作页面模块队列里的产物加载，用一个极小的 React 桩驱动组件，验证注册的槽位与 key、以及写出的 path op 恰好落在 `providers.<路由>.headers` 上并按 revision 加锁。

## 许可证

MIT
