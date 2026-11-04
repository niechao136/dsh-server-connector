// dsh-server-connector — the agent-facing tool surface (design doc §5, §6).
//
// Six `srv_*` tools, the system-prompt section that advertises the configured
// servers (§5.3), and the three gates every execution goes through (§6.1):
//
//   srv_exec(command)
//      ├─① policy.check(command, server.policy, server.disabledRules)
//      │     block   → POLICY_BLOCKED, no connection, no execution
//      │     confirm → ②
//      │     allow   → ③
//      ├─② ctx.approval.request({agent, toolName: 'srv_exec', reason})
//      │     allowed-once                → ③
//      │     rejected/cancelled/unavailable → POLICY_DENIED_BY_USER
//      └─③ execute through the pool → audit → result
//
// This module is the only model-visible face of the plugin. It orchestrates the
// units below it and owns no storage of its own: the registry (§3.1), the pool
// (§7), the policy engine (§4) and the audit log (§3.4) are injected.
//
// Two deliberate decisions, both visible to the model and documented in the PR:
//
// 1. **Policy/approval/transport failures are thrown; a nonzero exit and a
//    timeout are results.** §5.5 lists `EXIT_NONZERO` and `TIMEOUT` among the
//    error types, but throwing would throw away the stdout/stderr the model
//    needs to act on. Both are therefore reported as a typed `code` field
//    (`EXIT_NONZERO` / `TIMEOUT`) on the normal result, whose rendered text
//    leads with the code and a next step. Everything that *prevented* the
//    command from running or from reporting (`POLICY_BLOCKED`,
//    `POLICY_DENIED_BY_USER`, `CONNECT_FAILED`, `HOST_KEY_UNKNOWN`,
//    `AUTH_FAILED`, `NO_CREDENTIAL`, `TIMEOUT` before any output, …) is thrown
//    as a {@link ToolError} whose message starts with the §5.5 code.
//
// 2. **Long commands are promoted, not migrated.** `async: true` or a call that
//    outlives `syncTimeoutMs` returns a `ctx.jobs` job id that keeps the very
//    same SSH channel open. A foreground command therefore never runs twice and
//    never loses output it already emitted. Without `ctx.jobs` (§9.4 optional
//    service) execution degrades to a synchronous call bounded by `timeoutMs`.

import { defineTool } from '@deepseek-ai/dsh-tools'

import { RULES } from './policy.js'
import { check as checkPolicy } from './policy.js'

/** The six tool names of doc §5.1, in registration order. */
export const TOOL_NAMES = Object.freeze([
  'srv_list',
  'srv_connect',
  'srv_exec',
  'srv_job_output',
  'srv_job_kill',
  'srv_policy_check',
])

/**
 * Machine-readable error codes (§5.5). `INVALID_ARGUMENT` is the one addition:
 * it marks a malformed tool argument, which the §5.5 table does not enumerate
 * because it describes transport and policy failures.
 * @typedef {'CONNECT_FAILED'|'HOST_KEY_UNKNOWN'|'AUTH_FAILED'|'POLICY_BLOCKED'|'POLICY_DENIED_BY_USER'|'TIMEOUT'|'EXIT_NONZERO'|'UNKNOWN_SERVER'|'AMBIGUOUS_SERVER'|'NO_CREDENTIAL'|'INVALID_ARGUMENT'} ToolErrorCode
 */

/**
 * A tool failure the model can read. The message always starts with the code so
 * the model can branch on it without parsing prose (§5.5: "每种都带一句可执行的
 * 下一步提示").
 */
export class ToolError extends Error {
  /**
   * @param {ToolErrorCode} code
   * @param {string} detail - what happened, in one sentence.
   * @param {string} [next] - the actionable next step.
   */
  constructor(code, detail, next) {
    super(`${code}: ${detail}${next === undefined || next === '' ? '' : ` ${next}`}`)
    this.name = 'ToolError'
    /** @type {ToolErrorCode} */
    this.code = code
  }
}

/**
 * The probe `srv_connect` runs after the handshake: platform, shell and sudo
 * availability in one round trip (§5.1). Every line is `key=value`; an unknown
 * key is ignored, a missing one reports `unknown`. The trailing `true` keeps the
 * exit code 0 so a `grep`-style failure inside the probe is not mistaken for a
 * failed connection.
 * @type {string}
 */
export const CONNECT_PROBE = [
  '. /etc/os-release 2>/dev/null; printf "os=%s\\n" "${PRETTY_NAME:-${ID:-unknown}}"',
  'printf "kernel=%s\\n" "$(uname -srm 2>/dev/null || echo unknown)"',
  'printf "shell=%s\\n" "${SHELL:-/bin/sh}"',
  'if command -v sudo >/dev/null 2>&1; then',
  '  if sudo -n true >/dev/null 2>&1; then echo "sudo=passwordless"; else echo "sudo=password (needs a password)"; fi',
  'else echo "sudo=absent"; fi',
  'true',
].join('; ')

/**
 * Parse the {@link CONNECT_PROBE} output into the fields the tool returns.
 * @param {string} stdout
 * @returns {{platform: string, kernel: string, shell: string, sudo: string}}
 */
export function parseProbe(stdout) {
  /** @type {Record<string, string>} */
  const fields = {}
  for (const line of stdout.split('\n')) {
    const index = line.indexOf('=')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    if (key !== '' && value !== '') fields[key] = value
  }
  return {
    platform: fields.os ?? 'unknown',
    kernel: fields.kernel ?? 'unknown',
    shell: fields.shell ?? 'unknown',
    sudo: fields.sudo ?? 'unknown',
  }
}

/**
 * Render the §5.3 system-prompt section for the configured servers.
 *
 * Returns an empty string when nothing is configured: the section then
 * contributes nothing (§5.3: "仅在已配置服务器存在时出现"), and an empty section
 * is how `ctx.systemPrompt.section` spells "nothing to say".
 * @param {import('./registry.js').ServerRecord[]} servers
 * @param {{maxListedServers?: number}} [options]
 * @returns {string}
 */
export function renderServerSection(servers, options = {}) {
  if (servers.length === 0) return ''
  const max = options.maxListedServers ?? 8
  const listed = servers.slice(0, max)
  const lines = ['可运维服务器（调用 srv_exec 时必须传 server）：']
  for (const server of listed) {
    const workdir = server.defaultWorkDir === null ? '（无默认目录）' : server.defaultWorkDir
    lines.push(
      `- ${server.id}  ${server.name}   ${server.username}@${server.host}:${server.port}   默认目录 ${workdir}`,
    )
  }
  const rest = servers.length - listed.length
  if (rest > 0) lines.push(`…另有 ${rest} 台，调用 srv_list 查看全部`)

  // Per-server overrides are what an operator actually configured; when every
  // server inherits the built-in catalog, summarise the catalog instead of
  // claiming an override that does not exist.
  /** @type {Map<string, Set<string>>} */
  const overrides = new Map()
  for (const server of servers) {
    for (const [ruleId, decision] of Object.entries(server.policy)) {
      const key = `${ruleId}=${decision}`
      if (!overrides.has(key)) overrides.set(key, new Set())
      overrides.get(key)?.add(server.id)
    }
  }
  if (overrides.size > 0) {
    const summary = [...overrides.keys()].sort().join('、')
    lines.push(`高危策略：${summary}（可用 srv_policy_check 预检）`)
  } else {
    const blocked = RULES.filter((rule) => rule.defaultDecision === 'block').length
    const confirmed = RULES.length - blocked
    lines.push(
      `高危策略：内置 ${RULES.length} 条规则（${blocked} 条 block、${confirmed} 条 confirm），未做逐台覆盖（可用 srv_policy_check 预检）`,
    )
  }
  return lines.join('\n')
}

/**
 * Order of the §5.3 section in the assembled system prompt.
 *
 * Newer DSH releases allocate section orders centrally
 * (`ctx.systemPrompt.getSectionOrder('MCP_SERVERS')`); the release candidates
 * this package targets expose only plain numeric orders. Both are supported so
 * the plugin does not pin one harness build: the fallback numbers are the ones
 * `SECTION_ORDERS` assigns (`MCP_SERVERS = 3100`, "other tool guidance").
 * @param {any} ctx
 * @param {keyof typeof FALLBACK_SECTION_ORDERS} name
 * @returns {number}
 */
export function systemPromptOrder(ctx, name) {
  const resolveOrder = ctx?.systemPrompt?.getSectionOrder
  if (typeof resolveOrder === 'function') {
    try {
      const order = resolveOrder.call(ctx.systemPrompt, name)
      if (typeof order === 'number' && Number.isFinite(order)) return order
    } catch {
      // Fall through to the literal order below.
    }
  }
  return FALLBACK_SECTION_ORDERS[name]
}

/**
 * The `SECTION_ORDERS` values this plugin uses, for harness builds without
 * `getSectionOrder`. Keep in sync with `@deepseek-ai/dsh-system-prompt`.
 * @type {{MCP_SERVERS: number}}
 */
export const FALLBACK_SECTION_ORDERS = Object.freeze({
  MCP_SERVERS: 3100,
})

/**
 * Whether one approval outcome granted the action (§6.1: only `allowed-once`
 * executes).
 * @param {string} outcome
 * @returns {boolean}
 */
export function isGranted(outcome) {
  return outcome === 'allowed-once'
}

/**
 * The session's effective approval policy, read without prompting anyone.
 *
 * `ApprovalService` computes it as "the session override, else the deployment
 * default". The public surface exposes neither directly (`overrideOf` is
 * declared private, `config` is public), so both are probed defensively: a
 * future shape change degrades to `'ask'`, which only affects the wording of a
 * rejection message, never whether something runs.
 * @param {any} approval - the `ctx.approval` service.
 * @param {any} agent - the calling agent.
 * @returns {'ask'|'never'}
 */
export function approvalPolicyOf(approval, agent) {
  const session = agent?.session
  if (session !== undefined && typeof approval?.overrideOf === 'function') {
    try {
      const override = approval.overrideOf(session)
      if (override === 'ask' || override === 'never') return override
    } catch {
      // Fall through to the configured default.
    }
  }
  const configured = approval?.config?.policy
  return configured === 'never' ? 'never' : 'ask'
}

/**
 * Build the §6.1 approval reason: rule id + server name + the full command.
 * @param {{ruleId: string|null, ruleLabel?: string, server: import('./registry.js').ServerRecord, command: string}} input
 * @returns {string}
 */
export function approvalReason(input) {
  const rule = input.ruleId === null ? 'server policy' : `rule ${input.ruleId}${input.ruleLabel ? ` (${input.ruleLabel})` : ''}`
  return `${rule} matched on server ${input.server.name} (${input.server.id}): ${input.command}`
}

/**
 * Render a job-read delta the way the model reads it: stdout in order, then the
 * stderr chunks in one `[stderr]` section, so a promoted call and the
 * `srv_job_output` reads that follow have the same shape.
 * @param {readonly {text: string, channel?: string}[]} chunks
 * @returns {string}
 */
export function renderChunks(chunks) {
  const out = chunks.filter((chunk) => chunk.channel !== 'stderr').map((chunk) => chunk.text).join('')
  const err = chunks.filter((chunk) => chunk.channel === 'stderr').map((chunk) => chunk.text).join('')
  const separator = out.length > 0 && !out.endsWith('\n') ? '\n' : ''
  return out + (err.length > 0 ? `${separator}[stderr]\n${err}` : '')
}

/**
 * One line describing how a finished command ended. Kept separately from the
 * output so a test (and the model) can locate it deterministically.
 * @param {{exitCode: number|null, timedOut?: boolean, durationMs?: number}} result
 * @returns {string}
 */
export function statusLine(result) {
  if (result.timedOut === true) {
    return 'TIMEOUT: the remote watchdog killed the process group; raise timeoutMs or run it with async: true.'
  }
  if (result.exitCode === null || result.exitCode === undefined) return 'exit: unknown'
  if (result.exitCode === 0) return 'exit 0'
  return `exit ${result.exitCode} (EXIT_NONZERO)`
}

/**
 * One `srv_exec` result, canonical shape (doc §5.4). `running` marks a promoted
 * call (poll with `srv_job_output`); `code` carries the §5.5 failure code for a
 * command that did run but did not succeed.
 * @typedef {object} SrvExecValue
 * @property {string} serverId
 * @property {string} serverName
 * @property {string} command
 * @property {'allow'|'confirm'} decision
 * @property {string} [policyRule]
 * @property {string} [jobId]
 * @property {boolean} [running]
 * @property {number} [exitCode]
 * @property {'EXIT_NONZERO'|'TIMEOUT'} [code]
 * @property {string} [stdout]
 * @property {string} [stderr]
 * @property {boolean} [truncated]
 * @property {number} [durationMs]
 * @property {string} [note]
 */

/**
 * The model-visible tool surface. One instance per plugin process.
 *
 * `jobs` and `approval` are optional (§9.4): without `approval` every `confirm`
 * decision fails closed as `POLICY_DENIED_BY_USER`; without `jobs` every call
 * is synchronous.
 */
export class ToolSurface {
  /** @type {import('./registry.js').Registry} */
  #registry
  /** @type {import('./pool.js').Pool} */
  #pool
  /** @type {import('./audit.js').AuditLog|null} */
  #audit
  /** @type {any} */
  #approval
  /** @type {any} */
  #jobs
  /** @type {import('./index.js').PluginConfig} */
  #config
  /** @type {{info?: Function, warn?: Function, error?: Function}|null} */
  #logger
  /** @type {import('./registry.js').ServerRecord[]} */
  #servers = []
  /** @type {boolean} */
  #loaded = false

  /**
   * @param {{
   *   registry: import('./registry.js').Registry,
   *   pool: import('./pool.js').Pool,
   *   audit?: import('./audit.js').AuditLog|null,
   *   approval?: any,
   *   jobs?: any,
   *   config?: Partial<import('./index.js').PluginConfig>,
   *   logger?: {info?: Function, warn?: Function, error?: Function}|null,
   * }} options
   */
  constructor(options) {
    if (options?.registry === undefined || options.registry === null) {
      throw new TypeError('ToolSurface requires a registry.')
    }
    if (options?.pool === undefined || options.pool === null) {
      throw new TypeError('ToolSurface requires a pool.')
    }
    this.#registry = options.registry
    this.#pool = options.pool
    this.#audit = options.audit ?? null
    this.#approval = options.approval ?? null
    this.#jobs = options.jobs ?? null
    this.#config = /** @type {import('./index.js').PluginConfig} */ ({
      commandTimeoutMs: 60000,
      syncTimeoutMs: 20000,
      maxOutputChars: 200000,
      maxListedServers: 8,
      ...options.config,
    })
    this.#logger = options.logger ?? null
  }

  /** The cached server list used by the synchronous system-prompt provider. */
  get servers() {
    return this.#servers
  }

  /** Whether {@link refresh} has completed at least once. */
  get loaded() {
    return this.#loaded
  }

  /**
   * Re-read `servers.json` into the cache used by the system-prompt provider
   * (which must be synchronous, `ctx.systemPrompt.section` accepts no promise).
   * Called at startup and after every tool call; phase 5's HTTP routes call it
   * after a mutation so the prompt follows the panel.
   * @returns {Promise<import('./registry.js').ServerRecord[]>}
   */
  async refresh() {
    this.#servers = await this.#registry.list()
    this.#loaded = true
    return this.#servers
  }

  /**
   * Register the six tools on `ctx.tools` (§5.1).
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @returns {void}
   */
  register(ctx) {
    for (const definition of [
      this.#listTool(),
      this.#connectTool(),
      this.#execTool(),
      this.#jobOutputTool(),
      this.#jobKillTool(),
      this.#policyCheckTool(),
    ]) {
      ctx.tools.register(definition)
    }
  }

  /**
   * Register the §5.3 system-prompt section. The provider is synchronous, so it
   * serves the cache; the cache is refreshed at startup and after every tool
   * call.
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @returns {void}
   */
  registerSystemPrompt(ctx) {
    ctx.effect(() =>
      ctx.systemPrompt.section({
        name: 'dsh-server-connector:servers',
        // Next to the MCP server list: both describe systems reachable from this
        // deployment, and neither is session-scoped.
        order: systemPromptOrder(ctx, 'MCP_SERVERS'),
        text: () =>
          renderServerSection(this.#loaded ? this.#servers : [], {
            maxListedServers: this.#config.maxListedServers,
          }),
      }),
    )
  }

  // ---------------------------------------------------------------- tools --

  /** @returns {any} */
  #listTool() {
    const surface = this
    return defineTool({
      name: 'srv_list',
      description:
        'List the servers configured on this machine: id, name, host, default working directory, and whether a connection is currently open. Call this first when unsure which server to address.',
      parameters: {},
      output: {
        schema: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              name: { type: 'string', required: true },
              host: { type: 'string', required: true },
              port: { type: 'number', required: true },
              username: { type: 'string', required: true },
              defaultWorkDir: { type: 'string' },
              connected: { type: 'boolean', required: true },
              hostKeyMode: { type: 'string', enum: ['accept-new', 'verify', 'off'], required: true },
            },
          },
        },
        render: (_args, servers) => [
          {
            type: 'text',
            text:
              servers.length === 0
                ? 'No servers are configured yet. Add one in the "服务器" panel of this plugin.'
                : servers
                    .map(
                      (server) =>
                        `${server.id}  ${server.name}  ${server.username}@${server.host}:${server.port}` +
                        `  ${server.connected ? 'connected' : 'not connected'}` +
                        `  ${server.defaultWorkDir === undefined ? '(no default dir)' : `dir ${server.defaultWorkDir}`}`,
                    )
                    .join('\n'),
          },
        ],
      },
      async execute() {
        await surface.refresh()
        const connected = new Set(surface.poolConnectedIds())
        return surface.servers.map((server) => ({
          id: server.id,
          name: server.name,
          host: server.host,
          port: server.port,
          username: server.username,
          ...(server.defaultWorkDir === null ? {} : { defaultWorkDir: server.defaultWorkDir }),
          connected: connected.has(server.id),
          hostKeyMode: server.hostKeyMode,
        }))
      },
    })
  }

  /** @returns {any} */
  #connectTool() {
    const surface = this
    return defineTool({
      name: 'srv_connect',
      description:
        'Open (or reuse) the SSH connection for one server and report what the remote host is: platform, kernel, login shell and sudo availability. Safe to call repeatedly; srv_exec connects on its own.',
      parameters: {
        server: {
          type: 'string',
          required: true,
          description: 'Server id, exact name, or an unambiguous prefix of either (see srv_list).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            serverId: { type: 'string', required: true },
            serverName: { type: 'string', required: true },
            platform: { type: 'string', required: true },
            kernel: { type: 'string', required: true },
            shell: { type: 'string', required: true },
            sudo: { type: 'string', required: true },
            reconnected: { type: 'boolean', required: true },
            durationMs: { type: 'number', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: [
              `${value.serverId} (${value.serverName}) connected in ${value.durationMs} ms`,
              `platform: ${value.platform}`,
              `kernel:   ${value.kernel}`,
              `shell:    ${value.shell}`,
              `sudo:     ${value.sudo}`,
            ].join('\n'),
          },
        ],
      },
      async execute(args, exec) {
        await surface.refresh()
        const server = await surface.#resolveServer(args.server)
        const startedAt = Date.now()
        const { reconnected } = await surface.#callPool('connect', server, exec)
        const probe = await surface.#callPool(
          'exec',
          server,
          { command: CONNECT_PROBE, timeoutMs: Math.min(surface.#config.commandTimeoutMs ?? 60000, 15000) },
          exec,
        )
        const parsed = parseProbe(String(probe.stdout ?? ''))
        return {
          serverId: server.id,
          serverName: server.name,
          ...parsed,
          reconnected: reconnected !== false,
          durationMs: Date.now() - startedAt,
        }
      },
    })
  }

  /** @returns {any} */
  #execTool() {
    const surface = this
    return defineTool({
      name: 'srv_exec',
      description:
        'Run a shell command on one configured server. High-risk commands are blocked or require the user to confirm first (see the server list in the system prompt, or pre-check with srv_policy_check). Output beyond the configured ceiling is cut and marked TRUNCATED; a command that outlives the sync budget returns a job id to poll with srv_job_output.',
      parameters: {
        server: {
          type: 'string',
          required: true,
          description: 'Server id, exact name, or an unambiguous prefix of either.',
        },
        command: {
          type: 'string',
          required: true,
          description: 'The shell command to run on the remote host.',
        },
        cwd: {
          type: 'string',
          description: "Working directory; defaults to the server's defaultWorkDir.",
        },
        timeoutMs: {
          type: 'number',
          description:
            'Wall-clock budget in milliseconds (default from the plugin config, 60000). On expiry the remote watchdog kills the process group.',
        },
        async: {
          type: 'boolean',
          description: 'Return a job id immediately instead of waiting for the first syncTimeoutMs window.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            serverId: { type: 'string', required: true },
            serverName: { type: 'string', required: true },
            command: { type: 'string', required: true },
            decision: { type: 'string', enum: ['allow', 'confirm'], required: true },
            policyRule: { type: 'string' },
            jobId: { type: 'string' },
            running: { type: 'boolean' },
            exitCode: { type: 'number' },
            code: { type: 'string', enum: ['EXIT_NONZERO', 'TIMEOUT'] },
            stdout: { type: 'string' },
            stderr: { type: 'string' },
            truncated: { type: 'boolean' },
            durationMs: { type: 'number' },
            note: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (value.running === true) {
            return [
              {
                type: 'text',
                text:
                  `started background job ${value.jobId} on ${value.serverId} (${value.serverName})\n` +
                  `command: ${value.command}\n` +
                  'Read it with srv_job_output, stop it with srv_job_kill.',
              },
            ]
          }
          const header = [
            `${value.serverId} (${value.serverName})`,
            statusLine({ exitCode: value.exitCode ?? null, timedOut: value.code === 'TIMEOUT' }),
            value.durationMs === undefined ? undefined : `${value.durationMs} ms`,
            value.decision === 'confirm' ? 'approved by user' : undefined,
            value.truncated === true ? 'TRUNCATED' : undefined,
          ]
            .filter((part) => part !== undefined)
            .join('  ')
          const body = [value.stdout ?? '', value.stderr === undefined ? '' : `[stderr]\n${value.stderr}`]
            .filter((part) => part !== '')
            .join(value.stdout !== undefined && !value.stdout.endsWith('\n') && value.stderr ? '\n' : '')
          return [{ type: 'text', text: `${header}\n${body}${value.note === undefined ? '' : `\n[${value.note}]`}` }]
        },
      },
      async execute(args, exec) {
        return surface.#exec(args, exec)
      },
      presentCall: (args) => ({
        card: 'terminal',
        title: args.command,
        description: `server ${args.server}`,
      }),
    })
  }

  /** @returns {any} */
  #jobOutputTool() {
    const surface = this
    return defineTool({
      name: 'srv_job_output',
      description:
        'Read the output of a running or finished srv_exec job. Returns only what is new since the previous read (or since `offset`), plus the next byte offset to resume from. A job whose ring dropped bytes reports lossy: true with the spill file paths.',
      parameters: {
        jobId: { type: 'string', required: true, description: 'Job id returned by srv_exec.' },
        offset: {
          type: 'number',
          description: 'Absolute byte offset to read from. Omit to continue from the previous read.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            jobId: { type: 'string', required: true },
            status: { type: 'string', required: true },
            text: { type: 'string', required: true },
            next: { type: 'number', required: true },
            lossy: { type: 'boolean', required: true },
            detail: { type: 'string' },
            spillPaths: { type: 'array', items: { type: 'string' } },
            result: { type: 'string' },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: [
              `${value.jobId}  ${value.status}${value.detail === undefined ? '' : `  (${value.detail})`}`,
              value.lossy ? `[some output was dropped; full output: ${(value.spillPaths ?? []).join(', ') || '(unavailable)'}]` : undefined,
              value.text === '' ? '(no new output)' : value.text,
              `next: ${value.next}`,
            ]
              .filter((part) => part !== undefined)
              .join('\n'),
          },
        ],
      },
      async execute(args) {
        const jobs = surface.#jobs
        if (jobs === null || jobs === undefined) {
          throw new ToolError(
            'INVALID_ARGUMENT',
            'this deployment has no background-job service, so srv_exec never produces a job.',
            'Run the command without async: true (it then runs synchronously).',
          )
        }
        const id = String(args.jobId)
        const caller = surface.#ownerOf(undefined)
        if (typeof args.offset === 'number') {
          if (!Number.isFinite(args.offset) || args.offset < 0) {
            throw new ToolError('INVALID_ARGUMENT', 'offset must be a non-negative byte offset.')
          }
          const read = jobs.readAt(id, Math.floor(args.offset), caller)
          const job = jobs.get(id, caller)
          return {
            jobId: id,
            status: job.status,
            text: renderChunks(read.chunks),
            next: read.next,
            lossy: read.lossy === true,
            ...(job.detail === undefined ? {} : { detail: job.detail }),
            ...(job.output?.spillPaths === undefined ? {} : { spillPaths: job.output.spillPaths }),
          }
        }
        const read = jobs.read(id, caller)
        return {
          jobId: id,
          status: read.job.status,
          text: renderChunks(read.chunks),
          next: read.job.output.total,
          lossy: read.lossy === true,
          ...(read.job.detail === undefined ? {} : { detail: read.job.detail }),
          ...(read.job.output.spillPaths === undefined ? {} : { spillPaths: read.job.output.spillPaths }),
          ...(read.result === undefined ? {} : { result: read.result }),
        }
      },
    })
  }

  /** @returns {any} */
  #jobKillTool() {
    const surface = this
    return defineTool({
      name: 'srv_job_kill',
      description: 'Cancel a running srv_exec job. A finished job reports already-finished.',
      parameters: {
        jobId: { type: 'string', required: true, description: 'Job id returned by srv_exec.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            jobId: { type: 'string', required: true },
            outcome: { type: 'string', enum: ['cancellation-requested', 'already-finished'], required: true },
            status: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              value.outcome === 'cancellation-requested'
                ? `requested cancellation of job ${value.jobId} (status: ${value.status})`
                : `job ${value.jobId} had already finished (status: ${value.status})`,
          },
        ],
      },
      async execute(args) {
        const jobs = surface.#jobs
        if (jobs === null || jobs === undefined) {
          throw new ToolError(
            'INVALID_ARGUMENT',
            'this deployment has no background-job service, so no srv_exec job can exist.',
            'srv_exec ran synchronously; nothing is left running.',
          )
        }
        const id = String(args.jobId)
        const caller = surface.#ownerOf(undefined)
        const outcome = jobs.kill(id, caller)
        const job = jobs.get(id, caller)
        /** @type {'cancellation-requested'|'already-finished'} */
        const cancellation = outcome === 'requested' ? 'cancellation-requested' : 'already-finished'
        return { jobId: id, outcome: cancellation, status: job.status }
      },
    })
  }

  /** @returns {any} */
  #policyCheckTool() {
    const surface = this
    return defineTool({
      name: 'srv_policy_check',
      description:
        'Decide how srv_exec would treat a command on one server — allow, confirm (the user is asked) or block (never runs) — without connecting or executing anything. Use it before running something the built-in rules might catch.',
      parameters: {
        server: { type: 'string', required: true, description: 'Server id, exact name, or an unambiguous prefix.' },
        command: { type: 'string', required: true, description: 'The command to judge.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            serverId: { type: 'string', required: true },
            serverName: { type: 'string', required: true },
            command: { type: 'string', required: true },
            decision: { type: 'string', enum: ['allow', 'confirm', 'block'], required: true },
            ruleId: { type: 'string' },
            ruleLabel: { type: 'string' },
            matches: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  ruleId: { type: 'string', required: true },
                  decision: { type: 'string', enum: ['allow', 'confirm', 'block'], required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              `${value.decision.toUpperCase()} on ${value.serverId} (${value.serverName})` +
              `${value.ruleId === undefined ? '' : ` — rule ${value.ruleId}${value.ruleLabel === undefined ? '' : ` (${value.ruleLabel})`}`}\n` +
              `command: ${value.command}` +
              (value.decision === 'block' ? '\nThis command will not run: the rule blocks it. Ask the user to change the server policy if it is really needed.' : ''),
          },
        ],
      },
      async execute(args) {
        await surface.refresh()
        const server = await surface.#resolveServer(args.server)
        const command = requireCommand(args.command)
        const verdict = checkPolicy(command, server.policy, server.disabledRules)
        const matched = verdict.matchedRule
        return {
          serverId: server.id,
          serverName: server.name,
          command,
          decision: verdict.decision,
          ...(matched === null ? {} : { ruleId: matched.id, ruleLabel: matched.label }),
          matches: verdict.matches.map((match) => ({ ruleId: match.id, decision: match.decision })),
        }
      },
    })
  }

  // ------------------------------------------------------------- internals --

  /**
   * Resolve and cache-refresh one `server` argument (§5.2).
   * @param {unknown} query
   * @returns {Promise<import('./registry.js').ServerRecord>}
   */
  async #resolveServer(query) {
    try {
      return await this.#registry.resolve(String(query ?? ''))
    } catch (error) {
      const code = /** @type {{code?: string, message?: string}} */ (error).code
      if (code === 'UNKNOWN_SERVER' || code === 'AMBIGUOUS_SERVER' || code === 'INVALID_SERVER') {
        throw new ToolError(
          /** @type {ToolErrorCode} */ (code),
          String(/** @type {{message?: string}} */ (error).message ?? error),
          code === 'UNKNOWN_SERVER' ? 'Call srv_list to see the configured servers.' : undefined,
        )
      }
      throw error
    }
  }

  /**
   * Call one pool method and normalise its failures into §5.5 tool errors.
   * @param {'connect'|'exec'|'execStream'|'disconnect'} method
   * @param {...any} args
   * @returns {Promise<any>}
   */
  async #callPool(method, ...args) {
    try {
      // The pool's methods have unrelated signatures; this dispatcher exists only
      // so every transport failure is normalised in one place.
      const call = /** @type {(...a: any[]) => Promise<any>} */ (/** @type {any} */ (this.#pool)[method]).bind(
        this.#pool,
      )
      return await call(...args)
    } catch (error) {
      throw normalizePoolFailure(error)
    }
  }

  /**
   * Ids with a live connection, for `srv_list` (§5.1 "是否已连接").
   * @returns {string[]}
   */
  poolConnectedIds() {
    try {
      return this.#pool.connectedServerIds()
    } catch {
      return []
    }
  }

  /**
   * The three gates of §6.1, then execution.
   * @param {{server: string, command: string, cwd?: string, timeoutMs?: number, async?: boolean}} args
   * @param {import('@deepseek-ai/dsh-tools').ToolRunContext} exec
   * @returns {Promise<SrvExecValue>}
   */
  async #exec(args, exec) {
    await this.refresh?.()
    const server = await this.#resolveServer(args.server)
    const command = requireCommand(args.command)
    const timeoutMs = positiveInteger(args.timeoutMs, 'timeoutMs') ?? this.#config.commandTimeoutMs ?? 60000
    const cwd = typeof args.cwd === 'string' && args.cwd.trim() !== '' ? args.cwd : undefined
    const auditBase = {
      sessionId: this.#sessionIdOf(exec),
      serverId: server.id,
      serverName: server.name,
      command,
    }

    // ① policy. A block never connects and never executes.
    const verdict = checkPolicy(command, server.policy, server.disabledRules)
    if (verdict.decision === 'block') {
      await this.#auditExec({ ...auditBase, decision: 'block', policyRule: verdict.ruleId })
      throw new ToolError(
        'POLICY_BLOCKED',
        `command blocked by rule ${verdict.ruleId ?? 'unknown'}${
          verdict.matchedRule === null ? '' : ` (${verdict.matchedRule.label})`
        } on server ${server.name} (${server.id}): ${command}`,
        'Nothing was sent to the server. Ask the user to allow this rule for that server, or rephrase the command.',
      )
    }

    // ② approval. Only 'allowed-once' proceeds; everything else fails closed.
    /** @type {boolean|null} */
    let approved = null
    if (verdict.decision === 'confirm') {
      const outcome = await this.#requestApproval({
        exec,
        server,
        command,
        ruleId: verdict.ruleId,
        ruleLabel: verdict.matchedRule?.label,
      })
      if (!isGranted(outcome)) {
        await this.#auditExec({ ...auditBase, decision: 'confirm', policyRule: verdict.ruleId, approved: false })
        throw this.#denialError(outcome, exec, server, command)
      }
      approved = true
    }

    // ③ execute, then audit.
    const jobs = this.#jobs
    if (jobs === null || jobs === undefined) {
      const result = await this.#runSync({ server, command, cwd, timeoutMs, exec, asyncRequested: args.async === true })
      await this.#auditExec({
        ...auditBase,
        decision: verdict.decision,
        policyRule: verdict.ruleId,
        approved,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        truncated: result.truncated,
      })
      return result
    }

    const started = this.#startJob({ server, command, cwd, timeoutMs, exec })
    const owner = this.#ownerOf(exec)
    if (args.async === true) {
      /** @type {SrvExecValue} */
      const startedValue = {
        serverId: server.id,
        serverName: server.name,
        command,
        // The block branch returned above, so the decision is allow or confirm.
        decision: /** @type {'allow'|'confirm'} */ (verdict.decision),
        ...(verdict.ruleId === null ? {} : { policyRule: verdict.ruleId }),
        jobId: started.id,
        running: true,
      }
      return startedValue
    }

    let view
    try {
      view = await jobs.wait(started.id, this.#config.syncTimeoutMs ?? 20000, owner, exec.signal)
    } catch (error) {
      jobs.kill(started.id, owner, 'the srv_exec call was aborted')
      throw error
    }
    this.#log('info', 'dsh-server-connector: srv_exec on %s settled as %s', server.id, view.status)

    if (view.status === 'running' || view.status === 'stopping') {
      return {
        serverId: server.id,
        serverName: server.name,
        command,
        decision: verdict.decision,
        ...(verdict.ruleId === null ? {} : { policyRule: verdict.ruleId }),
        jobId: started.id,
        running: true,
        note: `still running after ${this.#config.syncTimeoutMs} ms; use srv_job_output`,
      }
    }

    // The call itself collected the terminal state and never handed the id out,
    // so the record leaves with the call (§12 / jobs start+wait+remove pattern).
    jobs.remove(started.id, owner)
    const settled = started.outcome()
    await this.#auditExec({
      ...auditBase,
      decision: verdict.decision,
      policyRule: verdict.ruleId,
      approved,
      exitCode: settled?.exitCode ?? null,
      durationMs: settled?.durationMs,
      truncated: settled?.truncated ?? false,
    })
    return this.#resultOf({ server, command, verdict, approved, result: settled })
  }

  /**
   * Ask the user through the DSH approval service (§6.1) and report the closed
   * outcome. A missing service or a missing agent fails closed as
   * `'unavailable'` rather than running the command unasked.
   * @param {{exec: any, server: any, command: string, ruleId: string|null, ruleLabel?: string}} input
   * @returns {Promise<string>}
   */
  async #requestApproval(input) {
    const approval = this.#approval
    const agent = input.exec?.agent
    if (approval === null || approval === undefined || typeof approval.request !== 'function') {
      return 'unavailable'
    }
    if (agent === undefined) return 'unavailable'
    try {
      return await approval.request({
        agent,
        toolName: 'srv_exec',
        ...(input.exec.callId === undefined ? {} : { callId: input.exec.callId }),
        reason: approvalReason({
          ruleId: input.ruleId,
          ruleLabel: input.ruleLabel,
          server: input.server,
          command: input.command,
        }),
        ...(input.exec.signal === undefined ? {} : { signal: input.exec.signal }),
      })
    } catch (error) {
      this.#log('warn', 'dsh-server-connector: approval.request failed: %s', String(error))
      return 'unavailable'
    }
  }

  /**
   * The §6.1 rejection error, wording the outcome and — when the session policy
   * is `never` — saying so explicitly, because that is the case the user can fix
   * without a prompt ever appearing.
   * @param {string} outcome
   * @param {any} exec
   * @param {import('./registry.js').ServerRecord} server
   * @param {string} command
   * @returns {ToolError}
   */
  #denialError(outcome, exec, server, command) {
    const context = `${server.name} (${server.id}): ${command}`
    if (outcome === 'rejected' && approvalPolicyOf(this.#approval, exec?.agent) === 'never') {
      return new ToolError(
        'POLICY_DENIED_BY_USER',
        `当前会话审批策略为 never，高危命令无法确认，命令未执行 — ${context}`,
        'The session approval policy is "never", so confirmation prompts are auto-rejected. Switch the session to the "ask" policy (or run the command manually on the server) and retry.',
      )
    }
    if (outcome === 'rejected') {
      return new ToolError(
        'POLICY_DENIED_BY_USER',
        `the user rejected this command — ${context}`,
        'Nothing was sent to the server. Ask the user what to do instead, or use srv_policy_check to find an allowed form.',
      )
    }
    if (outcome === 'cancelled') {
      return new ToolError(
        'POLICY_DENIED_BY_USER',
        `the confirmation was cancelled before it was answered — ${context}`,
        'Nothing was sent to the server. Retry when the user is ready to decide.',
      )
    }
    return new ToolError(
      'POLICY_DENIED_BY_USER',
      `the confirmation could not be shown (no approval answerer is available) — ${context}`,
      'Nothing was sent to the server. Ask the user to run the command or to enable an interactive approval surface.',
    )
  }

  /**
   * Execute without `ctx.jobs` (§9.4: "无 jobs → 强制同步执行 + 硬超时").
   * @param {{server: any, command: string, cwd?: string, timeoutMs: number, exec: any, asyncRequested: boolean}} input
   * @returns {Promise<SrvExecValue>}
   */
  async #runSync(input) {
    const result = await this.#callPool(
      'exec',
      input.server,
      {
        command: input.command,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        timeoutMs: input.timeoutMs,
      },
      input.exec,
    )
    const verdict = checkPolicy(input.command, input.server.policy, input.server.disabledRules)
    return this.#resultOf({
      server: input.server,
      command: input.command,
      verdict,
      approved: null,
      result,
      note: input.asyncRequested ? 'this deployment has no background-job service, so the call ran synchronously' : undefined,
    })
  }

  /**
   * Shape one finished execution into the canonical tool result.
   * @param {{server: any, command: string, verdict: any, approved: boolean|null, result: any, note?: string}} input
   * @returns {SrvExecValue}
   */
  #resultOf(input) {
    const result = input.result ?? {}
    const timedOut = result.timedOut === true
    const exitCode = typeof result.exitCode === 'number' ? result.exitCode : null
    /** @type {SrvExecValue} */
    const value = {
      serverId: input.server.id,
      serverName: input.server.name,
      command: input.command,
      decision: input.verdict.decision === 'block' ? 'allow' : input.verdict.decision,
      ...(input.verdict.ruleId === null ? {} : { policyRule: input.verdict.ruleId }),
      ...(exitCode === null ? {} : { exitCode }),
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
      truncated: result.truncated === true,
      durationMs: typeof result.durationMs === 'number' ? result.durationMs : 0,
    }
    if (timedOut) value.code = 'TIMEOUT'
    else if (exitCode !== null && exitCode !== 0) value.code = 'EXIT_NONZERO'
    if (input.note !== undefined) value.note = input.note
    return value
  }

  /**
   * Register one `srv_exec` as a job and start the SSH channel inside it. The
   * job owns the stream from its first byte, so a promoted call keeps emitting
   * into the ring that `srv_job_output` reads (§5.4).
   * @param {{server: any, command: string, cwd?: string, timeoutMs: number, exec: any}} input
   * @returns {{id: string, outcome: () => any}}
   */
  #startJob(input) {
    const jobs = this.#jobs
    /** @type {any} */
    let settled = null
    /** @type {(() => void)|null} */
    let cancelStream = null
    const maxOutputChars = this.#config.maxOutputChars ?? 200000
    const label = `${input.server.id}: ${input.command}`

    /** @type {any} */
    const spec = {
      kind: 'ssh',
      label,
      ...(this.#ownerOf(input.exec) === undefined ? {} : { owner: this.#ownerOf(input.exec) }),
      ...(input.exec?.callId === undefined
        ? {}
        : { toolCall: { callId: input.exec.callId, rootCallId: input.exec.rootCallId ?? input.exec.callId } }),
      run: (/** @type {any} */ job) => {
        /** @type {Promise<any>} */
        let streaming
        try {
          streaming = this.#pool.execStream(
            input.server,
            {
              command: input.command,
              ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
              timeoutMs: input.timeoutMs,
              maxOutputChars,
              onChunk: (/** @type {'stdout'|'stderr'} */ channel, /** @type {string} */ text) => {
                job.append(text, { channel })
              },
              onCancel: (/** @type {() => void} */ cancel) => {
                cancelStream = cancel
              },
            },
            input.exec?.signal,
          )
        } catch (error) {
          return {
            cancel: () => {},
            done: Promise.resolve({ status: 'failed', detail: String(error) }),
          }
        }
        const done = streaming.then(
          (/** @type {any} */ result) => {
            settled = result
            if (result.truncated === true) job.append('\n…[TRUNCATED]')
            /** @type {any} */
            const outcome = result.cancelled === true
              ? { status: 'killed', detail: 'cancelled by srv_job_kill' }
              : {
                  status: 'completed',
                  detail: result.timedOut === true ? 'TIMEOUT (process group killed)' : `exit code: ${result.exitCode}`,
                  result: JSON.stringify({
                    exitCode: result.exitCode,
                    timedOut: result.timedOut,
                    truncated: result.truncated,
                    durationMs: result.durationMs,
                  }),
                }
            return outcome
          },
          (/** @type {any} */ error) => ({
            status: 'failed',
            detail: normalizePoolFailure(error).message,
          }),
        )
        return {
          cancel: () => {
            if (cancelStream !== null) cancelStream()
          },
          done,
        }
      },
    }
    const id = jobs.start(spec)
    return { id, outcome: () => settled }
  }

  /**
   * Write one audit line (§6.2). Audit failures are logged, never surfaced: the
   * command's outcome must not change because a log file is unwritable.
   * @param {Record<string, any>} entry
   * @returns {Promise<void>}
   */
  async #auditExec(entry) {
    const audit = this.#audit
    if (audit === null || audit === undefined) return
    try {
      await audit.append(entry)
    } catch (error) {
      this.#log('error', 'dsh-server-connector: audit append failed: %s', String(error))
    }
  }

  /**
   * @param {any} exec
   * @returns {string|undefined}
   */
  #sessionIdOf(exec) {
    const id = exec?.agent?.id ?? exec?.agent?.session?.id
    return typeof id === 'string' ? id : undefined
  }

  /**
   * The reading/owning session of a job call, or undefined for an unowned job.
   * @param {any} exec
   * @returns {any}
   */
  #ownerOf(exec) {
    return exec?.agent?.id
  }

  /**
   * @param {'info'|'warn'|'error'} level
   * @param {string} message
   * @param {...unknown} args
   * @returns {void}
   */
  #log(level, message, ...args) {
    const logger = this.#logger
    if (logger === null || logger === undefined) return
    const write = logger[level] ?? logger.info
    if (typeof write === 'function') write.call(logger, message, ...args)
  }
}

/**
 * Map a transport failure onto a §5.5 tool error, keeping the actionable next
 * step the pool already composed.
 * @param {unknown} error
 * @returns {ToolError}
 */
export function normalizePoolFailure(error) {
  if (error instanceof ToolError) return error
  const code = /** @type {{code?: string}} */ (error).code
  const known = /** @type {ToolErrorCode[]} */ ([
    'CONNECT_FAILED',
    'HOST_KEY_UNKNOWN',
    'AUTH_FAILED',
    'TIMEOUT',
    'NO_CREDENTIAL',
    'EXIT_NONZERO',
    'INVALID_ARGUMENT',
  ])
  const message = error instanceof Error ? error.message : String(error)
  if (typeof code === 'string' && known.includes(/** @type {ToolErrorCode} */ (code))) {
    return new ToolError(/** @type {ToolErrorCode} */ (code), message)
  }
  return new ToolError('CONNECT_FAILED', message, 'Retry; if it persists, check that sshd is running on the target.')
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function requireCommand(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolError('INVALID_ARGUMENT', 'command must be a non-empty string.', 'Pass the shell command to run.')
  }
  return value
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {number|undefined}
 */
function positiveInteger(value, label) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ToolError('INVALID_ARGUMENT', `${label} must be a positive number of milliseconds.`)
  }
  return Math.round(value)
}

export default ToolSurface
