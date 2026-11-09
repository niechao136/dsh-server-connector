// Tests for the Client half (design doc §8, §9.1, §9.2).
//
// Run with: node --test tests/client.test.ts   (Node strips the types natively)
// or:       npm test
//
// lib/client.js is a browser bundle for the DSH client module system
// (`window.__ModuleLoader__.load`), not a Node module. These tests therefore
// *execute* it the way the page does — install a fake `__ModuleLoader__`, call
// the registered factory with a fake `require`, and hand the resulting `apply()`
// a recording cordis context — instead of importing it.
//
// What is pinned here:
//
//   - the package declares exactly the §9.2 `dsh.client` block and exports the
//     `./client` bundle the module system resolves;
//   - the bundle registers under the package name and returns `inject`/`apply`;
//   - `apply()` makes exactly the three §8.1 contributions, under the ids the
//     sidebar and the panel key exchange;
//   - every dictionary key exists in both languages (a missing English key would
//     silently render the Chinese one, and vice versa);
//   - the stylesheet and the three React components render without a browser
//     (react-dom/server), which is what catches a hook or prop mistake before the
//     page does.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { CONFIG_KEYS } from '../lib/index.js'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Read and execute the browser bundle exactly as the page would. */
async function loadBundle() {
  const source = await readFile(join(PACKAGE_ROOT, 'lib', 'client.js'), 'utf8')
  const registrations: any[] = []
  const seed: Record<string, any> = {
    react: React,
    'react/jsx-runtime': {},
  }
  const previousModuleLoader = Reflect.get(globalThis, '__ModuleLoader__')
  const previousDocument = Reflect.get(globalThis, 'document')
  Reflect.set(globalThis, '__ModuleLoader__', {
    load(registration: any) {
      registrations.push(registration)
    },
  })
  const styles: any[] = []
  // The bundle reads `document` off the page global, exactly as it does in the
  // browser; the fake records the <style> tag installStyles() appends.
  Reflect.set(globalThis, 'document', {
    querySelector: () => null,
    createElement: () => {
      const tag = { textContent: '', setAttribute() {} }
      styles.push(tag)
      return tag
    },
    head: { appendChild: () => {} },
  })
  try {
    // The bundle is CommonJS-ish factory form loaded by a script tag, not an ESM
    // module, so it is executed here the same way.
    // eslint-disable-next-line no-new-func
    const run = new Function(`${source}\n`)
    run()
    assert.equal(registrations.length, 1)
    const registration = registrations[0]
    const exports = registration.factory((spec: string) => {
      if (!(spec in seed)) throw new Error(`unexpected require("${spec}")`)
      return seed[spec]
    })
    // The page globals stay installed for the caller's `apply()` — that is when
    // the bundle injects its stylesheet — and `dispose()` restores them.
    let disposed = false
    return {
      registration,
      exports,
      styles,
      dispose() {
        if (disposed) return
        disposed = true
        if (previousModuleLoader === undefined) Reflect.deleteProperty(globalThis, '__ModuleLoader__')
        else Reflect.set(globalThis, '__ModuleLoader__', previousModuleLoader)
        if (previousDocument === undefined) Reflect.deleteProperty(globalThis, 'document')
        else Reflect.set(globalThis, 'document', previousDocument)
      },
    }
  } catch (error) {
    if (previousModuleLoader === undefined) Reflect.deleteProperty(globalThis, '__ModuleLoader__')
    else Reflect.set(globalThis, '__ModuleLoader__', previousModuleLoader)
    if (previousDocument === undefined) Reflect.deleteProperty(globalThis, 'document')
    else Reflect.set(globalThis, 'document', previousDocument)
    throw error
  }
}

/** A recording cordis context: `slots`, `locale`, `effect`. */
function recordingContext() {
  const slotRegistrations: any[] = []
  const dictionaries: any[] = []
  const effects: string[] = []
  const ctx = {
    slots: {
      inject(name: string, contribute: () => void) {
        assert.equal(typeof contribute, 'function')
        contribute()
        return () => {}
      },
      register(options: any, component: any) {
        slotRegistrations.push({ options, component })
        return () => {}
      },
    },
    locale: {
      register(ns: string, dicts: any) {
        dictionaries.push({ ns, dicts })
        return () => {}
      },
      bind(ns: string) {
        return (key: string) => `${ns}:${key}`
      },
    },
    effect(fn: () => unknown, label: string) {
      effects.push(label)
      fn()
      return () => {}
    },
  }
  return { ctx, slotRegistrations, dictionaries, effects }
}

describe('package manifest (§9.2)', () => {
  test('declares the two-client-package inject list and the web platform', async () => {
    const text = await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8')
    const manifest = JSON.parse(text)
    assert.deepEqual(manifest.dsh.client, {
      inject: ['@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-locale'],
      platform: 'web',
    })
    assert.equal(manifest.exports['./client'], './lib/client.js')
    assert.equal(manifest.icon, './icon.svg')
    assert.ok(manifest.files.includes('locale'))
    assert.ok(manifest.files.includes('icon.svg'))
  })

  test('ships an icon and both locale display dictionaries', async () => {
    const icon = await readFile(join(PACKAGE_ROOT, 'icon.svg'), 'utf8')
    assert.match(icon, /^<svg[^>]*viewBox="0 0 36 36"/)
    for (const language of ['zh', 'en']) {
      const text = await readFile(join(PACKAGE_ROOT, 'locale', `${language}.json`), 'utf8')
      const parsed = JSON.parse(text)
      assert.equal(typeof parsed.meta.title, 'string')
      assert.ok(parsed.meta.title.length > 0)
      assert.equal(typeof parsed.meta.description, 'string')
    }
  })
})

describe('the bundle', () => {
  test('registers under the package name and exports inject/apply', async () => {
    const bundle = await loadBundle()
    try {
      assert.equal(bundle.registration.id, 'dsh-server-connector')
      assert.equal(typeof bundle.exports.apply, 'function')
      assert.deepEqual(bundle.exports.inject, ['slots', 'locale'])
      assert.equal(bundle.exports.PANEL_ID, 'server-connector')
      assert.equal(bundle.exports.NS, 'serverConnector')
    } finally {
      bundle.dispose()
    }
  })

  test('apply() makes exactly the three §8.1 contributions', async () => {
    const bundle = await loadBundle()
    const { exports } = bundle
    const { ctx, slotRegistrations, dictionaries } = recordingContext()
    exports.apply(ctx)
    assert.equal(slotRegistrations.length, 3)

    const byName = new Map(slotRegistrations.map((entry) => [entry.options.name, entry]))
    assert.deepEqual([...byName.keys()].sort(), ['main', 'settings.section', 'sidebar.panellist'])

    const sidebar = byName.get('sidebar.panellist').options
    assert.equal(sidebar.id, 'server-connector')
    assert.equal(sidebar.locale, 'serverConnector')
    assert.equal(typeof sidebar.label, 'function')

    // The sidebar id and the main panel key are the same value: that exchange is
    // how the sidebar opens this panel.
    const main = byName.get('main').options
    assert.equal(main.key, sidebar.id)
    assert.equal(main.locale, 'serverConnector')

    const settings = byName.get('settings.section').options
    assert.equal(settings.id, 'server-connector')
    assert.equal(settings.locale, 'serverConnector')
    assert.equal(typeof settings.label, 'function')

    // Every contribution is a component the renderer can mount.
    for (const entry of slotRegistrations) assert.equal(typeof entry.component, 'function')

    assert.equal(dictionaries.length, 1)
    assert.equal(dictionaries[0].ns, 'serverConnector')
    bundle.dispose()
  })

  test('both dictionaries have the same keys, and every key is used', async () => {
    const bundle = await loadBundle()
    const { exports } = bundle
    const { ctx, dictionaries } = recordingContext()
    exports.apply(ctx)
    const { zh, en } = dictionaries[0].dicts
    const zhKeys = Object.keys(zh).sort()
    const enKeys = Object.keys(en).sort()
    assert.deepEqual(enKeys, zhKeys)
    assert.ok(zhKeys.length > 60)

    // A key that renders nowhere is dead copy; a rendered key missing from the
    // dictionary would show up as its raw id in the page.
    const source = await readFile(join(PACKAGE_ROOT, 'lib', 'client.js'), 'utf8')
    const used = new Set(
      [...source.matchAll(/\bt\('([A-Za-z0-9.]+)'/g)]
        .map((match) => match[1])
        .filter((key): key is string => key !== undefined),
    )
    const missing = [...used].filter((key) => !(key in zh))
    assert.deepEqual(missing, [], `used but missing from the dictionary: ${missing.join(', ')}`)
    bundle.dispose()
  })
})

describe('styles', () => {
  test('the stylesheet is injected once and only mentions design tokens', async () => {
    const bundle = await loadBundle()
    const { ctx } = recordingContext()
    bundle.exports.apply(ctx)
    const { styles } = bundle
    assert.equal(styles.length, 1)
    const css = styles[0].textContent
    assert.ok(css.length > 1000)
    assert.match(css, /\.srv-page/)
    assert.match(css, /\[data-on="true"\]/)
    // Hard-coded colors would break dark mode; every color is a token. The only
    // literals left are var() fallbacks, which apply solely when a token is
    // missing (never in the Host, which defines all of them).
    const allowed = new Set(['#fff', '#0f1115', '#adb2b8'])
    const colors = (css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).filter(
      (color: string) => !allowed.has(color.toLowerCase()),
    )
    assert.deepEqual(colors, [])
    bundle.dispose()
  })

  test('the switch stays legible in both themes', async () => {
    // Two regressions are pinned here.
    //
    // 1. The off track once used a border token that renders as a barely visible
    //    wash, so the control read as a white block.
    // 2. The thumb was hard-coded `#fff`. In dark mode the on-track resolves to
    //    #f9fafb, so a white thumb on a near-white track disappeared entirely.
    //
    // The Host solves this by pairing `--dsw-alias-label-primary` (track) with
    // `--dsw-alias-label-primary-inverted` (thumb): the two swap together, so
    // contrast survives either theme.
    const bundle = await loadBundle()
    const { ctx } = recordingContext()
    bundle.exports.apply(ctx)
    const css = bundle.styles[0].textContent
    const hostTokens = new Set([
      '--dsw-alias-brand-primary',
      '--dsw-alias-button-primary-fill',
      '--dsw-alias-button-primary-hover',
      '--dsw-alias-label-primary',
      '--dsw-alias-label-primary-foreground',
      '--dsw-alias-label-primary-inverted',
      '--dsw-alias-label-secondary',
      '--dsw-alias-label-tertiary',
      '--dsw-alias-label-caption',
      '--dsw-alias-bg-layer-1',
      '--dsw-alias-border-l2',
      '--dsw-alias-border-l3',
      '--dsw-alias-border-l4',
      '--dsw-alias-interactive-bg-hover',
      '--dsw-alias-state-error-primary',
      '--dsw-alias-state-warn-primary',
      '--dsw-alias-state-success-primary',
      '--dsw-alias-state-idle-primary',
      '--dsw-static-neutral-bluish-00',
      '--dsw-static-neutral-bluish-1000',
      '--dsw-elevation-soft',
    ])
    const used = [...css.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((match) => match[1])
    const unknown = used.filter((token) => !hostTokens.has(token))
    assert.deepEqual(unknown, [], `unknown host tokens: ${unknown.join(', ')}`)
    // On-track uses label-primary; the thumb under the on state must use its
    // inverted partner rather than a fixed white.
    assert.match(css, /\.srv-switch\[data-on="true"\]\{[^}]*--dsw-alias-label-primary[,)]/)
    assert.match(css, /\.srv-switch\[data-on="true"\] \.srv-switch-knob\{[^}]*--dsw-alias-label-primary-inverted/)
    // Nothing may paint the thumb a literal white, in any state.
    assert.doesNotMatch(css, /\.srv-switch-knob\{[^}]*background:#fff/)
    bundle.dispose()
  })
})

describe('rendering', () => {
  /**
   * Render one registered component with the props a slot would pass.
   * @param {string} slot - slot name to pick the component.
   * @param {Record<string, unknown>} extra - extra props.
   */
  async function render(slot: string, extra: Record<string, unknown> = {}) {
    const bundle = await loadBundle()
    const { exports } = bundle
    const { ctx, slotRegistrations } = recordingContext()
    exports.apply(ctx)
    const entry = slotRegistrations.find((candidate) => candidate.options.name === slot)
    assert.ok(entry !== undefined, `no registration for ${slot}`)
    const t = (key: string, params?: Record<string, unknown>) =>
      params === undefined ? key : `${key}(${JSON.stringify(params)})`
    // `useState`/`useEffect` run once in the server renderer; a fetch never
    // resolves there, so a panel renders its loading state, which is the point.
    const html = renderToStaticMarkup(React.createElement(entry.component, { t, ...extra }))
    bundle.dispose()
    return { html, entry }
  }

  test('the sidebar icon renders an svg at the requested size', async () => {
    const { html } = await render('sidebar.panellist', { size: 24, active: false })
    assert.match(html, /^<svg[^>]*width="24"/)
    assert.match(html, /aria-hidden="true"/)
  })

  test('the main panel renders its loading state on first paint', async () => {
    const { html } = await render('main')
    assert.match(html, /class="srv-page"/)
    assert.match(html, /panel\.loading/)
    assert.match(html, /srv-badge|srv-head/)
  })

  test('the settings page renders the pending section and the global section', async () => {
    const { html } = await render('settings.section', { close: () => {} })
    assert.match(html, /class="srv-page"/)
    assert.match(html, /settings\.pending/)
    assert.match(html, /settings\.global/)
  })

  test('the settings page renders a read-only global card when it has no form', async () => {
    // Without an injected `configForms` scope the page cannot save. It must say
    // so instead of rendering dead inputs. (Outside the slot's `inject` path the
    // page falls back to a detached model, which is exactly this case.)
    const { html } = await render('settings.section', { close: () => {} })
    assert.match(html, /settings\.globalReadonly/)
    assert.doesNotMatch(html, /<input/)
  })

  test('deleting from the detail page finishes in place, still through the queue', async () => {
    // §8.2/§8.3: the confirm step moved from the settings page to the detail
    // page, but the safety model did not change — `DELETE` only queues, and the
    // removal happens on `POST /pending/:id/confirm`. This pins both halves so a
    // later refactor cannot turn "delete" into a single destructive click.
    const source = await readFile(join(PACKAGE_ROOT, 'lib', 'client.js'), 'utf8')
    const remove = /const remove = async \(server\) => \{([\s\S]*?)\n      \}/.exec(source)
    assert.ok(remove !== null, 'the detail-page delete flow is missing')
    const body = remove[1] ?? ''
    assert.match(body, /method: 'DELETE'/)
    assert.match(body, /\/pending\/\$\{encodeURIComponent\(id\)\}\/confirm/)
    // The detail page owns the confirmation state; the plain delete button only
    // opens it, so one click never reaches the network.
    assert.match(source, /const \[confirming, setConfirming\] = React\.useState\(false\)/)
    assert.match(source, /disabled: deleting \|\| !acknowledged/)
  })

  test('apply() survives a Host that rejects a seat instead of taking the batch down', async () => {    // The client bundle batch is ONE concatenated classic script: an exception that
    // escapes apply() also skips every later bundle's registration. That is how an
    // unrelated plugin's update made this panel disappear — the failure was never
    // ours, but the blast radius was. apply() must therefore never throw.
    const bundle = await loadBundle()
    const { ctx } = recordingContext()
    const thin = {
      ...ctx,
      slots: {
        inject(name: string, contribute: () => void) {
          // A Host that knows the seat: run it, but let it fail internally.
          if (name === 'main') {
            contribute()
            return () => {}
          }
          // A Host that does not know the seat at all.
          throw new Error(`unknown slot ${name}`)
        },
        register() {
          throw new Error('register refused')
        },
      },
    }
    assert.doesNotThrow(() => bundle.exports.apply(thin))
    bundle.dispose()
  })

  test('a re-applied bundle reuses its seat instead of failing on the duplicate', async () => {
    // The update path that made the panel "disappear after an update and only
    // come back after a restart".
    //
    // The shipped slot registry refuses a second registration of the same id at
    // the same priority (`list slot "…" already has an entry with id "…"`), and a
    // throw inside `slots.inject`'s callback retires that injection for the
    // fiber's remaining lifetime. So when the new bundle's `apply()` runs while
    // the previous registration is still in the table — the state an update can
    // leave behind — a blind `register()` fails, and the seat is then absent for
    // good instead of being reused.
    //
    // dsh-context guards exactly this: `if (alreadyMounted(ctx, slot, id)) return`.
    // Ours must too, so a re-apply keeps the seat that is already there.
    const bundle = await loadBundle()
    const { ctx } = recordingContext()
    /** Seat table keyed by slot name; entries keep the registry's `{options, component}` shape. */
    const seats = new Map<string, any[]>()
    const attempts: string[] = []
    /** Mirrors the Host's duplicate rules for list and keyed slots. */
    const strict = {
      ...ctx,
      slots: {
        inject(name: string, contribute: () => void) {
          contribute()
          return () => {}
        },
        entries(name: string) {
          return seats.get(name) ?? []
        },
        register(options: any, component: any) {
          attempts.push(options.name)
          const list = seats.get(options.name) ?? []
          if (options.name === 'main') {
            if (list.some((entry) => entry.options.key === options.key)) {
              throw new Error(`keyed slot "main" already has an entry for key "${options.key}"`)
            }
          } else if (list.some((entry) => entry.options.id === options.id)) {
            throw new Error(`list slot "${options.name}" already has an entry with id "${options.id}"`)
          }
          const record = { options, component }
          list.push(record)
          seats.set(options.name, list)
          return () => {
            seats.set(options.name, list.filter((entry) => entry !== record))
          }
        },
      },
    }
    assert.doesNotThrow(() => bundle.exports.apply(strict))
    attempts.length = 0
    // A second apply, with the first apply's seats still occupied.
    assert.doesNotThrow(() => bundle.exports.apply(strict))
    // It must not even try: a refused register would retire the injection.
    assert.deepEqual(attempts, [])
    assert.equal(seats.get('sidebar.panellist')?.length, 1)
    assert.equal(seats.get('main')?.length, 1)
    assert.equal(seats.get('settings.section')?.length, 1)
    bundle.dispose()
  })

  test('a seat whose registration throws does not take the other seats down', async () => {
    const bundle = await loadBundle()
    const { ctx } = recordingContext()
    const registered: string[] = []
    const partial = {
      ...ctx,
      slots: {
        inject(name: string, contribute: () => void) {
          contribute()
          return () => {}
        },
        register(options: any) {
          // The first seat fails; the other two must still register.
          if (options.name === 'sidebar.panellist') throw new Error('refused')
          registered.push(options.name)
          return () => {}
        },
      },
    }
    assert.doesNotThrow(() => bundle.exports.apply(partial))
    assert.deepEqual(registered, ['main', 'settings.section'])
    bundle.dispose()
  })

  test('the global settings form covers every Config key exactly once', async () => {
    // The page's field table is hand-written; `Config` is the authority. A key
    // added to one and not the other would either hide a setting or show a
    // control the Host rejects.
    const bundle = await loadBundle()
    const { exports } = bundle
    const { ctx } = recordingContext()
    exports.apply(ctx)
    const source = await readFile(join(PACKAGE_ROOT, 'lib', 'client.js'), 'utf8')
    const table = /const CONFIG_FIELDS = \[([\s\S]*?)\n    \]/.exec(source)
    assert.ok(table !== null, 'CONFIG_FIELDS table is missing')
    const listed = [...(table[1] ?? '').matchAll(/key: '([A-Za-z0-9]+)'/g)].map((match) => match[1]).sort()
    const keys = CONFIG_KEYS.slice().sort()
    assert.deepEqual(listed, keys)
    assert.equal(new Set(listed).size, listed.length)
    bundle.dispose()
  })
})
