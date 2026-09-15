#!/usr/bin/env node
/**
 * dsh-bg-changer installer / uninstaller for a DSH profile.
 *
 * Why this exists: a destructive DSH update wipes `~/.dsh/profiles/web`, so after
 * every reinstall this script puts the plugin back in one command. It never
 * touches DSH sources and never needs the network: it links this checkout into
 * the profile's `node_modules`, registers the package in the profile manifest,
 * and reminds you to restart the service.
 *
 * Usage (from anywhere):
 *   node tools/install.cjs                     install from this checkout
 *   node tools/install.cjs --dry-run           print the plan, change nothing
 *   node tools/install.cjs --from-github       install github:GIN0076/dsh-bg-changer
 *   node tools/install.cjs --uninstall         remove dependency + bundle entry + link
 *   node tools/install.cjs --profile tui       target another profile
 *
 * Options:
 *   --profile <name>   profile under <DSH_HOME>/profiles (default: web)
 *   --dsh-home <dir>   DSH home directory (default: $DSH_HOME or ~/.dsh)
 *   --source <dir>     plugin checkout to link (default: this repository root)
 *   --dsh-cli <file>   DSH CLI entry for --from-github (default: auto-detect)
 *   --github-spec <s>  override the git spec (default: github:GIN0076/dsh-bg-changer)
 *   --dry-run          print the plan and exit without writing
 *   --force            replace an existing node_modules entry pointing elsewhere
 *   --uninstall        undo an install
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

const USAGE = [
  'dsh-bg-changer installer',
  '',
  '  node tools/install.cjs [--dry-run] [--profile web] [--source <dir>] [--force]',
  '  node tools/install.cjs --from-github [--dsh-cli <file>]',
  '  node tools/install.cjs --uninstall [--dry-run]',
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

/** Local timestamp for backup names. */
function stamp() {
  const now = new Date()
  const pad = value => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

function parseArgs(argv) {
  const options = {
    profile: 'web',
    dshHome: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
    source: REPO_ROOT,
    dshCli: process.env.DSH_CLI || '',
    githubSpec: DEFAULT_GITHUB_SPEC,
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
    else if (arg === '--dsh-home') options.dshHome = next()
    else if (arg === '--source') options.source = path.resolve(next())
    else if (arg === '--dsh-cli') options.dshCli = next()
    else if (arg === '--github-spec') options.githubSpec = next()
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--force') options.force = true
    else if (arg === '--from-github') options.fromGithub = true
    else if (arg === '--uninstall' || arg === '--remove') options.uninstall = true
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write(USAGE)
      process.exit(0)
    } else fail('unknown argument ' + JSON.stringify(arg) + '\n\n' + USAGE)
  }
  return options
}

function readJson(file) {
  // Tolerate a UTF-8 BOM: editors on Windows add one, JSON.parse does not.
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
}

/** Write JSON with a trailing newline, 2-space indent, non-ASCII preserved. */
function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

/** Where the profile lives, validated. */
function resolveProfile(options) {
  const dir = path.join(options.dshHome, 'profiles', options.profile)
  const manifestPath = path.join(dir, 'package.json')
  if (!fs.existsSync(manifestPath)) {
    fail(`没有找到 profile：${manifestPath}\n`
      + '       请先启动/使用一次 DSH（或 `dsh plugin --profile ' + options.profile + ' list`）再装插件。')
  }
  return { dir, manifestPath, manifest: readJson(manifestPath) }
}

/** The bundle layer list, created on demand. */
function ensureProfile(manifest, options) {
  if (manifest.dsh == null || typeof manifest.dsh !== 'object') manifest.dsh = {}
  if (manifest.dsh.profile == null || typeof manifest.dsh.profile !== 'object') manifest.dsh.profile = {}
  if (!Array.isArray(manifest.dsh.profile.bundles)) manifest.dsh.profile.bundles = []
  return manifest.dsh.profile.bundles
}

function normalized(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** Whether an entry exists and where it points. */
function linkState(target) {
  let stats
  try {
    stats = fs.lstatSync(target)
  } catch (error) {
    return { exists: false }
  }
  if (stats.isSymbolicLink()) {
    let real = ''
    try {
      real = fs.realpathSync(target)
    } catch (error) {
      real = ''
    }
    return { exists: true, kind: 'link', real }
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

/** Auto-detect the DSH CLI for the --from-github path. */
function detectDshCli(options) {
  const candidates = [
    options.dshCli,
    path.join('E:', path.sep, 'DSH-OneClick', 'src', 'apps', 'cli', 'lib', 'bin.js'),
    path.join('E:', path.sep, 'DSH-OneClick', 'dsh.cmd'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return ''
}

function installFromGithub(options) {
  const cli = detectDshCli(options)
  if (cli === '') {
    fail('没有自动找到 DSH CLI，请手动执行：\n'
      + `       dsh plugin --profile ${options.profile} add ${options.githubSpec}\n`
      + '       （或用 --dsh-cli <你的 dsh.cmd / bin.js 路径>）')
  }
  const args = cli.endsWith('.cmd')
    ? ['/d', '/c', cli, 'plugin', '--profile', options.profile, 'add', options.githubSpec]
    : [cli, 'plugin', '--profile', options.profile, 'add', options.githubSpec]
  section('用 DSH CLI 安装（会走 pnpm，需要网络）')
  step(`cli   : ${cli}`)
  step(`spec  : ${options.githubSpec}`)
  if (options.dryRun) {
    step('dry-run：未执行')
    return 0
  }
  const result = spawnSync(cli.endsWith('.cmd') ? 'cmd' : process.execPath, args, {
    stdio: 'inherit',
    cwd: path.dirname(cli),
  })
  if (result.status !== 0) {
    fail('DSH CLI 安装失败（exit ' + result.status + '）。git 依赖安装失败时看一下 pnpm 的提示，'
      + '或改用默认的本目录 link 安装：node tools/install.cjs')
  }
  section('完成')
  step('接下来重启 DSH 服务，然后刷新页面：设置 → 通用 最下方应出现「背景图」。')
  return 0
}

function installLocal(options) {
  const source = options.source
  if (!fs.existsSync(path.join(source, 'package.json'))) {
    fail('源目录里没有 package.json：' + source)
  }
  const { dir, manifestPath, manifest } = resolveProfile(options)
  const target = path.join(dir, 'node_modules', NAME)
  const spec = 'link:' + source.replace(/\\/g, '/')
  const bundles = ensureProfile(manifest, options)
  const dependencies = manifest.dependencies == null || typeof manifest.dependencies !== 'object'
    ? (manifest.dependencies = {})
    : manifest.dependencies
  const state = linkState(target)
  const alreadyLinked = state.exists && state.kind === 'link' && normalized(state.real) === normalized(source)
  const alreadyRegistered = dependencies[NAME] === spec && bundles.includes(NAME)

  section('计划（本目录 link 安装）')
  step(`profile   : ${dir}`)
  step(`source    : ${source}`)
  step(`link      : ${target}`)
  step(`dependency: ${NAME} = ${spec}`)
  step(`bundles   : ${NAME} ${bundles.includes(NAME) ? '（已在列表中）' : '（将追加到末尾）'}`)
  step(`本机状态  : ${alreadyLinked ? 'link 已就位' : state.exists ? `已有 ${state.kind} 条目` : '无条目'}`
    + '，' + (alreadyRegistered ? '清单已登记' : '清单需更新'))

  if (alreadyLinked && alreadyRegistered) {
    section('已经是安装状态，无需改动')
    step('若界面里还没出现，请重启 DSH 服务 + 刷新页面（Ctrl+Shift+R）。')
    return 0
  }
  if (state.exists && !alreadyLinked && !options.force) {
    fail(`${target} 已存在（${state.kind}）且不是指向本目录。\n`
      + '       用 --force 覆盖，或先手动删除该条目。')
  }
  if (options.dryRun) {
    section('dry-run：未写入任何文件')
    return 0
  }

  section('执行')
  const backup = `${manifestPath}.bak-${stamp()}`
  fs.copyFileSync(manifestPath, backup)
  step(`已备份清单：${path.basename(backup)}`)
  const nodeModules = path.dirname(target)
  if (!fs.existsSync(nodeModules)) {
    fs.mkdirSync(nodeModules, { recursive: true })
    step('已创建 profile 的 node_modules')
  }
  if (state.exists && !alreadyLinked) {
    const removed = removeEntry(target, state)
    if (!removed) fail('无法替换已存在的条目：' + target)
    step('已移除旧条目')
  }
  if (!alreadyLinked) {
    createLink(target, source)
    step('已建立 link（Windows 用 junction，无需管理员）')
  }
  dependencies[NAME] = spec
  if (!bundles.includes(NAME)) bundles.push(NAME)
  writeJson(manifestPath, manifest)
  const verify = readJson(manifestPath)
  if (verify.dependencies == null || verify.dependencies[NAME] !== spec
    || !Array.isArray(verify.dsh?.profile?.bundles) || !verify.dsh.profile.bundles.includes(NAME)) {
    fail('清单写入后校验失败，请用备份还原：' + backup)
  }
  step('已写入并校验 profile 清单')

  section('完成')
  step('1) 重启 DSH 服务（新增 bundle 层只在启动时读取）')
  step('2) 刷新页面（Ctrl+Shift+R）→ 设置 → 通用 最下方「背景图」')
  step(`回退：node tools/install.cjs --uninstall   （备份：${path.basename(backup)}）`)
  return 0
}

function uninstall(options) {
  const { dir, manifestPath, manifest } = resolveProfile(options)
  const target = path.join(dir, 'node_modules', NAME)
  const state = linkState(target)
  const bundles = ensureProfile(manifest, options)
  const dependencies = manifest.dependencies == null || typeof manifest.dependencies !== 'object'
    ? (manifest.dependencies = {})
    : manifest.dependencies

  section('计划（卸载）')
  step(`profile   : ${dir}`)
  step(`dependency: ${Object.prototype.hasOwnProperty.call(dependencies, NAME) ? '将移除 ' + NAME : '无'}`)
  step(`bundles   : ${bundles.includes(NAME) ? '将移除 ' + NAME : '无'}`)
  step(`node_modules 条目: ${state.exists ? '将移除（' + state.kind + '）' : '无'}`)
  if (state.exists && state.kind === 'dir') {
    step('注意：该条目是真实目录（不是 link），为安全起见不会删除，请自行处理。')
  }
  if (options.dryRun) {
    section('dry-run：未写入任何文件')
    return 0
  }

  section('执行')
  const backup = `${manifestPath}.bak-${stamp()}`
  fs.copyFileSync(manifestPath, backup)
  step(`已备份清单：${path.basename(backup)}`)
  delete dependencies[NAME]
  const index = bundles.indexOf(NAME)
  if (index >= 0) bundles.splice(index, 1)
  writeJson(manifestPath, manifest)
  step('已从 profile 清单移除')
  if (state.exists && state.kind === 'link') {
    if (removeEntry(target, state)) step('已移除 node_modules 条目')
    else step('警告：node_modules 条目移除失败，请手动删除：' + target)
  }

  section('完成')
  step('重启 DSH 服务即可（插件行随之消失）')
  step('插件自己的数据（壁纸与参数）在浏览器里：DevTools 删除 localStorage 键')
  step('dsh-bg-changer:config:v1 / dsh-bg-changer:image:v1 与 IndexedDB 库 dsh-bg-changer。')
  return 0
}

const options = parseArgs(process.argv.slice(2))
process.stdout.write(`dsh-bg-changer 安装器  ${NAME}@${pkg.version}\n`)
process.exit(options.uninstall ? uninstall(options) : options.fromGithub ? installFromGithub(options) : installLocal(options))
