// dsh-server-connector — execution audit log (design doc §3.4/§6.2).
//
// One JSON object per line, appended to `$DSH_HOME/server-connector/audit.log`.
// The module only appends and reads the tail: it never participates in a
// decision, never rewrites an earlier line, and never loads the whole file to
// answer a tail(limit) call.
//
// Record shapes (doc §3.4):
//   exec:  { ts, sessionId, serverId, serverName, command, decision,
//            policyRule, approved, exitCode, durationMs, truncated }
//   block: an exec record with decision="block", approved=null, exitCode=null
//   event: { ts, event, serverId, serverName, detail? } for non-execution
//          events such as hostkey-disabled / server-deleted / rule-disabled
//
// Rotation (doc §6.2): with `auditMaxBytes > 0`, the log is rotated once when
// the next append would exceed that size. The current file becomes
// `audit.log.1` and a fresh `audit.log` starts; a second threshold hit
// overwrites `audit.log.1`, so at most two files of bounded size exist.

import { mkdir, open, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { connectorDirectory } from './registry.js'

/** File name of the audit log. */
export const AUDIT_FILE_NAME = 'audit.log'

/** Suffix of the single rotated file. */
export const AUDIT_ROTATED_SUFFIX = '.1'

/** Byte size of the read window when tail() has to grow to satisfy `limit`. */
const INITIAL_TAIL_WINDOW = 64 * 1024

/**
 * One tail promise per log file: two AuditLog instances (tools and routes, say)
 * must not interleave a line or race the rotation check.
 * @type {Map<string, Promise<void>>}
 */
const APPEND_QUEUES = new Map()

/**
 * One audit record, exactly as persisted. Exec records, block records and
 * event records share this wrapper; `event` is present only on events.
 * @typedef {object} AuditRecord
 * @property {string} ts - ISO-8601 timestamp.
 * @property {string} [sessionId]
 * @property {string} [serverId]
 * @property {string} [serverName]
 * @property {string} [command]
 * @property {'allow'|'confirm'|'block'|'event'} [decision]
 * @property {string|null} [policyRule]
 * @property {boolean|null} [approved]
 * @property {number|null} [exitCode]
 * @property {number} [durationMs]
 * @property {boolean} [truncated]
 * @property {string} [event]
 * @property {string} [detail]
 */

/**
 * Non-execution events the spec names (doc §3.4, §4.2.4, §9.6). `rule-disabled`
 * is the event that must be written when a rule id leaves a server's
 * `disabledRules` — i.e. when the rule is switched off (doc §4.2.4).
 * @typedef {'hostkey-disabled'|'server-deleted'|'rule-disabled'} AuditEvent
 */

/**
 * What `append()` accepts. Every key except `ts` is optional; `ts` is stamped
 * by the log so callers cannot backdate an entry.
 * @typedef {object} AuditEntry
 * @property {string} [sessionId]
 * @property {string} [serverId]
 * @property {string} [serverName]
 * @property {string} [command]
 * @property {'allow'|'confirm'|'block'} [decision]
 * @property {string|null} [policyRule]
 * @property {boolean|null} [approved]
 * @property {number|null} [exitCode]
 * @property {number} [durationMs]
 * @property {boolean} [truncated]
 * @property {AuditEvent} [event]
 * @property {string} [detail]
 */

/**
 * Machine-readable audit failure. `INVALID_AUDIT` marks a malformed call (bad
 * record, bad rotation limit); nothing is written when it is thrown.
 * @typedef {'INVALID_AUDIT'} AuditErrorCode
 */
export class AuditError extends Error {
  /**
   * @param {AuditErrorCode} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'AuditError'
    /** @type {AuditErrorCode} */
    this.code = code
  }
}

/**
 * Default location of `audit.log` (doc §3.5).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function defaultAuditFile(env = process.env) {
  return join(connectorDirectory(env), AUDIT_FILE_NAME)
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {unknown} error
 * @param {string} code
 * @returns {boolean}
 */
function isErrno(error, code) {
  return isPlainObject(error) && error.code === code
}

/**
 * Sequence one record's keys in the order of doc §3.4 instead of insertion
 * order, so the file stays readable and greppable in a stable shape.
 * @param {AuditRecord} record
 * @returns {string}
 */
function serialize(record) {
  /** @type {Record<string, unknown>} */
  const ordered = { ts: record.ts }
  for (const key of [
    'event',
    'detail',
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
  ]) {
    const value = /** @type {Record<string, unknown>} */ (record)[key]
    if (value !== undefined) ordered[key] = value
  }
  return `${JSON.stringify(ordered)}\n`
}

/**
 * Build a validated record from a caller's entry. Shorthands that the spec
 * fixes are applied here so a block record cannot be written wrongly:
 * a `decision: "block"` line always carries `approved: null` and
 * `exitCode: null` (doc §3.4).
 * @param {AuditEntry} entry
 * @param {Date} now
 * @returns {AuditRecord}
 */
function buildRecord(entry, now) {
  if (!isPlainObject(entry)) throw new AuditError('INVALID_AUDIT', 'audit entry must be an object.')
  const isEvent = entry.event !== undefined
  if (isEvent) {
    if (entry.event !== 'hostkey-disabled' && entry.event !== 'server-deleted' && entry.event !== 'rule-disabled') {
      throw new AuditError(
        'INVALID_AUDIT',
        'event must be one of hostkey-disabled, server-deleted, rule-disabled.',
      )
    }
    if (entry.decision !== undefined) {
      throw new AuditError('INVALID_AUDIT', 'an event record carries no exec decision.')
    }
  } else if (entry.decision === undefined) {
    // Never default to "allow": a forgotten decision would then be recorded as
    // an allowed execution, which is exactly the mislabelling an audit log must
    // not produce.
    throw new AuditError('INVALID_AUDIT', 'decision must be allow, confirm or block (or provide event).')
  } else if (entry.decision !== 'allow' && entry.decision !== 'confirm' && entry.decision !== 'block') {
    throw new AuditError('INVALID_AUDIT', 'decision must be allow, confirm or block (or provide event).')
  }

  /** @type {AuditRecord} */
  const record = { ts: now.toISOString() }
  if (isEvent) {
    record.event = /** @type {AuditEvent} */ (entry.event)
    if (entry.detail !== undefined) {
      if (typeof entry.detail !== 'string') throw new AuditError('INVALID_AUDIT', 'detail must be a string.')
      record.detail = entry.detail
    }
  } else {
    record.decision = /** @type {'allow'|'confirm'|'block'} */ (entry.decision)
  }

  for (const field of /** @type {const} */ (['sessionId', 'serverId', 'serverName', 'command'])) {
    const value = entry[field]
    if (value === undefined) continue
    if (typeof value !== 'string') throw new AuditError('INVALID_AUDIT', `${field} must be a string.`)
    record[field] = value
  }

  if (entry.policyRule !== undefined) {
    if (entry.policyRule !== null && typeof entry.policyRule !== 'string') {
      throw new AuditError('INVALID_AUDIT', 'policyRule must be a string or null.')
    }
    record.policyRule = entry.policyRule
  }

  const isBlock = !isEvent && record.decision === 'block'
  if (isBlock) {
    // Doc §3.4: a blocked command never ran, so approval and exit code are null
    // no matter what a caller passed. Timing/output fields are dropped for the
    // same reason: there is no execution to describe.
    record.approved = null
    record.exitCode = null
  } else if (!isEvent) {
    if (entry.approved !== undefined) {
      if (entry.approved !== null && typeof entry.approved !== 'boolean') {
        throw new AuditError('INVALID_AUDIT', 'approved must be a boolean or null.')
      }
      record.approved = entry.approved
    }
    if (entry.exitCode !== undefined) {
      if (entry.exitCode !== null && !(typeof entry.exitCode === 'number' && Number.isInteger(entry.exitCode))) {
        throw new AuditError('INVALID_AUDIT', 'exitCode must be an integer or null.')
      }
      record.exitCode = entry.exitCode
    }
    if (entry.durationMs !== undefined) {
      if (typeof entry.durationMs !== 'number' || !Number.isFinite(entry.durationMs) || entry.durationMs < 0) {
        throw new AuditError('INVALID_AUDIT', 'durationMs must be a non-negative number.')
      }
      record.durationMs = entry.durationMs
    }
    if (entry.truncated !== undefined) {
      if (typeof entry.truncated !== 'boolean') {
        throw new AuditError('INVALID_AUDIT', 'truncated must be a boolean.')
      }
      record.truncated = entry.truncated
    }
  }
  return record
}

/**
 * Split a byte window into complete JSONL records, dropping a partial first
 * line (the window started mid-record) and a partial last line (the record is
 * still being appended). Malformed complete lines are skipped rather than
 * aborting the whole read: a damaged log must not make the panel unusable.
 * @param {string} text
 * @param {boolean} windowStartsAtFileStart
 * @returns {AuditRecord[]}
 */
function parseLines(text, windowStartsAtFileStart) {
  const lines = text.split('\n')
  // The window starts mid-record unless it begins at offset 0.
  if (!windowStartsAtFileStart) lines.shift()
  // The final element is either "" (the text ended with "\n") or an
  // unterminated fragment still being appended; neither is a whole record.
  lines.pop()
  /** @type {AuditRecord[]} */
  const records = []
  for (const line of lines) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line)
      if (isPlainObject(parsed)) records.push(/** @type {AuditRecord} */ (parsed))
    } catch {
      // Skip a truncated or hand-edited line; the rest of the log is still valid.
    }
  }
  return records
}

/**
 * Append-only audit log with bounded tail reads and optional single rotation.
 *
 * The log is disabled by `auditEnabled = false` (doc §10): the same methods
 * still work, but {@link AuditLog.append} writes nothing and reports
 * `enabled: false`, which is exactly what the caller must not treat as an
 * error — the command itself still runs.
 */
export class AuditLog {
  /** @type {string} */
  #file
  /** @type {boolean} */
  #enabled
  /** @type {number} */
  #maxBytes

  /**
   * @param {{file?: string, enabled?: boolean, maxBytes?: number}} [options]
   *   `file` defaults to `$DSH_HOME/server-connector/audit.log`; `enabled`
   *   mirrors `auditEnabled` and `maxBytes` mirrors `auditMaxBytes` (0 = never
   *   rotate).
   */
  constructor(options = {}) {
    this.#file = options.file ?? defaultAuditFile()
    this.#enabled = options.enabled ?? true
    const maxBytes = options.maxBytes ?? 0
    if (!(typeof maxBytes === 'number' && Number.isSafeInteger(maxBytes) && maxBytes >= 0)) {
      throw new AuditError('INVALID_AUDIT', 'maxBytes must be a non-negative integer (0 = never rotate).')
    }
    this.#maxBytes = maxBytes
  }

  /** Absolute path of the log this instance appends to. */
  get file() {
    return this.#file
  }

  /** Whether appends are recorded (`auditEnabled`). */
  get enabled() {
    return this.#enabled
  }

  /** Rotation threshold in bytes; 0 means the log is never rotated. */
  get maxBytes() {
    return this.#maxBytes
  }

  /**
   * Append one record. The call resolves only after the line reached the file.
   *
   * A block record is normalised to `approved: null, exitCode: null`; an event
   * record carries `event` instead of an exec decision. Records are serialised
   * per log file so two concurrent appends cannot interleave inside one line.
   * @param {AuditEntry} entry
   * @returns {Promise<{written: boolean, enabled: boolean, rotated: boolean}>}
   * @throws {AuditError} for a malformed record, before anything is written.
   */
  async append(entry) {
    const now = new Date()
    const record = buildRecord(entry, now)
    const line = serialize(record)
    if (!this.#enabled) return { written: false, enabled: false, rotated: false }
    return this.#queued(async () => {
      const rotated = await this.#rotateIfNeeded(Buffer.byteLength(line, 'utf8'))
      await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 })
      await writeFile(this.#file, line, { encoding: 'utf8', flag: 'a', mode: 0o600 })
      return { written: true, enabled: true, rotated }
    })
  }

  /**
   * Read the last `limit` records, oldest first, without loading the file.
   *
   * The read starts from a growing window at the end of the file, so a 1 GB
   * log costs one bounded read for a 20-record tail. A missing file is an
   * empty log. Records are returned exactly as stored, newest last.
   * @param {number} [limit] - how many records to return; defaults to 20.
   * @returns {Promise<AuditRecord[]>}
   * @throws {AuditError} when `limit` is not a positive integer.
   */
  async tail(limit = 20) {
    if (!(typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0)) {
      throw new AuditError('INVALID_AUDIT', 'limit must be a positive integer.')
    }
    /** @type {import('node:fs/promises').FileHandle} */
    let handle
    try {
      handle = await open(this.#file, 'r')
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return []
      throw error
    }
    try {
      const { size } = await handle.stat()
      if (size === 0) return []
      let window = Math.min(size, Math.max(INITIAL_TAIL_WINDOW, limit * 256))
      /** @type {AuditRecord[]} */
      let records = []
      for (;;) {
        const start = Math.max(0, size - window)
        const buffer = Buffer.alloc(size - start)
        // FileHandle.read may return short; keep reading until the window is full.
        let filled = 0
        while (filled < buffer.length) {
          const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, start + filled)
          if (bytesRead === 0) break
          filled += bytesRead
        }
        records = parseLines(buffer.subarray(0, filled).toString('utf8'), start === 0)
        if (records.length >= limit || start === 0) break
        window *= 4
      }
      return records.slice(-limit)
    } finally {
      await handle.close()
    }
  }

  /**
   * Rotate the log when the next append would pass `maxBytes` (doc §6.2).
   * Only one rotation is ever kept: the current file replaces `audit.log.1`.
   * @param {number} incomingBytes
   * @returns {Promise<boolean>} whether a rotation happened.
   */
  async #rotateIfNeeded(incomingBytes) {
    if (this.#maxBytes <= 0) return false
    let size
    try {
      size = (await stat(this.#file)).size
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return false
      throw error
    }
    if (size === 0 || size + incomingBytes <= this.#maxBytes) return false
    const rotated = `${this.#file}${AUDIT_ROTATED_SUFFIX}`
    try {
      await rename(this.#file, rotated)
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error
    }
    return true
  }

  /**
   * Run an append after every earlier append to the same file finished.
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  async #queued(operation) {
    const key = resolve(this.#file)
    const previous = APPEND_QUEUES.get(key) ?? Promise.resolve()
    const running = previous.then(operation)
    const settled = running.then(
      () => undefined,
      () => undefined,
    )
    APPEND_QUEUES.set(key, settled)
    void settled.then(() => {
      if (APPEND_QUEUES.get(key) === settled) APPEND_QUEUES.delete(key)
    })
    return running
  }
}
