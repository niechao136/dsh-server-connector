// dsh-server-connector — server registry (design doc §3.1/§3.5).
//
// The registry owns exactly one thing: CRUD over server records in
// `$DSH_HOME/server-connector/servers.json`. It knows nothing about SSH,
// policy evaluation or DSH; `lib/tools.js` (a later phase) composes it.
//
// Guarantees:
// - every mutation validates a complete record before anything is written;
// - the write is an atomic replacement (temp file in the same directory +
//   rename), so a crash never leaves a half-written JSON document;
// - mutations are serialised per instance, so two concurrent create() calls
//   cannot read the same document and silently lose one server;
// - secrets are never persisted: password auth keeps only a `credentialRef`.
//
// File layout (doc §3.5):
//   $DSH_HOME/server-connector/servers.json
//   { "version": 1, "servers": [ ... ] }

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Schema version written to, and required from, `servers.json`. */
export const REGISTRY_VERSION = 1

/** Directory below `$DSH_HOME` that holds every file of this plugin (doc §3.5). */
export const CONNECTOR_DIR_NAME = 'server-connector'

/**
 * One tail promise per registry file, so every Registry instance in this
 * process serialises its mutations against the same document.
 * @type {Map<string, Promise<void>>}
 */
const MUTATION_QUEUES = new Map()

/** File name of the server registry. */
export const SERVERS_FILE_NAME = 'servers.json'

/** The three auth shapes of doc §3.1. */
export const AUTH_KINDS = Object.freeze(['key', 'password', 'agent'])

/** The three host-key verification modes of doc §6.4. */
export const HOST_KEY_MODES = Object.freeze(['accept-new', 'verify', 'off'])

/** The three per-server policy levels of doc §4.2. */
export const DECISION_VALUES = Object.freeze(['allow', 'confirm', 'block'])

/**
 * One server record exactly as persisted (doc §3.1).
 * @typedef {object} ServerRecord
 * @property {string} id - stable addressing key; names may change, ids must not.
 * @property {string} name - unique display name.
 * @property {string} host
 * @property {number} port
 * @property {string} username
 * @property {{kind:'key', privateKeyPath:string}|{kind:'password', credentialRef:string}|{kind:'agent'}} auth
 * @property {'accept-new'|'verify'|'off'} hostKeyMode
 * @property {string|null} defaultWorkDir
 * @property {Record<string, 'allow'|'confirm'|'block'>} policy
 * @property {string[]} disabledRules
 * @property {string} createdAt
 * @property {string|null} lastConnectedAt
 */

/**
 * The parsed file: a schema version plus the records.
 * @typedef {object} RegistryDocument
 * @property {number} version
 * @property {ServerRecord[]} servers
 */

/**
 * Machine-readable registry failure. `UNKNOWN_SERVER` and `AMBIGUOUS_SERVER`
 * are the tool-facing codes of doc §5.5; the rest describe input or storage
 * problems. The message is written for both the model and the panel: unknown
 * servers list every configured server, ambiguous ones list the candidates, so
 * a caller can self-correct in one turn (doc §5.2).
 * @typedef {'UNKNOWN_SERVER'|'AMBIGUOUS_SERVER'|'DUPLICATE_NAME'|'INVALID_SERVER'|'INVALID_REGISTRY'} RegistryErrorCode
 */
export class RegistryError extends Error {
  /**
   * @param {RegistryErrorCode} code
   * @param {string} message
   * @param {{available?: string[], candidates?: string[]}} [details]
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'RegistryError'
    /** @type {RegistryErrorCode} */
    this.code = code
    /** @type {string[]|undefined} */
    this.available = details.available
    /** @type {string[]|undefined} */
    this.candidates = details.candidates
  }
}

/**
 * The harness home: `$DSH_HOME` when set, otherwise `~/.dsh` (the same default
 * the harness itself uses).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function dshHome(env = process.env) {
  const configured = env.DSH_HOME
  return configured !== undefined && configured.trim() !== '' ? configured.trim() : join(homedir(), '.dsh')
}

/**
 * The plugin's data directory below the harness home.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function connectorDirectory(env = process.env) {
  return join(dshHome(env), CONNECTOR_DIR_NAME)
}

/**
 * Default location of `servers.json` (doc §3.5).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function defaultServersFile(env = process.env) {
  return join(connectorDirectory(env), SERVERS_FILE_NAME)
}

/** Fields a create() call accepts. */
const CREATE_FIELDS = new Set([
  'name',
  'host',
  'port',
  'username',
  'auth',
  'hostKeyMode',
  'defaultWorkDir',
  'policy',
  'disabledRules',
])

/** Fields an update() call accepts; `id` and `createdAt` are immutable. */
const UPDATE_FIELDS = new Set([...CREATE_FIELDS, 'lastConnectedAt'])

/** Fields a persisted record carries. */
const STORED_FIELDS = new Set(['id', ...CREATE_FIELDS, 'createdAt', 'lastConnectedAt'])

/** Allowed keys inside each auth shape. */
/** @type {Record<'key'|'password'|'agent', ReadonlySet<string>>} */
const AUTH_FIELDS = {
  key: new Set(['kind', 'privateKeyPath']),
  password: new Set(['kind', 'credentialRef']),
  agent: new Set(['kind']),
}

/**
 * Fields that would put a secret into `servers.json`. They are rejected with a
 * dedicated message rather than a generic "unknown field" one, because the
 * constraint is security-relevant (doc §6.3).
 */
const SECRET_FIELDS = new Set(['password', 'passphrase', 'privateKey', 'privateKeyContent', 'secret', 'token'])

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
 * @returns {value is 'allow'|'confirm'|'block'}
 */
function isDecisionValue(value) {
  return value === 'allow' || value === 'confirm' || value === 'block'
}

/**
 * @param {string} field
 * @param {RegistryErrorCode} errorCode
 * @returns {RegistryError}
 */
function plaintextError(field, errorCode) {
  return new RegistryError(
    errorCode,
    `Refusing to store "${field}" in servers.json: plaintext secrets are never stored. ` +
      'Use auth.kind "key" with privateKeyPath, or auth.kind "password" with a credentialRef backed by ctx.credentials.',
  )
}

/**
 * Reject unknown fields and plaintext secrets before any value is used.
 * @param {Record<string, unknown>} source
 * @param {ReadonlySet<string>} allowed
 * @param {RegistryErrorCode} errorCode
 * @param {string} label
 * @returns {void}
 */
function assertKnownFields(source, allowed, errorCode, label) {
  for (const key of Object.keys(source)) {
    if (allowed.has(key)) continue
    if (SECRET_FIELDS.has(key)) throw plaintextError(key, errorCode)
    throw new RegistryError(
      errorCode,
      `Unknown field "${key}" in ${label}. Allowed fields: ${[...allowed].join(', ')}.`,
    )
  }
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {RegistryErrorCode} errorCode
 * @returns {string}
 */
function requiredString(value, field, errorCode) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RegistryError(errorCode, `${field} must be a non-empty string.`)
  }
  return value.trim()
}

/**
 * @param {unknown} value
 * @param {RegistryErrorCode} errorCode
 * @returns {string}
 */
function normalizeHost(value, errorCode) {
  const host = requiredString(value, 'host', errorCode)
  if (/\s/.test(host)) throw new RegistryError(errorCode, 'host must not contain whitespace.')
  return host
}

/**
 * @param {unknown} value
 * @param {RegistryErrorCode} errorCode
 * @returns {number}
 */
function normalizePort(value, errorCode) {
  if (value === undefined) return 22
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new RegistryError(errorCode, 'port must be an integer between 1 and 65535.')
  }
  return value
}

/**
 * @param {unknown} value
 * @param {RegistryErrorCode} errorCode
 * @returns {'accept-new'|'verify'|'off'}
 */
function normalizeHostKeyMode(value, errorCode) {
  if (value === undefined) return 'accept-new'
  if (value === 'accept-new' || value === 'verify' || value === 'off') return value
  throw new RegistryError(errorCode, `hostKeyMode must be one of ${HOST_KEY_MODES.join(', ')}.`)
}

/**
 * @param {unknown} value
 * @param {RegistryErrorCode} errorCode
 * @returns {string|null}
 */
function normalizeWorkDir(value, errorCode) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new RegistryError(errorCode, 'defaultWorkDir must be a string or null.')
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {RegistryErrorCode} errorCode
 * @returns {string}
 */
function normalizeTimestamp(value, field, errorCode) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RegistryError(errorCode, `${field} must be an ISO-8601 timestamp.`)
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new RegistryError(errorCode, `${field} must be an ISO-8601 timestamp.`)
  }
  return parsed.toISOString()
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {RegistryErrorCode} errorCode
 * @returns {string|null}
 */
function normalizeOptionalTimestamp(value, field, errorCode) {
  if (value === undefined || value === null) return null
  return normalizeTimestamp(value, field, errorCode)
}

/**
 * @param {unknown} value
 * @param {string} serverId
 * @param {RegistryErrorCode} errorCode
 * @returns {{kind:'key', privateKeyPath:string}|{kind:'password', credentialRef:string}|{kind:'agent'}}
 */
function normalizeAuth(value, serverId, errorCode) {
  if (value === undefined) return { kind: 'agent' }
  if (!isPlainObject(value)) throw new RegistryError(errorCode, 'auth must be an object.')
  const kind = value.kind
  if (kind === 'key') {
    assertKnownFields(value, AUTH_FIELDS.key, errorCode, 'auth')
    return { kind: 'key', privateKeyPath: requiredString(value.privateKeyPath, 'auth.privateKeyPath', errorCode) }
  }
  if (kind === 'password') {
    assertKnownFields(value, AUTH_FIELDS.password, errorCode, 'auth')
    // Doc §6.3: the record keeps a reference, never the password itself. The
    // conventional ref is `server-connector:<id>:password`.
    const credentialRef =
      value.credentialRef === undefined
        ? `server-connector:${serverId}:password`
        : requiredString(value.credentialRef, 'auth.credentialRef', errorCode)
    return { kind: 'password', credentialRef }
  }
  if (kind === 'agent') {
    assertKnownFields(value, AUTH_FIELDS.agent, errorCode, 'auth')
    return { kind: 'agent' }
  }
  throw new RegistryError(errorCode, `auth.kind must be one of ${AUTH_KINDS.join(', ')}.`)
}

/**
 * @param {unknown} value
 * @param {RegistryErrorCode} errorCode
 * @returns {Record<string, 'allow'|'confirm'|'block'>}
 */
function normalizePolicy(value, errorCode) {
  if (value === undefined) return {}
  if (!isPlainObject(value)) {
    throw new RegistryError(errorCode, 'policy must be an object of ruleId → allow|confirm|block.')
  }
  /** @type {Record<string, 'allow'|'confirm'|'block'>} */
  const policy = {}
  for (const [ruleId, decision] of Object.entries(value)) {
    if (ruleId.trim() === '') throw new RegistryError(errorCode, 'policy keys must be non-empty rule ids.')
    if (!isDecisionValue(decision)) {
      throw new RegistryError(errorCode, `policy.${ruleId} must be one of ${DECISION_VALUES.join(', ')}.`)
    }
    policy[ruleId] = decision
  }
  return policy
}

/**
 * @param {unknown} value
 * @param {RegistryErrorCode} errorCode
 * @returns {string[]}
 */
function normalizeDisabledRules(value, errorCode) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new RegistryError(errorCode, 'disabledRules must be an array of rule ids.')
  /** @type {string[]} */
  const ids = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new RegistryError(errorCode, 'disabledRules must contain non-empty rule ids.')
    }
    const id = item.trim()
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * Validate and canonicalise one complete record. Create, update and load all
 * go through this function, so a stored record and a freshly created one have
 * exactly the same shape.
 * @param {Record<string, unknown>} source
 * @param {{
 *   allowed: ReadonlySet<string>,
 *   id: string,
 *   errorCode: RegistryErrorCode,
 *   label: string,
 *   createdAt?: string,
 * }} options
 * @returns {ServerRecord}
 */
function normalizeRecord(source, options) {
  const { allowed, id, errorCode, label } = options
  if (!isPlainObject(source)) throw new RegistryError(errorCode, `${label} must be an object.`)
  assertKnownFields(source, allowed, errorCode, label)
  const createdAt =
    options.createdAt !== undefined
      ? normalizeTimestamp(options.createdAt, 'createdAt', errorCode)
      : normalizeTimestamp(source.createdAt, 'createdAt', errorCode)
  return {
    id,
    name: requiredString(source.name, 'name', errorCode),
    host: normalizeHost(source.host, errorCode),
    port: normalizePort(source.port, errorCode),
    username: requiredString(source.username, 'username', errorCode),
    auth: normalizeAuth(source.auth, id, errorCode),
    hostKeyMode: normalizeHostKeyMode(source.hostKeyMode, errorCode),
    defaultWorkDir: normalizeWorkDir(source.defaultWorkDir, errorCode),
    policy: normalizePolicy(source.policy, errorCode),
    disabledRules: normalizeDisabledRules(source.disabledRules, errorCode),
    createdAt,
    lastConnectedAt: normalizeOptionalTimestamp(source.lastConnectedAt, 'lastConnectedAt', errorCode),
  }
}

/**
 * Case- and whitespace-insensitive comparison key for the unique display name.
 * @param {string} name
 * @returns {string}
 */
function normalizeNameKey(name) {
  return name.trim().toLowerCase()
}

/**
 * @param {ServerRecord[]} servers
 * @returns {string}
 */
function describeServers(servers) {
  if (servers.length === 0) return 'none configured'
  return servers.map((server) => `${server.id} (${server.name})`).join(', ')
}

/**
 * @param {string} id
 * @param {ServerRecord[]} servers
 * @returns {RegistryError}
 */
function unknownServer(id, servers) {
  return new RegistryError('UNKNOWN_SERVER', `Unknown server "${id}". Available servers: ${describeServers(servers)}.`, {
    available: servers.map((server) => server.id),
  })
}

/**
 * @param {ServerRecord[]} servers
 * @param {string} name
 * @param {string|null} exceptId - the record being renamed, or null on create.
 * @returns {void}
 */
function assertNameAvailable(servers, name, exceptId) {
  const key = normalizeNameKey(name)
  for (const server of servers) {
    if (server.id === exceptId) continue
    if (normalizeNameKey(server.name) === key) {
      throw new RegistryError(
        'DUPLICATE_NAME',
        `A server named ${JSON.stringify(name)} already exists (id ${server.id}). Server names are unique.`,
      )
    }
  }
}

/**
 * Next sequential id, e.g. `srv-01`. The width grows to fit the number.
 * @param {ServerRecord[]} servers
 * @returns {string}
 */
function nextServerId(servers) {
  let highest = 0
  for (const server of servers) {
    const match = /^srv-(\d+)$/.exec(server.id)
    if (match === null) continue
    const digits = match[1]
    if (digits === undefined) continue
    const value = Number(digits)
    if (Number.isSafeInteger(value) && value > highest) highest = value
  }
  const next = highest + 1
  const width = next >= 100 ? String(next).length : 2
  return `srv-${String(next).padStart(width, '0')}`
}

/**
 * Drop undefined patch entries and reject immutable or unknown fields before
 * they are merged into a record.
 * @param {Record<string, unknown>} patch
 * @returns {Record<string, unknown>}
 */
function normalizePatch(patch) {
  if (!isPlainObject(patch)) throw new RegistryError('INVALID_SERVER', 'update patch must be an object.')
  /** @type {Record<string, unknown>} */
  const changes = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (key === 'id' || key === 'createdAt') {
      throw new RegistryError('INVALID_SERVER', `${key} is immutable; create a new server instead.`)
    }
    if (!UPDATE_FIELDS.has(key)) {
      if (SECRET_FIELDS.has(key)) throw plaintextError(key, 'INVALID_SERVER')
      throw new RegistryError('INVALID_SERVER', `Unknown field "${key}" in update.`)
    }
    changes[key] = value
  }
  return changes
}

/**
 * CRUD facade over one `servers.json` file.
 *
 * All methods are asynchronous; reads go straight to disk, mutations are
 * queued per file and committed atomically. Use {@link Registry.resolve} for
 * the forgiving server addressing described in doc §5.2.
 */
export class Registry {
  /** @type {string} */
  #file
  /**
   * @param {{file?: string}} [options] - `file` overrides the default path and is
   *   what the tests use; production code relies on `$DSH_HOME`.
   */
  constructor(options = {}) {
    this.#file = options.file ?? defaultServersFile()
  }

  /** Absolute path of the registry file this instance reads and writes. */
  get file() {
    return this.#file
  }

  /**
   * Every server, in file order.
   * @returns {Promise<ServerRecord[]>}
   */
  async list() {
    const document = await this.#load()
    return document.servers.map((server) => clone(server))
  }

  /**
   * Exact lookup by stable id.
   * @param {string} id
   * @returns {Promise<ServerRecord|null>} null when no server has that id.
   */
  async get(id) {
    const document = await this.#load()
    const record = document.servers.find((server) => server.id === id)
    return record === undefined ? null : clone(record)
  }

  /**
   * Forgiving lookup for a tool's `server` argument (doc §5.2):
   * 1. exact `id`;
   * 2. exact `name` (case-insensitive);
   * 3. unique prefix of an id or a name (case-insensitive);
   * 4. zero matches → `UNKNOWN_SERVER`, message listing every server;
   * 5. several matches → `AMBIGUOUS_SERVER`, message listing the candidates.
   *
   * Exact id/name matches win over prefix matches, so a name that prefixes
   * another name remains addressable.
   * @param {string} query
   * @returns {Promise<ServerRecord>}
   * @throws {RegistryError} `INVALID_SERVER`, `UNKNOWN_SERVER` or `AMBIGUOUS_SERVER`.
   */
  async resolve(query) {
    if (typeof query !== 'string' || query.trim() === '') {
      throw new RegistryError('INVALID_SERVER', 'server must be a non-empty id, name or unique prefix.')
    }
    const wanted = query.trim()
    const document = await this.#load()
    const servers = document.servers

    const exactId = servers.find((server) => server.id === wanted)
    if (exactId !== undefined) return clone(exactId)

    const wantedName = wanted.toLowerCase()
    const exactName = servers.find((server) => server.name.toLowerCase() === wantedName)
    if (exactName !== undefined) return clone(exactName)

    const prefix = wanted.toLowerCase()
    const candidates = servers.filter(
      (server) => server.id.toLowerCase().startsWith(prefix) || server.name.toLowerCase().startsWith(prefix),
    )
    const only = candidates.length === 1 ? candidates[0] : undefined
    if (only !== undefined) return clone(only)
    if (candidates.length === 0) throw unknownServer(wanted, servers)
    throw new RegistryError(
      'AMBIGUOUS_SERVER',
      `Server "${wanted}" is ambiguous: matches ${candidates
        .map((server) => `${server.id} (${server.name})`)
        .join(', ')}. Use the full id or name.`,
      { candidates: candidates.map((server) => server.id) },
    )
  }

  /**
   * Create a server. The id is assigned by the registry; `createdAt` is now.
   * @param {Record<string, unknown>} input
   * @returns {Promise<ServerRecord>} the stored record.
   * @throws {RegistryError} `INVALID_SERVER` or `DUPLICATE_NAME`.
   */
  async create(input) {
    return this.#mutate((document) => {
      const id = nextServerId(document.servers)
      const record = normalizeRecord(input, {
        allowed: CREATE_FIELDS,
        id,
        errorCode: 'INVALID_SERVER',
        label: 'server',
        createdAt: new Date().toISOString(),
      })
      assertNameAvailable(document.servers, record.name, null)
      document.servers.push(record)
      return clone(record)
    })
  }

  /**
   * Change some fields of one server. `id` and `createdAt` cannot be changed;
   * omitted fields keep their current value. The merged record is validated as
   * a whole before it replaces the stored one.
   * @param {string} id
   * @param {Record<string, unknown>} patch
   * @returns {Promise<ServerRecord>} the stored record.
   * @throws {RegistryError} `UNKNOWN_SERVER`, `INVALID_SERVER` or `DUPLICATE_NAME`.
   */
  async update(id, patch) {
    return this.#mutate((document) => {
      const index = document.servers.findIndex((server) => server.id === id)
      const existing = index === -1 ? undefined : document.servers[index]
      if (existing === undefined) throw unknownServer(id, document.servers)
      const changes = normalizePatch(patch)
      /** @type {Record<string, unknown>} */
      const merged = { ...existing }
      for (const [key, value] of Object.entries(changes)) merged[key] = value
      const record = normalizeRecord(merged, {
        allowed: STORED_FIELDS,
        id: existing.id,
        errorCode: 'INVALID_SERVER',
        label: 'server',
        createdAt: existing.createdAt,
      })
      assertNameAvailable(document.servers, record.name, existing.id)
      document.servers[index] = record
      return clone(record)
    })
  }

  /**
   * Delete one server, returning the record that was removed.
   * @param {string} id
   * @returns {Promise<ServerRecord>}
   * @throws {RegistryError} `UNKNOWN_SERVER`.
   */
  async remove(id) {
    return this.#mutate((document) => {
      const index = document.servers.findIndex((server) => server.id === id)
      const existing = index === -1 ? undefined : document.servers[index]
      if (existing === undefined) throw unknownServer(id, document.servers)
      document.servers.splice(index, 1)
      return clone(existing)
    })
  }

  /**
   * Read and validate the whole file. A missing or empty file is an empty
   * registry; invalid JSON, an unknown version, duplicate ids/names or a
   * malformed record is reported as `INVALID_REGISTRY` instead of being
   * silently rewritten.
   * @returns {Promise<RegistryDocument>}
   */
  async #load() {
    /** @type {string} */
    let text
    try {
      text = await readFile(this.#file, 'utf8')
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return { version: REGISTRY_VERSION, servers: [] }
      throw error
    }
    if (text.trim() === '') return { version: REGISTRY_VERSION, servers: [] }

    /** @type {unknown} */
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new RegistryError('INVALID_REGISTRY', `${this.#file} is not valid JSON; fix or remove it.`)
    }
    if (!isPlainObject(parsed)) {
      throw new RegistryError('INVALID_REGISTRY', `${this.#file} must contain a JSON object.`)
    }
    if (parsed.version !== REGISTRY_VERSION) {
      throw new RegistryError(
        'INVALID_REGISTRY',
        `${this.#file} has unsupported version ${String(parsed.version)}; expected ${REGISTRY_VERSION}.`,
      )
    }
    if (!Array.isArray(parsed.servers)) {
      throw new RegistryError('INVALID_REGISTRY', `${this.#file} must contain a "servers" array.`)
    }

    /** @type {ServerRecord[]} */
    const servers = []
    const seenIds = new Set()
    const seenNames = new Set()
    for (let index = 0; index < parsed.servers.length; index += 1) {
      const raw = parsed.servers[index]
      if (!isPlainObject(raw)) {
        throw new RegistryError('INVALID_REGISTRY', `${this.#file}: servers[${index}] is not an object.`)
      }
      const recordId = requiredString(raw.id, `servers[${index}].id`, 'INVALID_REGISTRY')
      const record = normalizeRecord(raw, {
        allowed: STORED_FIELDS,
        id: recordId,
        errorCode: 'INVALID_REGISTRY',
        label: `servers[${index}]`,
      })
      if (seenIds.has(record.id)) {
        throw new RegistryError('INVALID_REGISTRY', `${this.#file}: duplicate server id "${record.id}".`)
      }
      seenIds.add(record.id)
      const nameKey = normalizeNameKey(record.name)
      if (seenNames.has(nameKey)) {
        throw new RegistryError('INVALID_REGISTRY', `${this.#file}: duplicate server name ${record.name}.`)
      }
      seenNames.add(nameKey)
      servers.push(record)
    }
    return { version: REGISTRY_VERSION, servers }
  }

  /**
   * Commit the document by writing a sibling temp file and renaming it over
   * the registry. Readers only ever observe the old or the new complete file.
   * @param {RegistryDocument} document
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
   * Run one read-modify-write operation after every earlier mutation finished.
   *
   * The queue is keyed by the absolute file path, not by this instance: the
   * tools surface, the HTTP routes and the tests each build their own Registry,
   * and two instances on the same file must not lose each other's writes.
   * @template T
   * @param {(document: RegistryDocument) => T} mutate
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
    // Keep the map from growing once a file goes quiet.
    void settled.then(() => {
      if (MUTATION_QUEUES.get(key) === settled) MUTATION_QUEUES.delete(key)
    })
    return operation
  }
}
