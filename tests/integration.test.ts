// Integration tests: the real units wired together, with no doubles in the path
// that matters (design doc §6.1, §9.6).
//
// Run with: node --test tests/integration.test.ts   (Node strips types natively)
// or:       npm test
//
// The unit suites (tools.test.ts, pending.test.ts) prove each module's contract
// against doubles. This file proves the *composition*: a real in-process SSH
// server, the real ssh2 Pool, the real Registry, the real AuditLog and the real
// `@deepseek-ai/dsh-user-approval` service, driven through the registered tool
// definitions exactly as the model would call them.
//
// The decisive assertions are the negative ones — the ones a mock cannot make:
//
//   - a blocked command leaves the SSH server's connection counter untouched;
//   - a rejected confirmation likewise never dials;
//   - under the real service's `never` policy, no answerer is consulted at all.
//
// The in-process server executes commands with a real `/bin/sh -c`, so the
// accept path runs real processes on this machine rather than pretending to.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, beforeEach, describe, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import ssh2 from 'ssh2'

import { AuditLog } from '../lib/audit.js'
import { KnownHosts } from '../lib/known-hosts.js'
import { createPendingApplier, PendingQueue } from '../lib/pending.js'
import { Pool } from '../lib/pool.js'
import { Registry } from '../lib/registry.js'
import { renderServerSection, ToolSurface } from '../lib/tools.js'

const { Server, utils } = ssh2

let directory: string
let serversFile: string
let knownHostsFile: string
let auditFile: string

/**
 * Key material generated once. `ssh2`'s generator occasionally emits a blob its
 * own parser rejects, so every candidate is validated before use (the pool suite
 * documents the same hazard).
 */
const FIXTURES = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-integration-fixtures-'))
  const keyPair = () => {
    for (;;) {
      const pair = utils.generateKeyPairSync('ed25519')
      const parsed = utils.parseKey(pair.private)
      if (!(parsed instanceof Error) && parsed !== null) return pair
    }
  }
  const user = keyPair()
  const privateKeyPath = join(dir, 'id_ed25519')
  writeFileSync(privateKeyPath, user.private, { mode: 0o600 })
  return { dir, privateKeyPath, user, hostKey: () => keyPair().private }
})()

process.on('exit', () => {
  try {
    rmSync(FIXTURES.dir, { recursive: true, force: true })
  } catch {
    // Best effort: a leftover temp dir is harmless.
  }
})

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-integration-'))
  serversFile = join(directory, 'servers.json')
  knownHostsFile = join(directory, 'known_hosts.json')
  auditFile = join(directory, 'audit.log')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/**
 * A real SSH server that executes commands with `/bin/sh -c`. It counts
 * connections and remembers the commands it received, which is how these tests
 * prove that a gate stopped *before* the network.
 */
class RealSshServer {
  /** @type {any} */
  #server
  port = 0
  connections = 0
  /** @type {string[]} */
  commands: string[] = []
  /** @type {Set<any>} */
  clients = new Set<any>()
  /** @type {Set<import('node:net').Socket>} */
  sockets = new Set<import('node:net').Socket>()
  /** @type {Set<import('node:child_process').ChildProcess>} */
  children = new Set<import('node:child_process').ChildProcess>()
  hostKey: string

  constructor() {
    this.hostKey = FIXTURES.hostKey()
    this.#server = new Server({ hostKeys: [this.hostKey] }, (/** @type {any} */ client) => {
      this.connections += 1
      this.clients.add(client)
      client.on('close', () => this.clients.delete(client))
      client.on('error', () => {})
      client.on('authentication', (/** @type {any} */ ctx) => {
        if (ctx.method === 'publickey') return ctx.accept()
        if (ctx.method === 'none') return ctx.reject(['publickey'])
        ctx.reject()
      })
      client.on('ready', () => {
        client.on('session', (/** @type {any} */ acceptSession: () => any) => {
          const session = acceptSession()
          session.on('exec', (/** @type {any} */ acceptExec: () => any, _reject: any, info: any) => {
            this.commands.push(info.command)
            const stream = acceptExec()
            // `detached` gives the command its own process group so closing the
            // channel can kill the whole tree, the way a real sshd does. Without
            // it SIGKILL only reaches the outer `sh`, and the `setsid` command it
            // started survives holding this process's stdio open.
            const child = spawn('/bin/sh', ['-c', info.command], {
              stdio: ['ignore', 'pipe', 'pipe'],
              detached: true,
            })
            this.children.add(child)
            child.on('exit', () => this.children.delete(child))
            child.stdout.on('data', (chunk: Buffer) => stream.write(chunk))
            child.stderr.on('data', (chunk: Buffer) => stream.stderr.write(chunk))
            // A real sshd accepts a channel signal request and forwards the
            // signal to the command. Without the `accept` callback ssh2 never
            // reports the request, so the pool's cancellation could not be
            // observed here at all.
            session.on('signal', (/** @type {any} */ acceptSignal: () => void, rejectSignal: any, info: any) => {
              acceptSignal()
              if (child.pid === undefined) return
              try {
                process.kill(child.pid, info.name)
              } catch {
                // Already exited.
              }
            })
            // And a closed channel hangs up on the session, as sshd does. Its
            // SIGHUP lets the script's own trap kill the process group; that is
            // the behaviour the cancellation test is checking.
            const killChild = () => {
              if (child.pid === undefined) return
              try {
                process.kill(child.pid, 'SIGHUP')
              } catch {
                // Already exited.
              }
            }
            stream.on('close', killChild)
            stream.on('error', killChild)
            child.on('close', (code: number | null, signal: string | null) => {
              if (signal !== null) stream.exit(signal)
              else stream.exit(code ?? 1)
              stream.end()
            })
          })
        })
      })
    })
    // The raw net socket is what `Server.close()` actually waits for; a
    // Connection object cannot destroy it, so track both levels.
    this.#server.on('connection', (/** @type {import('node:net').Socket} */ socket: import('node:net').Socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
    })
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject)
      this.#server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = this.#server.address()
    if (address === null || typeof address === 'string') throw new Error('server has no port')
    this.port = address.port
  }

  /**
   * Stop listening and drop every live client.
   *
   * Dropping them is not cosmetic: ssh2's `Server.close()` waits for open
   * connections, and a test-context `after` hook runs before the later-registered
   * pool disposal, so a leaked socket would hang the suite instead of failing it.
   */
  /**
   * Stop listening and drop every live connection *hard*.
   *
   * `Server.close()` only calls back once every connection is gone, so a socket
   * a test forgot to release would hang the suite instead of failing it.
   * Destroying the underlying socket is what makes the callback fire.
   */
  async close(): Promise<void> {
    for (const client of this.clients) {
      try {
        client.end()
      } catch {
        // Already gone.
      }
    }
    this.clients.clear()
    // Any command still running belongs to a test that has ended. Reap it,
    // descendants included: the pool's script runs the command under `setsid`,
    // which *by design* escapes its parent's process group, so a plain group
    // kill would miss it. A survivor keeps this process's stdio open and turns
    // a green suite into a hung runner.
    for (const child of this.children) reap(child)
    this.children.clear()
    for (const socket of this.sockets) {
      try {
        socket.destroy()
      } catch {
        // Already gone.
      }
    }
    this.sockets.clear()
    await new Promise<void>((resolve) => this.#server.close(() => resolve()))
  }
}

/**
 * Start a real SSH server for one test and register its cleanup on the test
 * context.
 * @param {import('node:test').TestContext} t
 * @returns {Promise<RealSshServer>}
 */
async function serveSsh(t: import('node:test').TestContext): Promise<RealSshServer> {
  const server = new RealSshServer()
  await server.listen()
  return server
}

/**
 * The real component stack over one running SSH server.
 * @param {import('node:test').TestContext} t
 * @param {RealSshServer} server
 */
async function stack(t: import('node:test').TestContext, server: RealSshServer) {
  const registry = new Registry({ file: serversFile })
  await registry.create({
    name: '生产机-A',
    host: '127.0.0.1',
    port: server.port,
    username: 'probe',
    auth: { kind: 'key', privateKeyPath: FIXTURES.privateKeyPath },
    hostKeyMode: 'accept-new',
    defaultWorkDir: null,
  })
  const pool = new Pool({ knownHosts: new KnownHosts({ file: knownHostsFile }), commandTimeoutMs: 20000 })
  // One ordered teardown: release the client sockets first, then stop the
  // server. Two independent hooks would be enough here, but a single one makes
  // the order explicit — `Server.close()` waits for its connections, so the
  // client side must go first.
  t.after(async () => {
    await pool.dispose()
    await server.close()
  })
  const audit = new AuditLog({ file: auditFile })
  return { registry, pool, audit }
}

/**
 * An ApprovalService over a session double that behaves like the real log.
 * @param {'ask'|'never'} [policy]
 */
function approvalService(policy: 'ask' | 'never' = 'ask') {
  const ctx = new Context()
  const service = new ApprovalService(ctx, { policy })
  const events: { type: string, data: any }[] = [{ type: 'turn/start', data: {} }]
  const session = {
    get events() {
      return events
    },
    append(type: string, data: any) {
      events.push({ type, data })
    },
    id: 'session-1',
  }
  const agent = { id: 'session-1', session }
  /** Answer the service's waterfall as an interactive UI would. */
  const answer = (outcome: string) => {
    ctx.waterfall = async () => outcome
  }
  return { ctx, service, events, agent, answer }
}

/**
 * Register the tools on a fake ctx and index them by name.
 * @param {ToolSurface} surface
 * @returns {Map<string, any>}
 */
function toolsOf(surface: ToolSurface): Map<string, any> {
  const tools = new Map<string, any>()
  surface.register({
    tools: { register: (definition: any) => void tools.set(definition.name, definition) },
  } as any)
  return tools
}

function toolExec(agent?: any) {
  return {
    callId: 'call-1',
    name: 'srv_exec',
    arguments: {},
    signal: new AbortController().signal,
    ...(agent === undefined ? {} : { agent }),
  }
}

/** Render a tool result the way the model receives it. */
async function call(tool: any, args: any, exec: any = toolExec()): Promise<string> {
  const value = await tool.execute(args, exec)
  return tool.output
    .render(args, value)
    .map((block: any) => block.text)
    .join('\n')
}

/**
 * SIGKILL a process and every descendant of it.
 *
 * `setsid` deliberately puts the command in its own session, so neither a group
 * kill (`-pid`) nor `SIGHUP` to the parent reaches it reliably; walking the
 * process tree is the only way to be sure nothing survives teardown.
 * @param {import('node:child_process').ChildProcess} child
 */
function reap(child: import('node:child_process').ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return
  /** @type {number[]} */
  let victims = []
  try {
    const listing = spawnSync('ps', ['-eo', 'pid,ppid'], { encoding: 'utf8' })
    /** @type {Map<number, number[]>} */
    const children = new Map()
    for (const line of String(listing.stdout ?? '').trim().split('\n').slice(1)) {
      const [rawPid, rawParent] = line.trim().split(/\s+/)
      const childPid = Number(rawPid)
      const parentPid = Number(rawParent)
      if (!Number.isInteger(childPid) || !Number.isInteger(parentPid)) continue
      if (!children.has(parentPid)) children.set(parentPid, [])
      children.get(parentPid)?.push(childPid)
    }
    // Breadth-first so every descendant is collected before anything dies.
    const queue = [pid]
    while (queue.length > 0) {
      const current = queue.shift()
      if (current === undefined) break
      victims.push(current)
      for (const next of children.get(current) ?? []) queue.push(next)
    }
  } catch {
    victims = [pid]
  }
  for (const victim of victims.reverse()) {
    try {
      process.kill(victim, 'SIGKILL')
    } catch {
      // Already exited.
    }
  }
}

/**
 * Running processes whose command line mentions `needle`, excluding the shells
 * the pool itself uses to start them.
 *
 * The probe script always contains the command, so the outer `sh -c` and the
 * `setsid sh -c` wrapper match the needle by construction. What matters is
 * whether the *command* is still alive, so those wrappers are filtered out and
 * only the real process survives the filter.
 */
function psMentions(needle: string): string[] {
  const result = spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8' })
  return String(result.stdout ?? '')
    .split('\n')
    .filter((line) => line.includes(needle))
    .filter((line) => !line.includes('ps -eo'))
    // The wrappers exist even once the command is dead; they are the harness,
    // not the process under test.
    .filter((line) => !/^\S*sh -c (trap|setsid)/.test(line.trim()))
    .filter((line) => !line.trim().endsWith(needle) === false)
}

describe('gate ① over a real server: a block never dials (§6.1, §9.6)', () => {
  test('POLICY_BLOCKED leaves the SSH server with zero connections', async (t) => {
    const server = await serveSsh(t)
    const { registry, pool, audit } = await stack(t, server)
    const surface = new ToolSurface({ registry, pool, audit })
    const before = server.connections

    await assert.rejects(
      call(toolsOf(surface).get('srv_exec'), { server: 'srv-01', command: 'rm -rf /tmp/dsh-integration-nothing' }),
      (error: unknown) => {
        assert.match(String((error as Error).message), /^POLICY_BLOCKED: /)
        assert.match((error as Error).message, /rm-recursive/)
        return true
      },
    )

    // The whole point of gate ①: the socket was never opened and no command
    // reached the host.
    assert.equal(server.connections, before)
    assert.deepEqual(
      server.commands.filter((command) => command.includes('dsh-integration-nothing')),
      [],
    )
  })

  test('the blocked attempt is still in audit.log (§6.2)', async (t) => {
    const server = await serveSsh(t)
    const { registry, pool, audit } = await stack(t, server)
    const surface = new ToolSurface({ registry, pool, audit })
    await assert.rejects(
      call(toolsOf(surface).get('srv_exec'), { server: 'srv-01', command: 'rm -rf /tmp/dsh-integration-audit' }),
    )
    const [record] = await audit.tail(5)
    assert.equal(record?.decision, 'block')
    assert.equal(record?.approved, null)
    assert.equal(record?.serverId, 'srv-01')
  })

  test('srv_policy_check reports block without connecting either', async (t) => {
    const server = await serveSsh(t)
    const { registry, pool } = await stack(t, server)
    const surface = new ToolSurface({ registry, pool })
    const before = server.connections
    const text = await call(toolsOf(surface).get('srv_policy_check'), { server: 'srv-01', command: 'rm -rf /x' })
    assert.match(text, /BLOCK/)
    assert.equal(server.connections, before)
  })
})

describe('gate ② with the real approval service (§6.1, §9.6)', () => {
  test('allowed-once executes on the remote host and records the approval', async (t) => {
    const server = await serveSsh(t)
    const { registry, pool, audit } = await stack(t, server)
    const { service, agent, answer, events } = approvalService('ask')
    answer('allowed-once')
    const surface = new ToolSurface({ registry, pool, audit, approval: service })

    // `systemctl restart` matches the service-restart rule (§4.1) and is still
    // harmless here: the assertion is that it ran only *after* the grant.
    const text = await call(
      toolsOf(surface).get('srv_exec'),
      { server: 'srv-01', command: 'systemctl restart dsh-integration-test; echo approved-run' },
      toolExec(agent),
    )
    assert.match(text, /approved by user/)
    assert.match(text, /approved-run/)
    assert.ok(server.commands.some((command) => command.includes('dsh-integration-test')))

    // The real service logged the pair, and the reason reached it intact.
    const asked = events.find((event) => event.type === 'approval/asked')
    assert.ok(asked)
    const askedData = asked!.data as { toolName: string, reason: string }
    assert.equal(askedData.toolName, 'srv_exec')
    assert.match(askedData.reason, /service-restart/)
    assert.match(askedData.reason, /生产机-A/)
    assert.match(askedData.reason, /systemctl/)
    const decided = events.find((event) => event.type === 'approval/decided')
    assert.equal((decided!.data as { outcome: string }).outcome, 'allowed-once')
  })

  test('a rejection runs nothing on the host', async (t) => {
    const server = await serveSsh(t)
    const { registry, pool, audit } = await stack(t, server)
    const { service, agent, answer } = approvalService('ask')
    answer('rejected')
    const surface = new ToolSurface({ registry, pool, audit, approval: service })
    const before = server.connections

    await assert.rejects(
      call(toolsOf(surface).get('srv_exec'), { server: 'srv-01', command: 'systemctl restart never-runs' }, toolExec(agent)),
      /POLICY_DENIED_BY_USER/,
    )
    assert.equal(server.connections, before)
    assert.deepEqual(
      server.commands.filter((command) => command.includes('never-runs')),
      [],
    )
  })

  test("the real service's 'never' policy rejects without consulting any answerer", async (t) => {
    const server = await serveSsh(t)
    const { registry, pool, audit } = await stack(t, server)
    const { service, agent, ctx } = approvalService('never')
    let consulted = 0
    // If the service prompted at all, this would run and grant the command.
    ctx.waterfall = async () => {
      consulted += 1
      return 'allowed-once'
    }
    const surface = new ToolSurface({ registry, pool, audit, approval: service })
    const before = server.connections

    await assert.rejects(
      call(toolsOf(surface).get('srv_exec'), { server: 'srv-01', command: 'systemctl restart x' }, toolExec(agent)),
      (error: unknown) => {
        assert.match((error as Error).message, /POLICY_DENIED_BY_USER/)
        assert.match((error as Error).message, /当前会话审批策略为 never/)
        return true
      },
    )

    // §6.1 fail-closed: no prompt was shown, and nothing ran.
    assert.equal(consulted, 0)
    assert.equal(server.connections, before)
  })

  test('an allow command never touches the approval service', async (t) => {
    const server = await serveSsh(t)
    const { registry, pool } = await stack(t, server)
    const { service, agent, ctx } = approvalService('ask')
    let consulted = 0
    ctx.waterfall = async () => {
      consulted += 1
      return 'rejected'
    }
    const surface = new ToolSurface({ registry, pool, approval: service })
    const text = await call(toolsOf(surface).get('srv_exec'), { server: 'srv-01', command: 'echo plain-allow' }, toolExec(agent))
    assert.match(text, /plain-allow/)
    assert.equal(consulted, 0)
  })
})

describe('gate ③ over a real server: execution details (§5.4, §7.3)', () => {
  test('a real command returns its exit code, stdout and stderr split', async (t) => {
    const server = await serveSsh(t)
    const { registry, pool, audit } = await stack(t, server)
    const surface = new ToolSurface({ registry, pool, audit })
    const text = await call(toolsOf(surface).get('srv_exec'), {
      server: 'srv-01',
      command: 'echo out-line; echo err-line >&2',
    })
    assert.match(text, /exit 0/)
    assert.match(text, /out-line/)
    assert.match(text, /\[stderr\]\nerr-line/)
  })

  test('a nonzero exit is a result, not a thrown error (§5.5)', async (t) => {
    const server = await serveSsh(t)
    const { registry, pool } = await stack(t, server)
    const surface = new ToolSurface({ registry, pool })
    const value = await toolsOf(surface).get('srv_exec').execute({ server: 'srv-01', command: 'exit 3' }, toolExec())
    assert.equal(value.exitCode, 3)
    assert.equal(value.code, 'EXIT_NONZERO')
  })

  test('cwd actually changes the remote working directory', async (t) => {
    const server = await serveSsh(t)
    const { registry, pool } = await stack(t, server)
    const surface = new ToolSurface({ registry, pool })
    const text = await call(toolsOf(surface).get('srv_exec'), { server: 'srv-01', command: 'pwd', cwd: '/tmp' })
    assert.match(text, /\/tmp/)
  })

  test('timeoutMs kills the remote process group and reports TIMEOUT (§9.6)', async (t) => {
    const server = await serveSsh(t)
    const { registry, pool } = await stack(t, server)
    const surface = new ToolSurface({ registry, pool })
    const marker = `dsh-sleep-${process.pid}-${Date.now()}`
    const startedAt = Date.now()
    const value = await toolsOf(surface)
      .get('srv_exec')
      .execute({ server: 'srv-01', command: `sleep 30 # ${marker}`, timeoutMs: 1500 }, toolExec())
    const elapsed = Date.now() - startedAt
    assert.equal(value.code, 'TIMEOUT')
    // A watchdog, not a wall clock: it must return near the budget, not at 30 s.
    assert.ok(elapsed < 10000, `elapsed ${elapsed} ms`)
    // The direct proof of §7.3: nothing named after this run survives.
    assert.deepEqual(psMentions(marker), [])
  })

  test('the connection is reused across calls (§7.2)', async (t) => {
    const server = await serveSsh(t)
    const { registry, pool } = await stack(t, server)
    const surface = new ToolSurface({ registry, pool })
    const tool = toolsOf(surface).get('srv_exec')
    const before = server.connections
    await tool.execute({ server: 'srv-01', command: 'echo one' }, toolExec())
    await tool.execute({ server: 'srv-01', command: 'echo two' }, toolExec())
    assert.equal(server.connections - before, 1)
  })
})

describe('streaming and incremental output (§5.4)', () => {
  test('execStream forwards chunks as they arrive and returns the whole result', async (t) => {
    const server = await serveSsh(t)
    const { registry, pool } = await stack(t, server)
    const [record] = await registry.list()
    const chunks: { channel: string, text: string }[] = []
    const result = await pool.execStream(record!, {
      command: 'echo first; sleep 0.2; echo second',
      onChunk: (channel: 'stdout' | 'stderr', text: string) => chunks.push({ channel, text }),
    })
    assert.equal(result.exitCode, 0)
    assert.match(result.stdout, /first/)
    assert.match(result.stdout, /second/)
    assert.ok(chunks.length > 0)
    assert.ok(chunks.every((chunk) => chunk.channel === 'stdout'))
    assert.match(chunks.map((chunk) => chunk.text).join(''), /first[\s\S]*second/)
  })

  test('the cancel handle resolves a running command promptly', async (t) => {
    const server = await serveSsh(t)
    const { registry, pool } = await stack(t, server)
    const [record] = await registry.list()
    /** @type {(() => void)|null} */
    let cancel = null
    const startedAt = Date.now()
    const streaming = pool.execStream(record!, {
      // The budget is short on purpose: it bounds how long the remote command
      // (which cannot be signalled through this in-process double) may outlive
      // teardown. Killing the remote process group on cancellation is proven
      // directly against `buildWatchdogScript` in tests/pool.test.ts, where no
      // ssh2 layer sits between the signal and the shell.
      command: 'sleep 30',
      timeoutMs: 2000,
      onCancel: (handle: () => void) => {
        cancel = handle
      },
    })
    // Let the channel open, then kill it.
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.ok(cancel !== null, 'onCancel was called')
    ;(cancel as () => void)()
    const result = await streaming
    assert.equal(result.cancelled, true)
    assert.ok(Date.now() - startedAt < 1500, `cancellation is prompt (${Date.now() - startedAt} ms)`)
  })

  test('output past maxOutputChars is cut and flagged', async (t) => {
    const server = await serveSsh(t)
    const { registry, pool } = await stack(t, server)
    const [record] = await registry.list()
    const result = await pool.execStream(record!, {
      command: 'yes x | head -c 200000',
      maxOutputChars: 500,
    })
    assert.equal(result.truncated, true)
    assert.ok(result.stdout.length <= 600, `length ${result.stdout.length}`)
    assert.match(result.stdout, /TRUNCATED/)
  })
})

describe('the pending queue against a real registry (§8.3)', () => {
  test('a delete request leaves the server usable until it is confirmed', async (t) => {
    const server = await serveSsh(t)
    const { registry, pool, audit } = await stack(t, server)
    const pending = new PendingQueue({
      file: join(directory, 'pending.json'),
      apply: createPendingApplier({ registry, pool, audit }),
    })
    const surface = new ToolSurface({ registry, pool })
    const [record] = await registry.list()

    const { record: request } = await pending.request({
      kind: 'delete-server',
      serverId: record!.id,
      snapshot: record,
    })
    // Still there and still working while the request is pending.
    assert.equal((await registry.list()).length, 1)
    const text = await call(toolsOf(surface).get('srv_exec'), { server: record!.id, command: 'echo still-here' })
    assert.match(text, /still-here/)

    await pending.confirm(request.id)
    assert.deepEqual(await registry.list(), [])
    const records = await audit.tail(20)
    assert.ok(records.some((entry) => entry.event === 'server-deleted'))

    // The deleted server is gone from the tool surface too.
    await assert.rejects(
      call(toolsOf(surface).get('srv_exec'), { server: record!.id, command: 'echo hi' }),
      /UNKNOWN_SERVER/,
    )
  })

  test('a cancelled host-key change leaves the original mode in place', async (t) => {
    const server = await serveSsh(t)
    const { registry } = await stack(t, server)
    const pending = new PendingQueue({
      file: join(directory, 'pending.json'),
      apply: createPendingApplier({ registry }),
    })
    const [record] = await registry.list()
    const { record: request } = await pending.request({ kind: 'disable-hostkey', serverId: record!.id })
    assert.equal((await registry.get(record!.id))?.hostKeyMode, 'accept-new')
    await pending.cancel(request.id)
    assert.equal((await registry.get(record!.id))?.hostKeyMode, 'accept-new')
  })
})

describe('the §5.3 prompt reflects the real registry', () => {
  test('the section names the server exactly as the spec draws it', async (t) => {
    const server = await serveSsh(t)
    const { registry, pool } = await stack(t, server)
    const surface = new ToolSurface({ registry, pool })
    await surface.refresh()
    const text = renderServerSection(surface.servers)
    const [record] = await registry.list()
    assert.ok(
      text.includes(`- ${record!.id}  生产机-A   probe@127.0.0.1:${server.port}   默认目录 （无默认目录）`),
      text,
    )
  })
})

// Last-resort teardown: every server and pool is disposed by its own test, so
// nothing may still be listening here. A leak would hang the runner; failing
// loudly is the useful outcome.
after(async () => {
  // Give the sockets one turn to finish closing before judging.
  await new Promise((resolve) => setTimeout(resolve, 100))
  type Handle = { constructor: { name: string }, localPort?: number, remotePort?: number, hasRef?: () => boolean }
  const handles = (process as unknown as { _getActiveHandles(): Handle[] })._getActiveHandles()
  const live = handles
    .filter((handle) => ['Server', 'Socket', 'TLSSocket'].includes(handle.constructor?.name))
    .filter((handle) => handle.hasRef?.() === true)
  assert.deepEqual(
    live.map((handle) => `${handle.constructor?.name}:${handle.localPort ?? '-'}:${handle.remotePort ?? '-'}`),
    [],
  )
})
