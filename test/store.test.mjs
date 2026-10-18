/**
 * store.js 的单元测试。跑法：node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryStore, STORE_FILE, BACKUP_FILE, similarity, normalizeScope, normalizeTags } from '../lib/store.js'

function freshStore(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-'))
  const store = new MemoryStore({ dir, ...options })
  return { dir, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('写入后落盘，新实例能读回', () => {
  const { dir, store, cleanup } = freshStore()
  try {
    const a = store.upsert({ title: '称呼偏好', text: '用户希望被称呼为「船长」', kind: 'preference' })
    assert.equal(a.ok, true)
    assert.equal(a.action, 'created')
    assert.match(a.item.id, /^m_/)

    const b = store.upsert({ title: '主食', text: '白米饭', kind: 'fact' })
    assert.equal(b.ok, true)

    assert.ok(existsSync(join(dir, STORE_FILE)))

    const reloaded = new MemoryStore({ dir })
    assert.equal(reloaded.items.size, 2)
    assert.equal(reloaded.get(a.item.id).title, '称呼偏好')
    assert.equal(reloaded.get(a.item.id).kind, 'preference')
  } finally {
    cleanup()
  }
})

test('同标题查重：第二条变成更新而不是新增', () => {
  const { store, cleanup } = freshStore()
  try {
    const first = store.upsert({ title: '称呼偏好', text: '叫船长' })
    const second = store.upsert({ title: '称呼偏好', text: '叫船长，不要叫主人' })
    assert.equal(second.action, 'updated')
    assert.equal(second.item.id, first.item.id)
    assert.equal(store.items.size, 1)
    assert.match(second.item.text, /不要叫主人/)
  } finally {
    cleanup()
  }
})

test('不同标题不会误合并', () => {
  const { store, cleanup } = freshStore()
  try {
    store.upsert({ title: '称呼偏好', text: '叫船长' })
    store.upsert({ title: '项目背景', text: '做 DSH 插件' })
    assert.equal(store.items.size, 2)
  } finally {
    cleanup()
  }
})

test('检索按标题/标签/正文打分并排序', () => {
  const { store, cleanup } = freshStore()
  try {
    store.upsert({ title: '称呼偏好', text: '喜欢被叫船长', tags: ['称呼', '船长'] })
    store.upsert({ title: '午饭', text: '白米饭一大碗' })
    store.upsert({ title: '随手记', text: '顺便提了一句船长' })

    const byTitle = store.list({ q: '称呼' })
    assert.equal(byTitle.items.length, 1)
    assert.equal(byTitle.items[0].title, '称呼偏好')

    const byBody = store.list({ q: '船长' })
    assert.equal(byBody.items.length, 2)
    // 标签命中（+4）高于正文命中（+1），所以带「船长」标签的排在前面
    assert.equal(byBody.items[0].title, '称呼偏好')
  } finally {
    cleanup()
  }
})

test('达到 maxItems 后拒绝新增，且给出 full 原因', () => {
  const { store, cleanup } = freshStore({ maxItems: 2 })
  try {
    assert.equal(store.upsert({ title: '甲', text: '第一条' }).ok, true)
    assert.equal(store.upsert({ title: '乙', text: '第二条' }).ok, true)
    const third = store.upsert({ title: '丙', text: '第三条完全不同的内容' })
    assert.equal(third.ok, false)
    assert.equal(third.reason, 'full')
    assert.equal(store.items.size, 2)
    assert.equal(third.usage.full, true)
  } finally {
    cleanup()
  }
})

test('更新已有条目不受 maxItems 限制', () => {
  const { store, cleanup } = freshStore({ maxItems: 1 })
  try {
    const first = store.upsert({ title: '唯一', text: '初始' })
    const second = store.upsert({ id: first.item.id, text: '改过了' })
    assert.equal(second.ok, true)
    assert.equal(second.action, 'updated')
    assert.equal(store.get(first.item.id).text, '改过了')
  } finally {
    cleanup()
  }
})

test('硬删除：内存消失、落盘墓碑、重载后仍消失', () => {
  const { dir, store, cleanup } = freshStore()
  try {
    const item = store.upsert({ title: '要被删的', text: 'x' })
    const result = store.remove(item.item.id)
    assert.equal(result.ok, true)
    assert.equal(store.items.size, 0)
    assert.ok(existsSync(join(dir, BACKUP_FILE)), '删除前应留下 .bak 快照')

    const reloaded = new MemoryStore({ dir })
    assert.equal(reloaded.items.size, 0)
    assert.equal(reloaded.get(item.item.id), null)
  } finally {
    cleanup()
  }
})

test('压实后同 id 只剩一条、墓碑消失', () => {
  const { dir, store, cleanup } = freshStore()
  try {
    const item = store.upsert({ title: '反复改', text: 'v1' })
    store.upsert({ id: item.item.id, text: 'v2' })
    store.upsert({ id: item.item.id, text: 'v3' })
    const dead = store.upsert({ title: '另一个', text: 'y' })
    store.remove(dead.item.id)

    const before = readFileSync(join(dir, STORE_FILE), 'utf8').trim().split('\n').length
    assert.equal(before, 5) // 1 create + 2 update + 1 create + 1 tombstone

    const compacted = store.compact()
    assert.equal(compacted.count, 1)
    const lines = readFileSync(join(dir, STORE_FILE), 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    assert.equal(JSON.parse(lines[0]).text, 'v3')

    const reloaded = new MemoryStore({ dir })
    assert.equal(reloaded.items.size, 1)
  } finally {
    cleanup()
  }
})

test('坏行容错：解析不了的行被跳过，其它条目照常', () => {
  const { dir, store, cleanup } = freshStore()
  try {
    store.upsert({ title: '好的', text: 'ok' })
    appendFileSync(join(dir, STORE_FILE), '{ this is not json\n')
    appendFileSync(join(dir, STORE_FILE), '{"id":123}\n')
    const reloaded = new MemoryStore({ dir })
    assert.equal(reloaded.items.size, 1)
    assert.equal([...reloaded.items.values()][0].title, '好的')
  } finally {
    cleanup()
  }
})

test('导入 replace 会清空旧数据，merge 会保留', () => {
  const { store, cleanup } = freshStore()
  try {
    store.upsert({ title: '旧的', text: 'a' })
    const merged = store.importAll([{ title: '新的', text: 'b' }], { mode: 'merge' })
    assert.equal(merged.ok, true)
    assert.equal(store.items.size, 2)

    store.importAll([{ title: '只有这个', text: 'c' }], { mode: 'replace' })
    assert.equal(store.items.size, 1)
    assert.equal([...store.items.values()][0].title, '只有这个')
  } finally {
    cleanup()
  }
})

test('只读模式拒绝一切写操作', () => {
  const { dir, cleanup } = freshStore()
  try {
    const writable = new MemoryStore({ dir })
    writable.upsert({ title: '先写一条', text: 'x' })
    const readonly = new MemoryStore({ dir, readonly: true })
    const result = readonly.upsert({ title: '写不进去', text: 'y' })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'readonly')
    assert.equal(readonly.remove([...readonly.items.keys()][0]).ok, false)
  } finally {
    cleanup()
  }
})

test('工具函数：作用域归一化与标签清理', () => {
  assert.equal(normalizeScope(''), 'global')
  assert.equal(normalizeScope('GLOBAL'), 'global')
  assert.equal(normalizeScope('workspace'), 'workspace')
  assert.equal(normalizeScope('workspace:abc'), 'workspace:abc')
  assert.equal(normalizeScope('乱七八糟'), 'global')
  assert.deepEqual(normalizeTags('称呼，偏好 白米饭'), ['称呼', '偏好', '白米饭'])
  assert.deepEqual(normalizeTags(['a', 'a', 'b']), ['a', 'b'])
  assert.ok(similarity('称呼偏好', '称呼偏好') === 1)
  assert.ok(similarity('称呼偏好', '项目背景') < 0.3)
})
