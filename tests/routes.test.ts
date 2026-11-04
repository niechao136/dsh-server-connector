// Tests for the Client half's JSON routes (design doc §8.5).
//
// Run with: node --test tests/routes.test.ts   (Node strips the types natively)
// or:       npm test
//
// The decisive assertions are the two-step ones (§8.3) and the secret ones
// (§6.3):
//
//   - DELETE queues a request and leaves the record in servers.json;
//   - hostKeyMode "off" queues a request and leaves the mode alone;
//   - "停用" queues a request and leaves the rule working;
//   - confirm applies *and* audits, cancel changes nothing;
//   - no response body ever carries a stored password, and a password sent by
//     the panel only reaches the credential service.
//
// The routes are exercised through {@link createApi}, which is the dispatcher the
// node:http adapter calls, plus a few end-to-end requests through a real
// node:http server to prove the adapter's status codes and body handling.

import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { AuditLog } from '../lib/audit.js'
import { createPendingApplier, PendingQueue } from '../lib/pending.js'
import { RULES } from '../lib/policy.js'
import { Registry } from '../lib/registry.js'
import {
  API_PREFIX,
  API_ROUTES,
  MAX_BODY_BYTES,
  createApi,
  createHandler,
  registerRoutes,
  ruleCatalog,
  toHttpError,
} from '../lib/routes.js'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let directory: string
let serversFile: string
let auditFile: string
let pendingFile: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-routes-'))
  serversFile = join(directory, 'servers.json')
  auditFile = join(directory, 'audit.log')
  pendingFile = join(directory, 'pending.json')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/**
 * A stand-in for the SSH pool: it counts dials and answers the connect probe
 * without a socket. Only the routes' contract is under test here; the real
 * transport is covered by tests/pool.test.ts and tests/integration.test.ts.
 */
class FakePool {
  connects = 0
  disconnects: string[] = []
  failure: Error | null = null
  connected = new Set<string>()

  async connect(server: any) {
    if (this.failure !== null) throw this.failure
    this.connects += 1
    this.connected.add(server.id)
    return { reconnected: true }
  }

  async exec() {
    if (this.failure !== null) throw this.failure
    return {
      stdout: 'os=Debian 12\nkernel=Linux 6.1\nshell=/bin/bash\nsudo=absent\n',
      stderr: '',
      exitCode: 0,
      durationMs: 1,
      timedOut: false,
      truncated: false,
      reconnected: false,
      timeoutError: null,
    }
  }

  async disconnect(serverId: string) {
    this.connected.delete(serverId)
    this.disconnects.push(serverId)
  }

  connectedServerIds() {
    return [...this.connected]
  }
}

/** A credential service double: set/unset/describe, never a value in describe. */
class FakeCredentials {
  /** @type {Map<string, string>} */
  values = new Map()

  async set(ref: string, value: string) {
    this.values.set(ref, value)
  }

  async unset(ref: string) {
    this.values.delete(ref)
  }

  async describe(ref: string) {
    return { configured: this.values.has(ref), writable: true }
  }
}

/** The real units over temporary files, with a fake pool and credentials. */
function stack() {
  const registry = new Registry({ file: serversFile })
  const audit = new AuditLog({ file: auditFile })
  const pending = new PendingQueue({ file: pendingFile })
  const pool = new FakePool()
  const credentials = new FakeCredentials()
  pending.setApplier(
    createPendingApplier({
      registry,
      pool: /** @type {any} */ (pool),
      audit,
      getCredentials: () => credentials,
    }),
  )
  const changes: number[] = []
  const api = createApi({
    registry,
    pool: /** @type {any} */ (pool),
    audit,
    pending,
    getCredentials: () => credentials,
    config: { commandTimeoutMs: 60000 },
    onChange: () => {
      changes.push(Date.now())
    },
  })
  return { api, registry, audit, pending, pool, credentials, changes }
}

/**
 * Dispatch one request against the mount path.
 *
 * `dispatch` reports a failure by throwing (the adapter maps it with
 * `toHttpError`); the tests want both halves in one shape, so one thrown failure
 * becomes `{status, body: {error}}` here, exactly as the adapter would serialise
 * it.
 * @returns {Promise<{status:number, body:any}>}
 */
async function call(
  api: ReturnType<typeof createApi>,
  method: string,
  path: string,
  options: { body?: unknown; query?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  try {
    return await api.dispatch({ method, path, query: options.query, body: options.body })
  } catch (error) {
    const failure = toHttpError(error)
    return {
      status: failure.status,
      body: {
        error: {
          code: failure.code,
          message: failure.message,
          ...(Object.keys(failure.details).length === 0 ? {} : { details: failure.details }),
        },
      },
    }
  }
}

/** Create one server through the route, as the panel's form does. */
async function createServer(api: ReturnType<typeof createApi>, overrides: Record<string, unknown> = {}) {
  const answer = await call(api, 'POST', '/servers', {
    body: {
      name: '生产机-A',
      host: '10.0.0.5',
      port: 22,
      username: 'devops',
      auth: { kind: 'agent' },
      hostKeyMode: 'accept-new',
      defaultWorkDir: '/srv/app',
      ...overrides,
    },
  })
  assert.equal(answer.status, 201, JSON.stringify(answer.body))
  return answer.body.server
}

describe('route table (§8.5)', () => {
  test('declares exactly the eleven documented endpoints', () => {
    assert.equal(API_ROUTES.length, 11)
    const surface = API_ROUTES.map((route) => `${route.method} ${route.path}`)
    assert.deepEqual(surface, [
      'GET /servers',
      'POST /servers',
      'PUT /servers/:id',
      'DELETE /servers/:id',
      'POST /test',
      'POST /connect/:id',
      'POST /disconnect/:id',
      'GET /audit',
      'GET /pending',
      'POST /pending/:id/confirm',
      'POST /pending/:id/cancel',
    ])
    assert.equal(API_PREFIX, '/server-connector')
  })

  test('describe() reports the mounted paths', () => {
    const { api } = stack()
    const paths = api.describe().map((route) => route.path)
    assert.ok(paths.includes('/server-connector/servers'))
    assert.ok(paths.includes('/server-connector/pending/:id/confirm'))
  })

  test('the rule catalog exposes every built-in rule with its allowed decisions', () => {
    const catalog = ruleCatalog()
    assert.equal(catalog.length, RULES.length)
    const recursive = catalog.find((rule) => rule.id === 'rm-recursive')
    assert.deepEqual(recursive?.allowedDecisions, ['confirm', 'block'])
    const confirmRule = catalog.find((rule) => rule.defaultDecision === 'confirm')
    assert.ok(confirmRule !== undefined)
    assert.deepEqual(confirmRule.allowedDecisions, ['allow', 'confirm', 'block'])
  })
})

describe('GET /servers', () => {
  test('an empty registry lists nothing but still carries rules and config', async () => {
    const { api } = stack()
    const answer = await call(api, 'GET', '/servers')
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body.servers, [])
    assert.equal(answer.body.rules.length, RULES.length)
    assert.equal(answer.body.config.pendingTtlHours, 24)
    assert.deepEqual(answer.body.hostKeyModes, ['accept-new', 'verify', 'off'])
    assert.equal(answer.body.pendingCount, 0)
  })

  test('a password server reports configured state, never the reference or a value', async () => {
    const { api, credentials } = stack()
    const server = await createServer(api, {
      name: '测试机-B',
      auth: { kind: 'password' },
      password: 'hunter2',
    })
    assert.equal(server.auth.kind, 'password')
    assert.equal(server.passwordConfigured, true)
    assert.equal(credentials.values.size, 1)

    const answer = await call(api, 'GET', '/servers')
    const text = JSON.stringify(answer.body)
    assert.ok(!text.includes('hunter2'))
    assert.ok(!text.includes('credentialRef'))
    assert.equal(answer.body.servers[0].passwordConfigured, true)
    assert.deepEqual(answer.body.servers[0].auth, { kind: 'password' })
  })

  test('policyState reports the effective decision and disabled rules', async () => {
    const { api, registry } = stack()
    const server = await createServer(api, { policy: { 'service-restart': 'allow' } })
    await registry.update(server.id, { disabledRules: ['docker-prune'] })
    const answer = await call(api, 'GET', '/servers')
    const state = answer.body.servers[0].policyState
    assert.equal(state['service-restart'].configured, 'allow')
    assert.equal(state['service-restart'].decision, 'allow')
    assert.equal(state['rm-recursive'].decision, 'block')
    assert.equal(state['docker-prune'].disabled, true)
  })
})

describe('POST /servers', () => {
  test('creates a server and returns the stored record', async () => {
    const { api, registry } = stack()
    const server = await createServer(api)
    assert.equal(server.id, 'srv-01')
    assert.equal(server.name, '生产机-A')
    assert.equal(server.defaultWorkDir, '/srv/app')
    assert.equal((await registry.list()).length, 1)
  })

  test('rejects a duplicate name with 409', async () => {
    const { api } = stack()
    await createServer(api)
    const again = await call(api, 'POST', '/servers', {
      body: { name: '生产机-A', host: '10.0.0.9', username: 'x', auth: { kind: 'agent' } },
    })
    assert.equal(again.status, 409)
    assert.equal(again.body.error.code, 'DUPLICATE_NAME')
  })

  test('rejects a relative key path, a bad port and an empty name with 400', async () => {
    const { api } = stack()
    const relative = await call(api, 'POST', '/servers', {
      body: { name: 'k', host: 'h', username: 'u', auth: { kind: 'key', privateKeyPath: 'id_rsa' } },
    })
    assert.equal(relative.status, 400)
    assert.equal(relative.body.error.code, 'INVALID_SERVER')

    const port = await call(api, 'POST', '/servers', {
      body: { name: 'p', host: 'h', username: 'u', port: 70000, auth: { kind: 'agent' } },
    })
    assert.equal(port.status, 400)

    const name = await call(api, 'POST', '/servers', {
      body: { name: '  ', host: 'h', username: 'u', auth: { kind: 'agent' } },
    })
    assert.equal(name.status, 400)
  })

  test('creating with hostKeyMode "off" keeps verification on and queues the change', async () => {
    const { api, registry } = stack()
    const answer = await call(api, 'POST', '/servers', {
      body: { name: 'off-server', host: 'h', username: 'u', auth: { kind: 'agent' }, hostKeyMode: 'off' },
    })
    assert.equal(answer.status, 202)
    assert.equal(answer.body.server.hostKeyMode, 'accept-new')
    assert.equal(answer.body.pending[0].kind, 'disable-hostkey')
    assert.equal((await registry.get(answer.body.server.id))?.hostKeyMode, 'accept-new')
  })

  test('creating with disableRules queues one request per rule and stores none', async () => {
    const { api, registry } = stack()
    const answer = await call(api, 'POST', '/servers', {
      body: {
        name: 'rules-server',
        host: 'h',
        username: 'u',
        auth: { kind: 'agent' },
        disableRules: ['rm-recursive', 'docker-prune'],
      },
    })
    assert.equal(answer.status, 202)
    assert.deepEqual(
      answer.body.pending.map((record: any) => record.ruleId),
      ['rm-recursive', 'docker-prune'],
    )
    assert.deepEqual((await registry.get(answer.body.server.id))?.disabledRules, [])
  })

  test('rejects a plaintext secret smuggled into the body', async () => {
    const { api } = stack()
    const answer = await call(api, 'POST', '/servers', {
      body: { name: 's', host: 'h', username: 'u', auth: { kind: 'agent' }, password: 'x' },
    })
    // `password` is the write-only field for a password server; for an agent
    // server it must not be accepted silently.
    assert.equal(answer.status, 400)
    assert.equal(answer.body.error.code, 'INVALID_SERVER')
  })

  test('a created server refreshes the system-prompt cache', async () => {
    const { api, changes } = stack()
    await createServer(api)
    assert.equal(changes.length, 1)
  })
})

describe('PUT /servers/:id', () => {
  test('updates display fields immediately', async () => {
    const { api } = stack()
    const server = await createServer(api)
    const answer = await call(api, 'PUT', `/servers/${server.id}`, {
      body: { name: '生产机-A2', defaultWorkDir: '/srv/new', port: 2200 },
    })
    assert.equal(answer.status, 200)
    assert.equal(answer.body.server.name, '生产机-A2')
    assert.equal(answer.body.server.port, 2200)
    assert.equal(answer.body.applied, true)
  })

  test('hostKeyMode "off" is queued, not applied (§8.3)', async () => {
    const { api, registry } = stack()
    const server = await createServer(api)
    const answer = await call(api, 'PUT', `/servers/${server.id}`, { body: { hostKeyMode: 'off' } })
    assert.equal(answer.status, 202)
    assert.equal(answer.body.applied, false)
    assert.equal(answer.body.server.hostKeyMode, 'accept-new')
    assert.equal(answer.body.pending[0].kind, 'disable-hostkey')
    // The decisive assertion: the record on disk still verifies the host key.
    assert.equal((await registry.get(server.id))?.hostKeyMode, 'accept-new')
  })

  test('queueing the same "off" twice keeps one pending record', async () => {
    const { api } = stack()
    const server = await createServer(api)
    await call(api, 'PUT', `/servers/${server.id}`, { body: { hostKeyMode: 'off' } })
    const again = await call(api, 'PUT', `/servers/${server.id}`, { body: { hostKeyMode: 'off' } })
    assert.equal(again.body.pending.length, 1)
    const listed = await call(api, 'GET', '/pending')
    assert.equal(listed.body.pending.length, 1)
  })

  test('a built-in block rule cannot be lowered straight to allow', async () => {
    const { api } = stack()
    const server = await createServer(api)
    const answer = await call(api, 'PUT', `/servers/${server.id}`, {
      body: { policy: { 'rm-recursive': 'allow' } },
    })
    assert.equal(answer.status, 400)
    assert.equal(answer.body.error.code, 'INVALID_POLICY')
  })

  test('block → confirm is accepted and stored', async () => {
    const { api, registry } = stack()
    const server = await createServer(api)
    const answer = await call(api, 'PUT', `/servers/${server.id}`, {
      body: { policy: { 'rm-recursive': 'confirm' } },
    })
    assert.equal(answer.status, 200)
    assert.deepEqual((await registry.get(server.id))?.policy, { 'rm-recursive': 'confirm' })
  })

  test('disabling a rule is queued and the rule keeps its decision (§8.3)', async () => {
    const { api, registry } = stack()
    const server = await createServer(api)
    const answer = await call(api, 'PUT', `/servers/${server.id}`, { body: { disableRules: ['rm-recursive'] } })
    assert.equal(answer.status, 202)
    assert.equal(answer.body.pending[0].kind, 'disable-rule')
    assert.equal(answer.body.pending[0].ruleId, 'rm-recursive')
    assert.deepEqual((await registry.get(server.id))?.disabledRules, [])
    // And the effective policy still blocks.
    const listed = await call(api, 'GET', '/servers')
    assert.equal(listed.body.servers[0].policyState['rm-recursive'].disabled, false)
    assert.equal(listed.body.servers[0].policyState['rm-recursive'].decision, 'block')
  })

  test('re-enabling a rule applies immediately, because it is the safe direction', async () => {
    const { api, registry } = stack()
    const server = await createServer(api)
    await registry.update(server.id, { disabledRules: ['docker-prune'] })
    const answer = await call(api, 'PUT', `/servers/${server.id}`, { body: { enableRules: ['docker-prune'] } })
    assert.equal(answer.status, 200)
    assert.equal(answer.body.applied, true)
    assert.deepEqual((await registry.get(server.id))?.disabledRules, [])
  })

  test('disabledRules cannot be written directly', async () => {
    const { api } = stack()
    const server = await createServer(api)
    const answer = await call(api, 'PUT', `/servers/${server.id}`, { body: { disabledRules: ['rm-recursive'] } })
    assert.equal(answer.status, 400)
    assert.equal(answer.body.error.code, 'INVALID_PENDING')
  })

  test('an unknown server is 404', async () => {
    const { api } = stack()
    const answer = await call(api, 'PUT', '/servers/srv-99', { body: { name: 'x' } })
    assert.equal(answer.status, 404)
    assert.equal(answer.body.error.code, 'UNKNOWN_SERVER')
  })
})

describe('DELETE /servers/:id', () => {
  test('queues the deletion and leaves the server usable (§8.3)', async () => {
    const { api, registry } = stack()
    const server = await createServer(api)
    const answer = await call(api, 'DELETE', `/servers/${server.id}`)
    assert.equal(answer.status, 202)
    assert.equal(answer.body.pending.kind, 'delete-server')
    assert.equal(answer.body.pending.snapshot.name, '生产机-A')
    // Still there, still resolvable.
    assert.notEqual(await registry.get(server.id), null)
    const listed = await call(api, 'GET', '/servers')
    assert.equal(listed.body.servers.length, 1)
    assert.equal(listed.body.pendingCount, 1)
  })
})

describe('POST /test and the connect endpoints', () => {
  test('test reports the probe fields and records lastConnectedAt', async () => {
    const { api, registry } = stack()
    const server = await createServer(api)
    const answer = await call(api, 'POST', '/test', { body: { id: server.id } })
    assert.equal(answer.status, 200)
    assert.equal(answer.body.ok, true)
    assert.equal(answer.body.platform, 'Debian 12')
    assert.equal(answer.body.shell, '/bin/bash')
    assert.equal(answer.body.sudo, 'absent')
    assert.equal(typeof answer.body.durationMs, 'number')
    assert.notEqual((await registry.get(server.id))?.lastConnectedAt, null)
  })

  test('test does not run a policy gate: an unconfigured server id is just a 404', async () => {
    const { api, pool } = stack()
    const answer = await call(api, 'POST', '/test', { body: { id: 'srv-99' } })
    assert.equal(answer.status, 404)
    assert.equal(pool.connects, 0)
  })

  test('connect opens the pooled connection, disconnect closes it', async () => {
    const { api, pool } = stack()
    const server = await createServer(api)
    const connected = await call(api, 'POST', `/connect/${server.id}`)
    assert.equal(connected.status, 200)
    assert.equal(connected.body.connected, true)
    assert.equal(connected.body.probe.platform, 'Debian 12')
    assert.deepEqual(pool.connectedServerIds(), [server.id])

    const listed = await call(api, 'GET', '/servers')
    assert.equal(listed.body.servers[0].connected, true)

    const disconnected = await call(api, 'POST', `/disconnect/${server.id}`)
    assert.equal(disconnected.status, 200)
    assert.deepEqual(pool.disconnects, [server.id])
    assert.deepEqual(pool.connectedServerIds(), [])
  })

  test('a transport failure keeps its code and maps to a 5xx/409', async () => {
    const { api, pool } = stack()
    const server = await createServer(api)
    const { PoolError } = await import('../lib/pool.js')
    pool.failure = new PoolError('HOST_KEY_UNKNOWN', 'the host key changed', { serverId: server.id })
    const answer = await call(api, 'POST', '/test', { body: { id: server.id } })
    assert.equal(answer.status, 409)
    assert.equal(answer.body.error.code, 'HOST_KEY_UNKNOWN')
  })
})

describe('GET /audit', () => {
  test('returns the newest records first', async () => {
    const { api, audit } = stack()
    const server = await createServer(api)
    for (let index = 0; index < 3; index += 1) {
      await audit.append({ serverId: server.id, command: `echo ${String(index)}`, decision: 'allow', exitCode: 0 })
    }
    const answer = await call(api, 'GET', '/audit', { query: { limit: '2' } })
    assert.equal(answer.status, 200)
    assert.equal(answer.body.records.length, 2)
    assert.equal(answer.body.records[0].command, 'echo 2')
    assert.equal(answer.body.records[1].command, 'echo 1')
  })

  test('filters by serverId', async () => {
    const { api, audit } = stack()
    const first = await createServer(api)
    const second = await createServer(api, { name: '测试机-B', host: '10.0.0.6' })
    await audit.append({ serverId: first.id, command: 'a', decision: 'allow', exitCode: 0 })
    await audit.append({ serverId: second.id, command: 'b', decision: 'allow', exitCode: 0 })
    const answer = await call(api, 'GET', '/audit', { query: { serverId: second.id } })
    assert.deepEqual(
      answer.body.records.map((record: any) => record.command),
      ['b'],
    )
  })

  test('a non-numeric limit is a 400, and an empty log is an empty list', async () => {
    const { api } = stack()
    assert.equal((await call(api, 'GET', '/audit', { query: { limit: 'x' } })).status, 400)
    const empty = await call(api, 'GET', '/audit')
    assert.deepEqual(empty.body.records, [])
  })
})

describe('the pending queue endpoints (§8.3)', () => {
  test('the list names the target of each kind', async () => {
    const { api } = stack()
    const server = await createServer(api)
    await call(api, 'DELETE', `/servers/${server.id}`)
    const answer = await call(api, 'GET', '/pending')
    assert.equal(answer.status, 200)
    assert.equal(answer.body.pending.length, 1)
    const record = answer.body.pending[0]
    assert.equal(record.kind, 'delete-server')
    assert.equal(record.serverName, '生产机-A')
    assert.equal(record.target.present, true)
    assert.equal(record.target.host, '10.0.0.5')
    // The snapshot is not published wholesale.
    assert.equal(record.target.policy, undefined)
  })

  test('confirm applies the deletion and writes the audit event', async () => {
    const { api, registry, audit } = stack()
    const server = await createServer(api)
    const queued = await call(api, 'DELETE', `/servers/${server.id}`)
    const answer = await call(api, 'POST', `/pending/${queued.body.pending.id}/confirm`)
    assert.equal(answer.status, 200)
    assert.equal(answer.body.status, 'applied')
    assert.equal(await registry.get(server.id), null)
    const records = await audit.tail(10)
    assert.equal(records.at(-1)?.event, 'server-deleted')
    assert.deepEqual((await call(api, 'GET', '/pending')).body.pending, [])
  })

  test('confirm applies hostKeyMode off and writes the audit event', async () => {
    const { api, registry, audit } = stack()
    const server = await createServer(api)
    const queued = await call(api, 'PUT', `/servers/${server.id}`, { body: { hostKeyMode: 'off' } })
    await call(api, 'POST', `/pending/${queued.body.pending[0].id}/confirm`)
    assert.equal((await registry.get(server.id))?.hostKeyMode, 'off')
    assert.equal((await audit.tail(5)).at(-1)?.event, 'hostkey-disabled')
  })

  test('confirm applies a disabled rule and writes the audit event', async () => {
    const { api, registry, audit } = stack()
    const server = await createServer(api)
    const queued = await call(api, 'PUT', `/servers/${server.id}`, { body: { disableRules: ['rm-recursive'] } })
    await call(api, 'POST', `/pending/${queued.body.pending[0].id}/confirm`)
    assert.deepEqual((await registry.get(server.id))?.disabledRules, ['rm-recursive'])
    assert.equal((await audit.tail(5)).at(-1)?.event, 'rule-disabled')
  })

  test('cancel leaves the target untouched', async () => {
    const { api, registry, pool } = stack()
    const server = await createServer(api)
    const queued = await call(api, 'DELETE', `/servers/${server.id}`)
    const answer = await call(api, 'POST', `/pending/${queued.body.pending.id}/cancel`)
    assert.equal(answer.status, 200)
    assert.equal(answer.body.status, 'discarded')
    assert.notEqual(await registry.get(server.id), null)
    assert.deepEqual(pool.disconnects, [])
    assert.deepEqual((await call(api, 'GET', '/pending')).body.pending, [])
  })

  test('an unknown pending id is a 404', async () => {
    const { api } = stack()
    assert.equal((await call(api, 'POST', '/pending/pend-99/confirm')).status, 404)
    assert.equal((await call(api, 'POST', '/pending/pend-99/cancel')).status, 404)
  })
})

describe('dispatch errors', () => {
  test('an unknown path is 404', async () => {
    const { api } = stack()
    const answer = await call(api, 'GET', '/nope')
    assert.equal(answer.status, 404)
    assert.equal(answer.body.error.code, 'NOT_FOUND')
  })

  test('a known path with the wrong method is 405 and names the allowance', async () => {
    const { api } = stack()
    const answer = await call(api, 'POST', '/servers/srv-01')
    assert.equal(answer.status, 405)
    assert.equal(answer.body.error.code, 'METHOD_NOT_ALLOWED')
    assert.equal(answer.body.error.details.allow, 'PUT, DELETE')
  })

  test('a pending queue is not required for the read routes', async () => {
    const registry = new Registry({ file: serversFile })
    const pool = new FakePool()
    const api = createApi({ registry, pool: /** @type {any} */ (pool) })
    assert.equal((await call(api, 'GET', '/servers')).status, 200)
    assert.deepEqual((await call(api, 'GET', '/pending')).body.pending, [])
    const server = await registry.create({ name: 'a', host: 'h', username: 'u' })
    assert.equal((await call(api, 'DELETE', `/servers/${server.id}`)).status, 503)
  })
})

describe('composition wiring (§8.5, §9.4)', () => {
  test('registers one prefix route on webServer and disposes it', () => {
    const { registry, pool, audit, pending } = stack()
    const registered: any[] = []
    const webServer = {
      register(route: any) {
        registered.push(route)
        return () => {
          registered.splice(registered.indexOf(route), 1)
        }
      },
    }
    const ctx = {
      webServer,
      logger: { warn() {} },
      get: () => undefined,
    }
    const outcome = registerRoutes(ctx as any, {
      registry,
      pool: pool as any,
      audit,
      pending,
    })
    assert.equal(registered.length, 1)
    assert.equal(registered[0].kind, 'prefix')
    assert.equal(registered[0].path, '/server-connector')
    assert.equal(typeof registered[0].handler, 'function')
    outcome.dispose()
    assert.equal(registered.length, 0)
  })

  test('the trust fence is consulted per request, so a late connection service still guards', async () => {
    const { registry, pool, audit, pending } = stack()
    let registeredRoute: any
    let connection: any
    const ctx = {
      webServer: {
        register(route: any) {
          registeredRoute = route
          return () => {}
        },
      },
      logger: { warn() {} },
      get(name: string) {
        return name === 'connection' ? connection : undefined
      },
    }
    registerRoutes(ctx as any, { registry, pool: pool as any, audit, pending })
    assert.ok(registeredRoute !== undefined)

    // A cordis-derived context is not required here: the handler only needs a
    // request/response pair, so a minimal pair exercises the fence.
    const respond = async () => {
      let status = 0
      let ended = false
      const request = { url: '/server-connector/servers', method: 'GET', headers: {} } as any
      const response = {
        set statusCode(value: number) {
          status = value
        },
        get statusCode() {
          return status
        },
        setHeader() {},
        end() {
          ended = true
        },
        headersSent: false,
        destroy() {},
      } as any
      await registeredRoute.handler(request, response)
      return { status, ended }
    }

    // No connection service yet: the route answers (a headless composition).
    const open = await respond()
    assert.equal(open.status, 200)

    connection = { requestRejection: () => 401 }
    const fenced = await respond()
    assert.equal(fenced.status, 401)
  })

  test('the host entry mounts the routes through an optional webServer injection', async () => {
    // The plugin's own `inject` list must not make webServer mandatory (§9.4):
    // a headless profile has no panel and still runs the six tools, so the entry
    // wires the routes with `ctx.inject(['webServer'], …)` instead.
    const entry = await readFile(join(PACKAGE_ROOT, 'lib', 'index.js'), 'utf8')
    assert.doesNotMatch(entry, /export const inject = \[[^\]]*webServer/)
    assert.match(entry, /ctx\.inject\(\['webServer'\]/)
  })
})

describe('node:http adapter', () => {
  /** Start the real handler on a random port and return its origin. */
  async function serve(options: Parameters<typeof createHandler>[1] = {}) {
    const { api } = stack()
    const handler = createHandler(api, options)
    const server = createHttpServer((req, res) => {
      void handler(req, res)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address() as AddressInfo
    return {
      origin: `http://127.0.0.1:${String(address.port)}`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    }
  }

  test('serves the list under the mount path with JSON and no-store', async () => {
    const running = await serve()
    try {
      const response = await fetch(`${running.origin}${API_PREFIX}/servers`)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.deepEqual((await response.json() as any).servers, [])
    } finally {
      await running.close()
    }
  })

  test('creates a server from a JSON POST body', async () => {
    const running = await serve()
    try {
      const response = await fetch(`${running.origin}${API_PREFIX}/servers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'n', host: 'h', username: 'u', auth: { kind: 'agent' } }),
      })
      assert.equal(response.status, 201)
      const payload = (await response.json()) as any
      assert.equal(payload.server.name, 'n')
    } finally {
      await running.close()
    }
  })

  test('a request outside the mount path is 404 and a bad body is 400', async () => {
    const running = await serve()
    try {
      const outside = await fetch(`${running.origin}/elsewhere`)
      assert.equal(outside.status, 404)
      const bad = await fetch(`${running.origin}${API_PREFIX}/servers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      })
      assert.equal(bad.status, 400)
      assert.equal(((await bad.json()) as any).error.code, 'INVALID_JSON')
    } finally {
      await running.close()
    }
  })

  test('an oversized body is 413', async () => {
    const running = await serve()
    try {
      const response = await fetch(`${running.origin}${API_PREFIX}/servers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'x'.repeat(MAX_BODY_BYTES + 1024) }),
      })
      assert.equal(response.status, 413)
      assert.equal(((await response.json()) as any).error.code, 'BODY_TOO_LARGE')
    } finally {
      await running.close()
    }
  })

  test('a rejected request never reaches a handler', async () => {
    const running = await serve({ rejected: () => 401 })
    try {
      const response = await fetch(`${running.origin}${API_PREFIX}/servers`)
      assert.equal(response.status, 401)
      const created = await fetch(`${running.origin}${API_PREFIX}/servers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'n', host: 'h', username: 'u' }),
      })
      assert.equal(created.status, 401)
      const file = await readFile(serversFile, 'utf8').catch(() => '')
      assert.equal(file, '')
    } finally {
      await running.close()
    }
  })

  test('a 405 carries an allow header', async () => {
    const running = await serve()
    try {
      const response = await fetch(`${running.origin}${API_PREFIX}/servers/srv-01`, { method: 'POST' })
      assert.equal(response.status, 405)
      assert.equal(response.headers.get('allow'), 'PUT, DELETE')
    } finally {
      await running.close()
    }
  })
})
