// dsh-server-connector — Host half.
//
// Unit map (doc §2.1):
//
//   policy.js      built-in high-risk catalog + per-server decisions (§4)
//   registry.js    servers.json CRUD (§3.1)
//   known-hosts.js known_hosts.json fingerprints (§3.2)
//   pool.js        ssh2 connection pool + execution (§7)
//   audit.js       audit.log JSONL append/tail (§3.4)
//   pending.js     pending.json two-step queue (§3.3, §8.3)
//   tools.js       the six srv_* tools + the §5.3 system-prompt section (§5, §6)
//
// This entry wires those units, the plugin's lifecycle and the Client half's
// JSON routes (doc §8.5, lib/routes.js). The browser bundle itself is
// lib/client.js, loaded by the client module system, not by this file.
//
// Config MUST be a @deepseek-ai/schemastery schema, never zod: the loader
// rejects a row whose Config is a foreign schema (dsh-remote records this as
// "zod rejects the undefined row config").

import z from '@deepseek-ai/schemastery'

import { AuditLog, defaultAuditFile } from './audit.js'
import { readConfig } from './config.js'
import { KnownHosts, defaultKnownHostsFile } from './known-hosts.js'
import { PendingQueue, createPendingApplier, defaultPendingFile } from './pending.js'
import { Pool } from './pool.js'
import { Registry, defaultServersFile } from './registry.js'
import { registerRoutes } from './routes.js'
import { TOOL_NAMES, ToolSurface } from './tools.js'

export const name = 'dsh-server-connector'

// Hard dependencies of the finished plugin (doc §9.4). Declared from phase 1 so
// the row's requirements are visible; credentials / jobs / webServer are read
// optionally with ctx.get() once those units exist.
export const inject = ['tools', 'systemPrompt']

/**
 * Global configuration (doc §10). Every key has a default, so an empty row config validates.
 *
 * Every key is `.volatile()`, and that is not decoration. DSH 0.2.2 exposes a
 * plugin's settings form only through `volatileForm()`, which keeps a field only
 * when it is marked volatile (`dsh-settings/lib/index.js`); a schema with no
 * volatile field projects to `undefined`, the settings page lists no namespace
 * for this row, and `ctx.configForms.get('dsh-server-connector')` stays
 * `unavailable` forever. That is why the settings page used to show nine
 * read-only numbers with no way to edit them — the row was never projected.
 *
 * A volatile field resolves to a cosmokit *cell*, not to its value: the loader
 * writes an edit into that same cell in place and emits `loader/volatile-update`
 * instead of remounting the plugin. Read every value through `readConfig`
 * (lib/config.js), and treat the plugin's config object as a live view.
 */
export const Config = z.object({
  /** SSH connection timeout. */
  connectTimeoutMs: z.number().step(1).min(1000).default(15000).volatile(),
  /** Default timeout of one command; a tool argument may override it. */
  commandTimeoutMs: z.number().step(1).min(1000).default(60000).volatile(),
  /** A synchronous call longer than this becomes a ctx.jobs job. */
  syncTimeoutMs: z.number().step(1).min(1000).default(20000).volatile(),
  /** Per-stream output ceiling, applied to stdout and to stderr each; beyond it that stream is marked TRUNCATED. */
  maxOutputChars: z.number().step(1).min(1024).default(200000).volatile(),
  /** Idle timeout after which the pool closes a connection. */
  idleTimeoutMs: z.number().step(1).min(1000).default(600000).volatile(),
  /** Whether to append a line to audit.log for every srv_exec. */
  auditEnabled: z.boolean().default(true).volatile(),
  /** Rotate the audit log once it exceeds this size; 0 disables rotation. */
  auditMaxBytes: z.number().step(1).min(0).default(0).volatile(),
  /** Lifetime of a pending (two-step) dangerous operation. */
  pendingTtlHours: z.number().step(1).min(1).default(24).volatile(),
  /** How many servers the system prompt lists before collapsing the rest. */
  maxListedServers: z.number().step(1).min(1).default(8).volatile(),
})

export { CONFIG_DEFAULTS, CONFIG_KEYS, readConfig, unbox } from './config.js'

/**
 * The resolved configuration shape (doc §10) — plain values, as {@link readConfig}
 * returns them.
 * @typedef {object} PluginConfig
 * @property {number} connectTimeoutMs
 * @property {number} commandTimeoutMs
 * @property {number} syncTimeoutMs
 * @property {number} maxOutputChars
 * @property {number} idleTimeoutMs
 * @property {boolean} auditEnabled
 * @property {number} auditMaxBytes
 * @property {number} pendingTtlHours
 * @property {number} maxListedServers
 */

/**
 * The configuration object the loader hands `apply`.
 *
 * Every field is `.volatile()`, so schemastery resolves each one to a cosmokit
 * cell rather than to its value — the type is therefore deliberately opaque, and
 * {@link readConfig} is the only sanctioned reader.
 * @typedef {Record<string, unknown>} RawConfig
 */

/**
 * Build the registry for these settings (doc §3.5).
 *
 * `file` exists for tests and for an embedding host that keeps the data
 * directory somewhere else; production code passes nothing and gets
 * `$DSH_HOME/server-connector/servers.json`.
 * @param {RawConfig} [config] - unused today, accepted so every unit factory
 *   has the same `(config, options)` signature.
 * @param {{file?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Registry}
 */
export function buildRegistry(config, options = {}) {
  void config
  return new Registry({ file: options.file ?? defaultServersFile(options.env) })
}

/**
 * Build the audit log for these settings (doc §3.4, §6.2, §10).
 * `auditEnabled: false` keeps the log object usable but makes `append()` a
 * no-op, which is what the gate needs: the command still runs.
 * @param {RawConfig} config - supplies `auditEnabled` and `auditMaxBytes`.
 * @param {{file?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {AuditLog}
 */
export function buildAuditLog(config, options = {}) {
  const values = readConfig(config)
  return new AuditLog({
    file: options.file ?? defaultAuditFile(options.env),
    enabled: values.auditEnabled,
    maxBytes: values.auditMaxBytes,
  })
}

/**
 * Build the host fingerprint store for these settings (doc §3.2, §6.4).
 * @param {RawConfig} [config] - unused today, accepted so every unit factory
 *   has the same `(config, options)` signature.
 * @param {{file?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {KnownHosts}
 */
export function buildKnownHosts(config, options = {}) {
  void config
  return new KnownHosts({ file: options.file ?? defaultKnownHostsFile(options.env) })
}

/**
 * Build the SSH connection pool for these settings (doc §7, §10).
 *
 * `resolvePassword` is injected rather than looked up here: the pool must not
 * depend on `ctx.credentials` (doc §9.4 makes that service optional, and the
 * tools layer owns credential refs). When no resolver is passed, a password
 * server reports `NO_CREDENTIAL` instead of dialling with an empty password.
 * @param {RawConfig} config - supplies the timeouts and output ceiling.
 * @param {{
 *   knownHosts: KnownHosts,
 *   resolvePassword?: (server: import('./registry.js').ServerRecord) => Promise<string|null>,
 *   logger?: {info: Function, warn: Function, error: Function} | null,
 * }} options
 * @returns {Pool}
 */
export function buildPool(config, options) {
  const values = readConfig(config)
  return new Pool({
    knownHosts: options.knownHosts,
    resolvePassword: options.resolvePassword,
    logger: options.logger ?? null,
    connectTimeoutMs: values.connectTimeoutMs,
    commandTimeoutMs: values.commandTimeoutMs,
    idleTimeoutMs: values.idleTimeoutMs,
    maxOutputChars: values.maxOutputChars,
  })
}

/**
 * Build the two-step confirmation queue for these settings (doc §3.3, §8.3).
 * @param {RawConfig} config - supplies `pendingTtlHours`.
 * @param {{file?: string, env?: NodeJS.ProcessEnv, now?: () => Date}} [options]
 * @returns {PendingQueue}
 */
export function buildPendingQueue(config, options = {}) {
  return new PendingQueue({
    file: options.file ?? defaultPendingFile(options.env),
    ttlHours: readConfig(config).pendingTtlHours,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
}

/**
 * Mount the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin's cordis context.
 * @param {RawConfig} config - the validated {@link Config} value (volatile cells).
 * @returns {void}
 */
export function apply(ctx, config) {
  const knownHosts = buildKnownHosts(config)
  const registry = buildRegistry(config)
  const audit = buildAuditLog(config)
  const pending = buildPendingQueue(config)
  const pool = buildPool(config, {
    knownHosts,
    logger: ctx.logger,
    // `credentials` is an optional service (doc §9.4): without it only key and
    // agent authentication work, which is exactly NO_CREDENTIAL's message.
    resolvePassword: async (server) => {
      if (server.auth.kind !== 'password') return null
      const credentials = ctx.get('credentials')
      if (credentials === undefined || credentials === null) return null
      const resolved = await credentials.resolve?.(server.auth.credentialRef)
      const value = typeof resolved === 'string' ? resolved : resolved?.value
      return typeof value === 'string' && value !== '' ? value : null
    },
  })

  // Confirmed pending operations need the registry, the pool, the audit log and
  // (for a deleted password server) the credentials service. The applier is
  // injected so lib/pending.js stays free of those units (doc §2.2).
  pending.setApplier(
    createPendingApplier({
      registry,
      pool,
      audit,
      getCredentials: () => ctx.get('credentials'),
      logger: ctx.logger,
    }),
  )

  // `approval` (doc §6.1) and `jobs` (doc §5.4) are optional services: without
  // them a confirmation fails closed and every command runs synchronously.
  const surface = new ToolSurface({
    registry,
    pool,
    audit,
    approval: ctx.get('approval') ?? null,
    jobs: ctx.get('jobs') ?? null,
    config,
    logger: ctx.logger,
  })
  surface.register(ctx)
  surface.registerSystemPrompt(ctx)

  // The system-prompt provider is synchronous, so it serves this cache; refresh
  // it at startup and after the registry changes.
  const refresh = () => {
    surface.refresh().catch((error) => {
      ctx.logger.warn('dsh-server-connector: could not read servers.json: %s', String(error))
    })
  }
  refresh()

  // Two-step operations expire on their own (doc §8.3: "进程启动时与每次读写时
  // 各检查一次"); the startup sweep reports what it discarded.
  void pending
    .expire()
    .then((discarded) => {
      if (discarded.length === 0) return
      ctx.logger.info('dsh-server-connector: discarded %d expired pending operation(s)', discarded.length)
    })
    .catch((error) => {
      ctx.logger.warn('dsh-server-connector: could not read pending.json: %s', String(error))
    })

  // A pool holds live sockets and idle timers; the plugin row must release both
  // when it is unloaded, disabled or replaced. `ctx.effect` is cordis's
  // lifecycle hook (an 'error'-style dispose event does not exist).
  ctx.effect(() => () => pool.dispose(), 'dsh-server-connector: ssh pool')

  // A volatile settings edit is written into the config object the loader gave
  // this row and then announced — the plugin is NOT remounted, and `apply` is
  // not called again. So every unit that cached a value has to be handed the new
  // ones here, or the settings page would save and change nothing. The units
  // read their other values at call time already (see `readConfig`).
  //
  // The event is emitted by the loader (`_commitVolatile` in dsh-loader), not
  // declared in this plugin's own event map, hence the cast.
  const onVolatileUpdate = /** @type {(name: any, listener: () => void, label?: string) => void} */ (ctx.on.bind(ctx))
  onVolatileUpdate('loader/volatile-update', () => {
    try {
      const values = readConfig(config)
      pool.configure(values)
      audit.configure({ enabled: values.auditEnabled, maxBytes: values.auditMaxBytes })
      pending.configure(values.pendingTtlHours)
    } catch (error) {
      ctx.logger.warn('dsh-server-connector: applying a live settings change failed: %s', String(error))
    }
  }, 'dsh-server-connector: live settings')

  // The Client half's JSON routes (doc §8.5). `webServer` is an optional service
  // (§9.4): a headless composition keeps the tools and simply has no panel. The
  // panel's own changes go through the same registry, so the system-prompt cache
  // is refreshed from there or the model would keep seeing the old server list.
  ctx.inject(['webServer'], (webCtx) => {
    const { dispose } = registerRoutes(webCtx, {
      registry,
      pool,
      audit,
      pending,
      getCredentials: () => webCtx.get('credentials'),
      config,
      onChange: async () => {
        await surface.refresh()
      },
      logger: webCtx.logger,
    })
    webCtx.effect(() => dispose, 'dsh-server-connector: json routes')
  })

  ctx.logger.info(
    'dsh-server-connector: %d srv_* tools registered (approval=%s, jobs=%s, credentials=%s, routes=%s)',
    TOOL_NAMES.length,
    ctx.get('approval') === undefined ? 'unavailable' : 'available',
    ctx.get('jobs') === undefined ? 'unavailable (synchronous only)' : 'available',
    ctx.get('credentials') === undefined ? 'unavailable (key/agent auth only)' : 'available',
    ctx.get('webServer') === undefined ? 'unavailable (no panel)' : 'available',
  )
}
