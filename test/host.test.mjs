/**
 * 宿主半区的集成测试：用一个仿造的 cordis ctx 跑通
 * apply → 注册工具 → 工具执行 → 提示词注入 → HTTP 路由。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'

function makeCtx() {
  const registered = { tools: [], sections: [], routes: [], effects: [] }
  const ctx = {
    tools: {
      register(definition) {
        registered.tools.push(definition)
      },
    },
    systemPrompt: {
      section(options) {
        registered.sections.push(options)
      },
    },
    webServer: {
      register(route) {
        registered.routes.push(route)
        return () => {}
      },
    },
    effect(fn) {
      registered.effects.push(fn)
    },
  }
  return { ctx, registered }
}

function makeReq({ method = 'GET', url = '/', headers = {}, body = null } = {}) {
  const handlers = { data: [], end: [], error: [] }
  return {
    method,
    url,
    headers,
    on(event, fn) {
      ;(handlers[event] ??= []).push(fn)
      return this
    },
    destroy() {},
    flush() {
      if (body !== null) {
        const buf = Buffer.from(body, 'utf8')
        for (const fn of handlers.data) fn(buf)
      }
      for (const fn of handlers.end) fn()
    },
  }
}

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      if (headers !== undefined) Object.assign(this.headers, headers)
      return this
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) this.body += chunk.toString()
      return this
    },
  }
}

function setup(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-int-'))
  const { ctx, registered } = makeCtx()
  const runtime = apply(ctx, { storeDir: dir, ...config })
  return { dir, ctx, registered, runtime, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('apply 注册了五个工具、一个注入段、十条路由', () => {
  const { registered, runtime, cleanup } = setup()
  try {
    assert.equal(runtime.degraded, false)
    assert.deepEqual(runtime.capabilities, { tools: true, prompt: true, routes: true })

    const names = registered.tools.map((tool) => tool.name).sort()
    assert.deepEqual(names, [
      'memory_forget',
      'memory_list',
      'memory_pin',
      'memory_search',
      'memory_write',
    ])

    assert.equal(registered.sections.length, 1)
    assert.equal(registered.sections[0].name, 'memory:recall')
    assert.equal(registered.sections[0].interpolate, false)
    assert.equal(typeof registered.sections[0].text, 'function')

    assert.equal(registered.routes.length, 10)
  } finally {
    cleanup()
  }
})

test('memory_write 写入后，注入段里能看到它', async () => {
  const { registered, cleanup } = setup()
  try {
    const write = registered.tools.find((tool) => tool.name === 'memory_write')
    const result = await write.execute(
      { title: '称呼偏好', text: '用户希望被称呼为「船长」', kind: 'preference', pinned: true },
      {},
    )
    assert.equal(result.ok, true)
    assert.equal(result.action, 'created')

    const block = registered.sections[0].text()
    assert.match(block, /长期记忆/)
    assert.match(block, /称呼偏好/)
    assert.match(block, /船长/)
  } finally {
    cleanup()
  }
})

test('注入段遵守字符预算，超预算的条目被排除', async () => {
  const { registered, cleanup } = setup({ promptBudget: 260 })
  try {
    const write = registered.tools.find((tool) => tool.name === 'memory_write')
    for (let i = 0; i < 12; i++) {
      await write.execute({ title: `条目${i}`, text: '很长的正文'.repeat(20) }, {})
    }
    const block = registered.sections[0].text()
    assert.ok(block.length <= 900, `注入块应受预算约束，实际 ${block.length}`)
    assert.match(block, /共 12 条，本次展示 \d+ 条/)
  } finally {
    cleanup()
  }
})

test('memory_search 能按关键词命中并给 id', async () => {
  const { registered, cleanup } = setup()
  try {
    const write = registered.tools.find((tool) => tool.name === 'memory_write')
    const search = registered.tools.find((tool) => tool.name === 'memory_search')
    await write.execute({ title: '午饭', text: '白米饭一大碗' }, {})
    await write.execute({ title: '称呼偏好', text: '叫船长' }, {})

    const hit = await search.execute({ query: '白米饭' }, {})
    assert.equal(hit.ok, true)
    assert.match(hit.message, /午饭/)
    assert.ok(Array.isArray(hit.hits) && hit.hits[0].id.startsWith('m_'))
  } finally {
    cleanup()
  }
})

test('写满后 memory_write 返回失败并提示清理', async () => {
  const { registered, cleanup } = setup({ maxItems: 1 })
  try {
    const write = registered.tools.find((tool) => tool.name === 'memory_write')
    assert.equal((await write.execute({ title: '甲', text: '第一条' }, {})).ok, true)
    const second = await write.execute({ title: '乙', text: '完全不同的第二条' }, {})
    assert.equal(second.ok, false)
    assert.match(second.message, /记忆已满/)
  } finally {
    cleanup()
  }
})

test('memory_forget 按标题删除', async () => {
  const { registered, runtime, cleanup } = setup()
  try {
    const write = registered.tools.find((tool) => tool.name === 'memory_write')
    const forget = registered.tools.find((tool) => tool.name === 'memory_forget')
    await write.execute({ title: '临时', text: '记一下' }, {})
    const gone = await forget.execute({ title: '临时' }, {})
    assert.equal(gone.ok, true)
    assert.equal(runtime.store.items.size, 0)
  } finally {
    cleanup()
  }
})

test('关闭记忆后工具拒绝执行', async () => {
  const { registered, cleanup } = setup({ enabled: false })
  try {
    const write = registered.tools.find((tool) => tool.name === 'memory_write')
    const result = await write.execute({ title: 'x', text: 'y' }, {})
    assert.equal(result.ok, false)
    assert.match(result.message, /关闭/)
  } finally {
    cleanup()
  }
})

test('HTTP：list 返回条目，upsert 写进去（且挡住无 JSON 类型的写）', async () => {
  const { registered, cleanup } = setup()
  try {
    const find = (path) => registered.routes.find((route) => route.path === path)

    const upsert = find('/__dsh-memory/api/upsert')
    const rejected = makeReq({
      method: 'POST',
      url: '/__dsh-memory/api/upsert',
      headers: { 'content-type': 'text/plain' },
      body: '{"title":"x"}',
    })
    const rejectedRes = makeRes()
    const rejectedPromise = upsert.handler(rejected, rejectedRes)
    rejected.flush()
    await rejectedPromise
    assert.equal(rejectedRes.status, 415)

    const created = makeReq({
      method: 'POST',
      url: '/__dsh-memory/api/upsert',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '面板写的', text: '来自设置页' }),
    })
    const createdRes = makeRes()
    const createdPromise = upsert.handler(created, createdRes)
    created.flush()
    await createdPromise
    assert.equal(createdRes.status, 200)
    assert.equal(JSON.parse(createdRes.body).ok, true)

    const list = find('/__dsh-memory/api/list')
    const listRes = makeRes()
    await list.handler(makeReq({ url: '/__dsh-memory/api/list' }), listRes)
    const payload = JSON.parse(listRes.body)
    assert.equal(payload.ok, true)
    assert.equal(payload.total, 1)
    assert.equal(payload.items[0].title, '面板写的')
  } finally {
    cleanup()
  }
})

test('HTTP：跨域写请求被拒绝', async () => {
  const { registered, cleanup } = setup()
  try {
    const upsert = registered.routes.find((route) => route.path === '/__dsh-memory/api/upsert')
    const req = makeReq({
      method: 'POST',
      url: '/__dsh-memory/api/upsert',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example', host: '127.0.0.1:1234' },
      body: '{}',
    })
    const res = makeRes()
    const task = upsert.handler(req, res)
    req.flush()
    await task
    assert.equal(res.status, 403)
  } finally {
    cleanup()
  }
})

test('注入段在没有任何记忆时返回空串', () => {
  const { registered, cleanup } = setup()
  try {
    assert.equal(registered.sections[0].text(), '')
  } finally {
    cleanup()
  }
})

test('注入段不含易变内容（稳定性检查）', async () => {
  const { registered, cleanup } = setup()
  try {
    const write = registered.tools.find((tool) => tool.name === 'memory_write')
    await write.execute({ title: '稳定', text: '正文', pinned: true }, {})
    const first = registered.sections[0].text()
    const second = registered.sections[0].text()
    assert.equal(first, second, '同样数据两次渲染必须完全一致')
    assert.doesNotMatch(first, /\d{4}-\d{2}-\d{2}/, '不能出现日期')
    assert.doesNotMatch(first, /\d+\s*秒前|\d+\s*分钟前/, '不能出现相对时间')
  } finally {
    cleanup()
  }
})
