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

import { Config, buildAuditLog, buildRegistry } from '../lib/index.js'

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-config-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('Config schema (§10)', () => {
  test('every §10 key exists with its documented default', () => {
    const config = new Config({})
    assert.equal(config.connectTimeoutMs, 15000)
    assert.equal(config.commandTimeoutMs, 60000)
    assert.equal(config.syncTimeoutMs, 20000)
    assert.equal(config.maxOutputChars, 200000)
    assert.equal(config.idleTimeoutMs, 600000)
    assert.equal(config.auditEnabled, true)
    assert.equal(config.auditMaxBytes, 0)
    assert.equal(config.pendingTtlHours, 24)
    assert.equal(config.maxListedServers, 8)
  })

  test('auditEnabled / auditMaxBytes / pendingTtlHours accept explicit values', () => {
    const config = new Config({ auditEnabled: false, auditMaxBytes: 4096, pendingTtlHours: 72 })
    assert.equal(config.auditEnabled, false)
    assert.equal(config.auditMaxBytes, 4096)
    assert.equal(config.pendingTtlHours, 72)
  })

  test('auditMaxBytes 0 is valid (rotation disabled) and negative values are rejected', () => {
    assert.equal(new Config({ auditMaxBytes: 0 }).auditMaxBytes, 0)
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
})
