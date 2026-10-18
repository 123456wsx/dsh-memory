/**
 * dsh-memory — 存储层。
 *
 * 设计要点：
 *
 *  * **JSONL 追加日志**：每行一条 JSON。更新 = 追加同 id 的新版本（后者覆盖前者），
 *    删除 = 追加一条墓碑（`__deleted: true`）。这样写入是 O(1) 追加，不需要重写全文件。
 *  * **可手改、可 git、可救**：坏行解析失败就跳过，不影响其它条目。
 *  * **无过期、无回收站**：硬删除；删除前把当前全量快照到 `.bak`。
 *  * **硬上限**：`maxItems` 满了就拒绝新增，绝不自动淘汰 —— 删哪条是人的判断。
 *
 * 并发：同一进程内由调用方串行化；跨进程依赖 O_APPEND 的原子性
 * （单行小于一次写入上限，不会交错成半行）。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

export const STORE_FILE = 'memories.jsonl'
export const BACKUP_FILE = 'memories.jsonl.bak'
const TOMBSTONE_KEY = '__deleted'

const MAX_TITLE = 120
const MAX_TEXT = 4000
const MAX_TAGS = 12
const MAX_TAG_LEN = 24

export const KINDS = ['fact', 'preference', 'project', 'decision', 'todo', 'note']

function nowMs() {
  return Date.now()
}

function makeId(at = Date.now()) {
  return 'm_' + at.toString(36).padStart(9, '0') + randomBytes(5).toString('hex')
}

function trimmed(value, max) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length > max ? text.slice(0, max) : text
}

export function normalizeTags(raw) {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[,，、\s]+/)
      : []
  const out = []
  for (const each of list) {
    const tag = trimmed(String(each ?? ''), MAX_TAG_LEN)
    if (tag !== '' && !out.includes(tag)) out.push(tag)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

export function normalizeKind(raw) {
  const kind = trimmed(String(raw ?? ''), 24).toLowerCase()
  return KINDS.includes(kind) ? kind : 'note'
}

/**
 * 作用域归一化。
 *   global            —— 所有会话共享
 *   workspace         —— 仅当前工作区（由宿主在调用时补具体 key）
 *   workspace:<key>   —— 指定工作区
 *   session:<id>      —— 指定会话（预留）
 */
export function normalizeScope(raw) {
  const scope = trimmed(String(raw ?? ''), 200)
  if (scope === '' || scope === 'global') return 'global'
  if (scope === 'workspace') return 'workspace'
  const workspace = scope.match(/^workspace:(.*)$/)
  if (workspace) {
    const key = trimmed(workspace[1], 160)
    return key === '' ? 'workspace' : `workspace:${key}`
  }
  const session = scope.match(/^session:(.*)$/)
  if (session) {
    const id = trimmed(session[1], 160)
    return id === '' ? 'global' : `session:${id}`
  }
  return 'global'
}

/** 字符 bigram 集合：中文不分词也能做相似度。 */
function bigrams(text) {
  const flat = text.toLowerCase().replace(/\s+/g, '')
  const set = new Set()
  if (flat.length === 1) set.add(flat)
  for (let i = 0; i < flat.length - 1; i++) set.add(flat.slice(i, i + 2))
  return set
}

/** Jaccard 相似度，0..1。 */
export function similarity(a, b) {
  const left = bigrams(String(a ?? ''))
  const right = bigrams(String(b ?? ''))
  if (left.size === 0 && right.size === 0) return 1
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const gram of left) if (right.has(gram)) shared++
  return shared / (left.size + right.size - shared)
}

export class MemoryStore {
  /**
   * @param {{ dir: string, maxItems?: number, dedupeThreshold?: number, readonly?: boolean }} options
   */
  constructor(options = {}) {
    if (typeof options.dir !== 'string' || options.dir.trim() === '') {
      throw new Error('MemoryStore: options.dir is required')
    }
    this.dir = options.dir
    this.file = join(options.dir, STORE_FILE)
    this.backupFile = join(options.dir, BACKUP_FILE)
    this.maxItems = Number.isFinite(options.maxItems) ? Math.max(1, Math.trunc(options.maxItems)) : 5000
    this.dedupeThreshold = Number.isFinite(options.dedupeThreshold)
      ? Math.min(1, Math.max(0, options.dedupeThreshold))
      : 0.85
    this.readonly = options.readonly === true
    this.items = new Map()
    this.bytes = 0
    mkdirSync(this.dir, { recursive: true })
    this.load()
  }

  /** 从磁盘重建内存索引（后写覆盖前写，墓碑删条目）。 */
  load() {
    this.items.clear()
    this.bytes = 0
    let raw = ''
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch {
      return this
    }
    this.bytes = Buffer.byteLength(raw)
    for (const line of raw.split('\n')) {
      const text = line.trim()
      if (text === '') continue
      let record
      try {
        record = JSON.parse(text)
      } catch {
        continue // 坏行丢弃，不影响其它条目
      }
      if (record === null || typeof record !== 'object') continue
      if (typeof record.id !== 'string' || record.id === '') continue
      if (record[TOMBSTONE_KEY] === true) {
        this.items.delete(record.id)
        continue
      }
      const item = this.#sanitize(record)
      if (item !== null) this.items.set(item.id, item)
    }
    return this
  }

  #sanitize(record) {
    const at = Number.isFinite(record.createdAt) ? record.createdAt : nowMs()
    const title = trimmed(record.title, MAX_TITLE)
    const text = trimmed(record.text, MAX_TEXT)
    if (title === '' && text === '') return null
    return {
      id: record.id,
      scope: normalizeScope(record.scope),
      kind: normalizeKind(record.kind),
      title: title === '' ? text.slice(0, MAX_TITLE) : title,
      text,
      tags: normalizeTags(record.tags),
      pinned: record.pinned === true,
      source: record.source && typeof record.source === 'object' ? record.source : undefined,
      createdAt: at,
      updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : at,
      hits: Number.isFinite(record.hits) ? Math.max(0, Math.trunc(record.hits)) : 0,
      lastUsedAt: Number.isFinite(record.lastUsedAt) ? record.lastUsedAt : 0,
    }
  }

  #append(record) {
    const line = JSON.stringify(record) + '\n'
    appendFileSync(this.file, line)
    // 字节数跟真实文件大小走：少了这一行，新写的条目在面板里会显示 0 字节。
    this.bytes += Buffer.byteLength(line)
  }

  #backup() {
    try {
      if (!existsSync(this.file)) return false
      writeFileSync(this.backupFile, readFileSync(this.file))
      return true
    } catch {
      return false
    }
  }

  get(id) {
    return this.items.get(id) ?? null
  }

  /** 全部条目，按"该注入的顺序"排序：置顶 → 最近用到 → 最近更新。 */
  sorted() {
    return [...this.items.values()].sort(compareForPrompt)
  }

  /**
   * 列表 / 检索。
   * @param {{ scope?: string, kind?: string, q?: string, tag?: string,
   *           pinnedOnly?: boolean, limit?: number, offset?: number }} [query]
   */
  list(query = {}) {
    const scope = query.scope && query.scope !== 'all' ? normalizeScope(query.scope) : null
    const kind = query.kind && query.kind !== 'all' ? normalizeKind(query.kind) : null
    const tag = trimmed(String(query.tag ?? ''), MAX_TAG_LEN)
    const terms = tokenize(query.q)
    const pinnedOnly = query.pinnedOnly === true

    let rows = [...this.items.values()]
    if (scope !== null) rows = rows.filter((item) => item.scope === scope)
    if (kind !== null) rows = rows.filter((item) => item.kind === kind)
    if (pinnedOnly) rows = rows.filter((item) => item.pinned)
    if (tag !== '') rows = rows.filter((item) => item.tags.includes(tag))

    if (terms.length > 0) {
      rows = rows
        .map((item) => ({ item, score: scoreOf(item, terms) }))
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score || compareForPrompt(a.item, b.item))
        .map((row) => row.item)
    } else {
      rows.sort(compareForPrompt)
    }

    const total = rows.length
    const offset = Number.isFinite(query.offset) ? Math.max(0, Math.trunc(query.offset)) : 0
    const limit = Number.isFinite(query.limit) ? Math.min(500, Math.max(1, Math.trunc(query.limit))) : 100
    return { total, items: rows.slice(offset, offset + limit) }
  }

  /** 检索并给命中计数 +1（只影响排序权重，不落盘）。 */
  search(query = {}, options = {}) {
    const result = this.list({ ...query, ...options })
    for (const item of result.items) {
      item.hits += 1
      item.lastUsedAt = nowMs()
    }
    return result
  }

  /**
   * 新增或更新一条记忆。
   * @param {{ id?: string, title?: string, text?: string, kind?: string, scope?: string,
   *           tags?: string[], pinned?: boolean, source?: object }} input
   */
  upsert(input = {}) {
    if (this.readonly) {
      return { ok: false, reason: 'readonly', message: '当前是只读模式，不能写入记忆。' }
    }
    const at = nowMs()
    const title = trimmed(input.title, MAX_TITLE)
    const text = trimmed(input.text, MAX_TEXT)
    if (title === '' && text === '') {
      return { ok: false, reason: 'empty', message: '标题和正文不能都为空。' }
    }
    const scope = normalizeScope(input.scope)

    let target = typeof input.id === 'string' && input.id !== '' ? this.items.get(input.id) ?? null : null
    let action = target === null ? 'created' : 'updated'

    // 没给 id 时按标题查重：相似度达到阈值就当作同一条更新，避免模型反复写同一件事。
    if (target === null && !input.id) {
      const probe = title !== '' ? title : text
      for (const candidate of this.items.values()) {
        if (candidate.scope !== scope) continue
        if (similarity(probe, candidate.title) >= this.dedupeThreshold) {
          target = candidate
          action = 'updated'
          break
        }
      }
    }

    if (target === null && this.items.size >= this.maxItems) {
      return {
        ok: false,
        reason: 'full',
        message:
          `记忆已满（${this.items.size}/${this.maxItems}），本次没有写入。` +
          '请在 设置 → 记忆 里删除一些条目，或调高 maxItems。',
        usage: this.usage(),
      }
    }

    const base = target ?? {}
    const item = {
      id: target === null ? makeId(at) : target.id,
      scope,
      kind: normalizeKind(input.kind ?? base.kind),
      title: title !== '' ? title : base.title ?? text.slice(0, MAX_TITLE),
      text: text !== '' ? text : base.text ?? '',
      tags: input.tags === undefined ? [...(base.tags ?? [])] : normalizeTags(input.tags),
      pinned: input.pinned === undefined ? base.pinned === true : input.pinned === true,
      source: input.source === undefined ? base.source : input.source,
      createdAt: base.createdAt ?? at,
      updatedAt: at,
      hits: base.hits ?? 0,
      lastUsedAt: base.lastUsedAt ?? 0,
    }
    this.items.set(item.id, item)
    this.#append(item)
    return { ok: true, action, item: { ...item } }
  }

  setPin(id, pinned) {
    if (this.readonly) return { ok: false, reason: 'readonly', message: '当前是只读模式。' }
    const item = this.items.get(id)
    if (!item) return { ok: false, reason: 'not-found', message: `找不到记忆 ${id}。` }
    const next = { ...item, pinned: pinned === true, updatedAt: nowMs() }
    this.items.set(id, next)
    this.#append(next)
    return { ok: true, item: { ...next } }
  }

  /** 硬删除。删除前把当前全量快照到 .bak（不做回收站）。 */
  remove(id) {
    if (this.readonly) return { ok: false, reason: 'readonly', message: '当前是只读模式。' }
    const item = this.items.get(id)
    if (!item) return { ok: false, reason: 'not-found', message: `找不到记忆 ${id}。` }
    this.#backup()
    this.items.delete(id)
    this.#append({ id, [TOMBSTONE_KEY]: true, deletedAt: nowMs() })
    return { ok: true, removed: { ...item } }
  }

  stats() {
    const byScope = {}
    const byKind = {}
    for (const item of this.items.values()) {
      byScope[item.scope] = (byScope[item.scope] ?? 0) + 1
      byKind[item.kind] = (byKind[item.kind] ?? 0) + 1
    }
    return { count: this.items.size, bytes: this.bytes, byScope, byKind }
  }

  usage() {
    return {
      count: this.items.size,
      maxItems: this.maxItems,
      full: this.items.size >= this.maxItems,
      bytes: this.bytes,
    }
  }

  exportAll() {
    return this.sorted().map((item) => ({ ...item }))
  }

  /**
   * 导入。
   * @param {Array<Record<string, unknown>>} items
   * @param {{ mode?: 'merge' | 'replace' }} [options]
   */
  importAll(items, options = {}) {
    if (this.readonly) return { ok: false, reason: 'readonly', message: '当前是只读模式。' }
    if (!Array.isArray(items)) return { ok: false, reason: 'bad-input', message: '导入内容必须是数组。' }
    const mode = options.mode === 'replace' ? 'replace' : 'merge'

    if (mode === 'replace') {
      this.#backup()
      this.items.clear()
    }

    let added = 0
    let updated = 0
    let skipped = 0
    for (const raw of items) {
      if (raw === null || typeof raw !== 'object') {
        skipped++
        continue
      }
      const before = this.items.size
      const result = this.upsert({
        id: typeof raw.id === 'string' && this.items.has(raw.id) === false ? raw.id : undefined,
        title: raw.title,
        text: raw.text,
        kind: raw.kind,
        scope: raw.scope,
        tags: raw.tags,
        pinned: raw.pinned,
        source: { by: 'import', at: nowMs() },
      })
      if (!result.ok) {
        skipped++
        continue
      }
      if (result.action === 'updated' && before === this.items.size) updated++
      else added++
    }

    this.compact()
    return { ok: true, mode, added, updated, skipped, count: this.items.size }
  }

  /** 压实：同 id 只留最后一条，丢掉墓碑。 */
  compact() {
    const items = this.sorted()
    const lines = items.map((item) => JSON.stringify(item) + '\n').join('')
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, lines)
    renameSync(tmp, this.file)
    this.bytes = Buffer.byteLength(lines)
    return { ok: true, count: items.length, bytes: this.bytes }
  }
}

/** 查询串切词：空格分隔 + 整体保留（中文靠子串匹配）。 */
export function tokenize(query) {
  const text = trimmed(String(query ?? ''), 500)
  if (text === '') return []
  return [...new Set(text.split(/\s+/).filter((term) => term !== ''))]
}

function scoreOf(item, terms) {
  const title = item.title.toLowerCase()
  const text = item.text.toLowerCase()
  const tags = item.tags.map((tag) => tag.toLowerCase())
  let score = 0
  for (const raw of terms) {
    const term = raw.toLowerCase()
    if (title.includes(term)) score += 6
    for (const tag of tags) if (tag.includes(term)) score += 4
    if (text.includes(term)) score += 1
  }
  if (score > 0) {
    if (item.pinned) score += 2
    score += Math.min(item.hits, 10) * 0.1
  }
  return score
}

/** 注入 / 列表的稳定排序：置顶 → 最近用到 → 最近更新 → id（兜底稳定）。 */
export function compareForPrompt(a, b) {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
  if (a.lastUsedAt !== b.lastUsedAt) return b.lastUsedAt - a.lastUsedAt
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
