// Tests for the agent tool surface and the three-gate approval flow (doc §5, §6).
//
// Run with: node --test tests/tools.test.ts   (Node strips the types natively)
// or:       npm test
//
// The tests deliberately drive the *registered tool definitions* rather than the
// private helpers: the contract that matters is what a model sees when it calls
// srv_exec, and that contract lives in `ToolDefinition.execute` + `output.render`.
// Every gate of §6.1 therefore has a test that proves the gate fired, and — more
// importantly — a test that proves the next layer was never reached:
//
//   block   → the pool was never asked to connect
//   confirm → the pool ran only after approval returned 'allowed-once'
//   never   → no prompt, rejection, and the message names the session policy
//
// `defineTool` validates arguments and output against their declared schemas, so
// a passing test also proves the tool's JSON schema matches the value it returns.

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { AuditLog } from '../lib/audit.js'
import { Registry } from '../lib/registry.js'
import {
  CONNECT_PROBE,
  TOOL_NAMES,
  ToolError,
  ToolSurface,
  approvalPolicyOf,
  approvalReason,
  isGranted,
  normalizePoolFailure,
  parseProbe,
  renderChunks,
  renderServerSection,
  statusLine,
  systemPromptOrder,
} from '../lib/tools.js'

let directory: string
let serversFile: string
let auditFile: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-tools-'))
  serversFile = join(directory, 'servers.json')
  auditFile = join(directory, 'audit.log')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** A complete server record, without the registry-assigned id/timestamps. */
function serverInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: '生产机-A',
    host: '10.0.0.5',
    port: 22,
    username: 'devops',
    auth: { kind: 'key', privateKeyPath: '/root/.ssh/id_rsa' },
    defaultWorkDir: '/srv/app',
    ...overrides,
  }
}

/**
 * A fake pool recording every call. `exec` and `execStream` resolve with a
 * canned §7.3 result unless a test overrides them.
 */
class FakePool {
  connects: string[] = []
  execs: { serverId: string, request: any }[] = []
  streams: { serverId: string, request: any }[] = []
  disconnects: string[] = []
  connected = new Set<string>()
  execResult: any = { stdout: 'hi\n', stderr: '', exitCode: 0, durationMs: 12, timedOut: false, truncated: false, reconnected: false, timeoutError: null }
  connectError: Error | null = null

  async connect(server: any) {
    this.connects.push(server.id)
    if (this.connectError !== null) throw this.connectError
    this.connected.add(server.id)
    return { connection: {}, reconnected: true }
  }

  async exec(server: any, request: any) {
    this.execs.push({ serverId: server.id, request })
    return this.execResult
  }

  async execStream(server: any, request: any) {
    this.streams.push({ serverId: server.id, request })
    return { ...this.execResult, cancelled: false, startedAt: Date.now(), endedAt: Date.now() }
  }

  async disconnect(serverId: string) {
    this.disconnects.push(serverId)
    this.connected.delete(serverId)
  }

  connectedServerIds() {
    return [...this.connected].sort()
  }
}

/**
 * A jobs registry double with the parts srv_exec / srv_job_output /
 * srv_job_kill use: start, wait, read, readAt, get, kill, remove. The producer's
 * `run()` is invoked exactly as the real registry invokes it.
 */
class FakeJobs {
  jobs = new Map<string, any>()
  nextId = 1
  waitMs = 0
  finishImmediately = true
  /** Terminal state the producer reports; tests flip this for a hung command. */
  hang = false
  removed: string[] = []

  start(spec: any) {
    const id = `ssh-${this.nextId}`
    this.nextId += 1
    /** @type {string[]} */
    const chunks: { text: string, channel?: string }[] = []
    const handle = {
      id,
      append: (text: string, options: any = {}) => chunks.push({ text, ...(options.channel === undefined ? {} : { channel: options.channel }) }),
      updateProgress: () => {},
    }
    const hooks = spec.run(handle)
    this.jobs.set(id, { id, spec, hooks, chunks, status: 'running', detail: undefined, total: 0, owner: spec.owner })
    void hooks.done.then((outcome: any) => {
      const job = this.jobs.get(id)
      if (job === undefined) return
      job.status = outcome.status
      job.detail = outcome.detail
      job.total = chunks.reduce((size, chunk) => size + Buffer.byteLength(chunk.text, 'utf8'), 0)
      job.result = outcome.result
    })
    return id
  }

  /**
   * The real registry fences an *owned* job by session id: a caller that is not
   * the owner gets "belongs to another session", while an unowned job is visible
   * to everyone. This double must enforce the same rule, otherwise a tool that
   * forgets to pass its own `exec` still passes every test.
   * @param {any} job
   * @param {any} caller
   */
  assertAccess(job: any, caller: any) {
    if (job.owner === undefined) return
    if (caller !== job.owner) throw new Error(`job ${job.id} belongs to another session`)
  }

  get(id: string, caller?: any) {
    const job = this.jobs.get(id)
    if (job === undefined) throw new Error(`unknown job ${id}`)
    this.assertAccess(job, caller)
    return {
      id: job.id,
      status: job.status,
      ...(job.detail === undefined ? {} : { detail: job.detail }),
      output: { total: job.total, earliest: 0 },
    }
  }

  async wait(id: string, _timeoutMs: number, caller?: any) {
    const job = this.jobs.get(id)
    if (job === undefined) throw new Error(`unknown job ${id}`)
    this.assertAccess(job, caller)
    if (this.hang) return this.get(id, caller)
    await job.hooks.done
    // Give the settlement microtask a turn so `done` has updated the record.
    await Promise.resolve()
    return this.get(id, caller)
  }

  read(id: string, caller?: any) {
    const job = this.jobs.get(id)
    if (job === undefined) throw new Error(`unknown job ${id}`)
    this.assertAccess(job, caller)
    // The model's consuming cursor: chunks are handed out once, then dropped.
    const chunks = job.chunks
    job.chunks = []
    return {
      chunks,
      lossy: false,
      ...(job.result === undefined ? {} : { result: job.result }),
      job: this.get(id, caller),
    }
  }

  readAt(id: string, _offset?: number, caller?: any) {
    const job = this.jobs.get(id)
    if (job === undefined) throw new Error(`unknown job ${id}`)
    this.assertAccess(job, caller)
    return { chunks: job.chunks, next: job.total, lossy: false }
  }

  kill(id: string, caller?: any) {
    const job = this.jobs.get(id)
    if (job === undefined) throw new Error(`unknown job ${id}`)
    this.assertAccess(job, caller)
    if (job.status !== 'running') return 'already-finished'
    job.status = 'stopping'
    job.hooks.cancel('killed by test')
    return 'requested'
  }

  remove(id: string) {
    this.removed.push(id)
    this.jobs.delete(id)
  }
}

/** An approval service double. Records every request, answers `outcome`. */
class FakeApproval {
  requests: any[] = []
  outcome: string = 'allowed-once'
  throwOnRequest: Error | null = null
  config: { policy?: string } = { policy: 'ask' }
  override: string | undefined = undefined

  async request(request: any) {
    this.requests.push(request)
    if (this.throwOnRequest !== null) throw this.throwOnRequest
    return this.outcome
  }

  overrideOf() {
    return this.override
  }
}

/**
 * Build a surface with one server registered. Returns everything a test probes.
 * @param {{config?: any, approval?: FakeApproval|null, jobs?: FakeJobs|null, audit?: AuditLog|null}} [options]
 */
async function fixture(options: { config?: any, approval?: FakeApproval | null, jobs?: FakeJobs | null, audit?: AuditLog | null } = {}): Promise<{
  registry: Registry
  server: import('../lib/registry.js').ServerRecord
  pool: FakePool
  approval: FakeApproval
  jobs: FakeJobs | null
  surface: ToolSurface
}> {
  const registry = new Registry({ file: serversFile })
  const server = await registry.create(serverInput())
  const pool = new FakePool()
  const approval = options.approval === undefined ? new FakeApproval() : options.approval
  const jobs = options.jobs === undefined ? null : options.jobs
  const audit = options.audit === undefined ? null : options.audit
  const surface = new ToolSurface({
    registry,
    pool: pool as any,
    audit,
    approval,
    jobs,
    config: {
      commandTimeoutMs: 60000,
      syncTimeoutMs: 20000,
      maxOutputChars: 200000,
      maxListedServers: 8,
      ...(options.config ?? {}),
    },
  })
  return { registry, server, pool, approval, jobs, surface } as {
    registry: Registry
    server: import('../lib/registry.js').ServerRecord
    pool: FakePool
    approval: FakeApproval
    jobs: FakeJobs | null
    surface: ToolSurface
  }
}

/** Register the tools on a fake ctx and hand back the definitions by name. */
function toolsOf(surface: ToolSurface): Map<string, any> {
  const tools = new Map<string, any>()
  const ctx = {
    tools: { register: (definition: any) => void tools.set(definition.name, definition) },
    systemPrompt: { section: () => () => {}, getSectionOrder: () => 3100 },
    effect: (callback: any) => callback(),
  }
  surface.register(ctx as any)
  return tools
}

/** The execution context a tool call receives. */
function toolExec(agent?: any) {
  return { callId: 'call-1', name: 'srv_exec', arguments: {}, signal: new AbortController().signal, ...(agent === undefined ? {} : { agent }) }
}

/** A model-facing agent double whose session carries an approval override. */
function fakeAgent(policy?: 'ask' | 'never') {
  return {
    id: 'session-1',
    session: { id: 'session-1', policy },
  }
}

/** Run one tool and return its rendered text (what the model actually reads). */
async function call(tool: any, args: any, exec: any = toolExec()): Promise<string> {
  const value = await tool.execute(args, exec)
  const blocks = tool.output.render(args, value)
  return blocks.map((block: any) => block.text).join('\n')
}

/** Read the audit log this test wrote. */
async function auditRecords(file = auditFile): Promise<any[]> {
  const log = new AuditLog({ file })
  return log.tail(50)
}

describe('tool catalog and prompt surface (§5.1, §5.3)', () => {
  test('the six §5.1 tools are registered under their srv_ names', async () => {
    const { surface } = await fixture()
    const tools = toolsOf(surface)
    assert.deepEqual([...tools.keys()].sort(), [...TOOL_NAMES].sort())
    assert.deepEqual(TOOL_NAMES, [
      'srv_list',
      'srv_connect',
      'srv_exec',
      'srv_job_output',
      'srv_job_kill',
      'srv_policy_check',
    ])
  })

  test('every tool declares a description, parameters and an output schema', async () => {
    const { surface } = await fixture()
    for (const [name, tool] of toolsOf(surface)) {
      assert.equal(typeof tool.description, 'string', name)
      assert.ok(tool.description.length > 20, `${name}: description is useful`)
      assert.equal(typeof tool.parameters, 'object', name)
      // srv_list is the one array-rooted result (§5.1: a list of servers).
      assert.equal(tool.output.schema.type, name === 'srv_list' ? 'array' : 'object', name)
      assert.equal(typeof tool.output.render, 'function', name)
    }
  })

  test('srv_exec requires server and command, and offers cwd/timeoutMs/async', async () => {
    const { surface } = await fixture()
    const tool = toolsOf(surface).get('srv_exec')
    const properties = tool.parameters.properties
    assert.ok(properties.server)
    assert.ok(properties.command)
    assert.ok(properties.cwd)
    assert.ok(properties.timeoutMs)
    assert.ok(properties.async)
    assert.deepEqual(tool.parameters.required, ['server', 'command'])
  })

  test('the system-prompt section lists the documented columns', async () => {
    const { surface, registry } = await fixture()
    await surface.refresh()
    const text = renderServerSection(await registry.list(), { maxListedServers: 8 })
    assert.match(text, /可运维服务器（调用 srv_exec 时必须传 server）：/)
    const [server] = await registry.list()
    assert.ok(text.includes(`- ${server!.id}  ${server!.name}   devops@10.0.0.5:22   默认目录 /srv/app`), text)
    assert.match(text, /高危策略：/)
    assert.match(text, /srv_policy_check/)
  })

  test('no servers means no section at all (§5.3)', async () => {
    assert.equal(renderServerSection([]), '')
    const { surface } = await fixture()
    await surface.refresh()
    assert.notEqual(renderServerSection(surface.servers), '')
  })

  test('more than maxListedServers servers are folded into a count', async () => {
    const registry = new Registry({ file: serversFile })
    for (let index = 1; index <= 10; index += 1) {
      await registry.create(serverInput({ name: `机器-${index}`, host: `10.0.0.${index}` }))
    }
    const text = renderServerSection(await registry.list(), { maxListedServers: 8 })
    assert.equal(text.split('\n').filter((line) => line.startsWith('- ')).length, 8)
    assert.match(text, /…另有 2 台，调用 srv_list 查看全部/)
  })

  test('the configured maxListedServers is what the provider uses', async () => {
    const registry = new Registry({ file: serversFile })
    for (let index = 1; index <= 4; index += 1) {
      await registry.create(serverInput({ name: `机器-${index}`, host: `10.0.0.${index}` }))
    }
    const text = renderServerSection(await registry.list(), { maxListedServers: 2 })
    assert.match(text, /…另有 2 台/)
  })

  test('per-server overrides are summarised when an operator configured any', async () => {
    const { surface, registry } = await fixture()
    const [server] = await registry.list()
    await registry.update(server!.id, { policy: { 'rm-recursive': 'block', 'service-restart': 'confirm' } })
    await surface.refresh()
    const text = renderServerSection(surface.servers)
    assert.match(text, /rm-recursive=block/)
    assert.match(text, /service-restart=confirm/)
  })

  test('with no overrides the section summarises the built-in catalog instead', async () => {
    const { surface } = await fixture()
    await surface.refresh()
    const text = renderServerSection(surface.servers)
    assert.match(text, /内置 20 条规则（8 条 block、12 条 confirm）/)
  })

  test('the section order resolves through getSectionOrder when the harness has it', () => {
    assert.equal(systemPromptOrder({ systemPrompt: { getSectionOrder: () => 3100 } }, 'MCP_SERVERS'), 3100)
    // An older harness without the allocator still lands in the same slot.
    assert.equal(systemPromptOrder({ systemPrompt: {} }, 'MCP_SERVERS'), 3100)
    assert.equal(systemPromptOrder(undefined, 'MCP_SERVERS'), 3100)
  })
})

describe('srv_list and srv_connect (§5.1)', () => {
  test('srv_list reports id, name, host, workdir and connection state', async () => {
    const { surface, server, pool } = await fixture()
    pool.connected.add(server.id)
    const text = await call(toolsOf(surface).get('srv_list'), {})
    assert.match(text, /srv-01/)
    assert.match(text, /生产机-A/)
    assert.match(text, /devops@10\.0\.0\.5:22/)
    assert.match(text, /connected/)
    assert.match(text, /dir \/srv\/app/)
  })

  test('srv_list with nothing configured says so', async () => {
    const registry = new Registry({ file: serversFile })
    const surface = new ToolSurface({ registry, pool: new FakePool() as any })
    const text = await call(toolsOf(surface).get('srv_list'), {})
    assert.match(text, /No servers are configured yet/)
  })

  test('srv_connect probes platform, shell and sudo, then reports them', async () => {
    const { surface, pool } = await fixture()
    pool.execResult = {
      stdout: 'os=Ubuntu 24.04.1 LTS\nkernel=Linux 6.8.0 x86_64\nshell=/bin/bash\nsudo=passwordless\n',
      stderr: '',
      exitCode: 0,
      durationMs: 5,
      timedOut: false,
      truncated: false,
      reconnected: false,
      timeoutError: null,
    }
    const text = await call(toolsOf(surface).get('srv_connect'), { server: 'srv-01' })
    assert.match(text, /Ubuntu 24\.04\.1 LTS/)
    assert.match(text, /Linux 6\.8\.0/)
    assert.match(text, /\/bin\/bash/)
    assert.match(text, /sudo:\s+passwordless/)
    // The probe itself is what ran; it must not be mistaken for user output.
    assert.deepEqual(pool.connects, ['srv-01'])
    assert.equal(pool.execs[0]!.request.command, CONNECT_PROBE)
  })

  test('parseProbe tolerates a probe with missing fields', () => {
    const parsed = parseProbe('os=Debian\n')
    assert.equal(parsed.platform, 'Debian')
    assert.equal(parsed.kernel, 'unknown')
    assert.equal(parsed.shell, 'unknown')
    assert.equal(parsed.sudo, 'unknown')
  })

  test('a connect failure surfaces as a typed §5.5 error', async () => {
    const { surface, pool } = await fixture()
    pool.connectError = Object.assign(new Error('Cannot reach 10.0.0.5:22: ECONNREFUSED.'), { code: 'CONNECT_FAILED' })
    await assert.rejects(call(toolsOf(surface).get('srv_connect'), { server: 'srv-01' }), (error: unknown) => {
      assert.ok(error instanceof ToolError)
      assert.equal(error.code, 'CONNECT_FAILED')
      assert.match(error.message, /^CONNECT_FAILED: /)
      return true
    })
  })
})

describe('srv_policy_check: judge without executing (§5.1)', () => {
  test('an allow command reports allow and touches nothing', async () => {
    const { surface, pool } = await fixture()
    const text = await call(toolsOf(surface).get('srv_policy_check'), { server: 'srv-01', command: 'echo hi' })
    assert.match(text, /ALLOW on srv-01/)
    assert.deepEqual(pool.execs, [])
    assert.deepEqual(pool.connects, [])
  })

  test('a block rule names the rule id and says the command will not run', async () => {
    const { surface } = await fixture()
    const text = await call(toolsOf(surface).get('srv_policy_check'), { server: 'srv-01', command: 'rm -rf /tmp/x' })
    assert.match(text, /BLOCK on srv-01/)
    assert.match(text, /rm-recursive/)
    assert.match(text, /This command will not run/)
  })

  test('a confirm rule reports confirm', async () => {
    const { surface } = await fixture()
    const text = await call(toolsOf(surface).get('srv_policy_check'), {
      server: 'srv-01',
      command: 'systemctl restart app',
    })
    assert.match(text, /CONFIRM on srv-01/)
    assert.match(text, /service-restart/)
  })

  test('a per-server override is what the check applies', async () => {
    const { surface, registry, server } = await fixture()
    await registry.update(server.id, { policy: { 'rm-recursive': 'confirm' } })
    const text = await call(toolsOf(surface).get('srv_policy_check'), { server: 'srv-01', command: 'rm -rf /tmp/x' })
    assert.match(text, /CONFIRM on srv-01/)
  })

  test('a disabled rule no longer matches', async () => {
    const { surface, registry, server } = await fixture()
    await registry.update(server.id, { disabledRules: ['rm-recursive'] })
    const text = await call(toolsOf(surface).get('srv_policy_check'), { server: 'srv-01', command: 'rm -rf /tmp/x' })
    assert.match(text, /ALLOW on srv-01/)
  })

  test('the check never connects, even for a confirm decision', async () => {
    const { surface, pool } = await fixture()
    await call(toolsOf(surface).get('srv_policy_check'), { server: 'srv-01', command: 'systemctl restart app' })
    assert.deepEqual(pool.connects, [])
    assert.deepEqual(pool.execs, [])
  })
})

describe('srv_exec gate ①: block never connects or executes (§6.1)', () => {
  test('a blocked command throws POLICY_BLOCKED and the pool is untouched', async () => {
    const { surface, pool } = await fixture()
    await assert.rejects(
      call(toolsOf(surface).get('srv_exec'), { server: 'srv-01', command: 'rm -rf /srv/app' }),
      (error: unknown) => {
        assert.ok(error instanceof ToolError)
        assert.equal(error.code, 'POLICY_BLOCKED')
        assert.match(error.message, /rm-recursive/)
        assert.match(error.message, /生产机-A/)
        assert.match(error.message, /srv-01/)
        return true
      },
    )
    // The whole point of the first gate: nothing was dialled.
    assert.deepEqual(pool.connects, [])
    assert.deepEqual(pool.execs, [])
  })

  test('a blocked command writes an audit line with approved and exitCode null', async () => {
    const { surface } = await fixture({ audit: new AuditLog({ file: auditFile }) })
    await assert.rejects(call(toolsOf(surface).get('srv_exec'), { server: 'srv-01', command: 'rm -rf /srv/app' }))
    const [record] = await auditRecords()
    assert.equal(record.decision, 'block')
    assert.equal(record.policyRule, 'rm-recursive')
    assert.equal(record.approved, null)
    assert.equal(record.exitCode, null)
    assert.equal(record.serverId, 'srv-01')
    assert.equal(record.command, 'rm -rf /srv/app')
  })
})

describe('srv_exec gate ②: confirm goes through ctx.approval (§6.1)', () => {
  test('allowed-once runs the command and records the approval', async () => {
    const { surface, pool, approval } = await fixture({ audit: new AuditLog({ file: auditFile }) })
    approval.outcome = 'allowed-once'
    const text = await call(toolsOf(surface).get('srv_exec'), { server: 'srv-01', command: 'systemctl restart app' }, toolExec(fakeAgent()))
    assert.match(text, /approved by user/)
    assert.equal(pool.execs.length, 1)
    assert.equal(pool.execs[0]!.request.command, 'systemctl restart app')

    // The reason carries rule id + server name + the full command.
    assert.equal(approval.requests.length, 1)
    const reason = approval.requests[0].reason
    assert.match(reason, /service-restart/)
    assert.match(reason, /生产机-A/)
    assert.match(reason, /systemctl restart app/)
    assert.equal(approval.requests[0].toolName, 'srv_exec')
    assert.equal(approval.requests[0].agent.id, 'session-1')

    const [record] = await auditRecords()
    assert.equal(record.decision, 'confirm')
    assert.equal(record.approved, true)
    assert.equal(record.policyRule, 'service-restart')
  })

  for (const outcome of ['rejected', 'cancelled', 'unavailable']) {
    test(`'${outcome}' fails closed as POLICY_DENIED_BY_USER and runs nothing`, async () => {
      const { surface, pool, approval } = await fixture({ audit: new AuditLog({ file: auditFile }) })
      approval.outcome = outcome
      await assert.rejects(
        call(toolsOf(surface).get('srv_exec'), { server: 'srv-01', command: 'systemctl restart app' }, toolExec(fakeAgent())),
        (error: unknown) => {
          assert.ok(error instanceof ToolError)
          assert.equal(error.code, 'POLICY_DENIED_BY_USER')
          return true
        },
      )
      assert.deepEqual(pool.execs, [])
      const [record] = await auditRecords()
      assert.equal(record.approved, false)
    })
  }

  test('the session policy "never" rejects without prompting, and says so', async () => {
    const { surface, pool, approval } = await fixture()
    // The approval service itself auto-rejects under 'never' (fail-closed).
    approval.outcome = 'rejected'
    approval.override = 'never'

    await assert.rejects(
      call(toolsOf(surface).get('srv_exec'), { server: 'srv-01', command: 'systemctl restart app' }, toolExec(fakeAgent('never'))),
      (error: unknown) => {
        assert.ok(error instanceof ToolError)
        assert.equal(error.code, 'POLICY_DENIED_BY_USER')
        // The wording the issue asks for, verbatim.
        assert.match(error.message, /当前会话审批策略为 never/)
        assert.match(error.message, /高危命令无法确认/)
        return true
      },
    )
    assert.deepEqual(pool.execs, [])
  })

  test('without an approval service a confirm command fails closed', async () => {
    const { surface, pool } = await fixture({ approval: null })
    await assert.rejects(
      call(toolsOf(surface).get('srv_exec'), { server: 'srv-01', command: 'systemctl restart app' }, toolExec(fakeAgent())),
      (error: unknown) => {
        assert.equal((error as ToolError).code, 'POLICY_DENIED_BY_USER')
        assert.match((error as Error).message, /no approval answerer is available/)
        return true
      },
    )
    assert.deepEqual(pool.execs, [])
  })

  test('an allow decision never asks the user', async () => {
    const { surface, approval } = await fixture()
    await call(toolsOf(surface).get('srv_exec'), { server: 'srv-01', command: 'echo hi' }, toolExec(fakeAgent()))
    assert.deepEqual(approval.requests, [])
  })

  test('only allowed-once grants the action', () => {
    assert.equal(isGranted('allowed-once'), true)
    for (const outcome of ['rejected', 'cancelled', 'unavailable', 'allowed', '']) {
      assert.equal(isGranted(outcome), false, outcome)
    }
  })
})

describe('srv_exec gate ③: execution, output and audit (§5.4, §6.2)', () => {
  test('an allow command returns exitCode, stdout and stderr separately', async () => {
    const { surface, pool } = await fixture()
    pool.execResult = {
      stdout: 'hi\n',
      stderr: 'a warning\n',
      exitCode: 0,
      durationMs: 9,
      timedOut: false,
      truncated: false,
      reconnected: false,
      timeoutError: null,
    }
    const text = await call(toolsOf(surface).get('srv_exec'), { server: 'srv-01', command: 'echo hi' })
    assert.match(text, /exit 0/)
    assert.match(text, /hi/)
    assert.match(text, /\[stderr\]\na warning/)
  })

  test('output past maxOutputChars is marked TRUNCATED', async () => {
    const { surface, pool } = await fixture()
    pool.execResult = {
      stdout: 'x'.repeat(50) + '\n…[TRUNCATED]',
      stderr: '',
      exitCode: 0,
      durationMs: 3,
      timedOut: false,
      truncated: true,
      reconnected: false,
      timeoutError: null,
    }
    const text = await call(toolsOf(surface).get('srv_exec'), { server: 'srv-01', command: 'cat big.log' })
    assert.match(text, /TRUNCATED/)
  })

  test('a nonzero exit is a result carrying EXIT_NONZERO, not a thrown error', async () => {
    const { surface, pool } = await fixture()
    pool.execResult = { stdout: '', stderr: 'no such file\n', exitCode: 2, durationMs: 4, timedOut: false, truncated: false, reconnected: false, timeoutError: null }
    const tools = toolsOf(surface)
    const value = await tools.get('srv_exec').execute({ server: 'srv-01', command: 'cat /nope' }, toolExec())
    assert.equal(value.exitCode, 2)
    assert.equal(value.code, 'EXIT_NONZERO')
    assert.match(await call(tools.get('srv_exec'), { server: 'srv-01', command: 'cat /nope' }), /exit 2 \(EXIT_NONZERO\)/)
  })

  test('a timeout is a result carrying TIMEOUT and the §5.5 next step', async () => {
    const { surface, pool } = await fixture()
    pool.execResult = { stdout: '', stderr: '', exitCode: 137, durationMs: 2000, timedOut: true, truncated: false, reconnected: false, timeoutError: 'TIMEOUT' }
    const tools = toolsOf(surface)
    const value = await tools.get('srv_exec').execute({ server: 'srv-01', command: 'sleep 300', timeoutMs: 2000 }, toolExec())
    assert.equal(value.code, 'TIMEOUT')
    assert.match(await call(tools.get('srv_exec'), { server: 'srv-01', command: 'sleep 300' }), /TIMEOUT: the remote watchdog killed the process group/)
  })

  test('every srv_exec writes exactly one audit line (§6.2)', async () => {
    const { surface } = await fixture({ audit: new AuditLog({ file: auditFile }) })
    await call(toolsOf(surface).get('srv_exec'), { server: 'srv-01', command: 'echo one' })
    await call(toolsOf(surface).get('srv_exec'), { server: 'srv-01', command: 'echo two' })
    await assert.rejects(call(toolsOf(surface).get('srv_exec'), { server: 'srv-01', command: 'rm -rf /x' }))
    const records = await auditRecords()
    assert.equal(records.length, 3)
    assert.deepEqual(
      records.map((record) => record.decision),
      ['allow', 'allow', 'block'],
    )
  })

  test('auditEnabled=false keeps the command working and writes nothing', async () => {
    const disabled = new AuditLog({ file: auditFile, enabled: false })
    const { surface } = await fixture({ audit: disabled })
    const text = await call(toolsOf(surface).get('srv_exec'), { server: 'srv-01', command: 'echo hi' })
    assert.match(text, /exit 0/)
    assert.deepEqual(await auditRecords(), [])
  })

  test('timeoutMs and cwd reach the pool unchanged', async () => {
    const { surface, pool } = await fixture()
    await call(toolsOf(surface).get('srv_exec'), { server: 'srv-01', command: 'pwd', cwd: '/srv/other', timeoutMs: 12345 })
    const request = pool.execs[0]!.request
    assert.equal(request.cwd, '/srv/other')
    assert.equal(request.timeoutMs, 12345)
  })

  test('a malformed command or timeout is INVALID_ARGUMENT before anything connects', async () => {
    const { surface, pool } = await fixture()
    const tool = toolsOf(surface).get('srv_exec')
    await assert.rejects(tool.execute({ server: 'srv-01', command: '   ' }, toolExec()), (error: unknown) => {
      assert.equal((error as ToolError).code, 'INVALID_ARGUMENT')
      return true
    })
    await assert.rejects(tool.execute({ server: 'srv-01', command: 'echo hi', timeoutMs: -1 }, toolExec()), (error: unknown) => {
      assert.equal((error as ToolError).code, 'INVALID_ARGUMENT')
      return true
    })
    assert.deepEqual(pool.execs, [])
  })
})

describe('srv_exec async: ctx.jobs promotion (§5.4)', () => {
  test('async: true returns a job id immediately and runs the command once', async () => {
    const { surface, pool, jobs } = await fixture({ jobs: new FakeJobs() })
    const tools = toolsOf(surface)
    const value = await tools.get('srv_exec').execute({ server: 'srv-01', command: 'sleep 300', async: true }, toolExec())
    assert.equal(value.running, true)
    assert.match(value.jobId, /^ssh-/)
    // Exactly one channel was opened: promotion is not a re-run.
    assert.equal(pool.streams.length, 1)
    assert.deepEqual(pool.execs, [])
    assert.ok(jobs!.jobs.has(value.jobId))
  })

  test('a synchronous call that outlives syncTimeoutMs returns the same job id', async () => {
    const jobs = new FakeJobs()
    jobs.hang = true
    const { surface, pool } = await fixture({ jobs, config: { syncTimeoutMs: 50 } })
    const tools = toolsOf(surface)
    const value = await tools.get('srv_exec').execute({ server: 'srv-01', command: 'sleep 300' }, toolExec())
    assert.equal(value.running, true)
    assert.ok(value.jobId)
    assert.equal(pool.streams.length, 1)
    assert.match(value.note, /still running after 50 ms; use srv_job_output/)
  })

  test('a command that finishes inside the sync window returns its output, not a job', async () => {
    const jobs = new FakeJobs()
    const { surface, pool } = await fixture({ jobs })
    pool.execResult = { stdout: 'done\n', stderr: '', exitCode: 0, durationMs: 3, timedOut: false, truncated: false, reconnected: false, timeoutError: null }
    const tools = toolsOf(surface)
    const value = await tools.get('srv_exec').execute({ server: 'srv-01', command: 'echo done' }, toolExec())
    assert.equal(value.running, undefined)
    assert.equal(value.exitCode, 0)
    // The id was collected by this call, so its record leaves with it.
    assert.equal(jobs.removed.length, 1)
    assert.ok(!jobs.jobs.has(String(jobs.removed[0])))
  })

  test('without ctx.jobs every call runs synchronously and async:true is degraded', async () => {
    const { surface, pool } = await fixture({ jobs: null })
    const tools = toolsOf(surface)
    const value = await tools.get('srv_exec').execute({ server: 'srv-01', command: 'echo hi', async: true }, toolExec())
    assert.equal(value.running, undefined)
    assert.deepEqual(pool.streams, [])
    assert.equal(pool.execs.length, 1)
    assert.match(value.note, /no background-job service/)
  })

  test('srv_job_output reads the ring incrementally and reports next (§5.4)', async () => {
    const jobs = new FakeJobs()
    // Two chunks appended by the producer's stream callback.
    const { surface } = await fixture({ jobs })
    const id = jobs.start({
      kind: 'ssh',
      label: 'test',
      run: (handle: any) => {
        handle.append('line one\n', { channel: 'stdout' })
        handle.append('line two\n', { channel: 'stderr' })
        return { cancel: () => {}, done: Promise.resolve({ status: 'completed', detail: 'exit code: 0' }) }
      },
    })
    await Promise.resolve()
    const tools = toolsOf(surface)
    const text = await call(tools.get('srv_job_output'), { jobId: id })
    assert.match(text, /line one/)
    assert.match(text, /\[stderr\]\nline two/)
    assert.match(text, /next: \d+/)
  })

  test('srv_job_output with offset reads without consuming the model cursor', async () => {
    const jobs = new FakeJobs()
    const { surface } = await fixture({ jobs })
    const id = jobs.start({
      kind: 'ssh',
      label: 'test',
      run: (handle: any) => {
        handle.append('abc\n')
        return { cancel: () => {}, done: Promise.resolve({ status: 'completed', detail: 'exit code: 0' }) }
      },
    })
    await Promise.resolve()
    const tools = toolsOf(surface)
    const value = await tools.get('srv_job_output').execute({ jobId: id, offset: 0 }, toolExec())
    assert.match(value.text, /abc/)
    assert.equal(typeof value.next, 'number')
  })

  test('srv_job_kill cancels a live job and reports already-finished otherwise', async () => {
    const jobs = new FakeJobs()
    jobs.hang = true
    const { surface } = await fixture({ jobs })
    const id = jobs.start({
      kind: 'ssh',
      label: 'test',
      run: () => ({ cancel: () => {}, done: new Promise(() => {}) }),
    })
    const tools = toolsOf(surface)
    const first = await call(tools.get('srv_job_kill'), { jobId: id })
    assert.match(first, /requested cancellation of job/)
    jobs.jobs.get(id)!.status = 'completed'
    const second = await call(tools.get('srv_job_kill'), { jobId: id })
    assert.match(second, /had already finished/)
  })

  test('the job tools explain themselves when the deployment has no jobs service', async () => {
    const { surface } = await fixture({ jobs: null })
    const tools = toolsOf(surface)
    await assert.rejects(tools.get('srv_job_output').execute({ jobId: 'ssh-1' }, toolExec()), (error: unknown) => {
      assert.equal((error as ToolError).code, 'INVALID_ARGUMENT')
      assert.match((error as Error).message, /no background-job service/)
      return true
    })
  })

  test('killing the job reaches the pool\'s stream cancel handle', async () => {
    const jobs = new FakeJobs()
    jobs.hang = true
    /** @type {string[]} */
    const cancelReasons: string[] = []
    // The pool hands srv_exec a cancel closure through `request.onCancel`; the
    // job's own cancel() must call it, so a killed job really closes the channel
    // instead of being forgotten while the command keeps running remotely.
    class CancellablePool extends FakePool {
      override async execStream(server: any, request: any) {
        request.onCancel(() => cancelReasons.push('channel closed'))
        // Never settles on its own: only the cancel handle can end it.
        return new Promise(() => {})
      }
    }
    const registry = new Registry({ file: serversFile })
    await registry.create(serverInput())
    const surface = new ToolSurface({ registry, pool: new CancellablePool() as any, jobs })
    const tools = toolsOf(surface)
    const started = await tools.get('srv_exec').execute({ server: 'srv-01', command: 'sleep 300', async: true }, toolExec())
    await new Promise((resolve) => setTimeout(resolve, 10))

    await call(tools.get('srv_job_kill'), { jobId: String(started.jobId) })
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(cancelReasons, ['channel closed'])
  })

  test('the session that started a job can read and kill it (§5.4)', async () => {
    // Regression: srv_job_output / srv_job_kill read the owner off `undefined`
    // instead of their own `exec`, so every read looked unowned and the real
    // registry — which fences owned jobs by session — answered "belongs to
    // another session" even for the session that started the job.
    const jobs = new FakeJobs()
    jobs.hang = true
    const registry = new Registry({ file: serversFile })
    await registry.create(serverInput())
    const surface = new ToolSurface({ registry, pool: new FakePool() as any, jobs })
    const tools = toolsOf(surface)
    const agent = fakeAgent()
    const started = await tools
      .get('srv_exec')
      .execute({ server: 'srv-01', command: 'sleep 300', async: true }, toolExec(agent))
    await new Promise((resolve) => setTimeout(resolve, 10))

    // The owner recorded on the job is the calling session, so the same session
    // must be able to collect it. Reading is the decisive assertion: it is what
    // used to throw "belongs to another session".
    const text = await call(tools.get('srv_job_output'), { jobId: String(started.jobId) }, toolExec(agent))
    assert.doesNotMatch(text, /another session/)
    // kill() also consults the owner. The fake job here may already be settled
    // (FakePool resolves immediately), and either outcome is fine — what matters
    // is that the call is not rejected as foreign.
    const killed = await call(tools.get('srv_job_kill'), { jobId: String(started.jobId) }, toolExec(agent))
    assert.match(killed, /cancellation|already finished/)

    // A different session is still fenced out — the fix must not open the job up
    // to everyone.
    await assert.rejects(
      tools.get('srv_job_output').execute({ jobId: String(started.jobId) }, toolExec({ id: 'session-2', session: { id: 'session-2' } })),
      /belongs to another session|another session/,
    )
  })
})

describe('§5.2 server addressing', () => {
  test('an exact id, an exact name and a unique prefix all resolve', async () => {
    const { surface } = await fixture()
    const tool = toolsOf(surface).get('srv_policy_check')
    for (const query of ['srv-01', '生产机-A', 'srv-0', '生产']) {
      const text = await call(tool, { server: query, command: 'echo hi' })
      assert.match(text, /ALLOW on srv-01/, query)
    }
  })

  test('an unknown server lists every configured server (§5.2 rule 4)', async () => {
    const { surface } = await fixture()
    await assert.rejects(
      call(toolsOf(surface).get('srv_exec'), { server: 'nope', command: 'echo hi' }),
      (error: unknown) => {
        assert.ok(error instanceof ToolError)
        assert.equal(error.code, 'UNKNOWN_SERVER')
        assert.match(error.message, /srv-01/)
        assert.match(error.message, /生产机-A/)
        return true
      },
    )
  })

  test('an ambiguous prefix lists the candidates (§5.2 rule 5)', async () => {
    const registry = new Registry({ file: serversFile })
    await registry.create(serverInput({ name: '生产机-A' }))
    await registry.create(serverInput({ name: '生产机-B', host: '10.0.0.6' }))
    const surface = new ToolSurface({ registry, pool: new FakePool() as any })
    await assert.rejects(
      call(toolsOf(surface).get('srv_exec'), { server: '生产机', command: 'echo hi' }),
      (error: unknown) => {
        assert.equal((error as ToolError).code, 'AMBIGUOUS_SERVER')
        assert.match((error as Error).message, /srv-01/)
        assert.match((error as Error).message, /srv-02/)
        return true
      },
    )
  })
})

describe('§5.5 error types', () => {
  test('every §5.5 code is a ToolError code the pool can raise', () => {
    const codes = [
      'CONNECT_FAILED',
      'HOST_KEY_UNKNOWN',
      'AUTH_FAILED',
      'NO_CREDENTIAL',
      'TIMEOUT',
      'INVALID_ARGUMENT',
    ]
    for (const code of codes) {
      const normalized = normalizePoolFailure(Object.assign(new Error('boom'), { code }))
      assert.equal(normalized.code, code, code)
      assert.match(normalized.message, new RegExp(`^${code}: `))
    }
  })

  test('an unrecognised transport failure becomes CONNECT_FAILED with a next step', () => {
    const normalized = normalizePoolFailure(new Error('socket hang up'))
    assert.equal(normalized.code, 'CONNECT_FAILED')
    assert.match(normalized.message, /Retry; if it persists/)
  })

  test('a ToolError passes through unchanged', () => {
    const original = new ToolError('POLICY_BLOCKED', 'blocked')
    assert.equal(normalizePoolFailure(original), original)
  })

  test('statusLine distinguishes success, a nonzero exit and a timeout', () => {
    assert.equal(statusLine({ exitCode: 0 }), 'exit 0')
    assert.match(statusLine({ exitCode: 2 }), /exit 2 \(EXIT_NONZERO\)/)
    assert.match(statusLine({ exitCode: 137, timedOut: true }), /^TIMEOUT/)
  })

  test('renderChunks keeps stdout and stderr separable', () => {
    assert.equal(renderChunks([{ text: 'a\n' }, { text: 'b\n' }]), 'a\nb\n')
    assert.equal(renderChunks([{ text: 'a' }, { text: 'err', channel: 'stderr' }]), 'a\n[stderr]\nerr')
    assert.equal(renderChunks([]), '')
  })

  test('the approval reason always carries rule, server and command', () => {
    const reason = approvalReason({
      ruleId: 'service-restart',
      ruleLabel: '重启服务',
      server: { id: 'srv-01', name: '生产机-A' } as never,
      command: 'systemctl restart app',
    })
    assert.match(reason, /rule service-restart/)
    assert.match(reason, /重启服务/)
    assert.match(reason, /生产机-A \(srv-01\)/)
    assert.match(reason, /systemctl restart app/)
  })

  test('the effective policy falls back to ask when nothing can be read', () => {
    assert.equal(approvalPolicyOf(null, undefined), 'ask')
    assert.equal(approvalPolicyOf({ config: { policy: 'never' } }, undefined), 'never')
    assert.equal(approvalPolicyOf({ config: { policy: 'never' }, overrideOf: () => 'ask' }, fakeAgent()), 'ask')
    assert.equal(
      approvalPolicyOf(
        {
          config: { policy: 'ask' },
          overrideOf: () => {
            throw new Error('no session')
          },
        },
        fakeAgent(),
      ),
      'ask',
    )
  })
})
