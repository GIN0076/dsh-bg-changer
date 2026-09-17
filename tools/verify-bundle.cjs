#!/usr/bin/env node
/**
 * dsh-bg-changer bundle smoke test.
 *
 * Loads `lib/client.js` the way the client module system does (a
 * `window.__ModuleLoader__.load({id, factory})` registration), runs `apply()`
 * against a fake Cordis context, and checks both the plugin wiring and the
 * pure geometry/alpha helpers. It never touches the network, the file system
 * outside this package, or a real browser.
 *
 * Run: node tools/verify-bundle.cjs
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const BUNDLE = path.join(__dirname, '..', 'lib', 'client.js')
const failures = []
let passed = 0

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    process.stdout.write('  ok   ' + name + '\n')
    return
  }
  failures.push(name + (detail === undefined ? '' : ' — ' + detail))
  process.stdout.write('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail) + '\n')
}

function equal(name, actual, expected) {
  check(name, actual === expected, 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))
}

function near(name, actual, expected) {
  check(name, Math.abs(actual - expected) < 1e-9, 'expected ' + expected + ', got ' + actual)
}

/** Minimal DOM stub that counts mutations, so "no DOM writes at apply" is provable. */
function makeDocumentStub() {
  const counters = { created: 0, appended: 0, inserted: 0, removed: 0 }
  const makeStyle = () => {
    const properties = {}
    return {
      properties,
      cssText: '',
      setProperty(name, value) { properties[name] = String(value) },
      removeProperty(name) { delete properties[name] },
    }
  }
  const makeElement = (tag) => {
    const element = {
      tagName: String(tag).toUpperCase(),
      id: '',
      isConnected: true,
      nextSibling: null,
      children: [],
      style: makeStyle(),
      dataset: {},
      className: '',
      textContent: '',
      attributes: {},
      setAttribute(name, value) { this.attributes[name] = value },
      removeAttribute(name) { delete this.attributes[name] },
      appendChild(child) {
        counters.appended += 1
        this.children.push(child)
        child.isConnected = true
        child.parent = this
        return child
      },
      insertBefore(child) {
        counters.inserted += 1
        this.children.push(child)
        child.isConnected = true
        child.parent = this
        return child
      },
      remove() {
        counters.removed += 1
        this.isConnected = false
        const parent = this.parent
        if (parent != null) {
          const index = parent.children.indexOf(this)
          if (index >= 0) parent.children.splice(index, 1)
        }
      },
      addEventListener() {},
      removeEventListener() {},
      click() {},
      querySelector() { return null },
    }
    return element
  }
  const head = makeElement('head')
  const body = makeElement('body')
  body.firstChild = null
  const document = {
    head,
    body,
    documentElement: { style: makeStyle(), clientWidth: 1600, clientHeight: 900 },
    createElement(tag) { counters.created += 1; return makeElement(tag) },
    getElementById() { return null },
    querySelector() { return null },
  }
  return { document, counters }
}

/** In-memory IndexedDB stub serving one fixed asset record. */
function makeIndexedDb(record) {
  return {
    open() {
      const request = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null }
      setTimeout(() => {
        const db = {
          objectStoreNames: { contains: () => true },
          createObjectStore: () => {},
          close: () => {},
          transaction() {
            const tx = { error: null, oncomplete: null, onerror: null, onabort: null }
            const settle = () => { setTimeout(() => { if (tx.oncomplete != null) tx.oncomplete() }, 0) }
            const store = {
              get() { const req = { result: record, error: null }; settle(); return req },
              put() { const req = { result: undefined, error: null }; settle(); return req },
              delete() { const req = { result: undefined, error: null }; settle(); return req },
            }
            tx.objectStore = () => store
            return tx
          },
        }
        request.result = db
        if (request.onsuccess != null) request.onsuccess()
      }, 0)
      return request
    },
  }
}

/** Collect every stubbed React element whose className contains one token. */
function findByClass(tree, className) {
  const found = []
  const visit = (node) => {
    if (node == null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    // Shallow-render custom components (e.g. Slider) the way React would, so the
    // walker reaches their host elements. Every one of them is hook-free by design.
    if (typeof node.type === 'function') {
      let rendered
      try {
        rendered = node.type(node.props)
      } catch (error) {
        return
      }
      visit(rendered)
      return
    }
    const props = node.props
    if (props != null && typeof props.className === 'string'
      && props.className.split(/\s+/).indexOf(className) !== -1) {
      found.push(node)
    }
    if (Array.isArray(node.children)) node.children.forEach(visit)
  }
  visit(tree)
  return found
}

function makeCtx(record) {
  return {
    locale: {
      register(ns, locale, dict) {
        record.dicts.push({ ns, locale, dict })
        return () => {}
      },
    },
    slots: {
      inject(name, callback) {
        record.injected.push(name)
        return callback()
      },
      register(entry, component) {
        record.entries.push({ entry, component })
        return () => {}
      },
    },
    effect(callback, label) {
      record.effects.push(label)
      let disposer
      try {
        disposer = callback()
      } catch (error) {
        record.effectErrors.push(String(error && error.message))
      }
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    on(name) { record.events.push(name) },
    inject(_keys, callback) { callback(this) },
    provide() {},
  }
}

function tick() {
  return new Promise(resolve => setTimeout(resolve, 0))
}

async function main() {
  const source = fs.readFileSync(BUNDLE, 'utf8')

  process.stdout.write('bundle: ' + BUNDLE + '\n\n== source purity ==\n')
  const specifiers = []
  const requirePattern = /require\(\s*['"]([^'"]+)['"]\s*\)/g
  let match
  while ((match = requirePattern.exec(source)) !== null) specifiers.push(match[1])
  check('only the react baseline is required', JSON.stringify(specifiers) === JSON.stringify(['react']),
    'found ' + JSON.stringify(specifiers))
  check('registers through __ModuleLoader__.load', source.indexOf('window.__ModuleLoader__.load(') !== -1)
  check('declares the package id', source.indexOf("id: 'dsh-bg-changer'") !== -1)
  check('no host-side import statements', !/^\s*import\s/m.test(source))

  process.stdout.write('\n== module registration ==\n')
  const { document, counters } = makeDocumentStub()
  const store = new Map()
  globalThis.window = {
    __ModuleLoader__: { load(registration) { globalThis.__registration = registration } },
    innerWidth: 1600,
    innerHeight: 900,
    addEventListener() {},
    removeEventListener() {},
  }
  globalThis.document = document
  globalThis.localStorage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)) },
    removeItem: key => { store.delete(key) },
  }
  delete globalThis.indexedDB

  const requireStub = (id) => {
    if (id === 'react') {
      return {
        createElement: (...args) => ({ type: args[0], props: args[1], children: args.slice(2) }),
        Fragment: 'Fragment',
        useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
        useEffect: () => {},
        useRef: () => ({ current: null }),
        useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
      }
    }
    throw new Error('unexpected require: ' + id)
  }

  // eslint-disable-next-line no-new-func
  new Function(source)()
  const registration = globalThis.__registration
  check('registration captured', registration != null)
  equal('registration id is the package name', registration && registration.id, 'dsh-bg-changer')
  equal('factory is a function', typeof (registration && registration.factory), 'function')

  const mod = registration.factory(requireStub)
  equal('exports apply', typeof mod.apply, 'function')
  check('exports inject', Array.isArray(mod.inject) && mod.inject.join(',') === 'slots,locale',
    'got ' + JSON.stringify(mod.inject))

  process.stdout.write('\n== apply wiring ==\n')
  const record = { dicts: [], entries: [], injected: [], effects: [], events: [], effectErrors: [] }
  const ctx = makeCtx(record)
  mod.apply(ctx)
  const writesDuringApply = counters.created + counters.appended + counters.inserted
  await tick()
  await tick()

  equal('injects exactly one slot', record.injected.join(','), 'settings.general.item')
  equal('registers exactly one entry', record.entries.length, 1)
  const entry = record.entries[0]
  equal('entry slot name', entry && entry.entry.name, 'settings.general.item')
  equal('entry id', entry && entry.entry.id, 'bg-changer')
  check('entry order is below every shipped row', entry && entry.entry.order > 20,
    'order ' + (entry && entry.entry.order))
  equal('entry locale namespace', entry && entry.entry.locale, 'settings.bgChanger')
  equal('entry component is a function', typeof (entry && entry.component), 'function')
  check('zh dictionary registered', record.dicts.some(d => d.ns === 'settings.bgChanger' && d.locale === 'zh'))
  check('en dictionary registered', record.dicts.some(d => d.ns === 'settings.bgChanger' && d.locale === 'en'))
  check('dictionary keys match between locales', (() => {
    const zh = record.dicts.find(d => d.locale === 'zh')
    const en = record.dicts.find(d => d.locale === 'en')
    if (zh == null || en == null) return false
    return JSON.stringify(Object.keys(zh.dict).sort()) === JSON.stringify(Object.keys(en.dict).sort())
  })())
  check('no effect threw', record.effectErrors.length === 0, record.effectErrors.join('; '))
  check('no DOM writes at apply or right after', writesDuringApply === 0 && counters.created === 0,
    'created ' + counters.created + ', appended ' + counters.appended + ', inserted ' + counters.inserted)
  equal('no wallpaper is set with an empty store', store.has('dsh-bg-changer:config:v1'), false)

  process.stdout.write('\n== pure helpers ==\n')
  const internals = mod.__internals
  check('internals exported', internals != null && typeof internals.computeGeometry === 'function')
  const { computeGeometry, alphaFor, parseRgb, clamp } = internals

  const cover = computeGeometry({ fit: 'cover', scale: 100, offsetX: 0, offsetY: 0, viewW: 1600, viewH: 900, imgW: 4000, imgH: 3000 })
  equal('cover size', cover.size, '1600.00px 1200.00px')
  equal('cover position', cover.position, 'calc(50% + 0.00px) calc(50% + 0.00px)')
  equal('cover repeat', cover.repeat, 'no-repeat')
  near('cover overflowY', cover.overflowY, 300)
  near('cover overflowX', cover.overflowX, 0)

  const coverDown = computeGeometry({ fit: 'cover', scale: 100, offsetX: 0, offsetY: 100, viewW: 1600, viewH: 900, imgW: 4000, imgH: 3000 })
  near('cover max vertical offset stays inside the overflow', coverDown.ty, cover.overflowY / 2)
  const coverHalf = computeGeometry({ fit: 'cover', scale: 100, offsetX: 0, offsetY: 50, viewW: 1600, viewH: 900, imgW: 4000, imgH: 3000 })
  near('cover half vertical offset', coverHalf.ty, cover.overflowY / 4)

  const contain = computeGeometry({ fit: 'contain', scale: 100, offsetX: 100, offsetY: 0, viewW: 1600, viewH: 900, imgW: 4000, imgH: 3000 })
  equal('contain size', contain.size, '1200.00px 900.00px')
  near('contain cannot pan when it fits', contain.tx, 0)

  const stretched = computeGeometry({ fit: 'stretch', scale: 100, offsetX: 0, offsetY: 0, viewW: 1600, viewH: 900, imgW: 400, imgH: 400 })
  equal('stretch size', stretched.size, '1600.00px 900.00px')

  const tiled = computeGeometry({ fit: 'tile', scale: 200, offsetX: 100, offsetY: 0, viewW: 1600, viewH: 900, imgW: 400, imgH: 300 })
  equal('tile repeats', tiled.repeat, 'repeat')
  equal('tile size', tiled.size, '800.00px 600.00px')
  near('tile horizontal phase', tiled.tx, 400)

  const clamped = computeGeometry({ fit: 'cover', scale: 1000, offsetX: 0, offsetY: 0, viewW: 1600, viewH: 900, imgW: 1600, imgH: 900 })
  equal('scale clamps to 300%', clamped.size, '4800.00px 2700.00px')
  const floored = computeGeometry({ fit: 'cover', scale: 1, offsetX: 0, offsetY: 0, viewW: 1600, viewH: 900, imgW: 1600, imgH: 900 })
  equal('scale clamps to 50%', floored.size, '800.00px 450.00px')

  near('alpha floor 0 at 65%', alphaFor(0, 0.65), 0.65)
  near('alpha floor keeps buttons readable', alphaFor(0.65, 0.65), 0.8775)
  near('alpha 100% is fully opaque', alphaFor(0, 1), 1)
  near('alpha 0% keeps the floor', alphaFor(0.55, 0), 0.55)

  check('parseRgb opaque', JSON.stringify(parseRgb('rgb(21, 21, 23)')) === JSON.stringify({ r: 21, g: 21, b: 23 }))
  check('parseRgb slash syntax', JSON.stringify(parseRgb('rgb(1 2 3 / 0.5)')) === JSON.stringify({ r: 1, g: 2, b: 3 }))
  check('parseRgb transparent is unresolved', parseRgb('rgba(0, 0, 0, 0)') === null)
  check('parseRgb garbage is unresolved', parseRgb('color-mix(in srgb, red, blue)') === null)

  near('clamp below range', clamp(-5, 0, 100), 0)
  near('clamp above range', clamp(500, 0, 100), 100)
  near('clamp non-number', clamp('nope', 3, 9), 3)

  check('surface tokens cover the base surfaces', internals.SURFACE_TOKENS.indexOf('--dsw-alias-bg-base') !== -1
    && internals.SURFACE_TOKENS.indexOf('--dsw-alias-bg-layer-2') !== -1
    && internals.SURFACE_TOKENS.indexOf('--dsw-alias-bg-mask-1') !== -1)
  check('base css keeps the app above the wallpaper', internals.BASE_CSS.indexOf('#root{position:relative;z-index:1') !== -1)
  check('base css clears the opaque body background', internals.BASE_CSS.indexOf('body{background:transparent !important}') !== -1)

  process.stdout.write('\n== persisted wallpaper: restore, style, layers, row render ==\n')
  const stored = {
    enabled: true, fit: 'cover', scale: 150, offsetX: 25, offsetY: -40,
    imageOpacity: 80, blur: 10, dim: 20, surfaceOpacity: 60,
  }
  const assetRecord = {
    blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    name: 'wallpaper.png', type: 'image/png', size: 3, width: 4000, height: 3000, savedAt: 1,
  }
  const phase2 = makeDocumentStub()
  const phase2Store = new Map([['dsh-bg-changer:config:v1', JSON.stringify(stored)]])
  globalThis.window = {
    __ModuleLoader__: { load(registration) { globalThis.__registration2 = registration } },
    innerWidth: 1600,
    innerHeight: 900,
    addEventListener() {},
    removeEventListener() {},
  }
  globalThis.document = phase2.document
  globalThis.localStorage = {
    getItem: key => (phase2Store.has(key) ? phase2Store.get(key) : null),
    setItem: (key, value) => { phase2Store.set(key, String(value)) },
    removeItem: key => { phase2Store.delete(key) },
  }
  globalThis.indexedDB = makeIndexedDb(assetRecord)
  globalThis.getComputedStyle = () => ({ backgroundColor: 'rgb(21, 21, 23)' })
  URL.createObjectURL = () => 'blob:dsh-bg-changer-verify'
  URL.revokeObjectURL = () => {}

  // eslint-disable-next-line no-new-func
  new Function(source)()
  const mod2 = globalThis.__registration2.factory(requireStub)
  const record2 = { dicts: [], entries: [], injected: [], effects: [], events: [], effectErrors: [] }
  mod2.apply(makeCtx(record2))
  for (let i = 0; i < 8; i += 1) await tick()

  const layer = phase2.document.body.children.find(child => child.id === 'dsh-bg-layer')
  const scrim = phase2.document.body.children.find(child => child.id === 'dsh-bg-scrim')
  check('wallpaper layer created', layer != null)
  check('dim scrim sits right after the layer', scrim != null
    && phase2.document.body.children.indexOf(scrim) === phase2.document.body.children.indexOf(layer) + 1)
  const styleElement = phase2.document.head.children.find(child => child.attributes['data-dsh-bg-plugin'] === '1')
  check('plugin stylesheet created', styleElement != null)
  check('stylesheet is the last head child (re-assert)', styleElement != null
    && phase2.document.head.children[phase2.document.head.children.length - 1] === styleElement)
  const styleText = styleElement == null ? '' : styleElement.textContent
  check('stylesheet clears the body background', styleText.indexOf('body{background:transparent !important}') !== -1)
  check('stylesheet lifts #root above the wallpaper', styleText.indexOf('#root{position:relative;z-index:1') !== -1)
  check('stylesheet emits surface overrides', styleText.indexOf('--dsw-alias-bg-base: rgba(21, 21, 23,') !== -1
    && styleText.indexOf('--dsw-alias-bg-mask-1: rgba(21, 21, 23,') !== -1)
  check('surface alpha follows the slider', styleText.indexOf('rgba(21, 21, 23, 0.6000)') !== -1)

  const rootProps = phase2.document.documentElement.style.properties
  check('backdrop pinned to the probed theme color', rootProps['--dsh-bg-backdrop'] === 'rgb(21, 21, 23)')
  check('image variable set', String(rootProps['--dsh-bg-image'] || '').indexOf('url("') === 0)
  check('geometry covers the viewport plus bleed', /^\d+\.\d{2}px \d+\.\d{2}px$/.test(String(rootProps['--dsh-bg-size']))
    && Number(String(rootProps['--dsh-bg-size']).split('px')[0]) > 1600,
  String(rootProps['--dsh-bg-size']))
  equal('blur variable', rootProps['--dsh-bg-filter'], 'blur(10px)')
  equal('blur bleed inflates the layer', rootProps['--dsh-bg-bleed'], '-30px')
  equal('image opacity variable', rootProps['--dsh-bg-opacity'], '0.8')
  equal('dim scrim variable', rootProps['--dsh-bg-scrim'], 'rgba(0, 0, 0, 0.2)')

  const component = record2.entries[0].component
  const t = key => key
  let tree = component({ t })
  const head = findByClass(tree, 'dshbg-head')[0]
  check('row renders a header toggle', head != null && typeof head.props.onClick === 'function')
  check('collapsed row has no control body', findByClass(tree, 'dshbg-body').length === 0)
  head.props.onClick()
  tree = component({ t })
  check('expanded row renders the body', findByClass(tree, 'dshbg-body').length === 1)
  check('expanded row renders the crop preview', findByClass(tree, 'dshbg-preview').length === 1)
  const sliders = findByClass(tree, 'dshbg-range')
  check('expanded row renders every slider', sliders.length === 7, 'found ' + sliders.length)
  const chips = findByClass(tree, 'dshbg-chip')
  equal('expanded row renders the four fit chips', chips.length, 4)
  equal('active chip follows the stored fit', chips.filter(chip => chip.props['aria-pressed'] === 'true').length, 1)
  const opacitySlider = sliders.find(slider => slider.props['aria-label'] === 'effect.opacity')
  check('slider reflects the stored value', opacitySlider != null && opacitySlider.props.value === '80',
    opacitySlider == null ? 'missing' : String(opacitySlider.props.value))
  const previewCanvas = findByClass(tree, 'dshbg-preview')[0]
  check('preview mirrors the viewport aspect ratio', String(previewCanvas.props.style.aspectRatio) === '1600 / 900',
    String(previewCanvas.props.style.aspectRatio))
  check('preview paints the same image', String(previewCanvas.props.style.backgroundImage).indexOf('url("blob:') === 0,
    String(previewCanvas.props.style.backgroundImage))
  check('preview falls back to cover until it is measured', previewCanvas.props.style.backgroundSize === 'cover')

  opacitySlider.props.onChange({ target: { value: '35' } })
  await tick()
  equal('slider write reaches the root variable', phase2.document.documentElement.style.properties['--dsh-bg-opacity'], '0.35')

  const clearButton = findByClass(tree, 'dshbg-btn').find(button => button.props.className.indexOf('is-danger') !== -1)
  check('clear button exists', clearButton != null)
  clearButton.props.onClick()
  for (let i = 0; i < 6; i += 1) await tick()
  check('clearing removes the layer', phase2.document.body.children.every(child => child.id !== 'dsh-bg-layer'))
  check('clearing removes the stylesheet', phase2.document.head.children.every(child => child.attributes['data-dsh-bg-plugin'] !== '1'))
  check('clearing drops every plugin variable', Object.keys(phase2.document.documentElement.style.properties).length === 0,
    JSON.stringify(phase2.document.documentElement.style.properties))
  check('clearing forgets the stored config', phase2Store.has('dsh-bg-changer:config:v1') === false)

  process.stdout.write('\n' + passed + ' checks passed, ' + failures.length + ' failed\n')
  if (failures.length > 0) {
    process.stdout.write('\nfailures:\n' + failures.map(failure => '  - ' + failure).join('\n') + '\n')
    process.exitCode = 1
  }
}

main().catch((error) => {
  process.stderr.write('verify-bundle: ' + (error && error.stack ? error.stack : String(error)) + '\n')
  process.exitCode = 1
})
