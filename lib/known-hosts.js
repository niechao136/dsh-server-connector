// dsh-server-connector — host key fingerprints (design doc §3.2, §6.4, §7.4).
//
// The store remembers, per server id, the fingerprint the pool accepted on the
// first successful handshake:
//
//   $DSH_HOME/server-connector/known_hosts.json
//   { "srv-01": { "hash": "<sha256 base64>", "firstSeen": "...", "algorithm": "ssh-ed25519" } }
//
// The document is flat — one key per server id, no version wrapper — exactly as
// doc §3.2 draws it, so a person can inspect and edit it by hand (the plan's
// recovery path for a changed fingerprint is "confirm, then trust the new one").
//
// Guarantees, in the same spirit as the registry (§3.1):
// - a missing or empty file is an empty store; a read never creates the file;
// - a malformed document is reported (`INVALID_KNOWN_HOSTS`), never rewritten;
// - every mutation is an atomic replace (temp file in the same directory +
//   rename) and is serialised per file across instances of this process;
// - `firstSeen` survives re-recording the same fingerprint, so it keeps meaning
//   "when this host was first trusted".
//
// This module knows nothing about SSH connections: `lib/pool.js` owns the
// verification decision (§7.4); the store only persists its outcome.

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { connectorDirectory } from './registry.js'

/** File name of the fingerprint store. */
export const KNOWN_HOSTS_FILE_NAME = 'known_hosts.json'

/**
 * One write promise per store file, so every KnownHosts instance in this
 * process serialises its mutations against the same document (the registry
 * uses the same pattern for servers.json).
 * @type {Map<string, Promise<void>>}
 */
const MUTATION_QUEUES = new Map()

/**
 * One stored fingerprint, exactly as persisted (doc §3.2).
 * @typedef {object} HostKeyRecord
 * @property {string} hash - SHA-256 of the host public key blob, base64 (the
 *   `SHA256:`-style digest ssh(1) prints, minus its prefix).
 * @property {string} firstSeen - ISO-8601 timestamp of first acceptance.
 * @property {string} algorithm - key type from the blob, e.g. `ssh-ed25519`.
 */

/**
 * Machine-readable fingerprint-store failure. `INVALID_HOST_KEY` marks bytes
 * that cannot be an SSH host key; `INVALID_KNOWN_HOSTS` marks a bad call or a
 * malformed document on disk.
 * @typedef {'INVALID_KNOWN_HOSTS'|'INVALID_HOST_KEY'} KnownHostsErrorCode
 */
export class KnownHostsError extends Error {
  /**
   * @param {KnownHostsErrorCode} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'KnownHostsError'
    /** @type {KnownHostsErrorCode} */
    this.code = code
  }
}

/**
 * Default location of `known_hosts.json` (doc §3.5).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function defaultKnownHostsFile(env = process.env) {
  return join(connectorDirectory(env), KNOWN_HOSTS_FILE_NAME)
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
 * Compute the stored fingerprint of a host public key.
 *
 * `ssh2`'s `hostVerifier` receives the raw SSH wire-format key blob (unless a
 * `hostHash` option is set), so the digest is computed here: SHA-256 over the
 * whole blob, base64-encoded, which is the value modern OpenSSH shows as
 * `SHA256:<base64>`. The leading wire string of the blob is the key algorithm
 * name (`ssh-ed25519`, `rsa-sha2-256`, …); it is kept for the human-readable
 * panel row (doc §8.2) and to make a fingerprint file readable without a
 * decoder.
 * @param {Buffer|Uint8Array|string} hostKey - the host public key blob.
 * @returns {{hash: string, algorithm: string}}
 * @throws {KnownHostsError} `INVALID_HOST_KEY` when the bytes cannot be a key.
 */
export function fingerprintHostKey(hostKey) {
  const blob = Buffer.isBuffer(hostKey) ? hostKey : Buffer.from(hostKey ?? [])
  if (blob.length < 5) {
    throw new KnownHostsError('INVALID_HOST_KEY', 'host public key is too short to be an SSH public key blob.')
  }
  const algorithmLength = blob.readUInt32BE(0)
  if (algorithmLength < 1 || algorithmLength > blob.length - 4) {
    throw new KnownHostsError('INVALID_HOST_KEY', 'host public key blob has a malformed algorithm-name field.')
  }
  const algorithm = blob.subarray(4, 4 + algorithmLength).toString('latin1')
  if (!/^[A-Za-z0-9@._+-]+$/.test(algorithm)) {
    throw new KnownHostsError('INVALID_HOST_KEY', `host public key blob names an implausible algorithm: ${algorithm}`)
  }
  return { hash: createHash('sha256').update(blob).digest('base64'), algorithm }
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new KnownHostsError('INVALID_KNOWN_HOSTS', `${field} must be a non-empty string.`)
  }
  return value.trim()
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function requiredTimestamp(value, field) {
  const text = requiredString(value, field)
  if (Number.isNaN(new Date(text).getTime())) {
    throw new KnownHostsError('INVALID_KNOWN_HOSTS', `${field} must be an ISO-8601 timestamp.`)
  }
  return new Date(text).toISOString()
}

/**
 * Validate one fingerprint digest. Accepting anything else would let a
 * hand-edited file or a caller store a value the comparison can never match,
 * which reads as "fingerprint changed" forever.
 *
 * The digest is the base64 SHA-256 of the host key blob, i.e. the `SHA256:…`
 * value OpenSSH prints once the prefix is dropped. A 32-byte digest encodes to
 * 44 characters including one `=` pad.
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function normalizeHash(value, field) {
  const hash = requiredString(value, field)
  if (!/^[A-Za-z0-9+/]{43}=$/.test(hash)) {
    throw new KnownHostsError('INVALID_KNOWN_HOSTS', `${field} must be a base64 SHA-256 digest (44 characters).`)
  }
  return hash
}

/**
 * Validate one persisted record. Anything that is not exactly the §3.2 shape is
 * rejected instead of being coerced, so a hand-edited file cannot silently
 * weaken a comparison.
 * @param {unknown} value
 * @param {string} serverId
 * @returns {HostKeyRecord}
 */
function normalizeRecord(value, serverId) {
  if (!isPlainObject(value)) {
    throw new KnownHostsError('INVALID_KNOWN_HOSTS', `known_hosts entry "${serverId}" must be an object.`)
  }
  for (const key of Object.keys(value)) {
    if (key !== 'hash' && key !== 'firstSeen' && key !== 'algorithm') {
      throw new KnownHostsError(
        'INVALID_KNOWN_HOSTS',
        `known_hosts entry "${serverId}" has unknown field "${key}"; allowed: hash, firstSeen, algorithm.`,
      )
    }
  }
  const hash = normalizeHash(value.hash, `known_hosts["${serverId}"].hash`)
  return {
    hash,
    firstSeen: requiredTimestamp(value.firstSeen, `known_hosts["${serverId}"].firstSeen`),
    algorithm: requiredString(value.algorithm, `known_hosts["${serverId}"].algorithm`),
  }
}

/**
 * The fingerprint store. One instance per file; instances on the same file share
 * the mutation queue.
 */
export class KnownHosts {
  /** @type {string} */
  #file

  /**
   * @param {{file?: string, env?: NodeJS.ProcessEnv}} [options] - `file` exists
   *   for tests and for an embedding host that keeps the data elsewhere;
   *   production code passes nothing and gets `$DSH_HOME/server-connector/known_hosts.json`.
   */
  constructor(options = {}) {
    this.#file = options.file ?? defaultKnownHostsFile(options.env)
  }

  /** Absolute path of the backing document. */
  get file() {
    return this.#file
  }

  /**
   * Every stored fingerprint, newest call reading the file afresh.
   * @returns {Promise<Array<{serverId: string} & HostKeyRecord>>}
   */
  async list() {
    const document = await this.#load()
    return Object.entries(document)
      .map(([serverId, record]) => ({ serverId, ...record }))
      .sort((left, right) => left.serverId.localeCompare(right.serverId))
  }

  /**
   * The fingerprint remembered for one server, or `null` when the host has
   * never been accepted (doc §7.4's `knownHosts.get(serverId)`).
   * @param {string} serverId
   * @returns {Promise<HostKeyRecord|null>}
   */
  async get(serverId) {
    const id = requiredString(serverId, 'serverId')
    const document = await this.#load()
    const record = document[id]
    return record === undefined ? null : { ...record }
  }

  /**
   * Record a fingerprint. Re-recording the same hash keeps the original
   * `firstSeen`; a different hash is a new trust decision and starts a new
   * record (doc §6.4: a changed fingerprint is rejected until a person trusts it
   * again).
   * @param {string} serverId
   * @param {{hash: string, algorithm: string, firstSeen?: string}} fingerprint
   * @returns {Promise<HostKeyRecord>}
   */
  async set(serverId, fingerprint) {
    const id = requiredString(serverId, 'serverId')
    if (!isPlainObject(fingerprint)) {
      throw new KnownHostsError('INVALID_KNOWN_HOSTS', 'fingerprint must be an object with hash and algorithm.')
    }
    const hash = normalizeHash(fingerprint.hash, 'fingerprint.hash')
    const algorithm = requiredString(fingerprint.algorithm, 'algorithm')
    const now = new Date().toISOString()
    return this.#mutate((document) => {
      const existing = document[id]
      const firstSeen =
        existing !== undefined && existing.hash === hash
          ? existing.firstSeen
          : fingerprint.firstSeen === undefined
            ? now
            : requiredTimestamp(fingerprint.firstSeen, 'firstSeen')
      /** @type {HostKeyRecord} */
      const record = { hash, firstSeen, algorithm }
      document[id] = record
      return { ...record }
    })
  }

  /**
   * Forget one server's fingerprint (used when a server is deleted).
   * @param {string} serverId
   * @returns {Promise<boolean>} whether a record existed.
   */
  async remove(serverId) {
    const id = requiredString(serverId, 'serverId')
    return this.#mutate((document) => {
      if (!(id in document)) return false
      delete document[id]
      return true
    })
  }

  /**
   * Read and validate the whole document.
   * @returns {Promise<Record<string, HostKeyRecord>>}
   */
  async #load() {
    /** @type {string} */
    let text
    try {
      text = await readFile(this.#file, 'utf8')
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return {}
      throw error
    }
    if (text.trim() === '') return {}

    /** @type {unknown} */
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new KnownHostsError('INVALID_KNOWN_HOSTS', `${this.#file} is not valid JSON; fix or remove it.`)
    }
    if (!isPlainObject(parsed)) {
      throw new KnownHostsError('INVALID_KNOWN_HOSTS', `${this.#file} must contain a JSON object of serverId → record.`)
    }
    /** @type {Record<string, HostKeyRecord>} */
    const document = {}
    for (const [serverId, value] of Object.entries(parsed)) {
      if (serverId.trim() === '') {
        throw new KnownHostsError('INVALID_KNOWN_HOSTS', `${this.#file} has an empty server id.`)
      }
      document[serverId] = normalizeRecord(value, serverId)
    }
    return document
  }

  /**
   * Commit the document atomically: write a sibling temp file, then rename it
   * over the store, so a reader sees either the old or the new complete file.
   * @param {Record<string, HostKeyRecord>} document
   * @returns {Promise<void>}
   */
  async #save(document) {
    await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 })
    const temporary = `${this.#file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    // Keep a stable, readable ordering (doc §3.2) instead of insertion order.
    /** @type {Record<string, HostKeyRecord>} */
    const ordered = {}
    for (const serverId of Object.keys(document).sort()) {
      const record = document[serverId]
      if (record !== undefined) ordered[serverId] = record
    }
    try {
      await writeFile(temporary, `${JSON.stringify(ordered, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.#file)
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    }
  }

  /**
   * Run one read-modify-write after every earlier mutation of the same file
   * finished, in this process and across instances.
   * @template T
   * @param {(document: Record<string, HostKeyRecord>) => T} mutate
   * @returns {Promise<T>}
   */
  async #mutate(mutate) {
    const key = resolve(this.#file)
    const previous = MUTATION_QUEUES.get(key) ?? Promise.resolve()
    const operation = previous.then(async () => {
      const document = await this.#load()
      const result = mutate(document)
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
}
