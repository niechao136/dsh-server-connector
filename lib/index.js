// dsh-server-connector — Host half.
//
// Phase 1 shipped the skeleton and the policy engine (lib/policy.js). Phase 2
// adds the two file-backed units: the server registry (lib/registry.js) and the
// audit log (lib/audit.js), plus the Config → unit wiring exported below. The
// SSH pool, agent tools (srv_*), pending queue and HTTP routes of doc §5–8
// still arrive in later phases; this entry registers no tool yet, so installing
// the bundle remains a loadable no-op row.
//
// Config MUST be a @deepseek-ai/schemastery schema, never zod: the loader
// rejects a row whose Config is a foreign schema (dsh-remote records this as
// "zod rejects the undefined row config").

import z from '@deepseek-ai/schemastery'

import { AuditLog, defaultAuditFile } from './audit.js'
import { Registry, defaultServersFile } from './registry.js'

export const name = 'dsh-server-connector'

// Hard dependencies of the finished plugin (doc §9.4). Declared from phase 1 so
// the row's requirements are visible; credentials / jobs / webServer are read
// optionally with ctx.get() once those units exist.
export const inject = ['tools', 'systemPrompt']

/** Global configuration (doc §10). Every key has a default, so an empty row config validates. */
export const Config = z.object({
  /** SSH connection timeout. */
  connectTimeoutMs: z.number().step(1).min(1000).default(15000),
  /** Default timeout of one command; a tool argument may override it. */
  commandTimeoutMs: z.number().step(1).min(1000).default(60000),
  /** A synchronous call longer than this becomes a ctx.jobs job. */
  syncTimeoutMs: z.number().step(1).min(1000).default(20000),
  /** Output ceiling of a synchronous call; beyond it the result is marked TRUNCATED. */
  maxOutputChars: z.number().step(1).min(1024).default(200000),
  /** Idle timeout after which the pool closes a connection. */
  idleTimeoutMs: z.number().step(1).min(1000).default(600000),
  /** Whether to append a line to audit.log for every srv_exec. */
  auditEnabled: z.boolean().default(true),
  /** Rotate the audit log once it exceeds this size; 0 disables rotation. */
  auditMaxBytes: z.number().step(1).min(0).default(0),
  /** Lifetime of a pending (two-step) dangerous operation. */
  pendingTtlHours: z.number().step(1).min(1).default(24),
  /** How many servers the system prompt lists before collapsing the rest. */
  maxListedServers: z.number().step(1).min(1).default(8),
})

/**
 * The validated configuration shape (doc §10).
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
 * Build the registry for these settings (doc §3.5).
 *
 * `file` exists for tests and for an embedding host that keeps the data
 * directory somewhere else; production code passes nothing and gets
 * `$DSH_HOME/server-connector/servers.json`.
 * @param {PluginConfig} [config] - unused today, accepted so every unit factory
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
 * @param {PluginConfig} config - supplies `auditEnabled` and `auditMaxBytes`.
 * @param {{file?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {AuditLog}
 */
export function buildAuditLog(config, options = {}) {
  return new AuditLog({
    file: options.file ?? defaultAuditFile(options.env),
    enabled: config?.auditEnabled ?? true,
    maxBytes: config?.auditMaxBytes ?? 0,
  })
}

/**
 * Mount the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin's cordis context.
 * @param {PluginConfig} config - the validated {@link Config} value.
 * @returns {void}
 */
export function apply(ctx, config) {
  ctx.logger.info(
    'dsh-server-connector: policy engine + registry + audit loaded (audit=%s, auditMaxBytes=%s, pendingTtlHours=%s); server tools arrive in a later phase',
    String(config.auditEnabled),
    String(config.auditMaxBytes),
    String(config.pendingTtlHours),
  )
}
