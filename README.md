# dsh-bg-changer

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下称 DSH）背景图插件：在 **设置 → 通用** 最下方加一行「背景图」，上传一张图后即可调节显示方式、缩放、水平/垂直位置
（也就是「裁剪显示部位」）、图片不透明度、模糊度、暗化，以及让壁纸能透出来的**界面不透明度**。

- **零依赖、零构建**：浏览器半侧是手写的 lazy-CJS bundle，只 `require('react')`（与宿主共享模块基线）：
  不需要 tsdown、不需要 `pnpm install`。
- **不改宿主源码**：不碰 DSH 的源码树，一切通过 profile 插件机制注册。
- **MIT**；仓库内无账号、无凭据、无隐私的绝对路径（安装命令里的路径都需要你按自己的安装位置替换）。

---

## 本次版本与环境

| 项目 | 值 |
|---|---|
| 插件版本 | **0.3.0** |
| 面向的 DSH | **0.2.0-rc.2 桌面 Electron 版（Windows）**；DSH 的 **web profile 同样兼容**（同一套 client 协议） |
| 数据目录 | `%USERPROFILE%\.dsh`（可用 `DSH_HOME` 覆盖） |
| 本机 profile | `desktop`（当前活动）；`web` 两个 profile 目录都存在，**桌面版跑的是 `desktop`** |
| 桌面版窗口 origin | **`dsh-app://app`**（自定义协议，按 standard + secure 注册，所以 localStorage / IndexedDB / `blob:` 都可用；应用页面没有 CSP）。**不是** `http://127.0.0.1:19387`，详见「存储与作用范围」 |
| 本机 CLI 示例 | `<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd`（**不在 PATH 上**），路径随安装位置不同，请自行替换 |

> **核验状态（请不要误解）**：本文档针对 DSH 0.2.0-rc.2 桌面版做了**静态核对**——读了
> `lib/client.js` / `cordis.patch.yml` / `package.json`、读了本机 profile 清单，
> 也读了 `%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\runtime.json` 的 `desktopVersion`，
> 实跑 `node --check lib/client.js` 与 `node tools/verify-bundle.cjs`。
> **「插件在桌面应用里能正常加载、拖动手感如何」这类结论属于实机验证，由仓库维护者负责**；
> 本文档不替它下这个结论。凡属推测或不确定之处，文中都会写明。

---

## 功能一览

| 分组 | 内容 |
|---|---|
| 图片 | **两个槽位：浅色主题 / 深色主题**（各自点击 / 拖拽上传、更换、移除）；支持 PNG、JPEG、WebP、GIF（保留动画）、BMP、AVIF、SVG；显示文件名、体积、格式、像素 |
| 布局与裁剪 | **填充 / 适应 / 拉伸 / 平铺**；缩放 50–300%；水平、垂直偏移 −100…100；预览框内**拖拽平移 + 滚轮缩放**（与窗口同宽高比，所见即所得）；重置构图 |
| 效果 | 图片不透明度 0–100%、模糊度 0–40px、暗化 0–60% |
| 界面 | **壁纸范围**：`仅对话区（侧边栏不透明，默认）` / `全部界面`；**界面不透明度** 0–100%（默认 **65%**）。调低后生效范围内的界面变半透明，壁纸才看得见；**设置面板、对话框、菜单、提示气泡始终保持默认清晰外观，不受这个滑块影响** |
| 备份与迁移 | **导出文件 / 复制配置 / 导入文件 / 粘贴导入**：一份 JSON 里同时打包参数与两张图片，换机器、重装、清浏览器数据后一键恢复 |
| 动作 | 启用 / 停用背景、移除当前图、清除并重置 |

所有改动**即时生效、即时保存**：参数写 `localStorage`，图片 Blob 进 IndexedDB。

### 明暗两套图怎么工作

- 「浅色主题」是默认图；「深色主题」可选。
- 主题切到深色且深色图存在 → **自动换成深色图**；只设了深色图 → 两个主题都用它（不会出现"放了图却看不到"）。
- 两张图**共用**布局、效果、界面不透明度这些参数（换图不换构图）。
- 行内会标出当前正在用哪一张（`当前在用` 徽标 + 标题栏状态文字）。
- 切换是全自动的：插件盯着宿主的 `body[data-ds-dark-theme]`，主题一变立刻换图。

### 备份里有什么

一份 JSON（`format: "dsh-bg-changer/backup"`、`version: 1`）：

| 字段 | 内容 |
|---|---|
| `config` | 全部参数（布局 / 效果 / 界面不透明度 / 停用状态） |
| `images.light` / `images.dark` | 对应槽位的图片：文件名、类型、宽高、`data:image/...` |
| `exportedAt` | 导出时间（ISO） |

导入时只认这个格式：**异种 JSON、更高版本、超大文件一律拒收**并给出提示，不会写坏你现有的壁纸。
导入只覆盖备份里带的槽位（备份只有深色图时，你的浅色图不会被动）。

### 「裁剪显示部位」怎么理解

「裁剪」不是真的去裁一张新图，而是**在一张比窗口大的图里移动窗口**。

- `填充（cover）` + `缩放 > 100%` 让图片大于窗口，于是产生**可平移的余量**；
- `水平 / 垂直偏移` 在这段余量内移动图片（偏移到 100% 就是余量边界，因此**永远不会露出底色**）；
- 预览框与真实窗口同宽高比，框内拖拽 / 滚轮与真实效果一一对应。

`适应` / `拉伸` / `平铺` 下若图片小于视口，就没有可平移的余量，偏移自动保持 0（避免露底）。

---

## 安装

### 先确认 DSH 装在哪

本机示例（你的安装位置可能不同，**请自行替换**）：

```powershell
# DSH CLI（不在 PATH 上，必须写全路径）
<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd
# 桌面应用主程序（重启时用）
<DSH 安装目录>\DeepSeek Harness.exe
```

> `<DSH 安装目录>` 以本机为例是 `D:\SoftwareInstallation2\Deepseek`；`<本仓库目录>` 就是你把本仓库 clone 到的位置。

### 方式一（首选）：用 DSH 官方的插件命令

```powershell
& '<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add '<本仓库目录>'
```

- `dsh plugin` **必须带 `--profile`**：本机实测不带会直接报
  `error: required option '--profile <name>' not specified`。
- 这条命令把参数原样传给该 profile 目录下的 pnpm（本机实测 `plugin --profile desktop --help`
  打印的就是 pnpm 的帮助），官方支持**绝对路径**。
- 装完**一般要重启桌面应用**；2026-10-01 在 0.2.0-rc.2 实测本机登记后即热生效，先看 设置 → 通用，
  没出现再重启（见「重启与刷新规则」）。

> **排查提示**：官方 CLI 改过 profile 清单之后，pnpm 有时要求再同步一次。若下次升级 / 重装
> DSH 时报 lockfile 相关错误，在该 profile 目录跑一次 `pnpm install` 即可（pnpm 随 DSH 一起装，
> 不一定在 PATH 上，用全路径示例）：
>
> ```powershell
> cd "$env:USERPROFILE\.dsh\profiles\desktop"
> node '<DSH 安装目录>\resources\runtime\pnpm\bin\pnpm.cjs' install
> ```
>
> （Windows 上 pnpm 随 DSH 一起装，通常在 `<DSH 安装目录>\resources\runtime\pnpm\bin\pnpm.cjs`。）

### 方式二：用仓库脚本（不联网、确定性写清单）

```powershell
cd '<本仓库目录>'

node tools/install.cjs --dry-run --profile desktop   # 先看计划，不写任何文件
node tools/install.cjs --profile desktop             # 建 link + 登记 profile 清单
```

Windows 上也可以直接双击 `安装.cmd`（它把参数原样转给 `tools/install.cjs`）。

脚本做的事：

1. 把本仓库 link 到 `<DSH_HOME>\profiles\<profile>\node_modules\dsh-bg-changer`
   （Windows 用 **junction**，免管理员权限）；
2. 在该 profile 的 `package.json` 里补 `dependencies` 与 `dsh.profile.bundles` **各一条**；
3. 写之前自动备份 `package.json.bak-<时间戳>`（**只保留最近 5 份**）；
4. 采用「先写临时文件再改名」的**原子写法**，写完立刻**回读校验**；
5. 检测到链接断开（包括 target 指向的路径已经不存在）时**自动重建**，而不是不管、直接报「已就位」；
6. 结束时提示**重启桌面应用**，并给出重启方式（0.2.0 实测多数情况登记即热生效，脚本仍提示以防万一）。

### 干跑与参数

```powershell
node tools/install.cjs --dry-run --profile desktop
```

```
node tools/install.cjs [--dry-run] [--profile <name>] [--dsh-home <dir>] [--dsh-cli <path>]
                       [--from-github [spec]] [--uninstall|--remove] [--force] [--help]
```

| 参数 | 作用 |
|---|---|
| `--dry-run` | 只打印计划，绝不写盘 |
| `--profile <name>` | 指定 profile；**不传则自动识别当前活动 profile** |
| `--dsh-home <dir>` | DSH 数据目录（默认 `$DSH_HOME`，否则 `%USERPROFILE%\.dsh`） |
| `--dsh-cli <path>` | `--from-github` 时用的 `dsh.cmd`（默认自动探测） |
| `--from-github [spec]` | 交给 DSH CLI + pnpm 从 GitHub 安装（需要网络），spec 默认 `github:GIN0076/dsh-bg-changer` |
| `--uninstall` / `--remove` | 卸载 |
| `--force` | 覆盖已存在、但指向不对的 `node_modules` 条目 |
| `--help` | 打印用法 |

**不传 `--profile` 时怎么选 profile**（0.2.0 起，默认值不再是 `web`）：

1. 优先看环境变量 `DSH_PROFILE`；
2. 只有一个 profile，就用它；
3. 有多个 profile，就选 `dsh.profile.bundles` 条目**最多**的那个
   （本机实测：`desktop` 有 9 条，`web` 只有 2 条，选中 `desktop`）；
4. 脚本会在输出里**明确打印「选中了哪个 profile、为什么」**；如果判断不出来，就报错并列出候选项，
   要求你显式传 `--profile`。

> 下面的所有示例都用 `--profile desktop`，因为本机桌面版跑的是 `desktop` profile。
> 如果你哪天改用 web profile，把示例里的 `desktop` 换成 `web` 即可。

### 卸载

```powershell
node tools/install.cjs --uninstall --profile desktop --dry-run   # 先看计划
node tools/install.cjs --uninstall --profile desktop             # 移除 link + 两条清单登记（先备份）
```

之后重启桌面应用（或按「重启与刷新规则」先看是否已即时消失），插件行随之消失。
**插件自己存的数据在浏览器里**（见「存储与作用范围」），脚本和卸载都无法替你删除。

---

## 装上之后在哪看

**设置 → 通用**，拉到最下方 → **背景图**。

- 默认折叠，右侧显示「未设置」；点这一行展开全部控件。
- 排序值是 **`order 101`**：官方行「当前版本」那一行排在它前面。
  0.1.x 用的是 `order 100`，与官方行同序，位置会飘；0.2.0 已改成 101，稳定排在最后。

## 重启与刷新规则

插件的两个加载面，生效方式不同——**搞错了就会以为「装了没反应」**：

| 你改了什么 | 生效方式 |
|---|---|
| **已挂载插件的 `lib/client.js`**（client-only 改动，例如改样式、改文案） | **硬刷新即可**（`Ctrl+Shift+R`），不用重启 |
| **新增 / 移除 bundle**：首次安装插件、改 `cordis.patch.yml`、安装卸载任何插件 | 一般**需要重启桌面应用**；但 0.2.0 实测本机 desktop profile **登记后即热生效**（页面的插件图会走 SSE 更新），所以先直接看 设置 → 通用：出现了就不用重启 |

2026-10-01 在 DSH 0.2.0-rc.2 桌面版实测：`node tools/install.cjs` 写入 profile 清单后，
`Settings` 槽位里立刻出现了 `bg-changer`（`order 101`，排在官方 `current-version` 之后），
**没有重启应用**。若你的版本没有这个行为，按上表重启一次即可。

重启方式：托盘菜单里退出，然后重新打开
`<DSH 安装目录>\DeepSeek Harness.exe`（路径按你的实际安装位置替换）。

---

## 0.3.0 新版

| 类别 | 内容 |
|---|---|
| 明暗两套图 | 图片区分**浅色主题 / 深色主题**两个槽位；主题切换时**自动换图**；只设深色图时两个主题都用它；行内标出当前在用哪张 |
| 备份与迁移 | **导出文件 / 复制配置 / 导入文件 / 粘贴导入**四种方式，一份 JSON 同时带参数与图片；导入只认本插件格式，异种 JSON / 更高版本 / 超大文件一律拒绝 |
| 兼容 | 备份格式带 `format` + `version` 双标识，旧版本备份永远能导入（向后兼容） |
| 测试 | 从 117 到 **184 条**（**以脚本输出为准**）：新增备份往返、异种备份拒收、data URL 解码、明暗切换选图、只设深色图的兜底、经真实 UI 的粘贴导入与导出内容校验、样式表完整性、诊断不崩、壁纸范围开关的两向断言、外壳标记只命中铺满窗口的元素 |
| 修复 | **「未设置壁纸」时整行丢失样式**（0.1.x 起的老问题，用户实测发现）：样式表原本与壁纸图层绑在一起，没有壁纸就不创建。现在样式表随插件挂载就一直存在，只有卸载才移除 |
| 修复 | **侧边栏/气泡/输入框不跟随界面透明度**：0.2.0-rc.2 把侧边栏底色换成了新变量 `--dsw-specific-sidebar-fill`（0.1.x 时代没有这个名字），旧清单漏了它 → 侧边栏永远不透明。现在补齐了侧边栏、聊天气泡、输入框、浮层四个变量，并给承载文字的三个面留了可读性下限 |
| 排版 | **「壁纸范围」二选一**，默认 `仅对话区`：Windows 上宿主用**同一个变量**给"整窗口外壳"和"左侧栏"上色（`[data-windows-titlebar] .BynINW_frame` 与 `.BynINW_sidebarCol` 都取 `--dsw-specific-sidebar-fill`），所以"不覆盖变量"等于整窗口不透明。做法是保留侧边栏原色、**只清掉那块铺满窗口的外壳的背景**，三道保险：① 运行时深度扫描（背景色与侧边栏精确相等 + 覆盖 ≥90% 窗口，命中打 `data-dsh-bg-frame`）；② 静态选择器 `*:has(> [class*="sidebarCol"])`；③ `#root > *:has([class*="sidebarCol"])`。**不匹配任何哈希类名**（全应用 11 个 `*_frame` 类，会误伤）；选 `全部界面` 才把侧边栏一起纳入半透明 |
| 排查 | 新增 **「检查显示（为什么看不见壁纸）」** 按钮：一键把实况打在面板上（样式表是否注入、壁纸层是否画上、图层尺寸与不透明度、关键变量的实际取值、以及"谁在刷不透明底色"的前 4 个元素）。打包版桌面应用没有 DevTools，这个按钮是唯一的取证手段 |

## 0.2.0 修复版

| 类别 | 内容 |
|---|---|
| 安装 | 默认档位改为**自动识别活动 profile**（优先 `DSH_PROFILE` → 唯一 profile → `bundle` 条目最多者），并打印选中理由；不再默认选 `web` |
| 安装 | 修掉**链接已经断开却报『已就位』**的问题：现在会校验链接目标是否真实存在，断了就自动重建 |
| 安装 | 写清单改成**先写临时文件再改名**的原子写法 + 写完回读校验 + 备份最多保留 5 份 |
| 交互 | DRAG / 滑块改为**按帧合并渲染**（拖动更顺、少掉帧）；主题颜色探测结果**按主题缓存**，不再每次重算 |
| 生命周期 | 插件停用后不再有异步任务把背景层插回来；同时**释放图片占用的内存** |
| 竞态 | 修掉**刚启动就选图，结果被后上传的图顶掉** |
| 交互 | 修鼠标在预览框外松手后仍继续拖动的问题 |
| 上传 | 上传**并发互斥**、解码**超时**保护 |
| 上传 | 增加**文件大小上限与像素上限**，超限的静态图先压到最长边 4096px，防止超大数据把页面拖到白屏 |
| 安全 | SVG 改为**先净化、再转成 PNG 保存**，避免 SVG 里引用外部资源导致联网 |
| 反馈 | 取不到主题颜色时给出**可见提示**（不再静默失效）；出错会写 `console.warn`，便于排查 |
| 显示 | 文件体积显示的是**实际保存后的大小**（压缩前/后不再混淆） |
| 排序 | 插件行 `order` 改为 **101**，稳定排在官方行「当前版本」之后 |

---

## 升级 DSH 之后插件不工作了怎么排查

**先跑自检**（不需要浏览器）：

```powershell
node tools/verify-bundle.cjs
```

红哪一项就改哪一项。插件对宿主的全部依赖面就是下面四条：

| 依赖的机制 | 上游位置（DSH 开源仓库里的路径；**本机 asar 打包版没有源码树**，这些路径只用于对照上游） | 失效表现 | 怎么办 |
|---|---|---|---|
| `settings.general.item` 槽位 | `packages/client/ui-settings/src/client/contract/slots.ts` | 设置里根本不出现「背景图」行 | 改 `lib/client.js` 里的 `ctx.slots.inject('settings.general.item', …)` |
| 客户端 bundle 工厂协议 `window.__ModuleLoader__.load({id, factory})` | `packages/client/tsdown.client.ts` 的 banner / footer | 控制台报模块加载失败，或模块表里没有这个 id | 改 `lib/client.js` 顶部的包装，改完重跑自检 |
| 模块表基线（`react`） | `packages/client/web/src/platform.ts` 的 `PLATFORM_MODULES` | `require('react')` 拿不到东西 | 把依赖写进 `package.json` 的 `dsh.client.external` |
| 表面设计 token `--dsw-alias-bg-*` / `--dsw-specific-*` | `packages/client/ui-theme/src/styles/design-platform.css` | 界面不透明度滑块没效果，或部分面板不透明 | 改 `lib/client.js` 的 `SURFACE_TOKENS` / `ALPHA_FLOOR`。取不到值的 token 会被跳过并给出可见提示（0.1.x 是静默降级） |

---

## 存储与作用范围

| 内容 | 位置 |
|---|---|
| 全部参数 | `localStorage['dsh-bg-changer:config:v1']` |
| 浅色主题图 | IndexedDB 库 `dsh-bg-changer` → 存储 `assets` → 键 `wallpaper`（Blob） |
| 深色主题图 | 同一库同存储 → 键 `wallpaper-dark`（Blob） |
| 降级路径 | IndexedDB 不可用 / 配额失败 → 单张 ≤ 2.5MB 时退化为 localStorage 的 data URL（`dsh-bg-changer:image:v1` / `dsh-bg-changer:image-dark:v1`）→ 再不行则仅当前会话生效（行内会提示） |
| 备份文件 | 你在「备份与迁移」里导出的那份 JSON（插件本身不写任何备份文件到磁盘，下载位置由浏览器决定） |

### 作用范围是「当前浏览器 + 当前 origin」，这一点必须看清

- 桌面 Electron 版窗口的真实 origin 是自定义协议 **`dsh-app://app`**（不是 `http://127.0.0.1:19387`）。
  该协议按 standard + secure 注册，所以 `localStorage` / IndexedDB / `blob:` 在这里都可用；
  应用页面也没有 CSP 限制。
- 浏览器的 localStorage 和 IndexedDB 都是**按 origin 隔离**的。因此：
  - 你在**旧浏览器地址**（例如 `http://127.0.0.1:19387`）下存的壁纸和参数，
    **不会自动出现在桌面版里** —— 需要在桌面版（`dsh-app://app`）里**重新上传一次**；反之亦然。
  - 清空浏览器数据 / 站点数据，**图就没了**，参数也回到出厂状态。
- 作用范围不随会话或工作区变化，不写进 DSH 的 settings，也不进入模型上下文。

---

## 已知限制

- **需要界面半透明**：宿主用 `body` 与各面板用不透明 token 绘制，插件通过覆盖这些 token 让壁纸透出。
  把界面不透明度拉回 100% 时壁纸基本被挡住（设计使然，不是 bug）。
- **弹窗永远不透明**：设置面板、对话框、菜单、提示气泡走
  `role="dialog" / "alertdialog" / "menu" / "listbox" / "tooltip"` 与 `body > :not(#root)` 门户容器作用域，
  始终按主题原始 alpha 绘制——任何滑块档位下文字都可读（刻意设计）。
- **模糊边缘扩边**：模糊度 > 0 时壁纸层向外扩张 `3×模糊` 像素，避免模糊边缘出现硬框。
- **超大 GIF 不压缩**：动图超过 8MB 或最长边超过 4096px 时不做压缩（压缩会丢动画），行内会提示。
- **最多两张图**（浅色一张、深色一张，静态图或动图）：没有视频壁纸、多图轮播、按会话/工作区切换。
- **SVG 有取舍**：含脚本或外部引用的 SVG 会被拒绝（避免联网取图）；干净 SVG 会先转成 PNG 再保存。
- **备份是明文 JSON**：图片以 base64 内嵌，体积约为原图的 1.33 倍；导出/导入全程在本机，不联网。
- **仅在 Chromium 内核验证**：Firefox 未验证。

---

## 开发与验证

```powershell
node --check lib/client.js          # 语法检查（本机实测退出码 0）
node tools/verify-bundle.cjs        # 自检：不需要浏览器，纯 Node 跑
```

**自检条数：以脚本实际的输出为准，不要在文档里写死。**

- **0.3.0（本次）实测：`184 checks passed, 0 failed`**（2026-10-01，Node 22）。
  0.3.0 期间条数一路增长（`117 → 126 → 157 → 160 → 162 → 163 → 166 → 175 → 181 → 184`），
  **写作时是 184**——所以这条只当作一次采样的记录，不要当常量引用。
- 0.2.0 是 `117 checks passed, 0 failed`；0.1.2 稳定代码树（commit `509c39d`）是 `87 checks passed, 0 failed`。
- 因此**条数与红绿一律以 `node tools/verify-bundle.cjs` 实际的输出为准**；
  发布前先让它全绿再打 tag。

`verify-bundle.cjs` 分五段：

1. **源码形态**：只 `require('react')`、无 `import`、按 `window.__ModuleLoader__.load` 注册、id 正确。
2. **插件接线**：`apply` / `inject`、唯一槽位 `settings.general.item`（`id=bg-changer`、`order` 在所有官方行之下、
   `locale=settings.bgChanger`）、中英词典键一致、**apply 阶段无 DOM 写入**。
3. **纯函数**：`computeGeometry`（cover / contain / stretch / tile、缩放与偏移夹取、永不露底）、
   `alphaFor`（各表面 alpha）、`parseRgb`、`clamp`。
4. **持久化全链路**（假 DOM + 假 IndexedDB / localStorage）：恢复已保存的图 → 生成 `#dsh-bg-layer`、
   暗化层与 `style[data-dsh-bg-plugin]`（断言样式表在 head 里、表面 token 覆盖生效、
   **弹窗 / 设置作用域保持主题原始 alpha 不受滑块影响**、`--dsh-bg-*` 变量正确）→ 渲染展开态 UI
   （滑块、分组、chip、预览框）→ 滑块写回根变量 → 点「清除并重置」后图层 / 样式 / 变量 / 本地记录全部消失。

CI 也会跑同样两条命令：`.github/workflows/self-test.yml` 在 push / pull_request 上用
`windows-latest` + Node 22 执行 `node --check lib/client.js` 与 `node tools/verify-bundle.cjs`。

### 目录

```
dsh-bg-changer/
  package.json                dsh.bundle.patch + dsh.client 声明（无 dependencies）
  cordis.patch.yml            - insert: [{ id: bg-changer, name: dsh-bg-changer }]
  lib/index.js                宿主半侧：空 apply（插件行必须能导入）
  lib/client.js               全部功能（手写 lazy-CJS bundle，只 require('react')）
  tools/verify-bundle.cjs     自检（无需浏览器）
  tools/install.cjs           安装 / 卸载（幂等、可干跑、自动备份、原子写清单）
  安装.cmd                     Windows 双击入口 → tools/install.cjs
  .github/workflows/self-test.yml  CI：语法检查 + 自检
  README.md / 使用说明.md / CHANGELOG.md / LICENSE
```

### 为什么手写 bundle

客户端的 `clientBundle` 预置（上游 `packages/client/tsdown.client.ts`）不对外发布成 npm 包，
仓库外的插件必须自己复刻它的产物格式：

```js
window.__ModuleLoader__.load({
  id: '<包名>',
  factory: (require) => { var module = { exports: {} }; /* … */ return module.exports },
})
```

`require` 只能取模块表里的共享基线：`react`（本插件只用纯 JS + `React.createElement`），
所以不用 tsdown、不用 `pnpm install`。上游模块表里还有 `react/jsx-runtime`、`react-dom`、
`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、
`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、
`@deepseek-ai/dsh-client-ui-dockkit`，需要时可以在 `package.json` 的 `dsh.client.external` 里声明。

> 历史：本仓库的前身是 2026-09-10 的一次尝试（面向 `cordis_define` 动态插件机制，被当时的
> `oneOf` schema bug 挡住、从未运行）。现版本改走持久化插件机制，并沿用其 UI 分组思路，代码全部重写。

---

## 兼容性说明

- 面向 **DSH 0.2.0-rc.2 桌面 Electron 版（Windows）**核对；DSH 的 **web profile 亦兼容**，
  前提是同一套 client 模块协议（见上面的排查表）。
- 插件依赖宿主的**共享模块基线**与**表面设计 token**，DSH 大版本升级时这是最可能失效的两处；
  升级后先跑 `node tools/verify-bundle.cjs`。
- 仅在 Chromium 内核（Electron / Chrome）下验证；Firefox 未验证。

## 许可

MIT，见 [LICENSE](./LICENSE)。
