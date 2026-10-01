#!/usr/bin/env node
/**
 * dsh-bg-changer bundle smoke test.
 *
 * Loads `lib/client.js` the way the client module system does (a
 * `window.__ModuleLoader__.load({id, factory})` registration), runs `apply()`
 * against a fake Cordis context, and checks the plugin wiring, the pure
 * geometry/alpha helpers, the persisted-wallpaper pipeline and the lifecycle
 * guards. It never touches the network, the file system outside this package,
 * or a real browser.
 *
 * The fake environment is deliberately faithful where it matters:
 * - `requestAnimationFrame` is a real queue, so the coalesced renderer is
 *   exercised instead of bypassed (`flushFrames()` drains one frame);
 * - the document stub tracks `nextSibling`/`firstChild`, so "the stylesheet
 *   stays last in <head>" and "the scrim sits right after the layer" are real
 *   assertions rather than artefacts of the stub;
 * - the element style tracks written properties, so per-variable diffing is
 *   measurable;
 * - React is modelled with ref slots, state slots, executing effects and a
 *   real external-store subscription.
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

/** Minimal but faithful DOM stub: mutation counters, real sibling links. */
function makeDocumentStub() {
  const counters = { created: 0, appended: 0, inserted: 0, removed: 0, stylesheetWrites: 0 }
  const makeStyle = () => {
    const properties = {}
    let writes = 0
    return {
      properties,
      get writes() { return writes },
      get size() { return Object.keys(properties).length },
      setProperty(name, value) {
        const next = String(value)
        if (properties[name] !== next) {
          writes += 1
          counters.stylesheetWrites += 1
        }
        properties[name] = next
      },
      getPropertyValue(name) {
        return Object.prototype.hasOwnProperty.call(properties, name) ? properties[name] : ''
      },
      removeProperty(name) { delete properties[name] },
    }
  }
  const makeElement = (tag) => {
    const element = {
      tagName: String(tag).toUpperCase(),
      id: '',
      parent: null,
      isConnected: false,
      children: [],
      style: makeStyle(),
      dataset: {},
      className: '',
      textContent: '',
      value: '',
      attributes: {},
      get firstChild() { return this.children.length > 0 ? this.children[0] : null },
      get nextSibling() {
        const parent = this.parent
        if (parent == null) return null
        const index = parent.children.indexOf(this)
        return index >= 0 && index + 1 < parent.children.length ? parent.children[index + 1] : null
      },
      setAttribute(name, value) { this.attributes[name] = String(value) },
      removeAttribute(name) { delete this.attributes[name] },
      hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) },
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null
      },
      appendChild(child) {
        counters.appended += 1
        this.children.push(child)
        child.isConnected = true
        child.parent = this
        return child
      },
      insertBefore(child, reference) {
        counters.inserted += 1
        const index = reference == null ? -1 : this.children.indexOf(reference)
        if (index < 0) this.children.push(child)
        else this.children.splice(index, 0, child)
        child.isConnected = true
        child.parent = this
        return child
      },
      getBoundingClientRect() { return this.rect || { width: 0, height: 0, x: 0, y: 0 } },
      append(...nodes) { nodes.forEach(node => this.appendChild(node)) },
      remove() {
        counters.removed += 1
        this.isConnected = false
        const parent = this.parent
        if (parent != null) {
          const index = parent.children.indexOf(this)
          if (index >= 0) parent.children.splice(index, 1)
        }
        this.parent = null
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
  const document = {
    head,
    body,
    documentElement: { style: makeStyle(), clientWidth: 1600, clientHeight: 900 },
    createElement(tag) { counters.created += 1; return makeElement(tag) },
    getElementById(id) { return document.body.children.find(child => child.id === id) || null },
    querySelector() { return null },
  }
  return { document, counters }
}

/** In-memory IndexedDB stub over a per-key record map (missing key = empty slot). */
function makeIndexedDb(recordsByKey) {
  const records = recordsByKey || {}
  return {
    records,
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
              get(key) { const req = { result: records[key] == null ? undefined : records[key], error: null }; settle(); return req },
              put(record, key) { records[key] = record; const req = { result: key, error: null }; settle(); return req },
              delete(key) { delete records[key]; const req = { result: undefined, error: null }; settle(); return req },
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
  return findByProps(tree, node => typeof node.props.className === 'string'
    && node.props.className.split(/\s+/).indexOf(className) !== -1)
}

/** Collect every stubbed React element matching a props predicate. */
function findByProps(tree, predicate) {
  const found = []
  const visit = (node) => {
    if (node == null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    // Shallow-render custom components (e.g. Slider) the way React would, so the
    // walker reaches their host elements.
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
    if (props != null && predicate(node)) found.push(node)
    if (Array.isArray(node.children)) node.children.forEach(visit)
  }
  visit(tree)
  return found
}

/** The single text node of a stub element, flattened. */
function textOf(node) {
  if (node == null) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node !== 'object') return ''
  return (node.children || []).map(textOf).join('')
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
      record.disposers.push(() => {
        if (typeof disposer === 'function') disposer()
      })
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    on(name, handler) {
      record.events.push(name)
      if (typeof handler === 'function') record.handlers[name] = handler
    },
    inject(_keys, callback) { callback(this) },
    provide() {},
  }
}

function tick() {
  return new Promise(resolve => setTimeout(resolve, 0))
}

/** A real animation-frame queue: the coalesced renderer needs draining. */
const frameQueue = []
let frameSeq = 0
function flushFrames() {
  const pending = frameQueue.splice(0, frameQueue.length)
  pending.forEach((callback) => { if (typeof callback === 'function') callback() })
}

/** Build the React double with ref slots, state slots and executing effects. */
function makeReactStub() {
  const refs = []
  const states = []
  const subscriptions = []
  const effectCleanups = []
  let refIndex = 0
  let stateIndex = 0
  return {
    refs,
    states,
    subscriptions,
    effectCleanups,
    resetSlots() { refIndex = 0; stateIndex = 0 },
    react: {
      createElement: (...args) => ({ type: args[0], props: args[1], children: args.slice(2) }),
      Fragment: 'Fragment',
      useState: (initial) => {
        const index = stateIndex
        stateIndex += 1
        if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
        return [states[index], (next) => {
          states[index] = typeof next === 'function' ? next(states[index]) : next
        }]
      },
      useEffect: (callback) => {
        effectCleanups.push(callback())
      },
      useRef: () => {
        const index = refIndex
        refIndex += 1
        if (!(index in refs)) refs[index] = { current: null }
        return refs[index]
      },
      useSyncExternalStore: (subscribe, getSnapshot) => {
        if (subscriptions.indexOf(subscribe) === -1) subscriptions.push(subscribe)
        return getSnapshot()
      },
    },
  }
}

/** Install the globals one phase needs; returns the bundle's module exports. */
function loadBundle(source, options) {
  const reactStub = makeReactStub()
  const dom = makeDocumentStub()
  const store = new Map(options.stored || [])
  const createdBlobs = []
  const indexedDb = options.indexedDB === false ? null : makeIndexedDb(options.records || {})
  globalThis.window = {
    __ModuleLoader__: { load(registration) { globalThis.__registration = registration } },
    innerWidth: 1600,
    innerHeight: 900,
    addEventListener() {},
    removeEventListener() {},
  }
  globalThis.document = dom.document
  globalThis.localStorage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)) },
    removeItem: key => { store.delete(key) },
  }
  if (indexedDb == null) delete globalThis.indexedDB
  else globalThis.indexedDB = indexedDb
  globalThis.getComputedStyle = options.getComputedStyle || (() => ({ backgroundColor: 'rgb(21, 21, 23)' }))
  globalThis.requestAnimationFrame = (callback) => { frameQueue.push(callback); frameSeq += 1; return frameSeq }
  globalThis.cancelAnimationFrame = (id) => {
    const index = id - 1
    if (index >= 0 && index < frameQueue.length) frameQueue[index] = null
  }
  // Blob URLs are unique per call, so light/dark are distinguishable.
  globalThis.URL.createObjectURL = (blob) => { createdBlobs.push(blob); return 'blob:dsh-bg-changer-verify-' + createdBlobs.length }
  globalThis.URL.revokeObjectURL = () => {}
  globalThis.FileReader = class FakeFileReader {
    readAsDataURL(blob) {
      blob.arrayBuffer().then((buffer) => {
        this.result = 'data:' + (blob.type || '') + ';base64,' + Buffer.from(buffer).toString('base64')
        if (this.onload != null) this.onload()
      }, (error) => { this.error = error; if (this.onerror != null) this.onerror(error) })
    }
    readAsText(blob) {
      blob.text().then((text) => {
        this.result = text
        if (this.onload != null) this.onload()
      }, (error) => { this.error = error; if (this.onerror != null) this.onerror(error) })
    }
  }

  // eslint-disable-next-line no-new-func
  new Function(source)()
  const mod = globalThis.__registration.factory(id => {
    if (id === 'react') return reactStub.react
    throw new Error('unexpected require: ' + id)
  })
  return { mod, reactStub, dom, store, indexedDb, createdBlobs }
}

/** Render the registered row once, with fresh hook slots. */
function renderRow(reactStub, component) {
  reactStub.resetSlots()
  return component({ t: key => key })
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
  check('no synchronous render call hangs off update()', source.indexOf('render()\n      persistConfig()') === -1)

  process.stdout.write('\n== module registration ==\n')
  const phase1 = loadBundle(source, { indexedDB: false })
  const registration = globalThis.__registration
  check('registration captured', registration != null)
  equal('registration id is the package name', registration && registration.id, 'dsh-bg-changer')
  equal('factory is a function', typeof (registration && registration.factory), 'function')

  const mod = phase1.mod
  equal('exports apply', typeof mod.apply, 'function')
  check('exports inject', Array.isArray(mod.inject) && mod.inject.join(',') === 'slots,locale',
    'got ' + JSON.stringify(mod.inject))
  const internals = mod.__internals
  check('internals exported', internals != null && typeof internals.computeGeometry === 'function')

  process.stdout.write('\n== apply wiring ==\n')
  const record = { dicts: [], entries: [], injected: [], effects: [], events: [], effectErrors: [], disposers: [], handlers: {} }
  const ctx = makeCtx(record)
  mod.apply(ctx)
  await tick()
  await tick()
  flushFrames()

  equal('injects exactly one slot', record.injected.join(','), 'settings.general.item')
  equal('registers exactly one entry', record.entries.length, 1)
  const entry = record.entries[0]
  equal('entry slot name', entry && entry.entry.name, 'settings.general.item')
  equal('entry id', entry && entry.entry.id, 'bg-changer')
  equal('entry order sits after every shipped row', entry && entry.entry.order, internals.ROW_ORDER)
  check('entry order clears the shipped maximum (100)', internals.ROW_ORDER > 100, 'order ' + internals.ROW_ORDER)
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
  // The row must be styled from the moment it is mounted — including the
  // "nothing set yet" state, which is exactly what 0.1.x/0.2.0 got wrong.
  const styleAtApply = phase1.dom.document.head.children.find(child => child.attributes['data-dsh-bg-plugin'] === '1')
  check('apply injects the row stylesheet', styleAtApply != null
    && styleAtApply.textContent.indexOf('.dshbg-row') !== -1)
  check('a styleless row is impossible: the sheet is the base one', styleAtApply != null
    && styleAtApply.textContent === internals.BASE_CSS)
  check('apply paints no wallpaper layer', phase1.dom.document.body.children.length === 0,
    'body children: ' + phase1.dom.document.body.children.map(child => child.id || child.tagName).join(','))
  check('apply sets no plugin variable',
    Object.keys(phase1.dom.document.documentElement.style.properties).length === 0,
    JSON.stringify(phase1.dom.document.documentElement.style.properties))
  equal('no wallpaper is set with an empty store', phase1.store.has('dsh-bg-changer:config:v1'), false)

  process.stdout.write('\n== pure helpers ==\n')
  const { computeGeometry, alphaFor, parseRgb, clamp, svgHasExternalReferences } = internals

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

  check('parseRgb opaque keeps alpha 1', JSON.stringify(parseRgb('rgb(21, 21, 23)')) === JSON.stringify({ r: 21, g: 23 - 2, b: 23, a: 1 }))
  check('parseRgb slash syntax keeps the original alpha', JSON.stringify(parseRgb('rgb(1 2 3 / 0.5)')) === JSON.stringify({ r: 1, g: 2, b: 3, a: 0.5 }))
  check('parseRgb transparent is unresolved', parseRgb('rgba(0, 0, 0, 0)') === null)
  check('parseRgb color-mix is unresolved', parseRgb('color-mix(in srgb, red, blue)') === null)

  near('clamp below range', clamp(-5, 0, 100), 0)
  near('clamp above range', clamp(500, 0, 100), 100)
  near('clamp non-number', clamp('nope', 3, 9), 3)

  check('a clean SVG passes the external-reference guard',
    svgHasExternalReferences('<svg xmlns="http://www.w3.org/2000/svg"><use href="#pin"/></svg>') === false)
  check('an SVG <image> reference is refused',
    svgHasExternalReferences('<svg><image href="https://tracker.example/x.png"/></svg>') === true)
  check('an SVG <script> is refused',
    svgHasExternalReferences('<svg><script>alert(1)</script></svg>') === true)
  check('an SVG <foreignObject> is refused',
    svgHasExternalReferences('<svg><foreignObject/></svg>') === true)
  check('an SVG url() reference is refused',
    svgHasExternalReferences('<svg><rect style="fill:url(http://x/y)"/></svg>') === true)
  check('an SVG with no text is refused', svgHasExternalReferences('') === true)

  check('upload size cap is finite and below the storage budget',
    internals.MAX_UPLOAD_BYTES > internals.MAX_KEEP_BYTES && internals.MAX_UPLOAD_BYTES <= 64 * 1024 * 1024,
    String(internals.MAX_UPLOAD_BYTES))
  check('pixel cap is finite', internals.MAX_PIXELS > 0 && internals.MAX_PIXELS < Infinity, String(internals.MAX_PIXELS))

  check('surface tokens cover the base surfaces', internals.SURFACE_TOKENS.indexOf('--dsw-alias-bg-base') !== -1
    && internals.SURFACE_TOKENS.indexOf('--dsw-alias-bg-layer-2') !== -1
    && internals.SURFACE_TOKENS.indexOf('--dsw-alias-bg-mask-1') !== -1)
  // 0.2.0-rc.2 paints the sidebar with its own token; missing it leaves the
  // sidebar fully opaque (the "nothing changed" report of 2026-10-01).
  check('surface tokens cover the rc.2 sidebar fill',
    internals.SURFACE_TOKENS.indexOf('--dsw-specific-sidebar-fill') !== -1)
  check('surface tokens cover the read-through text surfaces',
    internals.SURFACE_TOKENS.indexOf('--dsw-specific-bubble') !== -1
    && internals.SURFACE_TOKENS.indexOf('--dsw-specific-input-major') !== -1
    && internals.SURFACE_TOKENS.indexOf('--dsw-alias-bg-overlay') !== -1)
  check('text-carrying surfaces keep a readability floor', (() => {
    return internals.ALPHA_FLOOR['--dsw-specific-bubble'] > 0.4
      && internals.ALPHA_FLOOR['--dsw-specific-input-major'] > 0.4
      && internals.ALPHA_FLOOR['--dsw-alias-bg-overlay'] > 0.4
      && internals.ALPHA_FLOOR['--dsw-specific-sidebar-fill'] === 0
  })())
  check('base css keeps the app above the wallpaper', internals.BASE_CSS.indexOf('#root{position:relative;z-index:1') !== -1)
  check('base css clears the opaque body background', internals.BASE_CSS.indexOf('body{background:transparent !important}') !== -1)
  // A broken rule would silently drop styling for the whole row (the 0.3.0 bug).
  check('the base stylesheet has balanced braces', (() => {
    const opens = (internals.BASE_CSS.match(/\{/g) || []).length
    const closes = (internals.BASE_CSS.match(/\}/g) || []).length
    return opens > 10 && opens === closes
  })(), 'braces in BASE_CSS')
  check('the row stylesheet carries every control class', [
    '.dshbg-row', '.dshbg-head', '.dshbg-body', '.dshbg-slot', '.dshbg-drop',
    '.dshbg-range', '.dshbg-preview', '.dshbg-btn', '.dshbg-msg', '.dshbg-paste-area',
  ].every(selector => internals.BASE_CSS.indexOf(selector) !== -1))
  check('every new message key exists in both dictionaries', (() => {
    const required = ['message.tooLarge', 'message.tooManyPixels', 'message.decodeTimeout',
      'message.svgRefused', 'message.svgRasterized', 'message.transparencyUnavailable',
      'image.light', 'image.dark', 'image.inUse', 'group.backup',
      'backup.export', 'backup.copy', 'backup.import', 'backup.paste', 'backup.confirm',
      'message.exported', 'message.copied', 'message.copyFailed', 'message.imported',
      'message.importedNoImage', 'message.importFailed', 'message.importTooLarge', 'status.dark']
    return required.every(key => internals.TEXTS.zh[key] != null && internals.TEXTS.en[key] != null)
  })())

  process.stdout.write('\n== backup format and data-url helpers ==\n')
  const { buildBackup, parseBackup, dataUrlToBlob, safeImageUrl, downloadText } = internals
  const samplePng = Buffer.from([1, 2, 3, 4, 5]).toString('base64')
  const sampleConfig = Object.assign({}, internals.DEFAULTS, { enabled: true, scale: 133 })
  const sampleImages = {
    light: { name: 'day.png', type: 'image/png', width: 10, height: 20, dataUrl: 'data:image/png;base64,' + samplePng },
  }
  const roundTrip = parseBackup(JSON.stringify(buildBackup(sampleConfig, sampleImages, 0)))
  equal('a backup round-trips its config', roundTrip.config.scale, 133)
  equal('a backup round-trips its image', roundTrip.images.light.dataUrl, sampleImages.light.dataUrl)
  equal('a backup stamps its format', buildBackup(sampleConfig, {}, 0).format, internals.BACKUP_FORMAT)
  check('a backup timestamp is ISO', /^\d{4}-\d{2}-\d{2}T/.test(buildBackup(sampleConfig, {}, 0).exportedAt))

  check('a foreign JSON is refused', (() => {
    try { parseBackup('{"hello":"world"}'); return false } catch (error) { return error.noticeKey === 'message.importFailed' }
  })())
  check('a newer backup version is refused', (() => {
    const future = JSON.stringify({ format: internals.BACKUP_FORMAT, version: internals.BACKUP_VERSION + 1, config: {} })
    try { parseBackup(future); return false } catch (error) { return error.noticeKey === 'message.importFailed' }
  })())
  check('a broken JSON is refused', (() => {
    try { parseBackup('{not json'); return false } catch (error) { return error.noticeKey === 'message.importFailed' }
  })())
  check('an oversized backup is refused', (() => {
    try { parseBackup('x'.repeat(internals.MAX_BACKUP_BYTES + 1)); return false } catch (error) { return error.noticeKey === 'message.importTooLarge' }
  })())
  check('a backup without config is refused', (() => {
    try { parseBackup(JSON.stringify({ format: internals.BACKUP_FORMAT, version: 1 })); return false } catch (error) { return error.noticeKey === 'message.importFailed' }
  })())
  check('an unknown image slot in a backup is ignored', (() => {
    const parsed = parseBackup(JSON.stringify(buildBackup(sampleConfig, { evil: sampleImages.light, light: sampleImages.light })))
    return Object.keys(parsed.images).join(',') === 'light'
  })())

  const decoded = dataUrlToBlob(sampleImages.light.dataUrl)
  check('a base64 data url decodes to a blob', decoded != null && decoded.size === 5 && decoded.type === 'image/png',
    decoded == null ? 'null' : decoded.size + '/' + decoded.type)
  check('a non-data url is not decodable', dataUrlToBlob('https://example.com/x.png') == null)
  check('a text data url decodes without base64', (() => {
    const blob = dataUrlToBlob('data:text/plain,hello%20world')
    return blob != null && blob.type === 'text/plain'
  })())
  check('safeImageUrl keeps blob urls', safeImageUrl('blob:x') === 'blob:x')
  check('safeImageUrl keeps image data urls', safeImageUrl('data:image/png;base64,AA') === 'data:image/png;base64,AA')
  check('safeImageUrl refuses remote urls', safeImageUrl('https://tracker.example/x.png') == null)
  check('safeImageUrl refuses javascript', safeImageUrl('javascript:alert(1)') == null)
  check('the light and dark slots use different storage keys',
    internals.IDB_KEY !== internals.IDB_KEY_DARK && internals.LS_IMAGE !== internals.LS_IMAGE_DARK)
  check('downloadText reports success with a working DOM', downloadText('{"a":1}', 'x.json') === true)

  process.stdout.write('\n== persisted wallpaper: restore, style, layers, row render ==\n')
  const stored = {
    enabled: true, fit: 'cover', scale: 150, offsetX: 25, offsetY: -40,
    imageOpacity: 80, blur: 10, dim: 20, surfaceOpacity: 60,
  }
  const assetRecord = {
    blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    name: 'wallpaper.png', type: 'image/png', size: 3, width: 4000, height: 3000, savedAt: 1,
  }
  const phase2 = loadBundle(source, {
    stored: [['dsh-bg-changer:config:v1', JSON.stringify(stored)]],
    records: { [internals.IDB_KEY]: assetRecord, [internals.IDB_KEY_DARK]: assetRecord },
  })
  const record2 = { dicts: [], entries: [], injected: [], effects: [], events: [], effectErrors: [], disposers: [], handlers: {} }
  // A fake app shell inside #root: one window-sized element carrying the sidebar
  // colour (the Windows frame) and one small panel with the same colour.
  const fakeRoot = phase2.dom.document.createElement('div')
  fakeRoot.id = 'root'
  const wideFrame = phase2.dom.document.createElement('div')
  wideFrame.rect = { width: 1600, height: 900 }
  const smallPanel = phase2.dom.document.createElement('div')
  smallPanel.rect = { width: 120, height: 60 }
  fakeRoot.appendChild(wideFrame)
  fakeRoot.appendChild(smallPanel)
  phase2.dom.document.body.appendChild(fakeRoot)
  phase2.mod.apply(makeCtx(record2))
  for (let i = 0; i < 8; i += 1) await tick()
  flushFrames()

  const doc2 = phase2.dom.document
  const layer = doc2.body.children.find(child => child.id === 'dsh-bg-layer')
  const scrim = doc2.body.children.find(child => child.id === 'dsh-bg-scrim')
  check('wallpaper layer created', layer != null)
  check('dim scrim sits right after the layer', scrim != null
    && doc2.body.children.indexOf(scrim) === doc2.body.children.indexOf(layer) + 1)
  const styleElement = doc2.head.children.find(child => child.attributes['data-dsh-bg-plugin'] === '1')
  check('plugin stylesheet created', styleElement != null)
  check('stylesheet is the last head child (re-assert)', styleElement != null
    && doc2.head.children[doc2.head.children.length - 1] === styleElement)
  const styleText = styleElement == null ? '' : styleElement.textContent
  check('stylesheet clears the body background', styleText.indexOf('body{background:transparent !important}') !== -1)
  check('stylesheet lifts #root above the wallpaper', styleText.indexOf('#root{position:relative;z-index:1') !== -1)
  check('stylesheet emits surface overrides', styleText.indexOf('--dsw-alias-bg-base: rgba(21, 21, 23,') !== -1
    && styleText.indexOf('--dsw-alias-bg-mask-1: rgba(21, 21, 23,') !== -1)
  check('surface alpha follows the slider', styleText.indexOf('rgba(21, 21, 23, 0.6000)') !== -1)
  // The readability contract: dialogs/Settings/menus re-declare the probed
  // tokens at their ORIGINAL alpha, so the slider never dims them.
  check('overlay scopes are exempt from the slider', typeof internals.OPAQUE_SCOPE === 'string'
    && styleText.indexOf(internals.OPAQUE_SCOPE) !== -1
    && internals.OPAQUE_SCOPE.indexOf('[role="dialog"]') !== -1
    && internals.OPAQUE_SCOPE.indexOf('body > :not(#root)') !== -1,
  JSON.stringify(internals.OPAQUE_SCOPE))
  check('overlay palette keeps the original alpha', styleText.indexOf('--dsw-alias-bg-layer-2: rgba(21, 21, 23, 1.0000)') !== -1)
  check('the settings hint promises clear dialogs', (() => {
    const zh = internals.TEXTS.zh['interface.hint']
    const en = internals.TEXTS.en['interface.hint']
    return /设置/.test(zh) && /Settings/.test(en)
  })())

  const rootProps = doc2.documentElement.style.properties
  check('backdrop pinned to the probed theme color', rootProps['--dsh-bg-backdrop'] === 'rgb(21, 21, 23)')
  check('image variable set', String(rootProps['--dsh-bg-image'] || '').indexOf('url("') === 0)
  check('geometry covers the viewport plus bleed', /^\d+\.\d{2}px \d+\.\d{2}px$/.test(String(rootProps['--dsh-bg-size']))
    && Number(String(rootProps['--dsh-bg-size']).split('px')[0]) > 1600,
  String(rootProps['--dsh-bg-size']))
  equal('blur variable', rootProps['--dsh-bg-filter'], 'blur(10px)')
  equal('blur bleed inflates the layer', rootProps['--dsh-bg-bleed'], '-30px')
  equal('image opacity variable', rootProps['--dsh-bg-opacity'], '0.8')
  equal('dim scrim variable', rootProps['--dsh-bg-scrim'], 'rgba(0, 0, 0, 0.2)')
  check('unsafe image schemes never reach a css url()',
    source.indexOf("if (value.indexOf('blob:') === 0) return value") !== -1
    && source.indexOf('/^data:image\\//i.test(value)') !== -1)

  const component = record2.entries[0].component
  const t = key => key
  let tree = renderRow(phase2.reactStub, component)
  const head = findByClass(tree, 'dshbg-head')[0]
  check('row renders a header toggle', head != null && typeof head.props.onClick === 'function')
  check('collapsed row has no control body', findByClass(tree, 'dshbg-body').length === 0)
  head.props.onClick()
  tree = renderRow(phase2.reactStub, component)
  check('expanded row renders the body', findByClass(tree, 'dshbg-body').length === 1)
  check('expanded row renders the crop preview', findByClass(tree, 'dshbg-preview').length === 1)
  const sliders = findByClass(tree, 'dshbg-range')
  check('expanded row renders every slider', sliders.length === 7, 'found ' + sliders.length)
  const chips = findByClass(tree, 'dshbg-chip')
  const fitChips = chips.filter(chip => textOf(chip).indexOf('fit.') === 0)
  equal('expanded row renders the four fit chips', fitChips.length, 4)
  equal('active chip follows the stored fit', fitChips.filter(chip => chip.props['aria-pressed'] === 'true').length, 1)
  const opacitySlider = sliders.find(slider => slider.props['aria-label'] === 'effect.opacity')
  check('slider reflects the stored value', opacitySlider != null && opacitySlider.props.value === '80',
    opacitySlider == null ? 'missing' : String(opacitySlider.props.value))
  const previewCanvas = findByClass(tree, 'dshbg-preview')[0]
  check('preview mirrors the viewport aspect ratio', String(previewCanvas.props.style.aspectRatio) === '1600 / 900',
    String(previewCanvas.props.style.aspectRatio))
  check('preview paints the same image', String(previewCanvas.props.style.backgroundImage).indexOf('url("blob:') === 0,
    String(previewCanvas.props.style.backgroundImage))
  check('preview falls back to cover until it is measured', previewCanvas.props.style.backgroundSize === 'cover')
  check('the component subscribes to the controller store',
    phase2.reactStub.subscriptions.length === 1 && typeof phase2.reactStub.subscriptions[0] === 'function')

  // Coalescing: two slider moves in one frame repaint once, and only the
  // variable that actually changed is written.
  const writesBefore = doc2.documentElement.style.writes
  opacitySlider.props.onChange({ target: { value: '40' } })
  opacitySlider.props.onChange({ target: { value: '45' } })
  equal('no paint before the frame is drained', doc2.documentElement.style.writes, writesBefore)
  flushFrames()
  equal('one frame paints the final value', rootProps['--dsh-bg-opacity'], '0.45')
  equal('a frame writes only the changed variable', doc2.documentElement.style.writes - writesBefore, 1)

  const surfaceSlider = sliders.find(slider => slider.props['aria-label'] === 'interface.opacity')
  check('the interface-opacity slider exists', surfaceSlider != null)

  // Wallpaper scope: the sidebar keeps its own opaque fill by default.
  const scopeMain = chips.find(chip => textOf(chip) === 'scope.main')
  const scopeAll = chips.find(chip => textOf(chip) === 'scope.all')
  check('the wallpaper-scope chips are rendered', scopeMain != null && scopeAll != null)
  equal('the sidebar stays opaque by default', scopeMain.props['aria-pressed'], 'true')
  const sheetText = () => {
    const sheet = doc2.head.children.find(child => child.attributes['data-dsh-bg-plugin'] === '1')
    return sheet == null ? '' : sheet.textContent
  }
  check('an opaque sidebar is not overridden at all',
    sheetText().indexOf('--dsw-specific-sidebar-fill:') === -1)
  check('the window-wide shell is cleared instead', sheetText().indexOf('data-dsh-bg-frame') !== -1)
  check('only the window-sized shell element is marked',
    wideFrame.attributes['data-dsh-bg-frame'] === '1'
    && smallPanel.attributes['data-dsh-bg-frame'] === undefined,
    JSON.stringify({ wide: wideFrame.attributes['data-dsh-bg-frame'], small: smallPanel.attributes['data-dsh-bg-frame'] }))
  scopeAll.props.onClick()
  flushFrames()
  check('the whole-interface mode makes the sidebar translucent',
    sheetText().indexOf('--dsw-specific-sidebar-fill: rgba(21, 21, 23, 0.6000)') !== -1)
  check('whole-interface mode drops the frame override',
    sheetText().indexOf('data-dsh-bg-frame') === -1)
  const scopedTree = renderRow(phase2.reactStub, component)
  equal('the whole-interface chip becomes active',
    findByClass(scopedTree, 'dshbg-chip').find(chip => textOf(chip) === 'scope.all').props['aria-pressed'], 'true')
  findByClass(scopedTree, 'dshbg-chip').find(chip => textOf(chip) === 'scope.main').props.onClick()
  flushFrames()
  check('switching back leaves the sidebar opaque again',
    sheetText().indexOf('--dsw-specific-sidebar-fill:') === -1)

  surfaceSlider.props.onChange({ target: { value: '100' } })
  flushFrames()
  const statusWithOpaque = findByClass(renderRow(phase2.reactStub, component), 'dshbg-head-status')[0]
  check('an opaque interface says the wallpaper is hidden',
    statusWithOpaque != null && textOf(statusWithOpaque).indexOf('status.opaque') !== -1,
    textOf(statusWithOpaque))
  surfaceSlider.props.onChange({ target: { value: '60' } })
  flushFrames()
  const statusWithTransparent = findByClass(renderRow(phase2.reactStub, component), 'dshbg-head-status')[0]
  check('a translucent interface drops that warning',
    statusWithTransparent != null && textOf(statusWithTransparent).indexOf('status.opaque') === -1,
    textOf(statusWithTransparent))

  process.stdout.write('\n== on-screen diagnostic ==\n')
  const diagnosticTree = renderRow(phase2.reactStub, component)
  const diagnoseButton = findByClass(diagnosticTree, 'dshbg-link')
    .find(button => textOf(button) === 'diagnose.run')
  check('the diagnostic button is rendered', diagnoseButton != null)
  check('no diagnostic block before asking for one', findByClass(diagnosticTree, 'dshbg-diag').length === 0)
  diagnoseButton.props.onClick()
  const reportedTree = renderRow(phase2.reactStub, component)
  const diagBlock = findByClass(reportedTree, 'dshbg-diag')[0]
  const report = diagBlock == null ? '' : textOf(diagBlock)
  check('the diagnostic prints a report', diagBlock != null && report.indexOf('样式表') === 0,
    report.slice(0, 60))
  check('the diagnostic reports the wallpaper layer', report.indexOf('壁纸层') !== -1)
  check('the diagnostic reports the probed tokens', report.indexOf('--dsw-alias-bg-base') !== -1
    && report.indexOf('--dsw-specific-sidebar-fill') !== -1)
  check('the diagnostic names the opaque culprits section', report.indexOf('不透明底色来源') !== -1)

  const clearButton = findByClass(tree, 'dshbg-btn').find(button => button.props.className.indexOf('is-danger') !== -1)
  check('clear button exists', clearButton != null)
  clearButton.props.onClick()
  for (let i = 0; i < 6; i += 1) await tick()
  flushFrames()
  check('clearing removes the layer', doc2.body.children.every(child => child.id !== 'dsh-bg-layer'))
  check('clearing keeps the row stylesheet, base only', (() => {
    const sheet = doc2.head.children.find(child => child.attributes['data-dsh-bg-plugin'] === '1')
    return sheet != null && sheet.textContent === internals.BASE_CSS
  })())
  check('clearing drops every plugin variable', Object.keys(rootProps).length === 0, JSON.stringify(rootProps))
  check('clearing forgets the stored config', phase2.store.has('dsh-bg-changer:config:v1') === false)

  // The external store is real: a subscriber is notified, and stops after it
  // unsubscribes.
  let notified = 0
  const unsubscribe = phase2.reactStub.subscriptions[0](() => { notified += 1 })
  let afterClear = renderRow(phase2.reactStub, component)
  const headAfterClear = findByClass(afterClear, 'dshbg-head')[0]
  headAfterClear.props.onClick()
  equal('controller notifies its subscribers', notified, 1)
  unsubscribe()
  afterClear = renderRow(phase2.reactStub, component)
  findByClass(afterClear, 'dshbg-head')[0].props.onClick()
  equal('an unsubscribed listener is not notified', notified, 1)
  // The click above re-expanded the row, so re-render before looking for the
  // file input inside the (now expanded) body.
  afterClear = renderRow(phase2.reactStub, component)

  // Upload guard rails: an oversized file is refused with its own message.
  const fileInput = findByProps(afterClear, node => node.type === 'input' && node.props.type === 'file')[0]
  check('file input is rendered', fileInput != null)
  check('file input is enabled while idle', fileInput != null && fileInput.props.disabled === false)
  fileInput.props.onChange({
    target: { files: [{ size: internals.MAX_UPLOAD_BYTES + 1, type: 'image/png', name: 'huge.png' }], value: '' },
  })
  await tick()
  await tick()
  const oversizedRow = renderRow(phase2.reactStub, component)
  const notices = findByClass(oversizedRow, 'dshbg-msg').map(textOf)
  check('an oversized upload reports message.tooLarge', notices.indexOf('message.tooLarge') !== -1,
    JSON.stringify(notices))
  check('the oversized upload leaves the wallpaper untouched', doc2.body.children.every(child => child.id !== 'dsh-bg-layer'))

  process.stdout.write('\n== lifecycle: dispose, unreadable palette ==\n')
  const phase3 = loadBundle(source, {
    stored: [['dsh-bg-changer:config:v1', JSON.stringify(stored)]],
    records: { [internals.IDB_KEY]: assetRecord, [internals.IDB_KEY_DARK]: assetRecord },
    // A host that renamed or dropped the surface tokens: every probe resolves
    // to a fully transparent color.
    getComputedStyle: () => ({ backgroundColor: 'rgba(0, 0, 0, 0)' }),
  })
  const record3 = { dicts: [], entries: [], injected: [], effects: [], events: [], effectErrors: [], disposers: [], handlers: {} }
  phase3.mod.apply(makeCtx(record3))
  for (let i = 0; i < 8; i += 1) await tick()
  flushFrames()

  const doc3 = phase3.dom.document
  check('degraded palette still paints the wallpaper',
    doc3.body.children.some(child => child.id === 'dsh-bg-layer'))
  const style3 = doc3.head.children.find(child => child.attributes['data-dsh-bg-plugin'] === '1')
  check('degraded palette emits no surface override', style3 != null && style3.textContent === internals.BASE_CSS,
    style3 == null ? 'no stylesheet' : style3.textContent.slice(0, 80))
  const degraded = renderRow(phase3.reactStub, record3.entries[0].component)
  findByClass(degraded, 'dshbg-head')[0].props.onClick()
  const degradedRow = renderRow(phase3.reactStub, record3.entries[0].component)
  const degradedNotices = findByClass(degradedRow, 'dshbg-msg').map(textOf)
  check('an unreadable palette says so instead of failing silently',
    degradedNotices.indexOf('message.transparencyUnavailable') !== -1, JSON.stringify(degradedNotices))
  check('the parser still refuses a non-rgb computed color by design', parseRgb('oklch(0.7 0.1 200)') === null)

  // Dispose must cancel the queued frame and never let a late paint resurrect
  // the layer (the historical "it came back after disabling" bug).
  const phase3Sliders = findByClass(degradedRow, 'dshbg-range')
  const phase3Opacity = phase3Sliders.find(slider => slider.props['aria-label'] === 'effect.opacity')
  phase3Opacity.props.onChange({ target: { value: '30' } })
  const disposeEffect = record3.effects.indexOf('dsh-bg-changer: dispose')
  check('apply registers a dispose effect', disposeEffect >= 0, JSON.stringify(record3.effects))
  record3.disposers[disposeEffect]()
  flushFrames()
  await tick()
  flushFrames()
  check('dispose removes the layer', doc3.body.children.every(child => child.id !== 'dsh-bg-layer'))
  check('dispose removes the stylesheet', doc3.head.children.every(child => child.attributes['data-dsh-bg-plugin'] !== '1'))
  check('dispose drops every plugin variable', Object.keys(doc3.documentElement.style.properties).length === 0,
    JSON.stringify(doc3.documentElement.style.properties))
  check('a queued frame cannot repaint after dispose',
    doc3.body.children.every(child => child.id !== 'dsh-bg-layer' && child.id !== 'dsh-bg-scrim'))

  process.stdout.write('\n== dark slot: import through the UI, theme switch, export ==\n')
  const phase4 = loadBundle(source, { records: {} })
  const record4 = { dicts: [], entries: [], injected: [], effects: [], events: [], effectErrors: [], disposers: [], handlers: {} }
  phase4.mod.apply(makeCtx(record4))
  for (let i = 0; i < 4; i += 1) await tick()
  flushFrames()
  const doc4 = phase4.dom.document
  const row4 = record4.entries[0].component

  let tree4 = renderRow(phase4.reactStub, row4)
  findByClass(tree4, 'dshbg-head')[0].props.onClick()
  tree4 = renderRow(phase4.reactStub, row4)
  equal('two image slots are offered', findByClass(tree4, 'dshbg-slot').length, 2)
  equal('two image inputs are offered',
    findByProps(tree4, node => node.type === 'input' && node.props.type === 'file' && node.props.accept === 'image/*').length, 2)
  check('an empty row has no wallpaper layer', doc4.body.children.every(child => child.id !== 'dsh-bg-layer'))
  check('an empty row claims no slot is in use', findByClass(tree4, 'dshbg-slot-badge').length === 0)

  const lightBackup = JSON.stringify(phase4.mod.__internals.buildBackup(
    Object.assign({}, internals.DEFAULTS, { enabled: true, scale: 175 }),
    {
      light: { name: 'day.png', type: 'image/png', width: 4000, height: 3000, dataUrl: 'data:image/png;base64,' + samplePng },
      dark: { name: 'night.png', type: 'image/png', width: 4000, height: 3000, dataUrl: 'data:image/png;base64,' + Buffer.from([9, 9, 9]).toString('base64') },
    },
  ))
  const pasteToggle = findByClass(tree4, 'dshbg-btn').find(button => textOf(button) === 'backup.paste')
  check('the paste-import button exists', pasteToggle != null)
  pasteToggle.props.onClick()
  tree4 = renderRow(phase4.reactStub, row4)
  const pasteArea = findByClass(tree4, 'dshbg-paste-area')[0]
  check('the paste area appears', pasteArea != null && pasteArea.type === 'textarea')
  pasteArea.props.onChange({ target: { value: lightBackup } })
  tree4 = renderRow(phase4.reactStub, row4)
  const confirmImport = findByClass(tree4, 'dshbg-btn').find(button => textOf(button) === 'backup.confirm')
  check('the confirm-import button exists', confirmImport != null)
  confirmImport.props.onClick()
  for (let i = 0; i < 8; i += 1) await tick()
  flushFrames()

  check('the imported light image is stored', phase4.indexedDb.records[internals.IDB_KEY] != null)
  check('the imported dark image is stored', phase4.indexedDb.records[internals.IDB_KEY_DARK] != null)
  check('an imported wallpaper paints',
    doc4.body.children.some(child => child.id === 'dsh-bg-layer'))
  tree4 = renderRow(phase4.reactStub, row4)
  check('the import notice is shown',
    findByClass(tree4, 'dshbg-msg').map(textOf).indexOf('message.imported') !== -1,
    JSON.stringify(findByClass(tree4, 'dshbg-msg').map(textOf)))
  check('the in-use badge marks exactly one slot', findByClass(tree4, 'dshbg-slot-badge').length === 1)

  const imageVar = () => doc4.documentElement.style.properties['--dsh-bg-image']
  const lightThemeUrl = imageVar()
  check('the light theme paints the light image', typeof lightThemeUrl === 'string' && lightThemeUrl.indexOf('url("blob:') === 0)
  doc4.body.setAttribute('data-ds-dark-theme', '')
  record4.handlers['theme/change']()
  flushFrames()
  const darkThemeUrl = imageVar()
  check('a theme change repaints with the dark image', darkThemeUrl !== lightThemeUrl,
    String(darkThemeUrl) + ' vs ' + String(lightThemeUrl))
  doc4.body.removeAttribute('data-ds-dark-theme')
  record4.handlers['theme/change']()
  flushFrames()
  equal('switching back restores the light image', imageVar(), lightThemeUrl)

  tree4 = renderRow(phase4.reactStub, row4)
  const exportButton = findByClass(tree4, 'dshbg-btn').find(button => textOf(button) === 'backup.export')
  check('the export button exists', exportButton != null)
  exportButton.props.onClick()
  for (let i = 0; i < 8; i += 1) await tick()
  const exportedBlob = phase4.createdBlobs[phase4.createdBlobs.length - 1]
  const exportedText = exportedBlob == null ? '' : await exportedBlob.text()
  let exported = null
  try { exported = JSON.parse(exportedText) } catch (error) { exported = null }
  check('export writes a readable backup envelope', exported != null && exported.format === internals.BACKUP_FORMAT)
  check('export carries the applied config', exported != null && exported.config != null && exported.config.scale === 175,
    exported == null ? 'no backup' : JSON.stringify(exported.config && exported.config.scale))
  check('export carries both image data urls',
    exported != null && exported.images != null
    && String(exported.images.light && exported.images.light.dataUrl).indexOf('data:image/png;base64,') === 0
    && String(exported.images.dark && exported.images.dark.dataUrl).indexOf('data:image/png;base64,') === 0)
  tree4 = renderRow(phase4.reactStub, row4)
  check('the export notice is shown',
    findByClass(tree4, 'dshbg-msg').map(textOf).indexOf('message.exported') !== -1)

  process.stdout.write('\n== dark-only fallback ==\n')
  const phase5 = loadBundle(source, {
    records: { [internals.IDB_KEY_DARK]: {
      blob: new Blob([new Uint8Array([7, 7])], { type: 'image/png' }),
      name: 'night.png', type: 'image/png', size: 2, width: 800, height: 600, savedAt: 2,
    } },
    stored: [['dsh-bg-changer:config:v1', JSON.stringify({ enabled: true })]],
  })
  const record5 = { dicts: [], entries: [], injected: [], effects: [], events: [], effectErrors: [], disposers: [], handlers: {} }
  phase5.mod.apply(makeCtx(record5))
  for (let i = 0; i < 8; i += 1) await tick()
  flushFrames()
  const doc5 = phase5.dom.document
  check('a dark-only restore still paints', doc5.body.children.some(child => child.id === 'dsh-bg-layer'))
  const darkOnlyLightTheme = doc5.documentElement.style.properties['--dsh-bg-image']
  doc5.body.setAttribute('data-ds-dark-theme', '')
  record5.handlers['theme/change']()
  flushFrames()
  equal('a dark-only setup reuses the same image in the dark theme',
    doc5.documentElement.style.properties['--dsh-bg-image'], darkOnlyLightTheme)

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
