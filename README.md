# dsh-bg-changer

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）背景图插件：在**设置 → 通用**最下方加一行「背景图」，
上传一张图片后即可调节显示方式、缩放、水平/垂直位置（即裁剪显示部位）、图片不透明度、模糊度、暗化，
以及让壁纸能透出来的**界面不透明度**。

- **零依赖、零构建**：浏览器半侧是手写的 lazy-CJS bundle，只 `require('react')`（宿主共享模块基线），不需要 tsdown、不需要 `pnpm install`。
- **不改宿主源码**：不碰 DSH 的 `src/`，一切通过 profile 插件机制注册。
- **MIT**，无任何凭据、账号或本机路径硬编码。

> 已验证环境：DSH **v0.1.6-alpha.1**（Windows 源码构建）+ Chrome `--app`。其他版本/内核未验证（见文末「改造与兼容」）。

---

## 功能

| 分组 | 内容 |
|---|---|
| 图片 | 点击 / 拖拽上传；支持 PNG、JPEG、WebP、GIF（动图保留动画）、BMP、AVIF、SVG；显示文件名、体积、格式、像素；更换 / 移除 |
| 布局与裁剪 | **填充 / 适应 / 拉伸 / 平铺**；缩放 50–300%；水平、垂直偏移 −100…100；预览框内**拖拽平移 + 滚轮缩放**（与窗口同宽高比，所见即所得）；重置构图 |
| 效果 | 图片不透明度 0–100%、模糊度 0–40px、暗化 0–60% |
| 界面 | 界面不透明度 0–100%（默认 **65%**）。调低后各面板/侧边栏/卡片变半透明，壁纸才看得见；100% 完全恢复默认不透明外观 |
| 动作 | 启用 / 停用背景、移除图片、清除并重置 |

所有改动**即时生效、即时保存**（参数写 localStorage，图片 Blob 写 IndexedDB）。

### 「裁剪显示部位」怎么理解

- `填充（cover）` + `缩放 > 100%` 让图片大于视口，产生可平移的余量；
- `水平/垂直偏移` 在这段余量内移动图片（偏移 100% = 移到余量边界，因此**永远不会露出底色**）；
- 预览框与真实窗口同宽高比，框内拖拽/滚轮与真实效果一一对应。

`适应` / `拉伸` / `平铺` 下若图片小于视口则没有可平移余量，偏移自动保持 0（避免露底）。

---

## 安装

### 方式一：从 GitHub 装（推荐）

```powershell
# 让 DSH 自己把插件装进 web profile（走 pnpm，需要网络）
dsh plugin --profile web add github:GIN0076/dsh-bg-changer

# 或指定 CLI 路径（DSH 的 shim）
E:\DSH-OneClick\dsh.cmd plugin --profile web add github:GIN0076/dsh-bg-changer
```

然后**重启 DSH 服务**（新增 bundle 层只在启动时读取），刷新页面 → 设置 → 通用 → 最下方「背景图」。

### 方式二：克隆后本地 link 安装（开发用，改完刷新即生效）

```powershell
git clone https://github.com/GIN0076/dsh-bg-changer.git
cd dsh-bg-changer

node tools/install.cjs --dry-run     # 先看它要做什么，不写任何文件
node tools/install.cjs               # 建 link + 登记 profile 清单（幂等，自动备份清单）
```

Windows 也可以直接双击 `安装.cmd`。

安装器做的事：把本目录 link 进 `~/.dsh/profiles/<profile>/node_modules/dsh-bg-changer`，
在 profile 的 `package.json` 里补 `dependencies` 与 `dsh.profile.bundles` 各一条（写前自动备份 `package.json.bak-<时间戳>`），
写入后立即回读校验。**不会**修改 DSH 源码，也不需要管理员权限（Windows 用 junction）。

常用参数：

```powershell
node tools/install.cjs --profile tui          # 装到别的 profile
node tools/install.cjs --dsh-home D:\.dsh     # 指定 DSH 数据目录（默认 $DSH_HOME 或 ~/.dsh）
node tools/install.cjs --dry-run              # 只看计划
node tools/install.cjs --from-github          # 等价方式一，但用脚本调用 DSH CLI
```

### 卸载

```powershell
node tools/install.cjs --uninstall --dry-run   # 先看计划
node tools/install.cjs --uninstall             # 移除 link + 两条清单登记（先备份）
```

重启服务后插件行随之消失。插件自己的数据在浏览器里：DevTools 删除 localStorage 键
`dsh-bg-changer:config:v1` / `dsh-bg-changer:image:v1` 与 IndexedDB 库 `dsh-bg-changer`。

---

## 破坏性更新之后怎么装回来

DSH 破坏性更新 = 干净重装，`~/.dsh/profiles/web` 会被重建、`node_modules` 清空。三步恢复：

```powershell
# 1) 取回代码（就已是最新；改过代码时用它更新）
git clone https://github.com/GIN0076/dsh-bg-changer.git   # 已有目录则 git pull

# 2) 装回 profile（二选一）
dsh plugin --profile web add github:GIN0076/dsh-bg-changer        # 远程装
node tools/install.cjs                                            # 或本地 link 装

# 3) 重启服务 + 刷新页面（Ctrl+Shift+R）
powershell -File E:\DSH-OneClick\scripts\launch-dsh.ps1 -Stop     # 托盘图标右键「重新启动服务」亦可
```

装完先自检（不需要浏览器）：

```powershell
node tools/verify-bundle.cjs     # 84 项检查
```

**壁纸本身不在插件里**：图片与参数存在浏览器（localStorage + IndexedDB），所以只要浏览器数据没清，
重装插件后壁纸会自动恢复；清了浏览器数据就要重新上传。

### 升级 DSH 后如果插件不工作了

插件的全部依赖面就下面这几个，逐条对照即可：

| 依赖的机制 | 位置 | 失效时怎么改 |
|---|---|---|
| `settings.general.item` 槽位 | `packages/client/ui-settings/src/client/contract/slots.ts` | 槽位改名 → 改 `lib/client.js` 里 `ctx.slots.inject('settings.general.item', …)` |
| 客户端 bundle 工厂协议 `window.__ModuleLoader__.load({id, factory})` | `packages/client/tsdown.client.ts` 的 banner/footer | 协议变了 → 改 `lib/client.js` 顶部包装，重新 `node tools/verify-bundle.cjs` |
| 模块表基线（`react`） | `packages/client/web/src/platform.ts` 的 `PLATFORM_MODULES` | 基线收缩 → 把依赖写进 `package.json` 的 `dsh.client.external` |
| 表面 token `--dsw-alias-bg-*` / `--dsw-specific-*` | `packages/client/ui-theme/src/styles/design-platform.css` | token 改名 → 改 `lib/client.js` 的 `ALPHA_FLOOR` / `SURFACE_TOKENS`（取不到值的 token 会被自动跳过并 `console.warn`，只是透明度降级，壁纸仍显示） |

`tools/verify-bundle.cjs` 的 84 项检查覆盖了上面的大部分假设，升级后先跑它，红哪一项就改哪一项。

---

## 存储与作用范围

| 内容 | 位置 |
|---|---|
| 全部参数 | `localStorage['dsh-bg-changer:config:v1']` |
| 图片 | IndexedDB `dsh-bg-changer` → `assets['wallpaper']`（Blob） |
| 降级链 | IndexedDB 不可用/配额失败 → 图片 ≤2.5MB 时退化为 localStorage data URL → 再不行则仅当前会话生效（行内会提示） |

作用范围是**当前浏览器 + 当前站点源**（如 `http://127.0.0.1:3080`），不随会话/工作区变化，
不写入 DSH 的 settings，也不进入模型上下文。

---

## 已知限制

- **需要界面半透明**：宿主 `body` 与各面板用不透明 token 绘制，插件通过覆盖这些 token 让壁纸透出。
  把「界面不透明度」拉到 100% 时壁纸基本不可见（设计使然）。
- 模糊度 > 0 时壁纸层向外扩张 `3×模糊` 像素，避免模糊边缘出现硬框。
- 动图（GIF）超过 8MB 或最长边超过 4096px 时**不压缩**（压缩会丢动画），行内会有提示。
- 只支持单张壁纸；不含视频壁纸、多图轮播、按会话切换、配置导出/导入。
- 仅在 Chromium 内核验证；Firefox 未验证。

---

## 开发与验证

```powershell
node --check lib/client.js          # 语法
node tools/verify-bundle.cjs        # 84 项检查（无需浏览器）
```

`verify-bundle.cjs` 分四段：

1. **源码纯净度**：只 `require('react')`、无 `import`、按 `window.__ModuleLoader__.load` 注册、id 正确。
2. **插件接线**：`apply`/`inject`、唯一槽位 `settings.general.item`（`id=bg-changer`、`order=100`、
   `locale=settings.bgChanger`）、中英词典键一致、**apply 阶段零 DOM 写入**。
3. **纯函数**：`computeGeometry`（cover/contain/stretch/tile、缩放与偏移夹取、永不露底）、
   `alphaFor`（各面地板 alpha）、`parseRgb`、`clamp`。
4. **持久化全链路**（假 DOM + 假 IndexedDB/localStorage）：恢复已保存壁纸 → 生成 `/dsh-bg-layer`、
   暗化层与 `style[data-dsh-bg-plugin]`（断言样式表在 head 末尾、表面 token 覆盖生效、`--dsh-bg-*` 变量正确）
   → 渲染展开态 UI（7 个滑块、4 个布局 chip、预览框）→ 滑块写回根变量 →
   点「清除并重置」后图层/样式/变量/本地记录全部消失。

### 目录

```
dsh-bg-changer/
  package.json            dsh.bundle.patch + dsh.client 声明（无 dependencies）
  cordis.patch.yml        - insert: [{ id: bg-changer, name: dsh-bg-changer }]
  lib/index.js            宿主半侧：空 apply（插件行必须可导入）
  lib/client.js           全部功能（手写 lazy-CJS bundle，只 require('react')）
  tools/verify-bundle.cjs 自检（84 项）
  tools/install.cjs       安装/卸载（幂等、可干跑、自动备份）
  安装.cmd                 Windows 双击入口 → tools/install.cjs
  README.md / 使用说明.md / LICENSE
```

### 为什么手写 bundle

客户端的 `clientBundle` 预设（`packages/client/tsdown.client.ts`）不是已发布的 npm 包，仓库外的插件必须自行复刻其产物格式：

```js
window.__ModuleLoader__.load({
  id: '<包名>',
  factory: (require) => { var module = { exports: {} }; /* … */ return module.exports },
})
```

`require` 只能取模块表里的键：基线为 `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、
`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、
`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`（`packages/client/web/src/platform.ts`）。
本插件用纯 JS + `React.createElement`，因此不需要 tsdown、不需要 `pnpm install`。

> 历史：此仓库的前身是 2026-09-10 的一次尝试（面向 `cordis_define` 动态插件机制，被当时的 `oneOf` schema bug 挡住、从未运行）。
> 现版本改走持久化插件机制，并复用其 UI 分组思路，代码全部重写。
