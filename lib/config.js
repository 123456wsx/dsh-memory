/**
 * dsh-memory — 配置解析。
 *
 * 所有默认值集中在这里，宿主半区与测试共用。配置来源可以是 DSH 的插件
 * config（cordis 注入的对象），也可以是一份手写的 JSON。
 */
import os from 'node:os'
import path from 'node:path'

/** $DSH_HOME，默认 ~/.dsh（与 dsh-pet-live2d 的约定一致）。 */
export function resolveDshHome(env = process.env, homeDir = os.homedir()) {
  const raw = env?.DSH_HOME
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
  return path.join(homeDir, '.dsh')
}

export const DEFAULTS = Object.freeze({
  /** 插件总开关。关掉 = 不注入、工具拒绝写入、面板只读。 */
  enabled: true,
  /** 空字符串表示 <DSH_HOME>/memory。 */
  storeDir: '',
  /** 每次请求注入多少字符的记忆摘要；0 = 关闭自动注入。 */
  promptBudget: 1500,
  /** 条数硬上限。写满即拒写，不自动淘汰。 */
  maxItems: 5000,
  /** 启用哪些作用域。 */
  scopes: ['global', 'workspace'],
  /** 是否开放 /__dsh-memory/ 调试单页。 */
  exposePanel: true,
  /** 只读模式：面板与工具都禁止写。 */
  readonly: false,
  /** 写入查重：标题相似度达到这个值就视为同一条。 */
  dedupeThreshold: 0.85,
})

function toBool(value, fallback) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (text === 'true' || text === '1' || text === 'yes' || text === 'on') return true
    if (text === 'false' || text === '0' || text === 'no' || text === 'off') return false
  }
  if (value === 1) return true
  if (value === 0) return false
  return fallback
}

function toInt(value, fallback, min, max) {
  const num = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(num)))
}

function toNumber(value, fallback, min, max) {
  const num = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, num))
}

/**
 * 把原始配置归一化成运行时配置。
 * @param {Record<string, unknown>} raw
 * @param {{ env?: NodeJS.ProcessEnv, homeDir?: string }} [context]
 */
export function resolveConfig(raw = {}, context = {}) {
  const env = context.env ?? process.env
  const homeDir = context.homeDir ?? os.homedir()
  const dshHome = resolveDshHome(env, homeDir)

  const rawDir = typeof raw.storeDir === 'string' ? raw.storeDir.trim() : ''
  const storeDir = rawDir === '' ? path.join(dshHome, 'memory') : path.resolve(rawDir)

  const scopes = Array.isArray(raw.scopes)
    ? [...new Set(raw.scopes.filter((s) => s === 'global' || s === 'workspace'))]
    : [...DEFAULTS.scopes]

  return {
    enabled: toBool(raw.enabled, DEFAULTS.enabled),
    storeDir,
    dshHome,
    promptBudget: toInt(raw.promptBudget, DEFAULTS.promptBudget, 0, 20000),
    maxItems: toInt(raw.maxItems, DEFAULTS.maxItems, 1, 100000),
    scopes: scopes.length > 0 ? scopes : [...DEFAULTS.scopes],
    exposePanel: toBool(raw.exposePanel, DEFAULTS.exposePanel),
    readonly: toBool(raw.readonly, DEFAULTS.readonly),
    dedupeThreshold: toNumber(raw.dedupeThreshold, DEFAULTS.dedupeThreshold, 0, 1),
  }
}

/**
 * 安全取服务。
 *
 * cordis 4 里直接访问 `ctx.<name>` 而没在 inject 中声明，会抛
 * `cannot get property "x" without inject`，整个 apply 都会挂掉；
 * 而 `ctx.get(name)` 走服务注册表查询，不经过那层属性代理。
 *
 * 先走 `get()`，拿不到再退回普通属性读（测试里的假 ctx 没有 get 方法），
 * 两步都包着 try —— 真拿不到就返回 undefined，由调用方降级。
 */
export function serviceOf(ctx, name) {
  try {
    const get = ctx?.get
    if (typeof get === 'function') {
      const service = get.call(ctx, name)
      if (service !== undefined && service !== null) return service
    }
  } catch {
    /* 访问受限，继续走下一条路 */
  }
  try {
    return ctx?.[name]
  } catch {
    /* 未声明 inject 时的属性代理会抛，按「没有」处理 */
    return undefined
  }
}
