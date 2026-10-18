/**
 * dsh-memory — 宿主半区入口。
 *
 * 装配顺序：配置 → 存储 → 工具 → 系统提示词注入 → HTTP 面。
 *
 * 每一层都是**软依赖**：拿不到对应服务就降级，不让整个插件挂掉。
 * 这是有意的 —— DSH 的扩展点在不同版本间会变，记忆这种东西不该因为
 * 一个注入点缺失就完全不能用。
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { resolveConfig, serviceOf } from './config.js'
import { MemoryStore, normalizeScope } from './store.js'
import { registerMemoryTools } from './tools.js'
import { installPromptSection } from './prompt.js'
import { installRoutes } from './routes.js'

export const name = 'dsh-memory'

/**
 * cordis 4 的依赖声明：只有列在这里的服务，cordis 才会等它们就绪后再调用
 * apply()。不声明的话 apply 会立刻执行，那时 ctx.get('webServer') 还是
 * undefined —— 而且直接访问 ctx.webServer 还会抛
 * `cannot get property "x" without inject`，把整个插件判成 did not activate。
 */
export const inject = ['webServer', 'tools', 'systemPrompt']

/**
 * 不导出 inject。
 *
 * 声明 inject 而服务迟迟不就绪时，cordis 会让插件一直停在 pending，
 * apply 根本不会被调用 —— 表现就是「装上了，但工具、面板什么都没有」。
 * 这里改成 apply 之后短轮询等 webServer，缺服务也只是降级，不会卡死加载。
 */

/** 临时诊断打点：写 $DSH_HOME/memory/.boot.log。定位完会移除。 */
function bootLog(line) {
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    const dir = join(home, 'memory')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, '.boot.log'), new Date().toISOString() + ' ' + line + '\n')
  } catch {
    /* 打点失败不影响功能 */
  }
}

/** 工作区标识：对绝对路径做归一化后取短哈希。 */
export function workspaceKeyOf(cwd) {
  const text = String(cwd ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
  if (text === '') return 'unknown'
  return createHash('sha1').update(text).digest('hex').slice(0, 10)
}

/**
 * @param {any} ctx cordis 上下文
 * @param {Record<string, unknown>} [rawConfig] 插件 config
 */
export function apply(ctx, rawConfig = {}) {
  bootLog(
    'apply() 进入 | ctx=' + (ctx === null || ctx === undefined ? 'null' : typeof ctx) +
      ' | tools=' + typeof serviceOf(ctx, 'tools') +
      ' | webServer=' + typeof serviceOf(ctx, 'webServer') +
      ' | systemPrompt=' + typeof serviceOf(ctx, 'systemPrompt') +
      ' | config=' + JSON.stringify(rawConfig ?? {}),
  )

  try {
    return bootInner(ctx, rawConfig)
  } catch (error) {
    bootLog('apply 抛错: ' + (error && error.stack ? error.stack : String(error)))
    throw error
  }
}

function bootInner(ctx, rawConfig) {
  const config = resolveConfig(rawConfig ?? {})
  const workspaceKey = workspaceKeyOf(process.cwd())

  let store = null
  let initError = null
  try {
    store = new MemoryStore({
      dir: config.storeDir,
      maxItems: config.maxItems,
      dedupeThreshold: config.dedupeThreshold,
      readonly: config.readonly,
    })
  } catch (error) {
    initError = error instanceof Error ? error.message : String(error)
  }

  const stateFile = join(config.storeDir, 'state.json')
  const pausedAtStart = readPaused(stateFile)

  const runtime = {
    config,
    store,
    enabled: config.enabled && store !== null,
    degraded: store === null,
    initError,
    workspaceKey,
    paused: pausedAtStart,
    capabilities: { tools: false, prompt: false, routes: false },
    /** 是否正在工作：配置开着、存储可用、且用户没点暂停。 */
    isActive() {
      return runtime.enabled === true && runtime.paused !== true
    },
    /** 面板上的开关：暂停 = 不注入、工具拒绝写入。持久化到 state.json。 */
    setPaused(value) {
      runtime.paused = value === true
      writePaused(stateFile, runtime.paused)
      return runtime.paused
    },
    /**
     * 把外部传来的 scope 归一化；裸写 workspace 时补上当前工作区的 key。
     * @param {unknown} raw
     */
    resolveScope(raw) {
      if (raw === undefined || raw === null || raw === '') return 'global'
      if (raw === 'workspace') return `workspace:${workspaceKey}`
      const scope = normalizeScope(raw)
      return scope === 'workspace' ? `workspace:${workspaceKey}` : scope
    },
  }

  if (store === null) {
    // 存储建不起来（目录不可写等）：不注册工具与注入，只留一个能解释原因的路由
    runtime.capabilities.routes = installRoutes(ctx, runtime)
    return runtime
  }

  runtime.capabilities.tools = registerMemoryTools(ctx, runtime)
  runtime.capabilities.prompt = installPromptSection(ctx, runtime)

  // webServer 可能比 apply 晚就绪：先同步试一次，失败再短轮询。
  runtime.capabilities.routes = installRoutes(ctx, runtime)
  if (runtime.capabilities.routes === false) {
    let left = 20
    const retry = () => {
      if (installRoutes(ctx, runtime)) {
        runtime.capabilities.routes = true
        bootLog('routes 重试成功，剩余 ' + left)
        return
      }
      if (left-- > 0) setTimeout(retry, 500)
      else bootLog('routes 彻底失败 | webServer=' + typeof serviceOf(ctx, 'webServer'))
    }
    setTimeout(retry, 300)
  }

  bootLog('capabilities=' + JSON.stringify(runtime.capabilities) + ' | storeDir=' + config.storeDir)

  return runtime
}

function readPaused(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && parsed.paused === true
  } catch {
    return false
  }
}

function writePaused(file, paused) {
  try {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify({ paused, at: Date.now() }, null, 2) + '\n')
    return true
  } catch {
    return false
  }
}
