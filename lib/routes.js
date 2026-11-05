// dsh-server-connector — HTTP routes for the Client half (design doc §8.5).
//
// Eleven endpoints read and write the same units the tools use:
//
//   GET    /server-connector/servers            list (no secrets)
//   POST   /server-connector/servers            create
//   PUT    /server-connector/servers/:id        update (off / 停用 go to the pending queue)
//   DELETE /server-connector/servers/:id        delete *request* → pending queue
//   POST   /server-connector/test               connection test (outside a turn, no policy gate)
//   POST   /server-connector/connect/:id        open the pooled connection
//   POST   /server-connector/disconnect/:id     close it
//   GET    /server-connector/audit?limit=20     audit tail
//   GET    /server-connector/pending            two-step queue
//   POST   /server-connector/pending/:id/confirm
//   POST   /server-connector/pending/:id/cancel
//
// Two rules shape this module:
//
// 1. **The panel has no turn**, so `ctx.approval` is unavailable (§11). Every
//    destructive operation therefore goes through the pending queue (§8.3):
//    nothing here deletes a server, sets `hostKeyMode: off` or disables a rule
//    directly. The handlers *request*; only `pending.confirm` applies.
// 2. **The response never carries a secret** (§6.3). A stored password is a
//    credential reference the panel cannot read; the panel only learns whether
//    one is configured. A password arrives write-only on create/update and goes
//    straight to `ctx.credentials`.
//
// The HTTP layer is split from the handlers so the contract is testable without
// a socket: {@link createApi} is a pure dispatcher over `{method, path, query,
// body}` and {@link createHandler} is the thin node:http adapter.

import { stat } from 'node:fs/promises'

import { AuditError } from './audit.js'
import { PendingError } from './pending.js'
import { PoolError } from './pool.js'
import { RULES, RULES_BY_ID, effectiveDecision } from './policy.js'
import { DECISION_VALUES, RegistryError } from './registry.js'
import { CONNECT_PROBE, parseProbe } from './tools.js'

/** Mount path of every route below (doc §8.5). */
export const API_PREFIX = '/server-connector'

/** Largest request body the panel may send; the forms are small JSON objects. */
export const MAX_BODY_BYTES = 64 * 1024

/** Audit tail ceiling; the panel asks for 20, the API never reads more than this. */
export const MAX_AUDIT_LIMIT = 200

/**
 * The eleven endpoints of doc §8.5, in table order.
 *
 * `path` is relative to {@link API_PREFIX}; `:name` segments are parameters.
 * Tests and the handler's 405 response read this table, so it is the single
 * declaration of the surface.
 * @type {ReadonlyArray<{method: string, path: string, op: string}>}
 */
export const API_ROUTES = Object.freeze([
  Object.freeze({ method: 'GET', path: '/servers', op: 'listServers' }),
  Object.freeze({ method: 'POST', path: '/servers', op: 'createServer' }),
  Object.freeze({ method: 'PUT', path: '/servers/:id', op: 'updateServer' }),
  Object.freeze({ method: 'DELETE', path: '/servers/:id', op: 'requestDelete' }),
  Object.freeze({ method: 'POST', path: '/test', op: 'testConnection' }),
  Object.freeze({ method: 'POST', path: '/connect/:id', op: 'connectServer' }),
  Object.freeze({ method: 'POST', path: '/disconnect/:id', op: 'disconnectServer' }),
  Object.freeze({ method: 'GET', path: '/audit', op: 'listAudit' }),
  Object.freeze({ method: 'GET', path: '/pending', op: 'listPending' }),
  Object.freeze({ method: 'POST', path: '/pending/:id/confirm', op: 'confirmPending' }),
  Object.freeze({ method: 'POST', path: '/pending/:id/cancel', op: 'cancelPending' }),
])

/**
 * A handler failure carrying the status the browser should show.
 *
 * Codes are stable strings the panel may branch on; `message` is written for a
 * person and is safe to display (it never contains a secret).
 */
export class HttpError extends Error {
  /**
   * @param {number} status - HTTP status code.
   * @param {string} code - stable machine-readable code, e.g. `INVALID_SERVER`.
   * @param {string} message - displayable message.
   * @param {Record<string, unknown>} [details] - extra fields for the panel.
   */
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'HttpError'
    /** @type {number} */
    this.status = status
    /** @type {string} */
    this.code = code
    /** @type {Record<string, unknown>} */
    this.details = details
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'INVALID_SERVER', `${field} must be a non-empty string.`)
  }
  return value.trim()
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string} an absolute POSIX path, as doc §8.4 requires.
 */
function absolutePath(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'INVALID_SERVER', `${field} must be a non-empty absolute path.`)
  }
  const path = value.trim()
  if (!path.startsWith('/')) {
    throw new HttpError(400, 'INVALID_SERVER', `${field} must be an absolute path.`)
  }
  return path
}

/**
 * A path on *this* machine, which is not necessarily a POSIX one.
 *
 * `auth.privateKeyPath` points at a local file the Host reads itself, so on
 * Windows it is an ordinary drive-letter (`C:\Users\me\.ssh\id_ed25519`) or
 * UNC (`\\server\share\key`) path. Requiring a leading `/` here rejected every
 * Windows path the panel could offer, which left key auth unusable on Windows
 * even though the Host-side file check accepted the very same path.
 *
 * `defaultWorkDir` deliberately keeps using {@link absolutePath}: it is a path
 * on the *remote* host, which is POSIX by contract.
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function localAbsolutePath(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'INVALID_SERVER', `${field} must be a non-empty absolute path.`)
  }
  const path = value.trim()
  if (path.startsWith('/')) return path
  if (/^[A-Za-z]:[\\/]/.test(path)) return path
  if (path.startsWith('\\\\')) return path
  throw new HttpError(400, 'INVALID_SERVER', `${field} must be an absolute path.`)
}

/** The three auth kinds of doc §3.1. @type {ReadonlyArray<string>} */
const AUTH_KINDS = Object.freeze(['key', 'password', 'agent'])

/** The three host-key modes of doc §6.4. @type {ReadonlyArray<string>} */
const HOST_KEY_MODES = Object.freeze(['accept-new', 'verify', 'off'])

/**
 * Validate the public `auth` object of a create/update body (§3.1, §8.4).
 *
 * A password never appears here: it arrives in the separate write-only
 * `password` field and is stored through `ctx.credentials` (doc §6.3).
 * @param {unknown} value
 * @returns {{kind:'key', privateKeyPath:string}|{kind:'password'}|{kind:'agent'}}
 */
function normalizeAuthBody(value) {
  if (value === undefined) return { kind: 'agent' }
  if (!isPlainObject(value)) throw new HttpError(400, 'INVALID_SERVER', 'auth must be an object.')
  const kind = value.kind
  if (kind === 'key') {
    for (const key of Object.keys(value)) {
      if (key !== 'kind' && key !== 'privateKeyPath') {
        throw new HttpError(400, 'INVALID_SERVER', `Unknown auth field "${key}".`)
      }
    }
    return { kind: 'key', privateKeyPath: localAbsolutePath(value.privateKeyPath, 'auth.privateKeyPath') }
  }
  if (kind === 'password') {
    for (const key of Object.keys(value)) {
      if (key !== 'kind') throw new HttpError(400, 'INVALID_SERVER', `Unknown auth field "${key}".`)
    }
    return { kind: 'password' }
  }
  if (kind === 'agent') {
    for (const key of Object.keys(value)) {
      if (key !== 'kind') throw new HttpError(400, 'INVALID_SERVER', `Unknown auth field "${key}".`)
    }
    return { kind: 'agent' }
  }
  throw new HttpError(400, 'INVALID_SERVER', `auth.kind must be one of ${AUTH_KINDS.join(', ')}.`)
}

/**
 * The server fields both mutations share, spelled once.
 *
 * The write-only credential is deliberately not in this list: it is a request
 * field, not a record field (`servers.json` never holds it, §6.3), so each
 * operation adds it where it applies.
 */
const SHARED_BODY_FIELDS = Object.freeze(['name', 'host', 'port', 'username', 'auth', 'hostKeyMode', 'defaultWorkDir', 'policy'])

/** Fields a create body may carry; everything else is rejected by name. */
const CREATE_BODY_FIELDS = new Set([...SHARED_BODY_FIELDS, 'password', 'disableRules'])

/** Fields an update body may carry. `disabledRules` is listed only to explain its refusal. */
const UPDATE_BODY_FIELDS = new Set([...SHARED_BODY_FIELDS, 'password', 'enableRules', 'disableRules', 'disabledRules'])

/**
 * Reject a body key the panel has no business sending.
 *
 * This is where a plaintext secret would arrive by mistake (`auth.passphrase`,
 * a top-level `secret`): silently ignoring it would let the panel believe it was
 * stored, so an unknown key is a 400 instead.
 * @param {Record<string, unknown>} body
 * @param {ReadonlySet<string>} allowed
 * @returns {void}
 */
function assertKnownBodyFields(body, allowed) {
  for (const key of Object.keys(body)) {
    if (allowed.has(key)) continue
    throw new HttpError(400, 'INVALID_SERVER', `Unknown field "${key}" in the request body.`)
  }
}

/**
 * The decisions a rule may take from the panel (§4.2.3, §8.4).
 *
 * A built-in `block` rule may be lowered to `confirm` but never straight to
 * `allow`; a `confirm` rule may be relaxed to `allow`, tightened to `block`, or
 * switched off through the pending queue.
 * @param {{defaultDecision: string}} rule
 * @returns {string[]}
 */
export function allowedDecisions(rule) {
  return rule.defaultDecision === 'block' ? ['confirm', 'block'] : ['allow', 'confirm', 'block']
}

/**
 * Validate one `policy` map from the panel.
 *
 * Unknown rule ids, non-decision values and a `block → allow` jump are rejected
 * here rather than silently coerced by the engine: the panel must never store a
 * setting it cannot honour.
 * @param {unknown} value
 * @returns {Record<string, 'allow'|'confirm'|'block'>}
 */
function normalizePolicyBody(value) {
  if (!isPlainObject(value)) throw new HttpError(400, 'INVALID_POLICY', 'policy must be an object.')
  /** @type {Record<string, 'allow'|'confirm'|'block'>} */
  const policy = {}
  for (const [ruleId, decision] of Object.entries(value)) {
    if (!isKnownRule(ruleId)) {
      throw new HttpError(400, 'INVALID_POLICY', `Unknown high-risk rule "${ruleId}".`)
    }
    if (decision !== 'allow' && decision !== 'confirm' && decision !== 'block') {
      throw new HttpError(400, 'INVALID_POLICY', `policy.${ruleId} must be one of ${DECISION_VALUES.join(', ')}.`)
    }
    if (!allowedDecisions(/** @type {{defaultDecision: string}} */ (ruleOf(ruleId))).includes(decision)) {
      throw new HttpError(
        400,
        'INVALID_POLICY',
        `policy.${ruleId}: a built-in "block" rule can be lowered to "confirm" but not to "allow".`,
      )
    }
    policy[ruleId] = decision
  }
  return policy
}

/**
 * Resolve one built-in rule id or fail with 400.
 * @param {string} ruleId
 * @returns {import('./policy.js').Rule}
 */
function ruleOf(ruleId) {
  const rule = RULES_BY_ID.get(ruleId)
  if (rule === undefined) throw new HttpError(400, 'INVALID_POLICY', `Unknown high-risk rule "${ruleId}".`)
  return rule
}

/**
 * @param {unknown} ruleId
 * @returns {boolean}
 */
function isKnownRule(ruleId) {
  return typeof ruleId === 'string' && RULES_BY_ID.has(ruleId)
}

/**
 * The public catalog the panel renders one row per rule from (§8.4).
 * @returns {Array<Record<string, unknown>>}
 */
export function ruleCatalog() {
  return RULES.map((rule) => ({
    id: rule.id,
    label: rule.label,
    description: rule.description,
    defaultDecision: rule.defaultDecision,
    allowedDecisions: allowedDecisions(rule),
  }))
}

/**
 * Per-rule state of one server (§8.4 "高危策略" table).
 * @param {import('./registry.js').ServerRecord} server
 * @returns {Record<string, {configured: string|null, decision: string|null, disabled: boolean}>}
 */
function policyStateOf(server) {
  /** @type {Record<string, {configured: string|null, decision: string|null, disabled: boolean}>} */
  const state = {}
  for (const rule of RULES) {
    const disabled = server.disabledRules.includes(rule.id)
    const configured = server.policy[rule.id]
    state[rule.id] = {
      configured: configured ?? null,
      decision: disabled ? null : effectiveDecision(rule, server.policy),
      disabled,
    }
  }
  return state
}

/**
 * Public view of one server: everything the panel needs, no secret, and
 * `passwordConfigured` instead of the credential reference (§6.3).
 * @param {import('./registry.js').ServerRecord} server
 * @param {{connected?: boolean, passwordConfigured?: boolean|null}} [extra]
 * @returns {Record<string, unknown>}
 */
export function presentServer(server, extra = {}) {
  return {
    id: server.id,
    name: server.name,
    host: server.host,
    port: server.port,
    username: server.username,
    auth:
      server.auth.kind === 'key'
        ? { kind: 'key', privateKeyPath: server.auth.privateKeyPath }
        : { kind: server.auth.kind },
    hostKeyMode: server.hostKeyMode,
    defaultWorkDir: server.defaultWorkDir,
    policy: server.policy,
    disabledRules: server.disabledRules,
    createdAt: server.createdAt,
    lastConnectedAt: server.lastConnectedAt,
    connected: extra.connected === true,
    passwordConfigured: extra.passwordConfigured ?? null,
    policyState: policyStateOf(server),
  }
}

/**
 * Read the host-key mode of a body, defaulting to the current value.
 * @param {unknown} value
 * @returns {'accept-new'|'verify'|'off'}
 */
function hostKeyModeOf(value) {
  if (value === undefined) return /** @type {any} */ (undefined)
  if (typeof value !== 'string' || !HOST_KEY_MODES.includes(value)) {
    throw new HttpError(400, 'INVALID_SERVER', `hostKeyMode must be one of ${HOST_KEY_MODES.join(', ')}.`)
  }
  return /** @type {'accept-new'|'verify'|'off'} */ (value)
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function workDirOf(value) {
  if (value === undefined || value === null || value === '') return null
  return absolutePath(value, 'defaultWorkDir')
}

/**
 * Map a domain error to an HTTP failure (§5.5 codes stay visible to the panel).
 * @param {unknown} error
 * @returns {HttpError}
 */
export function toHttpError(error) {
  if (error instanceof HttpError) return error
  if (error instanceof RegistryError) {
    const status =
      error.code === 'UNKNOWN_SERVER'
        ? 404
        : error.code === 'DUPLICATE_NAME' || error.code === 'AMBIGUOUS_SERVER'
          ? 409
          : error.code === 'INVALID_REGISTRY'
            ? 500
            : 400
    return new HttpError(status, error.code, error.message)
  }
  if (error instanceof PendingError) {
    const status =
      error.code === 'UNKNOWN_PENDING'
        ? 404
        : error.code === 'EXPIRED_PENDING'
          ? 410
          : error.code === 'PENDING_UNAVAILABLE'
            ? 503
            : error.code === 'APPLY_FAILED'
              ? 502
              : 400
    return new HttpError(status, error.code, error.message)
  }
  if (error instanceof PoolError) {
    const status =
      error.code === 'HOST_KEY_UNKNOWN' || error.code === 'NO_CREDENTIAL'
        ? 409
        : error.code === 'TIMEOUT'
          ? 504
          : error.code === 'INVALID_SERVER'
            ? 400
            : 502
    return new HttpError(status, error.code, error.message, {
      ...(error.host === undefined ? {} : { host: error.host }),
      ...(error.serverId === undefined ? {} : { serverId: error.serverId }),
    })
  }
  if (error instanceof AuditError) return new HttpError(500, error.code, error.message)
  const message = error instanceof Error ? error.message : String(error)
  return new HttpError(500, 'INTERNAL', message)
}

/**
 * Build the route handlers over the plugin's units.
 *
 * Everything is injected, so this module knows nothing about cordis: the tests
 * build the same object with a real `Registry`, `Pool`, `AuditLog` and
 * `PendingQueue` over temporary files (doc §2.2).
 * @param {{
 *   registry: import('./registry.js').Registry,
 *   pool: {connect: Function, exec: Function, disconnect: Function, connectedServerIds: Function},
 *   audit?: import('./audit.js').AuditLog|null,
 *   pending?: import('./pending.js').PendingQueue|null,
 *   getCredentials?: () => ({describe?: Function, set?: Function, unset?: Function}|null|undefined),
 *   config?: Partial<import('./index.js').PluginConfig>,
 *   onChange?: () => (void|Promise<void>)|null,
 *   logger?: {info?: Function, warn?: Function, error?: Function}|null,
 * }} options
 * @returns {{dispatch: (request: {method: string, path: string, query?: Record<string, string>, body?: unknown}) => Promise<{status: number, body: unknown}>, describe: () => ReadonlyArray<{method: string, path: string}>}}
 */
export function createApi(options) {
  if (options?.registry === undefined || options.registry === null) throw new TypeError('createApi requires a registry.')
  if (options?.pool === undefined || options.pool === null) throw new TypeError('createApi requires a pool.')
  const { registry, pool, audit = null, pending = null, logger = null } = options
  const config = options.config ?? {}
  const onChange = typeof options.onChange === 'function' ? options.onChange : null
  const getCredentials = typeof options.getCredentials === 'function' ? options.getCredentials : () => null
  const probeTimeoutMs = Math.min(Number(config.commandTimeoutMs ?? 60000), 15000)

  /**
   * Report one non-fatal failure without changing the request outcome.
   * @param {string} message - printf-style format.
   * @param {...unknown} args
   * @returns {void}
   */
  const warn = (message, ...args) => {
    const method = logger === null ? undefined : logger.warn
    if (typeof method !== 'function') return
    method.call(
      logger,
      message,
      ...args.map((value) => (value instanceof Error ? value.message : String(value))),
    )
  }

  /** Refresh the system-prompt cache after a mutation (§9.4). */
  const notify = async () => {
    if (onChange === null) return
    try {
      await onChange()
    } catch (error) {
      warn('dsh-server-connector: could not refresh the server list after a panel change: %s', error)
    }
  }

  /**
   * Whether a password is stored for this server (`null` = cannot tell).
   * @param {import('./registry.js').ServerRecord} server
   * @returns {Promise<boolean|null>}
   */
  const passwordConfigured = async (server) => {
    if (server.auth.kind !== 'password') return null
    const credentials = getCredentials()
    if (credentials === null || credentials === undefined || typeof credentials.describe !== 'function') return null
    try {
      const info = await credentials.describe(server.auth.credentialRef)
      return info?.configured === true
    } catch (error) {
      warn('dsh-server-connector: could not describe the credential of %s: %s', server.id, error)
      return null
    }
  }

  /** @returns {Set<string>} ids with a live pooled connection */
  const connectedIds = () => {
    try {
      return new Set(/** @type {string[]} */ (pool.connectedServerIds()))
    } catch {
      return new Set()
    }
  }

  /**
   * Load one server or fail with 404.
   * @param {string} id
   * @returns {Promise<import('./registry.js').ServerRecord>}
   */
  const requireServer = async (id) => {
    const server = await registry.get(id)
    if (server === null) {
      throw new HttpError(404, 'UNKNOWN_SERVER', `No server "${id}"; it may have been deleted.`)
    }
    return server
  }

  /**
   * Require the pending queue where an operation needs it.
   * @returns {import('./pending.js').PendingQueue}
   */
  const requirePending = () => {
    if (pending === null) {
      throw new HttpError(503, 'PENDING_UNAVAILABLE', 'This deployment has no pending queue, so dangerous operations are unavailable.')
    }
    return pending
  }

  /**
   * Write a password to the credential service (doc §6.3). The record only ever
   * holds the reference.
   * @param {import('./registry.js').ServerRecord} server
   * @param {unknown} value - the write-only body field; validated here.
   * @returns {Promise<void>}
   */
  const storePassword = async (server, value) => {
    if (server.auth.kind !== 'password') {
      throw new HttpError(400, 'INVALID_SERVER', 'password is only accepted for auth.kind "password".')
    }
    const credentials = getCredentials()
    if (credentials === null || credentials === undefined || typeof credentials.set !== 'function') {
      throw new HttpError(
        503,
        'CREDENTIALS_UNAVAILABLE',
        'This deployment has no credential service, so a password cannot be stored. Use private-key or agent authentication.',
      )
    }
    if (typeof value !== 'string' || value === '') {
      throw new HttpError(400, 'INVALID_SERVER', 'password must be a non-empty string.')
    }
    await credentials.set(server.auth.credentialRef, value)
  }

  /**
   * Validate a key path on this machine (§8.4 "绝对路径、文件存在").
   * @param {string} path
   * @returns {Promise<void>}
   */
  const assertKeyFile = async (path) => {
    try {
      const info = await stat(path)
      if (!info.isFile()) {
        throw new HttpError(400, 'INVALID_SERVER', `auth.privateKeyPath ${path} is not a regular file.`)
      }
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw new HttpError(400, 'INVALID_SERVER', `auth.privateKeyPath ${path} does not exist on this machine.`)
    }
  }

  /**
   * Queue one dangerous operation and report it (§8.3).
   * @param {import('./pending.js').PendingRequestInput} input
   * @returns {Promise<import('./pending.js').PendingRecord>}
   */
  const enqueue = async (input) => {
    const queue = requirePending()
    const { record } = await queue.request(input)
    return record
  }

  // ------------------------------------------------------------- handlers --

  /**
   * GET /servers — every server, the rule catalog, the public config and the
   * pending count, so the panel and the settings page need one round trip.
   * @returns {Promise<{status: number, body: unknown}>}
   */
  const listServers = async () => {
    const servers = await registry.list()
    const connected = connectedIds()
    /** @type {Array<Record<string, unknown>>} */
    const present = []
    for (const server of servers) {
      present.push(
        presentServer(server, { connected: connected.has(server.id), passwordConfigured: await passwordConfigured(server) }),
      )
    }
    /** @type {unknown[]} */
    let queued = []
    if (pending !== null) {
      try {
        queued = await pending.list()
      } catch (error) {
        warn('dsh-server-connector: could not read pending.json: %s', error)
      }
    }
    return {
      status: 200,
      body: {
        servers: present,
        rules: ruleCatalog(),
        config: {
          connectTimeoutMs: config.connectTimeoutMs ?? 15000,
          commandTimeoutMs: config.commandTimeoutMs ?? 60000,
          syncTimeoutMs: config.syncTimeoutMs ?? 20000,
          maxOutputChars: config.maxOutputChars ?? 200000,
          idleTimeoutMs: config.idleTimeoutMs ?? 600000,
          auditEnabled: config.auditEnabled ?? true,
          auditMaxBytes: config.auditMaxBytes ?? 0,
          pendingTtlHours: config.pendingTtlHours ?? 24,
          maxListedServers: config.maxListedServers ?? 8,
        },
        hostKeyModes: [...HOST_KEY_MODES],
        decisions: [...DECISION_VALUES],
        pendingCount: Array.isArray(queued) ? queued.length : 0,
      },
    }
  }

  /**
   * POST /servers — create.
   *
   * `hostKeyMode: "off"` obeys the same two-step rule as an update (§8.4/§8.3):
   * the record is created with `accept-new` and an `disable-hostkey` request is
   * queued, so choosing "off" never takes effect in the same click that creates
   * the server.
   * @param {unknown} body
   * @returns {Promise<{status: number, body: unknown}>}
   */
  const createServer = async (body) => {
    if (!isPlainObject(body)) throw new HttpError(400, 'INVALID_SERVER', 'Request body must be a JSON object.')
    assertKnownBodyFields(body, CREATE_BODY_FIELDS)
    const auth = normalizeAuthBody(body.auth)
    if (auth.kind !== 'password' && body.password !== undefined) {
      throw new HttpError(
        400,
        'INVALID_SERVER',
        'A password is only accepted for auth.kind "password"; the record never stores a plaintext secret.',
      )
    }
    const requestedMode = hostKeyModeOf(body.hostKeyMode) ?? 'accept-new'
    if (auth.kind === 'key') await assertKeyFile(auth.privateKeyPath)
    if (auth.kind === 'password' && body.password === undefined) {
      throw new HttpError(400, 'INVALID_SERVER', 'A password server needs a password on create.')
    }

    /** @type {Record<string, unknown>} */
    const input = {
      name: requiredString(body.name, 'name'),
      host: requiredString(body.host, 'host'),
      username: requiredString(body.username, 'username'),
      auth,
      // §8.3: "off" is never the value a record starts with; it is requested.
      hostKeyMode: requestedMode === 'off' ? 'accept-new' : requestedMode,
      defaultWorkDir: workDirOf(body.defaultWorkDir),
      policy: body.policy === undefined ? {} : normalizePolicyBody(body.policy),
    }
    if (body.port !== undefined) input.port = body.port
    const server = await registry.create(input)
    try {
      if (auth.kind === 'password') await storePassword(server, body.password)
    } catch (error) {
      // The record without its password would be unusable; undo the create.
      await registry.remove(server.id).catch((cleanup) => {
        warn('dsh-server-connector: could not roll back server %s: %s', server.id, cleanup)
      })
      throw error
    }
    /** @type {import('./pending.js').PendingRecord[]} */
    const queued = []
    if (requestedMode === 'off') queued.push(await enqueue({ kind: 'disable-hostkey', serverId: server.id }))
    if (body.disableRules !== undefined) {
      if (!Array.isArray(body.disableRules)) {
        throw new HttpError(400, 'INVALID_POLICY', 'disableRules must be an array of rule ids.')
      }
      for (const ruleId of body.disableRules) {
        if (!isKnownRule(ruleId)) {
          throw new HttpError(400, 'INVALID_POLICY', `Unknown high-risk rule ${JSON.stringify(ruleId)}.`)
        }
        queued.push(await enqueue({ kind: 'disable-rule', serverId: server.id, ruleId }))
      }
    }
    await notify()
    return {
      status: queued.length > 0 ? 202 : 201,
      body: {
        server: presentServer(server, { passwordConfigured: await passwordConfigured(server) }),
        pending: queued,
        applied: queued.length === 0,
        ...(queued.length === 0
          ? {}
          : { note: 'The server was created with host-key verification on; switching it off is queued and needs confirmation.' }),
      },
    }
  }

  /**
   * PUT /servers/:id — update.
   *
   * `hostKeyMode: "off"`, `disableRules` and rule *enabling* have different
   * lifetimes: the first two go to the pending queue (§8.3) and are **not**
   * applied, re-enabling a rule is safe and applies immediately.
   * @param {string} id
   * @param {unknown} body
   * @returns {Promise<{status: number, body: unknown}>}
   */
  const updateServer = async (id, body) => {
    if (!isPlainObject(body)) throw new HttpError(400, 'INVALID_SERVER', 'Request body must be a JSON object.')
    assertKnownBodyFields(body, UPDATE_BODY_FIELDS)
    if (body.disabledRules !== undefined) {
      throw new HttpError(
        400,
        'INVALID_PENDING',
        'disabledRules cannot be written directly; switch a rule off with "disableRules" (pending) or on with "enableRules".',
      )
    }
    const existing = await requireServer(id)
    /** @type {Record<string, unknown>} */
    const patch = {}

    for (const field of ['name', 'host', 'username']) {
      if (body[field] !== undefined) patch[field] = requiredString(body[field], field)
    }
    if (body.port !== undefined) patch.port = body.port
    if (body.defaultWorkDir !== undefined) patch.defaultWorkDir = workDirOf(body.defaultWorkDir)
    if (body.policy !== undefined) patch.policy = normalizePolicyBody(body.policy)

    /** @type {{kind:'key', privateKeyPath:string}|{kind:'password'}|{kind:'agent'}|undefined} */
    let nextAuth
    if (body.auth !== undefined) {
      nextAuth = normalizeAuthBody(body.auth)
      if (nextAuth.kind === 'key') await assertKeyFile(nextAuth.privateKeyPath)
      patch.auth = nextAuth
    } else if (body.password !== undefined) {
      if (existing.auth.kind !== 'password') {
        throw new HttpError(400, 'INVALID_SERVER', 'password is only accepted for auth.kind "password".')
      }
    }

    const requested = hostKeyModeOf(body.hostKeyMode)
    /** @type {import('./pending.js').PendingRecord[]} */
    const queued = []
    /** @type {string} */
    let note = ''
    if (requested !== undefined && requested !== existing.hostKeyMode) {
      if (requested === 'off') {
        // §8.3: the server keeps connecting under its current policy.
        queued.push(await enqueue({ kind: 'disable-hostkey', serverId: existing.id }))
        note = 'hostKeyMode stays unchanged until the request is confirmed'
      } else {
        patch.hostKeyMode = requested
      }
    }

    /** @type {string[]} */
    const enableRules = []
    if (body.enableRules !== undefined) {
      if (!Array.isArray(body.enableRules)) {
        throw new HttpError(400, 'INVALID_POLICY', 'enableRules must be an array of rule ids.')
      }
      for (const ruleId of body.enableRules) {
        if (typeof ruleId !== 'string' || !isKnownRule(ruleId)) {
          throw new HttpError(400, 'INVALID_POLICY', `Unknown high-risk rule ${JSON.stringify(ruleId)}.`)
        }
        if (existing.disabledRules.includes(ruleId)) enableRules.push(ruleId)
      }
    }
    /** @type {string[]} */
    const disableRules = []
    if (body.disableRules !== undefined) {
      if (!Array.isArray(body.disableRules)) {
        throw new HttpError(400, 'INVALID_POLICY', 'disableRules must be an array of rule ids.')
      }
      for (const ruleId of body.disableRules) {
        if (typeof ruleId !== 'string' || !isKnownRule(ruleId)) {
          throw new HttpError(400, 'INVALID_POLICY', `Unknown high-risk rule ${JSON.stringify(ruleId)}.`)
        }
        // A rule the panel already disabled needs no second request; one being
        // re-enabled in this same call would contradict itself.
        if (existing.disabledRules.includes(ruleId) || enableRules.includes(ruleId)) continue
        disableRules.push(ruleId)
      }
    }
    for (const ruleId of disableRules) {
      queued.push(await enqueue({ kind: 'disable-rule', serverId: existing.id, ruleId }))
    }

    if (enableRules.length > 0) {
      patch.disabledRules = existing.disabledRules.filter((ruleId) => !enableRules.includes(ruleId))
    }

    /** @type {import('./registry.js').ServerRecord} */
    let server = existing
    if (Object.keys(patch).length > 0) server = await registry.update(existing.id, patch)

    if (body.password !== undefined) await storePassword(server, body.password)

    if (existing.auth.kind === 'password' && server.auth.kind !== 'password') {
      const credentials = getCredentials()
      if (credentials !== null && credentials !== undefined && typeof credentials.unset === 'function') {
        try {
          await credentials.unset(existing.auth.credentialRef)
        } catch (error) {
          warn('dsh-server-connector: could not remove the credential of %s: %s', existing.id, error)
        }
      }
    }

    await notify()
    const connected = connectedIds()
    return {
      status: queued.length > 0 ? 202 : 200,
      body: {
        server: presentServer(server, {
          connected: connected.has(server.id),
          passwordConfigured: await passwordConfigured(server),
        }),
        pending: queued,
        applied: queued.length === 0,
        ...(note === '' ? {} : { note }),
      },
    }
  }

  /**
   * DELETE /servers/:id — a delete *request* (§8.3). The server stays present
   * and usable; the snapshot keeps the pending row self-describing.
   * @param {string} id
   * @returns {Promise<{status: number, body: unknown}>}
   */
  const requestDelete = async (id) => {
    const server = await requireServer(id)
    const record = await enqueue({ kind: 'delete-server', serverId: server.id, snapshot: server })
    await notify()
    return {
      status: 202,
      body: {
        pending: record,
        server: presentServer(server, { connected: connectedIds().has(server.id) }),
        note: 'The server stays configured until the deletion is confirmed in Settings.',
      },
    }
  }

  /**
   * A connection probe: connect, run the §5.1 platform/shell/sudo probe, report.
   * @param {import('./registry.js').ServerRecord} server
   * @returns {Promise<Record<string, unknown>>}
   */
  const probe = async (server) => {
    const startedAt = Date.now()
    await pool.connect(server)
    const result = await pool.exec(server, { command: CONNECT_PROBE, timeoutMs: probeTimeoutMs })
    return { ...parseProbe(String(result.stdout ?? '')), durationMs: Date.now() - startedAt }
  }

  /**
   * POST /test — test one saved server. This is outside a turn, so no
   * `srv_exec` policy gate applies (doc §8.5).
   * @param {unknown} body
   * @returns {Promise<{status: number, body: unknown}>}
   */
  const testConnection = async (body) => {
    if (!isPlainObject(body)) throw new HttpError(400, 'INVALID_SERVER', 'Request body must be a JSON object.')
    const id = requiredString(body.id, 'id')
    const server = await requireServer(id)
    const outcome = await probe(server)
    try {
      await registry.update(server.id, { lastConnectedAt: new Date().toISOString() })
    } catch (error) {
      warn('dsh-server-connector: could not record lastConnectedAt of %s: %s', server.id, error)
    }
    await notify()
    return { status: 200, body: { ok: true, serverId: server.id, ...outcome } }
  }

  /**
   * POST /connect/:id — open and keep the pooled connection.
   * @param {string} id
   * @returns {Promise<{status: number, body: unknown}>}
   */
  const connectServer = async (id) => {
    const server = await requireServer(id)
    const outcome = await probe(server)
    try {
      await registry.update(server.id, { lastConnectedAt: new Date().toISOString() })
    } catch (error) {
      warn('dsh-server-connector: could not record lastConnectedAt of %s: %s', server.id, error)
    }
    await notify()
    return {
      status: 200,
      body: {
        serverId: server.id,
        connected: true,
        probe: outcome,
        server: presentServer(server, { connected: true, passwordConfigured: await passwordConfigured(server) }),
      },
    }
  }

  /**
   * POST /disconnect/:id
   * @param {string} id
   * @returns {Promise<{status: number, body: unknown}>}
   */
  const disconnectServer = async (id) => {
    const server = await requireServer(id)
    await pool.disconnect(server.id)
    return { status: 200, body: { serverId: server.id, connected: false } }
  }

  /**
   * GET /audit?limit=20[&serverId=…] — the newest records, newest first, so the
   * panel can render the detail page's last-20 list without sorting.
   * @param {Record<string, string>} query
   * @returns {Promise<{status: number, body: unknown}>}
   */
  const listAudit = async (query) => {
    if (audit === null) return { status: 200, body: { records: [] } }
    const rawLimit = query.limit === undefined ? 20 : Number(query.limit)
    if (!Number.isSafeInteger(rawLimit) || rawLimit <= 0) {
      throw new HttpError(400, 'INVALID_ARGUMENT', 'limit must be a positive integer.')
    }
    const limit = Math.min(rawLimit, MAX_AUDIT_LIMIT)
    const serverId = query.serverId
    // Filtering happens here rather than in the log: the tail is bounded and the
    // panel only ever asks for a handful of records.
    const records = await audit.tail(serverId === undefined ? limit : MAX_AUDIT_LIMIT)
    const filtered = serverId === undefined ? records : records.filter((record) => record.serverId === serverId)
    return { status: 200, body: { records: filtered.slice(-limit).reverse() } }
  }

  /**
   * The pending queue, enriched with the server name each row targets. A
   * `delete-server` snapshot is reduced to its display fields: the row's job is
   * to say *what* would be deleted, not to publish the record.
   * @returns {Promise<{status: number, body: unknown}>}
   */
  const listPending = async () => {
    if (pending === null) return { status: 200, body: { pending: [] } }
    const records = await pending.list()
    const servers = await registry.list()
    /** @type {Map<string, import('./registry.js').ServerRecord>} */
    const byId = new Map(servers.map((server) => [server.id, server]))
    return {
      status: 200,
      body: {
        pending: records.map((record) => {
          const live = byId.get(record.serverId)
          const snapshot = isPlainObject(record.snapshot) ? record.snapshot : null
          const name =
            typeof snapshot?.name === 'string'
              ? snapshot.name
              : live === undefined
                ? record.serverId
                : live.name
          /** @type {Record<string, unknown>} */
          const target = { present: live !== undefined }
          if (typeof snapshot?.host === 'string') target.host = snapshot.host
          else if (live !== undefined) target.host = live.host
          if (typeof snapshot?.port === 'number') target.port = snapshot.port
          else if (live !== undefined) target.port = live.port
          if (typeof snapshot?.username === 'string') target.username = snapshot.username
          else if (live !== undefined) target.username = live.username
          return { ...record, serverName: name, target }
        }),
      },
    }
  }

  /**
   * POST /pending/:id/confirm — apply one queued operation (§8.3).
   * @param {string} id
   * @returns {Promise<{status: number, body: unknown}>}
   */
  const confirmPending = async (id) => {
    const queue = requirePending()
    const outcome = await queue.confirm(id)
    await notify()
    return { status: 200, body: { status: outcome.status, record: outcome.record, result: outcome.result } }
  }

  /**
   * POST /pending/:id/cancel — drop the request, leaving the target unchanged.
   * @param {string} id
   * @returns {Promise<{status: number, body: unknown}>}
   */
  const cancelPending = async (id) => {
    const queue = requirePending()
    const outcome = await queue.cancel(id)
    await notify()
    return { status: 200, body: { status: outcome.status, record: outcome.record } }
  }

  /**
   * Run one request.
   * @param {{method: string, path: string, query?: Record<string, string>, body?: unknown}} request
   *   `path` is relative to {@link API_PREFIX} (`/servers/srv-01`).
   * @returns {Promise<{status: number, body: unknown}>}
   */
  const dispatch = async (request) => {
    const method = String(request.method ?? 'GET').toUpperCase()
    const segments = String(request.path ?? '/')
      .split('/')
      .filter((segment) => segment !== '')
    const query = request.query ?? {}

    // A path is matched first, then its method: a known path with an unexpected
    // method is a caller bug (405), a path nothing declares is a missing endpoint
    // (404). Both passes run over the same table, so the surface stays declared
    // in exactly one place.
    /** @type {typeof API_ROUTES[number]|null} */
    let matched = null
    /** @type {Record<string, string>|null} */
    let matchedParams = null
    /** @type {string[]} */
    const methods = []
    for (const route of API_ROUTES) {
      const params = matchRoute(route.path, segments)
      if (params === null) continue
      methods.push(route.method)
      if (route.method !== method || matched !== null) continue
      matched = route
      matchedParams = params
    }
    if (matched === null) {
      if (methods.length === 0) {
        throw new HttpError(404, 'NOT_FOUND', `No route for ${method} ${API_PREFIX}${request.path}.`)
      }
      const allow = methods.join(', ')
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', `${request.path} only supports ${allow}.`, { allow })
    }
    /** @type {Record<string, string>} */
    const params = matchedParams ?? {}
    const id = /** @type {string} */ (params.id)
    switch (matched.op) {
      case 'listServers':
        return listServers()
      case 'createServer':
        return createServer(request.body)
      case 'updateServer':
        return updateServer(id, request.body)
      case 'requestDelete':
        return requestDelete(id)
      case 'testConnection':
        return testConnection(request.body)
      case 'connectServer':
        return connectServer(id)
      case 'disconnectServer':
        return disconnectServer(id)
      case 'listAudit':
        return listAudit(query)
      case 'listPending':
        return listPending()
      case 'confirmPending':
        return confirmPending(id)
      case 'cancelPending':
        return cancelPending(id)
      default:
        throw new HttpError(500, 'INTERNAL', `Unhandled route operation ${String(matched.op)}.`)
    }
  }

  return {
    dispatch,
    describe: () => API_ROUTES.map(({ method, path }) => ({ method, path: `${API_PREFIX}${path}` })),
  }
}

/**
 * Match one route template against decoded path segments.
 * @param {string} template - e.g. `/pending/:id/confirm`
 * @param {string[]} segments - segments relative to the mount path.
 * @returns {Record<string, string>|null} the parameters, or null when it does not match.
 */
function matchRoute(template, segments) {
  const parts = template.split('/').filter((part) => part !== '')
  if (parts.length !== segments.length) return null
  /** @type {Record<string, string>} */
  const params = {}
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]
    const segment = segments[index]
    if (part === undefined || segment === undefined) return null
    if (part.startsWith(':')) {
      if (segment === '') return null
      params[part.slice(1)] = segment
      continue
    }
    if (part !== segment) return null
  }
  return params
}

/**
 * Collect one bounded JSON body.
 *
 * An absent body is `undefined` (the POST endpoints that take no arguments);
 * anything past the ceiling is reported as 413 and the stream is drained so the
 * socket does not stall.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit]
 * @returns {Promise<unknown>}
 */
export async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  /** @type {Buffer[]} */
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += buffer.byteLength
    if (size > limit) {
      req.resume()
      throw new HttpError(413, 'BODY_TOO_LARGE', `The request body exceeds ${String(limit)} bytes.`)
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'The request body is not valid JSON.')
  }
}

/**
 * Send one JSON response. `no-store` because every payload is live state.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 * @returns {void}
 */
function sendJson(res, status, body, headers = {}) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
  res.end(JSON.stringify(body ?? null))
}

/**
 * The node:http adapter: parse, dispatch, serialise.
 *
 * `rejected` is the composition's own request fence (`connection.requestRejection`
 * in the shipped Web app). The routes live on the same trust boundary as the
 * GUI (doc §8.5), so a deployment that has the connection service refuses an
 * unauthenticated or untrusted request here rather than in each handler.
 * @param {ReturnType<typeof createApi>} api
 * @param {{rejected?: (req: import('node:http').IncomingMessage) => number|undefined, logger?: {warn?: Function}|null}} [options]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createHandler(api, options = {}) {
  const rejected = typeof options.rejected === 'function' ? options.rejected : () => undefined
  const logger = options.logger ?? null
  return async (req, res) => {
    const rejection = rejected(req)
    if (rejection !== undefined) {
      res.statusCode = rejection
      res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }
    /** @type {URL} */
    let url
    try {
      url = new URL(String(req.url ?? '/'), 'http://server-connector.invalid')
    } catch {
      sendJson(res, 400, { error: { code: 'INVALID_URL', message: 'The request URL could not be parsed.' } })
      return
    }
    if (url.pathname !== API_PREFIX && !url.pathname.startsWith(`${API_PREFIX}/`)) {
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `No route for ${url.pathname}.` } })
      return
    }
    // Decode each segment: the panel encodes ids, and a route parameter is the
    // decoded id it addresses (`srv-01` today, but the adapter stays generic).
    let relative = url.pathname.slice(API_PREFIX.length)
    if (relative === '') relative = '/'
    try {
      relative = relative
        .split('/')
        .map((segment) => (segment === '' ? segment : decodeURIComponent(segment)))
        .join('/')
    } catch {
      sendJson(res, 400, { error: { code: 'INVALID_URL', message: 'The request path is not valid percent-encoding.' } })
      return
    }
    /** @type {Record<string, string>} */
    const query = {}
    for (const [name, value] of url.searchParams) query[name] = value
    const method = String(req.method ?? 'GET').toUpperCase()
    try {
      const body = method === 'GET' || method === 'HEAD' ? undefined : await readJsonBody(req)
      const outcome = await api.dispatch({
        method,
        path: relative,
        query,
        body,
      })
      sendJson(res, outcome.status, outcome.body)
    } catch (error) {
      const failure = toHttpError(error)
      if (failure.status >= 500 && logger !== null && typeof logger.warn === 'function') {
        logger.warn('dsh-server-connector: %s %s failed: %s', method, relative, failure.message)
      }
      /** @type {Record<string, string>} */
      const headers = {}
      if (typeof failure.details.allow === 'string') headers.allow = failure.details.allow
      sendJson(
        res,
        failure.status,
        {
          error: {
            code: failure.code,
            message: failure.message,
            ...(Object.keys(failure.details).length === 0 ? {} : { details: failure.details }),
          },
        },
        headers,
      )
    }
  }
}

/**
 * Register the routes on the Web carrier (§8.5).
 *
 * One prefix route serves all eleven endpoints: `webServer.register` patterns
 * are exact or prefix-only, and a single prefix keeps method dispatch, 405 and
 * 404 in one place.
 * @param {import('@deepseek-ai/cordis').Context} ctx - context that carries `webServer`.
 * @param {Parameters<typeof createApi>[0]} options
 * @returns {{api: ReturnType<typeof createApi>, dispose: () => void}} the dispatcher and the route disposer.
 */
export function registerRoutes(ctx, options) {
  const api = createApi(options)
  const handler = createHandler(api, {
    // Read the fence per request: the connection service may register after
    // this plugin, and a plugin reload can replace it.
    rejected: (req) => {
      const connection = /** @type {any} */ (ctx.get('connection'))
      if (connection === null || connection === undefined) return undefined
      if (typeof connection.requestRejection !== 'function') return undefined
      return connection.requestRejection(req)
    },
    logger: ctx.logger ?? null,
  })
  const webServer = /** @type {any} */ (ctx).webServer
  const dispose = webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler,
  })
  return { api, dispose }
}
