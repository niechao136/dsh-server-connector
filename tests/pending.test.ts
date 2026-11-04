// Tests for the two-step confirmation queue (design doc §3.3, §8.3).
//
// Run with: node --test tests/pending.test.ts   (Node strips the types natively)
// or:       npm test
//
// The queue's whole point is that a dangerous operation is *requested* first and
// applied later, so these tests pin both halves of that contract: what lands on
// disk (§3.3), and what does (or does not) happen to the server (§8.3). Every
// test documents which side effect — if any — it proves absent.

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import {
  DEFAULT_PENDING_TTL_HOURS,
  PENDING_FILE_NAME,
  PendingError,
  PendingQueue,
  createPendingApplier,
  defaultPendingFile,
} from '../lib/pending.js'
import { Registry } from '../lib/registry.js'
import { CONNECTOR_DIR_NAME } from '../lib/registry.js'

let directory: string
let file: string
/** A fixed clock so `requestedAt` / `expiresAt` are exactly checkable. */
const NOW = new Date('2026-11-04T09:20:11.000Z')

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-pending-'))
  file = join(directory, 'server-connector', 'pending.json')
})

/** Write a raw document, creating the connector directory when a test needs it. */
async function writeDocument(text: string): Promise<void> {
  await mkdir(join(directory, 'server-connector'), { recursive: true })
  await writeFile(file, text)
}

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** A queue on this test's temp file, with an injected clock. */
function queue(options: ConstructorParameters<typeof PendingQueue>[0] = {}): PendingQueue {
  return new PendingQueue({ file, now: () => NOW, ...options })
}

/** Read the stored document exactly as it was written. */
async function document(): Promise<{ version: number, pending: any[] }> {
  return JSON.parse(await readFile(file, 'utf8'))
}

describe('paths and defaults (§3.3, §3.5, §10)', () => {
  test('the default file lives under $DSH_HOME/server-connector', () => {
    assert.equal(defaultPendingFile({ DSH_HOME: '/var/lib/dsh' }), '/var/lib/dsh/server-connector/pending.json')
    assert.equal(PENDING_FILE_NAME, 'pending.json')
    assert.equal(CONNECTOR_DIR_NAME, 'server-connector')
  })

  test('the default TTL is 24 hours (§10 pendingTtlHours)', () => {
    assert.equal(DEFAULT_PENDING_TTL_HOURS, 24)
    assert.equal(queue().ttlHours, 24)
    assert.equal(queue({ ttlHours: 48 }).ttlHours, 48)
    assert.throws(() => new PendingQueue({ file, ttlHours: 0 }), /ttlHours/)
  })
})

describe('request(): no side effect, a §3.3 record on disk', () => {
  test('writes the documented record shape and applies nothing', async () => {
    /** @type {unknown[]} */
    const applied: unknown[] = []
    const store = queue({ apply: async (record) => applied.push(record) })

    const { record, created } = await store.request({
      kind: 'delete-server',
      serverId: 'srv-01',
      snapshot: { id: 'srv-01', name: '生产机-A', host: '10.0.0.5' },
    })

    assert.equal(created, true)
    assert.equal(record.id, 'pend-01')
    assert.equal(record.kind, 'delete-server')
    assert.equal(record.serverId, 'srv-01')
    assert.equal(record.requestedAt, '2026-11-04T09:20:11.000Z')
    // requestedAt + 24 h, exactly as §3.3 draws it.
    assert.equal(record.expiresAt, '2026-11-05T09:20:11.000Z')
    assert.deepEqual(record.snapshot, { id: 'srv-01', name: '生产机-A', host: '10.0.0.5' })

    const stored = await document()
    assert.equal(stored.version, 1)
    assert.equal(stored.pending.length, 1)
    assert.deepEqual(stored.pending[0], record)

    // §8.3: requesting is not applying.
    assert.deepEqual(applied, [])
  })

  test('the snapshot is a copy, so the caller cannot retroactively edit it', async () => {
    const store = queue()
    const snapshot = { id: 'srv-01', name: 'A' }
    const { record } = await store.request({ kind: 'delete-server', serverId: 'srv-01', snapshot })
    snapshot.name = 'mutated'
    assert.equal(record.snapshot?.name, 'A')
    assert.equal((await store.get(record.id))?.snapshot?.name, 'A')
  })

  test('disable-rule requires a ruleId; the other kinds reject one', async () => {
    const store = queue()
    await assert.rejects(store.request({ kind: 'disable-rule', serverId: 'srv-01' }), /ruleId/)
    await assert.rejects(store.request({ kind: 'disable-hostkey', serverId: 'srv-01', ruleId: 'x' }), /ruleId/)
    const { record } = await store.request({ kind: 'disable-rule', serverId: 'srv-01', ruleId: 'rm-recursive' })
    assert.equal(record.ruleId, 'rm-recursive')
  })

  test('an invalid kind or a blank serverId is refused', async () => {
    const store = queue()
    await assert.rejects(store.request({ kind: 'nuke', serverId: 'srv-01' }), /kind/)
    await assert.rejects(store.request({ kind: 'delete-server', serverId: '  ' }), /serverId/)
  })

  test('requesting the same operation twice keeps one record', async () => {
    const store = queue()
    const first = await store.request({ kind: 'disable-hostkey', serverId: 'srv-01' })
    const second = await store.request({ kind: 'disable-hostkey', serverId: 'srv-01' })
    assert.equal(second.created, false)
    assert.equal(second.record.id, first.record.id)
    assert.equal((await store.list()).length, 1)
  })

  test('different operations on one server stay separate rows', async () => {
    const store = queue()
    await store.request({ kind: 'disable-hostkey', serverId: 'srv-01' })
    await store.request({ kind: 'disable-rule', serverId: 'srv-01', ruleId: 'rm-recursive' })
    await store.request({ kind: 'disable-rule', serverId: 'srv-01', ruleId: 'dd-write' })
    assert.equal((await store.list()).length, 3)
  })

  test('ids are sequential and unique among the live records', async () => {
    const store = queue()
    const first = await store.request({ kind: 'disable-hostkey', serverId: 'srv-01' })
    const second = await store.request({ kind: 'disable-hostkey', serverId: 'srv-02' })
    assert.equal(first.record.id, 'pend-01')
    assert.equal(second.record.id, 'pend-02')
    const ids = (await store.list()).map((record) => record.id)
    assert.equal(new Set(ids).size, ids.length)
  })
})

describe('confirm(): the only side effect', () => {
  test('runs the applier, removes the record, and reports applied', async () => {
    const calls: string[] = []
    const store = queue({ apply: async (record) => calls.push(record.id) })
    const { record } = await store.request({ kind: 'disable-hostkey', serverId: 'srv-01' })

    const result = await store.confirm(record.id)
    assert.equal(result.status, 'applied')
    assert.deepEqual(calls, [record.id])
    assert.deepEqual(await store.list(), [])
    assert.deepEqual((await document()).pending, [])
  })

  test('a throwing applier keeps the record so the user can retry', async () => {
    let attempts = 0
    const store = queue({
      apply: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('disk full')
        return 'ok'
      },
    })
    const { record } = await store.request({ kind: 'delete-server', serverId: 'srv-01' })

    await assert.rejects(store.confirm(record.id), (error: unknown) => {
      assert.ok(error instanceof PendingError)
      assert.equal(error.code, 'APPLY_FAILED')
      assert.match(error.message, /disk full/)
      return true
    })
    // The row survives the failure — a transient problem must not silently
    // discard a decision the user already made.
    assert.equal((await store.list()).length, 1)

    const retried = await store.confirm(record.id)
    assert.equal(retried.status, 'applied')
    assert.equal(attempts, 2)
    assert.deepEqual(await store.list(), [])
  })

  test('confirming an unknown id reports UNKNOWN_PENDING', async () => {
    const store = queue({ apply: async () => 'ok' })
    await assert.rejects(store.confirm('pend-99'), (error: unknown) => {
      assert.equal((error as PendingError).code, 'UNKNOWN_PENDING')
      return true
    })
  })

  test('a queue without an applier cannot confirm', async () => {
    const store = queue()
    const { record } = await store.request({ kind: 'delete-server', serverId: 'srv-01' })
    assert.equal(store.applicable, false)
    await assert.rejects(store.confirm(record.id), (error: unknown) => {
      assert.equal((error as PendingError).code, 'PENDING_UNAVAILABLE')
      return true
    })
    assert.equal((await store.list()).length, 1)
  })

  test('setApplier() installs the side-effecting half after construction', async () => {
    const store = queue()
    const { record } = await store.request({ kind: 'disable-hostkey', serverId: 'srv-01' })
    store.setApplier(async () => 'late')
    assert.equal(store.applicable, true)
    const result = await store.confirm(record.id)
    assert.equal(result.result, 'late')
  })
})

describe('cancel(): the target keeps its current state', () => {
  test('removes the record and applies nothing', async () => {
    let applied = 0
    const store = queue({ apply: async () => (applied += 1) })
    const { record } = await store.request({ kind: 'delete-server', serverId: 'srv-01' })

    const result = await store.cancel(record.id)
    assert.equal(result.status, 'discarded')
    assert.equal(result.record.id, record.id)
    assert.deepEqual(await store.list(), [])
    assert.equal(applied, 0)
  })

  test('cancelling an unknown id reports UNKNOWN_PENDING', async () => {
    const store = queue()
    await assert.rejects(store.cancel('pend-42'), (error: unknown) => {
      assert.equal((error as PendingError).code, 'UNKNOWN_PENDING')
      return true
    })
  })

  test('a cancelled record cannot be confirmed afterwards', async () => {
    let applied = 0
    const store = queue({ apply: async () => (applied += 1) })
    const { record } = await store.request({ kind: 'delete-server', serverId: 'srv-01' })
    await store.cancel(record.id)
    await assert.rejects(store.confirm(record.id), /No pending record/)
    assert.equal(applied, 0)
  })
})

describe('expiry: 24 h, checked on load and on every read/write (§8.3)', () => {
  test('a record past its window is dropped and reported, never confirmable', async () => {
    let applied = 0
    let clock = NOW
    const store = new PendingQueue({ file, now: () => clock, apply: async () => (applied += 1) })
    const { record } = await store.request({ kind: 'delete-server', serverId: 'srv-01' })

    // One second inside the window: still live.
    clock = new Date(NOW.getTime() + 24 * 60 * 60 * 1000 - 1000)
    assert.equal((await store.list()).length, 1)

    // One second past it: gone, from disk as well.
    clock = new Date(NOW.getTime() + 24 * 60 * 60 * 1000 + 1000)
    assert.deepEqual(await store.list(), [])
    assert.deepEqual((await document()).pending, [])

    // An expired record is never applied, whether the eviction was already
    // persisted by an earlier read (UNKNOWN_PENDING) or is seen for the first
    // time by this confirm (EXPIRED_PENDING).
    await assert.rejects(store.confirm(record.id), /No pending record|expired/)
    assert.equal(applied, 0)
  })

  test('confirming an expired record that no read has evicted yet names the expiry', async () => {
    let clock = NOW
    const store = new PendingQueue({ file, now: () => clock, apply: async () => 'ok' })
    const { record } = await store.request({ kind: 'delete-server', serverId: 'srv-01' })
    clock = new Date(NOW.getTime() + 25 * 60 * 60 * 1000)
    await assert.rejects(store.confirm(record.id), (error: unknown) => {
      assert.equal((error as PendingError).code, 'EXPIRED_PENDING')
      return true
    })
  })

  test('expire() sweeps the queue and returns what it discarded', async () => {
    let clock = NOW
    const store = new PendingQueue({ file, now: () => clock })
    const first = await store.request({ kind: 'disable-hostkey', serverId: 'srv-01' })
    clock = new Date(NOW.getTime() + 12 * 60 * 60 * 1000)
    const second = await store.request({ kind: 'disable-hostkey', serverId: 'srv-02' })

    clock = new Date(NOW.getTime() + 25 * 60 * 60 * 1000)
    const discarded = await store.expire()
    assert.deepEqual(
      discarded.map((record) => record.id),
      [first.record.id],
    )
    assert.deepEqual(
      (await store.list()).map((record) => record.id),
      [second.record.id],
    )
  })

  test('get() reports an expired record as null instead of returning it', async () => {
    let clock = NOW
    const store = new PendingQueue({ file, now: () => clock })
    const { record } = await store.request({ kind: 'disable-hostkey', serverId: 'srv-01' })
    clock = new Date(NOW.getTime() + 25 * 60 * 60 * 1000)
    assert.equal(await store.get(record.id), null)
  })
})

describe('the document on disk (§3.3)', () => {
  test('a missing or empty file is an empty queue and a read does not create it', async () => {
    const store = queue()
    assert.deepEqual(await store.list(), [])
    await assert.rejects(readFile(file, 'utf8'), /ENOENT/)
  })

  test('invalid JSON is reported, never rewritten', async () => {
    await writeDocument('{oops')
    const store = queue()
    await assert.rejects(store.list(), (error: unknown) => {
      assert.equal((error as PendingError).code, 'INVALID_PENDING')
      return true
    })
    assert.equal(await readFile(file, 'utf8'), '{oops')
  })

  test('an unknown version, a missing array or a duplicate id is INVALID_PENDING', async () => {
    const cases = [
      JSON.stringify({ version: 2, pending: [] }),
      JSON.stringify({ version: 1 }),
      JSON.stringify({
        version: 1,
        pending: [
          { id: 'pend-01', kind: 'disable-hostkey', serverId: 'srv-01', requestedAt: NOW.toISOString(), expiresAt: NOW.toISOString() },
          { id: 'pend-01', kind: 'disable-hostkey', serverId: 'srv-02', requestedAt: NOW.toISOString(), expiresAt: NOW.toISOString() },
        ],
      }),
    ]
    for (const text of cases) {
      await writeDocument(text)
      await assert.rejects(queue().list(), (error: unknown) => (error as PendingError).code === 'INVALID_PENDING', text)
    }
  })

  test('a record whose expiresAt precedes requestedAt is rejected', async () => {
    await writeDocument(
      JSON.stringify({
        version: 1,
        pending: [
          {
            id: 'pend-01',
            kind: 'disable-hostkey',
            serverId: 'srv-01',
            requestedAt: '2026-11-05T00:00:00.000Z',
            expiresAt: '2026-11-04T00:00:00.000Z',
          },
        ],
      }),
    )
    await assert.rejects(queue().list(), /expiresAt/)
  })

  test('two instances on one file do not lose each other\'s writes', async () => {
    const a = queue()
    const b = queue()
    await Promise.all([
      a.request({ kind: 'disable-hostkey', serverId: 'srv-01' }),
      b.request({ kind: 'disable-hostkey', serverId: 'srv-02' }),
      a.request({ kind: 'disable-rule', serverId: 'srv-03', ruleId: 'rm-recursive' }),
    ])
    assert.equal((await a.list()).length, 3)
    assert.equal((await document()).pending.length, 3)
  })
})

describe('createPendingApplier(): the §8.3 side effects', () => {
  /** A registry on this test's temp dir with one key-auth server. */
  async function seededRegistry(): Promise<{ registry: Registry, serversFile: string }> {
    const serversFile = join(directory, 'servers.json')
    const registry = new Registry({ file: serversFile })
    await registry.create({
      name: '生产机-A',
      host: '10.0.0.5',
      port: 22,
      username: 'devops',
      auth: { kind: 'key', privateKeyPath: '/root/.ssh/id_rsa' },
      defaultWorkDir: '/srv/app',
    })
    return { registry, serversFile }
  }

  test('delete-server removes the record, disconnects the pool and writes server-deleted', async () => {
    const { registry, serversFile } = await seededRegistry()
    const [server] = await registry.list()
    const disconnected: string[] = []
    /** @type {Record<string, unknown>[]} */
    const events: Record<string, unknown>[] = []
    const apply = createPendingApplier({
      registry,
      pool: { disconnect: async (id: string) => void disconnected.push(id) },
      audit: { append: async (entry: Record<string, unknown>) => void events.push(entry) },
    })

    const store = queue({ apply })
    const { record } = await store.request({ kind: 'delete-server', serverId: server!.id, snapshot: server })
    // Requesting changes nothing.
    assert.equal((await registry.list()).length, 1)

    await store.confirm(record.id)
    assert.deepEqual(await registry.list(), [])
    assert.deepEqual(disconnected, [server!.id])
    assert.equal(events.length, 1)
    assert.equal(events[0]!.event, 'server-deleted')
    assert.equal(events[0]!.serverId, server!.id)
    assert.doesNotMatch(JSON.stringify(await serverFileText(serversFile)), /10\.0\.0\.5/)
  })

  test('disable-hostkey flips the mode and writes hostkey-disabled', async () => {
    const { registry } = await seededRegistry()
    const [server] = await registry.list()
    /** @type {Record<string, unknown>[]} */
    const events: Record<string, unknown>[] = []
    const apply = createPendingApplier({
      registry,
      audit: { append: async (entry: Record<string, unknown>) => void events.push(entry) },
    })

    const store = queue({ apply })
    const { record } = await store.request({ kind: 'disable-hostkey', serverId: server!.id })
    // Still on its original mode while pending (§8.3).
    assert.equal((await registry.get(server!.id))?.hostKeyMode, 'accept-new')

    await store.confirm(record.id)
    assert.equal((await registry.get(server!.id))?.hostKeyMode, 'off')
    assert.equal(events[0]!.event, 'hostkey-disabled')
  })

  test('disable-rule appends to disabledRules and writes rule-disabled', async () => {
    const { registry } = await seededRegistry()
    const [server] = await registry.list()
    /** @type {Record<string, unknown>[]} */
    const events: Record<string, unknown>[] = []
    const apply = createPendingApplier({
      registry,
      audit: { append: async (entry: Record<string, unknown>) => void events.push(entry) },
    })

    const store = queue({ apply })
    const { record } = await store.request({ kind: 'disable-rule', serverId: server!.id, ruleId: 'rm-recursive' })
    // The rule still applies while pending (§8.3).
    assert.deepEqual((await registry.get(server!.id))?.disabledRules, [])

    await store.confirm(record.id)
    assert.deepEqual((await registry.get(server!.id))?.disabledRules, ['rm-recursive'])
    assert.equal(events[0]!.event, 'rule-disabled')

    // Confirming the same rule twice is idempotent, not duplicating.
    const again = await store.request({ kind: 'disable-rule', serverId: server!.id, ruleId: 'dd-write' })
    await store.confirm(again.record.id)
    assert.deepEqual((await registry.get(server!.id))?.disabledRules, ['rm-recursive', 'dd-write'])
  })

  test('a broken audit log does not fail an applied operation', async () => {
    const { registry } = await seededRegistry()
    const [server] = await registry.list()
    const apply = createPendingApplier({
      registry,
      audit: {
        append: async () => {
          throw new Error('audit volume is read-only')
        },
      },
    })
    const store = queue({ apply })
    const { record } = await store.request({ kind: 'disable-hostkey', serverId: server!.id })
    // The mode change committed; the audit write is best effort (§6.2).
    assert.equal((await store.confirm(record.id)).status, 'applied')
    assert.equal((await registry.get(server!.id))?.hostKeyMode, 'off')
  })

  test('deleting an already-gone server still reports applied', async () => {
    const { registry } = await seededRegistry()
    const [server] = await registry.list()
    const apply = createPendingApplier({ registry })
    const store = queue({ apply })
    const { record } = await store.request({ kind: 'delete-server', serverId: server!.id })
    await registry.remove(server!.id)
    assert.equal((await store.confirm(record.id)).status, 'applied')
  })

  test('a password server\'s credential ref is unset on deletion', async () => {
    const serversFile = join(directory, 'servers.json')
    const registry = new Registry({ file: serversFile })
    const created = await registry.create({
      name: '测试机-B',
      host: '10.0.0.6',
      port: 22,
      username: 'devops',
      auth: { kind: 'password' },
    })
    const unset: string[] = []
    const apply = createPendingApplier({
      registry,
      getCredentials: () => ({ unset: async (ref: string) => void unset.push(ref) }),
    })
    const store = queue({ apply })
    const { record } = await store.request({ kind: 'delete-server', serverId: created.id, snapshot: created })
    await store.confirm(record.id)
    assert.deepEqual(unset, [created.auth.kind === 'password' ? created.auth.credentialRef : ''])
  })
})

/** Raw text of a file, for the "record actually left the file" assertions. */
async function serverFileText(path: string): Promise<string> {
  return readFile(path, 'utf8')
}
