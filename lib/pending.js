// dsh-server-connector — two-step confirmation queue for dangerous operations
// (design doc §3.3, §8.3).
//
// A dangerous panel action (delete a server, switch host-key verification off,
// disable a high-risk rule) is *requested* first and applied later, after the
// user comes back to the settings page and sees the full context. This module
// owns that queue and nothing else:
//
//   $DSH_HOME/server-connector/pending.json
//   { "version": 1, "pending": [{
//       "id": "pend-01",
//       "kind": "delete-server" | "disable-hostkey" | "disable-rule",
//       "serverId": "srv-01",
//       "ruleId": "rm-recursive",            // disable-rule only
//       "requestedAt": "2026-11-04T09:20:11Z",
//       "expiresAt": "2026-11-05T09:20:11Z", // requestedAt + pendingTtlHours
//       "snapshot": { /* delete-server: the complete record */ }
//   }] }
//
// State machine (§8.3):
//
//   无记录 ──request()──► pending ──confirm()──► applied   (执行 + 审计留痕)
//                              └──cancel() / 24h 过期──► discarded
//
// `request()` performs no side effect at all: the server keeps working, the
// rule keeps blocking, host-key verification keeps its mode. Only `confirm()`
// runs the operation, and it does so through an injected applier
// ({@link createPendingApplier} is the production one) so this module stays a
// durable queue rather than a second place that mutates `servers.json`
// (doc §2.2: "pending：危险操作的两段式队列，不执行任何副作用").
//
// Guarantees, in the same spirit as the registry (§3.1):
// - a missing or empty file is an empty queue; a read never creates the file;
// - a malformed document is reported (`INVALID_PENDING`), never rewritten;
// - every mutation is an atomic replace and is serialised per file across the
//   instances of this process;
// - an expired record is discarded on load, on every read and on every write
//   (doc §8.3: "进程启动时与每次读写时各检查一次"), and an expired record can
//   never be confirmed — the user has to request it again.

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { connectorDirectory } from './registry.js'

/** File name of the queue (doc §3.5). */
export const PENDING_FILE_NAME = 'pending.json'

/** Document version of `pending.json`. */
export const PENDING_VERSION = 1

/** The three dangerous operations the queue knows (doc §8.3). */
export const PENDING_KINDS = Object.freeze(['delete-server', 'disable-hostkey', 'disable-rule'])

/** Default lifetime of a pending record (doc §10 `pendingTtlHours`). */
export const DEFAULT_PENDING_TTL_HOURS = 24

const HOUR_MS = 60 * 60 * 1000

/**
 * One write promise per queue file, so every PendingQueue instance in this
 * process serialises its mutations against the same document (the registry and
 * the known-hosts store use the same pattern).
 * @type {Map<string, Promise<void>>}
 */
const MUTATION_QUEUES = new Map()

/**
 * Machine-readable queue failure. `INVALID_PENDING` marks a malformed call or
 * document, `UNKNOWN_PENDING` a record that is not in the queue,
 * `EXPIRED_PENDING` a record whose 24 h window closed, `PENDING_UNAVAILABLE` a
 * queue built without an applier, and `APPLY_FAILED` an applier that threw (the
 * record is kept, so the user can retry).
 * @typedef {'INVALID_PENDING'|'UNKNOWN_PENDING'|'EXPIRED_PENDING'|'PENDING_UNAVAILABLE'|'APPLY_FAILED'} PendingErrorCode
 */
export class PendingError extends Error {
  /**
   * @param {PendingErrorCode} code
   * @param {string} message
   * @param {{cause?: unknown, record?: PendingRecord}} [details]
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'PendingError'
    /** @type {PendingErrorCode} */
    this.code = code
    if (details.cause !== undefined) this.cause = details.cause
    if (details.record !== undefined) this.record = details.record
  }
}

/**
 * The three dangerous operations (doc §8.3).
 * @typedef {'delete-server'|'disable-hostkey'|'disable-rule'} PendingKind
 */

/**
 * One queued request, exactly as persisted (doc §3.3).
 * @typedef {object} PendingRecord
 * @property {string} id - `pend-01`, `pend-02`, …; assigned by the queue.
 * @property {PendingKind} kind
 * @property {string} serverId
 * @property {string} [ruleId] - present only for `disable-rule`.
 * @property {string} requestedAt - ISO-8601.
 * @property {string} expiresAt - requestedAt + pendingTtlHours, ISO-8601.
 * @property {Record<string, unknown>} [snapshot] - `delete-server` keeps the
 *   complete server record here so a cancelled request leaves no trace, and a
 *   confirmed one can still delete the credentials of an already-gone record.
 */

/**
 * The persisted document.
 * @typedef {object} PendingDocument
 * @property {number} version
 * @property {PendingRecord[]} pending
 */

/**
 * What `request()` accepts.
 * @typedef {object} PendingRequestInput
 * @property {PendingKind} kind
 * @property {string} serverId
 * @property {string} [ruleId] - required for `disable-rule`.
 * @property {Record<string, unknown>} [snapshot] - optional, `delete-server` uses it.
 */

/**
 * What `confirm()` returns. `status` is the §8.3 state the record reached.
 * @typedef {{record: PendingRecord, status: 'applied', result: unknown}} PendingApplied
 * @typedef {{record: PendingRecord, status: 'discarded'}} PendingDiscarded
 */

/**
 * Default location of `pending.json` (doc §3.5).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function defaultPendingFile(env = process.env) {
  return join(connectorDirectory(env), PENDING_FILE_NAME)
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
 * @param {unknown} value
 * @returns {value is PendingKind}
 */
function isPendingKind(value) {
  return value === 'delete-server' || value === 'disable-hostkey' || value === 'disable-rule'
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {PendingError['code']} code
 * @returns {string}
 */
function requiredString(value, label, code = 'INVALID_PENDING') {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PendingError(code, `${label} must be a non-empty string.`)
  }
  return value.trim()
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function requiredTimestamp(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PendingError('INVALID_PENDING', `${label} must be an ISO-8601 timestamp.`)
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new PendingError('INVALID_PENDING', `${label} must be an ISO-8601 timestamp.`)
  }
  return parsed.toISOString()
}

/**
 * Validate one stored record. Load, request and the document check all go
 * through this function, so a stored record and a freshly requested one have
 * exactly the same shape.
 * @param {unknown} raw
 * @param {string} label
 * @returns {PendingRecord}
 */
function normalizeRecord(raw, label) {
  if (!isPlainObject(raw)) throw new PendingError('INVALID_PENDING', `${label} must be an object.`)
  const id = requiredString(raw.id, `${label}.id`)
  if (!/^pend-\d{2,}$/.test(id)) {
    throw new PendingError('INVALID_PENDING', `${label}.id must look like "pend-01".`)
  }
  if (!isPendingKind(raw.kind)) {
    throw new PendingError('INVALID_PENDING', `${label}.kind must be one of ${PENDING_KINDS.join(', ')}.`)
  }
  const kind = raw.kind
  const serverId = requiredString(raw.serverId, `${label}.serverId`)
  const requestedAt = requiredTimestamp(raw.requestedAt, `${label}.requestedAt`)
  const expiresAt = requiredTimestamp(raw.expiresAt, `${label}.expiresAt`)
  if (new Date(expiresAt).getTime() < new Date(requestedAt).getTime()) {
    throw new PendingError('INVALID_PENDING', `${label}.expiresAt must not precede requestedAt.`)
  }

  /** @type {PendingRecord} */
  const record = { id, kind, serverId, requestedAt, expiresAt }
  if (kind === 'disable-rule') {
    record.ruleId = requiredString(raw.ruleId, `${label}.ruleId`)
  } else if (raw.ruleId !== undefined) {
    throw new PendingError('INVALID_PENDING', `${label}.ruleId is only valid for kind "disable-rule".`)
  }
  if (raw.snapshot !== undefined) {
    if (!isPlainObject(raw.snapshot)) {
      throw new PendingError('INVALID_PENDING', `${label}.snapshot must be an object.`)
    }
    record.snapshot = raw.snapshot
  }
  return record
}

/**
 * Allocate the next `pend-NN` id: a numeric suffix one past the highest in the
 * document, so a cancelled record's id is never reused by accident.
 * @param {PendingRecord[]} records
 * @returns {string}
 */
function nextPendingId(records) {
  let highest = 0
  for (const record of records) {
    const match = /^pend-(\d+)$/.exec(record.id)
    if (match !== null) highest = Math.max(highest, Number(match[1]))
  }
  return `pend-${String(highest + 1).padStart(2, '0')}`
}

/**
 * Drop the records whose window closed (doc §8.3). The caller persists the
 * document when it mutated it.
 * @param {PendingDocument} document
 * @param {number} nowMs
 * @returns {PendingRecord[]} the discarded records, oldest first.
 */
function dropExpired(document, nowMs) {
  const removed = []
  const kept = []
  for (const record of document.pending) {
    if (new Date(record.expiresAt).getTime() <= nowMs) removed.push(record)
    else kept.push(record)
  }
  document.pending = kept
  return removed
}

/**
 * Deep copy a record so callers cannot mutate this instance's state.
 * @template T
 * @param {T} value
 * @returns {T}
 */
function clone(value) {
  return structuredClone(value)
}

/**
 * The durable two-step queue (doc §3.3, §8.3).
 */
export class PendingQueue {
  /** @type {string} */
  #file
  /** @type {number} */
  #ttlHours
  /** @type {() => Date} */
  #now
  /** @type {((record: PendingRecord) => Promise<unknown>) | null} */
  #apply
  /** @type {{info?: Function, warn?: Function, error?: Function}|null} */
  #logger

  /**
   * @param {{
   *   file?: string,
   *   ttlHours?: number,
   *   now?: () => Date,
   *   apply?: (record: PendingRecord) => Promise<unknown>,
   *   logger?: {info?: Function, warn?: Function, error?: Function} | null,
   * }} [options]
   *   `file` defaults to `$DSH_HOME/server-connector/pending.json`; `now` is
   *   injectable so expiry is testable; `apply` is the side-effecting half and
   *   is required only by `confirm()`.
   */
  constructor(options = {}) {
    this.#file = options.file ?? defaultPendingFile()
    const ttlHours = options.ttlHours ?? DEFAULT_PENDING_TTL_HOURS
    if (!(typeof ttlHours === 'number' && Number.isFinite(ttlHours) && ttlHours > 0)) {
      throw new PendingError('INVALID_PENDING', 'ttlHours must be a positive number.')
    }
    this.#ttlHours = ttlHours
    this.#now = options.now ?? (() => new Date())
    this.#apply = options.apply ?? null
    this.#logger = options.logger ?? null
  }

  /** Absolute path of the queue file this instance reads and writes. */
  get file() {
    return this.#file
  }

  /** Lifetime of a record, in hours (`pendingTtlHours`). */
  get ttlHours() {
    return this.#ttlHours
  }

  /** Whether this queue can apply a confirmed record. */
  get applicable() {
    return this.#apply !== null
  }

  /**
   * Install the side-effecting half (the tools/HTTP layer builds it with
   * {@link createPendingApplier}). A queue without one can list, request,
   * cancel and expire — everything a read-only panel needs — but not confirm.
   * @param {(record: PendingRecord) => Promise<unknown>} apply
   * @returns {void}
   */
  setApplier(apply) {
    if (typeof apply !== 'function') throw new PendingError('INVALID_PENDING', 'apply must be a function.')
    this.#apply = apply
  }

  /**
   * Every live record, oldest request first. Expired records are discarded
   * (and the file rewritten when that removed anything).
   * @returns {Promise<PendingRecord[]>}
   */
  async list() {
    const { document, removed } = await this.#load()
    if (removed.length > 0) await this.#save(document)
    return document.pending.map((record) => clone(record))
  }

  /**
   * One record by id, or null. An expired record is discarded and reported as
   * null, never returned.
   * @param {string} id
   * @returns {Promise<PendingRecord|null>}
   */
  async get(id) {
    const { document, removed } = await this.#load()
    if (removed.length > 0) await this.#save(document)
    const record = document.pending.find((entry) => entry.id === id)
    return record === undefined ? null : clone(record)
  }

  /**
   * Queue one dangerous operation. **No side effect happens here** (doc §8.3):
   * the server keeps working, the rule keeps blocking, the host-key mode keeps
   * its value. Requesting the same operation again while it is pending returns
   * the existing record (`created: false`) instead of stacking duplicates.
   * @param {PendingRequestInput} input
   * @returns {Promise<{record: PendingRecord, created: boolean}>}
   * @throws {PendingError} `INVALID_PENDING`.
   */
  async request(input) {
    if (!isPlainObject(input)) throw new PendingError('INVALID_PENDING', 'request input must be an object.')
    if (!isPendingKind(input.kind)) {
      throw new PendingError('INVALID_PENDING', `kind must be one of ${PENDING_KINDS.join(', ')}.`)
    }
    const serverId = requiredString(input.serverId, 'serverId')
    /** @type {string|undefined} */
    let ruleId
    if (input.kind === 'disable-rule') ruleId = requiredString(input.ruleId, 'ruleId')
    else if (input.ruleId !== undefined) {
      throw new PendingError('INVALID_PENDING', 'ruleId is only valid for kind "disable-rule".')
    }
    if (input.snapshot !== undefined && !isPlainObject(input.snapshot)) {
      throw new PendingError('INVALID_PENDING', 'snapshot must be an object.')
    }

    const now = this.#now()
    const requestedAt = now.toISOString()
    const expiresAt = new Date(now.getTime() + this.#ttlHours * HOUR_MS).toISOString()
    return this.#mutate((document) => {
      const existing = document.pending.find(
        (record) => record.kind === input.kind && record.serverId === serverId && record.ruleId === ruleId,
      )
      if (existing !== undefined) return { record: clone(existing), created: false }
      /** @type {PendingRecord} */
      const record = {
        id: nextPendingId(document.pending),
        kind: input.kind,
        serverId,
        requestedAt,
        expiresAt,
      }
      if (ruleId !== undefined) record.ruleId = ruleId
      if (input.snapshot !== undefined) record.snapshot = clone(input.snapshot)
      document.pending.push(record)
      return { record: clone(record), created: true }
    })
  }

  /**
   * Apply one queued operation: run the injected applier (which performs the
   * real deletion / mode change / rule disable and writes the audit event),
   * then remove the record. A throwing applier keeps the record so the user can
   * retry.
   * @param {string} id
   * @returns {Promise<PendingApplied>}
   * @throws {PendingError} `UNKNOWN_PENDING`, `EXPIRED_PENDING`,
   *   `PENDING_UNAVAILABLE` or `APPLY_FAILED`.
   */
  async confirm(id) {
    const apply = this.#apply
    if (apply === null) {
      throw new PendingError(
        'PENDING_UNAVAILABLE',
        'This pending queue has no applier; confirmations cannot be executed in this composition.',
      )
    }
    // The applier runs *outside* the mutation queue: it talks to the registry,
    // the pool and the credentials service, and holding the queue lock across
    // those awaits would block every other queue operation. The record is
    // re-checked and removed in a second, short mutation.
    const record = await this.#requireLive(id)
    let result
    try {
      result = await apply(clone(record))
    } catch (error) {
      throw new PendingError(
        'APPLY_FAILED',
        `Applying ${record.kind} for ${record.serverId} failed: ${error instanceof Error ? error.message : String(error)}. The request stays pending; fix the cause and confirm again.`,
        { cause: error, record: clone(record) },
      )
    }
    await this.#mutate((document) => {
      const index = document.pending.findIndex((entry) => entry.id === id)
      // Another confirm/cancel may have won the race while the applier ran.
      if (index !== -1) document.pending.splice(index, 1)
    })
    return { record, status: 'applied', result }
  }

  /**
   * Drop one queued request. The target keeps its current state — cancelling
   * never reverts anything, because nothing happened yet.
   * @param {string} id
   * @returns {Promise<PendingDiscarded>}
   * @throws {PendingError} `UNKNOWN_PENDING`.
   */
  async cancel(id) {
    const discarded = await this.#mutate((document) => {
      const index = document.pending.findIndex((entry) => entry.id === id)
      if (index === -1) {
        throw new PendingError('UNKNOWN_PENDING', `No pending record "${id}"; it may have been confirmed, cancelled or expired already.`)
      }
      const [record] = document.pending.splice(index, 1)
      return record
    })
    return { record: clone(/** @type {PendingRecord} */ (discarded)), status: 'discarded' }
  }

  /**
   * Discard every record whose 24 h window closed (doc §8.3). Called once at
   * startup and implicitly by every read/write, so the panel never shows a
   * stale row.
   * @returns {Promise<PendingRecord[]>} the discarded records.
   */
  async expire() {
    /** @type {PendingRecord[]} */
    let discarded = []
    await this.#mutate((document, removed) => {
      // `#mutate` already dropped the expired records while loading; this write
      // persists that removal (and is a harmless no-op when nothing expired).
      void document
      discarded = removed
    })
    return discarded.map((record) => clone(record))
  }

  /**
   * Load the document, dropping expired records in memory and reporting them so
   * a read can persist the removal.
   * @returns {Promise<{document: PendingDocument, removed: PendingRecord[]}>}
   */
  async #load() {
    /** @type {string} */
    let text
    try {
      text = await readFile(this.#file, 'utf8')
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return { document: { version: PENDING_VERSION, pending: [] }, removed: [] }
      throw error
    }
    if (text.trim() === '') return { document: { version: PENDING_VERSION, pending: [] }, removed: [] }

    /** @type {unknown} */
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new PendingError('INVALID_PENDING', `${this.#file} is not valid JSON; fix or remove it.`)
    }
    if (!isPlainObject(parsed)) {
      throw new PendingError('INVALID_PENDING', `${this.#file} must contain a JSON object.`)
    }
    if (parsed.version !== PENDING_VERSION) {
      throw new PendingError(
        'INVALID_PENDING',
        `${this.#file} has unsupported version ${String(parsed.version)}; expected ${PENDING_VERSION}.`,
      )
    }
    if (!Array.isArray(parsed.pending)) {
      throw new PendingError('INVALID_PENDING', `${this.#file} must contain a "pending" array.`)
    }
    /** @type {PendingRecord[]} */
    const pending = []
    const seen = new Set()
    for (let index = 0; index < parsed.pending.length; index += 1) {
      const record = normalizeRecord(parsed.pending[index], `pending[${index}]`)
      if (seen.has(record.id)) {
        throw new PendingError('INVALID_PENDING', `${this.#file}: duplicate pending id "${record.id}".`)
      }
      seen.add(record.id)
      pending.push(record)
    }
    /** @type {PendingDocument} */
    const document = { version: PENDING_VERSION, pending }
    const removed = dropExpired(document, this.#now().getTime())
    return { document, removed }
  }

  /**
   * Commit the document atomically: write a sibling temp file, then rename it
   * over the queue, so a reader sees either the old or the new complete file.
   * @param {PendingDocument} document
   * @returns {Promise<void>}
   */
  async #save(document) {
    await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 })
    const temporary = `${this.#file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.#file)
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    }
  }

  /**
   * Run one read-modify-write after every earlier mutation of the same file
   * finished, in this process and across instances. Expired records are
   * discarded before the callback sees the document.
   * @template T
   * @param {(document: PendingDocument, removed: PendingRecord[]) => T} mutate
   * @returns {Promise<T>}
   */
  async #mutate(mutate) {
    const key = resolve(this.#file)
    const previous = MUTATION_QUEUES.get(key) ?? Promise.resolve()
    const operation = previous.then(async () => {
      const { document, removed } = await this.#load()
      for (const record of removed) {
        this.#log('info', 'dsh-server-connector: discarded expired pending %s (%s)', record.id, record.kind)
      }
      const result = mutate(document, removed)
      await this.#save(document)
      return result
    })
    const settled = operation.then(
      () => undefined,
      () => undefined,
    )
    MUTATION_QUEUES.set(key, settled)
    void settled.then(() => {
      if (MUTATION_QUEUES.get(key) === settled) MUTATION_QUEUES.delete(key)
    })
    return operation
  }

  /**
   * Read one record that is still pending and not expired, without mutating.
   * @param {string} id
   * @returns {Promise<PendingRecord>}
   */
  async #requireLive(id) {
    const { document, removed } = await this.#load()
    if (removed.length > 0) await this.#save(document)
    const record = document.pending.find((entry) => entry.id === id)
    if (record === undefined) {
      const expired = removed.find((entry) => entry.id === id)
      if (expired !== undefined) {
        throw new PendingError(
          'EXPIRED_PENDING',
          `Pending record "${id}" expired at ${expired.expiresAt} and was discarded; request the ${expired.kind} again if it is still wanted.`,
          { record: clone(expired) },
        )
      }
      throw new PendingError(
        'UNKNOWN_PENDING',
        `No pending record "${id}"; it may have been confirmed, cancelled or expired already.`,
      )
    }
    return clone(record)
  }

  /**
   * @param {string} level
   * @param {string} message
   * @param {...unknown} args
   * @returns {void}
   */
  #log(level, message, ...args) {
    const logger = this.#logger
    if (logger === null || logger === undefined) return
    const write = logger[/** @type {'info'|'warn'|'error'} */ (level)] ?? logger.info
    if (typeof write === 'function') write.call(logger, message, ...args)
  }
}

/**
 * The production applier: the side-effecting half of `confirm()` (doc §8.3).
 *
 * - `delete-server`      → remove the record from `servers.json`, close the
 *                          pool connection, drop the stored password, and write
 *                          a `server-deleted` audit event;
 * - `disable-hostkey`    → set `hostKeyMode: "off"` and write `hostkey-disabled`;
 * - `disable-rule`       → add the rule id to `disabledRules` and write
 *                          `rule-disabled`.
 *
 * Everything is injected, so the queue module itself never imports the
 * registry, the pool or the audit log (doc §2.2).
 * @param {{
 *   registry: import('./registry.js').Registry,
 *   pool?: {disconnect(serverId: string): Promise<void>} | null,
 *   audit?: {append(entry: Record<string, unknown>): Promise<unknown>} | null,
 *   getCredentials?: () => ({unset?(ref: string): Promise<void>} | null | undefined),
 *   logger?: {info?: Function, warn?: Function, error?: Function} | null,
 * }} options
 * @returns {(record: PendingRecord) => Promise<{event: string, serverId: string, serverName: string|null, detail: string}>}
 */
export function createPendingApplier(options) {
  const { registry, pool = null, audit = null, getCredentials, logger = null } = options
  if (registry === undefined || registry === null) {
    throw new PendingError('INVALID_PENDING', 'createPendingApplier requires a registry.')
  }

  /**
   * @param {'info'|'warn'|'error'} level
   * @param {string} message
   * @param {...unknown} args
   * @returns {void}
   */
  const log = (level, message, ...args) => {
    if (logger === null) return
    const write = logger[level] ?? logger.info
    if (typeof write === 'function') write.call(logger, message, ...args)
  }

  /**
   * @param {PendingRecord} record
   * @param {string} event
   * @param {string|null} serverName
   * @param {string} detail
   * @returns {Promise<{event: string, serverId: string, serverName: string|null, detail: string}>}
   */
  const recordEvent = async (record, event, serverName, detail) => {
    const summary = { event, serverId: record.serverId, serverName, detail }
    if (audit === null) return summary
    try {
      await audit.append({
        event: /** @type {'server-deleted'|'hostkey-disabled'|'rule-disabled'} */ (event),
        serverId: record.serverId,
        ...(serverName === null ? {} : { serverName }),
        detail,
      })
    } catch (error) {
      // The operation already committed; a broken audit file must not make the
      // panel believe the deletion failed. Report it in the log instead.
      log('error', 'dsh-server-connector: could not write the %s audit event: %s', event, String(error))
    }
    return summary
  }

  return async function apply(record) {
    if (record.kind === 'delete-server') {
      /** @type {import('./registry.js').ServerRecord|null} */
      const snapshot = /** @type {import('./registry.js').ServerRecord|null} */ (record.snapshot ?? null)
      try {
        await registry.remove(record.serverId)
      } catch (error) {
        // A record already gone is the desired end state; anything else is a
        // real failure and must keep the pending row (confirm() rethrows).
        if (!(error instanceof Error && /** @type {{code?: string}} */ (error).code === 'UNKNOWN_SERVER')) throw error
      }
      if (pool !== null) await pool.disconnect(record.serverId)
      if (snapshot !== null && snapshot.auth !== undefined && snapshot.auth.kind === 'password') {
        const credentials = getCredentials?.()
        if (credentials !== null && credentials !== undefined) {
          try {
            await credentials.unset?.(snapshot.auth.credentialRef)
          } catch (error) {
            log('warn', 'dsh-server-connector: could not remove the credential of %s: %s', record.serverId, String(error))
          }
        }
      }
      const serverName = snapshot === null ? null : String(snapshot.name)
      return recordEvent(record, 'server-deleted', serverName, `server ${serverName ?? record.serverId} removed`)
    }

    if (record.kind === 'disable-hostkey') {
      const server = await registry.update(record.serverId, { hostKeyMode: 'off' })
      return recordEvent(record, 'hostkey-disabled', server.name, 'hostKeyMode changed to off (host-key verification disabled)')
    }

    if (record.kind === 'disable-rule') {
      const server = await registry.get(record.serverId)
      if (server === null) {
        // The record vanished between the request and the confirmation; the
        // applier reports it with the registry's own code so confirm() keeps
        // the pending row instead of silently discarding it.
        throw Object.assign(new Error(`Unknown server "${record.serverId}"; request the rule change again.`), {
          code: 'UNKNOWN_SERVER',
        })
      }
      const ruleId = String(record.ruleId)
      const disabledRules = server.disabledRules.includes(ruleId)
        ? server.disabledRules
        : [...server.disabledRules, ruleId]
      await registry.update(record.serverId, { disabledRules })
      return recordEvent(record, 'rule-disabled', server.name, `high-risk rule ${ruleId} disabled`)
    }

    throw new PendingError('INVALID_PENDING', `Unsupported pending kind "${String(record.kind)}".`)
  }
}
