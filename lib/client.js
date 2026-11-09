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
      'panel.enable': '启用',
      'panel.disable': '禁用',
      'panel.disabled': '已禁用',
      'panel.disconnectFirst': '已连接的服务器不能禁用，请先断开',
      'panel.disabledNote': '已禁用：srv_list 不再返回它，任何 srv_* 调用都会被拒绝。',
      'panel.back': '返回列表',
      'panel.delete': '删除',
      'panel.deleteHint': '删除会先写入待确认区，确认后才真正移除。',
      'panel.deleteQueued': '删除请求已加入待确认区，服务器仍然可用；请到设置页确认。',
      'panel.deleteConfirmTitle': '确认删除这台服务器？',
      'panel.deleteConfirmBody': '删除后它的密码、主机指纹与审计记录一并移除，且无法撤销。服务器在你点击「确认删除」之前仍然可用。',
      'panel.deleteConfirmCheck': '我已确认这台服务器可以删除',
      'panel.deleteConfirm': '确认删除',
      'panel.deleteCancel': '保留服务器',
      'panel.deleteDone': '「{name}」已删除。',
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
      'settings.globalHint': '保存后立即生效，不需要重启插件；正在使用的连接不会被断开。',
      'settings.globalReadonly': '此处显示的是当前生效值，但本会话没能拿到可编辑的配置表单，因此只能查看。',
      'settings.globalLoading': '读取可编辑配置…',
      'settings.save': '保存',
      'settings.saving': '保存中…',
      'settings.discard': '还原',
      'settings.saved': '已保存，新值立即生效。',
      'settings.conflict': '配置已被别处修改，页面已重新读取；请确认后再次保存。',
      'settings.rejected': '保存被拒绝，配置未改变。',
      'settings.dirty': '有未保存的修改。',
      'settings.invalid': '「{field}」的值不合法：必须是不小于下限的整数。',
      'settings.pending': '待确认操作',
      'settings.pendingEmpty': '没有待确认的操作。',
      'settings.pendingHint': '删除服务器、关闭主机密钥校验、停用高危规则都会先进入这里；确认前目标保持原样。',
      'rules.section': '自定义规则',
      'rules.hint': '只作用于这台服务器；默认档只能是 confirm 或 block。保存前请先试跑，确认正则能命中真实命令。',
      'rules.empty': '还没有自定义规则。',
      'rules.add': '新增规则',
      'rules.delete': '删除',
      'rules.label': '标签',
      'rules.pattern': '正则（区分大小写的部分用 (?i) 关闭）',
      'rules.decision': '默认档',
      'rules.description': '说明',
      'rules.samples': '样例命令（每行一条）',
      'rules.samplesHint': '至少一条样例必须能命中，否则规则会因「永不触发」被拒绝。',
      'rules.preview': '试跑',
      'rules.wouldMatch': '是否命中',
      'rules.needSample': '试跑前请至少填一条样例命令。',
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
      'panel.enable': 'Enable',
      'panel.disable': 'Disable',
      'panel.disabled': 'Disabled',
      'panel.disconnectFirst': 'Disconnect this server before disabling it',
      'panel.disabledNote': 'Disabled: srv_list no longer returns it and every srv_* call is rejected.',
      'panel.back': 'Back to list',
      'panel.delete': 'Delete',
      'panel.deleteHint': 'Deleting first queues a request; the server is removed only after you confirm it.',
      'panel.deleteQueued': 'The delete request is queued and the server still works; confirm it in Settings.',
      'panel.deleteConfirmTitle': 'Delete this server?',
      'panel.deleteConfirmBody': 'Its password, host fingerprint and audit trail go with it, and this cannot be undone. The server stays usable until you press “Delete permanently”.',
      'panel.deleteConfirmCheck': 'I understand this server can go',
      'panel.deleteConfirm': 'Delete permanently',
      'panel.deleteCancel': 'Keep the server',
      'panel.deleteDone': '“{name}” was deleted.',
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
      'settings.globalHint': 'Saved values apply immediately; the plugin is not restarted and live connections stay up.',
      'settings.globalReadonly': 'These are the values in effect, but this session could not get an editable settings form, so they are read-only.',
      'settings.globalLoading': 'Reading the editable settings…',
      'settings.save': 'Save',
      'settings.saving': 'Saving…',
      'settings.discard': 'Discard',
      'settings.saved': 'Saved; the new values apply immediately.',
      'settings.conflict': 'The configuration changed elsewhere, so the page re-read it. Check the values and save again.',
      'settings.rejected': 'The save was refused and nothing changed.',
      'settings.dirty': 'Unsaved changes.',
      'settings.invalid': '“{field}” is not valid: it must be an integer no smaller than its minimum.',
      'settings.pending': 'Pending operations',
      'settings.pendingEmpty': 'Nothing is pending.',
      'settings.pendingHint': 'Deleting a server, switching host-key verification off and disabling a high-risk rule all wait here; the target stays as it is until you confirm.',
      'rules.section': 'Custom rules',
      'rules.hint': 'These apply to this server only; the default decision may be confirm or block. Run a preview before saving so you know the pattern matches a real command.',
      'rules.empty': 'No custom rules yet.',
      'rules.add': 'Add rule',
      'rules.delete': 'Delete',
      'rules.label': 'Label',
      'rules.pattern': 'Pattern (regular expression)',
      'rules.decision': 'Default decision',
      'rules.description': 'Description',
      'rules.samples': 'Sample commands (one per line)',
      'rules.samplesHint': 'At least one sample must match, otherwise the rule is rejected as one that never fires.',
      'rules.preview': 'Preview',
      'rules.wouldMatch': 'Matches',
      'rules.needSample': 'Add at least one sample command before previewing.',
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
      // A destructive *primary* button: the plain danger variant only recolours
      // the text, which would be red-on-black once the primary fill applies.
      '.srv-btn-primary.srv-btn-danger{background:var(--dsw-alias-state-error-primary);',
      'color:var(--dsw-static-neutral-bluish-00)}',
      '.srv-btn-primary.srv-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 86%,var(--dsw-alias-label-primary))}',
      '.srv-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}',
      '.srv-row{display:flex;align-items:flex-start;gap:4px 12px;flex-wrap:wrap;padding:10px 8px;border-radius:12px;min-width:0}',
      '.srv-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.srv-row-off{opacity:.55}',
      // Mirrors the Host's own switch (ui-primitives), which inverts with the
      // theme rather than staying monochrome:
      //
      //              track                                 thumb
      //   light on   --dsw-alias-label-primary (#0f1115)   --dsw-alias-label-primary-inverted (#fff)
      //   dark  on   --dsw-alias-label-primary (#f9fafb)   --dsw-alias-label-primary-inverted (#353638)
      //
      // The thumb MUST use the inverted pair, not a fixed white: a hard-coded
      // `#fff` disappears against the near-white track in dark mode, which reads
      // as one blank bar. `label-primary` / `label-primary-inverted` are the only
      // pair guaranteed to contrast in both themes.
      '.srv-switch{position:relative;flex:0 0 auto;width:36px;height:20px;padding:0;border:none;border-radius:999px;',
      'background:var(--dsw-alias-border-l4,rgba(0,0,0,.12));cursor:pointer;transition:background .15s ease}',
      '.srv-switch[data-on="true"]{background:var(--dsw-alias-label-primary,#0f1115)}',
      '.srv-switch:disabled{cursor:not-allowed;opacity:.5}',
      '.srv-switch:focus-visible{outline:2px solid var(--dsw-alias-label-primary,#0f1115);outline-offset:2px}',
      '.srv-switch-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;',
      'background:var(--dsw-alias-label-tertiary,#adb2b8);transition:transform .15s ease,background .15s ease}',
      '.srv-switch[data-on="true"] .srv-switch-knob{transform:translateX(16px);',
      'background:var(--dsw-alias-label-primary-inverted,#fff)}',
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
      '.srv-input[rows]{height:auto;padding:6px 8px;resize:vertical}',
      '.srv-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
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
      '.srv-cfg-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px 16px}',
      '.srv-check{display:flex;align-items:center;gap:8px;font-size:13px;line-height:20px;cursor:pointer}',
      '.srv-check input{width:15px;height:15px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}',
      '.srv-danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,var(--dsw-alias-border-l3))}',
      '.srv-danger-title{margin:0;font-size:14px;line-height:22px;font-weight:600;',
      'color:var(--dsw-alias-state-error-primary)}',
      '.srv-danger-kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 16px;margin:0;font-size:13px;line-height:20px}',
      '.srv-danger-kv dt{color:var(--dsw-alias-label-tertiary)}',
      '.srv-danger-kv dd{margin:0;min-width:0;overflow-wrap:anywhere}',
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

    // ----------------------------------------------------- global settings --

    /**
     * The row id this bundle's Host half is mounted as (see `cordis.patch.yml`).
     * `configForms.get()` addresses a Host configuration entry by that row id —
     * not by the package name — and `describe()` reports the namespace as
     * `entry.options.id`.
     */
    const CONFIG_ROW_ID = 'dsh-server-connector'

    /**
     * One field of the §10 global configuration, in the order the page shows it.
     *
     * `kind` decides the control and the client-side validation; the Host
     * validates against the real schema as well, so this table is about the UI,
     * never about authority. It has to stay in step with `Config` in
     * `lib/index.js` — `tests/client.test.ts` compares the two.
     */
    const CONFIG_FIELDS = [
      { key: 'connectTimeoutMs', kind: 'number', min: 1000 },
      { key: 'commandTimeoutMs', kind: 'number', min: 1000 },
      { key: 'syncTimeoutMs', kind: 'number', min: 1000 },
      { key: 'maxOutputChars', kind: 'number', min: 1024 },
      { key: 'idleTimeoutMs', kind: 'number', min: 1000 },
      { key: 'auditEnabled', kind: 'boolean' },
      { key: 'auditMaxBytes', kind: 'number', min: 0 },
      { key: 'pendingTtlHours', kind: 'number', min: 1 },
      { key: 'maxListedServers', kind: 'number', min: 1 },
    ]

    /**
     * Bind the Host's editable configuration form for this plugin's row.
     *
     * `configForms` is an optional client service, and the row only appears in it
     * when the Host projects the schema — which happens because every key of
     * `Config` is `.volatile()`. Both facts are runtime conditions, so every read
     * here is tolerant: a missing service, an unserved row and a scope that
     * throws all degrade to "read-only", never to an exception inside a render.
     *
     * The controller is created once per mount and handed to the page through
     * the slot's `inject` callback, exactly as the shipped panels do it.
     */
    function createConfigModel() {
      let service = false
      /** @type {any} */
      let scope = null
      /** @type {(() => void)|null} */
      let unsubscribe = null
      /** @type {Set<() => void>} */
      const listeners = new Set()

      const publish = () => {
        // Copy first: a listener may unsubscribe itself while being notified.
        for (const listener of Array.from(listeners)) {
          try {
            listener()
          } catch (error) {
            console.error('dsh-server-connector: a settings listener failed', error)
          }
        }
      }

      /**
       * The current snapshot, or a shape that reads as "loading" / "unavailable".
       * @returns {any}
       */
      const read = () => {
        if (scope === null || typeof scope.getSnapshot !== 'function') return { status: 'loading' }
        try {
          const snapshot = scope.getSnapshot()
          return snapshot !== null && typeof snapshot === 'object' ? snapshot : { status: 'unavailable' }
        } catch (error) {
          console.error('dsh-server-connector: reading the settings scope failed', error)
          return { status: 'unavailable' }
        }
      }

      return {
        /** Whether the page can save at all (the service exists and the row is served). */
        canWrite: () => read().writable === true && scope !== null && typeof scope.mutate === 'function',
        /** True once the client settings service was seen, even before the row is served. */
        hasService: () => service,
        noteService: () => {
          service = true
          publish()
        },
        /** @param {any} next */
        attach: (next) => {
          if (next === null || next === undefined) return
          service = true
          scope = next
          if (typeof scope.subscribe === 'function') {
            try {
              unsubscribe = scope.subscribe(publish)
            } catch (error) {
              console.error('dsh-server-connector: subscribing to the settings scope failed', error)
            }
          }
          publish()
        },
        detach: () => {
          if (typeof unsubscribe === 'function') {
            try {
              unsubscribe()
            } catch (error) {
              console.error('dsh-server-connector: releasing the settings scope failed', error)
            }
          }
          unsubscribe = null
        },
        read,
        /** @param {() => void} listener */
        subscribe: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        /**
         * Submit one revision-fenced batch of field writes.
         *
         * The revision is what keeps two windows from silently overwriting each
         * other: the Host refuses a batch composed against a value somebody else
         * already replaced, and this reports that refusal instead of pretending
         * the save landed.
         * @param {Array<{op: string, path: string[], value?: unknown}>} ops
         * @returns {Promise<boolean>}
         */
        write: async (ops) => {
          const snapshot = read()
          if (scope === null || typeof scope.mutate !== 'function') return false
          if (snapshot.writable !== true) return false
          if (!Array.isArray(ops) || ops.length === 0) return true
          try {
            return Boolean(await scope.mutate(ops, snapshot.revision))
          } catch (error) {
            console.error('dsh-server-connector: writing the configuration failed', error)
            return false
          }
        },
      }
    }

    /**
     * Ask `configForms` for our row and keep the scope for the fiber's lifetime.
     *
     * `whileServed` is the platform's own gate: a form fetched before the
     * `describe()` round trip settles is born with its persistence fixed to "not
     * host" and never upgrades, so the row is awaited instead of requested
     * eagerly.
     * @param {any} ctx - the client plugin context.
     * @param {ReturnType<typeof createConfigModel>} model
     * @returns {void}
     */
    function bindConfigModel(ctx, model) {
      try {
        if (typeof ctx.inject !== 'function') return
        ctx.inject(['configForms'], (/** @type {any} */ inner) => {
          const configForms = inner.configForms
          if (configForms === null || configForms === undefined) return
          model.noteService()
          const attach = () => {
            try {
              model.attach(configForms.get(CONFIG_ROW_ID))
            } catch (error) {
              console.error('dsh-server-connector: the settings row could not be opened', error)
            }
          }
          let stop = () => model.detach()
          try {
            if (typeof configForms.whileServed === 'function') {
              stop = configForms.whileServed([CONFIG_ROW_ID], () => {
                attach()
                return () => model.detach()
              })
            } else {
              attach()
              stop = () => model.detach()
            }
          } catch (error) {
            console.error('dsh-server-connector: this DSH serves no settings row for this plugin', error)
            return
          }
          if (typeof inner.effect === 'function') {
            inner.effect(() => stop, 'server-connector: settings scope')
          }
        })
      } catch (error) {
        console.error('dsh-server-connector: asking for the settings service failed', error)
      }
    }

    /**
     * A model that is never bound to a Host scope. Rendering the settings page
     * outside the `inject` path (a test, or a Host that mounts a section without
     * running the inject callback) then reads as "no editable form" and shows the
     * read-only card instead of throwing.
     */
    const DETACHED_CONFIG_MODEL = createConfigModel()

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
     * @param {{server: any, t: any, onOpen: (id: string) => void, onEdit: (id: string) => void, onTest: (id: string) => Promise<void>, onToggle: (server: any) => Promise<void>, testing: string|null, toggling: string|null}} props
     */
    function ServerRow({ server, t, onOpen, onEdit, onTest, onToggle, testing, toggling }) {
      const busy = testing === server.id
      const off = server.enabled === false
      const toggleBusy = toggling === server.id
      return h(
        'li',
        { className: off ? 'srv-row srv-row-off' : 'srv-row' },
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
            off ? h('span', { className: 'srv-tag', 'data-tone': 'warn' }, t('panel.disabled')) : null,
          ),
        ),
        h(
          'div',
          { className: 'srv-row-actions' },
          // The switch is the only control the panel needs for the enable state:
          // it applies immediately (no pending queue), so it reads as a switch.
          h(Switch, {
            checked: !off,
            disabled: toggleBusy || server.connected === true,
            label: off ? t('panel.enable') : t('panel.disable'),
            hint: server.connected === true ? t('panel.disconnectFirst') : null,
            onChange: () => void onToggle(server),
          }),
          h(Button, { size: 'sm', variant: 'outline', disabled: busy || off, onClick: () => void onTest(server.id) }, busy ? t('panel.testing') : t('panel.test')),
          h(Button, { size: 'sm', onClick: () => onEdit(server.id) }, t('panel.edit')),
        ),
      )
    }

    /**
     * A minimal on/off switch. The panel has no design-system switch in the
     * injected surface, so this is the smallest one that reads as a switch and
     * stays usable when disabled.
     * @param {{checked: boolean, disabled?: boolean, label: string, hint?: string|null, onChange: () => void}} props
     */
    function Switch({ checked, disabled = false, label, hint = null, onChange }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          'aria-label': label,
          title: hint ?? label,
          className: 'srv-switch',
          'data-on': checked ? 'true' : 'false',
          disabled,
          onClick: () => onChange(),
        },
        h('span', { className: 'srv-switch-knob', 'aria-hidden': 'true' }),
      )
    }

    /**
     * The list view (or the empty state). Owns no data: the panel passes state.
     * @param {{state: any, t: any, reload: () => Promise<void>, onAdd: () => void, onOpen: (id: string) => void, onEdit: (id: string) => void, onTest: (id: string) => Promise<void>, onToggle: (server: any) => Promise<void>, testing: string|null, toggling: string|null, notice: string|null, onOpenSettings?: () => void}} props
     */
    function ServerList({ state, t, reload, onAdd, onOpen, onEdit, onTest, onToggle, testing, toggling, notice }) {
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
                  onToggle,
                  testing,
                  toggling,
                }),
              ),
            )
          : null,
      )
    }

    /**
     * Custom rules for one server (doc §4.4).
     *
     * The section owns its own draft state: a rule is only sent to the Host after
     * the operator has seen a dry run of it against a sample command, which is
     * the one guard that catches "the regex never fires".
     * @param {{server: any, t: any, onRefresh: () => Promise<void>}} props
     */
    function CustomRulesSection({ server, t, onRefresh }) {
      const rules = Array.isArray(server.customRules) ? server.customRules : []
      const [draft, setDraft] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [preview, setPreview] = React.useState(null)

      const startAdd = () =>
        setDraft({ label: '', pattern: '', defaultDecision: 'confirm', description: '', samples: '' })
      const cancel = () => {
        setDraft(null)
        setPreview(null)
        setError(null)
      }

      /** @param {any} event */
      const dryRun = async (event) => {
        event.preventDefault()
        if (draft === null) return
        setBusy(true)
        setError(null)
        try {
          const samples = String(draft.samples ?? '')
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '')
          if (samples.length === 0) throw new Error(t('rules.needSample'))
          const data = await api(`/servers/${encodeURIComponent(server.id)}/rules/preview`, {
            method: 'POST',
            body: {
              label: draft.label === '' ? 'preview' : draft.label,
              pattern: draft.pattern,
              defaultDecision: draft.defaultDecision,
              samples,
            },
          })
          setPreview(data)
        } catch (failure) {
          setPreview(null)
          setError(messageOf(failure))
        } finally {
          setBusy(false)
        }
      }

      /** @param {any} event */
      const save = async (event) => {
        event.preventDefault()
        if (draft === null) return
        setBusy(true)
        setError(null)
        try {
          const samples = String(draft.samples ?? '')
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '')
          await api(`/servers/${encodeURIComponent(server.id)}/rules`, {
            method: 'POST',
            body: {
              label: draft.label,
              pattern: draft.pattern,
              defaultDecision: draft.defaultDecision,
              description: draft.description,
              samples,
            },
          })
          setDraft(null)
          setPreview(null)
          await onRefresh()
        } catch (failure) {
          setError(messageOf(failure))
        } finally {
          setBusy(false)
        }
      }

      /** @param {string} ruleId */
      const remove = async (ruleId) => {
        setBusy(true)
        setError(null)
        try {
          await api(`/servers/${encodeURIComponent(server.id)}/rules/${encodeURIComponent(ruleId)}`, {
            method: 'DELETE',
          })
          await onRefresh()
        } catch (failure) {
          setError(messageOf(failure))
        } finally {
          setBusy(false)
        }
      }

      return h(
        'section',
        { className: 'srv-card' },
        h('h3', { className: 'srv-card-title' }, t('rules.section')),
        h('p', { className: 'srv-hint' }, t('rules.hint')),
        rules.length === 0 ? h('p', { className: 'srv-hint' }, t('rules.empty')) : null,
        rules.length > 0
          ? h(
              'ul',
              { className: 'srv-rules' },
              rules.map((/** @type {any} */ rule) =>
                h(
                  'li',
                  { className: 'srv-rule', key: rule.id },
                  h(
                    'div',
                    { className: 'srv-rule-body' },
                    h('span', { className: 'srv-rule-label' }, rule.label),
                    h('span', { className: 'srv-rule-desc' }, rule.description || rule.pattern),
                  ),
                  h('span', { className: 'srv-tag', 'data-tone': rule.defaultDecision === 'block' ? undefined : 'success' }, rule.defaultDecision),
                  h(
                    Button,
                    { size: 'sm', danger: true, disabled: busy, onClick: () => void remove(rule.id) },
                    t('rules.delete'),
                  ),
                ),
              ),
            )
          : null,
        error !== null ? h('p', { className: 'srv-error' }, error) : null,
        draft === null
          ? h(Button, { variant: 'outline', disabled: busy, onClick: startAdd }, t('rules.add'))
          : h(
              'form',
              { className: 'srv-form', onSubmit: save },
              h(
                'div',
                { className: 'srv-field' },
                h('label', { htmlFor: 'srv-rule-label' }, t('rules.label')),
                h('input', {
                  id: 'srv-rule-label',
                  className: 'srv-input',
                  value: draft.label,
                  onChange: (/** @type {any} */ event) => setDraft({ ...draft, label: event.target.value }),
                }),
              ),
              h(
                'div',
                { className: 'srv-field' },
                h('label', { htmlFor: 'srv-rule-pattern' }, t('rules.pattern')),
                h('input', {
                  id: 'srv-rule-pattern',
                  className: 'srv-input srv-mono',
                  value: draft.pattern,
                  onChange: (/** @type {any} */ event) => setDraft({ ...draft, pattern: event.target.value }),
                }),
              ),
              h(
                'div',
                { className: 'srv-field' },
                h('label', { htmlFor: 'srv-rule-decision' }, t('rules.decision')),
                h(
                  'select',
                  {
                    id: 'srv-rule-decision',
                    className: 'srv-select',
                    value: draft.defaultDecision,
                    onChange: (/** @type {any} */ event) => setDraft({ ...draft, defaultDecision: event.target.value }),
                  },
                  h('option', { value: 'confirm' }, 'confirm'),
                  h('option', { value: 'block' }, 'block'),
                ),
              ),
              h(
                'div',
                { className: 'srv-field' },
                h('label', { htmlFor: 'srv-rule-desc' }, t('rules.description')),
                h('input', {
                  id: 'srv-rule-desc',
                  className: 'srv-input',
                  value: draft.description,
                  onChange: (/** @type {any} */ event) => setDraft({ ...draft, description: event.target.value }),
                }),
              ),
              h(
                'div',
                { className: 'srv-field' },
                h('label', { htmlFor: 'srv-rule-samples' }, t('rules.samples')),
                h('textarea', {
                  id: 'srv-rule-samples',
                  className: 'srv-input srv-mono',
                  rows: 3,
                  value: draft.samples,
                  onChange: (/** @type {any} */ event) => setDraft({ ...draft, samples: event.target.value }),
                }),
                h('span', { className: 'srv-hint' }, t('rules.samplesHint')),
              ),
              preview !== null
                ? h(
                    'ul',
                    { className: 'srv-rules' },
                    (preview.results ?? []).map((/** @type {any} */ item, /** @type {number} */ index) =>
                      h(
                        'li',
                        { className: 'srv-rule', key: index },
                        h(
                          'div',
                          { className: 'srv-rule-body' },
                          h('span', { className: 'srv-rule-label srv-mono' }, item.sample),
                          h('span', { className: 'srv-rule-desc' }, `${t('rules.wouldMatch')}: ${item.matched ? 'yes' : 'no'} · ${String(item.decision)}`),
                        ),
                      ),
                    ),
                  )
                : null,
              h(
                'div',
                { className: 'srv-actions' },
                h(Button, { type: 'button', disabled: busy, onClick: dryRun }, t('rules.preview')),
                h(Button, { variant: 'primary', type: 'submit', disabled: busy }, busy ? t('form.saving') : t('form.save')),
                h(Button, { type: 'button', disabled: busy, onClick: cancel }, t('form.cancel')),
              ),
            ),
      )
    }

    /**
     * The detail page: four connection fields read-only, the policy table, the
     * last 20 audit records and the delete flow (§8.2).
     *
     * Deleting is a two-step decision, but both steps happen here: the button
     * opens an in-page confirmation that names the target and its consequences
     * and stays disabled until a checkbox is ticked, and only that confirmation
     * touches the network (queue, then confirm). Nothing dangerous happens on one
     * click, and the operator no longer has to change panels to finish the job.
     * @param {{server: any, rules: any[], t: any, onBack: () => void, onEdit: () => void, onDelete: () => Promise<void>, deleting: boolean, notice: string|null, onRefresh: () => Promise<void>}} props
     */
    function ServerDetail({ server, rules, t, onBack, onEdit, onDelete, deleting, notice, onRefresh }) {
      const [audit, setAudit] = React.useState({ phase: 'loading' })
      const [confirming, setConfirming] = React.useState(false)
      const [acknowledged, setAcknowledged] = React.useState(false)
      // Leaving this server (or returning to it) must not keep a half-confirmed
      // deletion alive: the gate belongs to the server that was on screen.
      React.useEffect(() => {
        setConfirming(false)
        setAcknowledged(false)
      }, [server.id])
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
        h(CustomRulesSection, { server, t, onRefresh }),
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
          { className: confirming ? 'srv-danger-zone srv-danger' : 'srv-danger-zone' },
          h('span', { className: 'srv-hint' }, t('panel.deleteHint')),
          confirming
            ? null
            : h(
                Button,
                {
                  variant: 'outline',
                  danger: true,
                  disabled: deleting,
                  onClick: () => {
                    setAcknowledged(false)
                    setConfirming(true)
                  },
                },
                deleting ? t('pending.busy') : t('panel.delete'),
              ),
        ),
        confirming
          ? h(
              'section',
              { className: 'srv-card srv-danger', role: 'alertdialog', 'aria-label': t('panel.deleteConfirmTitle') },
              h('h3', { className: 'srv-danger-title' }, t('panel.deleteConfirmTitle')),
              h(
                'dl',
                { className: 'srv-danger-kv' },
                h('dt', null, t('field.name')),
                h('dd', null, server.name),
                h('dt', null, t('field.host')),
                h('dd', { className: 'srv-mono' }, `${server.username}@${server.host}:${String(server.port)}`),
              ),
              h('p', { className: 'srv-hint' }, t('panel.deleteConfirmBody')),
              h(
                'label',
                { className: 'srv-check' },
                h('input', {
                  type: 'checkbox',
                  checked: acknowledged,
                  disabled: deleting,
                  onChange: (/** @type {any} */ event) => setAcknowledged(event.target.checked),
                }),
                h('span', { className: 'srv-hint' }, t('panel.deleteConfirmCheck')),
              ),
              h(
                'div',
                { className: 'srv-actions' },
                h(
                  Button,
                  {
                    variant: 'primary',
                    danger: true,
                    disabled: deleting || !acknowledged,
                    onClick: () => void onDelete(),
                  },
                  deleting ? t('pending.busy') : t('panel.deleteConfirm'),
                ),
                h(
                  Button,
                  {
                    variant: 'outline',
                    disabled: deleting,
                    onClick: () => {
                      setConfirming(false)
                      setAcknowledged(false)
                    },
                  },
                  t('panel.deleteCancel'),
                ),
              ),
            )
          : null,
      )
    }

    /**
     * Whether a path is absolute on *this* machine.
     *
     * `auth.privateKeyPath` names a local file the Host reads, so on Windows a
     * drive-letter (`C:\Users\me\.ssh\id_ed25519`) or UNC (`\\server\share\key`)
     * path is absolute. The panel used to demand a leading `/` here, which made
     * key auth impossible to submit on Windows.
     * @param {string} path
     * @returns {boolean}
     */
    function isLocalAbsolutePath(path) {
      if (path.startsWith('/')) return true
      if (/^[A-Za-z]:[\\/]/.test(path)) return true
      return path.startsWith('\\\\')
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
        // The key file lives on *this* machine, so a Windows drive-letter or UNC
        // path is as absolute as a POSIX one (the Host accepts both).
        if (authKind === 'key' && !isLocalAbsolutePath(privateKeyPath.trim())) return t('form.absolutePath')
        if (authKind === 'password' && !editing && password === '') return t('form.errorPassword')
        // The working directory is on the *remote* host: POSIX only.
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
      const [toggling, setToggling] = React.useState(/** @type {string|null} */ (null))
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

      /**
       * Delete one server from the detail page, in place and in one flow.
       *
       * The safety model is unchanged: `DELETE` only ever *queues*, and the
       * removal happens on `POST /pending/:id/confirm`. What changed is where the
       * operator confirms — the detail page now shows the queued request with its
       * target and consequences, so confirming no longer means switching to the
       * settings page and finding the row again. The settings queue stays as the
       * second door, which is what makes a forgotten request visible later.
       * @param {any} server
       */
      const remove = async (server) => {
        setDeleting(true)
        setNotice(null)
        try {
          const queued = await api(`/servers/${encodeURIComponent(server.id)}`, { method: 'DELETE' })
          const id = queued?.pending?.id
          if (typeof id !== 'string' || id === '') {
            setNotice(t('panel.deleteQueued'))
            setView({ kind: 'list' })
            await reload()
            return
          }
          await api(`/pending/${encodeURIComponent(id)}/confirm`, { method: 'POST', body: {} })
          setNotice(t('panel.deleteDone', { name: server.name }))
          setView({ kind: 'list' })
          await reload()
        } catch (error) {
          // The queue step and the confirm step fail differently, and the server
          // may be gone already if the confirm half applied before the read
          // failed — so reload rather than guess which state we are in.
          setNotice(t('error.generic', { message: messageOf(error) }))
          await reload()
        } finally {
          setDeleting(false)
        }
      }

      /**
       * Flip the enable switch. It applies immediately — no pending queue — so
       * the only failure modes are "connected" (409) and a network error.
       * @param {any} server
       */
      const toggle = async (server) => {
        setToggling(server.id)
        setNotice(null)
        try {
          await api(`/servers/${encodeURIComponent(server.id)}`, {
            method: 'PUT',
            body: { enabled: server.enabled === false },
          })
          await reload()
        } catch (error) {
          setNotice(t('error.generic', { message: messageOf(error) }))
        } finally {
          setToggling(null)
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
                onToggle: toggle,
                testing,
                toggling,
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
                onDelete: () => remove(current),
                deleting,
                notice: status,
                onRefresh: reload,
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
     * One §10 field, rendered from {@link CONFIG_FIELDS}.
     *
     * A number field keeps its raw text in the draft so the operator can clear it
     * and retype without the value snapping back mid-edit; validation happens on
     * save, not on every keystroke.
     * @param {{field: any, value: unknown, disabled: boolean, onChange: (value: unknown) => void}} props
     */
    function ConfigField({ field, value, disabled, onChange }) {
      const id = `srv-cfg-${field.key}`
      if (field.kind === 'boolean') {
        return h(
          'div',
          { className: 'srv-field' },
          h(
            'label',
            { className: 'srv-check' },
            h('input', {
              id,
              type: 'checkbox',
              checked: value === true,
              disabled,
              onChange: (/** @type {any} */ event) => onChange(event.target.checked),
            }),
            h('span', { className: 'srv-mono' }, field.key),
          ),
        )
      }
      return h(
        'div',
        { className: 'srv-field' },
        h('label', { htmlFor: id, className: 'srv-mono' }, field.key),
        h('input', {
          id,
          className: 'srv-input',
          type: 'number',
          min: field.min,
          step: 1,
          value: value === undefined || value === null ? '' : String(value),
          disabled,
          onChange: (/** @type {any} */ event) => onChange(event.target.value),
        }),
      )
    }

    /**
     * Validate one staged value against the field's own rule.
     * @param {any} field
     * @param {unknown} value
     * @returns {number|boolean|null} the value to save, or null when invalid
     */
    function coerceConfigValue(field, value) {
      if (field.kind === 'boolean') return value === true
      const text = String(value ?? '').trim()
      if (text === '') return null
      const parsed = Number(text)
      if (!Number.isInteger(parsed) || parsed < field.min) return null
      return parsed
    }

    /**
     * The global-settings card: the nine §10 values, editable and saved live.
     *
     * Two shapes, chosen at runtime rather than at build time:
     *
     *   - `ready` — the Host projected this row into a settings form, so the
     *     values are staged locally and written back as one revision-fenced
     *     batch. The save applies immediately (the Host writes the volatile
     *     cells in place), which is why the copy says so.
     *   - anything else — the form could not be obtained (an older Host without
     *     `configForms`, or a row this deployment does not serve). The card then
     *     renders the values the Host reports through `GET /servers` and says
     *     plainly that they are read-only, instead of showing a dead input.
     * @param {{t: any, model: any, fallback: Record<string, unknown>|null}} props
     */
    function GlobalSettings({ t, model, fallback }) {
      const [snapshot, setSnapshot] = React.useState(() => model.read())
      const [draft, setDraft] = React.useState(/** @type {Record<string, unknown>} */ ({}))
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(/** @type {string|null} */ (null))
      const [note, setNote] = React.useState(/** @type {string|null} */ (null))

      React.useEffect(() => {
        const off = model.subscribe(() => setSnapshot(model.read()))
        setSnapshot(model.read())
        return off
      }, [model])

      // A new Host revision discards staged edits: keeping them would let a stale
      // draft overwrite a value somebody else just wrote.
      const revision = snapshot.revision
      const ready = snapshot.status === 'ready' && typeof snapshot.value === 'object' && snapshot.value !== null
      const values = ready ? /** @type {Record<string, unknown>} */ (snapshot.value) : {}
      React.useEffect(() => {
        setDraft({})
        setError(null)
      }, [revision])

      const dirty = Object.keys(draft).length > 0
      const current = (/** @type {any} */ field) => (Object.hasOwn(draft, field.key) ? draft[field.key] : values[field.key])

      /** @param {string} key @param {unknown} value */
      const stage = (key, value) => {
        setNote(null)
        setError(null)
        setDraft((/** @type {Record<string, unknown>} */ now) => ({ ...now, [key]: value }))
      }

      const save = async () => {
        /** @type {Array<{op: string, path: string[], value?: unknown}>} */
        const ops = []
        for (const field of CONFIG_FIELDS) {
          if (!Object.hasOwn(draft, field.key)) continue
          const value = coerceConfigValue(field, draft[field.key])
          if (value === null) {
            setError(t('settings.invalid', { field: field.key }))
            return
          }
          if (value === values[field.key]) continue
          ops.push({ op: 'set', path: [field.key], value })
        }
        if (ops.length === 0) {
          setDraft({})
          return
        }
        setBusy(true)
        setError(null)
        setNote(null)
        try {
          const landed = await model.write(ops)
          if (landed) {
            setDraft({})
            setNote(t('settings.saved'))
          } else {
            // The Host refused: either the row is not writable or the revision
            // moved under us. The scope re-reads on its own, so the page follows.
            setError(t(snapshot.writable === true ? 'settings.conflict' : 'settings.rejected'))
          }
        } finally {
          setBusy(false)
          setSnapshot(model.read())
        }
      }

      const header = h(
        'div',
        { className: 'srv-card-head' },
        h('h3', { className: 'srv-card-title' }, t('settings.global')),
        dirty ? h('span', { className: 'srv-tag', 'data-tone': 'warn' }, t('settings.dirty')) : null,
      )

      if (!ready) {
        const readOnly = snapshot.status === 'unavailable' || model.hasService() === false
        return h(
          'section',
          { className: 'srv-card' },
          header,
          h('p', { className: 'srv-hint' }, readOnly ? t('settings.globalReadonly') : t('settings.globalLoading')),
          readOnly && fallback !== null
            ? h(
                'dl',
                { className: 'srv-kv' },
                CONFIG_FIELDS.map((/** @type {any} */ field) =>
                  h(
                    F,
                    { key: field.key },
                    h('dt', { className: 'srv-mono' }, field.key),
                    h('dd', { className: 'srv-mono' }, String(fallback[field.key] ?? '—')),
                  ),
                ),
              )
            : null,
        )
      }

      const locked = snapshot.writable !== true || busy
      return h(
        'section',
        { className: 'srv-card' },
        header,
        h('p', { className: 'srv-hint' }, t('settings.globalHint')),
        h(
          'div',
          { className: 'srv-cfg-grid' },
          CONFIG_FIELDS.map((/** @type {any} */ field) =>
            h(ConfigField, {
              key: field.key,
              field,
              value: current(field),
              disabled: locked,
              onChange: (/** @type {unknown} */ value) => stage(field.key, value),
            }),
          ),
        ),
        error === null ? null : h('p', { className: 'srv-error', role: 'alert' }, error),
        note === null ? null : h('p', { className: 'srv-note' }, note),
        h(
          'div',
          { className: 'srv-actions' },
          h(
            Button,
            { variant: 'primary', disabled: locked || !dirty, onClick: () => void save() },
            busy ? t('settings.saving') : t('settings.save'),
          ),
          h(
            Button,
            {
              variant: 'outline',
              disabled: locked || !dirty,
              onClick: () => {
                setDraft({})
                setError(null)
                setNote(null)
              },
            },
            t('settings.discard'),
          ),
        ),
      )
    }

    /**
     * The `settings.section` page: the global settings (now editable) and the
     * pending queue with its red count badge (§8.3).
     *
     * `model` arrives from the slot's `inject` callback. A render outside that
     * path (a test, or a Host that mounts the section without running `inject`)
     * falls back to a detached model, which reads as "unavailable" and shows the
     * read-only view rather than throwing inside the page.
     * @param {{t: any, model?: any}} props
     */
    function SettingsPage({ t, model }) {
      const settingsModel = model === undefined || model === null ? DETACHED_CONFIG_MODEL : model
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
          h(GlobalSettings, { t, model: settingsModel, fallback: config }),
        ),
      )
    }

    // ---------------------------------------------------------------- mount --

    /** Services this bundle needs; `slots` carries the three mount points, `locale` the copy. */
    const inject = ['slots', 'locale']

    /**
     * Register one mount point, tolerating three separate failure modes.
     *
     * 1. **The seat is already taken by us.** The shipped slot registry refuses a
     *    second registration of the same id at the same priority (`list slot "…"
     *    already has an entry with id "…"`). An update can leave exactly that
     *    state: HMR replaces the bundle while the previous registration is still
     *    in the table. `dsh-context` guards it with an `alreadyMounted()` check
     *    before every `register()`; so does this helper. Without the guard the
     *    throw below would fire, and see (2).
     * 2. **A throw inside `slots.inject`'s callback retires that injection for the
     *    fiber's remaining lifetime.** Measured behaviour, not a guess: it is
     *    never retried, so the contribution stays missing until the process
     *    restarts. Reusing an existing seat instead of racing it is what keeps a
     *    re-apply from reaching this state.
     * 3. **A throw out of `apply()` takes the rest of the batch down.** The client
     *    bundle batch is one concatenated classic script, so an uncaught exception
     *    here also skips every later bundle's registration.
     *
     * Each seat is therefore registered through here: an occupied seat is left
     * alone, and any remaining failure degrades to "this one entry is absent"
     * rather than "no panel at all".
     * @param {any} ctx - the client plugin context.
     * @param {string} name - the slot name.
     * @param {{id?: string, key?: string}} identity - how the registry tells our entry from others.
     * @param {() => any} register - registers the contribution, returns its disposer.
     * @returns {void}
     */
    function mount(ctx, name, identity, register) {
      try {
        if (alreadyMounted(ctx, name, identity)) return
        ctx.slots.inject(name, () => {
          // Re-check inside the callback: the injected contribution runs later, so
          // the seat may have been filled in the meantime.
          if (alreadyMounted(ctx, name, identity)) return undefined
          try {
            return register()
          } catch (error) {
            console.error(`dsh-server-connector: registering ${name} failed; that entry stays hidden`, error)
            return undefined
          }
        })
      } catch (error) {
        console.error(`dsh-server-connector: this DSH does not accept a ${name} entry`, error)
      }
    }

    /**
     * Whether this bundle already occupies a seat.
     *
     * A `list` slot is identified by `id` and a `keyed` slot by `key`; that split
     * is the registry's own (`lib/client/ui-slots`: the duplicate checks read
     * `options.id` for list and `options.key` for keyed entries). `entries()` is
     * the registry's read face; a Host that does not expose it reports "not
     * mounted", which keeps the plain `register()` path working there.
     * @param {any} ctx - the client plugin context.
     * @param {string} name - the slot name.
     * @param {{id?: string, key?: string}} identity
     * @returns {boolean}
     */
    function alreadyMounted(ctx, name, identity) {
      const entriesOf = ctx.slots.entriesOfSlot ?? ctx.slots.entries
      if (typeof entriesOf !== 'function') return false
      try {
        const entries = entriesOf.call(ctx.slots, name)
        if (!Array.isArray(entries)) return false
        return entries.some((/** @type {any} */ entry) => {
          const options = entry?.options
          if (options === null || options === undefined) return false
          if (identity.id !== undefined) return options.id === identity.id
          if (identity.key !== undefined) return options.key === identity.key
          return false
        })
      } catch {
        return false
      }
    }

    /**
     * Register the dictionaries and the three §8.1 contributions.
     *
     * This function must never throw: `apply()` runs inside the client bundle batch
     * (see {@link mount}), and an escaping exception would silently unship every
     * later bundle in that batch as well.
     * @param {any} ctx - the browser plugin context.
     */
    function apply(ctx) {
      try {
        installStyles()
      } catch (error) {
        // A page without a DOM (a server renderer, a test) simply gets no styles;
        // the panel still mounts, just unstyled.
        console.error('dsh-server-connector: installing the stylesheet failed', error)
      }
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'server-connector: dictionaries')
      } catch (error) {
        // Without the dictionaries every label renders as its raw key — ugly, but
        // far better than unshipping the panel over a copy table.
        console.error('dsh-server-connector: registering the dictionaries failed', error)
      }

      // The editable global settings. `configForms` is an optional service and
      // is therefore reached through `ctx.inject` rather than the bundle's own
      // `inject` array: a Host without it still gets the panel and the tools,
      // and the settings card degrades to the read-only view.
      const configModel = createConfigModel()
      bindConfigModel(ctx, configModel)

      mount(ctx, 'sidebar.panellist', { id: PANEL_ID }, () =>
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

      mount(ctx, 'main', { key: PANEL_ID }, () =>
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

      mount(ctx, 'settings.section', { id: PANEL_ID }, () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: PANEL_ID,
            order: 25,
            label: () => ctx.locale.bind(NS)('settings.nav'),
            locale: NS,
            inject: () => ({ model: configModel }),
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
