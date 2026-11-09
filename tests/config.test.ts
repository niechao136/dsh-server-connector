// Tests that the phase-2 units are actually wired to the global config the
// plugin declares (design doc §10), rather than to their own hard-coded
// defaults.
//
// Run with: node --test tests/config.test.ts   (Node strips the types natively)
// or:       npm test

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { Config, CONFIG_DEFAULTS, CONFIG_KEYS, buildAuditLog, buildKnownHosts, buildPool, buildRegistry, readConfig, unbox } from '../lib/index.js'

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-config-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('Config schema (§10)', () => {
  test('every §10 key exists with its documented default', () => {
    // Every field is `.volatile()`, so it resolves to a cosmokit cell rather than
    // to its value: `readConfig` is the only correct reader (and the only one the
    // rest of the plugin uses).
    const config = readConfig(new Config({}))
    assert.equal(config.connectTimeoutMs, 15000)
    assert.equal(config.commandTimeoutMs, 60000)
    assert.equal(config.syncTimeoutMs, 20000)
    assert.equal(config.maxOutputChars, 200000)
    assert.equal(config.idleTimeoutMs, 600000)
    assert.equal(config.auditEnabled, true)
    assert.equal(config.auditMaxBytes, 0)
    assert.equal(config.pendingTtlHours, 24)
    assert.equal(config.maxListedServers, 8)
    assert.deepEqual(Object.keys(config).sort(), [...CONFIG_KEYS].sort())
  })

  test('every key is .volatile(), which is what makes the settings form appear', () => {
    // DSH projects a plugin row into a settings form only through
    // `volatileForm()`, which keeps a field only when it is marked volatile. A
    // single non-volatile key would silently shrink the form; a schema with none
    // would project to `undefined` and hide the whole section, which is exactly
    // the bug this pins against.
    const schema = new Config({})
    for (const key of CONFIG_KEYS) {
      const value = /** @type {any} */ (schema)[key]
      assert.equal(typeof value.get, 'function', `${key} is not volatile`)
      assert.equal(typeof unbox(value), typeof CONFIG_DEFAULTS[key], `${key} has the wrong type`)
    }
    assert.deepEqual(readConfig(new Config({})), CONFIG_DEFAULTS)
  })

  test('a volatile cell is read live, so an in-place write reaches the next reader', () => {
    // This is the mechanism the settings page relies on: the loader writes the
    // new value into the same cell object instead of remounting the plugin.
    const schema = new Config({})
    const cell = /** @type {any} */ (schema).commandTimeoutMs
    const write = Reflect.get(cell, Symbol.for('cosmokit.volatile.write'))
    assert.equal(typeof write, 'function')
    write(1234)
    assert.equal(cell.get(), 1234)
    assert.equal(readConfig(schema).commandTimeoutMs, 1234)
  })

  test('readConfig tolerates plain values and missing keys', () => {
    // A test fixture or an older host may hand over a plain object; a value that
    // was never configured falls back to the documented default.
    assert.equal(readConfig({ commandTimeoutMs: 42 }).commandTimeoutMs, 42)
    assert.equal(readConfig({ commandTimeoutMs: 42 }).syncTimeoutMs, CONFIG_DEFAULTS.syncTimeoutMs)
    assert.deepEqual(readConfig(undefined), CONFIG_DEFAULTS)
    assert.equal(unbox(7), 7)
    assert.equal(unbox(undefined), undefined)
  })

  test('auditEnabled / auditMaxBytes / pendingTtlHours accept explicit values', () => {
    const config = readConfig(new Config({ auditEnabled: false, auditMaxBytes: 4096, pendingTtlHours: 72 }))
    assert.equal(config.auditEnabled, false)
    assert.equal(config.auditMaxBytes, 4096)
    assert.equal(config.pendingTtlHours, 72)
  })

  test('auditMaxBytes 0 is valid (rotation disabled) and negative values are rejected', () => {
    assert.equal(readConfig(new Config({ auditMaxBytes: 0 })).auditMaxBytes, 0)
    assert.throws(() => new Config({ auditMaxBytes: -1 }))
  })

  test('pendingTtlHours is a positive integer', () => {
    assert.throws(() => new Config({ pendingTtlHours: 0 }))
    assert.throws(() => new Config({ pendingTtlHours: 1.5 }))
  })
})

describe('config → unit wiring', () => {
  test('buildAuditLog() forwards auditEnabled and auditMaxBytes', () => {
    const log = buildAuditLog(new Config({ auditEnabled: false, auditMaxBytes: 2048 }), {
      file: join(directory, 'audit.log'),
    })
    assert.equal(log.enabled, false)
    assert.equal(log.maxBytes, 2048)
  })

  test('buildRegistry() uses $DSH_HOME/server-connector/servers.json', () => {
    const registry = buildRegistry(undefined, { env: { DSH_HOME: directory } })
    assert.equal(registry.file, join(directory, 'server-connector', 'servers.json'))
  })

  test('buildRegistry() honours an explicit file override', () => {
    const file = join(directory, 'custom.json')
    assert.equal(buildRegistry(undefined, { file }).file, file)
  })

  test('buildKnownHosts() uses $DSH_HOME/server-connector/known_hosts.json', () => {
    const store = buildKnownHosts(undefined, { env: { DSH_HOME: directory } })
    assert.equal(store.file, join(directory, 'server-connector', 'known_hosts.json'))
  })

  test('buildKnownHosts() honours an explicit file override', () => {
    const file = join(directory, 'custom-known-hosts.json')
    assert.equal(buildKnownHosts(undefined, { file }).file, file)
  })

  test('buildPool() forwards the §10 timeouts and the output ceiling', () => {
    const pool = buildPool(
      new Config({ idleTimeoutMs: 1234, commandTimeoutMs: 5678, connectTimeoutMs: 4321, maxOutputChars: 9000 }),
      { knownHosts: buildKnownHosts(undefined, { file: join(directory, 'known_hosts.json') }) },
    )
    assert.equal(pool.idleTimeoutMs, 1234)
  })

  test('buildPool() falls back to the documented defaults for an empty config', () => {
    const pool = buildPool(new Config({}), {
      knownHosts: buildKnownHosts(undefined, { file: join(directory, 'known_hosts.json') }),
    })
    assert.equal(pool.idleTimeoutMs, 600000)
  })
})
