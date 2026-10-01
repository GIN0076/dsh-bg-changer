/**
 * dsh-bg-changer — browser half.
 *
 * Hand-written lazy-CJS client bundle: the module system materializes it via
 * `window.__ModuleLoader__.load({id, factory})`, and the only module-table row
 * it needs is the shell baseline (`react`). No build step, no dependencies.
 *
 * What it does:
 * - registers one preference row into `settings.general.item` at the BOTTOM of
 *   Settings > General (order 101; the shipped rows use -20..100);
 * - uploads an image (PNG/JPEG/WebP/GIF/BMP/AVIF/SVG), then tunes fit, scale,
 *   horizontal/vertical placement (the crop window), image opacity, blur, dim,
 *   and the interface translucency that lets the wallpaper show at all.
 *   An SVG that references anything external is refused instead of stored; a
 *   clean SVG is rasterized to PNG, so the saved wallpaper never fetches
 *   anything at runtime;
 * - paints the wallpaper in a fixed `#dsh-bg-layer` above the page backdrop and
 *   makes the app surfaces translucent by overriding `--dsw-alias-bg-*` tokens
 *   with rgba() values resolved from a live probe element;
 * - keeps every overlay layer (Settings panel, dialogs, menus, tooltips — the
 *   ARIA roles plus the `body > :not(#root)` portal containers) at the
 *   palette's ORIGINAL token alpha, so text stays readable at any slider
 *   position: the slider only dims the in-frame surfaces the wallpaper shows
 *   through, never the reading surfaces on top of them;
 * - persists the config in localStorage and the image blob in IndexedDB.
 *
 * Everything is inert until a wallpaper is enabled: no style tag, no layer
 * element, no host-side behaviour (see lib/index.js).
 *
 * Rendering contract: `update()` never paints synchronously. It marks the
 * controller dirty and coalesces every change in the same animation frame into
 * exactly one `render()`, so dragging the crop preview or sweeping a slider
 * costs one stylesheet pass per frame instead of one per pointer/wheel event.
 * The probed palette is cached per theme and only re-probed when the host
 * announces a theme change.
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
    const LS_IMAGE_DARK = 'dsh-bg-changer:image-dark:v1'
    const IDB_NAME = 'dsh-bg-changer'
    const IDB_STORE = 'assets'
    const IDB_KEY = 'wallpaper'
    const IDB_KEY_DARK = 'wallpaper-dark'
    /** Image slots: the light/default one and the optional dark-theme one. */
    const SLOT_LIGHT = 'light'
    const SLOT_DARK = 'dark'
    /** Backup envelope identity, so a foreign JSON is refused instead of half-applied. */
    const BACKUP_FORMAT = 'dsh-bg-changer/backup'
    const BACKUP_VERSION = 1
    const MAX_BACKUP_BYTES = 64 * 1024 * 1024
    const MAX_EDGE = 4096
    const MAX_KEEP_BYTES = 8 * 1024 * 1024
    const MAX_UPLOAD_BYTES = 40 * 1024 * 1024
    /** Decode budget: beyond this a bitmap is an out-of-memory risk, not a wallpaper. */
    const MAX_PIXELS = 60 * 1000 * 1000
    const LS_IMAGE_MAX_BYTES = 2.5 * 1024 * 1024
    const SAVE_DEBOUNCE_MS = 150
    const DECODE_TIMEOUT_MS = 20000
    /** Row order: after every shipped row (the last one, `current-version`, is 100). */
    const ROW_ORDER = 101
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
      /**
       * true (default) = the wallpaper only shows through the conversation area;
       * the left sidebar/workspace column keeps its own opaque fill.
       * false = the wallpaper shows through the whole interface.
       */
      sidebarOpaque: true,
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
      '--dsw-alias-bg-mask-1': 0,
      '--dsw-alias-bg-module-platform': 0,
      // 0.2.0-rc.2 paints the sidebar column with its own specific token; the
      // 0.1.x token set did not have it, so the sidebar used to stay opaque.
      '--dsw-specific-sidebar-fill': 0,
      '--dsw-specific-menu': 0.45,
      '--dsw-alias-markdown-code-block': 0.35,
      '--dsw-alias-markdown-code-block-banner': 0.35,
      // Readability floors for the surfaces that carry text or input.
      '--dsw-specific-bubble': 0.55,
      '--dsw-specific-input-major': 0.55,
      '--dsw-alias-bg-overlay': 0.6,
      '--dsw-menu-surface-fill': 0.6,
    }
    const SURFACE_TOKENS = Object.keys(ALPHA_FLOOR)
    /** The sidebar column's own fill: kept opaque unless the user opts in. */
    const SIDEBAR_TOKEN = '--dsw-specific-sidebar-fill'
    /**
     * On Windows the shell paints the WHOLE window with the sidebar fill
     * (`[data-windows-titlebar] .BynINW_frame{background:var(--dsw-specific-sidebar-fill)}`),
     * so leaving that token alone hides the wallpaper everywhere. The shell
     * element is found at runtime (top of the app + exactly that colour + covers
     * the window) and marked, so the sheet can clear only its own background and
     * leave the sidebar column untouched. Hashed CSS-module names are never
     * matched directly: eleven other `*_frame` classes exist in the app.
     */
    const FRAME_ATTR = 'data-dsh-bg-frame'
    const SIDEBAR_OPAQUE_CSS = [
      // 1) runtime marking (structure + exact colour + window-sized)
      '[' + FRAME_ATTR + '="1"]{background-color:transparent !important}',
      // 2) static fallbacks: the shell element is the one that has the sidebar
      //    column as a direct child. `sidebarCol` is unique to ui-layout, unlike
      //    `*_frame` which eleven other stylesheets also use.
      '*:has(> [class*="sidebarCol"]){background-color:transparent !important}',
      '#root > *:has([class*="sidebarCol"]){background-color:transparent !important}',
    ].join('\n')

    /**
     * Overlay scopes the translucency slider must never touch: the ARIA roles
     * every DSH dialog/menu carries wherever it mounts (the Settings panel is
     * `role="dialog"`), plus the portal containers that overlays mount into
     * beside `#root` (see `client/web/src/base.css`: "Every overlay portals to
     * document.body beside #root"). A declaration on these elements overrides
     * the body-level rgba() for their whole subtree, so the palette's own
     * alpha wins inside them at every slider position.
     */
    const OPAQUE_SCOPE = ':is([role="dialog"], [role="alertdialog"], [role="menu"], '
      + '[role="listbox"], [role="tooltip"]), body > :not(#root)'

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
        'interface.hint': '调低才能让壁纸透出来；只作用于主界面，设置与弹窗始终清晰',
        'scope.label': '壁纸范围',
        'scope.main': '仅对话区（侧边栏不透明）',
        'scope.all': '全部界面',
        'action.disable': '停用背景',
        'action.enable': '启用背景',
        'action.clear': '清除并重置',
        'image.light': '浅色主题',
        'image.dark': '深色主题',
        'image.lightHint': '默认使用；没设深色图时，深色主题也用它',
        'image.darkHint': '可选；不设就复用浅色图',
        'image.inUse': '当前在用',
        'group.backup': '备份与迁移',
        'backup.hint': '导出会连图片一起打包，换机器或重装后可一键恢复',
        'backup.export': '导出文件',
        'backup.copy': '复制配置',
        'backup.import': '导入文件',
        'backup.paste': '粘贴导入',
        'backup.pastePlaceholder': '把导出的 JSON 粘贴到这里',
        'backup.confirm': '确认导入',
        'backup.cancel': '取消',
        'message.exported': '已导出备份文件；若浏览器没弹出下载，请用「复制配置」',
        'message.copied': '备份已复制到剪贴板',
        'message.copyFailed': '复制失败，请改用「导出文件」',
        'message.exportFailed': '导出失败，请改用「复制配置」',
        'message.imported': '已导入备份',
        'message.importedNoImage': '已导入参数（这份备份里没有图片）',
        'message.importFailed': '备份无法识别，请确认是本插件导出的 JSON',
        'message.importTooLarge': '备份文件太大，已拒绝导入',
        'status.dark': '深色图',
        'status.opaque': '界面 100% 不透明，壁纸被挡住',
        'diagnose.run': '检查显示（为什么看不见壁纸）',
        'message.compressed': '图片较大，已压缩到最长边 4096px',
        'message.gifLarge': '动图较大，未压缩（保留动画）',
        'message.compressFailed': '压缩失败，已使用原始图片',
        'message.sessionOnly': '浏览器存储不可用，本次设置只在当前会话生效',
        'message.storageFallback': '浏览器存储降级为本地记录',
        'message.decodeFailed': '无法解码该图片格式',
        'message.notImage': '请选择图片文件',
        'message.tooLarge': '图片超过 40MB，请先压缩或换一张',
        'message.tooManyPixels': '图片像素太多（解码会占用过多内存），请换一张更小的图',
        'message.decodeTimeout': '图片处理超时，请重试或换一张图',
        'message.svgRefused': '该 SVG 引用了外部资源或脚本，已拒绝保存（避免联网取图）',
        'message.svgRasterized': 'SVG 已转换为 PNG 保存',
        'message.transparencyUnavailable': '读不到主题颜色，界面不透明度暂时不生效（壁纸仍然显示）',
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
        'interface.hint': 'Lower it to reveal the wallpaper; it only affects the main UI — Settings and dialogs always stay clear',
        'scope.label': 'Wallpaper scope',
        'scope.main': 'Conversation area only (sidebar opaque)',
        'scope.all': 'Whole interface',
        'action.disable': 'Disable wallpaper',
        'action.enable': 'Enable wallpaper',
        'action.clear': 'Clear and reset',
        'image.light': 'Light theme',
        'image.dark': 'Dark theme',
        'image.lightHint': 'Always used as the default; the dark theme falls back to it',
        'image.darkHint': 'Optional; without it the light image is reused',
        'image.inUse': 'in use',
        'group.backup': 'Backup & migration',
        'backup.hint': 'The export bundles the images, so a reinstall can restore everything in one click',
        'backup.export': 'Export file',
        'backup.copy': 'Copy config',
        'backup.import': 'Import file',
        'backup.paste': 'Paste import',
        'backup.pastePlaceholder': 'Paste the exported JSON here',
        'backup.confirm': 'Import',
        'backup.cancel': 'Cancel',
        'message.exported': 'Backup exported; if no download appeared, use “Copy config”',
        'message.copied': 'Backup copied to the clipboard',
        'message.copyFailed': 'Copy failed — use “Export file” instead',
        'message.exportFailed': 'Export failed — use “Copy config” instead',
        'message.imported': 'Backup imported',
        'message.importedNoImage': 'Settings imported (this backup carries no image)',
        'message.importFailed': 'That backup is not recognized — pick a JSON this plugin exported',
        'message.importTooLarge': 'That backup is too large to import',
        'status.dark': 'dark image',
        'status.opaque': 'interface is opaque — wallpaper hidden',
        'diagnose.run': 'Diagnose why the wallpaper is hidden',
        'message.compressed': 'Large image: compressed to a 4096px longest edge',
        'message.gifLarge': 'Large animation kept uncompressed to preserve motion',
        'message.compressFailed': 'Compression failed; the original image is used',
        'message.sessionOnly': 'Browser storage unavailable: this setting lasts for this session only',
        'message.storageFallback': 'Browser storage fell back to a local record',
        'message.decodeFailed': 'Could not decode that image format',
        'message.notImage': 'Please choose an image file',
        'message.tooLarge': 'That image is over 40MB — compress it or pick another one',
        'message.tooManyPixels': 'That image has too many pixels to decode safely — pick a smaller one',
        'message.decodeTimeout': 'Image processing timed out — try again or pick another image',
        'message.svgRefused': 'That SVG references external resources or scripts, so it was refused (no network fetch)',
        'message.svgRasterized': 'SVG converted to PNG',
        'message.transparencyUnavailable': 'Theme colors could not be read: interface opacity is inert (the wallpaper still shows)',
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
      '.dshbg-head-icon{display:flex;align-items:center;justify-content:center;width:20px;height:20px;'
        + 'flex:0 0 auto;color:var(--dsw-alias-label-secondary,#666)}',
      '.dshbg-head-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.dshbg-head-title{font-size:14px;line-height:22px;font-weight:500}',
      '.dshbg-head-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#666);'
        + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshbg-chevron{display:flex;align-items:center;flex:0 0 auto;'
        + 'color:var(--dsw-alias-label-secondary,#666);transition:transform .15s ease}',
      '.dshbg-chevron.is-open{transform:rotate(180deg)}',
      '.dshbg-body{display:flex;flex-direction:column;gap:14px;padding:0 14px 14px}',
      '.dshbg-group{display:flex;flex-direction:column;gap:8px}',
      '.dshbg-group-label{font-size:12px;line-height:18px;font-weight:600;letter-spacing:.04em;'
        + 'color:var(--dsw-alias-label-secondary,#666)}',
      '.dshbg-drop{display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px dashed '
        + 'var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:10px;background:transparent;cursor:pointer}',
      '.dshbg-drop:hover,.dshbg-drop.is-over{border-color:var(--dsw-alias-brand-primary,#4176e6)}',
      '.dshbg-drop.has-image{border-style:solid;border-color:var(--dsw-alias-border-l1,rgba(0,0,0,.08))}',
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
      '.dshbg-slot{display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:10px;'
        + 'border:0.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08))}',
      '.dshbg-slot.is-active{border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.14));'
        + 'background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.02))}',
      '.dshbg-slot-head{display:flex;flex-direction:column;gap:2px}',
      '.dshbg-slot-title{display:flex;align-items:center;gap:8px}',
      '.dshbg-slot-label{font-size:12px;line-height:18px;font-weight:600}',
      '.dshbg-slot-badge{padding:1px 6px;border-radius:6px;font-size:11px;line-height:16px;'
        + 'background:var(--dsw-alias-brand-primary,#4176e6);color:var(--dsw-alias-label-primary-inverted,#fff)}',
      '.dshbg-slot-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#666)}',
      '.dshbg-paste{display:flex;flex-direction:column;gap:8px}',
      '.dshbg-paste-area{width:100%;min-height:72px;resize:vertical;box-sizing:border-box;padding:8px;'
        + 'border-radius:8px;font:inherit;font-size:12px;line-height:18px;color:inherit;'
        + 'border:0.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));'
        + 'background-color:var(--dsw-alias-bg-layer-3,rgba(0,0,0,.06))}',
      '.dshbg-link{align-self:flex-start;background:none;border:0;padding:0;font:inherit;font-size:12px;'
        + 'line-height:18px;color:var(--dsw-alias-brand-primary,#4176e6);cursor:pointer;text-align:left}',
      '.dshbg-diag{margin:0;padding:8px 10px;border-radius:8px;max-height:240px;overflow:auto;'
        + 'font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:16px;'
        + 'white-space:pre-wrap;word-break:break-all;color:var(--dsw-alias-label-secondary,#666);'
        + 'background:var(--dsw-alias-bg-layer-3,rgba(0,0,0,.04))}',
      '.dshbg-field{display:flex;flex-direction:column;gap:6px}',
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
     * Parse a computed CSS color into rgb channels plus its original alpha.
     * @returns r/g/b/a, or null when the value is unresolved (fully transparent).
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
      return {
        r: Math.round(Number(match[1])),
        g: Math.round(Number(match[2])),
        b: Math.round(Number(match[3])),
        a: clamp(alpha, 0, 1),
      }
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

    /**
     * Whether an SVG source can reach outside itself: a script, a foreignObject
     * (which can carry HTML), an `<image>` reference, or any href that is not a
     * same-document fragment. Such a file is refused rather than stored, so the
     * saved wallpaper can never make the renderer fetch a remote resource.
     * Deliberately conservative: a false positive only refuses one upload.
     */
    function svgHasExternalReferences(text) {
      if (typeof text !== 'string' || text.length === 0) return true
      const lower = text.toLowerCase()
      if (lower.indexOf('<script') >= 0) return true
      if (lower.indexOf('<foreignobject') >= 0) return true
      if (lower.indexOf('<image') >= 0) return true
      if (lower.indexOf('javascript:') >= 0) return true
      // Every href must be a same-document fragment: href="#id".
      const hrefs = lower.match(/(?:xlink:)?href\s*=\s*("[^"]*"|'[^']*')/g) || []
      for (let i = 0; i < hrefs.length; i += 1) {
        const value = hrefs[i].slice(hrefs[i].indexOf('=') + 1).replace(/^["']|["']$/g, '').trim()
        if (value.charAt(0) !== '#') return true
      }
      // Any url(...) inside a style/attribute is an external resource.
      if (/url\(\s*(?!["']?#)/.test(lower)) return true
      return false
    }

    /** Reject after `ms` with an error carrying a user-facing message key. */
    function withTimeout(promise, ms, noticeKey) {
      return new Promise((resolve, reject) => {
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          const error = new Error('timed out')
          error.noticeKey = noticeKey
          reject(error)
        }, ms)
        promise.then(
          (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value) } },
          (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error) } },
        )
      })
    }

    /** One diagnostic line; never throws and never carries image data. */
    function warn(message, error) {
      try {
        if (typeof console !== 'undefined' && console != null && typeof console.warn === 'function') {
          console.warn('[dsh-bg-changer] ' + message, error == null ? '' : error)
        }
      } catch (ignored) { /* logging must never break the feature */ }
    }

    /** Only `blob:` and `data:image/…` may ever reach a CSS url(). */
    function safeImageUrl(value) {
      if (typeof value !== 'string' || value.length === 0) return null
      if (value.indexOf('blob:') === 0) return value
      if (/^data:image\//i.test(value)) return value
      return null
    }

    /** Decode a data: URL into a Blob without touching the network. */
    function dataUrlToBlob(dataUrl) {
      if (typeof dataUrl !== 'string') return null
      const comma = dataUrl.indexOf(',')
      if (comma < 0) return null
      const header = dataUrl.slice(0, comma)
      const body = dataUrl.slice(comma + 1)
      const mime = (/^data:([^;,]*)/i.exec(header) || [])[1] || 'application/octet-stream'
      try {
        if (!/;base64/i.test(header)) return new Blob([decodeURIComponent(body)], { type: mime })
        const binary = atob(body)
        const bytes = new Uint8Array(binary.length)
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
        return new Blob([bytes], { type: mime })
      } catch (error) {
        return null
      }
    }

    /** The portable backup envelope written by 「导出」. */
    function buildBackup(config, images, now) {
      return {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exportedAt: new Date(now == null ? Date.now() : now).toISOString(),
        config,
        images,
      }
    }

    /**
     * Validate a pasted/imported backup: anything that is not one of ours is
     * refused outright instead of half-applied.
     * @returns { config, images } or throws an error carrying a notice key.
     */
    function parseBackup(text) {
      if (typeof text !== 'string' || text.trim() === '') throw noticeError('message.importFailed')
      if (text.length > MAX_BACKUP_BYTES) throw noticeError('message.importTooLarge')
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch (error) {
        throw noticeError('message.importFailed')
      }
      if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) throw noticeError('message.importFailed')
      if (parsed.format !== BACKUP_FORMAT) throw noticeError('message.importFailed')
      if (Number(parsed.version) > BACKUP_VERSION) throw noticeError('message.importFailed')
      if (parsed.config == null || typeof parsed.config !== 'object' || Array.isArray(parsed.config)) {
        throw noticeError('message.importFailed')
      }
      const images = {}
      const raw = parsed.images != null && typeof parsed.images === 'object' ? parsed.images : {}
      ;[SLOT_LIGHT, SLOT_DARK].forEach((slot) => {
        const entry = raw[slot]
        if (entry == null || typeof entry !== 'object') return
        if (safeImageUrl(entry.dataUrl) == null) return
        images[slot] = {
          name: typeof entry.name === 'string' ? entry.name : 'image',
          type: typeof entry.type === 'string' ? entry.type : '',
          width: Number(entry.width) || 0,
          height: Number(entry.height) || 0,
          dataUrl: entry.dataUrl,
        }
      })
      return { config: parsed.config, images }
    }

    /** Trigger a download of one text payload (the shell may block it). */
    function downloadText(text, filename) {
      try {
        const blob = new Blob([text], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = filename
        anchor.setAttribute('rel', 'noopener')
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        setTimeout(() => { try { URL.revokeObjectURL(url) } catch (error) { /* gone */ } }, 1000)
        return true
      } catch (error) {
        warn('backup download failed', error)
        return false
      }
    }

    /** Clipboard write with a hidden-textarea fallback for restricted shells. */
    function copyText(text) {
      const clipboard = globalThis.navigator != null ? globalThis.navigator.clipboard : null
      if (clipboard != null && typeof clipboard.writeText === 'function') {
        return clipboard.writeText(text).then(() => true, () => legacyCopy(text))
      }
      return Promise.resolve(legacyCopy(text))
    }

    function legacyCopy(text) {
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '1')
        area.style.cssText = 'position:fixed;left:-9999px;top:0'
        document.body.appendChild(area)
        area.select()
        const copied = typeof document.execCommand === 'function' ? document.execCommand('copy') : false
        area.remove()
        return copied === true
      } catch (error) {
        return false
      }
    }

    /** Whether the browser half may touch the DOM at all. */
    function domReady() {
      return typeof document !== 'undefined' && document !== null && document.body != null
    }

    /** Whether the host currently paints the dark palette. */
    function themeIsDark() {
      if (!domReady() || typeof document.body.hasAttribute !== 'function') return false
      try {
        return document.body.hasAttribute('data-ds-dark-theme')
      } catch (error) {
        return false
      }
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

    /** Probe localStorage once per session instead of on every read/write. */
    let storageProbe
    let storageChecked = false

    function probeStorage() {
      if (storageChecked) return storageProbe
      storageChecked = true
      try {
        const ls = globalThis.localStorage
        if (!ls) { storageProbe = null; return storageProbe }
        const probe = 'dsh-bg-changer:probe'
        ls.setItem(probe, '1')
        ls.removeItem(probe)
        storageProbe = ls
      } catch (error) {
        storageProbe = null
      }
      return storageProbe
    }

    /** Drop the cache so the next call re-probes (used after a write fails). */
    function invalidateStorageProbe() {
      storageChecked = false
      storageProbe = undefined
    }

    function safeStorage() {
      return probeStorage()
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
        // Quota or a revoked storage handle: re-probe once, then give up.
        invalidateStorageProbe()
        warn('localStorage write failed for ' + key, error)
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
        const close = () => {
          try { db.close() } catch (closeError) { /* already closing */ }
        }
        let tx
        let store
        let request
        try {
          tx = db.transaction(IDB_STORE, mode)
          store = tx.objectStore(IDB_STORE)
        } catch (error) {
          close()
          reject(error)
          return
        }
        try {
          request = action(store)
        } catch (error) {
          close()
          reject(error)
          return
        }
        tx.oncomplete = () => {
          close()
          resolve(request ? request.result : undefined)
        }
        tx.onerror = () => {
          close()
          reject(tx.error || new Error('indexedDB transaction failed'))
        }
        tx.onabort = () => {
          close()
          reject(tx.error || new Error('indexedDB transaction aborted'))
        }
      }))
    }

    const idbPut = (record, key) => idbRun('readwrite', store => store.put(record, key))
    const idbGet = (key) => idbRun('readonly', store => store.get(key))
    const idbDelete = (key) => idbRun('readwrite', store => store.delete(key))

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

    function reencode(source, width, height, force) {
      return Promise.resolve().then(() => {
        const longest = Math.max(width, height) || 1
        const ratio = Math.min(1, MAX_EDGE / longest)
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(width * ratio))
        canvas.height = Math.max(1, Math.round(height * ratio))
        const context = canvas.getContext('2d')
        if (context == null) return null
        return Promise.resolve()
          .then(() => (typeof createImageBitmap === 'function' ? createImageBitmap(source) : null))
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
            if (blob == null || blob.size === 0) return null
            // Keep the original when re-encoding would not actually shrink it,
            // unless the caller needs a raster (an SVG must never be stored raw).
            if (force !== true && blob.size >= source.size) return null
            return { blob, width: canvas.width, height: canvas.height }
          })
      })
    }

    /** An error whose user-facing message key travels with the rejection. */
    function noticeError(key) {
      const error = new Error(key)
      error.noticeKey = key
      return error
    }

    function readText(file) {
      return new Promise((resolve, reject) => {
        const Reader = globalThis.FileReader
        if (!Reader) { reject(noticeError('message.decodeFailed')); return }
        const reader = new Reader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error || noticeError('message.decodeFailed'))
        reader.readAsText(file)
      })
    }

    /**
     * Turn one clean SVG upload into a PNG so nothing the wallpaper references
     * can be fetched at paint time. Files that reference anything external (or
     * carry a script) are refused by `svgHasExternalReferences`.
     */
    function rasterizeSvg(file) {
      let url = ''
      return readText(file)
        .then((text) => {
          if (svgHasExternalReferences(text)) throw noticeError('message.svgRefused')
          return new Promise((resolve, reject) => {
            try { url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' })) }
            catch (error) { reject(noticeError('message.svgRefused')); return }
            const image = new Image()
            image.onload = () => {
              try {
                const width = image.naturalWidth || 0
                const height = image.naturalHeight || 0
                if (width <= 0 || height <= 0) { reject(noticeError('message.svgRefused')); return }
                if (width * height > MAX_PIXELS) { reject(noticeError('message.tooManyPixels')); return }
                const longest = Math.max(width, height)
                const ratio = Math.min(1, MAX_EDGE / longest)
                const canvas = document.createElement('canvas')
                canvas.width = Math.max(1, Math.round(width * ratio))
                canvas.height = Math.max(1, Math.round(height * ratio))
                const context = canvas.getContext('2d')
                if (context == null) { reject(noticeError('message.svgRefused')); return }
                context.drawImage(image, 0, 0, canvas.width, canvas.height)
                canvas.toBlob((png) => {
                  if (png == null || png.size === 0) reject(noticeError('message.svgRefused'))
                  else resolve({ blob: png, width: canvas.width, height: canvas.height })
                }, 'image/png')
              } catch (error) {
                reject(error)
              }
            }
            image.onerror = () => reject(noticeError('message.svgRefused'))
            image.src = url
          })
        })
        .then(
          (result) => { releaseUrl(); return result },
          (error) => { releaseUrl(); throw error },
        )

      function releaseUrl() {
        if (url === '') return
        try { URL.revokeObjectURL(url) } catch (error) { /* already gone */ }
        url = ''
      }
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
     * Every rejection carries `noticeKey`, so the row can explain exactly why.
     * @returns { record, note } where note is an optional message key.
     */
    function prepareAsset(file) {
      const declaredType = String(file.type || '')
      const name = String(file.name || 'image')
      const isSvg = declaredType === 'image/svg+xml' || /\.svg$/i.test(name)
      if (Number(file.size) > MAX_UPLOAD_BYTES) return Promise.reject(noticeError('message.tooLarge'))

      const decoded = isSvg ? rasterizeSvg(file) : decodeImage(file)
      return withTimeout(decoded, DECODE_TIMEOUT_MS, 'message.decodeTimeout').then((decodedAsset) => {
        let blob
        let width
        let height
        let note = isSvg ? 'message.svgRasterized' : null

        if (isSvg) {
          blob = decodedAsset.blob
          width = decodedAsset.width
          height = decodedAsset.height
          return finish()
        }

        width = decodedAsset.width
        height = decodedAsset.height
        if (width * height > MAX_PIXELS) throw noticeError('message.tooManyPixels')
        blob = file
        if (Math.max(width, height) > MAX_EDGE || file.size > MAX_KEEP_BYTES) {
          if (declaredType === 'image/gif') {
            note = 'message.gifLarge'
          } else {
            return withTimeout(reencode(file, width, height, false), DECODE_TIMEOUT_MS, 'message.decodeTimeout')
              .then((scaled) => {
                if (scaled != null) {
                  blob = scaled.blob
                  // Report the dimensions actually stored, not the original ones.
                  width = scaled.width
                  height = scaled.height
                }
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
              name,
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
        assetDark: null,
        imageUrlDark: null,
        notice: null,
        expanded: false,
        busy: false,
        diagnostic: null,
      }
      let styleEl = null
      let layerEl = null
      let scrimEl = null
      let probeEl = null
      /** Live blob URLs, one per image slot. */
      const objectUrls = { light: null, dark: null }
      /** The uploaded blobs, so a backup export works even before storage settles. */
      const liveBlobs = { light: null, dark: null }
      let saveTimer = null
      /** True while a coalesced render is already queued. */
      let renderPending = false
      let rafId = null
      /** Set once the palette cannot be read, so the row explains itself once. */
      let transparencyWarned = false
      /** Bumped whenever the user acts, so a late `init()` cannot overrule them. */
      let loadGeneration = 0
      /** After dispose nothing may touch the DOM again, not even a late promise. */
      let disposed = false
      const listeners = new Set()

      const notify = () => {
        if (disposed) return
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

      function cancelSaveTimer() {
        if (saveTimer !== null) {
          clearTimeout(saveTimer)
          saveTimer = null
        }
      }

      function persistConfig() {
        if (disposed) return
        cancelSaveTimer()
        saveTimer = setTimeout(() => {
          saveTimer = null
          lsSet(LS_CONFIG, JSON.stringify(state.config))
        }, SAVE_DEBOUNCE_MS)
      }

      /* ---------------- image persistence ---------------- */

      /** Storage coordinates for one image slot. */
      function slotKeys(slot) {
        return slot === SLOT_DARK
          ? { idb: IDB_KEY_DARK, ls: LS_IMAGE_DARK }
          : { idb: IDB_KEY, ls: LS_IMAGE }
      }

      /** State patch for one image slot. */
      function slotPatch(slot, meta, url) {
        return slot === SLOT_DARK
          ? { assetDark: meta, imageUrlDark: url }
          : { asset: meta, imageUrl: url }
      }

      function storeAsset(record, slot) {
        const keys = slotKeys(slot)
        return idbPut(record, keys.idb)
          .then(() => {
            lsRemove(keys.ls)
            return 'idb'
          })
          .catch((error) => {
            warn('indexedDB store failed for the ' + slot + ' image', error)
            if (record.size > LS_IMAGE_MAX_BYTES) return 'memory'
            return blobToDataUrl(record.blob)
              .then(dataUrl => {
                const payload = Object.assign({}, metaOf(record), { dataUrl })
                return lsSet(keys.ls, JSON.stringify(payload)) ? 'dataurl' : 'memory'
              })
              .catch(() => 'memory')
          })
      }

      function loadAsset(slot) {
        const keys = slotKeys(slot)
        return idbGet(keys.idb)
          .then((record) => {
            if (record != null && record.blob instanceof Blob) {
              return { blob: record.blob, meta: metaOf(record) }
            }
            return loadAssetFromStorage(slot)
          })
          .catch(() => loadAssetFromStorage(slot))
      }

      function loadAssetFromStorage(slot) {
        const raw = lsGet(slotKeys(slot).ls)
        if (raw == null) return null
        try {
          const parsed = JSON.parse(raw)
          if (parsed == null || safeImageUrl(parsed.dataUrl) == null) return null
          return { dataUrl: parsed.dataUrl, meta: metaOf(parsed) }
        } catch (error) {
          return null
        }
      }

      /** The blob behind one slot: memory first, then storage. Used by export. */
      function readStoredImage(slot) {
        if (liveBlobs[slot] != null) {
          const meta = slot === SLOT_DARK ? state.assetDark : state.asset
          return Promise.resolve({ blob: liveBlobs[slot], meta: meta || metaOf({}) })
        }
        return loadAsset(slot).then((found) => {
          if (found == null) return null
          if (found.blob != null) return found
          const blob = dataUrlToBlob(found.dataUrl)
          return blob == null ? null : { blob, meta: found.meta }
        })
      }

      /* ---------------- DOM engine ---------------- */

      function rootStyle() {
        return domReady() ? document.documentElement.style : null
      }

      /**
       * The row's OWN stylesheet. It must exist whenever the row is mounted,
       * including the "nothing set yet" state: without it every control renders
       * with the browser's default look (the 0.1.x/0.2.0 bug this fixes).
       */
      function ensureStyle() {
        if (!domReady()) return false
        if (styleEl == null || !styleEl.isConnected) {
          const stale = document.querySelector('style[' + STYLE_ATTR + ']')
          if (stale != null) stale.remove()
          styleEl = document.createElement('style')
          styleEl.setAttribute(STYLE_ATTR, '1')
          styleEl.textContent = BASE_CSS
          document.head.appendChild(styleEl)
        }
        return true
      }

      /** Remove the row's stylesheet (only on dispose). */
      function removeStyle() {
        if (styleEl != null && styleEl.isConnected) styleEl.remove()
        styleEl = null
      }

      /** The wallpaper layer, the dim scrim and the colour probe. */
      function ensureDom() {
        if (!ensureStyle()) return false
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

      /**
       * The probed palette, cached for the active theme. Re-probing costs nine
       * getComputedStyle reads (each one a style recalculation), so it happens
       * once per theme instead of once per render — that is what makes dragging
       * the preview and sweeping a slider cheap.
       */
      let palette = null

      /** Resolve (and memoize) every surface token plus the app backdrop. */
      function resolvePalette() {
        if (palette != null) return palette
        const entries = []
        SURFACE_TOKENS.forEach((token) => {
          const rgb = probeToken(token)
          if (rgb != null) entries.push({ token, rgb })
        })
        palette = { entries, backdrop: probeToken('--dsw-alias-bg-base') || { r: 0, g: 0, b: 0, a: 1 } }
        return palette
      }

      /** A host theme pass rewrote the palette: re-probe on the next render. */
      function invalidatePalette() {
        palette = null
        frameScanDone = false
      }

      /**
       * Two blocks over the same probed palette: the body-level translucent
       * values the slider drives, and the original-alpha values re-declared on
       * every overlay scope so dialogs/menus/Settings stay fully readable
       * (a local declaration beats the value inherited from `body`).
       */
      /**
       * Mark every element that paints a WINDOW-SIZED opaque area with the
       * sidebar fill colour, so the sheet can clear exactly those backgrounds.
       * The shell element sits at an unknown depth (a previous one-level scan
       * missed it), so this walks body/#root breadth-first with a hard cap, and
       * never matches hashed class names (eleven `*_frame` classes exist).
       */
      let markedFrames = []
      let frameScanDone = false
      let lastFrameScan = { visited: 0, marked: 0 }

      function clearFrameMarks() {
        markedFrames.forEach((el) => {
          if (el != null && typeof el.removeAttribute === 'function') el.removeAttribute(FRAME_ATTR)
        })
        markedFrames = []
      }

      function markWindowFrame() {
        lastFrameScan = { visited: 0, marked: 0 }
        if (!domReady()) return
        clearFrameMarks()
        const sidebar = resolvePalette().entries.find(entry => entry.token === SIDEBAR_TOKEN)
        if (sidebar == null) return
        const viewportW = (typeof window !== 'undefined' ? window.innerWidth : 0) || 0
        const viewportH = (typeof window !== 'undefined' ? window.innerHeight : 0) || 0
        if (viewportW <= 0 || viewportH <= 0) return
        const near = (left, right) => Math.abs(left - right) <= 2
        const matches = (el) => {
          let raw = ''
          try { raw = globalThis.getComputedStyle(el).backgroundColor } catch (error) { return false }
          const rgb = parseRgb(raw)
          if (rgb == null || rgb.a < 0.9) return false
          if (!near(rgb.r, sidebar.rgb.r) || !near(rgb.g, sidebar.rgb.g) || !near(rgb.b, sidebar.rgb.b)) return false
          try {
            const rect = el.getBoundingClientRect()
            return rect.width >= viewportW * 0.9 && rect.height >= viewportH * 0.9
          } catch (error) {
            return false
          }
        }
        const queue = []
        if (document.body != null) queue.push(document.body)
        const appRoot = document.getElementById('root')
        if (appRoot != null && appRoot !== document.body) queue.push(appRoot)
        while (queue.length > 0 && lastFrameScan.visited < 1200) {
          const el = queue.shift()
          lastFrameScan.visited += 1
          if (el == null) continue
          if (matches(el)) {
            el.setAttribute(FRAME_ATTR, '1')
            markedFrames.push(el)
            lastFrameScan.marked += 1
          }
          const children = el.children
          if (children == null) continue
          for (let index = 0; index < children.length; index += 1) queue.push(children[index])
        }
        if (lastFrameScan.marked === 0) {
          warn('no window-sized shell element matched the sidebar fill; the wallpaper may stay hidden')
        }
      }

      function surfaceCss(surfaceAlpha, sidebarOpaque) {
        const resolved = resolvePalette()
        const entries = sidebarOpaque ? resolved.entries.filter(entry => entry.token !== SIDEBAR_TOKEN) : resolved.entries
        if (entries.length === 0) return ''
        const translucent = []
        const opaque = []
        entries.forEach(({ token, rgb }) => {
          const alpha = alphaFor(ALPHA_FLOOR[token], surfaceAlpha).toFixed(4)
          translucent.push('  ' + token + ': rgba(' + rgb.r + ', ' + rgb.g + ', ' + rgb.b + ', ' + alpha + ') !important;')
          const original = clamp(rgb.a == null ? 1 : rgb.a, 0, 1).toFixed(4)
          opaque.push('  ' + token + ': rgba(' + rgb.r + ', ' + rgb.g + ', ' + rgb.b + ', ' + original + ') !important;')
        })
        const blocks = [
          ['body, body[data-ds-dark-theme] {', ...translucent, '}'].join('\n'),
          [OPAQUE_SCOPE + ' {', ...opaque, '}'].join('\n'),
        ]
        if (sidebarOpaque) {
          // The window-wide shell keeps its own opaque fill, so it must not paint
          // over the wallpaper: mark it, then clear exactly that background.
          // The scan is structural, so it only has to run when the DOM or the
          // theme changed, not on every frame.
          if (!frameScanDone) {
            markWindowFrame()
            frameScanDone = true
          }
          blocks.push(SIDEBAR_OPAQUE_CSS)
        } else if (markedFrames.length > 0) {
          clearFrameMarks()
          frameScanDone = false
        }
        return blocks.join('\n')
      }

      function clearDom() {
        if (typeof document === 'undefined' || document == null) return
        if (layerEl != null && layerEl.isConnected) layerEl.remove()
        layerEl = null
        if (scrimEl != null && scrimEl.isConnected) scrimEl.remove()
        scrimEl = null
        if (probeEl != null && probeEl.isConnected) probeEl.remove()
        probeEl = null
        const style = rootStyle()
        if (style != null) BG_PROPS.forEach(property => style.removeProperty(property))
      }

      function revokeObjectUrl(slot) {
        const current = objectUrls[slot]
        if (current == null) return
        try { URL.revokeObjectURL(current) } catch (error) { /* already gone */ }
        objectUrls[slot] = null
      }

      function revokeAllObjectUrls() {
        revokeObjectUrl(SLOT_LIGHT)
        revokeObjectUrl(SLOT_DARK)
      }

      function adoptImageUrl(next, slot) {
        const key = slot === SLOT_DARK ? SLOT_DARK : SLOT_LIGHT
        const safe = safeImageUrl(next)
        if (safe !== objectUrls[key]) revokeObjectUrl(key)
        if (safe != null && safe.indexOf('blob:') === 0) objectUrls[key] = safe
        return safe
      }

      /** `body[data-ds-dark-theme]` is the palette switch (verified in 0.2.0-rc.2). */
      function isDarkTheme() {
        return themeIsDark()
      }

      /** What the active theme paints: dark when it is ready, else the light image. */
      function activeImage() {
        const darkUrl = safeImageUrl(state.imageUrlDark)
        const lightUrl = safeImageUrl(state.imageUrl)
        const darkReady = darkUrl != null && state.assetDark != null
        const lightReady = lightUrl != null && state.asset != null
        // A dark-only setup still paints in the light theme, so one uploaded
        // image always means a visible wallpaper.
        if (darkReady && (isDarkTheme() || !lightReady)) {
          return { url: darkUrl, asset: state.assetDark, slot: SLOT_DARK }
        }
        return { url: lightUrl, asset: state.asset, slot: SLOT_LIGHT }
      }

      /** Skip a custom-property write that would not change anything. */
      function setVar(style, name, value) {
        if (typeof style.getPropertyValue === 'function' && style.getPropertyValue(name) === value) return
        style.setProperty(name, value)
      }

      function render() {
        if (disposed) return
        // The row's own styles must be present even with nothing set.
        if (!ensureStyle()) return
        const chosen = activeImage()
        const imageUrl = chosen.url
        const active = imageUrl != null && chosen.asset != null && state.config.enabled
        if (!active) {
          clearDom()
          if (styleEl.textContent !== BASE_CSS) styleEl.textContent = BASE_CSS
          return
        }
        if (!ensureDom()) return
        const config = state.config
        const style = rootStyle()
        if (style == null) return

        // A cold palette cache must read the ORIGINAL tokens, so the override
        // block has to be off while `resolvePalette()` probes them.
        if (palette == null && styleEl.textContent !== BASE_CSS) styleEl.textContent = BASE_CSS

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
          imgW: chosen.asset.width || viewport.w,
          imgH: chosen.asset.height || viewport.h,
        })

        const backdrop = resolvePalette().backdrop
        setVar(style, '--dsh-bg-image', 'url("' + imageUrl + '")')
        setVar(style, '--dsh-bg-size', geometry.size)
        setVar(style, '--dsh-bg-position', geometry.position)
        setVar(style, '--dsh-bg-repeat', geometry.repeat)
        setVar(style, '--dsh-bg-bleed', (-3 * config.blur) + 'px')
        setVar(style, '--dsh-bg-filter', config.blur > 0 ? 'blur(' + config.blur + 'px)' : 'none')
        setVar(style, '--dsh-bg-opacity', String(clamp(config.imageOpacity / 100, 0, 1)))
        setVar(style, '--dsh-bg-scrim', config.dim > 0 ? 'rgba(0, 0, 0, ' + (config.dim / 100) + ')' : 'transparent')
        setVar(style, '--dsh-bg-backdrop', 'rgb(' + backdrop.r + ', ' + backdrop.g + ', ' + backdrop.b + ')')

        const surfaces = surfaceCss(config.surfaceOpacity / 100, config.sidebarOpaque !== false)
        const css = BASE_CSS + (surfaces === '' ? '' : '\n' + surfaces)
        if (styleEl.textContent !== css) styleEl.textContent = css
        // Re-assert: a host theme pass rewrites :root/body rules, so the plugin
        // sheet must stay the last one in <head> to keep winning.
        if (styleEl.nextSibling != null) document.head.appendChild(styleEl)

        // Degraded, but visible: say so once instead of leaving a dead slider.
        if (surfaces === '' && !transparencyWarned) {
          transparencyWarned = true
          warn('no theme token resolved; interface opacity is inert')
          if (state.notice == null) {
            setState({ notice: { key: 'message.transparencyUnavailable', kind: 'warn' } })
          }
        }
      }

      /**
       * Coalesce every change inside one animation frame into a single render.
       * Dragging the preview and sweeping a slider both land here.
       */
      function scheduleRender() {
        if (disposed || renderPending) return
        renderPending = true
        const run = () => {
          renderPending = false
          rafId = null
          render()
        }
        if (typeof requestAnimationFrame === 'function') rafId = requestAnimationFrame(run)
        else rafId = setTimeout(run, 16)
      }

      /** Layout-only change (window resize): keep the palette cache. */
      function scheduleReassert() {
        scheduleRender()
      }

      /**
       * A one-glance report of why the wallpaper may not be visible. The packaged
       * desktop app ships without DevTools, so the plugin has to testify itself.
       * Never throws: a broken diagnostic is worse than no diagnostic.
       */
      function diagnose() {
        const lines = []
        const readColor = (getter) => {
          try {
            const value = getter()
            return value == null || value === '' ? '(空)' : String(value)
          } catch (error) {
            return '(读不到)'
          }
        }
        const ownStyle = readColor(() => styleEl != null && styleEl.isConnected ? styleEl.textContent : '')
        const hasSheet = ownStyle !== '(空)' && ownStyle !== '(读不到)'
        const surfaceBlock = hasSheet && ownStyle.indexOf('body[data-ds-dark-theme] {') !== -1
        lines.push('样式表: ' + (hasSheet ? '已注入' : '缺失！') + '，表面覆盖块: ' + (surfaceBlock ? '有' : '没有'))
        lines.push('解析到的底色变量: ' + SURFACE_TOKENS.length + ' 个（表里）')

        const layer = domReady() ? document.getElementById(LAYER_ID) : null
        if (layer == null) {
          lines.push('壁纸层: 不存在 —— 图层根本没画上去')
        } else {
          const computed = readColor(() => globalThis.getComputedStyle(layer).backgroundImage)
          const opacity = readColor(() => globalThis.getComputedStyle(layer).opacity)
          const size = readColor(() => {
            const rect = layer.getBoundingClientRect()
            return Math.round(rect.width) + '×' + Math.round(rect.height)
          })
          lines.push('壁纸层: 存在 ' + size + '，opacity=' + opacity)
          lines.push('  background-image: ' + computed.slice(0, 90))
        }

        const bodyVar = (name) => readColor(() => globalThis.getComputedStyle(document.body).getPropertyValue(name).trim())
        lines.push('body 的 --dsw-alias-bg-base = ' + bodyVar('--dsw-alias-bg-base'))
        lines.push('body 的 --dsw-specific-sidebar-fill = ' + bodyVar('--dsw-specific-sidebar-fill'))
        const describe = (el) => {
          const className = typeof el.className === 'string' ? el.className.split(/\s+/)[0] : ''
          let size = ''
          try {
            const rect = el.getBoundingClientRect()
            size = ' ' + Math.round(rect.width) + '×' + Math.round(rect.height)
          } catch (error) { size = '' }
          return String(el.tagName || '?') + (className === '' ? '' : '.' + className) + size
        }
        lines.push('窗口外壳标记: ' + (markedFrames.length > 0
          ? '已标记 ' + markedFrames.length + ' 个'
          : '未标记') + '（扫描 ' + lastFrameScan.visited + ' 个元素）')
        markedFrames.slice(0, 3).forEach((el) => lines.push('  已标记: ' + describe(el)))
        // If marking missed, name the window-sized elements so the cause is obvious.
        const suspects = []
        try {
          const scanRoot = document.getElementById('root')
          const viewportW = (typeof window !== 'undefined' ? window.innerWidth : 0) || 0
          const viewportH = (typeof window !== 'undefined' ? window.innerHeight : 0) || 0
          if (scanRoot != null && typeof scanRoot.querySelectorAll === 'function' && viewportW > 0 && viewportH > 0) {
            const all = scanRoot.querySelectorAll('*')
            for (let index = 0; index < all.length && suspects.length < 5; index += 1) {
              const el = all[index]
              let covers = false
              try {
                const rect = el.getBoundingClientRect()
                covers = rect.width >= viewportW * 0.9 && rect.height >= viewportH * 0.9
              } catch (error) { covers = false }
              if (!covers) continue
              suspects.push(describe(el) + ' → ' + readColor(() => globalThis.getComputedStyle(el).backgroundColor))
            }
          }
        } catch (error) { /* the report must survive a hostile DOM */ }
        lines.push('窗口级元素(前 5 个):')
        if (suspects.length === 0) lines.push('  （没找到覆盖 ≥90% 窗口的元素）')
        else suspects.forEach((line) => lines.push('  ' + line))

        const bgOf = (el) => (el == null ? '(无此元素)' : readColor(() => globalThis.getComputedStyle(el).backgroundColor))
        lines.push('html 底色 = ' + bgOf(domReady() ? document.documentElement : null))
        lines.push('body 底色 = ' + bgOf(domReady() ? document.body : null))
        const root = domReady() ? document.getElementById('root') : null
        lines.push('#root 底色 = ' + bgOf(root))

        // Who inside the app paints an opaque background on top of the wallpaper?
        const culprits = []
        try {
          if (root != null && typeof root.querySelectorAll === 'function') {
            const all = root.querySelectorAll('*')
            for (let index = 0; index < all.length && culprits.length < 4; index += 1) {
              const el = all[index]
              const bg = readColor(() => globalThis.getComputedStyle(el).backgroundColor)
              if (bg === '(空)' || bg === '(读不到)' || bg === 'transparent' || bg.indexOf('rgba(0, 0, 0, 0)') === 0) continue
              const cls = typeof el.className === 'string' ? el.className.split(/\s+/)[0] : ''
              culprits.push((el.tagName || '?') + (cls === '' ? '' : '.' + cls) + ' → ' + bg)
            }
          }
        } catch (error) { /* the report must survive a hostile DOM */ }
        lines.push('不透明底色来源(前 4 个):')
        if (culprits.length === 0) lines.push('  （没找到——说明主界面本身已经透了）')
        else culprits.forEach((line) => lines.push('  ' + line))
        return lines
      }

      /** Theme change: re-probe the palette, then repaint. */
      function refreshTheme() {
        invalidatePalette()
        scheduleRender()
      }

      /* ---------------- public face ---------------- */

      const controller = {
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        getSnapshot() { return state },
        scheduleReassert,
        refreshTheme,
        ensureStyle,
        setExpanded(expanded) { setState({ expanded: !!expanded }) },
        /** Show one user-facing message in the row. */
        setNotice(notice) { setState({ notice }) },
        /** Print the live "why is it not visible" report into the row. */
        runDiagnostic() { setState({ diagnostic: diagnose() }) },
        update(patch) {
          const next = configPatch(patch)
          setState({ config: next })
          scheduleRender()
          persistConfig()
        },
        resetLayout() {
          controller.update({ fit: 'cover', scale: 100, offsetX: 0, offsetY: 0 })
        },
        chooseFile(file, slot) {
          const which = slot === SLOT_DARK ? SLOT_DARK : SLOT_LIGHT
          if (disposed || file == null) return Promise.resolve()
          // One upload at a time: another drop while decoding is ignored.
          if (state.busy) return Promise.resolve()
          const type = String(file.type || '')
          if (type !== '' && type.indexOf('image/') !== 0) {
            setState({ notice: { key: 'message.notImage', kind: 'error' } })
            return Promise.resolve()
          }
          // The user acted, so an in-flight restore must not overrule them.
          loadGeneration += 1
          const generation = loadGeneration
          setState({ busy: true, notice: null })
          return prepareAsset(file)
            .then((prepared) => storeAsset(prepared.record, which).then((where) => ({ prepared, where })))
            .then(({ prepared, where }) => {
              if (disposed || generation !== loadGeneration) return
              liveBlobs[which] = prepared.record.blob
              const url = adoptImageUrl(URL.createObjectURL(prepared.record.blob), which)
              let notice = prepared.note == null ? null : { key: prepared.note, kind: 'warn' }
              if (where === 'memory') notice = { key: 'message.sessionOnly', kind: 'warn' }
              else if (where === 'dataurl') notice = notice || { key: 'message.storageFallback', kind: 'info' }
              const patch = slotPatch(which, metaOf(prepared.record), url)
              patch.busy = false
              patch.notice = notice
              patch.config = configPatch({ enabled: true })
              setState(patch)
              scheduleRender()
              persistConfig()
            })
            .catch((error) => {
              if (disposed) return
              const key = error != null && error.noticeKey != null ? error.noticeKey : 'message.decodeFailed'
              if (error == null || error.noticeKey == null) warn('image upload failed', error)
              setState({ busy: false, notice: { key, kind: 'error' } })
            })
        },
        removeImage(slot) {
          const which = slot === SLOT_DARK ? SLOT_DARK : SLOT_LIGHT
          if (disposed) return Promise.resolve()
          cancelSaveTimer()
          setState({ busy: true })
          const keys = slotKeys(which)
          return Promise.resolve()
            .then(() => idbDelete(keys.idb))
            .catch((error) => { warn('could not delete the stored ' + which + ' image', error) })
            .then(() => {
              if (disposed) return
              lsRemove(keys.ls)
              liveBlobs[which] = null
              adoptImageUrl(null, which)
              const patch = slotPatch(which, null, null)
              patch.notice = null
              patch.busy = false
              const remaining = which === SLOT_DARK ? state.asset : state.assetDark
              if (remaining == null) patch.config = configPatch({ enabled: false })
              setState(patch)
              scheduleRender()
              persistConfig()
            })
        },
        clearAll() {
          if (disposed) return Promise.resolve()
          cancelSaveTimer()
          setState({ busy: true })
          const wipe = [SLOT_LIGHT, SLOT_DARK].map((slot) => {
            const keys = slotKeys(slot)
            return Promise.resolve()
              .then(() => idbDelete(keys.idb))
              .catch((error) => { warn('could not clear the stored ' + slot + ' image', error) })
              .then(() => { lsRemove(keys.ls) })
          })
          return Promise.all(wipe).then(() => {
            if (disposed) return
            lsRemove(LS_CONFIG)
            liveBlobs[SLOT_LIGHT] = null
            liveBlobs[SLOT_DARK] = null
            revokeAllObjectUrls()
            setState({
              config: Object.assign({}, DEFAULTS),
              asset: null,
              imageUrl: null,
              assetDark: null,
              imageUrlDark: null,
              notice: null,
              busy: false,
            })
            scheduleRender()
          })
        },
        init() {
          const saved = readConfig()
          const config = configPatch(saved == null ? {} : saved)
          const merged = Object.assign({}, DEFAULTS, config)
          setState({ config: merged })
          const generation = loadGeneration
          const restore = (slot) => loadAsset(slot)
            .then((found) => {
              if (found == null) return
              if (disposed || generation !== loadGeneration) return
              // The user already picked something while this was loading.
              const current = slot === SLOT_DARK ? state.assetDark : state.asset
              if (current != null) return
              const url = found.blob != null
                ? adoptImageUrl(URL.createObjectURL(found.blob), slot)
                : adoptImageUrl(found.dataUrl, slot)
              if (url == null) {
                warn('ignored an unusable stored ' + slot + ' wallpaper reference')
                return
              }
              if (found.blob != null) liveBlobs[slot] = found.blob
              setState(slotPatch(slot, found.meta, url))
            })
            .catch((error) => { warn('could not restore the stored ' + slot + ' wallpaper', error) })
          return Promise.all([SLOT_LIGHT, SLOT_DARK].map(restore)).then(() => {
            if (disposed || generation !== loadGeneration) return
            scheduleRender()
          })
        },
        /** Serialize parameters plus both images into one portable JSON string. */
        exportBackup() {
          return Promise.all([SLOT_LIGHT, SLOT_DARK].map(slot => readStoredImage(slot).then((found) => {
            if (found == null) return null
            return blobToDataUrl(found.blob).then(dataUrl => ({
              slot,
              entry: {
                name: found.meta.name || 'image',
                type: found.blob.type || found.meta.type || '',
                width: found.meta.width || 0,
                height: found.meta.height || 0,
                dataUrl,
              },
            }))
          }))).then((found) => {
            const images = {}
            found.forEach((item) => { if (item != null) images[item.slot] = item.entry })
            return JSON.stringify(buildBackup(state.config, images))
          })
        },
        /** Apply a backup produced by `exportBackup` (foreign JSON is refused). */
        importBackup(text) {
          if (disposed) return Promise.resolve()
          let parsed
          try {
            parsed = parseBackup(text)
          } catch (error) {
            const key = error != null && error.noticeKey != null ? error.noticeKey : 'message.importFailed'
            setState({ notice: { key, kind: 'error' } })
            return Promise.resolve()
          }
          loadGeneration += 1
          const generation = loadGeneration
          setState({ busy: true, notice: null })
          const jobs = [SLOT_LIGHT, SLOT_DARK].map((slot) => {
            const entry = parsed.images[slot]
            if (entry == null) return Promise.resolve()
            const blob = dataUrlToBlob(entry.dataUrl)
            if (blob == null) return Promise.resolve()
            const record = {
              blob,
              name: entry.name || 'image',
              type: entry.type || blob.type,
              size: blob.size,
              width: entry.width,
              height: entry.height,
              savedAt: Date.now(),
            }
            return storeAsset(record, slot).then(() => {
              if (disposed || generation !== loadGeneration) return
              liveBlobs[slot] = blob
              const url = adoptImageUrl(URL.createObjectURL(blob), slot)
              setState(slotPatch(slot, metaOf(record), url))
            })
          })
          const carriedImages = Object.keys(parsed.images).length > 0
          return Promise.all(jobs).then(() => {
            if (disposed || generation !== loadGeneration) return
            setState({
              busy: false,
              notice: { key: carriedImages ? 'message.imported' : 'message.importedNoImage', kind: 'info' },
              config: configPatch(parsed.config),
            })
            persistConfig()
            scheduleRender()
          })
        },
        dispose() {
          if (disposed) return
          disposed = true
          if (renderPending && rafId !== null) {
            if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId)
            else clearTimeout(rafId)
          }
          renderPending = false
          rafId = null
          cancelSaveTimer()
          listeners.clear()
          clearDom()
          removeStyle()
          revokeAllObjectUrls()
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

    /** Stable subscription handles: their identity must not change per render. */
    const EMPTY_STATE = {
      config: Object.assign({}, DEFAULTS),
      asset: null,
      imageUrl: null,
      assetDark: null,
      imageUrlDark: null,
      notice: null,
      expanded: false,
      busy: false,
      diagnostic: null,
    }

    function subscribeController(listener) {
      if (controller == null) return () => {}
      return controller.subscribe(listener)
    }

    function getControllerSnapshot() {
      return controller == null ? EMPTY_STATE : controller.getSnapshot()
    }

    function BackgroundRow(props) {
      const t = props != null && typeof props.t === 'function' ? props.t : key => key
      const state = React.useSyncExternalStore(subscribeController, getControllerSnapshot)
      const config = state.config
      const [dragOver, setDragOver] = React.useState(null)
      const [viewport, setViewport] = React.useState(readViewport)
      const [previewSize, setPreviewSize] = React.useState(null)
      const [pasteOpen, setPasteOpen] = React.useState(false)
      const [pasteText, setPasteText] = React.useState('')
      const previewRef = React.useRef(null)
      const fileRefLight = React.useRef(null)
      const fileRefDark = React.useRef(null)
      const backupInputRef = React.useRef(null)
      const dragRef = React.useRef(null)

      React.useEffect(() => {
        const onResize = () => { setViewport(readViewport()) }
        window.addEventListener('resize', onResize)
        return () => { window.removeEventListener('resize', onResize) }
      }, [])

      // One observer per mounted preview. It reports the BOX SIZE only, so
      // geometry is derived during render: a slider move repaints once instead
      // of tearing the observer down and re-rendering a second time.
      React.useEffect(() => {
        const box = previewRef.current
        if (box == null) {
          setPreviewSize(null)
          return undefined
        }
        const measure = () => {
          const el = previewRef.current
          if (el == null) return
          const w = el.clientWidth || 1
          const h = el.clientHeight || 1
          setPreviewSize(prev => (prev != null && prev.w === w && prev.h === h ? prev : { w, h }))
        }
        measure()
        if (typeof ResizeObserver === 'function') {
          const observer = new ResizeObserver(measure)
          observer.observe(box)
          return () => { observer.disconnect() }
        }
        window.addEventListener('resize', measure)
        return () => { window.removeEventListener('resize', measure) }
      }, [state.expanded, state.asset, state.imageUrl, state.assetDark, state.imageUrlDark])

      React.useEffect(() => {
        const box = previewRef.current
        if (box == null) return undefined
        const onWheel = (event) => {
          event.preventDefault()
          if (controller == null) return
          const current = controller.getSnapshot().config
          const step = event.deltaY > 0 ? -5 : 5
          controller.update({ scale: clamp(current.scale + step, RANGES.scale[0], RANGES.scale[1]) })
        }
        box.addEventListener('wheel', onWheel, { passive: false })
        return () => { box.removeEventListener('wheel', onWheel) }
      }, [state.expanded, state.imageUrl, state.imageUrlDark])

      const asset = state.asset
      const hasAnyImage = asset != null || state.assetDark != null
      // Which image the active theme paints (mirrors the controller's rule).
      const darkReady = state.assetDark != null && state.imageUrlDark != null
      const lightReady = asset != null && state.imageUrl != null
      const activeSlot = darkReady && (themeIsDark() || !lightReady) ? SLOT_DARK : SLOT_LIGHT
      const activeAsset = activeSlot === SLOT_DARK ? state.assetDark : asset
      const activeUrl = activeSlot === SLOT_DARK ? state.imageUrlDark : state.imageUrl
      const previewGeometry = previewSize == null || activeAsset == null
        ? null
        : computeGeometry({
          fit: config.fit,
          scale: config.scale,
          offsetX: config.offsetX,
          offsetY: config.offsetY,
          viewW: previewSize.w,
          viewH: previewSize.h,
          imgW: activeAsset.width || 16,
          imgH: activeAsset.height || 9,
        })

      /** Stop an active drag and drop its window-level listeners. */
      const endDrag = () => {
        const drag = dragRef.current
        if (drag == null) return
        dragRef.current = null
        if (typeof drag.cleanup === 'function') drag.cleanup()
      }

      const onPointerDown = (event) => {
        if (event.button != null && event.button !== 0) return
        endDrag()
        const cleanup = () => {
          window.removeEventListener('pointerup', endDrag)
          window.removeEventListener('pointercancel', endDrag)
        }
        dragRef.current = {
          x: event.clientX,
          y: event.clientY,
          geometry: previewGeometry,
          offsetX: config.offsetX,
          offsetY: config.offsetY,
          cleanup,
        }
        // Belt and braces beside pointer capture: a release outside the preview
        // (or a lost capture) still ends the drag.
        window.addEventListener('pointerup', endDrag)
        window.addEventListener('pointercancel', endDrag)
        if (typeof event.currentTarget.setPointerCapture === 'function') {
          try { event.currentTarget.setPointerCapture(event.pointerId) } catch (error) { /* best effort */ }
        }
      }
      const onPointerMove = (event) => {
        const drag = dragRef.current
        if (drag == null || drag.geometry == null) return
        if (event.buttons === 0) { endDrag(); return }
        if (controller == null) return
        const patch = {}
        if (drag.geometry.overflowX > 0) {
          patch.offsetX = clamp(drag.offsetX + ((event.clientX - drag.x) / (drag.geometry.overflowX / 2)) * 100, -100, 100)
        }
        if (drag.geometry.overflowY > 0) {
          patch.offsetY = clamp(drag.offsetY + ((event.clientY - drag.y) / (drag.geometry.overflowY / 2)) * 100, -100, 100)
        }
        if (Object.keys(patch).length > 0) controller.update(patch)
      }
      const onPointerUp = () => { endDrag() }

      /** One upload input handler per slot. */
      const onFileChange = (slot) => (event) => {
        const input = event.target
        const file = input.files != null ? input.files[0] : null
        input.value = ''
        if (file == null || controller == null) return
        void controller.chooseFile(file, slot)
      }
      const onDrop = (slot) => (event) => {
        event.preventDefault()
        setDragOver(null)
        const files = event.dataTransfer != null ? event.dataTransfer.files : null
        if (files == null || files[0] == null || controller == null) return
        if (state.busy) return
        void controller.chooseFile(files[0], slot)
      }
      const onBackupFile = (event) => {
        const input = event.target
        const file = input.files != null ? input.files[0] : null
        input.value = ''
        if (file == null || controller == null) return
        if (Number(file.size) > MAX_BACKUP_BYTES) {
          controller.setNotice({ key: 'message.importTooLarge', kind: 'error' })
          return
        }
        const reader = new FileReader()
        reader.onload = () => { if (controller != null) void controller.importBackup(String(reader.result)) }
        reader.onerror = () => { if (controller != null) controller.setNotice({ key: 'message.importFailed', kind: 'error' }) }
        reader.readAsText(file)
      }
      const startExport = (mode) => {
        if (controller == null) return
        controller.exportBackup().then((text) => {
          if (controller == null) return
          if (mode === 'copy') {
            return copyText(text).then((copied) => {
              if (controller != null) {
                controller.setNotice(copied
                  ? { key: 'message.copied', kind: 'info' }
                  : { key: 'message.copyFailed', kind: 'error' })
              }
            })
          }
          const ok = downloadText(text, 'dsh-bg-changer-backup.json')
          if (controller != null) {
            controller.setNotice(ok
              ? { key: 'message.exported', kind: 'info' }
              : { key: 'message.exportFailed', kind: 'error' })
          }
          return undefined
        }).catch((error) => {
          warn('backup export failed', error)
          if (controller != null) controller.setNotice({ key: 'message.exportFailed', kind: 'error' })
        })
      }
      const confirmPasteImport = () => {
        if (controller == null || pasteText.trim() === '') return
        void controller.importBackup(pasteText)
        setPasteText('')
        setPasteOpen(false)
      }

      if (controller == null) return null

      const statusText = state.busy
        ? t('status.busy')
        : activeAsset == null
          ? t('status.none')
          : (config.enabled ? t('status.applied') : t('status.disabled'))
            + ' · ' + activeAsset.name
            + (activeSlot === SLOT_DARK ? ' · ' + t('status.dark') : '')
            // The single most common "why can't I see it?" cause, said out loud.
            + (config.surfaceOpacity >= 95 ? ' · ' + t('status.opaque') : '')

      const children = [
        h('button', {
          key: 'head',
          type: 'button',
          className: 'dshbg-head',
          'aria-expanded': state.expanded ? 'true' : 'false',
          onClick: () => { controller.setExpanded(!state.expanded) },
        },
          h('span', { className: 'dshbg-head-icon', 'aria-hidden': 'true' },
            h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none' },
              h('rect', {
                x: 1.5, y: 2.5, width: 13, height: 11, rx: 2.5,
                stroke: 'currentColor', strokeWidth: 1.2,
              }),
              h('path', {
                d: 'M3.2 11.4l3.1-3.1 2.2 2.2 2.7-2.7 1.8 1.8',
                stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round',
              }),
              h('circle', { cx: 10.8, cy: 5.6, r: 1.05, fill: 'currentColor' }))),
          h('span', { className: 'dshbg-head-text' },
            h('span', { className: 'dshbg-head-title' }, t('title')),
            h('span', { className: 'dshbg-head-status' }, statusText)),
          h('span', {
            className: 'dshbg-chevron' + (state.expanded ? ' is-open' : ''),
            'aria-hidden': 'true',
          },
            h('svg', { width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none' },
              h('path', {
                d: 'M3 4.5L6 7.5L9 4.5',
                stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
              })))),
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

      /** One image slot: the light/default one and the optional dark-theme one. */
      const renderImageSlot = (slot) => {
        const slotAsset = slot === SLOT_DARK ? state.assetDark : state.asset
        const slotUrl = slot === SLOT_DARK ? state.imageUrlDark : state.imageUrl
        const slotRef = slot === SLOT_DARK ? fileRefDark : fileRefLight
        const label = t(slot === SLOT_DARK ? 'image.dark' : 'image.light')
        return h('div', {
          key: 'slot-' + slot,
          className: 'dshbg-slot' + (activeSlot === slot ? ' is-active' : ''),
        },
          h('div', { className: 'dshbg-slot-head' },
            h('div', { className: 'dshbg-slot-title' },
              h('span', { className: 'dshbg-slot-label' }, label),
              activeSlot === slot && slotAsset != null
                ? h('span', { className: 'dshbg-slot-badge' }, t('image.inUse'))
                : null),
            h('span', { className: 'dshbg-slot-hint' }, t(slot === SLOT_DARK ? 'image.darkHint' : 'image.lightHint'))),
          h('div', {
            className: 'dshbg-drop' + (dragOver === slot ? ' is-over' : '') + (slotAsset == null ? '' : ' has-image'),
            role: 'button',
            tabIndex: 0,
            'aria-label': label,
            'aria-disabled': state.busy ? 'true' : 'false',
            onClick: () => { if (state.busy) return; if (slotRef.current != null) slotRef.current.click() },
            onKeyDown: (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              if (state.busy) return
              if (slotRef.current != null) slotRef.current.click()
            },
            onDragOver: (event) => { event.preventDefault(); if (!state.busy) setDragOver(slot) },
            onDragLeave: () => { setDragOver(null) },
            onDrop: onDrop(slot),
          },
            slotAsset == null
              ? h('div', null,
                h('div', { className: 'dshbg-file-name' }, t('upload.cta')),
                h('div', { className: 'dshbg-file-meta' }, t('upload.types')))
              : h(React.Fragment, null,
                h('img', { className: 'dshbg-thumb', src: slotUrl, alt: '' }),
                h('div', { className: 'dshbg-file' },
                  h('div', { className: 'dshbg-file-name' }, slotAsset.name || 'image'),
                  h('div', { className: 'dshbg-file-meta' },
                    formatBytes(slotAsset.size) + ' · '
                    + ((slotAsset.type || '').replace('image/', '') || t('file.unknown')).toUpperCase()
                    + (slotAsset.width > 0 && slotAsset.height > 0 ? ' · ' + slotAsset.width + '×' + slotAsset.height : ''))),
                h('span', { className: 'dshbg-hint' }, t('upload.change')))),
          h('input', {
            ref: slotRef,
            type: 'file',
            accept: 'image/*',
            disabled: state.busy,
            style: { display: 'none' },
            onChange: onFileChange(slot),
          }))
      }

      body.push(h('div', { key: 'image', className: 'dshbg-group' },
        h('div', { className: 'dshbg-group-label' }, t('group.image')),
        renderImageSlot(SLOT_LIGHT),
        renderImageSlot(SLOT_DARK)))

      if (hasAnyImage) {
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
              backgroundImage: 'url("' + activeUrl + '")',
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
          h('div', { className: 'dshbg-field' },
            h('div', { className: 'dshbg-slider-label' }, t('scope.label')),
            h('div', { className: 'dshbg-chips' },
              h('button', {
                type: 'button',
                className: 'dshbg-chip' + (config.sidebarOpaque !== false ? ' is-active' : ''),
                'aria-pressed': config.sidebarOpaque !== false ? 'true' : 'false',
                onClick: () => { controller.update({ sidebarOpaque: true }) },
              }, t('scope.main')),
              h('button', {
                type: 'button',
                className: 'dshbg-chip' + (config.sidebarOpaque === false ? ' is-active' : ''),
                'aria-pressed': config.sidebarOpaque === false ? 'true' : 'false',
                onClick: () => { controller.update({ sidebarOpaque: false }) },
              }, t('scope.all')))),
          h(Slider, {
            name: 'surface-opacity', label: t('interface.opacity'), min: RANGES.surfaceOpacity[0], max: RANGES.surfaceOpacity[1], step: 1,
            value: config.surfaceOpacity, display: config.surfaceOpacity + '%',
            onChange: value => { controller.update({ surfaceOpacity: value }) },
          }),
          h('div', { className: 'dshbg-hint' }, t('interface.hint')),
          h('button', {
            type: 'button',
            className: 'dshbg-link',
            onClick: () => { controller.runDiagnostic() },
          }, t('diagnose.run')),
          state.diagnostic != null
            ? h('pre', { className: 'dshbg-diag' }, state.diagnostic.join('\n'))
            : null))
      }

      body.push(h('div', { key: 'backup', className: 'dshbg-group' },
        h('div', { className: 'dshbg-group-label' }, t('group.backup')),
        h('div', { className: 'dshbg-hint' }, t('backup.hint')),
        h('div', { className: 'dshbg-actions' },
          h('button', {
            type: 'button',
            className: 'dshbg-btn',
            disabled: state.busy,
            onClick: () => { startExport('download') },
          }, t('backup.export')),
          h('button', {
            type: 'button',
            className: 'dshbg-btn',
            disabled: state.busy,
            onClick: () => { startExport('copy') },
          }, t('backup.copy')),
          h('button', {
            type: 'button',
            className: 'dshbg-btn',
            disabled: state.busy,
            onClick: () => { if (backupInputRef.current != null) backupInputRef.current.click() },
          }, t('backup.import')),
          h('button', {
            type: 'button',
            className: 'dshbg-btn' + (pasteOpen ? ' is-primary' : ''),
            disabled: state.busy,
            onClick: () => { setPasteOpen(!pasteOpen) },
          }, t('backup.paste'))),
        pasteOpen
          ? h('div', { className: 'dshbg-paste' },
            h('textarea', {
              className: 'dshbg-paste-area',
              value: pasteText,
              placeholder: t('backup.pastePlaceholder'),
              spellCheck: false,
              'aria-label': t('backup.pasteTitle'),
              onChange: (event) => { setPasteText(event.target.value) },
            }),
            h('div', { className: 'dshbg-actions' },
              h('button', {
                type: 'button',
                className: 'dshbg-btn is-primary',
                disabled: state.busy || pasteText.trim() === '',
                onClick: confirmPasteImport,
              }, t('backup.confirm')),
              h('button', {
                type: 'button',
                className: 'dshbg-btn',
                onClick: () => { setPasteOpen(false); setPasteText('') },
              }, t('backup.cancel'))))
          : null,
        h('input', {
          ref: backupInputRef,
          type: 'file',
          accept: '.json,application/json,text/plain',
          style: { display: 'none' },
          onChange: onBackupFile,
        })))

      body.push(h('div', { key: 'actions', className: 'dshbg-actions' },
        hasAnyImage
          ? h('button', {
            type: 'button',
            className: 'dshbg-btn' + (config.enabled ? '' : ' is-primary'),
            disabled: state.busy,
            onClick: () => { controller.update({ enabled: !config.enabled }) },
          }, config.enabled ? t('action.disable') : t('action.enable'))
          : null,
        h('button', {
          type: 'button',
          className: 'dshbg-btn',
          disabled: state.busy || activeAsset == null,
          onClick: () => { void controller.removeImage(activeSlot) },
        }, t('upload.remove')),
        h('button', {
          type: 'button',
          className: 'dshbg-btn is-danger',
          disabled: state.busy,
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
      // Style the row immediately: `render()` would only reach this once the
      // (async) restore settles, and an unstyled frame is exactly the bug we
      // are fixing.
      controller.ensureStyle()

      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'bg-changer',
        // After every shipped row (permission -20 … current-version 100).
        order: ROW_ORDER,
        locale: NS,
      }, BackgroundRow))

      let observer = null
      let resizeHandler = null

      // A theme pass rewrote the palette: re-probe before repainting.
      const onThemeChange = () => { if (controller != null) controller.refreshTheme() }
      // A resize only changes the geometry.
      const onResize = () => { if (controller != null) controller.scheduleReassert() }

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
        resizeHandler = onResize
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
      formatBytes,
      svgHasExternalReferences,
      dataUrlToBlob,
      buildBackup,
      parseBackup,
      safeImageUrl,
      downloadText,
      ALPHA_FLOOR,
      OPAQUE_SCOPE,
      DEFAULTS,
      RANGES,
      SURFACE_TOKENS,
      BASE_CSS,
      TEXTS,
      ROW_ORDER,
      MAX_UPLOAD_BYTES,
      MAX_PIXELS,
      MAX_EDGE,
      MAX_KEEP_BYTES,
      MAX_BACKUP_BYTES,
      BACKUP_FORMAT,
      BACKUP_VERSION,
      SLOT_LIGHT,
      SLOT_DARK,
      IDB_KEY,
      IDB_KEY_DARK,
      LS_IMAGE,
      LS_IMAGE_DARK,
    }

    return module.exports
  },
})
