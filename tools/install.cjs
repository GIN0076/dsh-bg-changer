#!/usr/bin/env node
/**
 * dsh-bg-changer installer / uninstaller for a DSH profile.
 *
 * Why this exists: a destructive DSH update rebuilds `~/.dsh/profiles/<profile>`,
 * so after every reinstall this script puts the plugin back in one command. It
 * never touches DSH sources and never needs the network: it links this checkout
 * into the profile's `node_modules`, registers the package in the profile
 * manifest, and tells you to restart the app.
 *
 * Usage (from anywhere):
 *   node tools/install.cjs                          install into the active profile
 *   node tools/install.cjs --dry-run                print the plan, change nothing
 *   node tools/install.cjs --profile desktop        target one profile explicitly
 *   node tools/install.cjs --from-github            install github:GIN0076/dsh-bg-changer
 *   node tools/install.cjs --uninstall              remove dependency + bundle entry + link
 *
 * Options:
 *   --profile <name>   profile under <DSH_HOME>/profiles (default: auto-detect)
 *   --dsh-home <dir>   DSH home directory (default: $DSH_HOME or ~/.dsh)
 *   --source <dir>     plugin checkout to link (default: this repository root)
 *   --dsh-cli <file>   DSH CLI entry for --from-github (default: auto-detect)
 *   --from-github [s]  install through the DSH CLI / pnpm (optional git spec)
 *   --github-spec <s>  same as `--from-github <spec>` (kept for compatibility)
 *   --dry-run          print the plan and exit without writing
 *   --force            replace an existing node_modules link/file pointing elsewhere
 *   --uninstall        undo an install
 *
 * Auto-detection order for the profile: `--profile` → `$DSH_PROFILE` →
 * the only profile → the profile with the most `dsh.profile.bundles` entries.
 * The chosen profile and the reason are always printed.
 *
 * Exit codes: 0 success, 1 refused/failed.
 */
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const REPO_ROOT = path.resolve(__dirname, '..')
const MANIFEST_PATH = path.join(REPO_ROOT, 'package.json')
const pkg = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
const NAME = pkg.name
const DEFAULT_GITHUB_SPEC = 'github:GIN0076/dsh-bg-changer'
/** How many `package.json.bak-*` files to keep beside a profile manifest. */
const KEEP_BACKUPS = 5

const USAGE = [
  'dsh-bg-changer installer',
  '',
  '  node tools/install.cjs [--dry-run] [--profile <name>] [--force]',
  '  node tools/install.cjs --from-github [<spec>] [--dsh-cli <file>]',
  '  node tools/install.cjs --uninstall [--dry-run] [--profile <name>]',
  '',
].join('\n')

/** Print one step line. */
function step(message) {
  process.stdout.write('  ' + message + '\n')
}

/** Print one section header. */
function section(title) {
  process.stdout.write('\n' + title + '\n')
}

/** Print and abort. */
function fail(message) {
  process.stderr.write('\n错误：' + message + '\n')
  process.exit(1)
}

/** Local timestamp (with milliseconds) for backup names. */
function stamp() {
  const now = new Date()
  const pad = value => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-`
    + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-`
    + String(now.getMilliseconds()).padStart(3, '0')
}

function parseArgs(argv) {
  const options = {
    profile: '',
    dshHome: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
    source: REPO_ROOT,
    dshCli: process.env.DSH_CLI || '',
    githubSpec: '',
    dryRun: false,
    force: false,
    fromGithub: false,
    uninstall: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) fail(arg + ' needs a value')
      index += 1
      return value
    }
    if (arg === '--profile') options.profile = next()
    else if (arg === '--dsh-home') options.dshHome = path.resolve(next())
    else if (arg === '--source') options.source = path.resolve(next())
    else if (arg === '--dsh-cli') options.dshCli = next()
    else if (arg === '--github-spec') options.githubSpec = next()
    else if (arg === '--from-github') {
      options.fromGithub = true
      const value = argv[index + 1]
      if (value !== undefined && !value.startsWith('--')) {
        options.githubSpec = value
        index += 1
      }
    } else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--force') options.force = true
    else if (arg === '--uninstall' || arg === '--remove') options.uninstall = true
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write(USAGE)
      process.exit(0)
    } else fail('unknown argument ' + JSON.stringify(arg) + '\n\n' + USAGE)
  }
  if (options.githubSpec === '') options.githubSpec = DEFAULT_GITHUB_SPEC
  return options
}

/** Read one JSON file, tolerating a BOM and explaining malformed content. */
function readJson(file, label) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    fail('读不到' + label + '：' + file + '\n       ' + error.message)
  }
  const text = raw.replace(/^\uFEFF/, '').trim()
  if (text === '') fail(label + '是空文件：' + file)
  try {
    return JSON.parse(text)
  } catch (error) {
    fail(label + '不是合法 JSON：' + file + '\n       ' + error.message)
  }
}

/**
 * Write JSON with a trailing newline, 2-space indent, non-ASCII preserved.
 * Written to a sibling temp file and renamed, so an interrupted run can never
 * leave a half-written manifest behind.
 */
function writeJson(file, value) {
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

/** Back the manifest up and keep only the newest few backups. */
function backupManifest(manifestPath) {
  const backup = manifestPath + '.bak-' + stamp()
  fs.copyFileSync(manifestPath, backup)
  const directory = path.dirname(manifestPath)
  const prefix = path.basename(manifestPath) + '.bak-'
  let stale = []
  try {
    stale = fs.readdirSync(directory).filter(name => name.startsWith(prefix)).sort()
  } catch (error) {
    stale = []
  }
  let removed = 0
  while (stale.length > KEEP_BACKUPS) {
    const victim = stale.shift()
    try {
      fs.rmSync(path.join(directory, victim), { force: true })
      removed += 1
    } catch (error) { /* a kept backup must never break the install */ }
  }
  return { backup, removed }
}

/** Candidate profile directory names under <DSH_HOME>/profiles. */
function listProfiles(options) {
  let entries = []
  try {
    entries = fs.readdirSync(path.join(options.dshHome, 'profiles'), { withFileTypes: true })
  } catch (error) {
    return []
  }
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
}

/** Number of registered bundle layers in one profile (-1 when unreadable). */
function bundleCount(options, name) {
  const manifestPath = path.join(options.dshHome, 'profiles', name, 'package.json')
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''))
    const bundles = parsed != null && parsed.dsh != null && parsed.dsh.profile != null
      ? parsed.dsh.profile.bundles
      : null
    return Array.isArray(bundles) ? bundles.length : 0
  } catch (error) {
    return -1
  }
}

/** Decide which profile to touch, and say why. */
function pickProfile(options) {
  if (options.profile !== '') return { name: options.profile, reason: '--profile 指定' }
  const names = listProfiles(options)
  const fromEnv = process.env.DSH_PROFILE
  if (fromEnv != null && fromEnv !== '' && names.indexOf(fromEnv) >= 0) {
    return { name: fromEnv, reason: '环境变量 DSH_PROFILE' }
  }
  if (names.length === 1) return { name: names[0], reason: '这是唯一的 profile' }
  if (names.length > 1) {
    const scored = names
      .map(name => ({ name, count: bundleCount(options, name) }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
    if (scored[0].count > 0) {
      return { name: scored[0].name, reason: 'bundle 条目最多（' + scored[0].count + ' 条）' }
    }
  }
  fail('无法判断当前活动的 profile。\n'
    + '       已发现：' + (names.length > 0 ? names.join(', ') : '（没有 profiles 目录）') + '\n'
    + '       请显式指定，例如：--profile desktop')
}

/** Where the profile lives, validated, plus its parsed manifest. */
function resolveProfile(options) {
  const picked = pickProfile(options)
  const dir = path.join(options.dshHome, 'profiles', picked.name)
  const manifestPath = path.join(dir, 'package.json')
  if (!fs.existsSync(manifestPath)) {
    fail('没有找到 profile：' + manifestPath + '\n'
      + '       先启动一次 DSH（让该 profile 生成），或换一个名字：--profile <name>\n'
      + '       已发现：' + (listProfiles(options).join(', ') || '（无）'))
  }
  const manifest = readJson(manifestPath, 'profile 清单 ')
  return { dir, manifestPath, manifest, picked }
}

/** The bundle layer list, created on demand. */
function ensureProfile(manifest, options) {
  if (manifest.dsh == null || typeof manifest.dsh !== 'object') manifest.dsh = {}
  if (manifest.dsh.profile == null || typeof manifest.dsh.profile !== 'object') manifest.dsh.profile = {}
  if (!Array.isArray(manifest.dsh.profile.bundles)) manifest.dsh.profile.bundles = []
  return manifest.dsh.profile.bundles
}

function dependenciesOf(manifest) {
  if (manifest.dependencies == null || typeof manifest.dependencies !== 'object') manifest.dependencies = {}
  return manifest.dependencies
}

function normalized(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** Whether an entry exists and where it points. A broken link reports real = ''. */
function linkState(target) {
  let stats
  try {
    stats = fs.lstatSync(target)
  } catch (error) {
    return { exists: false }
  }
  if (stats.isSymbolicLink()) {
    let real = ''
    let broken = false
    try {
      real = fs.realpathSync(target)
    } catch (error) {
      real = ''
      broken = true
    }
    return { exists: true, kind: 'link', real, broken }
  }
  if (stats.isDirectory()) return { exists: true, kind: 'dir' }
  return { exists: true, kind: 'file' }
}

/** Create the node_modules entry this profile resolves the row through. */
function createLink(target, source) {
  if (process.platform === 'win32') fs.symlinkSync(source, target, 'junction')
  else fs.symlinkSync(source, target, 'dir')
}

/** Remove only the link — never recurse into a real directory. */
function removeEntry(target, state) {
  if (state.kind === 'link') {
    try {
      fs.rmSync(target, { recursive: false, force: true })
      return true
    } catch (error) { /* fall through */ }
    try {
      fs.unlinkSync(target)
      return true
    } catch (error) { /* fall through */ }
    try {
      fs.rmdirSync(target)
      return true
    } catch (error) {
      return false
    }
  }
  if (state.kind === 'dir') {
    // A copied directory: refuse to delete recursively, so a wrong path can
    // never take real files with it.
    return false
  }
  return false
}

/** One existing path from a candidate list, or ''. */
function firstFile(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate
  }
  return ''
}

/** Ask the OS where a bare command lives. */
function whichOnPath(command) {
  try {
    const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], { encoding: 'utf8' })
    if (probe.status !== 0 || typeof probe.stdout !== 'string') return ''
    const line = probe.stdout.split(/\r?\n/).map(entry => entry.trim()).filter(Boolean)[0]
    return line || ''
  } catch (error) {
    return ''
  }
}

/** Auto-detect the DSH CLI for the --from-github path. */
function detectDshCli(options) {
  const resourcesRuntime = path.join(path.dirname(process.execPath), '..')
  const desktopLayout = [
    path.join(resourcesRuntime, 'cli', 'bin', 'dsh.cmd'),
    path.join(resourcesRuntime, 'cli', 'bin', 'dsh'),
  ]
  const installedLayout = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
  ]
  const legacy = [
    path.join('E:', path.sep, 'DSH-OneClick', 'src', 'apps', 'cli', 'lib', 'bin.js'),
    path.join('E:', path.sep, 'DSH-OneClick', 'dsh.cmd'),
  ]
  return firstFile([
    options.dshCli,
    whichOnPath('dsh.cmd'),
    whichOnPath('dsh'),
    ...desktopLayout,
    ...installedLayout,
    ...legacy,
  ])
}

function installFromGithub(options) {
  const cli = detectDshCli(options)
  if (cli === '') {
    fail('没有自动找到 DSH CLI，请手动执行：\n'
      + `       dsh plugin --profile ${options.profile || '<profile>'} add ${options.githubSpec}\n`
      + '       （或用 --dsh-cli <你的 dsh.cmd / bin.js 路径>）\n'
      + '       提示：从桌面版安装的机器上，CLI 通常在\n'
      + '       <安装目录>\\resources\\runtime\\cli\\bin\\dsh.cmd')
  }
  const profileName = pickProfile(options).name
  const args = cli.endsWith('.cmd') || cli.endsWith('.bat')
    ? ['/d', '/c', cli, 'plugin', '--profile', profileName, 'add', options.githubSpec]
    : [cli, 'plugin', '--profile', profileName, 'add', options.githubSpec]
  section('用 DSH CLI 安装（会走 pnpm，需要网络）')
  step(`profile : ${profileName}`)
  step(`cli     : ${cli}`)
  step(`spec    : ${options.githubSpec}`)
  if (options.dryRun) {
    step('dry-run：未执行')
    return 0
  }
  const result = spawnSync(cli.endsWith('.cmd') || cli.endsWith('.bat') ? 'cmd' : process.execPath, args, {
    stdio: 'inherit',
    cwd: path.dirname(cli),
  })
  if (result.status !== 0) {
    fail('DSH CLI 安装失败（exit ' + result.status + '）。git 依赖安装失败时看一下 pnpm 的提示，'
      + '或改用本目录 link 安装：node tools/install.cjs')
  }
  section('完成')
  step('1) 重启桌面应用（新增 bundle 层只在启动时读取）')
  step('2) 打开 设置 → 通用，最下方应出现「背景图」')
  step('若 DSH 之后报 lockfile 相关错误：在该 profile 目录跑一次 pnpm install 即可。')
  return 0
}

function installLocal(options) {
  const source = options.source
  if (!fs.existsSync(path.join(source, 'package.json'))) {
    fail('源目录里没有 package.json：' + source)
  }
  const sourcePkg = readJson(path.join(source, 'package.json'), '源 package.json ')
  if (sourcePkg.name !== NAME) {
    fail('源目录不是 ' + NAME + '：' + source + '（package.json 里的 name 是 ' + String(sourcePkg.name) + '）')
  }
  const patchRel = sourcePkg.dsh != null && sourcePkg.dsh.bundle != null ? sourcePkg.dsh.bundle.patch : null
  if (typeof patchRel !== 'string' || patchRel === '') {
    fail('源 package.json 没有声明 dsh.bundle.patch：' + source)
  }
  if (!fs.existsSync(path.resolve(source, patchRel))) {
    fail('源里找不到 bundle patch 文件：' + path.resolve(source, patchRel)
      + '\n       缺了它 DSH 启动时会因找不到 patch 层而失败。')
  }

  const { dir, manifestPath, manifest, picked } = resolveProfile(options)
  const target = path.join(dir, 'node_modules', NAME)
  const spec = 'link:' + source.replace(/\\/g, '/')
  const bundles = ensureProfile(manifest, options)
  const dependencies = dependenciesOf(manifest)
  const state = linkState(target)
  const alreadyLinked = state.exists && state.kind === 'link' && state.real !== ''
    && normalized(state.real) === normalized(source)
  const alreadyRegistered = dependencies[NAME] === spec && bundles.includes(NAME)

  section('计划（本目录 link 安装）')
  step(`profile   : ${dir}`)
  step(`            （选择依据：${picked.reason}）`)
  step(`source    : ${source}`)
  step(`link      : ${target}`)
  step(`dependency: ${NAME} = ${spec}`)
  step(`bundles   : ${NAME} ${bundles.includes(NAME) ? '（已在列表中）' : '（将追加到末尾）'}`)
  step(`本机状态  : ${alreadyLinked
    ? 'link 已就位'
    : state.exists
      ? (state.broken ? '已有一条断链（目标不存在，将重建）' : `已有 ${state.kind} 条目（将替换）`)
      : '无条目'}，${alreadyRegistered ? '清单已登记' : '清单需更新'}`)

  if (alreadyLinked && alreadyRegistered) {
    section('已经是安装状态，无需改动')
    step('若界面里还没出现：重启桌面应用（新增 bundle 层只在启动时读取），再打开 设置 → 通用。')
    return 0
  }
  if (state.exists && !alreadyLinked && state.kind !== 'link' && !options.force) {
    fail(`${target} 已存在（${state.kind}）且不是指向本目录的链接。\n`
      + '       用 --force 覆盖（真实目录不会被递归删除），或先手动删除该条目。')
  }
  if (options.dryRun) {
    section('dry-run：未写入任何文件')
    return 0
  }

  section('执行')
  const { backup, removed } = backupManifest(manifestPath)
  step(`已备份清单：${path.basename(backup)}${removed > 0 ? `（清理了 ${removed} 份旧备份）` : ''}`)
  const nodeModules = path.dirname(target)
  if (!fs.existsSync(nodeModules)) {
    fs.mkdirSync(nodeModules, { recursive: true })
    step('已创建 profile 的 node_modules')
  }
  if (state.exists && !alreadyLinked) {
    const removedEntry = removeEntry(target, state)
    if (!removedEntry) fail('无法替换已存在的条目：' + target + '\n       它是一个真实目录，请手动处理。')
    step(state.broken ? '已移除断链' : '已移除旧条目')
  }
  if (!alreadyLinked) {
    try {
      createLink(target, source)
    } catch (error) {
      fail('建立链接失败：' + target + '\n       ' + error.message)
    }
    step('已建立 link（Windows 用 junction，无需管理员）')
  }

  // Re-read the manifest, so a concurrent DSH write is not clobbered.
  const latest = readJson(manifestPath, 'profile 清单 ')
  const latestBundles = ensureProfile(latest, options)
  const latestDependencies = dependenciesOf(latest)
  latestDependencies[NAME] = spec
  if (!latestBundles.includes(NAME)) latestBundles.push(NAME)
  writeJson(manifestPath, latest)

  const verify = readJson(manifestPath, 'profile 清单 ')
  if (verify.dependencies == null || verify.dependencies[NAME] !== spec
    || !Array.isArray(verify.dsh?.profile?.bundles) || !verify.dsh.profile.bundles.includes(NAME)) {
    fail('清单写入后校验失败，请用备份还原：' + backup)
  }
  step('已写入并校验 profile 清单')

  section('完成')
  step('1) 重启桌面应用（新增 bundle 层只在启动时读取）')
  step('   Windows 桌面版：托盘菜单退出后重新打开 DeepSeek Harness')
  step('2) 打开 设置 → 通用，最下方即「背景图」行')
  step('3) 只改了 lib/client.js 的后续更新不需要重启，Ctrl+Shift+R 硬刷新即可')
  step(`回退：node tools/install.cjs --uninstall --profile ${picked.name}   （备份：${path.basename(backup)}）`)
  step('若 DSH 之后报 lockfile 相关错误：在该 profile 目录跑一次 pnpm install 即可。')
  return 0
}

function uninstall(options) {
  const { dir, manifestPath, manifest, picked } = resolveProfile(options)
  const target = path.join(dir, 'node_modules', NAME)
  const state = linkState(target)
  const bundles = ensureProfile(manifest, options)
  const dependencies = dependenciesOf(manifest)
  const hasDependency = Object.prototype.hasOwnProperty.call(dependencies, NAME)
  const hasBundle = bundles.includes(NAME)
  const removable = state.exists && state.kind === 'link'

  section('计划（卸载）')
  step(`profile   : ${dir}`)
  step(`            （选择依据：${picked.reason}）`)
  step(`dependency: ${hasDependency ? '将移除 ' + NAME : '无'}`)
  step(`bundles   : ${hasBundle ? '将移除 ' + NAME : '无'}`)
  step(`node_modules 条目: ${state.exists ? '将移除（' + state.kind + (state.broken ? '，断链' : '') + '）' : '无'}`)
  if (state.exists && state.kind === 'dir') {
    step('注意：该条目是真实目录（不是 link），为安全起见不会删除，请自行处理。')
  }
  if (!hasDependency && !hasBundle && !removable) {
    section('没有可移除的内容，无需改动')
    return 0
  }
  if (options.dryRun) {
    section('dry-run：未写入任何文件')
    return 0
  }

  section('执行')
  if (hasDependency || hasBundle) {
    const { backup, removed } = backupManifest(manifestPath)
    step(`已备份清单：${path.basename(backup)}${removed > 0 ? `（清理了 ${removed} 份旧备份）` : ''}`)
    delete dependencies[NAME]
    const index = bundles.indexOf(NAME)
    if (index >= 0) bundles.splice(index, 1)
    writeJson(manifestPath, manifest)
    step('已从 profile 清单移除')
  }
  if (removable) {
    if (removeEntry(target, state)) step('已移除 node_modules 条目')
    else step('警告：node_modules 条目移除失败，请手动删除：' + target)
  }

  section('完成')
  step('重启桌面应用后插件行随之消失')
  step('壁纸与参数在浏览器存储里，如需彻底清理：DevTools 删除 localStorage 键')
  step('dsh-bg-changer:config:v1 / dsh-bg-changer:image:v1，以及 IndexedDB 库 dsh-bg-changer。')
  step('若 DSH 之后报 lockfile 相关错误：在该 profile 目录跑一次 pnpm install 即可。')
  return 0
}

const options = parseArgs(process.argv.slice(2))
process.stdout.write(`dsh-bg-changer 安装器  ${NAME}@${pkg.version}\n`)
process.exit(options.uninstall ? uninstall(options) : options.fromGithub ? installFromGithub(options) : installLocal(options))
