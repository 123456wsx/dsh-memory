/**
 * dsh-memory — 浏览器半区（DSH 设置页里的「记忆」一节）。
 *
 * 挂载方式与 DSH 客户端插件一致：
 *   window.__ModuleLoader__.load({ id, factory: (require) => exports })
 * React 由宿主提供，不需要构建步骤。
 *
 * 界面参照 ChatGPT 的「设置 → 个性化 → 记忆」：一个总开关、一条用量、
 * 一个搜索框、一列可编辑/可删除的条目。
 */
;(function bootstrap() {
  const loader = window.__ModuleLoader__
  if (!loader || typeof loader.load !== 'function') {
    console.warn('[dsh-memory] 当前页面没有 window.__ModuleLoader__，客户端面板无法挂载。')
    return
  }

  loader.load({
    id: 'dsh-memory',
    factory: (require) => {
      const module = { exports: {} }
      const exports = module.exports
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

      const react = require('react')
      const h = react.createElement
      const { useCallback, useEffect, useMemo, useRef, useState } = react

      const name = 'dsh-memory'
      const inject = ['slots']
      const API = '/__dsh-memory/api'

      const KINDS = [
        { id: 'preference', label: '偏好' },
        { id: 'decision', label: '决策' },
        { id: 'project', label: '项目' },
        { id: 'fact', label: '事实' },
        { id: 'todo', label: '待办' },
        { id: 'note', label: '随手记' },
      ]
      const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.id, k.label]))

      // ------------------------------------------------------------ 样式
      const STYLE_ID = 'dsh-memory-panel-style'
      const CSS = [
        '[data-dsh-memory]{display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:1.55;padding:2px 0 8px;}',
        '[data-dsh-memory] *{box-sizing:border-box;}',
        '[data-dsh-memory] .dm-toggle{display:flex;align-items:center;justify-content:space-between;gap:16px;',
        'padding:10px 12px;border:1px solid rgba(127,127,127,.22);border-radius:10px;}',
        '[data-dsh-memory] .dm-toggle b{display:block;font-weight:600;}',
        '[data-dsh-memory] .dm-toggle p{margin:2px 0 0;opacity:.62;font-size:12px;}',
        '[data-dsh-memory] input[type=text],[data-dsh-memory] textarea,[data-dsh-memory] select{',
        'font:inherit;color:inherit;background:transparent;border:1px solid rgba(127,127,127,.26);',
        'border-radius:8px;padding:6px 9px;outline:none;}',
        '[data-dsh-memory] input[type=text]:focus,[data-dsh-memory] textarea:focus,[data-dsh-memory] select:focus{',
        'border-color:rgba(64,132,255,.55);}',
        '[data-dsh-memory] textarea{min-height:72px;resize:vertical;width:100%;}',
        '[data-dsh-memory] button{font:inherit;color:inherit;background:rgba(127,127,127,.12);',
        'border:1px solid rgba(127,127,127,.24);border-radius:8px;padding:4px 10px;cursor:pointer;}',
        '[data-dsh-memory] button:hover:not(:disabled){background:rgba(127,127,127,.2);}',
        '[data-dsh-memory] button:disabled{opacity:.42;cursor:not-allowed;}',
        '[data-dsh-memory] button.dm-primary{background:rgba(64,132,255,.16);border-color:rgba(64,132,255,.42);}',
        '[data-dsh-memory] button.dm-danger{color:#e5534b;border-color:rgba(229,83,75,.38);}',
        '[data-dsh-memory] .dm-bar-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}',
        '[data-dsh-memory] .dm-bar-row input[type=text]{flex:1;min-width:160px;}',
        '[data-dsh-memory] .dm-usage{display:flex;align-items:center;gap:10px;font-size:12px;opacity:.82;}',
        '[data-dsh-memory] .dm-usage .dm-track{flex:1;height:6px;border-radius:3px;background:rgba(127,127,127,.18);overflow:hidden;}',
        '[data-dsh-memory] .dm-usage .dm-fill{display:block;height:100%;background:#4084ff;transition:width .2s;}',
        '[data-dsh-memory] .dm-usage .dm-fill.dm-full{background:#e5534b;}',
        '[data-dsh-memory] .dm-card{border:1px solid rgba(127,127,127,.2);border-radius:10px;',
        'padding:10px 12px;display:flex;flex-direction:column;gap:6px;}',
        '[data-dsh-memory] .dm-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
        '[data-dsh-memory] .dm-head b{font-weight:600;}',
        '[data-dsh-memory] .dm-card p{margin:0;white-space:pre-wrap;word-break:break-word;opacity:.84;}',
        '[data-dsh-memory] .dm-badge{font-size:11px;padding:1px 7px;border-radius:999px;background:rgba(127,127,127,.16);}',
        '[data-dsh-memory] .dm-tags{display:flex;gap:6px;flex-wrap:wrap;font-size:11px;opacity:.68;}',
        '[data-dsh-memory] .dm-grow{flex:1;}',
        '[data-dsh-memory] .dm-empty{padding:22px 12px;text-align:center;opacity:.6;font-size:12px;',
        'border:1px dashed rgba(127,127,127,.3);border-radius:10px;}',
        '[data-dsh-memory] .dm-error{color:#e5534b;font-size:12px;padding:8px 10px;border-radius:8px;',
        'background:rgba(229,83,75,.1);}',
        '[data-dsh-memory] .dm-warn{color:#d99a12;font-size:12px;}',
        '[data-dsh-memory] .dm-form{border:1px solid rgba(64,132,255,.35);border-radius:10px;',
        'padding:10px 12px;display:flex;flex-direction:column;gap:8px;}',
        '[data-dsh-memory] .dm-form .dm-bar-row{align-items:center;}',
        '[data-dsh-memory] .dm-hint{font-size:11px;opacity:.55;}',
      ].join('')

      function ensureStyle() {
        if (document.getElementById(STYLE_ID) !== null) return
        const el = document.createElement('style')
        el.id = STYLE_ID
        el.textContent = CSS
        document.head.appendChild(el)
      }

      // -------------------------------------------------------------- HTTP
      async function request(path, init) {
        let response
        try {
          response = await fetch(new URL(path, window.location.origin), init)
        } catch (error) {
          throw new Error('连不上记忆接口：' + ((error && error.message) || '网络错误'))
        }
        let payload = null
        try {
          payload = await response.json()
        } catch {
          if (response.status === 404) {
            throw new Error('记忆接口没有挂上（HTTP 404）：宿主侧插件没加载成功，重启 DSH 后再试')
          }
          throw new Error('记忆接口返回的不是 JSON（HTTP ' + response.status + '）')
        }
        if (!response.ok || payload?.ok === false) {
          throw new Error(payload?.message ?? '请求失败（HTTP ' + response.status + '）')
        }
        return payload
      }

      function getJson(path, params) {
        const url = new URL(path, window.location.origin)
        for (const [key, value] of Object.entries(params ?? {})) {
          if (value === undefined || value === null || value === '') continue
          url.searchParams.set(key, String(value))
        }
        return request(url.toString().replace(window.location.origin, ''), {
          headers: { accept: 'application/json' },
        })
      }

      function postJson(path, body) {
        return request(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        })
      }

      // ---------------------------------------------------------- 小组件
      function Toggle({ active, disabled, onToggle }) {
        return h(
          'div',
          { className: 'dm-toggle' },
          h(
            'div',
            null,
            h('b', null, '启用记忆'),
            h(
              'p',
              null,
              active
                ? '每次对话都会自动带上记忆摘要；模型也可以随时写入新记忆。'
                : '已暂停：不再自动注入，模型也无法写入。已保存的条目不会动。',
            ),
          ),
          h(
            'button',
            { className: active ? 'dm-primary' : '', disabled, onClick: onToggle },
            active ? '已启用' : '已暂停',
          ),
        )
      }

      function Usage({ usage }) {
        if (!usage) return null
        const ratio = usage.maxItems > 0 ? Math.min(1, usage.count / usage.maxItems) : 0
        const full = usage.full === true
        return h(
          'div',
          { className: 'dm-usage' },
          h(
            'div',
            { className: 'dm-track' },
            h('i', {
              className: full ? 'dm-fill dm-full' : 'dm-fill',
              style: { width: Math.round(ratio * 100) + '%' },
            }),
          ),
          h('span', null, usage.count + ' / ' + usage.maxItems + ' 条'),
          full ? h('span', { className: 'dm-warn' }, '已满，请删除一些') : null,
        )
      }

      function Card({ item, busy, onEdit, onDelete, onPin }) {
        return h(
          'div',
          { className: 'dm-card' },
          h(
            'div',
            { className: 'dm-head' },
            h('span', { className: 'dm-badge' }, KIND_LABEL[item.kind] ?? item.kind),
            item.pinned ? h('span', { title: '已置顶' }, '📌') : null,
            h('b', null, item.title),
            h('span', { className: 'dm-grow' }),
            h('button', { disabled: busy, onClick: () => onPin(item, !item.pinned) }, item.pinned ? '取消置顶' : '置顶'),
            h('button', { disabled: busy, onClick: () => onEdit(item) }, '编辑'),
            h('button', { className: 'dm-danger', disabled: busy, onClick: () => onDelete(item) }, '删除'),
          ),
          item.text ? h('p', null, item.text) : null,
          item.tags && item.tags.length > 0
            ? h(
                'div',
                { className: 'dm-tags' },
                item.tags.map((tag) => h('span', { key: tag }, '#' + tag)),
              )
            : null,
        )
      }

      function Editor({ draft, busy, onChange, onCancel, onSave, full }) {
        const disabledSave = busy || String(draft.title ?? '').trim() === ''
        return h(
          'div',
          { className: 'dm-form' },
          h('input', {
            type: 'text',
            placeholder: '标题（一句话，例如「称呼偏好」）',
            value: draft.title ?? '',
            onChange: (event) => onChange({ title: event.target.value }),
          }),
          h('textarea', {
            placeholder: '正文。写成完整陈述句，例如「用户希望被称呼为『船长』」。',
            value: draft.text ?? '',
            onChange: (event) => onChange({ text: event.target.value }),
          }),
          h(
            'div',
            { className: 'dm-bar-row' },
            h(
              'select',
              { value: draft.kind ?? 'note', onChange: (event) => onChange({ kind: event.target.value }) },
              KINDS.map((kind) => h('option', { key: kind.id, value: kind.id }, kind.label)),
            ),
            h('input', {
              type: 'text',
              placeholder: '标签，逗号分隔',
              value: draft.tagsText ?? '',
              onChange: (event) => onChange({ tagsText: event.target.value }),
              style: { flex: 1, minWidth: '140px' },
            }),
            h(
              'button',
              {
                className: draft.pinned ? 'dm-primary' : '',
                onClick: () => onChange({ pinned: !draft.pinned }),
                title: '置顶条目在自动注入时优先出现',
              },
              draft.pinned ? '📌 置顶' : '置顶',
            ),
          ),
          h(
            'div',
            { className: 'dm-bar-row' },
            h('span', { className: 'dm-grow' }),
            h('button', { onClick: onCancel, disabled: busy }, '取消'),
            h('button', { className: 'dm-primary', onClick: onSave, disabled: disabledSave }, '保存'),
          ),
          full ? h('div', { className: 'dm-hint' }, '记忆已满，保存会失败。请先删掉一些条目。') : null,
        )
      }

      // ---------------------------------------------------------- 主面板
      function MemorySettings() {
        const [stats, setStats] = useState(null)
        const [items, setItems] = useState([])
        const [total, setTotal] = useState(0)
        const [loading, setLoading] = useState(true)
        const [busy, setBusy] = useState(false)
        const [error, setError] = useState('')

        const [queryDraft, setQueryDraft] = useState('')
        const [query, setQuery] = useState('')
        const [scope, setScope] = useState('all')
        const [kind, setKind] = useState('all')

        const [editingId, setEditingId] = useState(null)
        const [draft, setDraft] = useState({})
        const [creating, setCreating] = useState(false)

        const alive = useRef(true)
        useEffect(() => {
          alive.current = true
          return () => {
            alive.current = false
          }
        }, [])

        // 搜索防抖
        useEffect(() => {
          const timer = window.setTimeout(() => setQuery(queryDraft.trim()), 320)
          return () => window.clearTimeout(timer)
        }, [queryDraft])

        const refresh = useCallback(async () => {
          setLoading(true)
          setError('')
          try {
            const [nextStats, nextList] = await Promise.all([
              getJson(API + '/stats'),
              getJson(API + '/list', {
                q: query,
                scope: scope === 'all' ? '' : scope,
                kind: kind === 'all' ? '' : kind,
                limit: 200,
              }),
            ])
            if (!alive.current) return
            setStats(nextStats)
            setItems(Array.isArray(nextList.items) ? nextList.items : [])
            setTotal(nextList.total ?? 0)
          } catch (failure) {
            if (!alive.current) return
            setError(failure instanceof Error ? failure.message : String(failure))
          } finally {
            if (alive.current) setLoading(false)
          }
        }, [query, scope, kind])

        useEffect(() => {
          void refresh()
        }, [refresh])

        const usage = stats?.usage ?? null
        const full = usage?.full === true
        const paused = stats?.paused === true
        const enabled = stats?.config?.enabled !== false
        const readonly = stats?.config?.readonly === true
        const locked = readonly || busy

        const run = useCallback(
          async (task) => {
            setBusy(true)
            setError('')
            try {
              await task()
              await refresh()
            } catch (failure) {
              setError(failure instanceof Error ? failure.message : String(failure))
            } finally {
              if (alive.current) setBusy(false)
            }
          },
          [refresh],
        )

        const onToggle = useCallback(() => {
          void run(async () => {
            await postJson(API + '/pause', { paused: !paused })
          })
        }, [paused, run])

        const startCreate = useCallback(() => {
          setEditingId(null)
          setCreating(true)
          setDraft({ title: '', text: '', kind: 'note', tagsText: '', pinned: false })
        }, [])

        const startEdit = useCallback((item) => {
          setCreating(false)
          setEditingId(item.id)
          setDraft({
            title: item.title,
            text: item.text,
            kind: item.kind,
            tagsText: (item.tags ?? []).join('，'),
            pinned: item.pinned === true,
          })
        }, [])

        const cancel = useCallback(() => {
          setEditingId(null)
          setCreating(false)
          setDraft({})
        }, [])

        const save = useCallback(() => {
          const title = String(draft.title ?? '').trim()
          if (title === '') return
          void run(async () => {
            await postJson(API + '/upsert', {
              ...(editingId !== null ? { id: editingId } : {}),
              title,
              text: String(draft.text ?? ''),
              kind: draft.kind ?? 'note',
              tags: String(draft.tagsText ?? '')
                .split(/[,，、\s]+/)
                .map((tag) => tag.trim())
                .filter((tag) => tag !== ''),
              pinned: draft.pinned === true,
            })
            cancel()
          })
        }, [draft, editingId, run, cancel])

        const remove = useCallback(
          (item) => {
            if (!window.confirm('删除「' + item.title + '」？\n\n删除后不可恢复（会先自动备份一份）。')) return
            void run(async () => {
              await postJson(API + '/delete', { id: item.id })
            })
          },
          [run],
        )

        const pin = useCallback(
          (item, pinned) => {
            void run(async () => {
              await postJson(API + '/pin', { id: item.id, pinned })
            })
          },
          [run],
        )

        const scopeOptions = useMemo(
          () => [
            { value: 'all', label: '全部作用域' },
            { value: 'global', label: '全局' },
            { value: 'workspace', label: '仅本工作区' },
          ],
          [],
        )

        return h(
          'div',
          { 'data-dsh-memory': '' },
          !enabled
            ? h(
                'div',
                { className: 'dm-error' },
                '插件配置里 enabled = false，记忆功能整体关闭了。改配置后重启生效。',
              )
            : null,
          h(Toggle, { active: !paused, disabled: locked, onToggle }),
          h(Usage, { usage }),
          full
            ? h('div', { className: 'dm-warn' }, '记忆已满：模型再写入会被拒绝，请删除一些条目。')
            : null,
          error !== '' ? h('div', { className: 'dm-error' }, error) : null,
          h(
            'div',
            { className: 'dm-bar-row' },
            h('input', {
              type: 'text',
              placeholder: '搜索标题、正文或标签…',
              value: queryDraft,
              onChange: (event) => setQueryDraft(event.target.value),
            }),
            h(
              'select',
              { value: scope, onChange: (event) => setScope(event.target.value) },
              scopeOptions.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
            ),
            h(
              'select',
              { value: kind, onChange: (event) => setKind(event.target.value) },
              h('option', { value: 'all' }, '全部类型'),
              KINDS.map((each) => h('option', { key: each.id, value: each.id }, each.label)),
            ),
          ),
          h(
            'div',
            { className: 'dm-bar-row' },
            h('span', { className: 'dm-hint' }, '共 ' + total + ' 条' + (loading ? '，加载中…' : '')),
            h('span', { className: 'dm-grow' }),
            h(
              'button',
              { className: 'dm-primary', disabled: locked || full, onClick: startCreate },
              '添加一条记忆',
            ),
          ),
          creating
            ? h(Editor, {
                draft,
                busy: locked,
                full,
                onChange: (patch) => setDraft((previous) => ({ ...previous, ...patch })),
                onCancel: cancel,
                onSave: save,
              })
            : null,
          items.length === 0 && !loading
            ? h(
                'div',
                { className: 'dm-empty' },
                queryDraft.trim() !== '' || scope !== 'all' || kind !== 'all'
                  ? '没有匹配的记忆。'
                  : '还没有记忆。模型在对话里遇到值得长期记住的事会自动写进来，你也可以手动添加。',
              )
            : null,
          items.map((item) =>
            editingId === item.id
              ? h(Editor, {
                  key: item.id,
                  draft,
                  busy: locked,
                  full,
                  onChange: (patch) => setDraft((previous) => ({ ...previous, ...patch })),
                  onCancel: cancel,
                  onSave: save,
                })
              : h(Card, {
                  key: item.id,
                  item,
                  busy: locked,
                  onEdit: startEdit,
                  onDelete: remove,
                  onPin: pin,
                }),
          ),
        )
      }

      // ------------------------------------------------------------ apply
      function apply(ctx) {
        ensureStyle()
        const slots = ctx?.slots
        if (slots === undefined || slots === null) return

        try {
          slots.inject('settings.section', () =>
            slots.register(
              { name: 'settings.section', id: 'memory', order: 45, label: () => '记忆' },
              () => h(MemorySettings, null),
            ),
          )
        } catch {
          // 老版本 DSH 没有 settings.section 这个 slot：面板不出现，但工具与注入照常工作
        }
      }

      exports.name = name
      exports.inject = inject
      exports.apply = apply
      exports.MemorySettings = MemorySettings
      return module.exports
    },
  })
})()
