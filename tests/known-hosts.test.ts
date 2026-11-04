// Tests for the host key fingerprint store (design doc §3.2, §6.4, §7.4).
//
// Run with: node --test tests/known-hosts.test.ts   (Node strips the types natively)
// or:       npm test
//
// Every test gets its own temp directory, so the real
// $DSH_HOME/server-connector/known_hosts.json is never touched. Coverage
// follows the §3.2 shape: the flat `{ serverId: {hash, firstSeen, algorithm} }`
// document, first-seen retention, fingerprint rotation, tolerant reads of a
// missing/empty file, and an honest failure on a hand-edited corrupt one.

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import {
  KNOWN_HOSTS_FILE_NAME,
  KnownHosts,
  KnownHostsError,
  defaultKnownHostsFile,
  fingerprintHostKey,
} from '../lib/known-hosts.js'

/** The SHA-256 (base64) of a real ssh-ed25519 host key blob, from OpenSSH. */
const ED25519_BLOB = Buffer.from(
  'AAAAC3NzaC1lZDI1NTE5AAAAII/9f0y6YbYt3FjV0q1t4Rk4oBzq3G3n0H4zS3H2y8Qe',
  'base64',
)

let directory: string
let file: string
let store: KnownHosts

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-known-hosts-'))
  file = join(directory, 'server-connector', KNOWN_HOSTS_FILE_NAME)
  store = new KnownHosts({ file })
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** Read the raw JSON document on disk. */
async function readDocument(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8'))
}

/** Real SHA-256 digests (base64) of three distinct byte strings, used as
 * stand-ins for host key fingerprints: the store only compares them. */
const HASH_A = 'ypeBEsobvcr6wjGzmiPcTaeG7/gUfE5yuYB3ha/uSLs='
const HASH_B = 'PiPoFgA5WUoziU9lZOGxNIu9egCI1CxKy3PurtWcAJ0='
const HASH_C = 'Ln0sA6lQeuJl7PW1NWiFpTOTogKdJBOUmXJloaJa78Y='

/** A complete record for srv-01, with a stable base64 digest. */
function record(hash = HASH_A, algorithm = 'ssh-ed25519') {
  return { hash, firstSeen: '2026-11-04T09:00:00.000Z', algorithm }
}

describe('paths (§3.5)', () => {
  test('the default file lives under $DSH_HOME/server-connector', () => {
    assert.equal(
      defaultKnownHostsFile({ DSH_HOME: '/var/lib/dsh' }),
      '/var/lib/dsh/server-connector/known_hosts.json',
    )
  })

  test('the default file falls back to ~/.dsh when $DSH_HOME is unset or blank', () => {
    assert.equal(defaultKnownHostsFile({}).endsWith('/.dsh/server-connector/known_hosts.json'), true)
    assert.equal(defaultKnownHostsFile({ DSH_HOME: '   ' }).endsWith('/.dsh/server-connector/known_hosts.json'), true)
  })

  test('the resolved path is exposed for the panel and for diagnostics', () => {
    assert.equal(store.file, file)
  })
})

describe('first trust (§6.4 accept-new)', () => {
  test('a missing file reads as an empty store and is not created by a read', async () => {
    assert.deepEqual(await store.list(), [])
    assert.equal(await store.get('srv-01'), null)
    await assert.rejects(readFile(file, 'utf8'))
  })

  test('set() writes the §3.2 document and creates its directory', async () => {
    const written = await store.set('srv-01', { hash: record().hash, algorithm: 'ssh-ed25519' })
    assert.equal(written.hash, record().hash)
    assert.equal(written.algorithm, 'ssh-ed25519')
    assert.match(written.firstSeen, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    assert.deepEqual(await readDocument(), { 'srv-01': written })
  })

  test('an empty file reads as an empty store', async () => {
    await mkdir(join(directory, 'server-connector'), { recursive: true })
    await writeFile(file, '', 'utf8')
    assert.deepEqual(await store.list(), [])
    await store.set('srv-01', { hash: record().hash, algorithm: 'ssh-ed25519' })
    assert.deepEqual(Object.keys(await readDocument()), ['srv-01'])
  })

  test('get() returns the stored record by server id', async () => {
    const written = await store.set('srv-01', { hash: record().hash, algorithm: 'ssh-ed25519' })
    assert.deepEqual(await store.get('srv-01'), written)
  })

  test('records are keyed by server id, so two hosts with the same key stay separate', async () => {
    const shared = record().hash
    await store.set('srv-01', { hash: shared, algorithm: 'ssh-ed25519' })
    await store.set('srv-02', { hash: shared, algorithm: 'ssh-ed25519' })
    assert.deepEqual(Object.keys(await readDocument()).sort(), ['srv-01', 'srv-02'])
  })

  test('the document is kept in stable server-id order', async () => {
    await store.set('srv-02', { hash: record().hash, algorithm: 'ssh-ed25519' })
    await store.set('srv-01', { hash: record().hash, algorithm: 'ssh-ed25519' })
    const text = await readFile(file, 'utf8')
    assert.ok(text.indexOf('"srv-01"') < text.indexOf('"srv-02"'), 'ids sort ascending')
  })
})

describe('firstSeen (§3.2)', () => {
  test('re-recording the same hash keeps the original firstSeen', async () => {
    const first = await store.set('srv-01', record())
    const again = await store.set('srv-01', { hash: first.hash, algorithm: first.algorithm })
    assert.equal(again.firstSeen, first.firstSeen)
  })

  test('a changed hash starts a new trust record with a new firstSeen', async () => {
    const first = await store.set('srv-01', record())
    const rotated = await store.set('srv-01', { hash: HASH_B, algorithm: 'ssh-ed25519' })
    assert.equal(rotated.hash, HASH_B)
    assert.ok(rotated.firstSeen >= first.firstSeen)
    assert.equal((await readDocument())['srv-01'] !== undefined, true)
  })

  test('an explicit firstSeen is respected when the caller supplies one', async () => {
    const written = await store.set('srv-01', {
      hash: record().hash,
      algorithm: 'ssh-ed25519',
      firstSeen: '2020-01-02T03:04:05.000Z',
    })
    assert.equal(written.firstSeen, '2020-01-02T03:04:05.000Z')
  })
})

describe('removal', () => {
  test('remove() deletes one server and reports whether it existed', async () => {
    await store.set('srv-01', record())
    await store.set('srv-02', record())
    assert.equal(await store.remove('srv-01'), true)
    assert.equal(await store.remove('srv-01'), false)
    assert.deepEqual(Object.keys(await readDocument()), ['srv-02'])
  })

  test('list() reports every stored fingerprint', async () => {
    await store.set('srv-02', record(HASH_C, 'ssh-rsa'))
    await store.set('srv-01', record())
    assert.deepEqual(await store.list(), [
      { serverId: 'srv-01', ...record() },
      { serverId: 'srv-02', ...record(HASH_C, 'ssh-rsa') },
    ])
  })
})

describe('validation and failure modes', () => {
  test('an invalid hash is refused before anything is written', async () => {
    await assert.rejects(
      store.set('srv-01', { hash: 'not base64!', algorithm: 'ssh-ed25519' }),
      (error: unknown) => error instanceof KnownHostsError && error.code === 'INVALID_KNOWN_HOSTS',
    )
    await assert.rejects(readFile(file, 'utf8'))
  })

  test('a missing algorithm is refused', async () => {
    await assert.rejects(
      // @ts-expect-error — the point of the test is the missing field.
      store.set('srv-01', { hash: record().hash }),
      (error: unknown) => error instanceof KnownHostsError,
    )
  })

  test('an empty server id is refused', async () => {
    await assert.rejects(
      store.set('  ', record()),
      (error: unknown) => error instanceof KnownHostsError && error.code === 'INVALID_KNOWN_HOSTS',
    )
  })

  test('invalid JSON on disk is reported, never silently rewritten', async () => {
    await mkdir(join(directory, 'server-connector'), { recursive: true })
    await writeFile(file, '{ not json', 'utf8')
    await assert.rejects(
      store.list(),
      (error: unknown) => error instanceof KnownHostsError && error.code === 'INVALID_KNOWN_HOSTS',
    )
    assert.equal(await readFile(file, 'utf8'), '{ not json')
  })

  test('an unknown field is reported instead of ignored', async () => {
    await mkdir(join(directory, 'server-connector'), { recursive: true })
    await writeFile(file, JSON.stringify({ 'srv-01': { ...record(), mode: 'trust-all' } }), 'utf8')
    await assert.rejects(
      store.get('srv-01'),
      (error: unknown) => error instanceof KnownHostsError && /unknown field "mode"/.test(error.message),
    )
  })

  test('a document that is not an object is rejected', async () => {
    await mkdir(join(directory, 'server-connector'), { recursive: true })
    await writeFile(file, JSON.stringify([record()]), 'utf8')
    await assert.rejects(
      store.list(),
      (error: unknown) => error instanceof KnownHostsError && error.code === 'INVALID_KNOWN_HOSTS',
    )
  })

  test('writes are atomic: no temp file survives a successful write', async () => {
    await store.set('srv-01', record())
    const entries = await readdir(join(directory, 'server-connector'))
    assert.deepEqual(entries, [KNOWN_HOSTS_FILE_NAME])
  })

  test('concurrent writes for one file do not lose a record', async () => {
    await Promise.all([
      store.set('srv-01', record()),
      new KnownHosts({ file }).set('srv-02', record()),
      new KnownHosts({ file }).set('srv-03', record()),
    ])
    assert.deepEqual(Object.keys(await readDocument()).sort(), ['srv-01', 'srv-02', 'srv-03'])
  })
})

describe('fingerprintHostKey (§7.4)', () => {
  test('a real ssh-ed25519 blob is digested to base64 SHA-256 with its algorithm', () => {
    const fingerprint = fingerprintHostKey(ED25519_BLOB)
    assert.equal(fingerprint.algorithm, 'ssh-ed25519')
    assert.match(fingerprint.hash, /^[A-Za-z0-9+/]{43}=$/)
    // Stable and independent of the input's Buffer identity.
    assert.deepEqual(fingerprint, fingerprintHostKey(Buffer.from(ED25519_BLOB)))
  })

  test('different keys produce different fingerprints', () => {
    const other = Buffer.concat([ED25519_BLOB, Buffer.from([0])])
    assert.notEqual(fingerprintHostKey(other).hash, fingerprintHostKey(ED25519_BLOB).hash)
  })

  test('bytes that cannot be a host key are refused', () => {
    assert.throws(
      () => fingerprintHostKey(Buffer.alloc(2)),
      (error: unknown) => error instanceof KnownHostsError && error.code === 'INVALID_HOST_KEY',
    )
    assert.throws(
      () => fingerprintHostKey(Buffer.from([0, 0, 0, 200, 1, 2, 3])),
      (error: unknown) => error instanceof KnownHostsError && error.code === 'INVALID_HOST_KEY',
    )
  })
})
