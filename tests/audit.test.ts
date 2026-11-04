// Tests for the audit log (design doc §3.4, §6.2, §10).
//
// Run with: node --test tests/audit.test.ts   (Node strips the types natively)
// or:       npm test
//
// Each test writes into its own temp directory. Coverage follows the phase-2
// issue: append then tail back, tail only the last N, the block-record shape,
// auditEnabled=false writing nothing, and rotation at auditMaxBytes.

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { AUDIT_FILE_NAME, AUDIT_ROTATED_SUFFIX, AuditError, AuditLog, defaultAuditFile } from '../lib/audit.js'
import { CONNECTOR_DIR_NAME } from '../lib/registry.js'

let directory: string
let file: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-audit-'))
  file = join(directory, 'server-connector', 'audit.log')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** A complete exec record as srv_exec writes it on an allow run (§3.4). */
const EXEC_ENTRY = {
  sessionId: 'session-1',
  serverId: 'srv-01',
  serverName: '生产机-A',
  command: 'systemctl restart app',
  decision: 'confirm' as const,
  policyRule: 'service-restart',
  approved: true,
  exitCode: 0,
  durationMs: 1200,
  truncated: false,
}

/** Read the raw log, one string per record. */
async function rawLines(): Promise<string[]> {
  const text = await readFile(file, 'utf8')
  return text.trimEnd().split('\n')
}

describe('paths (§3.5)', () => {
  test('default file lives under $DSH_HOME/server-connector', () => {
    assert.equal(defaultAuditFile({ DSH_HOME: '/var/lib/dsh' }), '/var/lib/dsh/server-connector/audit.log')
    assert.equal(AUDIT_FILE_NAME, 'audit.log')
    assert.equal(CONNECTOR_DIR_NAME, 'server-connector')
  })
})

describe('append() and tail()', () => {
  test('a missing log tails as empty and is not created by a read', async () => {
    const log = new AuditLog({ file })
    assert.deepEqual(await log.tail(), [])
    await assert.rejects(readFile(file, 'utf8'))
  })

  test('append then tail returns the same record', async () => {
    const log = new AuditLog({ file })
    assert.deepEqual(await log.append(EXEC_ENTRY), { written: true, enabled: true, rotated: false })
    const [record] = await log.tail(10)
    assert.ok(record)
    assert.match(record.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    assert.deepEqual({ ...record, ts: 'ignored' }, { ...EXEC_ENTRY, ts: 'ignored' })
  })

  test('the file is JSONL: one JSON object per line, keys in §3.4 order', async () => {
    const log = new AuditLog({ file })
    await log.append(EXEC_ENTRY)
    await log.append({ ...EXEC_ENTRY, command: 'ls -la', decision: 'allow' })
    const lines = await rawLines()
    assert.equal(lines.length, 2)
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line))
    assert.deepEqual(Object.keys(JSON.parse(lines[0] as string)), [
      'ts',
      'sessionId',
      'serverId',
      'serverName',
      'command',
      'decision',
      'policyRule',
      'approved',
      'exitCode',
      'durationMs',
      'truncated',
    ])
  })

  test('tail(limit) returns only the last N, oldest first', async () => {
    const log = new AuditLog({ file })
    for (let index = 0; index < 25; index += 1) await log.append({ ...EXEC_ENTRY, command: `echo ${index}` })
    const tail = await log.tail(5)
    assert.deepEqual(
      tail.map((record) => record.command),
      ['echo 20', 'echo 21', 'echo 22', 'echo 23', 'echo 24'],
    )
    assert.equal((await log.tail(100)).length, 25)
  })

  test('tail() reads a big log without loading all of it', async () => {
    const log = new AuditLog({ file })
    const filler = { ...EXEC_ENTRY, command: 'x'.repeat(4000) }
    for (let index = 0; index < 200; index += 1) await log.append({ ...filler, command: `${index}:${filler.command}` })
    const tail = await log.tail(2)
    assert.equal(tail.length, 2)
    assert.match(tail[1]?.command ?? '', /^199:/)
  })

  test('tail() skips a torn last line instead of failing', async () => {
    const log = new AuditLog({ file })
    await log.append(EXEC_ENTRY)
    await writeFile(file, `${await readFile(file, 'utf8')}{"ts":"partial`, 'utf8')
    const records = await log.tail(10)
    assert.equal(records.length, 1)
    assert.equal(records[0]?.command, EXEC_ENTRY.command)
  })

  test('a malformed limit is INVALID_AUDIT', async () => {
    const log = new AuditLog({ file })
    for (const limit of [0, -1, 1.5, '5' as never]) {
      await assert.rejects(log.tail(limit), (error: unknown) => {
        assert.ok(error instanceof AuditError)
        assert.equal(error.code, 'INVALID_AUDIT')
        return true
      })
    }
  })

  test('concurrent appends all land on their own line', async () => {
    const log = new AuditLog({ file })
    await Promise.all(Array.from({ length: 20 }, (_, index) => log.append({ ...EXEC_ENTRY, command: `c${index}` })))
    const records = await log.tail(50)
    assert.equal(records.length, 20)
    assert.deepEqual(new Set(records.map((record) => record.command)).size, 20)
  })
})

describe('record shapes (§3.4)', () => {
  test('a block record always carries approved=null and exitCode=null', async () => {
    const log = new AuditLog({ file })
    await log.append({
      serverId: 'srv-01',
      serverName: '生产机-A',
      command: 'rm -rf /',
      decision: 'block',
      policyRule: 'rm-recursive',
      // Even when a caller passes values, a blocked command never ran.
      approved: true,
      exitCode: 0,
      durationMs: 3,
    })
    const [record] = await log.tail(1)
    assert.ok(record)
    assert.equal(record.decision, 'block')
    assert.equal(record.approved, null)
    assert.equal(record.exitCode, null)
    assert.equal(record.policyRule, 'rm-recursive')
    // Nothing ran, so the execution-only fields are absent rather than zeroed.
    assert.equal('durationMs' in record, false)
    assert.equal('truncated' in record, false)
  })

  test('an exec record without a decision is rejected, never defaulted to allow', async () => {
    const log = new AuditLog({ file })
    const { decision: _omitted, ...withoutDecision } = EXEC_ENTRY
    await assert.rejects(log.append(withoutDecision as never), (error: unknown) => {
      assert.ok(error instanceof AuditError)
      assert.match(error.message, /decision/)
      return true
    })
    await assert.rejects(readFile(file, 'utf8'))
  })

  test('an event record uses the event field and no exec decision', async () => {
    const log = new AuditLog({ file })
    for (const event of ['hostkey-disabled', 'server-deleted', 'rule-disabled'] as const) {
      await log.append({ event, serverId: 'srv-01', serverName: '生产机-A', detail: event })
    }
    const records = await log.tail(10)
    assert.deepEqual(
      records.map((record) => record.event),
      ['hostkey-disabled', 'server-deleted', 'rule-disabled'],
    )
    for (const record of records) {
      assert.equal(record.decision, undefined)
      assert.equal(record.approved, undefined)
      assert.equal(record.exitCode, undefined)
    }
  })

  test('an unknown or contradictory event is rejected before writing', async () => {
    const log = new AuditLog({ file })
    await assert.rejects(log.append({ event: 'nuked' as never }), AuditError)
    await assert.rejects(log.append({ ...EXEC_ENTRY, event: 'server-deleted', decision: 'allow' as never }), AuditError)
    await assert.rejects(readFile(file, 'utf8'))
  })

  test('bad field types are rejected before anything is written', async () => {
    const log = new AuditLog({ file })
    const cases = [
      { ...EXEC_ENTRY, decision: 'maybe' as never },
      { ...EXEC_ENTRY, approved: 'yes' as never },
      { ...EXEC_ENTRY, exitCode: 1.5 },
      { ...EXEC_ENTRY, durationMs: -1 },
      { ...EXEC_ENTRY, truncated: 'no' as never },
      { ...EXEC_ENTRY, command: 42 as never },
    ]
    for (const entry of cases) await assert.rejects(log.append(entry), AuditError)
    await assert.rejects(readFile(file, 'utf8'))
  })

  test('timestamps are stamped by the log and are non-decreasing', async () => {
    const log = new AuditLog({ file })
    await log.append(EXEC_ENTRY)
    await log.append(EXEC_ENTRY)
    const records = await log.tail(2)
    const first = Date.parse(records[0]?.ts as string)
    const second = Date.parse(records[1]?.ts as string)
    assert.ok(Number.isFinite(first) && Number.isFinite(second))
    assert.ok(second >= first)
  })
})

describe('auditEnabled=false (§10)', () => {
  test('append() writes nothing and reports enabled=false', async () => {
    const log = new AuditLog({ file, enabled: false })
    assert.deepEqual(await log.append(EXEC_ENTRY), { written: false, enabled: false, rotated: false })
    assert.deepEqual(await log.append({ event: 'server-deleted' }), { written: false, enabled: false, rotated: false })
    assert.equal(log.enabled, false)
    await assert.rejects(readFile(file, 'utf8'))
    assert.deepEqual(await log.tail(5), [])
  })

  test('a disabled log still rejects a malformed record', async () => {
    const log = new AuditLog({ file, enabled: false })
    await assert.rejects(log.append({ ...EXEC_ENTRY, decision: 'nope' as never }), AuditError)
  })
})

describe('rotation at auditMaxBytes (§6.2)', () => {
  test('0 disables rotation', async () => {
    const log = new AuditLog({ file, maxBytes: 0 })
    for (let index = 0; index < 50; index += 1) await log.append(EXEC_ENTRY)
    assert.equal((await log.tail(100)).length, 50)
    const entries = await readdir(join(directory, 'server-connector'))
    assert.deepEqual(entries, ['audit.log'])
  })

  test('the log rotates once the next append would pass the threshold', async () => {
    const log = new AuditLog({ file, maxBytes: 1200 })
    let rotated = false
    let appends = 0
    while (!rotated && appends < 100) {
      const result = await log.append(EXEC_ENTRY)
      rotated = result.rotated
      appends += 1
    }
    assert.equal(rotated, true)
    assert.equal(appends > 1, true)
    const current = await readFile(file, 'utf8')
    const previous = await readFile(`${file}${AUDIT_ROTATED_SUFFIX}`, 'utf8')
    // The current file restarted with the record that triggered the rotation.
    assert.equal(current.trimEnd().split('\n').length, 1)
    assert.ok(Buffer.byteLength(previous, 'utf8') > 0)
    assert.ok(Buffer.byteLength(previous, 'utf8') <= 1200)
    assert.equal((await log.tail(1)).length, 1)
  })

  test('a second rotation replaces the previous rotated file (only one is kept)', async () => {
    const log = new AuditLog({ file, maxBytes: 900 })
    for (let index = 0; index < 30; index += 1) await log.append(EXEC_ENTRY)
    const previous = await readFile(`${file}${AUDIT_ROTATED_SUFFIX}`, 'utf8')
    assert.ok(Buffer.byteLength(previous, 'utf8') <= 900)
    const leftovers = (await readFile(file, 'utf8')).trimEnd().split('\n')
    assert.ok(leftovers.length >= 1)
  })

  test('an oversized single record is still written rather than dropped', async () => {
    const log = new AuditLog({ file, maxBytes: 50 })
    const result = await log.append({ ...EXEC_ENTRY, command: 'x'.repeat(500) })
    assert.equal(result.written, true)
    assert.equal((await log.tail(1)).length, 1)
  })

  test('a malformed maxBytes is INVALID_AUDIT', () => {
    for (const maxBytes of [-1, 1.5, '10' as never]) {
      assert.throws(() => new AuditLog({ file, maxBytes }), AuditError)
    }
  })
})
