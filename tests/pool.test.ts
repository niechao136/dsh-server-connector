// Tests for the SSH connection pool (design doc §7).
//
// Run with: node --test tests/pool.test.ts   (Node strips the types natively)
// or:       npm test
//
// Two layers, because they answer different questions:
//
// 1. **In-process SSH server** (`ssh2`'s own `Server`): every fast test runs
//    everywhere, including CI without Docker. The server executes commands with
//    a real `/bin/sh -c`, so the watchdog, the exit codes and the process-group
//    kill are exercised for real — they just run on this machine instead of a
//    container.
// 2. **sshd container** (integration, skipped when Docker is unavailable): a real
//    OpenSSH server, which is the only way to prove the §9.6 acceptance item
//    "timeout kills the remote process group" against OpenSSH's actual channel
//    and process-group behaviour. The container tests never mock anything.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'

const { Server, utils } = ssh2

// ssh2 is CommonJS without named ESM exports, so the whole namespace comes in
// through the default import (lib/pool.js does the same).
import ssh2 from 'ssh2'

import { KnownHosts } from '../lib/known-hosts.js'
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  Pool,
  PoolError,
  buildRemoteScript,
  buildWatchdogScript,
  decideHostKey,
  normalizeError,
  shellQuote,
  TRUNCATED_MARKER,
} from '../lib/pool.js'
import type { ServerRecord } from '../lib/registry.js'

let directory: string
let knownHostsFile: string

/**
 * Key material shared by every fake server in this file, generated once.
 *
 * Generating per test and writing with `void writeFile(...)` was a race (the
 * first connect could read a file that was still being written), and ssh2's
 * key generator occasionally emits a blob its own parser rejects, so the keys
 * are produced once, validated with `utils.parseKey`, and written
 * synchronously before any test starts.
 */
const FIXTURES = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pool-fixtures-'))
  /** @returns {{private: string, public: string}} */
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
  return {
    dir,
    privateKeyPath,
    user,
    /** A fresh host key for one fake server (each needs its own fingerprint). */
    hostKey: () => keyPair().private,
  }
})()

process.on('exit', () => {
  try {
    rmSync(FIXTURES.dir, { recursive: true, force: true })
  } catch {
    // Best effort: a leftover temp dir is harmless.
  }
})

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-pool-'))
  knownHostsFile = join(directory, 'known_hosts.json')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** A complete server record pointing at `port`, with a key auth for `privateKeyPath`. */
function record(overrides: Partial<ServerRecord> & { id?: string } = {}): ServerRecord {
  return {
    id: 'srv-01',
    name: 'probe',
    host: '127.0.0.1',
    port: 22,
    username: 'probe',
    auth: { kind: 'key', privateKeyPath: FIXTURES.privateKeyPath },
    hostKeyMode: 'accept-new',
    defaultWorkDir: null,
    policy: {},
    disabledRules: [],
    createdAt: '2026-11-04T09:00:00.000Z',
    lastConnectedAt: null,
    ...overrides,
  }
}

/** A `Pool` whose store is the real KnownHosts on this test's temp file. */
function createPool(options: ConstructorParameters<typeof Pool>[0] = {} as never): Pool {
  return new Pool({ knownHosts: new KnownHosts({ file: knownHostsFile }), ...options })
}

/**
 * One in-process SSH server executing commands with a real `/bin/sh -c`.
 * Records how many PTY requests arrived and how many connections were made.
 */
class FakeSshd {
  /** @type {any} */
  #server
  /** @type {string} */
  readonly userKey
  /** @type {string} */
  readonly privateKeyPath
  /** @type {string} */
  readonly hostKey
  port = 0
  connections = 0
  ptyRequests = 0
  /** @type {string[]} */
  commands: string[] = []
  /** @type {'publickey'|'password'|'none'} */
  authMode = 'publickey'
  /** @type {Set<any>} */
  clients = new Set<any>()
  /** Set to make the server drop every connection right after it opens. */
  dropConnections = false

  constructor() {
    this.hostKey = FIXTURES.hostKey()
    this.privateKeyPath = FIXTURES.privateKeyPath
    this.userKey = FIXTURES.user.public

    this.#server = new Server({ hostKeys: [this.hostKey] }, (/** @type {any} */ client) => {
      this.connections += 1
      this.clients.add(client)
      client.on('close', () => this.clients.delete(client))
      // A client that fails key exchange (a deliberately changed fingerprint,
      // a dropped socket) is expected here; without this listener the fake
      // server would throw on the EventEmitter's unhandled 'error'.
      client.on('error', () => {})
      client.on('authentication', (ctx) => {
        if (this.dropConnections) {
          client.end()
          return
        }
        if (this.authMode === 'password') {
          if (ctx.method === 'password' && ctx.password === 'secret') ctx.accept()
          else if (ctx.method === 'none') ctx.reject(['password'])
          else ctx.reject()
          return
        }
        if (ctx.method === 'publickey') return ctx.accept()
        if (ctx.method === 'none') return ctx.reject(['publickey'])
        ctx.reject()
      })
      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept()
          session.on('pty', (acceptPty: () => void) => {
            this.ptyRequests += 1
            acceptPty()
          })
          session.on(
            'exec',
            (acceptExec: () => any, reject: () => void, info: { command: string }) => {
              this.commands.push(info.command)
              const stream = acceptExec()
              const child = spawn('/bin/sh', ['-c', info.command], {
                stdio: ['ignore', 'pipe', 'pipe'],
              })
              child.stdout.on('data', (chunk: Buffer) => stream.write(chunk))
              // sshd carries stderr on the SSH "extended data" channel; the
              // fake server does the same so the pool's separation is real.
              child.stderr.on('data', (chunk: Buffer) => stream.stderr.write(chunk))
              child.on('error', () => {
                stream.exit(1)
                stream.end()
              })
              child.on('close', (code: number | null, signal: string | null) => {
                if (signal !== null) stream.exit(signal)
                else stream.exit(code ?? 1)
                stream.end()
              })
            },
          )
        })
      })
    })
  }

  /** Start listening on a free loopback port. */
  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject)
      this.#server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = this.#server.address()
    if (address === null || typeof address === 'string') throw new Error('server has no port')
    this.port = address.port
  }

  /** A record pointing at this server. */
  server(overrides: Partial<ServerRecord> & { id?: string } = {}): ServerRecord {
    return record({ port: this.port, ...overrides })
  }

  /** Drop every live client, simulating a network failure. */
  dropClients(): void {
    for (const client of this.clients) (/** @type {any} */ (client)).end()
    this.clients.clear()
  }

  async close(): Promise<void> {
    this.dropClients()
    await new Promise<void>((resolve) => this.#server.close(() => resolve()))
  }
}

/** Run `operation` and return the PoolError it must reject with. */
async function rejection(operation: Promise<unknown>): Promise<PoolError> {
  try {
    await operation
  } catch (error) {
    assert.ok(
      error instanceof PoolError,
      `expected a PoolError, got ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    )
    return error
  }
  assert.fail('expected the operation to reject')
}

describe('path helpers and defaults (§7.2, §7.3, §10)', () => {
  test('the idle timeout defaults to ten minutes', () => {
    assert.equal(DEFAULT_IDLE_TIMEOUT_MS, 600000)
    assert.equal(createPool().idleTimeoutMs, 600000)
    assert.equal(createPool({ idleTimeoutMs: 1500 } as never).idleTimeoutMs, 1500)
  })

  test('a pool without a known-hosts store is refused', () => {
    assert.throws(() => new Pool({} as never), /knownHosts/)
  })

  test('shellQuote keeps single quotes literal', () => {
    assert.equal(shellQuote('plain'), "'plain'")
    assert.equal(shellQuote("it's"), "'it'\\''s'")
    assert.equal(shellQuote('$(rm -rf /)'), "'$(rm -rf /)'")
  })

  test('the watchdog script carries the §7.3 shape', () => {
    const script = buildWatchdogScript('echo hi', 60000)
    assert.match(script, /^setsid sh -c 'echo hi' & child=\$!$/m)
    assert.match(script, /kill -KILL -\$child/)
    assert.match(script, /sleep 60;/)
    assert.match(script, /^wait \$child; rc=\$\?$/m)
    assert.match(script, /^kill \$watchdog 2>\/dev\/null$/m)
    assert.match(script, /^exit \$rc$/m)
  })

  test('the watchdog keeps its own output off the command channel', () => {
    // Without this redirect the watchdog `sleep` inherits the channel's stdout,
    // sshd waits for that pipe, and every command returns only at its timeout.
    assert.match(buildWatchdogScript('true', 1000), /kill -KILL -\$child 2>\/dev\/null \) >\/dev\/null 2>&1 & watchdog/)
  })

  test('sub-second timeouts are not rounded up to whole seconds', () => {
    assert.match(buildWatchdogScript('true', 1500), /sleep 1\.5;/)
    assert.match(buildWatchdogScript('true', 2000), /sleep 2;/)
  })

  test('cwd is prefixed on the remote side and only when present', () => {
    const without = buildRemoteScript('pwd', 1000, null)
    assert.equal(without.includes('cd '), false)
    const withCwd = buildRemoteScript('pwd', 1000, "/srv/a b's")
    assert.ok(withCwd.startsWith("cd '/srv/a b'\\''s' && {"))
    // The HUP trap is part of the body, so the watchdog proper starts on the
    // line after it (see the trap's docstring for why it exists).
    assert.match(without, /^trap 'kill -KILL -\$child 2>\/dev\/null; kill \$watchdog 2>\/dev\/null; exit 129' HUP TERM INT\nsetsid sh -c /)
  })
})

describe('host key verification (§6.4, §7.4)', () => {
  test('accept-new trusts and records an unknown host', () => {
    assert.deepEqual(decideHostKey({ mode: 'accept-new', known: null }, 'abc'), {
      accept: true,
      store: true,
      reason: 'accept-new',
    })
  })

  test('verify refuses an unknown host', () => {
    assert.deepEqual(decideHostKey({ mode: 'verify', known: null }, 'abc'), {
      accept: false,
      store: false,
      reason: 'unknown',
    })
  })

  test('a matching fingerprint is accepted without re-recording', () => {
    assert.deepEqual(decideHostKey({ mode: 'verify', known: { hash: 'abc' } }, 'abc'), {
      accept: true,
      store: false,
      reason: 'match',
    })
  })

  test('a changed fingerprint is refused even in accept-new', () => {
    assert.deepEqual(decideHostKey({ mode: 'accept-new', known: { hash: 'abc' } }, 'xyz'), {
      accept: false,
      store: false,
      reason: 'changed',
    })
  })

  test('off skips verification entirely', () => {
    assert.deepEqual(decideHostKey({ mode: 'off', known: { hash: 'abc' } }, 'xyz'), {
      accept: true,
      store: false,
      reason: 'disabled',
    })
  })
})

describe('error normalisation (§7.5)', () => {
  const context = { serverId: 'srv-01', host: '10.0.0.5', port: 22, username: 'devops' }

  test('ECONNREFUSED / ETIMEDOUT become CONNECT_FAILED with a next step', () => {
    for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND']) {
      const error = normalizeError(Object.assign(new Error('boom'), { code }), context)
      assert.equal(error.code, 'CONNECT_FAILED')
      assert.match(error.message, /sshd/)
      assert.equal(error.serverId, 'srv-01')
      assert.equal(error.host, '10.0.0.5')
    }
  })

  test('a handshake timeout becomes CONNECT_FAILED', () => {
    const error = normalizeError(Object.assign(new Error('Timed out while waiting for handshake'), { level: 'client-timeout' }), context)
    assert.equal(error.code, 'CONNECT_FAILED')
    assert.match(error.message, /10\.0\.0\.5:22/)
  })

  test('a refused authentication method becomes AUTH_FAILED', () => {
    const error = normalizeError(
      Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' }),
      context,
    )
    assert.equal(error.code, 'AUTH_FAILED')
    assert.match(error.message, /devops@10\.0\.0\.5:22/)
    assert.match(error.message, /username|key|password/)
  })

  test('an unreadable private key becomes AUTH_FAILED, not CONNECT_FAILED', () => {
    const error = normalizeError(
      Object.assign(new Error('ENOENT: no such file or directory, open privateKey'), { code: 'ENOENT' }),
      context,
    )
    assert.equal(error.code, 'AUTH_FAILED')
    assert.match(error.message, /private key/)
  })
})

describe('execution against an SSH server (§7.2, §7.3)', () => {
  let sshd: FakeSshd
  let pool: Pool

  beforeEach(async () => {
    sshd = new FakeSshd()
    await sshd.listen()
    pool = createPool()
  })

  afterEach(async () => {
    await pool.dispose()
    await sshd.close()
  })

  test('runs a command and reports exit code, stdout and stderr separately', async () => {
    const result = await pool.exec(sshd.server(), { command: 'echo out; echo err >&2; exit 4' })
    assert.equal(result.exitCode, 4)
    assert.equal(result.stdout, 'out\n')
    assert.equal(result.stderr, 'err\n')
    assert.equal(result.timedOut, false)
    assert.equal(result.truncated, false)
    assert.ok(result.durationMs >= 0)
  })

  test('never requests a PTY (§7.3)', async () => {
    await pool.exec(sshd.server(), { command: 'echo hi' })
    assert.equal(sshd.ptyRequests, 0)
  })

  test('runs the command in the requested cwd, on the remote side', async () => {
    const result = await pool.exec(sshd.server(), { command: 'pwd', cwd: directory })
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout.trim(), await realpathOf(directory))
  })

  test('falls back to the server defaultWorkDir, and a per-call cwd overrides it', async () => {
    const recordWithDir = sshd.server({ defaultWorkDir: '/tmp' })
    assert.equal((await pool.exec(recordWithDir, { command: 'pwd' })).stdout.trim(), await realpathOf('/tmp'))
    assert.equal(
      (await pool.exec(recordWithDir, { command: 'pwd', cwd: directory })).stdout.trim(),
      await realpathOf(directory),
    )
  })

  test('a missing cwd fails the command with the shell message', async () => {
    const result = await pool.exec(sshd.server(), { command: 'pwd', cwd: join(directory, 'nope') })
    assert.notEqual(result.exitCode, 0)
    assert.match(result.stderr, /nope/)
  })

  test('quotes arguments without letting them escape the remote command', async () => {
    const result = await pool.exec(sshd.server(), { command: "echo 'a b' \"c\"; echo $((1 + 1))" })
    assert.equal(result.stdout, 'a b c\n2\n')
  })

  test('reuses one connection for sequential commands (§7.2)', async () => {
    const server = sshd.server()
    await pool.exec(server, { command: 'echo one' })
    await pool.exec(server, { command: 'echo two' })
    await pool.exec(server, { command: 'echo three' })
    assert.equal(sshd.connections, 1)
    assert.equal(pool.isConnected(server.id), true)
    assert.deepEqual(pool.connectedServerIds(), [server.id])
  })

  test('runs commands for one server serially (§7.2)', async () => {
    const server = sshd.server()
    const order: string[] = []
    await Promise.all([
      pool.exec(server, { command: 'sleep 0.3; echo first' }).then(() => order.push('first')),
      pool.exec(server, { command: 'echo second' }).then(() => order.push('second')),
    ])
    assert.deepEqual(order, ['first', 'second'])
  })

  test('runs commands for different servers in parallel (§7.2)', async () => {
    const serverA = sshd.server({ id: 'srv-a' })
    const serverB = sshd.server({ id: 'srv-b' })
    const started = Date.now()
    await Promise.all([
      pool.exec(serverA, { command: 'sleep 0.6' }),
      pool.exec(serverB, { command: 'sleep 0.6' }),
    ])
    const elapsed = Date.now() - started
    assert.equal(sshd.connections, 2)
    assert.ok(elapsed < 1100, `two 600 ms commands should overlap, took ${elapsed} ms`)
  })

  test('a nonzero exit is reported as a result, not thrown (§5.4)', async () => {
    // The pool returns exitCode + streams; srv_exec (phase 4) is what turns a
    // nonzero exit into the ERROR_NONZERO-facing outcome for the model.
    const server = sshd.server()
    const failed = await pool.exec(server, { command: 'exit 9' })
    assert.equal(failed.exitCode, 9)
    assert.equal(failed.timedOut, false)
    assert.equal((await pool.exec(server, { command: 'echo still here' })).stdout, 'still here\n')
  })

  test('reconnects once when the connection dropped while idle (§7.2)', async () => {
    const server = sshd.server()
    await pool.exec(server, { command: 'echo one' })
    sshd.dropClients()
    await waitFor(() => pool.isConnected(server.id) === false)
    const result = await pool.exec(server, { command: 'echo two' })
    assert.equal(result.stdout, 'two\n')
    assert.equal(sshd.connections, 2)
  })

  test('reports CONNECT_FAILED when the server is gone and the retry also fails (§7.2)', async () => {
    const server = sshd.server()
    await pool.exec(server, { command: 'echo one' })
    const port = sshd.port
    // Stop listening: the remembered connection was closed with the server, so
    // the pool must dial once more, fail, and surface CONNECT_FAILED.
    const stopped = sshd
    await stopped.close()
    sshd = new FakeSshd() // keep the afterEach teardown valid
    await sshd.listen()
    const error = await rejection(pool.exec({ ...server, port }, { command: 'echo two' }))
    assert.ok(['CONNECT_FAILED', 'CONNECTION_LOST'].includes(error.code), error.code)
    assert.match(error.message, /sshd|Retry/)
  })

  test('reports CONNECT_FAILED for a port nothing listens on', async () => {
    const server = sshd.server({ port: await freePort() })
    const error = await rejection(pool.exec(server, { command: 'echo hi' }))
    assert.equal(error.code, 'CONNECT_FAILED')
    assert.match(error.message, /sshd is running/)
  })

  test('reports AUTH_FAILED when the server refuses every offered method', async () => {
    // The fake server only accepts publickey; offering a password leaves ssh2
    // with no method to try, which is the §7.5 "all methods failed" row.
    const server = sshd.server({ auth: { kind: 'password', credentialRef: 'ref' } })
    const error = await rejection(
      createPool({ resolvePassword: async () => 'wrong-password' } as never).exec(server, { command: 'echo hi' }),
    )
    assert.equal(error.code, 'AUTH_FAILED')
    assert.match(error.message, /Check the username/)
  })

  test('reports NO_CREDENTIAL when a password record has no stored secret (§6.3)', async () => {
    const server = sshd.server({ auth: { kind: 'password', credentialRef: 'server-connector:srv-01:password' } })
    const error = await rejection(pool.exec(server, { command: 'echo hi' }))
    assert.equal(error.code, 'NO_CREDENTIAL')
    assert.match(error.message, /credentialRef/)
  })

  test('uses an injected password resolver for password auth (§6.3)', async () => {
    sshd.authMode = 'password'
    const withPassword = createPool({ resolvePassword: async () => 'secret' } as never)
    try {
      const result = await withPassword.exec(
        sshd.server({ auth: { kind: 'password', credentialRef: 'ref' } }),
        { command: 'echo authed' },
      )
      assert.equal(result.stdout, 'authed\n')
    } finally {
      await withPassword.dispose()
    }
  })

  test('records an accept-new fingerprint on first connect (§6.4)', async () => {
    const store = new KnownHosts({ file: knownHostsFile })
    const server = sshd.server()
    await pool.exec(server, { command: 'echo hi' })
    const stored = await store.get(server.id)
    assert.notEqual(stored, null)
    assert.match(stored!.hash, /^[A-Za-z0-9+/]{43}=$/)
    assert.equal(stored!.algorithm, 'ssh-ed25519')
  })

  test('refuses a changed fingerprint with HOST_KEY_UNKNOWN (§6.4)', async () => {
    const store = new KnownHosts({ file: knownHostsFile })
    const server = sshd.server()
    await store.set(server.id, {
      hash: 'Ln0sA6lQeuJl7PW1NWiFpTOTogKdJBOUmXJloaJa78Y=',
      algorithm: 'ssh-ed25519',
    })
    const error = await rejection(pool.exec(server, { command: 'echo hi' }))
    assert.equal(error.code, 'HOST_KEY_UNKNOWN')
    assert.match(error.message, /changed/)
    assert.match(error.message, /known_hosts\.json/)
  })

  test('verify mode refuses an unknown host with HOST_KEY_UNKNOWN (§6.4)', async () => {
    const server = sshd.server({ hostKeyMode: 'verify' })
    const error = await rejection(pool.exec(server, { command: 'echo hi' }))
    assert.equal(error.code, 'HOST_KEY_UNKNOWN')
    assert.match(error.message, /not trusted yet/)
    assert.match(error.message, /accept-new/)
  })

  test('hostKeyMode off connects and records nothing (§6.4)', async () => {
    const store = new KnownHosts({ file: knownHostsFile })
    const server = sshd.server({ hostKeyMode: 'off' })
    await pool.exec(server, { command: 'echo hi' })
    assert.equal(await store.get(server.id), null)
  })

  test('an idle timeout does not close a connection that is in use (§7.2)', async () => {
    // The timer armed after the previous command must not fire mid-command and
    // close the socket the running command is using.
    const shortIdle = createPool({ idleTimeoutMs: 150 } as never)
    try {
      const server = sshd.server()
      await shortIdle.exec(server, { command: 'echo warm' })
      const result = await shortIdle.exec(server, { command: 'sleep 0.6; echo done' })
      assert.equal(result.stdout, 'done\n')
      assert.equal(sshd.connections, 1, 'the running command kept its connection')
    } finally {
      await shortIdle.dispose()
    }
  })

  test('a second command is not run concurrently with the first (§7.2)', async () => {
    // Guards the serial queue against the idle timer resetting it.
    const shortIdle = createPool({ idleTimeoutMs: 100 } as never)
    try {
      const server = sshd.server()
      await shortIdle.exec(server, { command: 'echo warm' })
      const order: string[] = []
      await Promise.all([
        shortIdle.exec(server, { command: 'sleep 0.4; echo first' }).then(() => order.push('first')),
        shortIdle.exec(server, { command: 'sleep 0.2; echo second' }).then(() => order.push('second')),
      ])
      assert.deepEqual(order, ['first', 'second'])
    } finally {
      await shortIdle.dispose()
    }
  })

  test('disconnect() waits for a running command instead of cutting it off (§8.3)', async () => {
    const server = sshd.server()
    const running = pool.exec(server, { command: 'sleep 0.4; echo finished' })
    const disconnecting = pool.disconnect(server.id)
    const result = await running
    await disconnecting
    assert.equal(result.stdout, 'finished\n')
    assert.equal(pool.isConnected(server.id), false)
  })

  test('closes the connection after idleTimeoutMs (§7.2)', async () => {
    const shortIdle = createPool({ idleTimeoutMs: 120 } as never)
    try {
      const server = sshd.server()
      await shortIdle.exec(server, { command: 'echo hi' })
      assert.equal(shortIdle.isConnected(server.id), true)
      await waitFor(() => shortIdle.isConnected(server.id) === false, 2000)
    } finally {
      await shortIdle.dispose()
    }
  })

  test('disconnect() closes one server and forgets it (§8.3)', async () => {
    const server = sshd.server()
    await pool.exec(server, { command: 'echo hi' })
    await pool.disconnect(server.id)
    assert.equal(pool.isConnected(server.id), false)
    await pool.exec(server, { command: 'echo again' })
    assert.equal(sshd.connections, 2)
  })

  test('truncates output at maxOutputChars, marks where, and flags it (§5.4)', async () => {
    const result = await pool.exec(sshd.server(), {
      command: 'i=0; while [ $i -lt 200 ]; do echo 0123456789; i=$((i+1)); done',
      maxOutputChars: 100,
    })
    assert.equal(result.truncated, true)
    assert.equal(result.stdout.length, 100 + TRUNCATED_MARKER.length)
    assert.ok(result.stdout.endsWith(TRUNCATED_MARKER))
    assert.equal(result.stdout.slice(0, 100).length, 100)
    assert.equal(result.exitCode, 0)
  })

  test('the truncation marker only lands in the stream that was cut (§5.4)', async () => {
    const result = await pool.exec(sshd.server(), {
      command: 'echo short-err >&2; i=0; while [ $i -lt 200 ]; do echo 0123456789; i=$((i+1)); done',
      maxOutputChars: 100,
    })
    assert.equal(result.truncated, true)
    assert.ok(result.stdout.endsWith(TRUNCATED_MARKER))
    assert.equal(result.stderr, 'short-err\n')
  })

  test('a per-call timeout overrides the pool default', async () => {
    const result = await pool.exec(sshd.server(), { command: 'sleep 5', timeoutMs: 400 })
    assert.equal(result.timedOut, true)
    assert.equal(result.exitCode, 137)
    assert.equal(result.timeoutError, 'TIMEOUT', 'srv_exec returns this §5.5 code directly')
    assert.ok(result.durationMs < 3000, `should not wait for the whole command: ${result.durationMs} ms`)
  })

  test('a command that finishes in time has no timeout code', async () => {
    const result = await pool.exec(sshd.server(), { command: 'echo hi', timeoutMs: 5000 })
    assert.equal(result.timedOut, false)
    assert.equal(result.timeoutError, null)
  })

  test('the timeout kills the whole process group, not just the shell (§7.3)', async () => {
    const server = sshd.server()
    const marker = `dsh-pool-watchdog-${process.pid}-${Date.now()}`
    const result = await pool.exec(server, {
      // The grandchild sleeps under a name unique to this test, and the parent
      // waits for it: without a process-group kill the sleeper survives.
      command: `sleep 300 & sleep 300; echo ${marker}`,
      timeoutMs: 700,
    })
    assert.equal(result.timedOut, true)
    // Nothing should be left: the watchdog KILLs the group that holds the sleeps.
    const after = await pool.exec(server, { command: 'ps -eo args' })
    assert.equal(after.stdout.includes('sleep 300'), false, `leftover processes:\n${after.stdout}`)
  })

  test('dispose() closes every connection and refuses later work', async () => {
    const server = sshd.server()
    await pool.exec(server, { command: 'echo hi' })
    await pool.dispose()
    assert.deepEqual(pool.connectedServerIds(), [])
    const error = await rejection(pool.exec(server, { command: 'echo hi' }))
    assert.equal(error.code, 'CONNECTION_LOST')
    await pool.dispose() // idempotent
  })

  test('rejects an incomplete server record and an empty command', async () => {
    const incomplete = { ...sshd.server(), id: '' }
    assert.equal((await rejection(pool.exec(incomplete, { command: 'echo hi' }))).code, 'INVALID_SERVER')
    assert.equal((await rejection(pool.exec(sshd.server(), { command: '   ' }))).code, 'INVALID_SERVER')
    assert.equal((await rejection(pool.exec(sshd.server(), { command: 'x', timeoutMs: -1 }))).code, 'INVALID_SERVER')
  })
})

/** Resolve a path the way `pwd` on this machine would (symlinks included). */
async function realpathOf(path: string): Promise<string> {
  const { realpath } = await import('node:fs/promises')
  return realpath(path)
}

/** Poll `predicate` until it holds or the deadline passes. */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(`condition not met within ${timeoutMs} ms`)
}

/** Ask the OS for a port that is free right now. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = address === null || typeof address === 'string' ? 0 : address.port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/**
 * Docker access for the integration layer: plain `docker`, then `sudo -n docker`
 * (this host grants the agent non-interactive sudo, and the socket is
 * root-owned). `null` means "no container runtime", and the suite skips.
 * @returns {{command: string[], available: boolean}}
 */
function dockerCommand(): { command: string[]; available: boolean } {
  /** Candidate invocations, in order: plain docker, then this host's sudo docker. */
  const candidates: string[][] = [['docker'], ['sudo', '-n', 'docker']]
  for (const command of candidates) {
    const head = command[0]
    if (head === undefined) continue
    const probe = spawnSync(head, [...command.slice(1), 'version', '--format', '{{.Server.Version}}'], {
      encoding: 'utf8',
      timeout: 15000,
    })
    if (probe.status === 0) return { command, available: true }
  }
  return { command: ['docker'], available: false }
}

/**
 * A real OpenSSH server in a container (integration layer).
 *
 * The image is `linuxserver/openssh-server` because it starts sshd from the
 * public key alone, needs no Dockerfile, and runs `setsid` and fractional
 * `sleep` — the two programs the watchdog relies on.
 */
class SshdContainer {
  /** @type {{command: string[], available: boolean}} */
  static docker = dockerCommand()
  static image = process.env.DSH_POOL_SSHD_IMAGE ?? 'linuxserver/openssh-server:latest'

  name: string
  port = 0
  /** @type {string} */
  privateKey = ''

  constructor(name: string) {
    this.name = name
  }

  /** Directory for the container's client key; survives per-test temp dirs. */
  static keysDir = join(tmpdir(), 'dsh-pool-sshd-keys')

  /** Run one docker subcommand of this container. */
  docker(...args: string[]): { status: number | null; stdout: string; stderr: string } {
    const [head = 'docker', ...rest] = SshdContainer.docker.command
    return spawnSync(head, [...rest, ...args], { encoding: 'utf8', timeout: 180000 })
  }

  /** Start the container and wait until it accepts the test key. */
  async start(): Promise<void> {
    const { mkdir, rm: remove } = await import('node:fs/promises')
    await mkdir(SshdContainer.keysDir, { recursive: true })
    this.privateKey = join(SshdContainer.keysDir, 'id_ed25519')
    // ssh-keygen refuses to overwrite, so a key left by an earlier run goes first.
    await remove(this.privateKey).catch(() => {})
    await remove(`${this.privateKey}.pub`).catch(() => {})
    // A real sshd is stricter than ssh2's server: give it a key OpenSSH itself
    // generated (`ssh-keygen`), which also exercises the OpenSSH key format.
    const generated = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', this.privateKey], {
      encoding: 'utf8',
      timeout: 15000,
    })
    assert.equal(generated.status, 0, `ssh-keygen failed: ${generated.stderr}`)
    const publicKey = (await readFile(`${this.privateKey}.pub`, 'utf8')).trim()

    this.port = await freePort()
    this.docker('rm', '-f', this.name)
    const run = this.docker(
      'run',
      '-d',
      '--name',
      this.name,
      '-e',
      'PUID=1000',
      '-e',
      'PGID=1001',
      '-e',
      'USER_NAME=probe',
      '-e',
      `PUBLIC_KEY=${publicKey}`,
      '-e',
      'SUDO_ACCESS=false',
      '-e',
      'PASSWORD_ACCESS=false',
      '-p',
      `127.0.0.1:${this.port}:2222`,
      SshdContainer.image,
    )
    assert.equal(run.status, 0, `docker run failed: ${run.stderr}`)

    // sshd has to generate its host keys before it answers; poll instead of sleeping.
    const deadline = Date.now() + 60000
    /** @type {PoolError|null} */
    let last = null
    while (Date.now() < deadline) {
      const probe = createPool({ connectTimeoutMs: 2000 } as never)
      try {
        await probe.exec(this.server(), { command: 'true' })
        await probe.dispose()
        return
      } catch (error) {
        last = error instanceof PoolError ? error : null
      } finally {
        await probe.dispose()
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    assert.fail(`sshd container did not become reachable: ${last?.code} ${last?.message}`)
  }

  /** A record pointing at this container. */
  server(overrides: Partial<ServerRecord> & { id?: string } = {}): ServerRecord {
    return record({
      port: this.port,
      username: 'probe',
      auth: { kind: 'key', privateKeyPath: this.privateKey },
      ...overrides,
    })
  }

  /** Remove the container. */
  stop(): void {
    this.docker('rm', '-f', this.name)
  }
}

describe('sshd container integration (doc §9.6)', () => {
  let container: SshdContainer | null = null
  let pool: Pool

  before(async () => {
    if (!SshdContainer.docker.available) return
    container = new SshdContainer(`dsh-pool-test-${process.pid}`)
    await container.start()
  })

  beforeEach(() => {
    pool = createPool()
  })

  afterEach(async () => {
    await pool.dispose()
  })

  after(() => {
    container?.stop()
  })

  test('runs "echo hi" on a real OpenSSH server (§9.6)', async (t) => {
    if (container === null) return t.skip('no Docker runtime (set DSH_POOL_SSHD_IMAGE to use another image)')
    const result = await pool.exec(container.server(), { command: 'echo hi' })
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout, 'hi\n')
    assert.equal(result.stderr, '')
    assert.equal(result.timedOut, false)
  })

  test('keeps stdout and stderr separate on OpenSSH too', async (t) => {
    if (container === null) return t.skip('no Docker runtime')
    const result = await pool.exec(container.server(), { command: 'echo out; echo err >&2; exit 2' })
    assert.equal(result.exitCode, 2)
    assert.equal(result.stdout, 'out\n')
    assert.equal(result.stderr, 'err\n')
  })

  test('honours cwd on a real OpenSSH server', async (t) => {
    if (container === null) return t.skip('no Docker runtime')
    const result = await pool.exec(container.server(), { command: 'pwd', cwd: '/config' })
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout.trim(), '/config')
  })

  test('reuses one connection: two commands report the same client port (§7.2)', async (t) => {
    if (container === null) return t.skip('no Docker runtime')
    const server = container.server()
    const first = await pool.exec(server, { command: 'echo "$SSH_CONNECTION"' })
    const second = await pool.exec(server, { command: 'echo "$SSH_CONNECTION"' })
    const clientPort = (line: string) => line.trim().split(/\s+/)[1]
    assert.equal(clientPort(first.stdout), clientPort(second.stdout), 'both commands share one TCP connection')
  })

  test('timeout kills the remote process group, proven with remote ps (§7.3, §9.6)', async (t) => {
    if (container === null) return t.skip('no Docker runtime')
    const server = container.server()
    const result = await pool.exec(server, {
      // A child that the channel's own signal cannot reach: it is in the
      // process group of the `setsid` child, so only the group kill stops it.
      command: 'sleep 300000 & sleep 300000',
      timeoutMs: 1500,
    })
    assert.equal(result.timedOut, true)
    assert.equal(result.exitCode, 137)
    assert.ok(result.durationMs < 15000, `returned in ${result.durationMs} ms`)

    // The only acceptable evidence: no `sleep 300000` remains on the server.
    const listing = await pool.exec(server, { command: 'ps -eo args' })
    assert.equal(
      listing.stdout.includes('sleep 300000'),
      false,
      `remote process group survived the timeout:\n${listing.stdout}`,
    )
  })

  test('does not wait out the timeout for a fast command (§7.3 redirect fix)', async (t) => {
    if (container === null) return t.skip('no Docker runtime')
    const result = await pool.exec(container.server(), { command: 'echo quick', timeoutMs: 30000 })
    assert.equal(result.stdout, 'quick\n')
    assert.ok(result.durationMs < 5000, `quick command took ${result.durationMs} ms`)
  })

  test('a changed host key refuses the connection with HOST_KEY_UNKNOWN (§6.4)', async (t) => {
    if (container === null) return t.skip('no Docker runtime')
    const store = new KnownHosts({ file: knownHostsFile })
    const server = container.server()
    await store.set(server.id, {
      hash: 'Ln0sA6lQeuJl7PW1NWiFpTOTogKdJBOUmXJloaJa78Y=',
      algorithm: 'ssh-ed25519',
    })
    const error = await rejection(pool.exec(server, { command: 'echo hi' }))
    assert.equal(error.code, 'HOST_KEY_UNKNOWN')
  })

  test('accept-new records the fingerprint of a real server (§6.4)', async (t) => {
    if (container === null) return t.skip('no Docker runtime')
    const store = new KnownHosts({ file: knownHostsFile })
    const server = container.server()
    await pool.exec(server, { command: 'true' })
    const stored = await store.get(server.id)
    assert.notEqual(stored, null)
    assert.equal(stored!.algorithm, 'ssh-ed25519')
  })
})
