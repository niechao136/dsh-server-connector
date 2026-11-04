// dsh-server-connector — Client half (design doc §8).
//
// Three mount points, all taken from the confirmed live Slot tree (§8.1):
//
//   sidebar.panellist  → the "服务器" icon in the left rail
//   main (key: "server-connector") → server list / detail / form
//   settings.section   → global settings + the pending two-step queue
//
// The file is a browser module-loader bundle, not a Node module: the DSH client
// module system loads it through `window.__ModuleLoader__.load`, and `require`
// is the page's static table (react, react/jsx-runtime, …). It is hand-authored
// — this repository has no client build step — so it uses `React.createElement`
// rather than JSX and keeps every browser global behind `browserGlobal` so the
// Node-side `tsc --noEmit` pass (tsconfig lib is ES2023, no DOM) stays clean.
//
// Two product constraints shape the UI:
//   - the panel talks to the Host only through the §8.5 JSON routes, and it
//     never receives a secret (a password is write-only, §6.3);
//   - the panel has no turn, so `ctx.approval` is unavailable (§11): deleting a
//     server, switching host-key verification off and disabling a rule all write
//     to the pending queue and say so. Nothing dangerous happens on one click.

/** The page global, typed loosely: this bundle runs in the browser, not in Node. */
const browserGlobal = /** @type {any} */ (globalThis)

browserGlobal.__ModuleLoader__.load({
  id: 'dsh-server-connector',
  factory: (/** @type {(id: string) => any} */ load) => {
    const module = { exports: /** @type {Record<string, unknown>} */ ({}) }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = load('react')
    const h = React.createElement
    const F = React.Fragment

    /** Dictionary namespace owned by this plugin. */
    const NS = 'serverConnector'
    /** The id shared by the sidebar entry, the main panel key and the settings page. */
    const PANEL_ID = 'server-connector'
    /** Mount path of the Host routes (§8.5). */
    const API = '/server-connector'
    /** A displayed audit tail matches the detail page (§8.2). */
    const AUDIT_LIMIT = 20

    // ---------------------------------------------------------------- copy --

    /** Chinese dictionary, the source of truth. */
    const zh = {
      'panel.label': '服务器',
      'panel.title': '服务器',
      'panel.add': '新增',
      'panel.loading': '读取服务器列表…',
      'panel.retry': '重试',
      'panel.empty': '还没有配置服务器。',
      'panel.emptyHint': '新增一台后，模型即可通过 srv_* 工具在这台机器上执行命令。',
      'panel.connected': '已连接',
      'panel.disconnected': '未连接',
      'panel.test': '测试',
      'panel.testing': '测试中…',
      'panel.edit': '编辑',
      'panel.back': '返回列表',
      'panel.delete': '删除',
      'panel.deleteHint': '删除会先写入待确认区，确认后才真正移除。',
      'panel.deleteQueued': '删除请求已加入待确认区，服务器仍然可用；请到设置页确认。',
      'panel.sectionConnection': '连接',
      'panel.sectionPolicy': '高危策略',
      'panel.sectionAudit': `最近 ${AUDIT_LIMIT} 条审计`,
      'panel.auditEmpty': '没有审计记录。',
      'panel.auditLoading': '读取审计…',
      'panel.notFound': '这台服务器已不存在。',
      'panel.lastConnected': '上次连接 {time}',
      'panel.neverConnected': '从未连接',
      'status.connected': '连接成功：{platform}（{shell}，sudo {sudo}），耗时 {ms} ms',
      'field.name': '名称',
      'field.host': '主机',
      'field.port': '端口',
      'field.username': '用户名',
      'field.auth': '认证方式',
      'field.privateKeyPath': '私钥路径',
      'field.password': '密码',
      'field.hostKeyMode': '主机密钥策略',
      'field.defaultWorkDir': '默认工作目录',
      'field.lastConnectedAt': '最近连接',
      'field.policy': '高危策略',
      'auth.key': '私钥',
      'auth.password': '密码',
      'auth.agent': 'SSH agent',
      'auth.passwordConfigured': '已设置',
      'hostKey.accept-new': 'accept-new（首次接受并记住）',
      'hostKey.verify': 'verify（严格校验）',
      'hostKey.off': 'off（关闭校验）',
      'form.new': '新增服务器',
      'form.edit': '编辑服务器',
      'form.save': '保存',
      'form.saving': '保存中…',
      'form.cancel': '取消',
      'form.portRange': '端口必须是 1–65535 的整数',
      'form.absolutePath': '必须是绝对路径',
      'form.passwordKeep': '留空则保持当前密码',
      'form.passwordNew': '密码只写不回显',
      'form.policyHint': '内置 block 规则只能降为 confirm，不能直接改为 allow；选择「停用」会先写入待确认区。',
      'form.offOption': '停用',
      'form.offQueued': '「停用」会写入待确认区，确认后该规则才失效。',
      'form.pendingNote': '危险改动已写入待确认区，确认后才生效。',
      'form.errorName': '名称不能为空',
      'form.errorHost': '主机不能为空',
      'form.errorUsername': '用户名不能为空',
      'form.errorKeyPath': '私钥路径不能为空',
      'form.errorPassword': '密码不能为空',
      'settings.nav': '服务器连接器',
      'settings.title': '服务器连接器',
      'settings.description': '面板、连接池与危险操作的两段式确认。',
      'settings.global': '全局设置',
      'settings.globalHint': '这些值来自 profile 配置，修改后重启插件生效。',
      'settings.pending': '待确认操作',
      'settings.pendingEmpty': '没有待确认的操作。',
      'settings.pendingHint': '删除服务器、关闭主机密钥校验、停用高危规则都会先进入这里；确认前目标保持原样。',
      'pending.deleteServer': '删除服务器「{name}」',
      'pending.disableHostkey': '关闭主机密钥校验「{name}」',
      'pending.disableRule': '停用高危规则「{rule}」（{name}）',
      'pending.requestedAt': '申请于 {time}',
      'pending.expiresAt': '{time} 过期',
      'pending.confirm': '确认执行',
      'pending.cancel': '取消',
      'pending.busy': '执行中…',
      'pending.targetMissing': '目标已不存在',
      'error.generic': '操作失败：{message}',
      'error.load': '读取失败：{message}',
    }

    /** English dictionary, key-identical to the Chinese source of truth. */
    const en = {
      'panel.label': 'Servers',
      'panel.title': 'Servers',
      'panel.add': 'Add',
      'panel.loading': 'Reading servers…',
      'panel.retry': 'Retry',
      'panel.empty': 'No server configured yet.',
      'panel.emptyHint': 'Add one and the model can run commands on this machine through the srv_* tools.',
      'panel.connected': 'Connected',
      'panel.disconnected': 'Not connected',
      'panel.test': 'Test',
      'panel.testing': 'Testing…',
      'panel.edit': 'Edit',
      'panel.back': 'Back to list',
      'panel.delete': 'Delete',
      'panel.deleteHint': 'Deleting first queues a request; the server is removed only after you confirm it.',
      'panel.deleteQueued': 'The delete request is queued and the server still works; confirm it in Settings.',
      'panel.sectionConnection': 'Connection',
      'panel.sectionPolicy': 'High-risk policy',
      'panel.sectionAudit': `Last ${AUDIT_LIMIT} audit records`,
      'panel.auditEmpty': 'No audit records.',
      'panel.auditLoading': 'Reading the audit log…',
      'panel.notFound': 'This server no longer exists.',
      'panel.lastConnected': 'Last connected {time}',
      'panel.neverConnected': 'Never connected',
      'status.connected': 'Connected: {platform} ({shell}, sudo {sudo}) in {ms} ms',
      'field.name': 'Name',
      'field.host': 'Host',
      'field.port': 'Port',
      'field.username': 'Username',
      'field.auth': 'Authentication',
      'field.privateKeyPath': 'Private key path',
      'field.password': 'Password',
      'field.hostKeyMode': 'Host-key policy',
      'field.defaultWorkDir': 'Default working directory',
      'field.lastConnectedAt': 'Last connected',
      'field.policy': 'High-risk policy',
      'auth.key': 'Private key',
      'auth.password': 'Password',
      'auth.agent': 'SSH agent',
      'auth.passwordConfigured': 'configured',
      'hostKey.accept-new': 'accept-new (accept and remember first)',
      'hostKey.verify': 'verify (strict)',
      'hostKey.off': 'off (verification off)',
      'form.new': 'Add server',
      'form.edit': 'Edit server',
      'form.save': 'Save',
      'form.saving': 'Saving…',
      'form.cancel': 'Cancel',
      'form.portRange': 'The port must be an integer from 1 to 65535',
      'form.absolutePath': 'Must be an absolute path',
      'form.passwordKeep': 'Leave blank to keep the current password',
      'form.passwordNew': 'The password is write-only',
      'form.policyHint': 'A built-in block rule can be lowered to confirm, never straight to allow; choosing “off” queues a pending request.',
      'form.offOption': 'Off',
      'form.offQueued': '“Off” is queued; the rule keeps working until you confirm.',
      'form.pendingNote': 'The dangerous change is queued and takes effect only after you confirm it.',
      'form.errorName': 'Name is required',
      'form.errorHost': 'Host is required',
      'form.errorUsername': 'Username is required',
      'form.errorKeyPath': 'Private key path is required',
      'form.errorPassword': 'Password is required',
      'settings.nav': 'Server Connector',
      'settings.title': 'Server Connector',
      'settings.description': 'The panel, the connection pool and two-step confirmation for dangerous operations.',
      'settings.global': 'Global settings',
      'settings.globalHint': 'These values come from the profile configuration; restart the plugin to change them.',
      'settings.pending': 'Pending operations',
      'settings.pendingEmpty': 'Nothing is pending.',
      'settings.pendingHint': 'Deleting a server, switching host-key verification off and disabling a high-risk rule all wait here; the target stays as it is until you confirm.',
      'pending.deleteServer': 'Delete server “{name}”',
      'pending.disableHostkey': 'Turn off host-key verification for “{name}”',
      'pending.disableRule': 'Disable high-risk rule “{rule}” on “{name}”',
      'pending.requestedAt': 'Requested {time}',
      'pending.expiresAt': 'expires {time}',
      'pending.confirm': 'Confirm',
      'pending.cancel': 'Cancel',
      'pending.busy': 'Working…',
      'pending.targetMissing': 'the target is already gone',
      'error.generic': 'The operation failed: {message}',
      'error.load': 'Could not read: {message}',
    }

    // --------------------------------------------------------------- style --

    /** One stylesheet, injected once by the module system (§ client styles claim the tag). */
    const CSS = [
      '.srv-page{box-sizing:border-box;height:100%;overflow:auto;padding:24px clamp(16px,3vw,40px) 48px;color:var(--dsw-alias-label-primary);',
      'font-size:14px;line-height:22px;container-type:inline-size}',
      '.srv-column{max-width:960px;margin:0 auto;display:flex;flex-direction:column;gap:16px}',
      '.srv-head{display:flex;align-items:center;gap:8px 16px;flex-wrap:wrap}',
      '.srv-head h2{margin:0;flex:1 1 auto;min-width:0;font-size:20px;line-height:28px;font-weight:500;',
      'overflow-wrap:anywhere}',
      '.srv-head-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.srv-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:32px;padding:0 14px;',
      'border:0;border-radius:16px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;',
      'font-size:13px;cursor:pointer;white-space:nowrap}',
      '.srv-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.srv-btn:disabled{cursor:not-allowed;opacity:.4}',
      '.srv-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.srv-btn-sm{height:26px;padding:0 10px;font-size:12px;border-radius:13px}',
      '.srv-btn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
      '.srv-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.srv-btn-outline{border:.5px solid var(--dsw-alias-border-l3)}',
      '.srv-btn-danger{color:var(--dsw-alias-state-error-primary)}',
      '.srv-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}',
      '.srv-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}',
      '.srv-row{display:flex;align-items:flex-start;gap:4px 12px;flex-wrap:wrap;padding:10px 8px;border-radius:12px;min-width:0}',
      '.srv-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.srv-row-main{flex:1 1 240px;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.srv-row-title{display:flex;align-items:center;gap:8px;min-width:0;font-size:14px;line-height:20px;font-weight:500}',
      '.srv-open{padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}',
      '.srv-open:hover{text-decoration:underline}',
      '.srv-row-meta{display:flex;align-items:center;gap:4px 10px;flex-wrap:wrap;font-size:12px;line-height:18px;',
      'color:var(--dsw-alias-label-caption);overflow-wrap:anywhere}',
      '.srv-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}',
      '.srv-dot[data-on="true"]{background:var(--dsw-alias-state-success-primary)}',
      '.srv-tag{display:inline-flex;align-items:center;border:.5px solid var(--dsw-alias-border-l4);border-radius:999px;',
      'padding:0 8px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.srv-tag[data-tone="success"]{border-color:transparent;background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent);',
      'color:var(--dsw-alias-state-success-primary)}',
      '.srv-tag[data-tone="warn"]{border-color:transparent;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);',
      'color:var(--dsw-alias-state-warn-primary)}',
      '.srv-row-actions{display:flex;align-items:center;gap:4px;flex:none;margin-left:auto}',
      '.srv-empty{margin:0;padding:32px 8px;text-align:center;color:var(--dsw-alias-label-tertiary)}',
      '.srv-empty p{margin:0 0 4px}',
      '.srv-card{display:flex;flex-direction:column;gap:12px;padding:16px;border:.5px solid var(--dsw-alias-border-l3);',
      'border-radius:16px;min-width:0}',
      '.srv-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.srv-card-title{margin:0;flex:1;font-size:15px;line-height:22px;font-weight:600}',
      '.srv-kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 16px;margin:0;font-size:13px;line-height:20px}',
      '.srv-kv dt{color:var(--dsw-alias-label-tertiary)}',
      '.srv-kv dd{margin:0;min-width:0;overflow-wrap:anywhere}',
      '.srv-mono{font-family:var(--ds-font-family-code,Menlo,monospace);font-size:12px}',
      '.srv-form{display:flex;flex-direction:column;gap:16px}',
      '.srv-field{display:flex;flex-direction:column;gap:6px;min-width:0;font-size:13px;line-height:20px}',
      '.srv-field-row{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:12px}',
      '.srv-input,.srv-select{box-sizing:border-box;width:100%;min-width:0;height:32px;padding:0 8px;font:inherit;',
      'font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1,transparent);',
      'border:.5px solid var(--dsw-alias-border-l4);border-radius:8px}',
      '.srv-input:focus-visible,.srv-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.srv-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}',
      '.srv-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.srv-note{margin:0;padding:8px 12px;border-radius:10px;font-size:13px;line-height:20px;',
      'background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent);overflow-wrap:anywhere}',
      '.srv-seg{display:inline-flex;gap:2px;padding:3px;border-radius:9px;background:var(--dsw-alias-interactive-bg-hover)}',
      '.srv-seg button{height:26px;padding:0 12px;border:0;border-radius:7px;background:transparent;cursor:pointer;',
      'font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.srv-seg button[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);',
      'box-shadow:var(--dsw-elevation-soft)}',
      '.srv-rules{border-top:.5px solid var(--dsw-alias-border-l2);margin:0;padding:0;list-style:none}',
      '.srv-rule{display:flex;align-items:flex-start;gap:12px;padding:8px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.srv-rule-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.srv-rule-label{font-size:13px;line-height:20px;font-weight:500}',
      '.srv-rule-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption);overflow-wrap:anywhere}',
      '.srv-rule-select{flex:none;width:132px}',
      '.srv-audit{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;font-size:12px;line-height:18px}',
      '.srv-audit li{display:flex;gap:8px;align-items:baseline;min-width:0;padding:2px 0}',
      '.srv-audit-time{flex:none;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}',
      '.srv-audit-decision{flex:none;width:56px;color:var(--dsw-alias-label-secondary)}',
      '.srv-audit-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,Menlo,monospace)}',
      '.srv-badge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;',
      'border-radius:9px;background:var(--dsw-alias-state-error-primary);color:var(--dsw-static-neutral-bluish-00);',
      'font-size:11px;line-height:18px;font-weight:600}',
      '.srv-pending{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}',
      '.srv-pending li{display:flex;align-items:center;gap:8px 12px;flex-wrap:wrap;padding:8px 0;',
      'border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.srv-pending-main{flex:1 1 220px;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.srv-pending-title{font-size:13px;line-height:20px;font-weight:500;overflow-wrap:anywhere}',
      '.srv-pending-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption)}',
      '.srv-danger-zone{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;',
      'padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '@container (max-width:640px){.srv-field-row{grid-template-columns:1fr}.srv-rule{flex-wrap:wrap}',
      '.srv-rule-select{width:100%}}',
    ].join('')

    /** Inject the stylesheet once; the client module system tags it for HMR cleanup. */
    function installStyles() {
      if (typeof browserGlobal.document === 'undefined') return
      const document = browserGlobal.document
      if (document.querySelector('style[data-server-connector]') !== null) return
      const tag = document.createElement('style')
      tag.setAttribute('data-server-connector', '')
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ---------------------------------------------------------------- HTTP --

    /**
     * One route call. Same-origin, so the browser session cookie authenticates
     * it exactly like the rest of the GUI (§8.5 trust boundary).
     * @param {string} path - path below {@link API}.
     * @param {{method?: string, body?: unknown, query?: Record<string, string>}} [options]
     * @returns {Promise<any>}
     */
    async function api(path, options = {}) {
      const query = options.query === undefined ? '' : `?${new URLSearchParams(options.query).toString()}`
      /** @type {Record<string, string>} */
      const headers = {}
      /** @type {RequestInit} */
      const init = { method: options.method ?? 'GET', headers }
      if (options.body !== undefined) {
        headers['content-type'] = 'application/json'
        init.body = JSON.stringify(options.body)
      }
      const response = await browserGlobal.fetch(`${API}${path}${query}`, init)
      let payload
      const text = await response.text()
      try {
        payload = text === '' ? null : JSON.parse(text)
      } catch {
        payload = null
      }
      if (!response.ok) {
        throw Object.assign(
          new Error(typeof payload?.error?.message === 'string' ? payload.error.message : `HTTP ${String(response.status)}`),
          {
            code: payload?.error?.code ?? `HTTP_${String(response.status)}`,
            status: response.status,
            details: payload?.error?.details ?? {},
          },
        )
      }
      return payload
    }

    /**
     * The displayable message of a thrown value.
     * @param {unknown} error
     * @returns {string}
     */
    function messageOf(error) {
      if (error instanceof Error) return error.message
      if (typeof error === 'object' && error !== null && typeof (/** @type {any} */ (error).message) === 'string') {
        return /** @type {any} */ (error).message
      }
      return String(error)
    }

    /**
     * Format one timestamp for the panel; an unparsable value is shown as-is.
     * @param {unknown} value
     * @returns {string}
     */
    function formatTime(value) {
      if (typeof value !== 'string' || value === '') return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return value
      return date.toLocaleString(undefined, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    }

    // --------------------------------------------------------------- atoms --

    /** @param {{size?: number, children?: any}} props */
    function Icon({ size = 16, children }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        children,
      )
    }

    /** The §8.1 sidebar icon: a rack of two server units. */
    function ServerIcon({ size = 20 }) {
      return h(
        Icon,
        { size },
        h('rect', { key: 'a', x: 3, y: 5, width: 18, height: 6, rx: 1.6 }),
        h('rect', { key: 'b', x: 3, y: 13, width: 18, height: 6, rx: 1.6 }),
        h('path', { key: 'c', d: 'M6.5 8h.01M6.5 16h.01' }),
      )
    }

    /**
     * @param {{variant?: string, size?: string, danger?: boolean, children?: any} & Record<string, any>} props
     */
    function Button({ variant = 'ghost', size = 'md', danger = false, children, ...rest }) {
      const className = [
        'srv-btn',
        size === 'sm' ? 'srv-btn-sm' : '',
        variant === 'primary' ? 'srv-btn-primary' : '',
        variant === 'outline' ? 'srv-btn-outline' : '',
        danger ? 'srv-btn-danger' : '',
      ]
        .filter(Boolean)
        .join(' ')
      return h('button', { type: 'button', className, ...rest }, children)
    }

    /** @param {{on: boolean}} props */
    function StatusDot({ on }) {
      return h('span', { className: 'srv-dot', 'data-on': on ? 'true' : 'false' })
    }

    // --------------------------------------------------------------- hooks --

    /**
     * Load `GET /servers` and keep a reload function.
     * @returns {{state: any, reload: () => Promise<void>}}
     */
    function useServers() {
      const [state, setState] = React.useState({ phase: 'loading' })
      const alive = React.useRef(true)
      React.useEffect(
        () => () => {
          alive.current = false
        },
        [],
      )
      const reload = React.useCallback(async () => {
        try {
          const data = await api('/servers')
          if (alive.current) setState({ phase: 'ready', data })
        } catch (error) {
          if (alive.current) setState({ phase: 'error', error })
        }
      }, [])
      React.useEffect(() => {
        void reload()
      }, [reload])
      return { state, reload }
    }

    // ------------------------------------------------------------- surfaces --

    /**
     * The §8.2 list row.
     * @param {{server: any, t: any, onOpen: (id: string) => void, onEdit: (id: string) => void, onTest: (id: string) => Promise<void>, testing: string|null}} props
     */
    function ServerRow({ server, t, onOpen, onEdit, onTest, testing }) {
      const busy = testing === server.id
      return h(
        'li',
        { className: 'srv-row' },
        h(StatusDot, { on: server.connected === true }),
        h(
          'div',
          { className: 'srv-row-main' },
          h(
            'div',
            { className: 'srv-row-title' },
            h('button', { type: 'button', className: 'srv-open', onClick: () => onOpen(server.id) }, server.name),
          ),
          h(
            'div',
            { className: 'srv-row-meta' },
            h('span', { className: 'srv-mono' }, `${server.username}@${server.host}:${String(server.port)}`),
            server.defaultWorkDir === null
              ? null
              : h('span', { className: 'srv-mono' }, server.defaultWorkDir),
            h(
              'span',
              { className: 'srv-tag', 'data-tone': server.connected === true ? 'success' : undefined },
              server.connected === true ? t('panel.connected') : t('panel.disconnected'),
            ),
            server.hostKeyMode === 'off' ? h('span', { className: 'srv-tag', 'data-tone': 'warn' }, 'host-key off') : null,
          ),
        ),
        h(
          'div',
          { className: 'srv-row-actions' },
          h(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: () => void onTest(server.id) }, busy ? t('panel.testing') : t('panel.test')),
          h(Button, { size: 'sm', onClick: () => onEdit(server.id) }, t('panel.edit')),
        ),
      )
    }

    /**
     * The list view (or the empty state). Owns no data: the panel passes state.
     * @param {{state: any, t: any, reload: () => Promise<void>, onAdd: () => void, onOpen: (id: string) => void, onEdit: (id: string) => void, onTest: (id: string) => Promise<void>, testing: string|null, notice: string|null, onOpenSettings?: () => void}} props
     */
    function ServerList({ state, t, reload, onAdd, onOpen, onEdit, onTest, testing, notice }) {
      const data = state.phase === 'ready' ? state.data : null
      const servers = data === null ? [] : data.servers
      const pendingCount = data === null ? 0 : data.pendingCount
      return h(
        F,
        null,
        h(
          'div',
          { className: 'srv-head' },
          h('h2', null, t('panel.title')),
          pendingCount > 0
            ? h('span', { className: 'srv-badge', title: t('settings.pending') }, String(pendingCount))
            : null,
          h(
            'div',
            { className: 'srv-head-actions' },
            h(Button, { variant: 'primary', onClick: onAdd }, t('panel.add')),
          ),
        ),
        notice === null ? null : h('p', { className: 'srv-note' }, notice),
        state.phase === 'loading' ? h('p', { className: 'srv-empty' }, t('panel.loading')) : null,
        state.phase === 'error'
          ? h(
              'div',
              { className: 'srv-empty' },
              h('p', { className: 'srv-error' }, t('error.load', { message: messageOf(state.error) })),
              h(Button, { variant: 'outline', onClick: () => void reload() }, t('panel.retry')),
            )
          : null,
        state.phase === 'ready' && servers.length === 0
          ? h(
              'div',
              { className: 'srv-empty' },
              h('p', null, t('panel.empty')),
              h('p', null, t('panel.emptyHint')),
            )
          : null,
        servers.length > 0
          ? h(
              'ul',
              { className: 'srv-list' },
              servers.map((/** @type {any} */ server) =>
                h(ServerRow, {
                  key: server.id,
                  server,
                  t,
                  onOpen,
                  onEdit,
                  onTest,
                  testing,
                }),
              ),
            )
          : null,
      )
    }

    /**
     * The detail page: four connection fields read-only, the policy table, the
     * last 20 audit records and [删除] (§8.2).
     * @param {{server: any, rules: any[], t: any, onBack: () => void, onEdit: () => void, onDelete: () => Promise<void>, deleting: boolean, notice: string|null}} props
     */
    function ServerDetail({ server, rules, t, onBack, onEdit, onDelete, deleting, notice }) {
      const [audit, setAudit] = React.useState({ phase: 'loading' })
      React.useEffect(() => {
        let alive = true
        api('/audit', { query: { limit: String(AUDIT_LIMIT), serverId: server.id } })
          .then((data) => {
            if (alive) setAudit({ phase: 'ready', records: data.records })
          })
          .catch((error) => {
            if (alive) setAudit({ phase: 'error', error })
          })
        return () => {
          alive = false
        }
      }, [server.id])

      const authText =
        server.auth.kind === 'key'
          ? `${t('auth.key')} · ${server.auth.privateKeyPath}`
          : server.auth.kind === 'password'
            ? server.passwordConfigured === true
              ? `${t('auth.password')} · ${t('auth.passwordConfigured')}`
              : `${t('auth.password')} · —`
            : t('auth.agent')

      return h(
        F,
        null,
        h(
          'div',
          { className: 'srv-head' },
          h(Button, { size: 'sm', onClick: onBack }, `← ${t('panel.back')}`),
          h('h2', null, server.name),
          h(
            'div',
            { className: 'srv-head-actions' },
            h(Button, { size: 'sm', variant: 'outline', onClick: onEdit }, t('panel.edit')),
          ),
        ),
        notice === null ? null : h('p', { className: 'srv-note' }, notice),
        h(
          'section',
          { className: 'srv-card' },
          h('h3', { className: 'srv-card-title' }, t('panel.sectionConnection')),
          h(
            'dl',
            { className: 'srv-kv' },
            h('dt', null, t('field.name')),
            h('dd', null, server.name),
            h('dt', null, t('field.host')),
            h('dd', { className: 'srv-mono' }, `${server.host}:${String(server.port)}`),
            h('dt', null, t('field.username')),
            h('dd', { className: 'srv-mono' }, server.username),
            h('dt', null, t('field.auth')),
            h('dd', { className: 'srv-mono' }, authText),
            h('dt', null, t('field.hostKeyMode')),
            h('dd', null, server.hostKeyMode),
            h('dt', null, t('field.defaultWorkDir')),
            h('dd', { className: 'srv-mono' }, server.defaultWorkDir === null ? '—' : server.defaultWorkDir),
            h('dt', null, t('field.lastConnectedAt')),
            h(
              'dd',
              null,
              server.lastConnectedAt === null ? t('panel.neverConnected') : t('panel.lastConnected', { time: formatTime(server.lastConnectedAt) }),
            ),
          ),
        ),
        h(
          'section',
          { className: 'srv-card' },
          h('h3', { className: 'srv-card-title' }, t('panel.sectionPolicy')),
          h(
            'ul',
            { className: 'srv-rules' },
            rules.map((/** @type {any} */ rule) => {
              const state = server.policyState?.[rule.id] ?? { configured: null, decision: null, disabled: false }
              return h(
                'li',
                { className: 'srv-rule', key: rule.id },
                h(
                  'div',
                  { className: 'srv-rule-body' },
                  h('span', { className: 'srv-rule-label' }, rule.label),
                  h('span', { className: 'srv-rule-desc' }, rule.description),
                ),
                h(
                  'span',
                  {
                    className: 'srv-tag',
                    'data-tone': state.disabled ? 'warn' : state.decision === 'block' ? undefined : 'success',
                  },
                  state.disabled ? t('form.offOption') : String(state.decision ?? rule.defaultDecision),
                ),
              )
            }),
          ),
        ),
        h(
          'section',
          { className: 'srv-card' },
          h('h3', { className: 'srv-card-title' }, t('panel.sectionAudit')),
          audit.phase === 'loading' ? h('p', { className: 'srv-hint' }, t('panel.auditLoading')) : null,
          audit.phase === 'error'
            ? h('p', { className: 'srv-error' }, t('error.load', { message: messageOf(audit.error) }))
            : null,
          audit.phase === 'ready' && audit.records.length === 0
            ? h('p', { className: 'srv-hint' }, t('panel.auditEmpty'))
            : null,
          audit.phase === 'ready' && audit.records.length > 0
            ? h(
                'ul',
                { className: 'srv-audit' },
                audit.records.map((/** @type {any} */ record, /** @type {number} */ index) =>
                  h(
                    'li',
                    { key: `${String(record.ts)}-${String(index)}` },
                    h('span', { className: 'srv-audit-time' }, formatTime(record.ts)),
                    h('span', { className: 'srv-audit-decision' }, String(record.event ?? record.decision ?? '')),
                    h(
                      'span',
                      { className: 'srv-audit-text', title: String(record.command ?? record.detail ?? '') },
                      String(record.command ?? record.detail ?? ''),
                    ),
                  ),
                ),
              )
            : null,
        ),
        h(
          'div',
          { className: 'srv-danger-zone' },
          h('span', { className: 'srv-hint' }, t('panel.deleteHint')),
          h(Button, { variant: 'outline', danger: true, disabled: deleting, onClick: () => void onDelete() }, deleting ? t('pending.busy') : t('panel.delete')),
        ),
      )
    }

    /**
     * The create/edit form (§8.4). Block rules expose only confirm/block, and
     * "off" is queued rather than applied (§8.3).
     * @param {{server: any|null, rules: any[], hostKeyModes: string[], t: any, onCancel: () => void, onSaved: (message: string|null) => void}} props
     */
    function ServerForm({ server, rules, hostKeyModes, t, onCancel, onSaved }) {
      const editing = server !== null
      const [name, setName] = React.useState(editing ? server.name : '')
      const [host, setHost] = React.useState(editing ? server.host : '')
      const [port, setPort] = React.useState(editing ? String(server.port) : '22')
      const [username, setUsername] = React.useState(editing ? server.username : '')
      const [authKind, setAuthKind] = React.useState(editing ? server.auth.kind : 'key')
      const [privateKeyPath, setPrivateKeyPath] = React.useState(editing && server.auth.kind === 'key' ? server.auth.privateKeyPath : '')
      const [password, setPassword] = React.useState('')
      const [hostKeyMode, setHostKeyMode] = React.useState(editing ? server.hostKeyMode : 'accept-new')
      const [defaultWorkDir, setDefaultWorkDir] = React.useState(editing && server.defaultWorkDir !== null ? server.defaultWorkDir : '')
      const [policy, setPolicy] = React.useState(() => {
        /** @type {Record<string, string>} */
        const initial = {}
        for (const rule of rules) {
          const state = editing ? server.policyState?.[rule.id] : null
          initial[rule.id] = state === undefined || state === null ? rule.defaultDecision : state.disabled ? 'off' : String(state.decision)
        }
        return initial
      })
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(/** @type {string|null} */ (null))
      const [note, setNote] = React.useState(/** @type {string|null} */ (null))

      /** @param {string} ruleId @param {string} value */
      const setRule = (ruleId, value) =>
        setPolicy((/** @type {Record<string, string>} */ current) => ({ ...current, [ruleId]: value }))

      /** Validate one client-side rule before touching the network (§8.4 validations). */
      const validate = () => {
        if (name.trim() === '') return t('form.errorName')
        if (host.trim() === '') return t('form.errorHost')
        if (username.trim() === '') return t('form.errorUsername')
        const parsed = Number(port)
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return t('form.portRange')
        if (authKind === 'key' && privateKeyPath.trim() === '') return t('form.errorKeyPath')
        if (authKind === 'key' && !privateKeyPath.trim().startsWith('/')) return t('form.absolutePath')
        if (authKind === 'password' && !editing && password === '') return t('form.errorPassword')
        if (defaultWorkDir.trim() !== '' && !defaultWorkDir.trim().startsWith('/')) return t('form.absolutePath')
        return null
      }

      /** @param {any} event */
      const submit = async (event) => {
        event.preventDefault()
        const problem = validate()
        if (problem !== null) {
          setError(problem)
          return
        }
        setBusy(true)
        setError(null)
        setNote(null)
        try {
          /** @type {Record<string, unknown>} */
          const body = {
            name: name.trim(),
            host: host.trim(),
            port: Number(port),
            username: username.trim(),
            auth: authKind === 'key' ? { kind: 'key', privateKeyPath: privateKeyPath.trim() } : { kind: authKind },
            hostKeyMode,
            defaultWorkDir: defaultWorkDir.trim() === '' ? null : defaultWorkDir.trim(),
          }
          if (authKind === 'password' && password !== '') body.password = password

          // Only rules that leave their built-in default are stored, so the
          // record stays readable; "off" and re-enabling have their own fields
          // because both change the *existing* rule set.
          /** @type {Record<string, string>} */
          const storedPolicy = {}
          /** @type {string[]} */
          const disableRules = []
          /** @type {string[]} */
          const enableRules = []
          for (const rule of rules) {
            const value = policy[rule.id]
            if (value === undefined) continue
            if (value === 'off') {
              disableRules.push(rule.id)
              continue
            }
            if (value === rule.defaultDecision) continue
            storedPolicy[rule.id] = value
          }
          body.policy = storedPolicy

          if (editing) {
            for (const rule of rules) {
              const value = policy[rule.id]
              const wasDisabled = server.policyState?.[rule.id]?.disabled === true
              if (wasDisabled && value !== undefined && value !== 'off') enableRules.push(rule.id)
            }
            if (disableRules.length > 0) body.disableRules = disableRules
            if (enableRules.length > 0) body.enableRules = enableRules
            const answer = await api(`/servers/${encodeURIComponent(server.id)}`, { method: 'PUT', body })
            if (answer.pending !== undefined && answer.pending.length > 0) {
              setNote(t('form.pendingNote'))
              setBusy(false)
              onSaved(t('form.pendingNote'))
              return
            }
          } else {
            if (disableRules.length > 0) body.disableRules = disableRules
            const answer = await api('/servers', { method: 'POST', body })
            if (answer.pending !== undefined && answer.pending.length > 0) {
              onSaved(t('form.pendingNote'))
              return
            }
          }
          onSaved(null)
        } catch (error) {
          setError(t('error.generic', { message: messageOf(error) }))
        } finally {
          setBusy(false)
        }
      }

      return h(
        'form',
        { className: 'srv-form', onSubmit: submit },
        h('h2', { className: 'srv-card-title' }, editing ? t('form.edit') : t('form.new')),
        h(
          'div',
          { className: 'srv-field' },
          h('label', { htmlFor: 'srv-name' }, t('field.name')),
          h('input', {
            id: 'srv-name',
            className: 'srv-input',
            value: name,
            onChange: (/** @type {any} */ event) => setName(event.target.value),
            required: true,
          }),
        ),
        h(
          'div',
          { className: 'srv-field-row' },
          h(
            'div',
            { className: 'srv-field' },
            h('label', { htmlFor: 'srv-host' }, t('field.host')),
            h('input', {
              id: 'srv-host',
              className: 'srv-input',
              value: host,
              onChange: (/** @type {any} */ event) => setHost(event.target.value),
              required: true,
            }),
          ),
          h(
            'div',
            { className: 'srv-field' },
            h('label', { htmlFor: 'srv-port' }, t('field.port')),
            h('input', {
              id: 'srv-port',
              className: 'srv-input',
              type: 'number',
              min: 1,
              max: 65535,
              value: port,
              onChange: (/** @type {any} */ event) => setPort(event.target.value),
            }),
          ),
        ),
        h(
          'div',
          { className: 'srv-field' },
          h('label', { htmlFor: 'srv-username' }, t('field.username')),
          h('input', {
            id: 'srv-username',
            className: 'srv-input',
            value: username,
            onChange: (/** @type {any} */ event) => setUsername(event.target.value),
            required: true,
          }),
        ),
        h(
          'div',
          { className: 'srv-field' },
          h('span', null, t('field.auth')),
          h(
            'div',
            { className: 'srv-seg', role: 'group', 'aria-label': t('field.auth') },
            ['key', 'password', 'agent'].map((kind) =>
              h(
                'button',
                {
                  key: kind,
                  type: 'button',
                  'aria-pressed': authKind === kind ? 'true' : 'false',
                  onClick: () => setAuthKind(kind),
                },
                t(`auth.${kind}`),
              ),
            ),
          ),
        ),
        authKind === 'key'
          ? h(
              'div',
              { className: 'srv-field' },
              h('label', { htmlFor: 'srv-key' }, t('field.privateKeyPath')),
              h('input', {
                id: 'srv-key',
                className: 'srv-input srv-mono',
                value: privateKeyPath,
                placeholder: '/root/.ssh/id_ed25519',
                onChange: (/** @type {any} */ event) => setPrivateKeyPath(event.target.value),
              }),
            )
          : null,
        authKind === 'password'
          ? h(
              'div',
              { className: 'srv-field' },
              h('label', { htmlFor: 'srv-password' }, t('field.password')),
              h('input', {
                id: 'srv-password',
                className: 'srv-input',
                type: 'password',
                value: password,
                autoComplete: 'new-password',
                placeholder: editing && server.passwordConfigured === true ? t('auth.passwordConfigured') : '',
                onChange: (/** @type {any} */ event) => setPassword(event.target.value),
              }),
              h('span', { className: 'srv-hint' }, editing ? t('form.passwordKeep') : t('form.passwordNew')),
            )
          : null,
        h(
          'div',
          { className: 'srv-field' },
          h('label', { htmlFor: 'srv-hostkey' }, t('field.hostKeyMode')),
          h(
            'select',
            {
              id: 'srv-hostkey',
              className: 'srv-select',
              value: hostKeyMode,
              onChange: (/** @type {any} */ event) => setHostKeyMode(event.target.value),
            },
            hostKeyModes.map((mode) => h('option', { key: mode, value: mode }, t(`hostKey.${mode}`))),
          ),
          hostKeyMode === 'off' && (editing ? server.hostKeyMode !== 'off' : false)
            ? h('span', { className: 'srv-hint' }, t('form.offQueued'))
            : null,
        ),
        h(
          'div',
          { className: 'srv-field' },
          h('label', { htmlFor: 'srv-workdir' }, t('field.defaultWorkDir')),
          h('input', {
            id: 'srv-workdir',
            className: 'srv-input srv-mono',
            value: defaultWorkDir,
            placeholder: '/srv/app',
            onChange: (/** @type {any} */ event) => setDefaultWorkDir(event.target.value),
          }),
        ),
        h(
          'div',
          { className: 'srv-field' },
          h('span', null, t('field.policy')),
          h('p', { className: 'srv-hint' }, t('form.policyHint')),
          h(
            'ul',
            { className: 'srv-rules' },
            rules.map((/** @type {any} */ rule) => {
              const value = policy[rule.id] ?? rule.defaultDecision
              // "停用" is always offered and always queued (§8.3): a new server
              // is created with the rule enabled and a disable request filed.
              const options = [...rule.allowedDecisions, 'off']
              return h(
                'li',
                { className: 'srv-rule', key: rule.id },
                h(
                  'div',
                  { className: 'srv-rule-body' },
                  h('span', { className: 'srv-rule-label' }, rule.label),
                  h('span', { className: 'srv-rule-desc' }, rule.description),
                ),
                h(
                  'select',
                  {
                    className: 'srv-select srv-rule-select',
                    'aria-label': rule.label,
                    value,
                    onChange: (/** @type {any} */ event) => setRule(rule.id, event.target.value),
                  },
                  options.map((decision) =>
                    h('option', { key: decision, value: decision }, decision === 'off' ? t('form.offOption') : decision),
                  ),
                ),
              )
            }),
          ),
        ),
        error === null ? null : h('p', { className: 'srv-error', role: 'alert' }, error),
        note === null ? null : h('p', { className: 'srv-note' }, note),
        h(
          'div',
          { className: 'srv-head-actions' },
          h(Button, { variant: 'primary', type: 'submit', disabled: busy }, busy ? t('form.saving') : t('form.save')),
          h(Button, { onClick: onCancel, disabled: busy }, t('form.cancel')),
        ),
      )
    }

    /**
     * The main panel: list ⇄ detail ⇄ form (§8.2). One server's data lives in
     * the list payload, so a mutation is followed by a reload rather than by
     * patching several copies.
     * @param {{t: any}} props
     */
    function ServerPanel({ t }) {
      const { state, reload } = useServers()
      const [view, setView] = React.useState({ kind: 'list' })
      const [testing, setTesting] = React.useState(/** @type {string|null} */ (null))
      const [deleting, setDeleting] = React.useState(false)
      const [notice, setNotice] = React.useState(/** @type {string|null} */ (null))
      const [status, setStatus] = React.useState(/** @type {string|null} */ (null))

      const data = state.phase === 'ready' ? state.data : null
      const servers = data === null ? [] : data.servers
      const rules = data === null ? [] : data.rules
      const hostKeyModes = data === null ? ['accept-new', 'verify', 'off'] : data.hostKeyModes

      /** @param {string} id */
      const test = async (id) => {
        setTesting(id)
        setNotice(null)
        setStatus(null)
        try {
          const answer = await api('/test', { method: 'POST', body: { id } })
          setStatus(
            t('status.connected', {
              platform: answer.platform,
              shell: answer.shell,
              sudo: answer.sudo,
              ms: answer.durationMs,
            }),
          )
          await reload()
        } catch (error) {
          setStatus(t('error.generic', { message: messageOf(error) }))
        } finally {
          setTesting(null)
        }
      }

      /** @param {string} id */
      const remove = async (id) => {
        setDeleting(true)
        setNotice(null)
        try {
          await api(`/servers/${encodeURIComponent(id)}`, { method: 'DELETE' })
          setNotice(t('panel.deleteQueued'))
          setView({ kind: 'list' })
          await reload()
        } catch (error) {
          setNotice(t('error.generic', { message: messageOf(error) }))
        } finally {
          setDeleting(false)
        }
      }

      /** @param {string|null} message */
      const saved = async (message) => {
        setNotice(message)
        setView({ kind: 'list' })
        await reload()
      }

      const current = view.kind === 'detail' ? servers.find((/** @type {any} */ server) => server.id === view.id) ?? null : null
      const edited = view.kind === 'form' && view.id !== undefined ? servers.find((/** @type {any} */ server) => server.id === view.id) ?? null : null

      return h(
        'div',
        { className: 'srv-page' },
        h(
          'div',
          { className: 'srv-column' },
          view.kind === 'list'
            ? h(ServerList, {
                state,
                t,
                reload,
                onAdd: () => {
                  setNotice(null)
                  setView({ kind: 'form' })
                },
                onOpen: (/** @type {string} */ id) => {
                  setNotice(null)
                  setView({ kind: 'detail', id })
                },
                onEdit: (/** @type {string} */ id) => {
                  setNotice(null)
                  setView({ kind: 'form', id })
                },
                onTest: test,
                testing,
                notice: notice ?? status,
              })
            : null,
          view.kind === 'detail' && current !== null
            ? h(ServerDetail, {
                server: current,
                rules,
                t,
                onBack: () => setView({ kind: 'list' }),
                onEdit: () => setView({ kind: 'form', id: current.id }),
                onDelete: () => remove(current.id),
                deleting,
                notice: status,
              })
            : null,
          view.kind === 'detail' && current === null
            ? h(
                'div',
                { className: 'srv-empty' },
                h('p', null, t('panel.notFound')),
                h(Button, { variant: 'outline', onClick: () => setView({ kind: 'list' }) }, t('panel.back')),
              )
            : null,
          view.kind === 'form'
            ? h(ServerForm, {
                server: edited,
                rules,
                hostKeyModes,
                t,
                onCancel: () => setView({ kind: 'list' }),
                onSaved: saved,
              })
            : null,
        ),
      )
    }

    /**
     * One §8.3 pending row.
     * @param {{record: any, t: any, onConfirm: (id: string) => Promise<void>, onCancel: (id: string) => Promise<void>, busy: string|null}} props
     */
    function PendingRow({ record, t, onConfirm, onCancel, busy }) {
      const working = busy === record.id
      const name = typeof record.serverName === 'string' ? record.serverName : record.serverId
      const title =
        record.kind === 'delete-server'
          ? t('pending.deleteServer', { name })
          : record.kind === 'disable-hostkey'
            ? t('pending.disableHostkey', { name })
            : t('pending.disableRule', { rule: String(record.ruleId ?? '?'), name })
      return h(
        'li',
        null,
        h(
          'div',
          { className: 'srv-pending-main' },
          h('span', { className: 'srv-pending-title' }, title),
          h(
            'span',
            { className: 'srv-pending-meta' },
            `${t('pending.requestedAt', { time: formatTime(record.requestedAt) })} · ${t('pending.expiresAt', {
              time: formatTime(record.expiresAt),
            })}${record.target?.present === false ? ` · ${t('pending.targetMissing')}` : ''}`,
          ),
        ),
        h(
          'div',
          { className: 'srv-row-actions' },
          h(Button, { size: 'sm', variant: 'primary', disabled: working, onClick: () => void onConfirm(record.id) }, working ? t('pending.busy') : t('pending.confirm')),
          h(Button, { size: 'sm', variant: 'outline', disabled: working, onClick: () => void onCancel(record.id) }, t('pending.cancel')),
        ),
      )
    }

    /**
     * The `settings.section` page: global settings (read-only, they come from the
     * profile) and the pending queue with its red count badge (§8.3).
     * @param {{t: any}} props
     */
    function SettingsPage({ t }) {
      const { state, reload } = useServers()
      const [pending, setPending] = React.useState({ phase: 'loading' })
      const [busy, setBusy] = React.useState(/** @type {string|null} */ (null))
      const [error, setError] = React.useState(/** @type {string|null} */ (null))

      const reloadPending = React.useCallback(async () => {
        try {
          const answer = await api('/pending')
          setPending({ phase: 'ready', records: answer.pending })
        } catch (failure) {
          setPending({ phase: 'error', error: failure })
        }
      }, [])

      React.useEffect(() => {
        void reloadPending()
      }, [reloadPending])

      /** @param {'confirm'|'cancel'} action @param {string} id */
      const act = async (action, id) => {
        setBusy(id)
        setError(null)
        try {
          await api(`/pending/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: {} })
          await Promise.all([reloadPending(), reload()])
        } catch (failure) {
          setError(t('error.generic', { message: messageOf(failure) }))
        } finally {
          setBusy(null)
        }
      }

      const records = pending.phase === 'ready' ? pending.records : []
      const config = state.phase === 'ready' ? state.data.config : null
      return h(
        'div',
        { className: 'srv-page' },
        h(
          'div',
          { className: 'srv-column' },
          h('h2', null, t('settings.title')),
          h('p', { className: 'srv-hint' }, t('settings.description')),
          h(
            'section',
            { className: 'srv-card' },
            h(
              'div',
              { className: 'srv-card-head' },
              h('h3', { className: 'srv-card-title' }, t('settings.pending')),
              h('span', { className: 'srv-badge', hidden: records.length === 0 }, String(records.length)),
            ),
            h('p', { className: 'srv-hint' }, t('settings.pendingHint')),
            error === null ? null : h('p', { className: 'srv-error', role: 'alert' }, error),
            records.length === 0 ? h('p', { className: 'srv-hint' }, t('settings.pendingEmpty')) : null,
            records.length > 0
              ? h(
                  'ul',
                  { className: 'srv-pending' },
                  records.map((/** @type {any} */ record) =>
                    h(PendingRow, {
                      key: record.id,
                      record,
                      t,
                      busy,
                      onConfirm: (/** @type {string} */ id) => act('confirm', id),
                      onCancel: (/** @type {string} */ id) => act('cancel', id),
                    }),
                  ),
                )
              : null,
          ),
          h(
            'section',
            { className: 'srv-card' },
            h('h3', { className: 'srv-card-title' }, t('settings.global')),
            h('p', { className: 'srv-hint' }, t('settings.globalHint')),
            config === null
              ? state.phase === 'error'
                ? h('p', { className: 'srv-error' }, t('error.load', { message: messageOf(state.error) }))
                : h('p', { className: 'srv-hint' }, t('panel.loading'))
              : h(
                  'dl',
                  { className: 'srv-kv' },
                  Object.entries(config).map(([key, value]) =>
                    h(F, { key }, h('dt', { className: 'srv-mono' }, key), h('dd', { className: 'srv-mono' }, String(value))),
                  ),
                ),
          ),
        ),
      )
    }

    // ---------------------------------------------------------------- mount --

    /** Services this bundle needs; `slots` carries the three mount points, `locale` the copy. */
    const inject = ['slots', 'locale']

    /**
     * Register the dictionaries and the three §8.1 contributions.
     * @param {any} ctx - the browser plugin context.
     */
    function apply(ctx) {
      installStyles()
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'server-connector: dictionaries')

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 10,
            label: () => ctx.locale.bind(NS)('panel.label'),
            locale: NS,
          },
          ServerIcon,
        ),
      )

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            locale: NS,
            inject: () => ({}),
          },
          ServerPanel,
        ),
      )

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: PANEL_ID,
            order: 25,
            label: () => ctx.locale.bind(NS)('settings.nav'),
            locale: NS,
            inject: () => ({}),
          },
          SettingsPage,
        ),
      )
    }

    exports.NS = NS
    exports.PANEL_ID = PANEL_ID
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
