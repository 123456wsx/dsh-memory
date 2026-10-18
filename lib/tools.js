/**
 * dsh-memory — agent 工具集。
 *
 * 五个工具，全部走 `ctx.tools.register()`。约定：
 *   * 参数一律 JSON Schema，`additionalProperties: false`（模型少犯错）
 *   * 返回值统一为 `{ ok, message, ... }`，`render` 只把 message 给模型看
 *   * `execute(args, exec)` 透传 `exec.signal`，便于长检索取消
 *
 * tools 也是软依赖：拿不到 `ctx.tools` 就返回 false，不抛错。
 */
import { serviceOf } from './config.js'
import { KINDS, normalizeKind, normalizeScope } from './store.js'

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    message: { type: 'string' },
  },
  required: ['ok', 'message'],
}

const QUICK_MS = 15_000
const WRITE_MS = 30_000

function asText(message) {
  return [{ type: 'text', text: String(message ?? '') }]
}

function guard(runtime) {
  const active = typeof runtime.isActive === 'function' ? runtime.isActive() : runtime.enabled
  if (active) return null
  if (runtime.paused === true) {
    return {
      ok: false,
      message: '记忆功能已暂停（设置 → 记忆 里的开关关着）。需要时可以先打开。',
    }
  }
  return {
    ok: false,
    message: '记忆功能当前是关闭的（enabled = false）。可以在 设置 → 记忆 里打开。',
  }
}

/**
 * @param {any} ctx
 * @param {{ store: import('./store.js').MemoryStore, config: any, enabled: boolean,
 *           resolveScope: (raw?: string) => string, workspaceKey: string }} runtime
 * @returns {boolean} 是否注册成功
 */
export function registerMemoryTools(ctx, runtime) {
  const tools = serviceOf(ctx, 'tools')
  if (!tools || typeof tools.register !== 'function') return false

  const define = (definition) => {
    try {
      tools.register(definition)
      return true
    } catch {
      // 单个工具注册失败（重名 / schema 不合法）不影响其它工具
      return false
    }
  }

  // ---------------------------------------------------------------- write
  define({
    name: 'memory_write',
    description: [
      '把一件值得跨会话记住的事写进长期记忆，下次开新对话时自动可见。',
      '适合记：用户明确的长期偏好（称呼、语气、禁忌）、确认过的项目决策、反复用得上的背景事实。',
      '不要记：一次性的临时细节、任务的中间状态、能从代码或文件里直接读到的内容。',
      '同一个事实重复提交会更新原条目而不是新增。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: {
          type: 'string',
          description: '一句话标题，便于列表与检索，例如「称呼偏好」。必填。',
        },
        text: {
          type: 'string',
          description: '正文。写成完整的陈述句，例如「用户希望被称呼为「船长」，不喜欢「主人」」。',
        },
        kind: {
          type: 'string',
          enum: KINDS,
          description: '条目类型：preference 偏好 / decision 决策 / project 项目 / fact 事实 / todo 待办 / note 随手记。默认 note。',
        },
        scope: {
          type: 'string',
          description: '作用域：global（所有会话，默认）或 workspace（仅当前工作区）。',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '标签，便于检索，可选。',
        },
        pinned: {
          type: 'boolean',
          description: '置顶。置顶条目在自动注入时优先，且不占淘汰名额。',
        },
      },
      required: ['title'],
    },
    output: { schema: RESULT_SCHEMA, render: (_args, value) => asText(value.message) },
    timeoutMs: WRITE_MS,
    async execute(args) {
      const blocked = guard(runtime)
      if (blocked) return blocked
      const result = runtime.store.upsert({
        title: args?.title,
        text: args?.text,
        kind: args?.kind,
        scope: runtime.resolveScope(args?.scope),
        tags: args?.tags,
        pinned: args?.pinned,
        source: { by: 'agent', at: Date.now() },
      })
      if (!result.ok) {
        return { ok: false, message: result.message ?? '写入失败。' }
      }
      const verb = result.action === 'created' ? '已记下' : '已更新'
      const usage = runtime.store.usage()
      return {
        ok: true,
        message: `${verb}：${result.item.title}（当前 ${usage.count}/${usage.maxItems} 条）。`,
        id: result.item.id,
        action: result.action,
      }
    },
  })

  // --------------------------------------------------------------- search
  define({
    name: 'memory_search',
    description:
      '在长期记忆里按关键词检索。用户提到「以前」「上次」「我说过」这类线索，或需要确认某项偏好时调用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '关键词，可空格分隔多个。' },
        scope: { type: 'string', description: '限定作用域，可选。' },
        kind: { type: 'string', enum: KINDS, description: '限定类型，可选。' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '返回条数，默认 8。' },
      },
      required: ['query'],
    },
    output: { schema: RESULT_SCHEMA, render: (_args, value) => asText(value.message) },
    timeoutMs: QUICK_MS,
    async execute(args) {
      const blocked = guard(runtime)
      if (blocked) return blocked
      const query = String(args?.query ?? '').trim()
      if (query === '') return { ok: false, message: 'query 不能为空。' }

      const result = runtime.store.search(
        {
          q: query,
          scope: args?.scope ? runtime.resolveScope(args.scope) : undefined,
          kind: args?.kind,
          limit: args?.limit ?? 8,
        },
      )
      if (result.items.length === 0) {
        return { ok: true, message: `没有找到与「${query}」相关的记忆。`, hits: [] }
      }
      const lines = result.items.map(
        (item) => `- [${item.kind}] ${item.title}${item.text ? '：' + item.text : ''}`,
      )
      return {
        ok: true,
        message: `找到 ${result.items.length} 条（共 ${result.total} 条匹配）：\n${lines.join('\n')}`,
        hits: result.items.map((item) => ({ id: item.id, title: item.title, kind: item.kind })),
      }
    },
  })

  // ----------------------------------------------------------------- list
  define({
    name: 'memory_list',
    description: '按作用域或类型列出长期记忆，用于浏览与核对。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: { type: 'string', description: '限定作用域，可选。' },
        kind: { type: 'string', enum: KINDS, description: '限定类型，可选。' },
        pinnedOnly: { type: 'boolean', description: '只看置顶。' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: '默认 20。' },
        offset: { type: 'integer', minimum: 0, description: '分页偏移。' },
      },
    },
    output: { schema: RESULT_SCHEMA, render: (_args, value) => asText(value.message) },
    timeoutMs: QUICK_MS,
    async execute(args) {
      const blocked = guard(runtime)
      if (blocked) return blocked
      const result = runtime.store.list({
        scope: args?.scope ? runtime.resolveScope(args.scope) : undefined,
        kind: args?.kind,
        pinnedOnly: args?.pinnedOnly === true,
        limit: args?.limit ?? 20,
        offset: args?.offset ?? 0,
      })
      if (result.total === 0) return { ok: true, message: '记忆是空的。', total: 0, items: [] }
      const lines = result.items.map(
        (item) => `- ${item.pinned ? '📌' : '·'} [${item.kind}] ${item.title}（${item.scope}）`,
      )
      return {
        ok: true,
        message: `共 ${result.total} 条，本页 ${result.items.length} 条：\n${lines.join('\n')}`,
        total: result.total,
      }
    },
  })

  // --------------------------------------------------------------- forget
  define({
    name: 'memory_forget',
    description: '删掉一条不再成立的长期记忆（硬删除，不可恢复）。优先用 id，也可以用完全相同的标题。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '记忆 id（memory_search 返回里的那个）。' },
        title: { type: 'string', description: '标题，必须完全一致。' },
      },
    },
    output: { schema: RESULT_SCHEMA, render: (_args, value) => asText(value.message) },
    timeoutMs: QUICK_MS,
    async execute(args) {
      const blocked = guard(runtime)
      if (blocked) return blocked

      let id = typeof args?.id === 'string' ? args.id.trim() : ''
      if (id === '' && typeof args?.title === 'string') {
        const title = args.title.trim()
        const found = [...runtime.store.items.values()].find((item) => item.title === title)
        if (!found) return { ok: false, message: `没有标题为「${title}」的记忆。` }
        id = found.id
      }
      if (id === '') return { ok: false, message: '需要 id 或 title 之一。' }

      const result = runtime.store.remove(id)
      if (!result.ok) return { ok: false, message: result.message ?? '删除失败。' }
      return { ok: true, message: `已删除：${result.removed.title}。` }
    },
  })

  // ------------------------------------------------------------------ pin
  define({
    name: 'memory_pin',
    description: '置顶或取消置顶一条记忆。置顶条目在每次自动注入时优先出现。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '记忆 id。' },
        pinned: { type: 'boolean', description: 'true 置顶，false 取消。' },
      },
      required: ['id', 'pinned'],
    },
    output: { schema: RESULT_SCHEMA, render: (_args, value) => asText(value.message) },
    timeoutMs: QUICK_MS,
    async execute(args) {
      const blocked = guard(runtime)
      if (blocked) return blocked
      const result = runtime.store.setPin(String(args?.id ?? ''), args?.pinned === true)
      if (!result.ok) return { ok: false, message: result.message ?? '操作失败。' }
      return {
        ok: true,
        message: `${result.item.pinned ? '已置顶' : '已取消置顶'}：${result.item.title}。`,
      }
    },
  })

  return true
}

export { RESULT_SCHEMA, normalizeKind, normalizeScope }
