// dsh-server-connector — SSH connection pool and execution (design doc §7).
//
// One long-lived ssh2 connection per server (§7.2), commands on the same server
// serialised, different servers in parallel. The pool knows nothing about
// policy, tools, credentials storage or the audit log: it turns a server record
// into a connection or a typed error, and an execution request into
// `{ exitCode, stdout, stderr, timedOut, truncated }`.
//
// Design points that are easy to get wrong, and how they are handled here:
//
// - **No PTY** (§7.3): `pty: false` keeps `\r\n` and colour escapes out of the
//   output.
// - **cwd** (§7.3): `cd '<cwd>' && …` is assembled on the remote side; nothing
//   is ever passed through a local shell.
// - **Timeout must kill the remote process group** (§7.3). `stream.signal()`
//   only reaches the channel's own process, so the command runs under a remote
//   watchdog that `kill -KILL`s the child's process group. The watchdog is
//   started with `setsid`, because on a non-interactive SSH channel the remote
//   shell has job control off: a background command then *stays in the shell's
//   own process group*, and `kill -- -$child` would address a pid that is not a
//   process-group leader (it silently fails, leaving the process alive). With
//   `setsid` the child really is its own group leader, so the kill lands.
//   The watchdog subshell's own stdout/stderr are redirected to /dev/null:
//   otherwise its `sleep` inherits the channel's stdout pipe, sshd waits for
//   that pipe to close, and *every* command returns only when its timeout
//   expires (measured: 5000 ms instead of 48 ms with the redirect).
// - **Reconnect once** (§7.2): a connection that fails while idle is rebuilt on
//   the next call; if that also fails, the caller gets `CONNECT_FAILED`.
// - **Host keys** (§7.4): verification is delegated to the `hostVerifier`
//   callback, which consults {@link KnownHosts} through an injected gateway, so
//   this module stays free of file IO and is testable without a file system.
// - **Error normalisation** (§7.5): every transport failure surfaces as a
//   {@link PoolError} with one of the documented codes and an actionable hint.

import { readFile } from 'node:fs/promises'

import ssh2 from 'ssh2'

import { fingerprintHostKey } from './known-hosts.js'

/** The ssh2 client class; pulled off the default export so both ESM and CJS consumers work. */
const { Client } = ssh2

/**
 * The transport-layer error codes of §5.5/§7.5. `EXIT_NONZERO` is listed because
 * the tools layer must return it, but the pool never raises it: a nonzero exit is
 * a *result* (`exitCode`), not a transport failure — srv_exec decides whether the
 * model sees an error. `POLICY_*` and `UNKNOWN_SERVER`/`AMBIGUOUS_SERVER` belong
 * to the policy engine and the registry, not to this module.
 */
export const POOL_ERROR_CODES = Object.freeze([
  'CONNECT_FAILED',
  'HOST_KEY_UNKNOWN',
  'AUTH_FAILED',
  'TIMEOUT',
  'EXIT_NONZERO',
  'NO_CREDENTIAL',
  'CONNECTION_LOST',
  'INVALID_SERVER',
])

/** Default idle timeout of one connection (§7.2, §10). */
export const DEFAULT_IDLE_TIMEOUT_MS = 600000

/** Default timeout of one command (§10). */
export const DEFAULT_COMMAND_TIMEOUT_MS = 60000

/** Default connect timeout (§10). */
export const DEFAULT_CONNECT_TIMEOUT_MS = 15000

/**
 * Appended to a stream that was cut at `maxOutputChars` (§5.4). The boolean
 * `truncated` says *that* output was lost; the marker shows *where*.
 */
export const TRUNCATED_MARKER = '\n…[TRUNCATED]'

/**
 * Machine-readable pool failure. `code` is the stable, documented identifier
 * (§5.5); `message` is written for the model and the panel to act on in one
 * turn, which is why every code carries a next step.
 */
export class PoolError extends Error {
  /**
   * @param {typeof POOL_ERROR_CODES[number]} code
   * @param {string} message
   * @param {{serverId?: string, host?: string, port?: number, username?: string, cause?: unknown, producedOutput?: boolean}} [details]
   */
  constructor(code, message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.name = 'PoolError'
    this.code = code
    this.serverId = details.serverId
    this.host = details.host
    this.port = details.port
    this.username = details.username
    /** Whether a channel had already delivered output when it failed (§7.2 retry safety). */
    this.producedOutput = details.producedOutput
  }
}

/**
 * One command execution request.
 * @typedef {object} ExecRequest
 * @property {string} command - the command line, passed to `sh -c` on the remote side.
 * @property {string|null} [cwd] - working directory; defaults to the server's `defaultWorkDir`.
 * @property {number} [timeoutMs] - wall-clock budget of the whole command.
 * @property {number} [maxOutputChars] - stdout+stderr ceiling; beyond it the result is marked truncated.
 */

/**
 * One command result.
 * @typedef {object} ExecResult
 * @property {string} stdout
 * @property {string} stderr
 * @property {number} exitCode - 0 on success; a negated signal number when the process was killed (137 = SIGKILL).
 * @property {number} durationMs
 * @property {boolean} timedOut - whether the remote watchdog killed the process group.
 * @property {boolean} truncated - whether output crossed `maxOutputChars`.
 * @property {boolean} reconnected - whether the command needed a fresh connection.
 * @property {string|null} timeoutError - `TIMEOUT` when `timedOut` is true, so the
 *   tools layer can return the §5.5 code without re-deriving it from exit 137.
 */

/**
 * Normalise one ssh2/transport error (§7.5). Exported so the tools layer can map
 * errors it catches outside a pool call (e.g. from `ctx.credentials`) the same way.
 * @param {unknown} error
 * @param {{serverId?: string, host?: string, port?: number, username?: string, phase?: 'connect'|'handshake'|'exec'}} [context]
 * @returns {PoolError}
 */
export function normalizeError(error, context = {}) {
  const details = {
    serverId: context.serverId,
    host: context.host,
    port: context.port,
    username: context.username,
    cause: error,
  }
  const where = describeTarget(context)
  const message = error instanceof Error ? error.message : String(error)
  const errno = isPlainObject(error) ? error.code : undefined
  const level = isPlainObject(error) ? error.level : undefined

  // §7.5 row 1: the socket never came up.
  if (errno === 'ECONNREFUSED' || errno === 'EHOSTUNREACH' || errno === 'ENETUNREACH' || errno === 'ENOTFOUND') {
    return new PoolError(
      'CONNECT_FAILED',
      `Cannot reach ${where}: ${message}. Check the host/port and that sshd is running on the target.`,
      details,
    )
  }
  if (errno === 'ETIMEDOUT' || level === 'client-timeout') {
    return new PoolError(
      'CONNECT_FAILED',
      `Connecting to ${where} timed out. Check the host/port, the network path, and that sshd is running on the target.`,
      details,
    )
  }
  // §7.5 rows 3 and 4: hostVerifier refused the key.
  if (error instanceof HostKeyRejectedError) {
    return new PoolError('HOST_KEY_UNKNOWN', error.message, details)
  }
  // §7.5 row 2: SSH asked for credentials and every method was refused.
  if (level === 'client-authentication' || /all configured authentication methods failed/i.test(message)) {
    return new PoolError(
      'AUTH_FAILED',
      `Authentication failed for ${context.username ? `${context.username}@` : ''}${where}: ${message}. ` +
        'Check the username, the private key or stored password.',
      details,
    )
  }
  // A missing/unreadable key file is a local configuration problem, not a
  // network one; surfacing it as AUTH_FAILED keeps one actionable bucket.
  // (`lib/pool.js#authFor` reads the file before dialling, so this also covers
  // an unreadable path reported by ssh2 itself.)
  if (errno === 'ENOENT' && /privateKey|private key|key/i.test(message)) {
    return new PoolError('AUTH_FAILED', `Cannot read the configured private key file: ${message}.`, details)
  }
  if (error instanceof PoolError) return error
  // Anything left over is either a dead socket mid-command or a dial that got
  // further than the errno cases above; the phase decides which bucket it is.
  const code = context.phase === 'exec' ? 'CONNECTION_LOST' : 'CONNECT_FAILED'
  return new PoolError(
    code,
    context.phase === 'exec'
      ? `The SSH connection to ${where} failed while the command was running: ${message}. Retry the command; if it keeps failing, check that sshd is still running.`
      : `SSH connection to ${where} failed: ${message}. Retry; if it persists, check that sshd is running and reachable.`,
    details,
  )
}

/**
 * A host-key rejection raised inside the `hostVerifier` callback. ssh2 only
 * reports the generic "Host denied (verification failed)" handshake error, so
 * the real reason travels on this field and is unwrapped by the connect path.
 */
export class HostKeyRejectedError extends Error {
  /**
   * @param {string} serverId
   * @param {string} message
   */
  constructor(serverId, message) {
    super(message)
    this.name = 'HostKeyRejectedError'
    this.serverId = serverId
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {{host?: string, port?: number, serverId?: string}} context
 * @returns {string}
 */
function describeTarget(context) {
  if (context.host === undefined) return context.serverId === undefined ? 'the server' : `server ${context.serverId}`
  const port = context.port === undefined ? '' : `:${context.port}`
  return `${context.host}${port}`
}

/**
 * The remote watchdog of §7.3, extended by the two corrections this module
 * documents at the top of the file: `setsid` so the child leads its own process
 * group, and stdout/stderr redirection on the watcher so it cannot hold the
 * channel open.
 *
 * Layout, with `command` substituted through {@link shellQuote}:
 *
 *   setsid sh -c '<command>' & child=$!
 *   ( sleep <seconds>; kill -KILL -$child 2>/dev/null ) >/dev/null 2>&1 & watchdog=$!
 *   wait $child; rc=$?
 *   kill $watchdog 2>/dev/null
 *   exit $rc
 *
 * The script also omits the spec's `exec 2>&1`, which folds stderr into stdout:
 * §5.4 returns them as two distinct fields, so the command runs under a single
 * `sh -c` and its two streams stay separate all the way to the channel.
 * @param {string} command
 * @param {number} timeoutMs
 * @returns {string}
 */
export function buildWatchdogScript(command, timeoutMs) {
  // Sub-second budgets are honoured with a fractional `sleep`, which both GNU
  // coreutils and busybox accept; rounding up to whole seconds would let a
  // 1.5 s budget run to 2 s.
  const seconds = Math.max(0.1, timeoutMs / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
  return [
    'setsid sh -c ' + shellQuote(command) + ' & child=$!',
    '( sleep ' + seconds + '; kill -KILL -$child 2>/dev/null ) >/dev/null 2>&1 & watchdog=$!',
    'wait $child; rc=$?',
    'kill $watchdog 2>/dev/null',
    'exit $rc',
  ].join('\n')
}

/**
 * The full remote script: the watchdog, optionally wrapped in `cd '<cwd>' && …`
 * (§7.3). A failed `cd` therefore fails the command with the shell's own
 * message, which is what the caller wants to read.
 * @param {string} command
 * @param {number} timeoutMs
 * @param {string|null} cwd
 * @returns {string}
 */
export function buildRemoteScript(command, timeoutMs, cwd) {
  const body = buildWatchdogScript(command, timeoutMs)
  return cwd === null || cwd === undefined || cwd === '' ? body : 'cd ' + shellQuote(cwd) + ' && {\n' + body + '\n}'
}

/**
 * Quote one string for a POSIX shell, single-quote style: everything inside
 * `'…'` is literal, and an embedded quote becomes `'\''`. This is the only
 * transformation the pool applies to caller text, and it happens for the remote
 * shell only — never for a local one (§7.1's whole point).
 * @param {string} value
 * @returns {string}
 */
export function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

/**
 * The `hostVerifier` decision of §7.4, factored out so both the client wiring
 * and the unit tests run the same code. The two outcomes are a discriminated
 * union, so an accepted key cannot be passed where a refusal reason is needed.
 * @param {{mode: 'accept-new'|'verify'|'off', known: {hash: string}|null}} state
 * @param {string} keyHash
 * @returns {{accept: true, store: boolean, reason: 'accept-new'|'match'|'disabled'} | {accept: false, store: false, reason: 'changed'|'unknown'}}
 */
export function decideHostKey(state, keyHash) {
  if (state.mode === 'off') return { accept: true, store: false, reason: 'disabled' }
  if (state.known === null || state.known === undefined) {
    if (state.mode === 'accept-new') return { accept: true, store: true, reason: 'accept-new' }
    return { accept: false, store: false, reason: 'unknown' }
  }
  return state.known.hash === keyHash
    ? { accept: true, store: false, reason: 'match' }
    : { accept: false, store: false, reason: 'changed' }
}

/**
 * The pool. One instance per plugin process; `dispose()` closes every
 * connection (the plugin's cordis dispose hook calls it).
 */
export class Pool {
  /** @type {number} */
  #idleTimeoutMs
  /** @type {number} */
  #connectTimeoutMs
  /** @type {number} */
  #commandTimeoutMs
  /** @type {number} */
  #maxOutputChars
  /** @type {number} */
  #keepaliveIntervalMs
  /** @type {import('./known-hosts.js').KnownHosts} */
  #knownHosts
  /** @type {(server: any) => Promise<string|null>} */
  #resolvePassword
  /** @type {{info:Function, warn:Function, error:Function}|null} */
  #logger
  /**
   * Live state per server id. `queue` is the serial tail of §7.2; `connection`
   * is `null` while no socket is open.
   * @type {Map<string, {connection: any, queue: Promise<void>, lastUsed: number, idleTimer: NodeJS.Timeout|null}>}
   */
  #servers = new Map()
  /** @type {boolean} */
  #disposed = false

  /**
   * @param {{
   *   knownHosts?: import('./known-hosts.js').KnownHosts,
   *   idleTimeoutMs?: number,
   *   connectTimeoutMs?: number,
   *   commandTimeoutMs?: number,
   *   maxOutputChars?: number,
   *   keepaliveIntervalMs?: number,
   *   resolvePassword?: (server: any) => Promise<string|null>,
   *   logger?: {info:Function, warn:Function, error:Function} | null,
   * }} [options]
   */
  constructor(options = {}) {
    if (options.knownHosts === undefined) {
      throw new TypeError('Pool requires a knownHosts store (see lib/known-hosts.js).')
    }
    this.#knownHosts = options.knownHosts
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.#connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.#commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
    this.#maxOutputChars = options.maxOutputChars ?? 200000
    // Slightly under a minute: a NAT/firewall idle drop is detected by ssh2
    // before the pool hands the next command a dead socket.
    this.#keepaliveIntervalMs = options.keepaliveIntervalMs ?? 30000
    this.#resolvePassword = options.resolvePassword ?? (async () => null)
    this.#logger = options.logger ?? null
  }

  /** Effective idle timeout of this pool. */
  get idleTimeoutMs() {
    return this.#idleTimeoutMs
  }

  /**
   * Whether a live connection exists for one server, for the panel's green/grey
   * dot (doc §8.2). Never opens a connection.
   * @param {string} serverId
   * @returns {boolean}
   */
  isConnected(serverId) {
    const entry = this.#servers.get(serverId)
    return entry !== undefined && entry.connection !== null && entry.connection.alive === true
  }

  /**
   * Server ids with a live connection (doc §8.2).
   * @returns {string[]}
   */
  connectedServerIds() {
    /** @type {string[]} */
    const ids = []
    for (const [serverId, entry] of this.#servers) {
      if (entry.connection !== null && entry.connection.alive === true) ids.push(serverId)
    }
    return ids.sort()
  }

  /**
   * Ensure a reusable connection for one server and return it (§7.2). Two
   * concurrent calls share one dial, so the "one long connection per server"
   * rule survives a burst.
   * @param {import('./registry.js').ServerRecord} server
   * @returns {Promise<{connection: any, reconnected: boolean}>}
   */
  async connect(server) {
    this.#assertUsable()
    const id = requireServer(server).id
    const entry = this.#entry(id)
    const live = entry.connection
    const reused = live !== null && live.alive === true
    const connection = await this.#ensureConnection(server, entry)
    this.#touch(entry)
    // "Reconnected" describes this call: a live socket was reused, or a new one
    // had to be built because the previous one was gone.
    return { connection, reconnected: !reused }
  }

  /**
   * Run one command on one server (§7.2, §7.3).
   *
   * Commands for the same server are serialised through the entry's promise
   * queue; different servers run concurrently because each has its own socket
   * and channel. A connection that turns out to be dead is rebuilt once, and
   * the command is replayed on the new connection exactly once (§7.2).
   * @param {import('./registry.js').ServerRecord} server
   * @param {ExecRequest} request
   * @returns {Promise<ExecResult>}
   */
  async exec(server, request) {
    this.#assertUsable()
    const record = requireServer(server)
    const command = normalizeCommand(request)
    const timeoutMs = normalizePositive(request.timeoutMs, this.#commandTimeoutMs)
    const maxOutputChars = normalizePositive(request.maxOutputChars, this.#maxOutputChars)
    const cwd = normalizeCwd(request.cwd, record)
    const entry = this.#entry(record.id)
    // A queued command must not race the idle timer armed by the previous one:
    // otherwise a command that outlives idleTimeoutMs has its own socket closed
    // and its serial queue reset under it.
    this.#clearIdle(entry)

    return this.#enqueue(entry, async () => {
      const script = buildRemoteScript(command, timeoutMs, cwd)
      let reconnected = false
      let connection = await this.#ensureConnection(record, entry)
      let outcome
      try {
        outcome = await this.#run(connection, script, timeoutMs, maxOutputChars)
      } catch (error) {
        if (!(error instanceof PoolError) || error.code !== 'CONNECTION_LOST') throw error
        // §7.2 allows exactly one automatic retry. It is only safe when the
        // command cannot have run: a channel that already delivered output may
        // have changed the server, and replaying it would repeat those side
        // effects. In that case the caller gets CONNECTION_LOST instead.
        if (error.producedOutput === true) throw error
        reconnected = true
        this.#discard(record.id, entry)
        connection = await this.#ensureConnection(record, entry)
        outcome = await this.#run(connection, script, timeoutMs, maxOutputChars)
      }
      this.#touch(entry)
      return {
        ...outcome,
        durationMs: Math.max(0, Math.round(outcome.endedAt - outcome.startedAt)),
        reconnected,
        timeoutError: outcome.timedOut ? 'TIMEOUT' : null,
      }
    })
  }

  /**
   * Run one command and stream its output while it runs (doc §5.4 async jobs).
   *
   * Same transport, watchdog, timeout and error normalisation as {@link exec};
   * the difference is what the caller gets: `onChunk` is called for every
   * stdout/stderr chunk as it arrives, and `onCancel` receives a function that
   * closes the channel (which the remote kernel turns into SIGHUP for the
   * process group, on top of the watchdog's SIGKILL at the budget).
   *
   * No replay: a streaming caller may already have handed bytes to its
   * consumer, so a connection lost mid-command is reported as
   * `CONNECTION_LOST` instead of being retried (§7.2's one-retry rule only
   * holds for a call that produced nothing).
   * @param {import('./registry.js').ServerRecord} server
   * @param {ExecRequest & {
   *   onChunk?: (channel: 'stdout'|'stderr', text: string) => void,
   *   onCancel?: (cancel: () => void) => void,
   * }} request
   * @param {AbortSignal} [signal] - caller cancellation (the tool call's signal).
   * @returns {Promise<ExecResult & {cancelled: boolean}>}
   */
  async execStream(server, request, signal) {
    this.#assertUsable()
    const record = requireServer(server)
    const command = normalizeCommand(request)
    const timeoutMs = normalizePositive(request.timeoutMs, this.#commandTimeoutMs)
    const maxOutputChars = normalizePositive(request.maxOutputChars, this.#maxOutputChars)
    const cwd = normalizeCwd(request.cwd, record)
    const entry = this.#entry(record.id)
    const onChunk = typeof request.onChunk === 'function' ? request.onChunk : () => {}
    const onCancel = typeof request.onCancel === 'function' ? request.onCancel : () => {}
    this.#clearIdle(entry)

    return this.#enqueue(entry, async () => {
      const script = buildRemoteScript(command, timeoutMs, cwd)
      const connection = await this.#ensureConnection(record, entry)
      const outcome = await this.#runStream(connection, script, timeoutMs, maxOutputChars, onChunk, onCancel, signal)
      this.#touch(entry)
      return {
        ...outcome,
        durationMs: Math.max(0, Math.round(outcome.endedAt - outcome.startedAt)),
        reconnected: false,
        timeoutError: outcome.timedOut ? 'TIMEOUT' : null,
      }
    })
  }

  /**
   * Close one server's connection and forget its queue (§8.3: deleting a server
   * disconnects the pool). A running command finishes first.
   * @param {string} serverId
   * @returns {Promise<void>}
   */
  async disconnect(serverId) {
    const entry = this.#servers.get(serverId)
    if (entry === undefined) return
    // Stop accepting new work for this server, then let whatever is already
    // running finish before the socket goes away.
    this.#servers.delete(serverId)
    this.#clearIdle(entry)
    await entry.queue.catch(() => {})
    const connection = entry.connection
    entry.connection = null
    if (connection !== null && connection.ready === 'ready') await closeConnection(connection).catch(() => {})
  }

  /**
   * Close every connection. Idempotent; later calls to exec()/connect() report
   * `CONNECTION_LOST` rather than dialling a disposed pool.
   * @returns {Promise<void>}
   */
  async dispose() {
    if (this.#disposed) return
    this.#disposed = true
    /** @type {Promise<void>[]} */
    const closing = []
    for (const [serverId, entry] of this.#servers) {
      this.#clearIdle(entry)
      const connection = entry.connection
      entry.connection = null
      if (connection !== null && connection.ready === 'ready') {
        closing.push(closeConnection(connection).catch(() => {}))
      }
      this.#servers.delete(serverId)
    }
    await Promise.all(closing)
  }

  /**
   * @param {import('./registry.js').ServerRecord} server
   * @param {{connection: any, queue: Promise<void>, lastUsed: number, idleTimer: NodeJS.Timeout|null}} entry
   * @returns {Promise<any>}
   */
  #dial(server, entry) {
    const id = server.id
    // A dial that is already in flight is shared instead of duplicated: two
    // concurrent callers await this same promise, so neither can leave it
    // rejected-but-unobserved.
    if (entry.connection !== null && entry.connection.ready === 'pending') {
      return entry.connection.promise
    }
    this.#clearIdle(entry)
    /** @type {Promise<any>} */
    const promise = this.#openConnection(server).then(
      (connection) => {
        entry.connection = connection
        return connection
      },
      (error) => {
        entry.connection = null
        const normalized =
          error instanceof PoolError
            ? error
            : normalizeError(error, {
                serverId: id,
                host: server.host,
                port: server.port,
                username: server.username,
                phase: 'connect',
              })
        this.#log('warn', 'dsh-server-connector: ssh connect to %s failed: %s', id, normalized.message)
        throw normalized
      },
    )
    /** @type {{ready: 'pending', promise: Promise<any>, alive: boolean, reconnected: boolean}} */
    entry.connection = { ready: 'pending', promise, alive: false, reconnected: false }
    return promise
  }

  /**
   * Open one ssh2 client, apply the §7.4 host-key decision, and resolve once the
   * handshake and authentication completed.
   * @param {import('./registry.js').ServerRecord} server
   * @returns {Promise<any>}
   */
  async #openConnection(server) {
    const auth = await this.#authFor(server)
    const known = await this.#knownHosts.get(server.id)
    /** @type {HostKeyRejectedError|null} */
    let rejection = null

    const client = new Client()
    /** @type {{value: {hash: string, algorithm: string}|null}} */
    const accepted = { value: null }
    // One listener for the whole life of the client, installed *before*
    // connect(): ssh2 emits 'error' both while the handshake is running and
    // long after `ready`. An EventEmitter 'error' with no listener throws, so a
    // socket that dies during a later command must always have somewhere to go.
    /** @type {{settled: boolean, resolve: (value: any) => void, reject: (reason: unknown) => void}} */
    const handshake = { settled: false, resolve: () => {}, reject: () => {} }
    /** @type {Promise<any>} */
    const ready = new Promise((resolve, reject) => {
      handshake.resolve = resolve
      handshake.reject = reject
    })
    /** @param {Error & {level?: string, code?: string}} error */
    const onClientError = (error) => {
      if (!handshake.settled) {
        handshake.settled = true
        handshake.reject(
          rejection ??
            normalizeError(error, {
              serverId: server.id,
              host: server.host,
              port: server.port,
              username: server.username,
              phase: 'connect',
            }),
        )
        return
      }
      this.#log('warn', 'dsh-server-connector: ssh connection to %s dropped: %s', server.id, error.message)
    }
    client.on('error', onClientError)
    client.on('close', () => {
      if (handshake.settled) return
      handshake.settled = true
      handshake.reject(
        normalizeError(new Error('the connection closed before the SSH handshake finished'), {
          serverId: server.id,
          host: server.host,
          port: server.port,
          username: server.username,
          phase: 'connect',
        }),
      )
    })
    client.once('ready', () => {
      if (handshake.settled) return
      handshake.settled = true
      handshake.resolve(client)
    })

    const options = {
      host: server.host,
      port: server.port,
      username: server.username,
      readyTimeout: this.#connectTimeoutMs,
      keepaliveInterval: this.#keepaliveIntervalMs,
      keepaliveCountMax: 3,
      // §7.4: the callback decides; the store only persists the outcome.
      /** @type {(keyBlob: Buffer|string, callback: (accept: boolean) => void) => void} */
      hostVerifier: (keyBlob, callback) => {
        const fingerprint =
          typeof keyBlob === 'string'
            ? { hash: keyBlob, algorithm: 'unknown' }
            : fingerprintOrNull(keyBlob)
        if (fingerprint === null) {
          rejection = new HostKeyRejectedError(
            server.id,
            `The host key of ${server.host}:${server.port} could not be read; refusing to connect.`,
          )
          callback(false)
          return
        }
        const decision = decideHostKey({ mode: server.hostKeyMode, known }, fingerprint.hash)
        if (!decision.accept) {
          rejection = hostKeyMessage(server, decision.reason)
          callback(false)
          return
        }
        if (decision.store) accepted.value = fingerprint
        callback(true)
      },
      ...auth,
    }

    try {
      client.connect(options)
      await ready
    } catch (error) {
      safeDestroy(client)
      if (accepted.value !== null) {
        // Record first, then report: a fingerprint accepted for an
        // `accept-new` host must survive the failure of a later auth attempt,
        // otherwise the next call would silently re-trust whatever answers.
        await this.#knownHosts
          .set(server.id, { hash: accepted.value.hash, algorithm: accepted.value.algorithm })
          .catch((storeError) => {
            this.#log('warn', 'dsh-server-connector: cannot store host key for %s: %s', server.id, String(storeError))
          })
      }
      throw error
    }

    if (accepted.value !== null) {
      await this.#knownHosts.set(server.id, { hash: accepted.value.hash, algorithm: accepted.value.algorithm })
    }

    const connection = { client, alive: true, ready: 'ready', openedAt: Date.now(), reconnected: false }
    // The single 'error' listener installed above already logs a post-handshake
    // drop; this only flips the liveness flag the pool checks before reuse.
    client.on('error', () => {
      connection.alive = false
    })
    client.on('close', () => {
      connection.alive = false
    })
    return connection
  }

  /**
   * Resolve the `ssh2` authentication fields for one server (§6.3). Password
   * authentication goes through the injected resolver, so this module never
   * reads `ctx.credentials` itself.
   * @param {import('./registry.js').ServerRecord} server
   * @returns {Promise<Record<string, unknown>>}
   */
  async #authFor(server) {
    const auth = server.auth
    if (auth.kind === 'agent') return {}
    if (auth.kind === 'key') {
      /** @type {Buffer} */
      let privateKey
      try {
        privateKey = await readFile(auth.privateKeyPath)
      } catch (error) {
        throw normalizeError(error, {
          serverId: server.id,
          host: server.host,
          port: server.port,
          username: server.username,
        })
      }
      return { privateKey }
    }
    if (auth.kind === 'password') {
      const password = await this.#resolvePassword(server)
      if (password === null || password === undefined || password === '') {
        throw new PoolError(
          'NO_CREDENTIAL',
          `No password is stored for server ${server.id} (credentialRef ${auth.credentialRef}). ` +
            'Set it in the server panel, or switch the server to key authentication.',
          { serverId: server.id, host: server.host, port: server.port, username: server.username },
        )
      }
      return { password }
    }
    throw new PoolError('INVALID_SERVER', `Server ${server.id} has an unsupported auth configuration.`, {
      serverId: server.id,
      host: server.host,
      port: server.port,
      username: server.username,
    })
  }

  /**
   * Run one already-assembled script over one connection.
   * @param {any} connection
   * @param {string} script
   * @param {number} timeoutMs
   * @param {number} maxOutputChars
   * @returns {Promise<{stdout: string, stderr: string, exitCode: number, timedOut: boolean, truncated: boolean, startedAt: number, endedAt: number}>}
   */
  async #run(connection, script, timeoutMs, maxOutputChars) {
    if (connection.alive === false) {
      throw new PoolError('CONNECTION_LOST', 'The SSH connection is no longer alive.', {})
    }
    const startedAt = Date.now()
    return new Promise((resolve, reject) => {
      let settled = false
      /** @type {NodeJS.Timeout|null} */
      let killTimer = null
      const finish = (/** @type {any} */ value, /** @type {unknown} */ error) => {
        if (settled) return
        settled = true
        if (killTimer !== null) clearTimeout(killTimer)
        if (error !== undefined) reject(error)
        else resolve(value)
      }

      let producedOutput = false
      /** @param {Error & {level?: string, code?: string}} error */
      const onExecError = (error) => {
        connection.alive = false
        const normalized = normalizeError(error, { phase: 'exec' })
        // Attach, rather than rebuild: the code and message stay the ones the
        // caller expects, and exec() reads this flag to decide on a replay.
        if (normalized instanceof PoolError) normalized.producedOutput = producedOutput
        finish(undefined, normalized)
      }

      /** @type {any} */
      let channel = null
      try {
        connection.client.exec(script, { pty: false }, (/** @type {any} */ error, /** @type {any} */ stream) => {
          if (error) {
            onExecError(error)
            return
          }
          channel = stream
          stream.on('data', () => {
            producedOutput = true
          })
          stream.stderr.on('data', () => {
            producedOutput = true
          })
          this.#consumeChannel(
            stream,
            maxOutputChars,
            (result) => {
              finish(
                {
                  stdout: result.stdout,
                  stderr: result.stderr,
                  exitCode: result.exitCode,
                  timedOut: result.timedOut,
                  truncated: result.truncated,
                  startedAt,
                  endedAt: Date.now(),
                },
                undefined,
              )
            },
            (deadError) => {
              onExecError(deadError)
            },
          )
        })
      } catch (error) {
        // `client.exec` throws synchronously when the socket is already gone.
        onExecError(/** @type {Error} */ (error))
        return
      }

      // The remote watchdog is the primary timeout; this is the safety net for
      // a channel that never reports back (say, a hung sshd). It closes the
      // channel, which the remote kernel turns into a SIGHUP for the command.
      killTimer = setTimeout(() => {
        if (settled || channel === null) return
        try {
          channel.signal('KILL')
        } catch {
          // The channel may already be closed; closing it below is harmless.
        }
        try {
          channel.close()
        } catch {
          // Same: a closed channel needs no second close.
        }
        finish(
          undefined,
          new PoolError(
            'TIMEOUT',
            `Command did not return within ${timeoutMs} ms and the SSH channel was closed. The remote watchdog kills the process group at the same budget; check the server if the process is still running.`,
            {},
          ),
        )
      }, timeoutMs + 5000)
      killTimer.unref?.()
    })
  }

  /**
   * The streaming twin of {@link #run}: same watchdog, same ceiling, but every
   * chunk is forwarded to `onChunk` as it arrives, and the caller can cancel
   * through the returned `onCancel` handle or its abort signal.
   * @param {any} connection
   * @param {string} script
   * @param {number} timeoutMs
   * @param {number} maxOutputChars
   * @param {(channel: 'stdout'|'stderr', text: string) => void} onChunk
   * @param {(cancel: () => void) => void} onCancel
   * @param {AbortSignal} [signal]
   * @returns {Promise<{stdout: string, stderr: string, exitCode: number, timedOut: boolean, truncated: boolean, cancelled: boolean, startedAt: number, endedAt: number}>}
   */
  async #runStream(connection, script, timeoutMs, maxOutputChars, onChunk, onCancel, signal) {
    if (connection.alive === false) {
      throw new PoolError('CONNECTION_LOST', 'The SSH connection is no longer alive.', {})
    }
    const startedAt = Date.now()
    return new Promise((resolve, reject) => {
      let settled = false
      let cancelled = false
      /** @type {NodeJS.Timeout|null} */
      let killTimer = null
      /** @type {any} */
      let channel = null
      /** @type {(() => void)|null} */
      let detachAbort = null

      const finish = (/** @type {any} */ value, /** @type {unknown} */ error) => {
        if (settled) return
        settled = true
        if (killTimer !== null) clearTimeout(killTimer)
        if (detachAbort !== null) detachAbort()
        if (error !== undefined) reject(error)
        else resolve(value)
      }

      /**
       * Abort the remote command: close the channel, which delivers SIGHUP to
       * the command's process group; the watchdog's SIGKILL at the budget
       * remains the fallback for a process that outlives the hangup.
       */
      const abortChannel = () => {
        if (channel === null) return
        try {
          channel.signal('KILL')
        } catch {
          // The channel may already be closed.
        }
        try {
          channel.close()
        } catch {
          // Same.
        }
      }

      /** @param {Error & {level?: string, code?: string}} error */
      const onExecError = (error) => {
        connection.alive = false
        finish(undefined, normalizeError(error, { phase: 'exec' }))
      }

      onCancel(() => {
        if (settled) return
        cancelled = true
        abortChannel()
        finish(
          {
            stdout: '',
            stderr: '',
            exitCode: null,
            timedOut: false,
            truncated: false,
            cancelled: true,
            startedAt,
            endedAt: Date.now(),
          },
          undefined,
        )
      })

      try {
        connection.client.exec(script, { pty: false }, (/** @type {any} */ error, /** @type {any} */ stream) => {
          if (error) {
            onExecError(error)
            return
          }
          channel = stream
          this.#consumeStreamChannel(
            stream,
            maxOutputChars,
            onChunk,
            (result) => {
              finish({ ...result, cancelled, startedAt, endedAt: Date.now() }, undefined)
            },
            onExecError,
          )
        })
      } catch (error) {
        onExecError(/** @type {Error} */ (error))
        return
      }

      if (signal !== undefined) {
        const onAbort = () => {
          cancelled = true
          abortChannel()
          finish(
            {
              stdout: '',
              stderr: '',
              exitCode: null,
              timedOut: false,
              truncated: false,
              cancelled: true,
              startedAt,
              endedAt: Date.now(),
            },
            undefined,
          )
        }
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
        detachAbort = () => signal.removeEventListener('abort', onAbort)
      }

      killTimer = setTimeout(() => {
        if (settled) return
        abortChannel()
        finish(
          undefined,
          new PoolError(
            'TIMEOUT',
            `Command did not return within ${timeoutMs} ms and the SSH channel was closed. The remote watchdog kills the process group at the same budget; check the server if the process is still running.`,
            {},
          ),
        )
      }, timeoutMs + 5000)
      killTimer.unref?.()
    })
  }

  /**
   * Read one channel to completion while forwarding each chunk. The same
   * `maxOutputChars` ceiling bounds the assembled result; a streaming consumer
   * (a job ring) applies its own retention.
   * @param {any} stream
   * @param {number} maxOutputChars
   * @param {(channel: 'stdout'|'stderr', text: string) => void} onChunk
   * @param {(result: {stdout: string, stderr: string, exitCode: number, timedOut: boolean, truncated: boolean}) => void} done
   * @param {(error: Error) => void} failed
   * @returns {void}
   */
  #consumeStreamChannel(stream, maxOutputChars, onChunk, done, failed) {
    let size = 0
    let truncated = false
    let closed = false
    let stdout = ''
    let stderr = ''
    /** @type {{stdout: boolean, stderr: boolean}} */
    const cut = { stdout: false, stderr: false }

    const forward = (/** @type {'stdout'|'stderr'} */ channel, /** @type {unknown} */ chunk) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(/** @type {Buffer} */ (chunk)).toString('utf8')
      if (size >= maxOutputChars) {
        cut[channel] = true
        truncated = true
        return
      }
      const remaining = maxOutputChars - size
      const kept = text.length > remaining ? text.slice(0, remaining) : text
      size += kept.length
      if (kept.length < text.length) {
        cut[channel] = true
        truncated = true
      }
      if (kept === '') return
      if (channel === 'stdout') stdout += kept
      else stderr += kept
      onChunk(channel, kept)
    }

    stream.on('data', (/** @type {unknown} */ chunk) => forward('stdout', chunk))
    stream.stderr.on('data', (/** @type {unknown} */ chunk) => forward('stderr', chunk))

    let exitSignal = /** @type {string|null} */ (null)
    stream.on('exit', (/** @type {number|null} */ code, /** @type {string|null} */ signal) => {
      exitSignal = signal
      stream.exitCode = code
    })
    stream.on('close', (/** @type {number|null} */ code, /** @type {string|null} */ signal) => {
      if (closed) return
      closed = true
      const finalSignal = signal ?? exitSignal
      const exitCode = typeof code === 'number' ? code : signalExitCode(finalSignal)
      done({
        stdout: stdout + (cut.stdout ? TRUNCATED_MARKER : ''),
        stderr: stderr + (cut.stderr ? TRUNCATED_MARKER : ''),
        exitCode,
        timedOut: finalSignal === 'SIGKILL' || exitCode === 137,
        truncated,
      })
    })
    stream.on('error', (/** @type {Error} */ error) => {
      if (closed) return
      closed = true
      failed(error)
    })
  }

  /**
   * Read one channel to completion. Output beyond `maxOutputChars` is dropped
   * (and flagged) instead of growing without bound.
   * @param {any} stream
   * @param {number} maxOutputChars
   * @param {(result: {stdout: string, stderr: string, exitCode: number, timedOut: boolean, truncated: boolean}) => void} done
   * @param {(error: Error) => void} failed
   * @returns {void}
   */
  #consumeChannel(stream, maxOutputChars, done, failed) {
    /** @type {string[]} */
    const stdoutParts = []
    /** @type {string[]} */
    const stderrParts = []
    let size = 0
    let truncated = false
    let closed = false

    // The cut is tracked per stream so the marker lands in the stream that was
    // actually truncated (and only there).
    /** @type {{stdout: boolean, stderr: boolean}} */
    const cut = { stdout: false, stderr: false }
    const append = (
      /** @type {string[]} */ parts,
      /** @type {unknown} */ chunk,
      /** @type {'stdout'|'stderr'} */ streamName,
    ) => {
      if (size >= maxOutputChars) {
        cut[streamName] = true
        truncated = true
        return
      }
      const remaining = maxOutputChars - size
      const text = typeof chunk === 'string' ? chunk : Buffer.from(/** @type {Buffer} */ (chunk)).toString('utf8')
      if (text.length > remaining) {
        parts.push(text.slice(0, remaining))
        size = maxOutputChars
        cut[streamName] = true
        truncated = true
        return
      }
      parts.push(text)
      size += text.length
    }

    stream.on('data', (/** @type {unknown} */ chunk) => append(stdoutParts, chunk, 'stdout'))
    stream.stderr.on('data', (/** @type {unknown} */ chunk) => append(stderrParts, chunk, 'stderr'))

    let exitSignal = /** @type {string|null} */ (null)
    stream.on('exit', (/** @type {number|null} */ code, /** @type {string|null} */ signal) => {
      exitSignal = signal
      stream.exitCode = code
    })
    stream.on('close', (/** @type {number|null} */ code, /** @type {string|null} */ signal) => {
      if (closed) return
      closed = true
      const finalSignal = signal ?? exitSignal
      const exitCode = typeof code === 'number' ? code : signalExitCode(finalSignal)
      // The watchdog KILLs the process group, so a timed-out command reports
      // 137 (128 + SIGKILL) on the channel. Any non-zero code when the process
      // was signalled is treated as a timeout only when the signal is SIGKILL;
      // a `kill -9` from inside the command is indistinguishable, which is
      // acceptable: both mean "the command did not finish on its own".
      done({
        stdout: stdoutParts.join('') + (cut.stdout ? TRUNCATED_MARKER : ''),
        stderr: stderrParts.join('') + (cut.stderr ? TRUNCATED_MARKER : ''),
        exitCode,
        timedOut: finalSignal === 'SIGKILL' || exitCode === 137,
        truncated,
      })
    })
    stream.on('error', (/** @type {Error} */ error) => {
      if (closed) return
      closed = true
      failed(error)
    })
  }

  /**
   * Record a used connection and arm its idle timer (§7.2).
   * @param {{connection: any, queue: Promise<void>, lastUsed: number, idleTimer: NodeJS.Timeout|null}} entry
   * @returns {void}
   */
  #touch(entry) {
    this.#clearIdle(entry)
    entry.lastUsed = Date.now()
    if (this.#idleTimeoutMs <= 0) return
    entry.idleTimer = setTimeout(() => {
      // Only a connection nobody is using may be closed. `queue` is *not*
      // touched here: it is the serialisation tail of the server, and clearing
      // it would let two commands run at once.
      const connection = entry.connection
      entry.connection = null
      entry.idleTimer = null
      if (connection !== null && connection.alive === true) {
        this.#log('info', 'dsh-server-connector: closing idle ssh connection')
        closeConnection(connection).catch(() => {})
      }
    }, this.#idleTimeoutMs)
    entry.idleTimer.unref?.()
  }

  /**
   * @param {{idleTimer: NodeJS.Timeout|null}} entry
   * @returns {void}
   */
  #clearIdle(entry) {
    if (entry.idleTimer !== null) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = null
    }
  }

  /**
   * @param {string} serverId
   * @param {{connection: any, queue: Promise<void>, lastUsed: number, idleTimer: NodeJS.Timeout|null}} entry
   * @returns {void}
   */
  #discard(serverId, entry) {
    this.#clearIdle(entry)
    const connection = entry.connection
    entry.connection = null
    if (connection !== null && connection.ready === 'ready') closeConnection(connection).catch(() => {})
    this.#log('info', 'dsh-server-connector: discarded dead connection for %s', serverId)
  }

  /**
   * Get a live connection, or dial one. A dead-but-remembered connection is
   * rebuilt exactly once (§7.2); if the rebuild fails, CONNECT_FAILED (or a
   * more specific code) travels to the caller unchanged.
   * @param {import('./registry.js').ServerRecord} server
   * @param {{connection: any, queue: Promise<void>, lastUsed: number, idleTimer: NodeJS.Timeout|null}} entry
   * @returns {Promise<any>}
   */
  async #ensureConnection(server, entry) {
    if (entry.connection !== null && entry.connection.alive === true) {
      return entry.connection
    }
    if (entry.connection !== null) {
      // One retry only: the previous socket is gone, dial a fresh one.
      closeConnection(entry.connection).catch(() => {})
      entry.connection = null
    }
    return this.#dial(server, entry)
  }

  /**
   * Serialise one operation behind the server's previous one (§7.2). A rejected
   * operation must not poison the queue for the next caller.
   * @param {{queue: Promise<void>}} entry
   * @param {() => Promise<any>} operation
   * @returns {Promise<any>}
   */
  async #enqueue(entry, operation) {
    const previous = entry.queue
    /** @type {Promise<any>} */
    const result = previous.then(operation, operation)
    entry.queue = result.then(
      () => {},
      () => {},
    )
    return result
  }

  /**
   * @param {string} id
   * @returns {{connection: any, queue: Promise<void>, lastUsed: number, idleTimer: NodeJS.Timeout|null}}
   */
  #entry(id) {
    let entry = this.#servers.get(id)
    if (entry === undefined) {
      entry = { connection: null, queue: Promise.resolve(), lastUsed: Date.now(), idleTimer: null }
      this.#servers.set(id, entry)
    }
    return entry
  }

  /** @returns {void} */
  #assertUsable() {
    if (this.#disposed) {
      throw new PoolError('CONNECTION_LOST', 'The SSH pool has been disposed; the plugin is shutting down.', {})
    }
  }

  /**
   * @param {'info'|'warn'|'error'} level
   * @param {string} message
   * @param {...unknown} args
   * @returns {void}
   */
  #log(level, message, ...args) {
    const logger = this.#logger
    if (logger === null || logger === undefined) return
    const write = logger[level] ?? logger.info
    if (typeof write === 'function') write.call(logger, message, ...args)
  }
}

/**
 * Turn a socket-level signal into the exit code a shell would report.
 * @param {string|null} signal
 * @returns {number}
 */
function signalExitCode(signal) {
  if (signal === null) return 0
  /** @type {Record<string, number>} */
  const numbers = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 }
  const number = numbers[signal]
  return number === undefined ? 1 : 128 + number
}

/**
 * Fingerprint one host key blob through the store's own implementation.
 * Returns `null` instead of throwing, because the ssh2 callback that calls this
 * has no channel to report an error through: the pool then refuses the host.
 * @param {Buffer|Uint8Array|string} keyBlob
 * @returns {{hash: string, algorithm: string}|null}
 */
function fingerprintOrNull(keyBlob) {
  try {
    return fingerprintHostKey(typeof keyBlob === 'string' ? Buffer.from(keyBlob, 'latin1') : keyBlob)
  } catch {
    return null
  }
}

/**
 * The §7.5 messages for a refused host key.
 * @param {import('./registry.js').ServerRecord} server
 * @param {'changed'|'unknown'} reason
 * @returns {HostKeyRejectedError}
 */
function hostKeyMessage(server, reason) {
  const target = `${server.host}:${server.port}`
  if (reason === 'changed') {
    return new HostKeyRejectedError(
      server.id,
      `The host key of ${target} changed; refusing to connect. If the change is expected, ` +
        `remove the entry for server ${server.id} from known_hosts.json (or trust the new key in the panel) and retry.`,
    )
  }
  return new HostKeyRejectedError(
    server.id,
    `The host key of ${target} is not trusted yet and server ${server.id} uses hostKeyMode "verify". ` +
      'Switch it to "accept-new" (or add the fingerprint to known_hosts.json) and retry.',
  )
}

/**
 * @param {unknown} value
 * @returns {import('./registry.js').ServerRecord}
 */
function requireServer(value) {
  if (!isPlainObject(value) || typeof value.id !== 'string' || value.id.trim() === '') {
    throw new PoolError('INVALID_SERVER', 'A complete server record is required (it must carry an id).', {})
  }
  if (typeof value.host !== 'string' || value.host.trim() === '') {
    throw new PoolError('INVALID_SERVER', `Server ${value.id} has no host.`, { serverId: value.id })
  }
  return /** @type {import('./registry.js').ServerRecord} */ (value)
}

/**
 * @param {ExecRequest} request
 * @returns {string}
 */
function normalizeCommand(request) {
  if (!isPlainObject(request) || typeof request.command !== 'string' || request.command.trim() === '') {
    throw new PoolError('INVALID_SERVER', 'exec() needs a non-empty command.', {})
  }
  return request.command
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizePositive(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new PoolError('INVALID_SERVER', 'timeoutMs and maxOutputChars must be positive numbers.', {})
  }
  return Math.round(value)
}

/**
 * @param {unknown} value
 * @param {import('./registry.js').ServerRecord} server
 * @returns {string|null}
 */
function normalizeCwd(value, server) {
  if (value === undefined) return server.defaultWorkDir ?? null
  if (value === null) return server.defaultWorkDir ?? null
  if (typeof value !== 'string') {
    throw new PoolError('INVALID_SERVER', 'cwd must be a string or null.', { serverId: server.id })
  }
  const trimmed = value.trim()
  return trimmed === '' ? server.defaultWorkDir ?? null : trimmed
}

/**
 * Close one connection without letting a half-open socket throw on the way out.
 * @param {any} connection
 * @returns {Promise<void>}
 */
async function closeConnection(connection) {
  connection.alive = false
  const client = connection.client
  if (client === undefined) return
  try {
    client.end()
  } catch {
    // Already destroyed.
  }
}

/**
 * @param {any} client
 * @returns {void}
 */
function safeDestroy(client) {
  try {
    client.destroy()
  } catch {
    // Never connected.
  }
}

export default Pool
