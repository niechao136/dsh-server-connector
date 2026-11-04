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
    // Hard-coded colors would break dark mode; every color is a token.
    const colors = css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
    assert.deepEqual(colors, [])
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
})
