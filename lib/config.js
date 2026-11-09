// dsh-server-connector — the global configuration (doc §10), as live data.
//
// Why this unit exists
// --------------------
// Every key of the plugin's `Config` is `.volatile()` (see `lib/index.js`), and
// that is what makes the settings page editable at all: DSH projects a plugin
// row into a settings form only through `volatileForm()`, which keeps a field
// only when it is marked volatile (`dsh-settings/lib/index.js`). Without a
// single volatile field the whole schema projects to `undefined`, the namespace
// never appears in `settings.describe()`, and `ctx.configForms.get(<row id>)`
// stays `unavailable` — which is exactly why this plugin's settings page used to
// render nine read-only numbers.
//
// A volatile field does not resolve to its value: schemastery wraps it with
// cosmokit's `createVolatile(default)`, the loader writes an edit **into that
// same cell** and emits `loader/volatile-update` instead of remounting the
// plugin. So the config object handed to `apply()` is a live view, and every
// consumer has to read through {@link readConfig} at the moment it uses a value.
// Snapshotting it at construction time is the bug this unit exists to prevent.

/** The documented §10 defaults, in one place. */
export const CONFIG_DEFAULTS = Object.freeze({
  connectTimeoutMs: 15000,
  commandTimeoutMs: 60000,
  syncTimeoutMs: 20000,
  maxOutputChars: 200000,
  idleTimeoutMs: 600000,
  auditEnabled: true,
  auditMaxBytes: 0,
  pendingTtlHours: 24,
  maxListedServers: 8,
})

/** The nine key names, in schema order; the settings form and the tests read this. */
export const CONFIG_KEYS = /** @type {Array<keyof import('./index.js').PluginConfig>} */ (Object.keys(CONFIG_DEFAULTS))

/**
 * Unwrap one configuration value.
 *
 * A `.volatile()` schema field resolves to a cosmokit cell (`{get()}`) rather
 * than to its value, and the loader mutates that cell in place when the user
 * edits the field. A plain value — a test's hand-built settings object, or an
 * older host that resolved the schema itself — passes through untouched, so
 * every caller may read through here unconditionally.
 * @param {unknown} value
 * @returns {unknown}
 */
export function unbox(value) {
  if (value === null || typeof value !== 'object') return value
  const candidate = /** @type {{get?: unknown}} */ (value)
  if (typeof candidate.get !== 'function') return value
  try {
    return /** @type {{get: () => unknown}} */ (candidate).get()
  } catch {
    return undefined
  }
}

/**
 * Read the nine §10 values as plain data.
 *
 * The result is a *snapshot*: never cache it across turns. Call this where the
 * value is used, so a live edit takes effect without a remount.
 *
 * The parameter is deliberately loose (`Record<string, unknown>`): the object a
 * `Config` instance produces holds volatile *cells*, not values, so a stricter
 * signature would make every caller cast.
 * @param {Record<string, unknown>|null|undefined} config - the row config (volatile cells or plain values).
 * @returns {import('./index.js').PluginConfig}
 */
export function readConfig(config) {
  const source = config ?? {}
  /** @param {keyof import('./index.js').PluginConfig} key */
  const pick = (key) => {
    const value = unbox(source[key])
    return value === undefined || value === null ? CONFIG_DEFAULTS[key] : value
  }
  return {
    connectTimeoutMs: /** @type {number} */ (pick('connectTimeoutMs')),
    commandTimeoutMs: /** @type {number} */ (pick('commandTimeoutMs')),
    syncTimeoutMs: /** @type {number} */ (pick('syncTimeoutMs')),
    maxOutputChars: /** @type {number} */ (pick('maxOutputChars')),
    idleTimeoutMs: /** @type {number} */ (pick('idleTimeoutMs')),
    auditEnabled: /** @type {boolean} */ (pick('auditEnabled')),
    auditMaxBytes: /** @type {number} */ (pick('auditMaxBytes')),
    pendingTtlHours: /** @type {number} */ (pick('pendingTtlHours')),
    maxListedServers: /** @type {number} */ (pick('maxListedServers')),
  }
}
