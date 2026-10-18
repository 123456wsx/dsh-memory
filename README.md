# dsh-memory

> 给 [DeepSeek Harness](https://github.com/deepseek-ai) 的持久记忆插件：**模型自己记，你随时改，新开对话还记得。**

DSH 的会话上下文是单次的 —— 新开会话，它不记得你们上次聊了什么。这个插件补上这一块：

- **模型能写**：对话中判断"这事以后用得上"，直接调用工具写进长期记忆
- **自动被看见**：每次组装系统提示词时，把记忆摘要拼进去，不需要模型先想起来去查
- **你能编辑**：设置页里一节「记忆」，像 ChatGPT 的「个性化」那样搜、看、改、删
- **只在本地**：一个 JSONL 文件，不联网、不上传、随时能导出

---

## 特性

| | |
|---|---|
| 🧠 五工具 | `memory_write` / `memory_search` / `memory_list` / `memory_forget` / `memory_pin` |
| 🪄 自动注入 | 走 `ctx.systemPrompt.section`，每次请求自带记忆摘要（可调预算，也可关闭） |
| ✍️ 可视化编辑 | 设置 → 记忆：搜索、新增、行内编辑、置顶、删除 |
| 📒 纯文本存储 | `$DSH_HOME/memory/memories.jsonl`，能记事本打开、能进 git、坏行能救 |
| 🚫 无隐形淘汰 | 写满 `maxItems` 就拒写并提示清理，绝不偷偷删你的记忆 |
| 🔒 纯本地 | 不发起任何网络请求；HTTP 只挂在 DSH 自己的 localhost 上 |
| 🧩 软降级 | 缺 `systemPrompt` / `slots` 的旧版本上，工具与面板照常，只是少了自动注入 |

---

## 安装

### 从 npm（推荐）

```bash
cd ~/.dsh/profiles/desktop     # Web 用户把 desktop 换成 web
pnpm add dsh-memory
```

然后把 `dsh-memory` 加进该 profile `package.json` 的 `dsh.profile.bundles` 数组：

```jsonc
"bundles": [
  "@deepseek-ai/dsh-base",
  "dsh-memory"          // ← 加这一行
]
```

### 从本地目录（开发）

```powershell
# Windows：用 junction，避免 pnpm 重装覆盖
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-memory" `
  -Target "E:\path\to\dsh-memory"
```

再到 `package.json` 的 `bundles` 里加一行 `dsh-memory`。

### 生效

**完全退出客户端再启动**（点右上角 X 只是收窗口），然后**新开一个会话**。
打开 设置 → 记忆，能看见开关和列表就说明装好了。

---

## 使用

### 模型侧

模型在对话里自己判断要不要记。你也可以直接说：

> 记住：我不喜欢被叫「主人」，叫「船长」就行。

它就会调用 `memory_write` 写一条。下次新开会话，这条会出现在系统提示词的「长期记忆」段里。

### 人侧

设置 → 记忆：

- 顶部开关：暂停 / 恢复（暂停 = 不注入、工具拒写，已存条目不动）
- 用量条：`N / maxItems`，满了会变红并提示删除
- 搜索框：标题、正文、标签都能搜；可按作用域、类型筛
- 每条：置顶 / 编辑 / 删除（删除前自动快照到 `.bak`）

---

## 配置

写在 DSH 的插件 config（或 profile patch 的 `config:` 块）里：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `storeDir` | `$DSH_HOME/memory` | 存储目录 |
| `promptBudget` | `1500` | 每次注入的字符预算；`0` = 关闭自动注入 |
| `maxItems` | `5000` | 条数硬上限，写满即拒写 |
| `scopes` | `["global","workspace"]` | 启用哪些作用域 |
| `exposePanel` | `true` | 是否开放 `/__dsh-memory/` 调试单页 |
| `readonly` | `false` | 只读模式 |
| `dedupeThreshold` | `0.85` | 写入查重：标题相似度阈值 |

示例：

```yaml
- id: dsh-memory
  name: dsh-memory
  config:
    promptBudget: 1200
    maxItems: 3000
```

---

## 数据在哪

```
$DSH_HOME/memory/
├─ memories.jsonl     # 主存储：每行一条 JSON
├─ memories.jsonl.bak # 删除前的自动快照
└─ state.json         # 面板开关状态
```

想手工改？直接编辑 `memories.jsonl` 即可 —— 每行一条，改成合法 JSON 就生效。
写坏了也没关系：解析失败的行会被跳过，不会连累其它条目。

---

## 隐私

- 全部数据在本地文件里，**不发任何网络请求**
- HTTP 接口只挂在 DSH 自己的 localhost webServer 上，写操作校验同源 + JSON 类型
- 不读你的工作区文件、不记录会话全文，只存模型**显式写入**的内容
- 随时可在设置页导出 / 删除

---

## 开发

```bash
node --test test/store.test.mjs test/host.test.mjs
```

`test/store.test.mjs` 是存储层单元测试（12 项），
`test/host.test.mjs` 用一个仿造的 cordis ctx 跑通
`apply → 工具注册 → 工具执行 → 提示词注入 → HTTP 路由`（11 项）。

---

## 这个插件用了哪些 DSH 扩展点

| 能力 | API |
|---|---|
| 注册工具 | `ctx.tools.register(...)` |
| 注入系统提示词 | `ctx.systemPrompt.section({ name, order, text, interpolate })` |
| 挂 HTTP 路由 | `ctx.webServer.register({ kind: 'exact', path, handler })` |
| 设置页一节 | `ctx.slots.inject('settings.section', () => ctx.slots.register(...))` |
| 客户端入口 | `window.__ModuleLoader__.load({ id, factory })` + `require('react')` |

全部是官方支持的扩展点，不改 DSH 源码、不 fork。

---

## License

MIT
