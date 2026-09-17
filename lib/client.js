/**
 * dsh-bg-changer — browser half.
 *
 * Hand-written lazy-CJS client bundle: the module system materializes it via
 * `window.__ModuleLoader__.load({id, factory})`, and the only module-table row
 * it needs is the shell baseline (`react`). No build step, no dependencies.
 *
 * What it does:
 * - registers one preference row into `settings.general.item` at the BOTTOM of
 *   Settings > General (order 100; every shipped row uses -20..20);
 * - uploads an image (PNG/JPEG/WebP/GIF/BMP/AVIF/SVG), then tunes fit, scale,
 *   horizontal/vertical placement (the crop window), image opacity, blur, dim,
 *   and the interface translucency that lets the wallpaper show at all;
 * - paints the wallpaper in a fixed `#dsh-bg-layer` above the page backdrop and
 *   makes the app surfaces translucent by overriding `--dsw-alias-bg-*` tokens
 *   with rgba() values resolved from a live probe element;
 * - persists the config in localStorage and the image blob in IndexedDB.
 *
 * Everything is inert until a wallpaper is enabled: no style tag, no layer
 * element, no host-side behaviour (see lib/index.js).
 */
window.__ModuleLoader__.load({
  id: 'dsh-bg-changer',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /* ------------------------------------------------------------------ *
     * Constants
     * ------------------------------------------------------------------ */

    const NS = 'settings.bgChanger'
    const LS_CONFIG = 'dsh-bg-changer:config:v1'
    const LS_IMAGE = 'dsh-bg-changer:image:v1'
    const IDB_NAME = 'dsh-bg-changer'
    const IDB_STORE = 'assets'
    const IDB_KEY = 'wallpaper'
    const MAX_EDGE = 4096
    const MAX_KEEP_BYTES = 8 * 1024 * 1024
    const LS_IMAGE_MAX_BYTES = 2.5 * 1024 * 1024
    const SAVE_DEBOUNCE_MS = 150
    const LAYER_ID = 'dsh-bg-layer'
    const SCRIM_ID = 'dsh-bg-scrim'
    const STYLE_ATTR = 'data-dsh-bg-plugin'
    const FITS = ['cover', 'contain', 'stretch', 'tile']

    const DEFAULTS = {
      enabled: false,
      fit: 'cover',
      scale: 100,
      offsetX: 0,
      offsetY: 0,
      imageOpacity: 100,
      blur: 0,
      dim: 0,
      surfaceOpacity: 65,
    }

    const RANGES = {
      scale: [50, 300],
      offsetX: [-100, 100],
      offsetY: [-100, 100],
      imageOpacity: [0, 100],
      blur: [0, 40],
      dim: [0, 60],
      surfaceOpacity: [0, 100],
    }

    const BG_PROPS = [
      '--dsh-bg-image', '--dsh-bg-size', '--dsh-bg-position', '--dsh-bg-repeat',
      '--dsh-bg-bleed', '--dsh-bg-filter', '--dsh-bg-opacity', '--dsh-bg-scrim',
      '--dsh-bg-backdrop',
    ]

    /**
     * Interface surfaces the wallpaper must shine through, each with the alpha
     * floor it keeps at surfaceOpacity = 0 (inputs/code/buttons stay legible).
     * Final alpha = floor + (1 - floor) * surfaceOpacity / 100, so 100 restores
     * the untouched opaque interface exactly.
     */
    const ALPHA_FLOOR = {
      '--dsw-alias-bg-base': 0,
      '--dsw-alias-bg-layer-1': 0,
      '--dsw-alias-bg-layer-2': 0,
      '--dsw-alias-bg-layer-3': 0,
      '--dsw-alias-bg-overlay': 0,
      '--dsw-alias-bg-module-platform': 0,
      '--dsw-specific-sidebar-fill': 0,
      '--dsw-specific-selector': 0.55,
      '--dsw-specific-input-major': 0.55,
      '--dsw-alias-markdown-code-block': 0.35,
      '--dsw-alias-markdown-code-block-banner': 0.35,
      '--dsw-alias-button-floating-fill': 0.65,
      '--dsw-alias-button-elevated-fill': 0.65,
    }
    const SURFACE_TOKENS = Object.keys(ALPHA_FLOOR)

    const TEXTS = {
      zh: {
        title: '背景图',
        'status.none': '未设置',
        'status.applied': '已应用',
        'status.disabled': '已停用',
        'status.busy': '处理中…',
        'group.image': '图片',
        'upload.cta': '点击或把图片拖到这里',
        'upload.types': '支持 PNG / JPEG / WebP / GIF / BMP / AVIF / SVG',
        'upload.change': '更换',
        'upload.remove': '移除',
        'file.unknown': '未知格式',
        'group.layout': '布局与裁剪',
        'fit.cover': '填充',
        'fit.contain': '适应',
        'fit.stretch': '拉伸',
        'fit.tile': '平铺',
        'layout.scale': '缩放',
        'layout.offsetX': '水平',
        'layout.offsetY': '垂直',
        'layout.previewTip': '拖拽平移 · 滚轮缩放',
        'layout.reset': '重置构图',
        'layout.hint': '缩放后即可在上方预览里拖动，选定要显示的部位',
        'group.effect': '效果',
        'effect.opacity': '图片不透明度',
        'effect.blur': '模糊度',
        'effect.dim': '暗化',
        'group.interface': '界面',
        'interface.opacity': '界面不透明度',
        'interface.hint': '调低才能让壁纸透出来；100% 完全还原默认外观',
        'action.disable': '停用背景',
        'action.enable': '启用背景',
        'action.clear': '清除并重置',
        'message.compressed': '图片较大，已压缩到最长边 4096px',
        'message.gifLarge': '动图较大，未压缩（保留动画）',
        'message.compressFailed': '压缩失败，已使用原始图片',
        'message.sessionOnly': '浏览器存储不可用，本次设置只在当前会话生效',
        'message.storageFallback': '浏览器存储降级为本地记录',
        'message.decodeFailed': '无法解码该图片格式',
        'message.notImage': '请选择图片文件',
      },
      en: {
        title: 'Background',
        'status.none': 'Not set',
        'status.applied': 'Applied',
        'status.disabled': 'Disabled',
        'status.busy': 'Working…',
        'group.image': 'Image',
        'upload.cta': 'Click or drop an image here',
        'upload.types': 'PNG / JPEG / WebP / GIF / BMP / AVIF / SVG',
        'upload.change': 'Replace',
        'upload.remove': 'Remove',
        'file.unknown': 'unknown',
        'group.layout': 'Layout & crop',
        'fit.cover': 'Cover',
        'fit.contain': 'Contain',
        'fit.stretch': 'Stretch',
        'fit.tile': 'Tile',
        'layout.scale': 'Scale',
        'layout.offsetX': 'Horizontal',
        'layout.offsetY': 'Vertical',
        'layout.previewTip': 'Drag to move · wheel to zoom',
        'layout.reset': 'Reset crop',
        'layout.hint': 'Zoom in, then drag in the preview to pick the visible part',
        'group.effect': 'Effects',
        'effect.opacity': 'Image opacity',
        'effect.blur': 'Blur',
        'effect.dim': 'Dim',
        'group.interface': 'Interface',
        'interface.opacity': 'Interface opacity',
        'interface.hint': 'Lower it to reveal the wallpaper; 100% restores the default look',
        'action.disable': 'Disable wallpaper',
        'action.enable': 'Enable wallpaper',
        'action.clear': 'Clear and reset',
        'message.compressed': 'Large image: compressed to a 4096px longest edge',
        'message.gifLarge': 'Large animation kept uncompressed to preserve motion',
        'message.compressFailed': 'Compression failed; the original image is used',
        'message.sessionOnly': 'Browser storage unavailable: this setting lasts for this session only',
        'message.storageFallback': 'Browser storage fell back to a local record',
        'message.decodeFailed': 'Could not decode that image format',
        'message.notImage': 'Please choose an image file',
      },
    }

    const BASE_CSS = [
      '#dsh-bg-layer{position:fixed;inset:var(--dsh-bg-bleed,0px);z-index:0;pointer-events:none;'
        + 'background-image:var(--dsh-bg-image);background-size:var(--dsh-bg-size,cover);'
        + 'background-position:var(--dsh-bg-position,center center);'
        + 'background-repeat:var(--dsh-bg-repeat,no-repeat);'
        + 'filter:var(--dsh-bg-filter,none);opacity:var(--dsh-bg-opacity,1)}',
      '#dsh-bg-scrim{position:fixed;inset:0;z-index:0;pointer-events:none;'
        + 'background:var(--dsh-bg-scrim,transparent)}',
      'html{background:var(--dsh-bg-backdrop,transparent) !important}',
      'body{background:transparent !important}',
      '#root{position:relative;z-index:1;background:transparent !important}',
      '.dshbg-row{display:flex;flex-direction:column;border:0.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));'
        + 'border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.02));margin-top:12px}',
      '.dshbg-head{display:flex;align-items:center;gap:10px;padding:12px 14px;width:100%;text-align:left;'
        + 'background:transparent;border:0;color:var(--dsw-alias-label-primary,inherit);font:inherit;cursor:pointer}',
      '.dshbg-head:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}',
      '.dshbg-head-icon{font-size:16px;line-height:1}',
      '.dshbg-head-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.dshbg-head-title{font-size:14px;line-height:22px;font-weight:500}',
      '.dshbg-head-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#666);'
        + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshbg-chevron{font-size:10px;line-height:1;color:var(--dsw-alias-label-secondary,#666)}',
      '.dshbg-body{display:flex;flex-direction:column;gap:14px;padding:0 14px 14px}',
      '.dshbg-group{display:flex;flex-direction:column;gap:8px}',
      '.dshbg-group-label{font-size:12px;line-height:18px;font-weight:600;letter-spacing:.04em;'
        + 'color:var(--dsw-alias-label-secondary,#666)}',
      '.dshbg-drop{display:flex;align-items:center;gap:12px;padding:12px;border:1px dashed '
        + 'var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:10px;background:transparent;cursor:pointer}',
      '.dshbg-drop:hover,.dshbg-drop.is-over{border-color:var(--dsw-alias-brand-primary,#4176e6)}',
      '.dshbg-drop.is-over{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}',
      '.dshbg-thumb{width:56px;height:56px;flex:0 0 auto;border-radius:8px;object-fit:cover;'
        + 'background:var(--dsw-alias-bg-layer-3,rgba(0,0,0,.06))}',
      '.dshbg-file{flex:1;min-width:0}',
      '.dshbg-file-name{font-size:13px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshbg-file-meta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#666)}',
      '.dshbg-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#666)}',
      '.dshbg-chips{display:flex;flex-wrap:wrap;gap:6px}',
      '.dshbg-chip{padding:5px 12px;border:0.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));'
        + 'border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:12px;line-height:18px;'
        + 'cursor:pointer}',
      '.dshbg-chip:hover{border-color:var(--dsw-alias-brand-primary,#4176e6)}',
      '.dshbg-chip.is-active{border-color:var(--dsw-alias-brand-primary,#4176e6);font-weight:500;'
        + 'background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
      '.dshbg-slider{display:grid;grid-template-columns:76px 1fr 52px;align-items:center;gap:10px}',
      '.dshbg-slider-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#666)}',
      '.dshbg-slider-value{font-size:12px;line-height:18px;text-align:right;font-variant-numeric:tabular-nums;'
        + 'color:var(--dsw-alias-label-secondary,#666)}',
      '.dshbg-range{width:100%;height:18px;margin:0;accent-color:var(--dsw-alias-brand-primary,#4176e6)}',
      '.dshbg-preview{position:relative;width:100%;border-radius:10px;overflow:hidden;background-repeat:no-repeat;'
        + 'border:0.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));'
        + 'background-color:var(--dsw-alias-bg-layer-3,rgba(0,0,0,.06));cursor:grab;touch-action:none}',
      '.dshbg-preview:active{cursor:grabbing}',
      '.dshbg-preview-tip{position:absolute;left:8px;bottom:6px;padding:2px 6px;border-radius:6px;font-size:11px;'
        + 'line-height:16px;color:#fff;background:rgba(0,0,0,.45);pointer-events:none}',
      '.dshbg-actions{display:flex;flex-wrap:wrap;gap:8px}',
      '.dshbg-btn{flex:1 1 110px;padding:8px 12px;border-radius:8px;'
        + 'border:0.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:transparent;color:inherit;'
        + 'font:inherit;font-size:13px;line-height:20px;cursor:pointer}',
      '.dshbg-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}',
      '.dshbg-btn.is-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,#111);'
        + 'color:var(--dsw-alias-label-primary-inverted,#fff)}',
      '.dshbg-btn.is-danger:hover{color:var(--dsw-alias-state-error-primary,#ec1313);'
        + 'border-color:var(--dsw-alias-state-error-secondary,#f25a5a)}',
      '.dshbg-btn:disabled{opacity:.45;cursor:not-allowed}',
      '.dshbg-msg{padding:8px 10px;border-radius:8px;font-size:12px;line-height:18px;'
        + 'background:var(--dsw-alias-bg-layer-3,rgba(0,0,0,.04))}',
      '.dshbg-msg.is-error{color:var(--dsw-alias-state-error-primary,#ec1313)}',
      '.dshbg-msg.is-warn{color:var(--dsw-alias-state-warn-label,#b45309)}',
    ].join('\n')

    /* ------------------------------------------------------------------ *
     * Pure helpers (unit-tested by tools/verify-bundle.cjs)
     * ------------------------------------------------------------------ */

    /** Clamp a number into a closed range. */
    function clamp(value, min, max) {
      const n = Number(value)
      if (!isFinite(n)) return min
      return n < min ? min : n > max ? max : n
    }

    /** Final alpha for one surface token: 0 keeps its floor, 1 is opaque. */
    function alphaFor(floor, surfaceAlpha) {
      const a = clamp(surfaceAlpha, 0, 1)
      const f = clamp(floor, 0, 1)
      return f + (1 - f) * a
    }

    /**
     * Parse a computed CSS color into rgb channels.
     * @returns r/g/b, or null when the value is unresolved (fully transparent).
     */
    function parseRgb(value) {
      if (typeof value !== 'string') return null
      const match = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(value.trim())
      if (!match) return null
      let alpha = 1
      if (match[4] !== undefined) {
        alpha = match[4].indexOf('%') >= 0 ? parseFloat(match[4]) / 100 : parseFloat(match[4])
      }
      if (!(alpha > 0)) return null
      return { r: Math.round(Number(match[1])), g: Math.round(Number(match[2])), b: Math.round(Number(match[3])) }
    }

    /**
     * Resolve the wallpaper layer's background geometry for one viewport.
     * Offsets are percentages of the available overflow, so the image always
     * spans the viewport (never exposing the backdrop) for cover/stretch.
     */
    function computeGeometry(input) {
      const fit = FITS.indexOf(input.fit) >= 0 ? input.fit : 'cover'
      const scale = clamp(Number(input.scale) || 100, 50, 300) / 100
      const offsetX = clamp(Number(input.offsetX) || 0, -100, 100)
      const offsetY = clamp(Number(input.offsetY) || 0, -100, 100)
      const viewW = Math.max(1, Number(input.viewW) || 1)
      const viewH = Math.max(1, Number(input.viewH) || 1)
      const imgW = Math.max(1, Number(input.imgW) || viewW)
      const imgH = Math.max(1, Number(input.imgH) || viewH)

      let baseW
      let baseH
      if (fit === 'stretch') {
        baseW = viewW
        baseH = viewH
      } else if (fit === 'cover') {
        const ratio = Math.max(viewW / imgW, viewH / imgH)
        baseW = imgW * ratio
        baseH = imgH * ratio
      } else if (fit === 'contain') {
        const ratio = Math.min(viewW / imgW, viewH / imgH)
        baseW = imgW * ratio
        baseH = imgH * ratio
      } else {
        baseW = imgW
        baseH = imgH
      }

      const width = baseW * scale
      const height = baseH * scale
      const overflowX = width - viewW
      const overflowY = height - viewH
      let tx = 0
      let ty = 0
      if (fit === 'tile') {
        tx = (offsetX / 100) * (width / 2)
        ty = (offsetY / 100) * (height / 2)
      } else {
        tx = overflowX > 0 ? clamp((offsetX / 100) * (overflowX / 2), -overflowX / 2, overflowX / 2) : 0
        ty = overflowY > 0 ? clamp((offsetY / 100) * (overflowY / 2), -overflowY / 2, overflowY / 2) : 0
      }

      return {
        size: width.toFixed(2) + 'px ' + height.toFixed(2) + 'px',
        position: 'calc(50% + ' + tx.toFixed(2) + 'px) calc(50% + ' + ty.toFixed(2) + 'px)',
        repeat: fit === 'tile' ? 'repeat' : 'no-repeat',
        width,
        height,
        overflowX,
        overflowY,
        tx,
        ty,
      }
    }

    /** Human-readable byte size. */
    function formatBytes(bytes) {
      const n = Number(bytes) || 0
      if (n < 1024) return n + ' B'
      if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
      return (n / 1048576).toFixed(1) + ' MB'
    }

    /** Whether the browser half may touch the DOM at all. */
    function domReady() {
      return typeof document !== 'undefined' && document !== null && document.body != null
    }

    function readViewport() {
      const w = typeof window !== 'undefined' ? window.innerWidth : 0
      const h = typeof window !== 'undefined' ? window.innerHeight : 0
      return {
        w: w || (domReady() ? document.documentElement.clientWidth : 1280) || 1280,
        h: h || (domReady() ? document.documentElement.clientHeight : 800) || 800,
      }
    }

    /* ------------------------------------------------------------------ *
     * Storage: config in localStorage, image blob in IndexedDB
     * ------------------------------------------------------------------ */

    function safeStorage() {
      try {
        const ls = globalThis.localStorage
        if (!ls) return null
        const probe = 'dsh-bg-changer:probe'
        ls.setItem(probe, '1')
        ls.removeItem(probe)
        return ls
      } catch (error) {
        return null
      }
    }

    function lsGet(key) {
      const ls = safeStorage()
      if (!ls) return null
      try {
        return ls.getItem(key)
      } catch (error) {
        return null
      }
    }

    function lsSet(key, value) {
      const ls = safeStorage()
      if (!ls) return false
      try {
        ls.setItem(key, value)
        return true
      } catch (error) {
        return false
      }
    }

    function lsRemove(key) {
      const ls = safeStorage()
      if (!ls) return
      try {
        ls.removeItem(key)
      } catch (error) { /* ignore */ }
    }

    function idbOpen() {
      return new Promise((resolve, reject) => {
        const factory = globalThis.indexedDB
        if (!factory) {
          reject(new Error('indexedDB unavailable'))
          return
        }
        let request
        try {
          request = factory.open(IDB_NAME, 1)
        } catch (error) {
          reject(error)
          return
        }
        request.onupgradeneeded = () => {
          const db = request.result
          if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE)
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error || new Error('indexedDB open failed'))
        request.onblocked = () => reject(new Error('indexedDB blocked'))
      })
    }

    function idbRun(mode, action) {
      return idbOpen().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, mode)
        const store = tx.objectStore(IDB_STORE)
        let request
        try {
          request = action(store)
        } catch (error) {
          try { db.close() } catch (closeError) { /* ignore */ }
          reject(error)
          return
        }
        tx.oncomplete = () => {
          try { db.close() } catch (closeError) { /* ignore */ }
          resolve(request ? request.result : undefined)
        }
        tx.onerror = () => {
          try { db.close() } catch (closeError) { /* ignore */ }
          reject(tx.error || new Error('indexedDB transaction failed'))
        }
        tx.onabort = () => {
          try { db.close() } catch (closeError) { /* ignore */ }
          reject(tx.error || new Error('indexedDB transaction aborted'))
        }
      }))
    }

    const idbPut = record => idbRun('readwrite', store => store.put(record, IDB_KEY))
    const idbGet = () => idbRun('readonly', store => store.get(IDB_KEY))
    const idbDelete = () => idbRun('readwrite', store => store.delete(IDB_KEY))

    function blobToDataUrl(blob) {
      return new Promise((resolve, reject) => {
        const Reader = globalThis.FileReader
        if (!Reader) {
          reject(new Error('FileReader unavailable'))
          return
        }
        const reader = new Reader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error || new Error('read failed'))
        reader.readAsDataURL(blob)
      })
    }

    /* ------------------------------------------------------------------ *
     * Image intake
     * ------------------------------------------------------------------ */

    function decodeImage(file) {
      if (typeof createImageBitmap === 'function') {
        return Promise.resolve()
          .then(() => createImageBitmap(file))
          .then((bitmap) => {
            const size = { width: bitmap.width, height: bitmap.height }
            if (typeof bitmap.close === 'function') bitmap.close()
            return size
          })
          .catch(() => decodeViaImageElement(file))
      }
      return decodeViaImageElement(file)
    }

    function decodeViaImageElement(file) {
      return new Promise((resolve, reject) => {
        let url
        try {
          url = URL.createObjectURL(file)
        } catch (error) {
          reject(error)
          return
        }
        const image = new Image()
        image.onload = () => {
          const size = { width: image.naturalWidth || 0, height: image.naturalHeight || 0 }
          try { URL.revokeObjectURL(url) } catch (error) { /* ignore */ }
          if (size.width <= 0 || size.height <= 0) {
            reject(new Error('empty image'))
            return
          }
          resolve(size)
        }
        image.onerror = () => {
          try { URL.revokeObjectURL(url) } catch (error) { /* ignore */ }
          reject(new Error('decode failed'))
        }
        image.src = url
      })
    }

    function reencode(file, width, height) {
      return Promise.resolve().then(() => {
        const longest = Math.max(width, height) || 1
        const ratio = Math.min(1, MAX_EDGE / longest)
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(width * ratio))
        canvas.height = Math.max(1, Math.round(height * ratio))
        const context = canvas.getContext('2d')
        if (context == null) return null
        return Promise.resolve()
          .then(() => (typeof createImageBitmap === 'function' ? createImageBitmap(file) : null))
          .then((bitmap) => {
            if (bitmap == null) return null
            context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
            if (typeof bitmap.close === 'function') bitmap.close()
            return new Promise(resolve => {
              try {
                canvas.toBlob(blob => resolve(blob), 'image/webp', 0.9)
              } catch (error) {
                resolve(null)
              }
            })
          })
          .then((blob) => {
            if (blob == null || blob.size === 0 || blob.size >= file.size) return null
            return blob
          })
      })
    }

    function metaOf(record) {
      return {
        name: record.name,
        type: record.type,
        size: record.size,
        width: record.width,
        height: record.height,
        savedAt: record.savedAt,
      }
    }

    /**
     * Decode and (when oversized) downscale one chosen file.
     * @returns { record, note } where note is an optional message key.
     */
    function prepareAsset(file) {
      const declaredType = String(file.type || '')
      return decodeImage(file).then((size) => {
        const width = size.width
        const height = size.height
        const longest = Math.max(width, height)
        let blob = file
        let note = null
        if (longest > MAX_EDGE || file.size > MAX_KEEP_BYTES) {
          if (declaredType === 'image/gif') {
            note = 'message.gifLarge'
          } else {
            return reencode(file, width, height).then((scaled) => {
              if (scaled != null) blob = scaled
              note = scaled != null ? 'message.compressed' : 'message.compressFailed'
              return finish()
            })
          }
        }
        return finish()

        function finish() {
          return {
            record: {
              blob,
              name: file.name || 'image',
              type: blob.type || declaredType,
              size: blob.size,
              width,
              height,
              savedAt: Date.now(),
            },
            note,
          }
        }
      })
    }

    /* ------------------------------------------------------------------ *
     * Controller: state, persistence, DOM engine
     * ------------------------------------------------------------------ */

    function createController() {
      let state = {
        config: Object.assign({}, DEFAULTS),
        asset: null,
        imageUrl: null,
        notice: null,
        expanded: false,
        busy: false,
      }
      let lastGeometry = null
      let styleEl = null
      let layerEl = null
      let scrimEl = null
      let probeEl = null
      let objectUrl = null
      let saveTimer = null
      let rafPending = false
      const listeners = new Set()

      const notify = () => {
        listeners.forEach((listener) => {
          try { listener() } catch (error) { /* a subscriber must not break the rest */ }
        })
      }

      const setState = (patch) => {
        state = Object.assign({}, state, patch)
        notify()
      }

      const configPatch = (patch) => {
        const next = Object.assign({}, state.config)
        Object.keys(patch).forEach((key) => {
          if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) return
          const template = DEFAULTS[key]
          const raw = patch[key]
          if (typeof template === 'boolean') next[key] = !!raw
          else if (typeof template === 'number') {
            const range = RANGES[key] || [0, 0]
            next[key] = clamp(raw, range[0], range[1])
          } else next[key] = raw
        })
        next.fit = FITS.indexOf(next.fit) >= 0 ? next.fit : 'cover'
        return next
      }

      /* ---------------- config persistence ---------------- */

      function readConfig() {
        const raw = lsGet(LS_CONFIG)
        if (raw == null) return null
        try {
          const parsed = JSON.parse(raw)
          if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
          return parsed
        } catch (error) {
          return null
        }
      }

      function persistConfig() {
        if (saveTimer !== null) clearTimeout(saveTimer)
        saveTimer = setTimeout(() => {
          saveTimer = null
          lsSet(LS_CONFIG, JSON.stringify(state.config))
        }, SAVE_DEBOUNCE_MS)
      }

      /* ---------------- image persistence ---------------- */

      function storeAsset(record) {
        return idbPut(record)
          .then(() => {
            lsRemove(LS_IMAGE)
            return 'idb'
          })
          .catch(() => {
            if (record.size > LS_IMAGE_MAX_BYTES) return 'memory'
            return blobToDataUrl(record.blob)
              .then(dataUrl => {
                const payload = Object.assign({}, metaOf(record), { dataUrl })
                return lsSet(LS_IMAGE, JSON.stringify(payload)) ? 'dataurl' : 'memory'
              })
              .catch(() => 'memory')
          })
      }

      function loadAsset() {
        return idbGet()
          .then((record) => {
            if (record != null && record.blob instanceof Blob) {
              return { blob: record.blob, meta: metaOf(record) }
            }
            return loadAssetFromStorage()
          })
          .catch(() => loadAssetFromStorage())
      }

      function loadAssetFromStorage() {
        const raw = lsGet(LS_IMAGE)
        if (raw == null) return null
        try {
          const parsed = JSON.parse(raw)
          if (parsed == null || typeof parsed.dataUrl !== 'string') return null
          return { dataUrl: parsed.dataUrl, meta: metaOf(parsed) }
        } catch (error) {
          return null
        }
      }

      /* ---------------- DOM engine ---------------- */

      function rootStyle() {
        return domReady() ? document.documentElement.style : null
      }

      function ensureDom() {
        if (!domReady()) return false
        if (styleEl == null || !styleEl.isConnected) {
          const stale = document.querySelector('style[' + STYLE_ATTR + ']')
          if (stale != null) stale.remove()
          styleEl = document.createElement('style')
          styleEl.setAttribute(STYLE_ATTR, '1')
          styleEl.textContent = BASE_CSS
          document.head.appendChild(styleEl)
        }
        if (layerEl == null || !layerEl.isConnected) {
          const stale = document.getElementById(LAYER_ID)
          if (stale != null) stale.remove()
          layerEl = document.createElement('div')
          layerEl.id = LAYER_ID
          document.body.insertBefore(layerEl, document.body.firstChild)
        }
        if (scrimEl == null || !scrimEl.isConnected) {
          const stale = document.getElementById(SCRIM_ID)
          if (stale != null) stale.remove()
          scrimEl = document.createElement('div')
          scrimEl.id = SCRIM_ID
          // Right after the wallpaper layer: equal z-index, later DOM order wins,
          // so the dim scrim sits above the image and below #root (z-index 1).
          document.body.insertBefore(scrimEl, layerEl.nextSibling)
        }
        return true
      }

      function ensureProbe() {
        if (!domReady()) return null
        if (probeEl == null || !probeEl.isConnected) {
          probeEl = document.createElement('div')
          probeEl.setAttribute('data-dsh-bg-probe', '1')
          probeEl.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:0;height:0;'
            + 'visibility:hidden;pointer-events:none'
          document.body.appendChild(probeEl)
        }
        return probeEl
      }

      /** Resolve one theme token to rgb through a live probe element. */
      function probeToken(token) {
        const el = ensureProbe()
        if (el == null) return null
        el.style.backgroundColor = ''
        el.style.backgroundColor = 'var(' + token + ')'
        let raw = ''
        try {
          raw = globalThis.getComputedStyle(el).backgroundColor
        } catch (error) {
          return null
        }
        return parseRgb(raw)
      }

      function surfaceCss(surfaceAlpha) {
        const declarations = []
        SURFACE_TOKENS.forEach((token) => {
          const rgb = probeToken(token)
          if (rgb == null) return
          const alpha = alphaFor(ALPHA_FLOOR[token], surfaceAlpha).toFixed(4)
          declarations.push('  ' + token + ': rgba(' + rgb.r + ', ' + rgb.g + ', ' + rgb.b + ', ' + alpha + ') !important;')
        })
        if (declarations.length === 0) return ''
        return ['body, body[data-ds-dark-theme] {', ...declarations, '}'].join('\n')
      }

      function clearDom() {
        if (typeof document === 'undefined' || document == null) return
        if (styleEl != null && styleEl.isConnected) styleEl.remove()
        styleEl = null
        if (layerEl != null && layerEl.isConnected) layerEl.remove()
        layerEl = null
        if (scrimEl != null && scrimEl.isConnected) scrimEl.remove()
        scrimEl = null
        if (probeEl != null && probeEl.isConnected) probeEl.remove()
        probeEl = null
        const style = rootStyle()
        if (style != null) BG_PROPS.forEach(property => style.removeProperty(property))
      }

      function revokeObjectUrl() {
        if (objectUrl == null) return
        try { URL.revokeObjectURL(objectUrl) } catch (error) { /* ignore */ }
        objectUrl = null
      }

      function adoptImageUrl(next) {
        if (next !== objectUrl) revokeObjectUrl()
        if (typeof next === 'string' && next.indexOf('blob:') === 0) objectUrl = next
        return next
      }

      function render() {
        const active = state.imageUrl != null && state.asset != null && state.config.enabled
        if (!active) {
          clearDom()
          lastGeometry = null
          return
        }
        if (!ensureDom()) return
        const config = state.config

        // Probe the ORIGINAL palette first: the override sheet is off.
        styleEl.textContent = BASE_CSS
        const backdrop = probeToken('--dsw-alias-bg-base') || { r: 0, g: 0, b: 0 }

        const viewport = readViewport()
        // The layer is inflated by the blur bleed so a blurred edge never shows a
        // hard frame; the geometry must cover that larger box.
        const bleed = 3 * config.blur
        const geometry = computeGeometry({
          fit: config.fit,
          scale: config.scale,
          offsetX: config.offsetX,
          offsetY: config.offsetY,
          viewW: viewport.w + 2 * bleed,
          viewH: viewport.h + 2 * bleed,
          imgW: state.asset.width || viewport.w,
          imgH: state.asset.height || viewport.h,
        })
        lastGeometry = geometry

        const style = rootStyle()
        if (style == null) return
        style.setProperty('--dsh-bg-image', 'url("' + state.imageUrl + '")')
        style.setProperty('--dsh-bg-size', geometry.size)
        style.setProperty('--dsh-bg-position', geometry.position)
        style.setProperty('--dsh-bg-repeat', geometry.repeat)
        style.setProperty('--dsh-bg-bleed', (-3 * config.blur) + 'px')
        style.setProperty('--dsh-bg-filter', config.blur > 0 ? 'blur(' + config.blur + 'px)' : 'none')
        style.setProperty('--dsh-bg-opacity', String(clamp(config.imageOpacity / 100, 0, 1)))
        style.setProperty('--dsh-bg-scrim', config.dim > 0 ? 'rgba(0, 0, 0, ' + (config.dim / 100) + ')' : 'transparent')
        style.setProperty('--dsh-bg-backdrop', 'rgb(' + backdrop.r + ', ' + backdrop.g + ', ' + backdrop.b + ')')

        const surfaces = surfaceCss(config.surfaceOpacity / 100)
        styleEl.textContent = BASE_CSS + (surfaces === '' ? '' : '\n' + surfaces)
        // Re-assert: a host theme pass rewrites :root/body rules, so the plugin
        // sheet must stay the last one in <head> to keep winning.
        if (styleEl.nextSibling != null) document.head.appendChild(styleEl)
      }

      function scheduleReassert() {
        if (rafPending) return
        rafPending = true
        const run = () => {
          rafPending = false
          render()
        }
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
        else setTimeout(run, 16)
      }

      /* ---------------- public face ---------------- */

      const controller = {
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        getSnapshot() { return state },
        getGeometry() { return lastGeometry },
        scheduleReassert,
        setExpanded(expanded) { setState({ expanded: !!expanded }) },
        update(patch) {
          const next = configPatch(patch)
          setState({ config: next })
          render()
          persistConfig()
        },
        resetLayout() {
          controller.update({ fit: 'cover', scale: 100, offsetX: 0, offsetY: 0 })
        },
        chooseFile(file) {
          if (file == null) return Promise.resolve()
          const type = String(file.type || '')
          if (type !== '' && type.indexOf('image/') !== 0) {
            setState({ notice: { key: 'message.notImage', kind: 'error' } })
            return Promise.resolve()
          }
          setState({ busy: true, notice: null })
          return prepareAsset(file)
            .then((prepared) => storeAsset(prepared.record).then((where) => ({ prepared, where })))
            .then(({ prepared, where }) => {
              const url = adoptImageUrl(URL.createObjectURL(prepared.record.blob))
              let notice = prepared.note == null ? null : { key: prepared.note, kind: 'warn' }
              if (where === 'memory') notice = { key: 'message.sessionOnly', kind: 'warn' }
              else if (where === 'dataurl') notice = notice || { key: 'message.storageFallback', kind: 'info' }
              setState({
                asset: metaOf(prepared.record),
                imageUrl: url,
                busy: false,
                notice,
                config: configPatch({ enabled: true }),
              })
              render()
              persistConfig()
            })
            .catch(() => {
              setState({ busy: false, notice: { key: 'message.decodeFailed', kind: 'error' } })
            })
        },
        removeImage() {
          return Promise.resolve()
            .then(() => idbDelete())
            .catch(() => undefined)
            .then(() => {
              lsRemove(LS_IMAGE)
              adoptImageUrl(null)
              setState({
                asset: null,
                imageUrl: null,
                notice: null,
                config: configPatch({ enabled: false }),
              })
              render()
              persistConfig()
            })
        },
        clearAll() {
          return Promise.resolve()
            .then(() => idbDelete())
            .catch(() => undefined)
            .then(() => {
              lsRemove(LS_IMAGE)
              lsRemove(LS_CONFIG)
              adoptImageUrl(null)
              setState({
                config: Object.assign({}, DEFAULTS),
                asset: null,
                imageUrl: null,
                notice: null,
              })
              render()
            })
        },
        init() {
          const saved = readConfig()
          const config = configPatch(saved == null ? {} : saved)
          const merged = Object.assign({}, DEFAULTS, config)
          setState({ config: merged })
          return loadAsset()
            .then((asset) => {
              if (asset == null) return
              const url = asset.blob != null
                ? adoptImageUrl(URL.createObjectURL(asset.blob))
                : adoptImageUrl(asset.dataUrl)
              setState({ asset: asset.meta, imageUrl: url })
              render()
            })
            .catch(() => undefined)
        },
        dispose() {
          listeners.clear()
          if (saveTimer !== null) {
            clearTimeout(saveTimer)
            saveTimer = null
          }
          clearDom()
          revokeObjectUrl()
        },
      }

      return controller
    }

    /* ------------------------------------------------------------------ *
     * Row UI
     * ------------------------------------------------------------------ */

    let controller = null

    function Slider(props) {
      const id = 'dshbg-' + props.name
      return h('div', { className: 'dshbg-slider' },
        h('label', { className: 'dshbg-slider-label', htmlFor: id }, props.label),
        h('input', {
          id,
          className: 'dshbg-range',
          type: 'range',
          min: String(props.min),
          max: String(props.max),
          step: String(props.step == null ? 1 : props.step),
          value: String(props.value),
          'aria-label': props.label,
          onChange: event => { props.onChange(Number(event.target.value)) },
        }),
        h('span', { className: 'dshbg-slider-value' }, props.display))
    }

    function BackgroundRow(props) {
      const t = props != null && typeof props.t === 'function' ? props.t : key => key
      const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot)
      const config = state.config
      const [dragOver, setDragOver] = React.useState(false)
      const [viewport, setViewport] = React.useState(readViewport)
      const [previewGeometry, setPreviewGeometry] = React.useState(null)
      const previewRef = React.useRef(null)
      const fileRef = React.useRef(null)
      const dragRef = React.useRef(null)

      React.useEffect(() => {
        const onResize = () => { setViewport(readViewport()) }
        window.addEventListener('resize', onResize)
        return () => { window.removeEventListener('resize', onResize) }
      }, [])

      React.useEffect(() => {
        const box = previewRef.current
        if (box == null || state.asset == null || state.imageUrl == null) {
          setPreviewGeometry(null)
          return undefined
        }
        const measure = () => {
          const el = previewRef.current
          if (el == null) return
          setPreviewGeometry(computeGeometry({
            fit: config.fit,
            scale: config.scale,
            offsetX: config.offsetX,
            offsetY: config.offsetY,
            viewW: el.clientWidth || 1,
            viewH: el.clientHeight || 1,
            imgW: state.asset.width || 16,
            imgH: state.asset.height || 9,
          }))
        }
        measure()
        if (typeof ResizeObserver === 'function') {
          const observer = new ResizeObserver(measure)
          observer.observe(box)
          return () => { observer.disconnect() }
        }
        window.addEventListener('resize', measure)
        return () => { window.removeEventListener('resize', measure) }
      }, [config.fit, config.scale, config.offsetX, config.offsetY, state.asset, state.imageUrl, state.expanded])

      React.useEffect(() => {
        const box = previewRef.current
        if (box == null) return undefined
        const onWheel = (event) => {
          event.preventDefault()
          const current = controller.getSnapshot().config
          const step = event.deltaY > 0 ? -5 : 5
          controller.update({ scale: clamp(current.scale + step, RANGES.scale[0], RANGES.scale[1]) })
        }
        box.addEventListener('wheel', onWheel, { passive: false })
        return () => { box.removeEventListener('wheel', onWheel) }
      }, [state.expanded, state.imageUrl])

      const onPointerDown = (event) => {
        dragRef.current = {
          x: event.clientX,
          y: event.clientY,
          geometry: previewGeometry,
          offsetX: config.offsetX,
          offsetY: config.offsetY,
        }
        if (typeof event.currentTarget.setPointerCapture === 'function') {
          try { event.currentTarget.setPointerCapture(event.pointerId) } catch (error) { /* ignore */ }
        }
      }
      const onPointerMove = (event) => {
        const drag = dragRef.current
        if (drag == null || drag.geometry == null) return
        const patch = {}
        if (drag.geometry.overflowX > 0) {
          patch.offsetX = clamp(drag.offsetX + ((event.clientX - drag.x) / (drag.geometry.overflowX / 2)) * 100, -100, 100)
        }
        if (drag.geometry.overflowY > 0) {
          patch.offsetY = clamp(drag.offsetY + ((event.clientY - drag.y) / (drag.geometry.overflowY / 2)) * 100, -100, 100)
        }
        if (Object.keys(patch).length > 0) controller.update(patch)
      }
      const onPointerUp = () => { dragRef.current = null }

      const onFileChange = (event) => {
        const input = event.target
        const file = input.files != null ? input.files[0] : null
        if (file != null) void controller.chooseFile(file)
        input.value = ''
      }
      const onDrop = (event) => {
        event.preventDefault()
        setDragOver(false)
        const files = event.dataTransfer != null ? event.dataTransfer.files : null
        if (files != null && files[0] != null) void controller.chooseFile(files[0])
      }

      const asset = state.asset
      const statusText = state.busy
        ? t('status.busy')
        : asset == null
          ? t('status.none')
          : (config.enabled ? t('status.applied') : t('status.disabled')) + ' · ' + asset.name

      const children = [
        h('button', {
          key: 'head',
          type: 'button',
          className: 'dshbg-head',
          'aria-expanded': state.expanded ? 'true' : 'false',
          onClick: () => { controller.setExpanded(!state.expanded) },
        },
          h('span', { className: 'dshbg-head-icon', 'aria-hidden': 'true' }, '🖼'),
          h('span', { className: 'dshbg-head-text' },
            h('span', { className: 'dshbg-head-title' }, t('title')),
            h('span', { className: 'dshbg-head-status' }, statusText)),
          h('span', { className: 'dshbg-chevron', 'aria-hidden': 'true' }, state.expanded ? '▲' : '▼')),
      ]

      if (!state.expanded) {
        return h('div', { className: 'dshbg-row' }, children)
      }

      const body = []
      if (state.notice != null) {
        body.push(h('div', {
          key: 'notice',
          className: 'dshbg-msg' + (state.notice.kind === 'error' ? ' is-error' : state.notice.kind === 'warn' ? ' is-warn' : ''),
          role: state.notice.kind === 'error' ? 'alert' : 'status',
        }, t(state.notice.key)))
      }

      body.push(h('div', { key: 'image', className: 'dshbg-group' },
        h('div', { className: 'dshbg-group-label' }, t('group.image')),
        h('div', {
          className: 'dshbg-drop' + (dragOver ? ' is-over' : ''),
          role: 'button',
          tabIndex: 0,
          onClick: () => { if (fileRef.current != null) fileRef.current.click() },
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              if (fileRef.current != null) fileRef.current.click()
            }
          },
          onDragOver: (event) => { event.preventDefault(); setDragOver(true) },
          onDragLeave: () => { setDragOver(false) },
          onDrop,
        },
          asset == null
            ? h('div', null,
              h('div', { className: 'dshbg-file-name' }, t('upload.cta')),
              h('div', { className: 'dshbg-file-meta' }, t('upload.types')))
            : h(React.Fragment, null,
              h('img', { className: 'dshbg-thumb', src: state.imageUrl, alt: '' }),
              h('div', { className: 'dshbg-file' },
                h('div', { className: 'dshbg-file-name' }, asset.name || 'image'),
                h('div', { className: 'dshbg-file-meta' },
                  formatBytes(asset.size) + ' · '
                  + ((asset.type || '').replace('image/', '') || t('file.unknown')).toUpperCase()
                  + (asset.width > 0 && asset.height > 0 ? ' · ' + asset.width + '×' + asset.height : ''))),
              h('span', { className: 'dshbg-hint' }, t('upload.change')))),
        h('input', {
          ref: fileRef,
          type: 'file',
          accept: 'image/*',
          style: { display: 'none' },
          onChange: onFileChange,
        })))

      if (asset != null) {
        body.push(h('div', { key: 'layout', className: 'dshbg-group' },
          h('div', { className: 'dshbg-group-label' }, t('group.layout')),
          h('div', { className: 'dshbg-chips' }, FITS.map(fit => h('button', {
            key: fit,
            type: 'button',
            className: 'dshbg-chip' + (config.fit === fit ? ' is-active' : ''),
            'aria-pressed': config.fit === fit ? 'true' : 'false',
            onClick: () => { controller.update({ fit }) },
          }, t('fit.' + fit)))),
          h(Slider, {
            name: 'scale', label: t('layout.scale'), min: RANGES.scale[0], max: RANGES.scale[1], step: 1,
            value: config.scale, display: config.scale + '%',
            onChange: value => { controller.update({ scale: value }) },
          }),
          h(Slider, {
            name: 'offset-x', label: t('layout.offsetX'), min: RANGES.offsetX[0], max: RANGES.offsetX[1], step: 1,
            value: config.offsetX, display: String(config.offsetX),
            onChange: value => { controller.update({ offsetX: value }) },
          }),
          h(Slider, {
            name: 'offset-y', label: t('layout.offsetY'), min: RANGES.offsetY[0], max: RANGES.offsetY[1], step: 1,
            value: config.offsetY, display: String(config.offsetY),
            onChange: value => { controller.update({ offsetY: value }) },
          }),
          h('div', {
            ref: previewRef,
            className: 'dshbg-preview',
            role: 'img',
            'aria-label': t('layout.previewTip'),
            style: {
              aspectRatio: viewport.w + ' / ' + viewport.h,
              backgroundImage: 'url("' + state.imageUrl + '")',
              backgroundSize: previewGeometry == null ? 'cover' : previewGeometry.size,
              backgroundPosition: previewGeometry == null ? 'center center' : previewGeometry.position,
              backgroundRepeat: previewGeometry == null ? 'no-repeat' : previewGeometry.repeat,
            },
            onPointerDown,
            onPointerMove,
            onPointerUp,
            onPointerCancel: onPointerUp,
          }, h('span', { className: 'dshbg-preview-tip' }, t('layout.previewTip'))),
          h('div', { className: 'dshbg-hint' }, t('layout.hint')),
          h('div', { className: 'dshbg-actions' },
            h('button', {
              type: 'button',
              className: 'dshbg-btn',
              onClick: () => { controller.resetLayout() },
            }, t('layout.reset')))))

        body.push(h('div', { key: 'effect', className: 'dshbg-group' },
          h('div', { className: 'dshbg-group-label' }, t('group.effect')),
          h(Slider, {
            name: 'image-opacity', label: t('effect.opacity'), min: RANGES.imageOpacity[0], max: RANGES.imageOpacity[1], step: 1,
            value: config.imageOpacity, display: config.imageOpacity + '%',
            onChange: value => { controller.update({ imageOpacity: value }) },
          }),
          h(Slider, {
            name: 'blur', label: t('effect.blur'), min: RANGES.blur[0], max: RANGES.blur[1], step: 1,
            value: config.blur, display: config.blur + 'px',
            onChange: value => { controller.update({ blur: value }) },
          }),
          h(Slider, {
            name: 'dim', label: t('effect.dim'), min: RANGES.dim[0], max: RANGES.dim[1], step: 1,
            value: config.dim, display: config.dim + '%',
            onChange: value => { controller.update({ dim: value }) },
          })))

        body.push(h('div', { key: 'interface', className: 'dshbg-group' },
          h('div', { className: 'dshbg-group-label' }, t('group.interface')),
          h(Slider, {
            name: 'surface-opacity', label: t('interface.opacity'), min: RANGES.surfaceOpacity[0], max: RANGES.surfaceOpacity[1], step: 1,
            value: config.surfaceOpacity, display: config.surfaceOpacity + '%',
            onChange: value => { controller.update({ surfaceOpacity: value }) },
          }),
          h('div', { className: 'dshbg-hint' }, t('interface.hint'))))
      }

      body.push(h('div', { key: 'actions', className: 'dshbg-actions' },
        asset == null
          ? null
          : h('button', {
            type: 'button',
            className: 'dshbg-btn' + (config.enabled ? '' : ' is-primary'),
            disabled: state.busy,
            onClick: () => { controller.update({ enabled: !config.enabled }) },
          }, config.enabled ? t('action.disable') : t('action.enable')),
        h('button', {
          type: 'button',
          className: 'dshbg-btn',
          disabled: state.busy || asset == null,
          onClick: () => { void controller.removeImage() },
        }, t('upload.remove')),
        h('button', {
          type: 'button',
          className: 'dshbg-btn is-danger',
          onClick: () => { void controller.clearAll() },
        }, t('action.clear'))))

      children.push(h('div', { key: 'body', className: 'dshbg-body' }, body))
      return h('div', { className: 'dshbg-row' }, children)
    }

    /* ------------------------------------------------------------------ *
     * Plugin body
     * ------------------------------------------------------------------ */

    function registerDictionaries(ctx) {
      if (ctx.locale == null || typeof ctx.locale.register !== 'function') return
      Object.keys(TEXTS).forEach((locale) => {
        ctx.effect(
          () => ctx.locale.register(NS, locale, TEXTS[locale]),
          'dsh-bg-changer: ' + locale + ' dictionary',
        )
      })
    }

    exports.inject = ['slots', 'locale']

    exports.apply = function apply(ctx) {
      registerDictionaries(ctx)
      controller = createController()

      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'bg-changer',
        // Below every shipped row (permission -20 … composer enter 20).
        order: 100,
        locale: NS,
      }, BackgroundRow))

      let observer = null
      let resizeHandler = null

      const onThemeChange = () => { if (controller != null) controller.scheduleReassert() }

      // Best-effort: the theme event may not reach a sibling fiber.
      try {
        if (typeof ctx.on === 'function') ctx.on('theme/change', onThemeChange)
      } catch (error) { /* the observer below is the real signal */ }

      const startObservers = () => {
        if (typeof MutationObserver === 'function' && domReady()) {
          observer = new MutationObserver(() => { onThemeChange() })
          observer.observe(document.head, { childList: true })
          // `body[data-ds-dark-theme]` is the palette switch (ui-layout
          // theme-presenter) and the host's own restyle pass touches it too.
          observer.observe(document.body, {
            attributes: true,
            attributeFilter: ['data-ds-dark-theme', 'class', 'style'],
          })
        }
        resizeHandler = () => { onThemeChange() }
        window.addEventListener('resize', resizeHandler)
      }

      const stopObservers = () => {
        if (observer != null) {
          observer.disconnect()
          observer = null
        }
        if (resizeHandler != null) {
          window.removeEventListener('resize', resizeHandler)
          resizeHandler = null
        }
      }

      startObservers()
      void controller.init()

      ctx.effect(() => () => {
        stopObservers()
        if (controller != null) {
          controller.dispose()
          controller = null
        }
      }, 'dsh-bg-changer: dispose')
    }

    exports.__internals = {
      clamp,
      alphaFor,
      parseRgb,
      computeGeometry,
      ALPHA_FLOOR,
      DEFAULTS,
      RANGES,
      SURFACE_TOKENS,
      BASE_CSS,
      TEXTS,
    }

    return module.exports
  },
})
