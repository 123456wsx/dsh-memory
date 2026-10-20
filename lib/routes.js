import { serviceOf } from './config.js'

/**
 * dsh-memory — HTTP 面。
 *
 * 挂在 DSH 自己的 webServer 上（不额外起服务、不监听别的端口）。
 *
 * 安全约定：
 *   * 同源校验：写操作要求 Origin 的 host 与请求 Host 一致
 *   * 写操作要求 `content-type: application/json`（挡掉表单式 CSRF 简单请求）
 *   * 请求体上限 1MB
 *   * 只做本地文件读写，不发任何网络请求
 */

const API = '/__dsh-memory'
const MAX_BODY = 1024 * 1024

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  res.end(body)
}

function sendHtml(res, html) {
  const body = Buffer.from(html, 'utf8')
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  res.end(body)
}

function sameOrigin(req) {
  const origin = req.headers?.origin
  if (typeof origin !== 'string' || origin === '') return true // 同源导航通常不带 Origin
  const host = req.headers?.host
  if (typeof host !== 'string' || host === '') return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function wantsJson(req) {
  const type = String(req.headers?.['content-type'] ?? '').toLowerCase()
  return type.includes('application/json')
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text.trim() === '' ? {} : JSON.parse(text))
      } catch (error) {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function queryOf(req) {
  try {
    return new URL(req.url, 'http://localhost').searchParams
  } catch {
    return new URLSearchParams()
  }
}

const PANEL_HTML = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<title>dsh-memory</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.hint { margin: 0 0 20px; opacity: .7; font-size: 13px; }
  .bar { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  input, button, select { font: inherit; padding: 6px 10px; border-radius: 8px; border: 1px solid rgba(127,127,127,.35); background: transparent; color: inherit; }
  button { cursor: pointer; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { padding: 10px 12px; border: 1px solid rgba(127,127,127,.25); border-radius: 10px; margin-bottom: 8px; }
  li b { font-weight: 600; }
  .badge { font-size: 11px; opacity: .65; margin-right: 6px; }
  .pin { color: #d99a12; }
  pre { white-space: pre-wrap; word-break: break-word; opacity: .8; margin: 6px 0 0; font-size: 12px; }
</style>
<h1>dsh-memory</h1>
<p class="hint">这是调试用的只读列表。日常编辑请用 <b>设置 → 记忆</b>。接口前缀：<code>/__dsh-memory/api</code></p>
<div class="bar">
  <input id="q" placeholder="搜索记忆…" style="min-width:220px">
  <button id="go">搜索</button>
  <span id="meta" style="align-self:center;opacity:.6"></span>
</div>
<ul id="list"><li>加载中…</li></ul>
<script>
const list = document.getElementById('list');
const meta = document.getElementById('meta');
async function load(q) {
  const url = '/__dsh-memory/api/list' + (q ? '?q=' + encodeURIComponent(q) : '');
  const data = await fetch(url).then(r => r.json());
  meta.textContent = '共 ' + data.total + ' 条 / 上限 ' + (data.usage ? data.usage.maxItems : '?');
  if (!data.items || data.items.length === 0) { list.innerHTML = '<li>没有记录</li>'; return; }
  list.innerHTML = '';
  for (const item of data.items) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="badge">[' + item.kind + ']</span>'
      + (item.subject === 'self' ? '<span class="badge">本鱼</span>' : '')
      + (item.pinned ? '<span class="pin">📌 </span>' : '')
      + '<b></b>';
    li.querySelector('b').textContent = item.title;
    const pre = document.createElement('pre');
    pre.textContent = item.text || '';
    li.appendChild(pre);
    list.appendChild(li);
  }
}
document.getElementById('go').onclick = () => load(document.getElementById('q').value.trim());
document.getElementById('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('go').click(); });
load('');
</script>
</html>`

/**
 * 挂路由。
 * @returns {boolean} 是否挂上
 */
export function installRoutes(ctx, runtime) {
  const server = serviceOf(ctx, 'webServer')
  if (!server || typeof server.register !== 'function') return false

  const routes = []

  const register = (path, handler) => {
    routes.push(server.register({ kind: 'exact', path, handler }))
  }

  // 面板（可选）
  register(`${API}/`, async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end()
      return
    }
    if (!runtime.config.exposePanel) {
      sendJson(res, 404, { ok: false, message: '面板已关闭（exposePanel = false）。' })
      return
    }
    sendHtml(res, PANEL_HTML)
  })

  register(`${API}/api/stats`, async (req, res) => {
    if (req.method !== 'GET') return res.writeHead(405).end()
    sendJson(res, 200, {
      ok: true,
      paused: runtime.paused === true,
      active: typeof runtime.isActive === 'function' ? runtime.isActive() : runtime.enabled,
      ...runtime.store.stats(),
      usage: runtime.store.usage(),
      capabilities: runtime.capabilities,
      config: {
        enabled: runtime.enabled,
        readonly: runtime.config.readonly,
        promptBudget: runtime.config.promptBudget,
        selfBudget: runtime.config.selfBudget,
        maxItems: runtime.config.maxItems,
      },
    })
  })

  register(`${API}/api/list`, async (req, res) => {
    if (req.method !== 'GET') return res.writeHead(405).end()
    const q = queryOf(req)
    const result = runtime.store.list({
      q: q.get('q') ?? undefined,
      subject: q.get('subject') ?? undefined,
      scope: q.get('scope') ?? undefined,
      kind: q.get('kind') ?? undefined,
      tag: q.get('tag') ?? undefined,
      pinnedOnly: q.get('pinnedOnly') === '1',
      limit: q.get('limit') ? Number(q.get('limit')) : 100,
      offset: q.get('offset') ? Number(q.get('offset')) : 0,
    })
    sendJson(res, 200, { ok: true, ...result, usage: runtime.store.usage() })
  })

  register(`${API}/api/item`, async (req, res) => {
    if (req.method !== 'GET') return res.writeHead(405).end()
    const id = queryOf(req).get('id') ?? ''
    const item = runtime.store.get(id)
    if (!item) return sendJson(res, 404, { ok: false, message: '找不到这条记忆。' })
    sendJson(res, 200, { ok: true, item })
  })

  const writeGuard = (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return false
    }
    if (!sameOrigin(req)) {
      sendJson(res, 403, { ok: false, message: '跨域请求被拒绝。' })
      return false
    }
    if (!wantsJson(req)) {
      sendJson(res, 415, { ok: false, message: '只接受 application/json。' })
      return false
    }
    if (runtime.config.readonly) {
      sendJson(res, 403, { ok: false, message: '当前是只读模式。' })
      return false
    }
    return true
  }

  /**
   * 「本鱼的记忆」在 HTTP 这一侧是**硬只读**。
   *
   * 不是把按钮灰一下：前端绕过、直接打接口也一样被顶回来。
   * 只有模型手里的工具（memory_diary / memory_write subject=self）能改它。
   */
  const lockedSelf = (res, item) => {
    if (!item || item.subject !== 'self') return false
    sendJson(res, 403, {
      ok: false,
      message: '这是本鱼自己的记忆，只有本鱼能改；你只能看。',
    })
    return true
  }

  register(`${API}/api/upsert`, async (req, res) => {
    if (!writeGuard(req, res)) return
    try {
      const body = await readBody(req)
      const existing =
        typeof body?.id === 'string' && body.id !== '' ? runtime.store.get(body.id) : null
      if (lockedSelf(res, existing)) return
      if (body?.subject === 'self') {
        sendJson(res, 403, {
          ok: false,
          message: '这是本鱼自己的记忆，只有本鱼能改；你只能看。',
        })
        return
      }
      const result = runtime.store.upsert({
        id: body?.id,
        // 面板写进来的一律是「我们之间」那一档
        subject: 'user',
        title: body?.title,
        text: body?.text,
        kind: body?.kind,
        scope: runtime.resolveScope(body?.scope),
        tags: body?.tags,
        pinned: body?.pinned,
        source: { by: 'user', at: Date.now() },
      })
      if (!result.ok) return sendJson(res, 409, { ok: false, ...result })
      sendJson(res, 200, { ok: true, ...result, usage: runtime.store.usage() })
    } catch (error) {
      sendJson(res, 400, { ok: false, message: String(error?.message ?? error) })
    }
  })

  register(`${API}/api/delete`, async (req, res) => {
    if (!writeGuard(req, res)) return
    try {
      const body = await readBody(req)
      const target = runtime.store.get(String(body?.id ?? ''))
      if (lockedSelf(res, target)) return
      const result = runtime.store.remove(String(body?.id ?? ''))
      if (!result.ok) return sendJson(res, 404, { ok: false, ...result })
      sendJson(res, 200, { ok: true, ...result, usage: runtime.store.usage() })
    } catch (error) {
      sendJson(res, 400, { ok: false, message: String(error?.message ?? error) })
    }
  })

  register(`${API}/api/pin`, async (req, res) => {
    if (!writeGuard(req, res)) return
    try {
      const body = await readBody(req)
      const target = runtime.store.get(String(body?.id ?? ''))
      if (lockedSelf(res, target)) return
      const result = runtime.store.setPin(String(body?.id ?? ''), body?.pinned === true)
      if (!result.ok) return sendJson(res, 404, { ok: false, ...result })
      sendJson(res, 200, { ok: true, ...result })
    } catch (error) {
      sendJson(res, 400, { ok: false, message: String(error?.message ?? error) })
    }
  })

  register(`${API}/api/pause`, async (req, res) => {
    if (req.method !== 'POST') return res.writeHead(405).end()
    if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, message: '跨域请求被拒绝。' })
    if (!wantsJson(req)) return sendJson(res, 415, { ok: false, message: '只接受 application/json。' })
    try {
      const body = await readBody(req)
      if (typeof runtime.setPaused !== 'function') {
        return sendJson(res, 501, { ok: false, message: '当前版本不支持暂停开关。' })
      }
      const paused = runtime.setPaused(body?.paused === true)
      sendJson(res, 200, {
        ok: true,
        paused,
        active: typeof runtime.isActive === 'function' ? runtime.isActive() : runtime.enabled,
      })
    } catch (error) {
      sendJson(res, 400, { ok: false, message: String(error?.message ?? error) })
    }
  })

  register(`${API}/api/export`, async (req, res) => {
    if (req.method !== 'GET') return res.writeHead(405).end()
    const subject = queryOf(req).get('subject') ?? undefined
    const items = runtime.store.exportAll({ subject })
    const only = subject === 'self' ? '-self' : ''
    const body = Buffer.from(JSON.stringify({ ok: true, count: items.length, items }, null, 2), 'utf8')
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="dsh-memory${only}-export.json"`,
      'content-length': body.length,
      'cache-control': 'no-store',
    })
    res.end(body)
  })

  register(`${API}/api/import`, async (req, res) => {
    if (!writeGuard(req, res)) return
    try {
      const body = await readBody(req)
      const items = Array.isArray(body) ? body : body?.items
      const mode = body?.mode === 'replace' ? 'replace' : 'merge'
      const result = runtime.store.importAll(items, { mode })
      if (!result.ok) return sendJson(res, 400, { ok: false, ...result })
      sendJson(res, 200, { ok: true, ...result, usage: runtime.store.usage() })
    } catch (error) {
      sendJson(res, 400, { ok: false, message: String(error?.message ?? error) })
    }
  })

  // 插件卸载时把注册的路由一并撤掉
  if (typeof ctx?.effect === 'function') {
    try {
      ctx.effect(() => () => {
        for (const dispose of routes) {
          try {
            if (typeof dispose === 'function') dispose()
          } catch {
            /* 已经撤掉了 */
          }
        }
      }, 'dsh-memory: routes')
    } catch {
      /* 老版本没有 ctx.effect：路由随进程走，不影响功能 */
    }
  }

  return true
}

export { API }
