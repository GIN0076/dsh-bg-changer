# Changelog

本文件记录 `dsh-bg-changer` 的所有重要改动。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.3.0] - 2026-10-01

新增「明暗两套图」与「备份与迁移」，同样面向 **DSH 0.2.0-rc.2 桌面 Electron 版（Windows）**；DSH 的 web profile 兼容。

### Added

- **明暗两套图**：图片栏拆成「浅色主题」与「深色主题」两个槽位，各自点击 / 更换 / 移除；
  显示文件名、体积、格式、像素，并带 `当前在用` 徽标标出此刻生效的那张。
- **按主题自动换图**：沿用已有的 `body[data-ds-dark-theme]` 观察机制，主题一变立刻重绘，
  不需要刷新页面；两张图共用布局、效果与界面不透明度（换图不换构图）。
- **只设深色图时的兜底**：浅色槽位为空、深色槽位有图时，两个主题都用深色图，
  避免"放了图却看不到"。
- **备份与迁移**：`导出文件`（下载 JSON）、`复制配置`（剪贴板兜底）、`导入文件`、`粘贴导入`；
  一份 JSON 同时携带参数与两张图片（`config` + `images.light` + `images.dark`）。
- **可自述的备份格式**：`format: "dsh-bg-changer/backup"` + `version: 1` + `exportedAt`；
  导入时非本插件的 JSON、更高版本、超过 64MB 一律拒绝并给出具体提示，不做半吊子写入。
- **新增「壁纸范围」开关**（`sidebarOpaque`，默认 `true` = 仅对话区）：
  Windows 上宿主用**同一个变量**给"整窗口外壳"与"左侧栏列"上色
  （`[data-windows-titlebar] .BynINW_frame` 与 `.BynINW_sidebarCol` 都取 `--dsw-specific-sidebar-fill`），
  因此"不覆盖该变量"会让**整个窗口**保持不透明、壁纸被完全盖住。
  正确实现是保留侧边栏原色、**只清掉那块铺满窗口的外壳的背景**，三道保险：
  ①运行时深度优先（有界 BFS，≤1200 节点）扫描 body/#root 子树，要求"背景色与侧边栏变量精确相等（±2，alpha≥0.9）
  + 矩形覆盖 ≥90% 窗口宽高"，命中打 `data-dsh-bg-frame="1"`；
  ②静态 `*:has(> [class*="sidebarCol"])`；③静态 `#root > *:has([class*="sidebarCol"])`。
  **不匹配任何哈希类名**（全应用共有 11 个 `*_frame` 类，静态选择器会误伤）。
  选「全部界面」时才把侧边栏一起纳入半透明覆盖。旧配置缺这个键时按默认值处理。
  诊断新增「窗口外壳标记（扫描 N 个元素）」与「窗口级元素(前 5 个)」两段，标记失手时可直接读出该清哪个元素。
- 自检从 **117 到 184 条**（**以 `node tools/verify-bundle.cjs` 的实际输出为准**）：新增备份往返、异种更高版本/超大备份拒收、`data:` URL 解码、
  明暗切换选图、只设深色图的兜底、经真实 UI 的粘贴导入与导出内容校验、样式表完整性、诊断自检、
  壁纸范围开关的两向断言、外壳标记只命中铺满窗口的元素。
- **修复侧边栏不跟随界面透明度**：0.2.0-rc.2 的侧边栏底色改用 `--dsw-specific-sidebar-fill`
  （0.1.x 没有这个变量），旧清单未覆盖 → 侧边栏恒不透明。现补齐侧边栏（下限 0）、聊天气泡（0.55）、
  输入框（0.55）、浮层与菜单面（0.6）四个变量。
- **新增「检查显示」诊断按钮**：一键打印样式表注入状态、壁纸层是否存在及尺寸/不透明度、
  关键变量的实际取值、以及主界面里"谁在刷不透明底色"的前 4 个元素；打包版无 DevTools，靠它取证。
- 观感细节：两个槽位都包了同款卡片（原先只有"在用"那个有卡片，另一个悬在空中）；
  空槽位高度收窄；**没有图片时不再显示 `当前在用` 徽标**（原先空槽也会标一个，容易误导）。

### Fixed

- **面板在「未设置壁纸」时完全丢失样式**（0.1.x 起就存在，用户实测发现）：
  插件把自己的样式表与「壁纸图层」绑在一起，没有壁纸时 `render()` 提前返回，
  样式表既没创建也会被清掉 —— 于是整行用浏览器默认外观渲染（灰边按钮、无卡片、无间距）。
  现在样式表在 `apply()` 与每次 `render()` 都确保存在，只有 `dispose()` 才移除；
  停用时样式表回退"基础样式"状态（不含界面半透明覆盖）。
  另外补了三条回归断言：「一 apply 就注入样式表」「样式表就是 base」「apply 不画任何图层/变量」。
- 头部图标与展开箭头由字符（🖼 / ▲▼）改为内联矢量图标：跟随主题文字色、展开时旋转，
  不会再因 emoji 字体不同而忽大忽小。

### Changed

- 图片按槽位分开存储：IndexedDB 键 `wallpaper` / `wallpaper-dark`；
  降级用的 localStorage 键 `dsh-bg-changer:image:v1` / `dsh-bg-changer:image-dark:v1`。
- 「移除」按钮语义改为**移除当前图**（当前主题正在用的那张）；「清除并重置」仍清空两个槽位。
- 面板新增「备份与迁移」分组与相关样式（槽位卡片、徽标、粘贴输入框）。

### Notes

- 导入**只覆盖备份里带的槽位**：备份只有深色图时，现有浅色图不会被动。
- 备份是明文 JSON，图片以 base64 内嵌（体积约为原图 1.33 倍）；导出/导入全程在本机，插件不联网。
- 旧版本的参数与图片自动被识别为「浅色槽位」，升级后无需手动迁移。

## [0.2.0] - 2026-10-01

面向 **DSH 0.2.0-rc.2 桌面 Electron 版（Windows）** 的适配与修复版本；DSH 的 web profile 同样兼容。

> 本次的代码改动随本次发布落地。仓库文档已按 0.2.0 做了静态核对与自检脚本实跑；
> **桌面应用内的实机加载/手感结论由维护者实测确认**，本文档不代为断言。

### Added

- 安装：**自动识别当前活动 profile** —— 优先环境变量 `DSH_PROFILE`，其次唯一 profile，
  再次 `dsh.profile.bundles` 条目最多者；并在输出里打印「选中了哪个 profile、为什么」，
  判断不出来时报错并列出候选项，要求显式传 `--profile`。
- 安装：新增 `--dsh-cli <path>`；`--from-github` 自动探测 DSH CLI（PATH → 旧路径 → 当前 runtime 目录）。
- 安装：写清单前自动备份 `package.json.bak-<时间戳>`（**只保留最近 5 份**）。
- 上传：**文件大小上限与像素上限**校验，超限静态图先压到最长边 4096px。
- 上传：**并发互斥**（连点不会互相覆盖）与**解码超时**保护。
- 反馈：取不到主题颜色时给出**可见提示**（不再静默失效）。
- 反馈：出错写 `console.warn`，便于排查。
- 新增 `CHANGELOG.md` 与 GitHub Actions 自检 workflow（`.github/workflows/self-test.yml`：
  `windows-latest` + Node 22 跑 `node --check lib/client.js` 与 `node tools/verify-bundle.cjs`）。

### Fixed

- 安装：修掉**node_modules 链接已经断开却报『已就位』**的问题 —— 现在会校验链接目标是否真实存在，
  target 指向已不存在的路径时**自动重建**。
- 安装：清单写入改为**先写临时文件再改名**的原子写法，写后**回读校验**。
- 修掉「**刚启动就选图，结果被后上传的图顶掉**」的竞态。
- 修掉鼠标在预览框外松手后**仍继续拖动**的问题。
- 插件停用后不再有异步任务把背景层**插回来**；同时**释放图片占用的内存**。
- 修复界面里显示的文件体积 —— 现在显示**实际保存后的大小**。
- 插件行排序值 `order` 从 `100` 改为 **`101`**，稳定排在官方行「当前版本」之后
  （原先与官方行同序，位置会飘）。

### Changed

- 安装：**默认 profile 不再选 `web`**：改为自动识别活动 profile；所有文档示例改成
  显式 `--profile desktop`（本机桌面版跑的是 `desktop`）。
- 安装完成提示改为「**必须重启桌面应用**才生效」，并给出重启方式。
- **SVG 改为先净化再转成 PNG 保存**，避免 SVG 内引用外部资源导致联网。
- DRAG 与滑块改为**按帧合并渲染**（拖动更顺、少掉帧）；主题颜色探测结果**按主题缓存**。
- 文档重写：删除全部失效信息（已不存在的 `E:\DSH-OneClick` 路径、`--profile web` 默认、端口 3080、
  「取不到 token 走 console.warn」等与代码不符的说法），补齐桌面版 origin `dsh-app://app`
  与「存储按 origin 隔离」的说明。

## [0.1.2] - 2026-09-24

`v0.1.2: keep Settings and overlays opaque at any interface-opacity setting`（commit `509c39d`）

### Fixed

- 界面不透明度滑块原先在 `body` 上全局覆盖 `--dsw-alias-bg-*`，导致设置面板一起变半透明、文字难读。

### Changed

- 新增 `OPAQUE_SCOPE`（`[role=dialog/alertdialog/menu/listbox/tooltip]` 与 `body > :not(#root)` 门户容器）：
  `surfaceCss` 现在输出两段 —— body 层按滑块做半透明，overlay 作用域内把同样的 token
  **按探测到的原始 alpha 重新声明**，用局部声明压过继承值，因此任何滑块档位下
  设置面板 / 对话框 / 菜单都保持默认外观。
- `parseRgb` 改为返回 `{r,g,b,a}`，半透明调色板 token（mask、menu）能精确还原，而不会被强制成不透明。
- 同步更新中英文界面提示文案、README、使用说明。
- 自检条数 84 → **87**（新增：opaque scope 存在、原始 alpha 保留、提示文案）。

## [0.1.1] - 2026-09-17

`v0.1.1: fix token compatibility for DSH v0.1.6-alpha.2`（commit `e0904a9`）

### Fixed

- 面向 DSH v0.1.6-alpha.2 的设计 token 兼容性问题。

### Changed

- 移除 6 个已废弃的表面 token（`bg-overlay`、`sidebar-fill`、`selector`、`input-major`、
  `button-floating-fill`、`button-elevated-fill`）。
- 新增 2 个 token（`bg-mask-1`、`specific-menu`），改善半透明覆盖效果。
- 同步更新自检脚本的 token 集合，共 4 项检查全部通过。
- README 的「已验证」补上 v0.1.6-alpha.2。

## [0.1.0] - 2026-09-17

`dsh-bg-changer v0.1.0：DSH 背景图插件（设置 → 通用 最下方）`（commit `bf575d3`）

### Added

- 首个可用版本：在 **设置 → 通用** 最下方注册一行「背景图」。
- 图片：点击 / 拖拽上传（PNG / JPEG / WebP / GIF / BMP / AVIF / SVG），显示文件名、体积、格式、像素，
  支持更换 / 移除。
- 布局与裁剪：填充 / 适应 / 拉伸 / 平铺、缩放 50–300%、水平与垂直偏移 −100…100、
  与窗口同宽高比的预览框（拖拽平移 + 滚轮缩放）、重置构图。
- 效果：图片不透明度、模糊度（0–40px）、暗化。
- 界面：界面不透明度（默认 65%），主界面半透明以透出壁纸。
- 动作：启用 / 停用、移除、清除并重置。
- 持久化：参数存 `localStorage`，图片 Blob 进 IndexedDB（不可用时按体积降级）。
- 手写 lazy-CJS 客户端 bundle（只 `require('react')`，零构建、零依赖），
  仅作为可导入插件行的宿主半侧；
  配套 `tools/verify-bundle.cjs` 自检与 `tools/install.cjs` 安装/卸载脚本。
- MIT 许可。

[0.2.0]: https://github.com/GIN0076/dsh-bg-changer/compare/509c39d...HEAD
[0.1.2]: https://github.com/GIN0076/dsh-bg-changer/commit/509c39d
[0.1.1]: https://github.com/GIN0076/dsh-bg-changer/commit/e0904a9
[0.1.0]: https://github.com/GIN0076/dsh-bg-changer/commit/bf575d3
