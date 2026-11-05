// Tests for the server registry (design doc §3.1, §5.2, §6.3).
//
// Run with: node --test tests/registry.test.ts   (Node strips the types natively)
// or:       npm test
//
// Every test gets its own temp directory, so the real
// $DSH_HOME/server-connector/servers.json is never touched. Coverage follows
// the phase-2 issue: first creation from an empty file, CRUD, unique-name
// conflicts, port bounds, and all five resolve() paths (§5.2).

import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import {
  REGISTRY_VERSION,
  Registry,
  RegistryError,
  connectorDirectory,
  defaultServersFile,
  dshHome,
} from '../lib/registry.js'
import type { ServerRecord } from '../lib/registry.js'

/** A complete valid create() payload; tests override single fields. */
const VALID_INPUT = {
  name: '生产机-A',
  host: '10.0.0.5',
  port: 22,
  username: 'devops',
  auth: { kind: 'key', privateKeyPath: '/root/.ssh/id_rsa' },
  hostKeyMode: 'accept-new',
  defaultWorkDir: '/srv/app',
  policy: { 'rm-recursive': 'block', 'service-restart': 'confirm' },
  disabledRules: ['docker-prune'],
}

let directory: string
let registry: Registry
let file: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-registry-'))
  file = join(directory, 'server-connector', 'servers.json')
  registry = new Registry({ file })
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** Run `operation` and return the RegistryError it must throw. */
async function rejection(operation: Promise<unknown>): Promise<RegistryError> {
  try {
    await operation
  } catch (error) {
    assert.ok(error instanceof RegistryError, `expected a RegistryError, got ${String(error)}`)
    return error
  }
  assert.fail('expected the operation to reject')
}

/** Read the raw JSON document on disk. */
async function readDocument(): Promise<{ version: number; servers: ServerRecord[] }> {
  return JSON.parse(await readFile(file, 'utf8'))
}

describe('paths (§3.5)', () => {
  test('default file lives under $DSH_HOME/server-connector', () => {
    assert.equal(defaultServersFile({ DSH_HOME: '/var/lib/dsh' }), '/var/lib/dsh/server-connector/servers.json')
    assert.equal(connectorDirectory({ DSH_HOME: '/var/lib/dsh' }), '/var/lib/dsh/server-connector')
  })

  test('$DSH_HOME falls back to ~/.dsh when unset or blank', () => {
    assert.equal(dshHome({}).endsWith('/.dsh'), true)
    assert.equal(dshHome({ DSH_HOME: '   ' }).endsWith('/.dsh'), true)
    assert.equal(dshHome({ DSH_HOME: '/srv/dsh' }), '/srv/dsh')
  })
})

describe('first creation from nothing', () => {
  test('a missing file is an empty registry and is not created by a read', async () => {
    assert.deepEqual(await registry.list(), [])
    assert.equal(await registry.get('srv-01'), null)
    await assert.rejects(readFile(file, 'utf8'))
  })

  test('create() on a missing file makes the directory and a valid document', async () => {
    const created = await registry.create(VALID_INPUT)
    assert.equal(created.id, 'srv-01')
    assert.deepEqual(created, {
      id: 'srv-01',
      name: '生产机-A',
      host: '10.0.0.5',
      port: 22,
      username: 'devops',
      auth: { kind: 'key', privateKeyPath: '/root/.ssh/id_rsa' },
      hostKeyMode: 'accept-new',
      defaultWorkDir: '/srv/app',
      enabled: true,
      policy: { 'rm-recursive': 'block', 'service-restart': 'confirm' },
      disabledRules: ['docker-prune'],
      customRules: [],
      createdAt: created.createdAt,
      lastConnectedAt: null,
    })
    assert.match(created.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    assert.deepEqual(await readDocument(), { version: REGISTRY_VERSION, servers: [created] })
  })

  test('an empty file is treated as an empty registry', async () => {
    await mkdir(join(directory, 'server-connector'), { recursive: true })
    await writeFile(file, '', 'utf8')
    assert.deepEqual(await registry.list(), [])
    const created = await registry.create(VALID_INPUT)
    assert.deepEqual((await readDocument()).servers.map((server) => server.id), [created.id])
  })

  test('defaults fill in port, hostKeyMode, auth, policy and disabledRules', async () => {
    const created = await registry.create({ name: 'bare', host: 'example.test', username: 'root' })
    assert.equal(created.port, 22)
    assert.equal(created.hostKeyMode, 'accept-new')
    assert.deepEqual(created.auth, { kind: 'agent' })
    assert.deepEqual(created.policy, {})
    assert.deepEqual(created.disabledRules, [])
    assert.equal(created.defaultWorkDir, null)
    assert.equal(created.lastConnectedAt, null)
  })

  test('ids are sequential and stable', async () => {
    const first = await registry.create(VALID_INPUT)
    const second = await registry.create({ ...VALID_INPUT, name: '生产机-B' })
    assert.equal(first.id, 'srv-01')
    assert.equal(second.id, 'srv-02')
    assert.deepEqual(
      (await registry.list()).map((server) => server.id),
      ['srv-01', 'srv-02'],
    )
  })

  test('the file is written atomically and leaves no temp file behind', async () => {
    await registry.create(VALID_INPUT)
    await registry.update('srv-01', { name: '改名' })
    const entries = await readdir(join(directory, 'server-connector'))
    assert.deepEqual(entries, ['servers.json'])
  })

  test('the file and its directory are private (0600 / 0700) on POSIX', async () => {
    if (process.platform === 'win32') return
    await registry.create(VALID_INPUT)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    assert.equal((await stat(join(directory, 'server-connector'))).mode & 0o777, 0o700)
  })

  test('a rewrite replaces a loosened file mode with 0600', async () => {
    if (process.platform === 'win32') return
    await registry.create(VALID_INPUT)
    await chmod(file, 0o644)
    await registry.update('srv-01', { host: '10.0.0.6' })
    // The atomic replace installs a fresh 0600 inode; a loose mode never persists.
    assert.equal((await stat(file)).mode & 0o777, 0o600)
  })
})

describe('CRUD', () => {
  test('get() returns a copy, never the instance state', async () => {
    const created = await registry.create(VALID_INPUT)
    const fetched = await registry.get(created.id)
    assert.deepEqual(fetched, created)
    assert.ok(fetched)
    fetched.name = 'mutated'
    assert.equal((await registry.get(created.id))?.name, '生产机-A')
  })

  test('list() returns records in file order', async () => {
    await registry.create(VALID_INPUT)
    await registry.create({ ...VALID_INPUT, name: 'B', host: '10.0.0.6' })
    assert.deepEqual(
      (await registry.list()).map((server) => server.name),
      ['生产机-A', 'B'],
    )
  })

  test('update() merges a patch and keeps id and createdAt', async () => {
    const created = await registry.create(VALID_INPUT)
    const updated = await registry.update(created.id, {
      port: 2222,
      defaultWorkDir: '/srv/other',
      lastConnectedAt: '2026-11-04T09:20:00Z',
      policy: { 'rm-recursive': 'confirm' },
    })
    assert.equal(updated.id, created.id)
    assert.equal(updated.createdAt, created.createdAt)
    assert.equal(updated.port, 2222)
    assert.equal(updated.defaultWorkDir, '/srv/other')
    assert.equal(updated.lastConnectedAt, '2026-11-04T09:20:00.000Z')
    assert.deepEqual(updated.policy, { 'rm-recursive': 'confirm' })
    // Untouched fields survive the merge.
    assert.equal(updated.name, created.name)
    assert.equal(updated.host, created.host)
    assert.deepEqual(await readDocument(), { version: REGISTRY_VERSION, servers: [updated] })
  })

  test('update() validates the merged record, not just the patch', async () => {
    const created = await registry.create(VALID_INPUT)
    const error = await rejection(registry.update(created.id, { host: '  ' }))
    assert.equal(error.code, 'INVALID_SERVER')
    // A rejected patch leaves the stored record untouched.
    assert.deepEqual(await registry.get(created.id), created)
  })

  test('id and createdAt are immutable', async () => {
    const created = await registry.create(VALID_INPUT)
    assert.equal((await rejection(registry.update(created.id, { id: 'srv-99' }))).code, 'INVALID_SERVER')
    assert.equal(
      (await rejection(registry.update(created.id, { createdAt: '2020-01-01T00:00:00Z' }))).code,
      'INVALID_SERVER',
    )
    assert.equal((await registry.get(created.id))?.id, 'srv-01')
  })

  test('update() of an unknown id is UNKNOWN_SERVER and lists what exists', async () => {
    await registry.create(VALID_INPUT)
    const error = await rejection(registry.update('nope', { port: 22 }))
    assert.equal(error.code, 'UNKNOWN_SERVER')
    assert.match(error.message, /srv-01/)
  })

  test('remove() deletes the record and returns it', async () => {
    const first = await registry.create(VALID_INPUT)
    const second = await registry.create({ ...VALID_INPUT, name: 'B', host: '10.0.0.6' })
    const removed = await registry.remove(first.id)
    assert.deepEqual(removed, first)
    assert.equal(await registry.get(first.id), null)
    assert.deepEqual((await readDocument()).servers, [second])
  })

  test('remove() of an unknown id is UNKNOWN_SERVER', async () => {
    assert.equal((await rejection(registry.remove('srv-42'))).code, 'UNKNOWN_SERVER')
  })

  test('two instances on the same file do not lose each other\'s writes', async () => {
    const other = new Registry({ file })
    const [a, b] = await Promise.all([
      registry.create(VALID_INPUT),
      other.create({ ...VALID_INPUT, name: 'B', host: '10.0.0.6' }),
    ])
    assert.notEqual(a.id, b.id)
    assert.deepEqual(
      (await registry.list()).map((server) => server.id).sort(),
      [a.id, b.id].sort(),
    )
  })

  test('concurrent creates both land (mutations are serialised)', async () => {
    const [a, b] = await Promise.all([
      registry.create(VALID_INPUT),
      registry.create({ ...VALID_INPUT, name: 'B', host: '10.0.0.6' }),
    ])
    assert.notEqual(a.id, b.id)
    assert.deepEqual(
      (await registry.list()).map((server) => server.name).sort(),
      ['B', '生产机-A'].sort(),
    )
  })
})

describe('validation', () => {
  test('a duplicate name is DUPLICATE_NAME, including case-only differences', async () => {
    await registry.create(VALID_INPUT)
    assert.equal((await rejection(registry.create(VALID_INPUT))).code, 'DUPLICATE_NAME')
    const caseOnly = await rejection(
      registry.create({ ...VALID_INPUT, name: '生产机-a', host: '10.0.0.7' }),
    )
    assert.equal(caseOnly.code, 'DUPLICATE_NAME')
    assert.equal((await registry.list()).length, 1)
  })

  test('renaming onto another server\'s name is DUPLICATE_NAME; renaming to itself is fine', async () => {
    await registry.create(VALID_INPUT)
    await registry.create({ ...VALID_INPUT, name: 'B', host: '10.0.0.6' })
    assert.equal((await rejection(registry.update('srv-02', { name: '生产机-A' }))).code, 'DUPLICATE_NAME')
    // Retyping your own name (even with different casing/whitespace) is not a conflict.
    const renamed = await registry.update('srv-02', { name: '  b ' })
    assert.equal(renamed.name, 'b')
  })

  test('port outside 1..65535 or non-integer is INVALID_SERVER', async () => {
    for (const port of [0, -1, 65536, 1.5, Number.NaN, '22' as never, null as never]) {
      const error = await rejection(registry.create({ ...VALID_INPUT, port } as never))
      assert.equal(error.code, 'INVALID_SERVER', `port=${String(port)}`)
      assert.match(error.message, /port/)
    }
    assert.equal((await registry.create({ ...VALID_INPUT, port: 1 })).port, 1)
    assert.equal((await registry.create({ ...VALID_INPUT, name: 'B', port: 65535 })).port, 65535)
  })

  test('name, host and username must be non-empty strings', async () => {
    for (const field of ['name', 'host', 'username'] as const) {
      for (const value of ['', '   ', 42 as never, null as never]) {
        const error = await rejection(registry.create({ ...VALID_INPUT, [field]: value } as never))
        assert.equal(error.code, 'INVALID_SERVER', `${field}=${String(value)}`)
      }
    }
  })

  test('hostKeyMode and auth are constrained to the spec values', async () => {
    assert.equal((await rejection(registry.create({ ...VALID_INPUT, hostKeyMode: 'yes' as never }))).code, 'INVALID_SERVER')
    assert.equal((await rejection(registry.create({ ...VALID_INPUT, auth: { kind: 'sudo' } as never }))).code, 'INVALID_SERVER')
    assert.equal(
      (await rejection(registry.create({ ...VALID_INPUT, auth: { kind: 'key' } as never }))).code,
      'INVALID_SERVER',
    )
  })

  test('policy decisions are allow/confirm/block only', async () => {
    const error = await rejection(registry.create({ ...VALID_INPUT, policy: { 'rm-recursive': 'deny' } as never }))
    assert.equal(error.code, 'INVALID_SERVER')
    assert.match(error.message, /rm-recursive/)
  })

  test('an unknown field is rejected so a typo cannot silently vanish', async () => {
    const error = await rejection(registry.create({ ...VALID_INPUT, defaulWorkDir: '/typo' } as never))
    assert.equal(error.code, 'INVALID_SERVER')
    assert.match(error.message, /defaulWorkDir/)
  })

  test('plaintext secrets are refused, and password auth keeps only a credentialRef (§6.3)', async () => {
    for (const field of ['password', 'passphrase', 'privateKey']) {
      const error = await rejection(registry.create({ ...VALID_INPUT, auth: { kind: 'password', [field]: 'hunter2' } } as never))
      assert.equal(error.code, 'INVALID_SERVER', field)
      assert.match(error.message, /plaintext/i)
    }
    const created = await registry.create({
      ...VALID_INPUT,
      name: '密码机',
      auth: { kind: 'password', credentialRef: 'server-connector:srv-02:password' },
    })
    assert.deepEqual(created.auth, { kind: 'password', credentialRef: 'server-connector:srv-02:password' })
    const text = await readFile(file, 'utf8')
    assert.equal(text.includes('hunter2'), false)
    assert.equal(/"(?:password|passphrase|privateKey)"\s*:/.test(text), false)
  })

  test('password auth without a credentialRef derives the conventional ref from the id', async () => {
    const created = await registry.create({ ...VALID_INPUT, auth: { kind: 'password' } as never })
    assert.deepEqual(created.auth, { kind: 'password', credentialRef: `server-connector:${created.id}:password` })
  })
})

describe('resolve() — the five §5.2 paths', () => {
  beforeEach(async () => {
    await registry.create({ ...VALID_INPUT, name: '生产机-A' }) // srv-01
    await registry.create({ ...VALID_INPUT, name: '测试机-B', host: '10.0.0.6' }) // srv-02
    await registry.create({ ...VALID_INPUT, name: 'proddb-C', host: '10.0.0.7' }) // srv-03
    await registry.create({ ...VALID_INPUT, name: 'prodweb-D', host: '10.0.0.8' }) // srv-04
  })

  test('1/5 exact id wins', async () => {
    assert.equal((await registry.resolve('srv-02')).name, '测试机-B')
  })

  test('2/5 exact name wins, case-insensitively', async () => {
    assert.equal((await registry.resolve('生产机-A')).id, 'srv-01')
    assert.equal((await registry.resolve('PRODDB-C')).id, 'srv-03')
  })

  test('3/5 a unique prefix of an id or a name wins', async () => {
    assert.equal((await registry.resolve('测试')).id, 'srv-02')
    assert.equal((await registry.resolve('proddb')).id, 'srv-03')
    // "srv-0" prefixes every id, so it must stay ambiguous rather than guess.
    assert.equal((await rejection(registry.resolve('srv-0'))).code, 'AMBIGUOUS_SERVER')
  })

  test('4/5 zero matches is UNKNOWN_SERVER and lists every server', async () => {
    const error = await rejection(registry.resolve('nope'))
    assert.equal(error.code, 'UNKNOWN_SERVER')
    assert.match(error.message, /srv-01/)
    assert.match(error.message, /srv-02/)
    assert.match(error.message, /srv-03/)
    assert.match(error.message, /生产机-A/)
    assert.deepEqual(error.available, ['srv-01', 'srv-02', 'srv-03', 'srv-04'])
  })

  test('5/5 several prefix matches is AMBIGUOUS_SERVER and lists the candidates', async () => {
    const error = await rejection(registry.resolve('prod'))
    assert.equal(error.code, 'AMBIGUOUS_SERVER')
    assert.deepEqual(error.candidates, ['srv-03', 'srv-04'])
    assert.match(error.message, /proddb-C/)
    assert.match(error.message, /prodweb-D/)
  })

  test('exact id/name beat prefix matches', async () => {
    await registry.create({ ...VALID_INPUT, name: 'proddb', host: '10.0.0.9' }) // srv-05
    // "proddb" is an exact name (srv-05) and a prefix of proddb-C (srv-03).
    assert.equal((await registry.resolve('proddb')).id, 'srv-05')
    assert.equal((await registry.resolve('proddb-C')).id, 'srv-03')
  })

  test('blank and non-string queries are INVALID_SERVER', async () => {
    for (const query of ['', '   ', 42 as never, null as never]) {
      assert.equal((await rejection(registry.resolve(query))).code, 'INVALID_SERVER', String(query))
    }
  })

  test('resolve() returns a copy', async () => {
    const resolved = await registry.resolve('srv-01')
    resolved.name = 'mutated'
    assert.equal((await registry.get('srv-01'))?.name, '生产机-A')
  })
})

describe('file-level failures are reported, never silently rewritten', () => {
  test('invalid JSON is INVALID_REGISTRY and the file is left alone', async () => {
    await mkdir(join(directory, 'server-connector'), { recursive: true })
    await writeFile(file, '{ not json', 'utf8')
    const error = await rejection(registry.list())
    assert.equal(error.code, 'INVALID_REGISTRY')
    assert.equal(await readFile(file, 'utf8'), '{ not json')
  })

  test('an unsupported version is INVALID_REGISTRY', async () => {
    await mkdir(join(directory, 'server-connector'), { recursive: true })
    await writeFile(file, JSON.stringify({ version: 2, servers: [] }), 'utf8')
    assert.equal((await rejection(registry.list())).code, 'INVALID_REGISTRY')
  })

  test('duplicate ids or names inside the file are INVALID_REGISTRY', async () => {
    const record = {
      ...VALID_INPUT,
      id: 'srv-01',
      createdAt: '2026-11-04T09:00:00Z',
      lastConnectedAt: null,
    }
    await mkdir(join(directory, 'server-connector'), { recursive: true })
    await writeFile(file, JSON.stringify({ version: 1, servers: [record, record] }), 'utf8')
    assert.equal((await rejection(registry.list())).code, 'INVALID_REGISTRY')
  })

  test('a stored record with an invalid field is INVALID_REGISTRY', async () => {
    const record = { ...VALID_INPUT, id: 'srv-01', port: 99999, createdAt: '2026-11-04T09:00:00Z', lastConnectedAt: null }
    await mkdir(join(directory, 'server-connector'), { recursive: true })
    await writeFile(file, JSON.stringify({ version: 1, servers: [record] }), 'utf8')
    assert.equal((await rejection(registry.list())).code, 'INVALID_REGISTRY')
  })
})

describe('customRules (§4.4)', () => {
  /** A minimal valid rule; `id` is supplied per test. */
  const customRule = (overrides: Record<string, unknown> = {}) => ({
    id: 'custom-1',
    label: '删 Docker 卷',
    pattern: String.raw`docker\s+compose\s+down\s+-v`,
    defaultDecision: 'confirm',
    description: 'down -v 会删除命名卷。',
    ...overrides,
  })

  test('create() stores custom rules and defaults them to an empty list', async () => {
    const plain = await registry.create({ ...VALID_INPUT, name: '无规则' })
    assert.deepEqual(plain.customRules, [])

    const withRule = await registry.create({ ...VALID_INPUT, name: '有规则', customRules: [customRule()] })
    assert.equal(withRule.customRules.length, 1)
    assert.equal(withRule.customRules[0]!.id, 'custom-1')
    // The stored record round-trips through the file with the rule intact.
    const reread = await registry.get(withRule.id)
    assert.deepEqual(reread?.customRules, withRule.customRules)
  })

  test('create() rejects an invalid rule and never writes it', async () => {
    await assert.rejects(
      registry.create({ ...VALID_INPUT, name: '坏规则', customRules: [customRule({ defaultDecision: 'allow' })] }),
      (error: unknown) => /customRules/.test((error as Error).message),
    )
    // A duplicate id inside one record is refused too.
    await assert.rejects(
      registry.create({
        ...VALID_INPUT,
        name: '重复 id',
        customRules: [customRule(), customRule()],
      }),
      (error: unknown) => /already in use/.test((error as Error).message),
    )
    // A built-in id cannot be shadowed.
    await assert.rejects(
      registry.create({ ...VALID_INPUT, name: '撞内置', customRules: [customRule({ id: 'rm-recursive' })] }),
      (error: unknown) => /already in use/.test((error as Error).message),
    )
  })

  test('update() can add and remove custom rules', async () => {
    const created = await registry.create({ ...VALID_INPUT, name: '可改规则' })
    const added = await registry.update(created.id, { customRules: [customRule()] })
    assert.equal(added.customRules.length, 1)
    const cleared = await registry.update(created.id, { customRules: [] })
    assert.deepEqual(cleared.customRules, [])
  })

  test('a hand-edited servers.json without customRules still loads', async () => {
    // Older files predate the field; load must default it rather than fail.
    await mkdir(join(directory, 'server-connector'), { recursive: true })
    const doc = { version: REGISTRY_VERSION, servers: [{ ...VALID_INPUT, id: 'srv-01', createdAt: '2026-01-01T00:00:00.000Z', lastConnectedAt: null }] }
    await writeFile(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
    const loaded = await registry.get('srv-01')
    assert.deepEqual(loaded?.customRules, [])
  })
})

describe('the enable switch (§3.1, enable-switch spec)', () => {
  test('create() defaults to enabled and round-trips the flag', async () => {
    const on = await registry.create({ ...VALID_INPUT, name: '开' })
    assert.equal(on.enabled, true)
    const off = await registry.create({ ...VALID_INPUT, name: '关', enabled: false })
    assert.equal(off.enabled, false)
    assert.equal((await registry.get(off.id))?.enabled, false)
  })

  test('a record without the field loads as enabled, never as disabled', async () => {
    // Files written before the switch existed carry no `enabled` key; treating
    // the absence as "disabled" would silently cut every existing server off.
    await mkdir(join(directory, 'server-connector'), { recursive: true })
    const { enabled: _drop, ...rest } = VALID_INPUT as Record<string, unknown>
    const legacy = { ...rest, id: 'srv-01', createdAt: '2026-01-01T00:00:00.000Z', lastConnectedAt: null }
    await writeFile(file, `${JSON.stringify({ version: REGISTRY_VERSION, servers: [legacy] }, null, 2)}\n`, 'utf8')
    assert.equal((await registry.get('srv-01'))?.enabled, true)
  })

  test('update() flips the flag and rejects a non-boolean', async () => {
    const created = await registry.create({ ...VALID_INPUT, name: '可切' })
    assert.equal((await registry.update(created.id, { enabled: false })).enabled, false)
    assert.equal((await registry.update(created.id, { enabled: true })).enabled, true)
    await assert.rejects(
      registry.update(created.id, { enabled: 'no' }),
      (error: unknown) => /enabled must be a boolean/.test((error as Error).message),
    )
  })
})
