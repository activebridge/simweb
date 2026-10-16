#!/usr/bin/env node
// simweb — run the ZeppOS simulator headless and drive it from a browser tab.
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync, strFromU8 } from 'fflate'
import { Server as IoServer } from 'socket.io'
import WebSocket, { WebSocketServer } from 'ws'
import { createBridge } from '../lib/bridge.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = path.join(os.homedir(), '.zepp', 'emulator_cache')
const PAGES = {
  side: 'https://zepp-os.zepp.com/frameworks/v4.0.0.4/side-service.html',
  settings: 'https://zepp-os.zepp.com/app-settings/v1.0.1/index.html',
}
// Sensor/display/user values the firmware reads (process/user-setting.js). simweb keeps its
// own copy, seeded from the Zepp simulator's table so both start from the same values.
const VCONFIG_FILE = path.join(os.homedir(), '.simweb', 'vconfig.json')
const ZEPP_VCONFIG = path.join(os.homedir(), '.zepp', 'userData_cache', 'vconfig.json')
const VCONFIG_DEFAULTS = {
  vcfg_heartrate: ['int32', '75'], vcfg_calorie: ['string', '300'], vcfg_walkstep: ['int32', '300'],
  vcfg_battery: ['int32', '88'], vcfg_charge: ['bool', false], vcfg_lock: ['bool', false],
  vcfg_timeformat: ['bool', true], vcfg_language: ['int32', '2'],
}
function loadVconfig () {
  for (const file of [VCONFIG_FILE, ZEPP_VCONFIG]) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')).vconfig } catch {}
  }
  return Object.fromEntries(Object.entries(VCONFIG_DEFAULTS).map(([name, [type, value]]) => [name, { name, type, value }]))
}
// The table goes as raw "name|type|value\r\n" lines spliced into the JSON string unescaped,
// exactly as Electron sends it.
function configFrame (vconfig) {
  let table = '{'
  for (const key in vconfig) if (vconfig[key]) table += `${vconfig[key].name}|${vconfig[key].type}|${vconfig[key].value}\r\n`
  return JSON.stringify({ method: 'Config', vconfig: 'buffer' }).replace('buffer', table + '}')
}

const CATALOG = 'https://upload-cdn.huami.com/zeppos/simulator/download/emulatorList.json'

const args = parseArgs(process.argv.slice(2))
const PORT = Number(args.port || 7650)

const QEMU_CANDIDATES = {
  darwin: ['/Applications/simulator.app/Contents/Resources/firmware/qemu_mac/qemu-system-arm'],
  linux: ['/opt/simulator/resources/firmware/qemu_linux/qemu-system-arm'],
  // per-user install (default) or all-users install
  win32: [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'), process.env.PROGRAMFILES].filter(Boolean)
    .map(dir => path.join(dir, 'simulator', 'resources', 'firmware', 'qemu_win', 'qemu-system-arm.exe')),
}

function parseArgs (argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([^=]+)(?:=(.*))?$/)
    if (!m) continue
    out[m[1]] = m[2] ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true)
  }
  return out
}

function die (msg) {
  console.error('simweb: ' + msg)
  process.exit(1)
}

function findQemu () {
  if (args.qemu) return args.qemu
  const hit = (QEMU_CANDIDATES[process.platform] || []).find(p => fs.existsSync(p))
  if (!hit) die('Zepp Simulator not found. Install it from https://docs.zepp.com/docs/guides/tools/simulator/download/ (or pass --qemu <path>)')
  return hit
}

// Every release in Zepp's public catalog, flagged when its firmware (main.elf +
// norflash.bin) is already in the emulator cache. Offline: just the cached ids.
const LAST_DEVICE_FILE = path.join(os.homedir(), '.simweb', 'device.json')
const isDownloaded = id => fs.existsSync(path.join(CACHE, id, 'main.elf')) && fs.existsSync(path.join(CACHE, id, 'norflash.bin'))
async function listDevices () {
  const list = []
  try {
    const res = await fetch(CATALOG, { signal: AbortSignal.timeout(5000) })
    for (const model of await res.json()) {
      for (const rel of model.released) {
        list.push({ id: rel.id, name: rel.name, code: rel.code, model: model.modelName, image: model.deviceImage, ratio: model.ratio, size: rel.fileSize, url: rel.filePath, support: rel.support, downloaded: isDownloaded(rel.id) })
      }
    }
  } catch {}
  if (fs.existsSync(CACHE)) {
    for (const id of fs.readdirSync(CACHE)) if (isDownloaded(id) && !list.some(d => d.id === id)) list.push({ id, name: id, downloaded: true })
  }
  return list
}

function pickDevice (devices) {
  const ready = devices.filter(d => d.downloaded)
  if (!ready.length) die('no simulator firmware in ' + CACHE + '. Download a device once in the Zepp Simulator.')
  let q = args.device && String(args.device).toLowerCase()
  if (!q) try { q = JSON.parse(fs.readFileSync(LAST_DEVICE_FILE, 'utf8')).id } catch {}
  if (!q) return ready[0]
  const dev = ready.find(d => d.id === q) || ready.find(d => d.name.toLowerCase().includes(q))
  if (!dev && args.device) die('no downloaded device matches "' + args.device + '". Downloaded:\n  ' + ready.map(d => d.name).join('\n  '))
  return dev || ready[0]
}

// Fetch a release zip from Zepp's CDN into the shared emulator cache, the way the Zepp
// simulator does (process/init-emulator-list.js): unzip, rename the folder to the release id.
async function downloadDevice (dev, onProgress) {
  fs.mkdirSync(CACHE, { recursive: true })
  const zip = path.join(CACHE, `${dev.id}.zip`)
  const res = await fetch(dev.url)
  if (!res.ok) throw new Error(`download HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || dev.size || 0
  const out = fs.createWriteStream(zip)
  let received = 0
  let last = 0
  for await (const chunk of res.body) {
    received += chunk.length
    if (!out.write(chunk)) await new Promise(resolve => out.once('drain', resolve))
    if (Date.now() - last > 250) { last = Date.now(); onProgress(received, total) }
  }
  await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())))
  onProgress(total, total)
  const folder = path.basename(new URL(dev.url).pathname).replace(/\..*$/, '')
  const unzip = process.platform === 'win32'
    // Windows 10+ ships bsdtar, which reads zip; full path skips Git's GNU tar on PATH
    ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', CACHE]]
    : ['unzip', ['-q', '-o', zip, '-d', CACHE]]
  await new Promise((resolve, reject) => spawn(...unzip, { stdio: 'ignore' }).on('exit', code => (code ? reject(new Error('unzip failed')) : resolve())))
  fs.rmSync(zip, { force: true })
  if (folder !== dev.id) {
    fs.rmSync(path.join(CACHE, dev.id), { recursive: true, force: true })
    fs.renameSync(path.join(CACHE, folder), path.join(CACHE, dev.id))
  }
  if (!isDownloaded(dev.id)) throw new Error('firmware incomplete after unzip')
}

// Open the page as an app window (no tabs or address bar) in a Chromium browser: the default
// one if it is Chromium, else the first installed; any other browser gets a normal tab.
// --browser <bundle id | app path> overrides, --tab forces a plain tab.
const CHROMIUM_IDS = ['com.google.Chrome', 'net.imput.helium', 'org.chromium.Chromium', 'com.brave.Browser', 'com.microsoft.edgemac', 'com.vivaldi.Vivaldi', 'com.operasoftware.Opera']
const CHROMIUM_BINS = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave-browser', 'microsoft-edge']
function openWindow (url) {
  const appArgs = [`--app=${url}`, '--window-size=1600,950']
  const run = (cmd, argv) => spawn(cmd, argv, { stdio: 'ignore', detached: true }).unref()
  if (args.tab) {
    if (process.platform === 'darwin') return run('open', [url])
    if (process.platform === 'win32') return run('cmd.exe', ['/c', 'start', '', url])
    return run('xdg-open', [url])
  }
  if (process.platform === 'darwin') {
    if (args.browser) return run('open', [String(args.browser).includes('/') ? '-na' : '-nb', String(args.browser), '--args', ...appArgs])
    let id = null
    try {
      const handlers = execFileSync('defaults', ['read', 'com.apple.LaunchServices/com.apple.launchservices.secure', 'LSHandlers'], { encoding: 'utf8' })
      id = (/LSHandlerRoleAll = "([^"]+)";\s*LSHandlerURLScheme = https;/.exec(handlers) || [])[1]
    } catch {}
    const installed = bid => { try { return !!execFileSync('mdfind', [`kMDItemCFBundleIdentifier == '${bid}'`], { encoding: 'utf8' }).trim() } catch { return false } }
    const pick = CHROMIUM_IDS.includes(id) ? id : CHROMIUM_IDS.find(installed)
    return pick ? run('open', ['-nb', pick, '--args', ...appArgs]) : run('open', [url])
  }
  // start resolves chrome/msedge via App Paths; Edge ships with Windows 10/11
  if (process.platform === 'win32') return run('cmd.exe', ['/c', 'start', '', args.browser || 'msedge', ...appArgs])
  const bin = args.browser || CHROMIUM_BINS.find(b => { try { execFileSync('which', [b]); return true } catch { return false } })
  return bin ? run(bin, appArgs) : run('xdg-open', [url])
}

function freePort () {
  return new Promise(resolve => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

// Fresh, disposable flash per device boot. clonefile on APFS makes the 256 MB copy free.
function cloneFlash (dev, dir) {
  const flash = path.join(dir, 'norflash.bin')
  const src = path.join(CACHE, dev.id, 'norflash.bin')
  fs.rmSync(flash, { force: true })
  if (process.platform === 'win32') {
    // Windows has no reflink/clonefile; just copy
    fs.copyFileSync(src, flash)
  } else {
    try {
      execFileSync('cp', process.platform === 'darwin' ? ['-c', src, flash] : ['--reflink=auto', src, flash])
    } catch {
      fs.copyFileSync(src, flash)
    }
  }
}
function prepareRunDir (dev) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simweb-'))
  cloneFlash(dev, dir)
  // -vnc needs a keymap file; the bundle ships none. Touch-only watch, so a stub works.
  fs.mkdirSync(path.join(dir, 'keymaps'))
  fs.writeFileSync(path.join(dir, 'keymaps', 'en-us'), '# minimal\na 0x1e\nb 0x30\nspace 0x39\nReturn 0x1c\n')
  return dir
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' }

// Zepp's hosted page with our bridge shim injected ahead of its bundle. <base> keeps the
// bundle loading from Zepp's CDN; plain <script src> needs no CORS.
const pageCache = {}
async function zeppPage (role, origin) {
  if (!pageCache[role]) {
    const res = await fetch(PAGES[role])
    if (!res.ok) throw new Error(`${PAGES[role]}: HTTP ${res.status}`)
    pageCache[role] = await res.text()
  }
  const base = PAGES[role].replace(/[^/]*$/, '')
  return pageCache[role].replace('<head>', `<head><base href="${base}"><script src="${origin}/shim.js" data-role="${role}"></script>`)
}

function serveFile (res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end(); return }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' }).end(buf)
  })
}

async function main () {
  const qemu = findQemu()
  const devices = await listDevices()
  let dev = pickDevice(devices)
  const vncPort = await freePort()
  const wsPort = await freePort()
  const runDir = prepareRunDir(dev)

  const state = { device: dev, devices, wsPort, serial: [] }
  const serialClients = new Set()
  const eventClients = new Set()
  // Log entries for the page: { src: watch|side|settings|all, line | msg | sep, t, sys? }.
  const logEntry = entry => {
    entry.t = Date.now()
    state.serial.push(entry)
    if (state.serial.length > 15000) state.serial.shift()
    const frame = JSON.stringify(entry)
    for (const ws of serialClients) ws.send(frame)
  }
  const consoleLine = line => logEntry({ src: 'watch', line })
  const emit = ev => { for (const ws of eventClients) ws.send(JSON.stringify(ev)) }
  const bridge = createBridge({
    storeFile: path.join(os.homedir(), '.simweb', 'storage.json'),
    fwUrl: () => `ws://127.0.0.1:${wsPort}`,
    log: logEntry,
    onOpenSettings: ev => emit({ type: 'openSettings', ...ev }),
    onSide: cmd => emit({ type: 'side', cmd }),
  })

  const qemuArgs = () => [
    '-L', runDir,
    '-M', 'mps2-an521', '-semihosting',
    '-drive', `file=${path.join(runDir, 'norflash.bin')},bus=0,unit=0,format=raw`,
    '-kernel', path.join(CACHE, dev.id, 'main.elf'),
    '-nic', `user,id=usernet,hostfwd=tcp:127.0.0.1:${wsPort}-:7833,model=lan9118`,
    '-display', 'none',
    '-vnc', `127.0.0.1:${vncPort - 5900}`,
    '-name', 'simweb',
    '-serial', 'stdio',
  ]
  if (vncPort < 5900) die('no free VNC port')

  let proc = null
  let rebooting = false
  let lastInstall = null // params of the last zeus push, reinstalled after a device switch
  let reinstallAfterBoot = false
  let switchTo = null
  function boot () {
    if (switchTo) { dev = switchTo; switchTo = null; state.device = dev; cloneFlash(dev, runDir) }
    try { fs.mkdirSync(path.dirname(LAST_DEVICE_FILE), { recursive: true }); fs.writeFileSync(LAST_DEVICE_FILE, JSON.stringify({ id: dev.id })) } catch {}
    console.log(`simweb: booting ${dev.name}`)
    logEntry({ src: 'watch', sep: `booting ${dev.name}` })
    proc = spawn(qemu, qemuArgs(), { cwd: path.dirname(qemu), stdio: ['ignore', 'pipe', 'pipe'] })
    let partial = ''
    const onSerial = chunk => {
      const lines = (partial + chunk.toString('utf8')).split(/\r?\n/)
      partial = lines.pop()
      for (const line of lines) consoleLine(line)
    }
    proc.stdout.on('data', onSerial)
    proc.stderr.on('data', onSerial)
    proc.on('exit', code => {
      if (rebooting) { rebooting = false; boot(); return }
      console.log(`simweb: qemu exited (${code})`)
      cleanup()
      process.exit(code || 0)
    })
  }
  // Other firmware: fresh flash for it, then put the last pushed app back on.
  function switchDevice (next) {
    switchTo = next
    reinstallAfterBoot = !!lastInstall
    rebooting = true
    emit({ type: 'device', device: next })
    logEntry({ src: 'all', sep: `switching to ${next.name}` })
    proc.kill('SIGKILL')
  }
  boot()

  function cleanup () {
    fs.rmSync(runDir, { recursive: true, force: true })
  }
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { proc.kill('SIGKILL'); cleanup(); process.exit(0) })
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ device: state.device, devices: state.devices, app: appInfo() }))
      return
    }
    if (url.pathname === '/api/config' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(Object.fromEntries(Object.values(vconfig).map(v => [v.name, v.value]))))
      return
    }
    if (url.pathname === '/api/config' && req.method === 'POST') {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        try {
          for (const [key, value] of Object.entries(JSON.parse(body))) {
            if (!vconfig[key]) continue
            vconfig[key].value = value
          }
          fs.mkdirSync(path.dirname(VCONFIG_FILE), { recursive: true })
          fs.writeFileSync(VCONFIG_FILE, JSON.stringify({ vconfig }))
          fwSend(configFrame(vconfig))
          res.writeHead(204).end()
        } catch (err) {
          res.writeHead(400).end(err.message)
        }
      })
      return
    }
    if (url.pathname === '/api/device' && req.method === 'POST') {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', async () => {
        try {
          const { id } = JSON.parse(body)
          const next = state.devices.find(d => d.id === id)
          if (!next) throw new Error('unknown device')
          res.writeHead(202).end()
          if (!next.downloaded) {
            emit({ type: 'download', id, received: 0, total: next.size })
            await downloadDevice(next, (received, total) => emit({ type: 'download', id, received, total }))
            next.downloaded = true
            emit({ type: 'download', id, done: true })
          }
          switchDevice(next)
        } catch (err) {
          console.error('simweb: device switch failed: ' + err.message)
          emit({ type: 'download', error: err.message })
          if (!res.headersSent) res.writeHead(400).end(err.message)
        }
      })
      return
    }
    if (url.pathname === '/api/chaos' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(bridge.chaos))
      return
    }
    if (url.pathname === '/api/chaos' && req.method === 'POST') {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        try {
          const { link, network, latency, side } = JSON.parse(body)
          const next = {}
          if (typeof link === 'boolean') next.link = link
          if (['online', 'slow', 'failing', 'offline'].includes(network)) next.network = network
          if (Number.isFinite(latency)) next.latency = Math.max(0, latency)
          bridge.setChaos(next)
          if (side === 'kill') bridge.killSide()
          if (side === 'start') bridge.startSide()
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(bridge.chaos))
        } catch (err) {
          res.writeHead(400).end(err.message)
        }
      })
      return
    }
    if (url.pathname === '/api/rest' && req.method === 'POST') {
      fwSend(JSON.stringify({ method: 'ScreenRest' }))
      res.writeHead(204).end()
      return
    }
    if (url.pathname === '/api/screenshot') {
      screenshot().then(
        png => res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }).end(png),
        err => res.writeHead(504).end(err.message))
      return
    }
    if (url.pathname === '/side.html' || url.pathname === '/settings.html') {
      zeppPage(url.pathname.slice(1, -5), `http://${req.headers.host}`).then(
        html => res.writeHead(200, { 'content-type': 'text/html' }).end(html),
        err => res.writeHead(502).end(err.message))
      return
    }
    if (url.pathname.startsWith('/novnc/')) {
      const base = path.join(ROOT, 'node_modules', '@novnc', 'novnc')
      const file = path.join(base, path.normalize(url.pathname.slice('/novnc/'.length)))
      if (!file.startsWith(base)) { res.writeHead(403).end(); return }
      serveFile(res, file)
      return
    }
    const rel = url.pathname === '/' ? 'index.html' : path.normalize(url.pathname.slice(1))
    const file = path.join(ROOT, 'public', rel)
    if (!file.startsWith(path.join(ROOT, 'public'))) { res.writeHead(403).end(); return }
    serveFile(res, file)
  })

  // /vnc: browser ws <-> qemu VNC tcp (what websockify does, minus the package).
  const vncWss = new WebSocketServer({ noServer: true })
  vncWss.on('connection', ws => {
    const sock = net.connect(vncPort, '127.0.0.1')
    sock.on('data', d => ws.readyState === 1 && ws.send(d))
    ws.on('message', d => sock.write(d))
    sock.on('close', () => ws.close())
    sock.on('error', () => ws.close())
    ws.on('close', () => sock.destroy())
  })

  const serialWss = new WebSocketServer({ noServer: true })
  serialWss.on('connection', ws => {
    for (const entry of state.serial) ws.send(JSON.stringify(entry))
    serialClients.add(ws)
    ws.on('close', () => serialClients.delete(ws))
  })

  const eventsWss = new WebSocketServer({ noServer: true })
  eventsWss.on('connection', ws => {
    eventClients.add(ws)
    ws.on('close', () => eventClients.delete(ws))
  })
  const bridgeWss = new WebSocketServer({ noServer: true, maxPayload: 1e9 })

  let vconfig = loadVconfig()
  const shotWaiters = []
  function screenshot () {
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject }
      shotWaiters.push(waiter)
      fwSend(JSON.stringify({ method: 'ScreenShot' }))
      setTimeout(() => {
        const i = shotWaiters.indexOf(waiter)
        if (i >= 0) { shotWaiters.splice(i, 1); reject(new Error('watch did not answer')) }
      }, 15000)
    })
  }

  // Firmware control socket (7833 in the guest). Up only after boot, so retry.
  const fw = { ws: null, queue: [] }
  function connectFirmware () {
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/SIMULATOR`)
    ws.on('open', () => {
      fw.ws = ws
      console.log('simweb: firmware socket up')
      ws.send(configFrame(vconfig))
      if (reinstallAfterBoot && lastInstall) {
        try { install(lastInstall) } catch (err) { console.error('simweb: reinstall failed: ' + err.message) }
      }
      reinstallAfterBoot = false
      for (const msg of fw.queue.splice(0)) ws.send(msg)
    })
    ws.on('message', d => {
      const head = d.subarray(0, 200).toString()
      if (head.includes('ScreenShot')) {
        const waiter = shotWaiters.shift()
        try { waiter?.resolve(Buffer.from(JSON.parse(d.toString()).file, 'base64')) } catch (err) { waiter?.reject(err) }
      } else console.log('simweb: firmware says ' + head)
    })
    ws.on('error', () => {})
    ws.on('close', () => {
      fw.ws = null
      setTimeout(connectFirmware, 2000)
    })
  }
  connectFirmware()
  function fwSend (msg) {
    if (fw.ws) fw.ws.send(msg)
    else fw.queue.push(msg)
  }

  function appInfo () {
    const app = bridge.app
    if (!app) return null
    const has = rel => fs.existsSync(path.join(app.dir, rel))
    return { rev: app.rev, appId: app.json.app.appId, name: app.json.app.appName, side: has('app-side/app-side.js'), settings: has('app-side/setting.js') }
  }

  // Unpack what the side service and settings app read: device app.json + app-side/.
  function unpackApp (outer, appJson) {
    const dir = path.join(runDir, 'app')
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(path.join(dir, 'data', 'temp'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'data', 'download'), { recursive: true })
    if (outer['app-side.zip']) {
      for (const [name, buf] of Object.entries(unzipSync(outer['app-side.zip']))) {
        if (name.endsWith('/')) continue
        const file = path.join(dir, 'app-side', name)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, buf)
      }
    }
    bridge.setApp({ dir, json: appJson, rev: (bridge.app?.rev || 0) + 1 })
    emit({ type: 'app', app: appInfo() })
  }

  // zeus dev → socket.io 'message' with JSON-RPC ide.simulator.preview; params.data is the
  // .zab-like zip (device.zip + app-side.zip) as a plain number array.
  function install (params) {
    const outer = unzipSync(Uint8Array.from(params.data))
    const deviceZip = outer['device.zip']
    if (!deviceZip) throw new Error('package has no device.zip')
    // the watch's build as installed, for reading a stack trace's line numbers (runDir/device/)
    try {
      const out = path.join(runDir, 'device')
      fs.rmSync(out, { recursive: true, force: true })
      for (const [name, buf] of Object.entries(unzipSync(deviceZip))) {
        if (name.endsWith('/')) continue
        fs.mkdirSync(path.dirname(path.join(out, name)), { recursive: true })
        fs.writeFileSync(path.join(out, name), buf)
      }
    } catch {}
    const appJson = unzipSync(deviceZip, { filter: f => f.name === 'app.json' })['app.json']
    const json = appJson ? JSON.parse(strFromU8(appJson)) : { app: {} }
    const app = json.app
    const appIdHex = Number(app.appId || params.appid).toString(16).toUpperCase().padStart(8, '0')
    const head = Buffer.from(`{"method":"Project","type":"install","appid":"${appIdHex}","length":${deviceZip.length},"file":"`)
    fwSend(Buffer.concat([head, Buffer.from(deviceZip), Buffer.from('"}')]))
    fwSend(JSON.stringify({ method: app.appType === 'watchface' ? 'ChangeWatchFace' : 'OpenProject', appid: appIdHex }))
    unpackApp(outer, json)
    logEntry({ src: 'all', sep: `installed ${app.appName || params.projectName}`, appId: appIdHex })
    console.log(`simweb: installed ${params.projectName} (${appIdHex}, ${deviceZip.length} B)`)
  }

  const io = new IoServer(server, { cors: { origin: '*' }, maxHttpBufferSize: 1e9, destroyUpgrade: false })
  io.on('connection', socket => {
    console.log('simweb: zeus connected')
    socket.on('message', data => {
      const req = JSON.parse(data)
      let result
      try {
        install(req.params)
        lastInstall = req.params
        result = { success: true }
      } catch (err) {
        console.error('simweb: install failed: ' + err.message)
        result = { success: false, error: err.message }
      }
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }))
    })
  })

  server.on('upgrade', (req, sock, head) => {
    const { pathname } = new URL(req.url, 'http://x')
    if (pathname.startsWith('/socket.io/')) return // socket.io handles its own upgrades
    if (pathname === '/bridge') {
      const role = new URL(req.url, 'http://x').searchParams.get('role')
      bridgeWss.handleUpgrade(req, sock, head, ws => bridge.connect(role === 'side' ? 'side' : 'settings', ws))
      return
    }
    const wss = pathname === '/vnc' ? vncWss : pathname === '/serial' ? serialWss : pathname === '/events' ? eventsWss : null
    if (!wss) { sock.destroy(); return }
    wss.handleUpgrade(req, sock, head, ws => wss.emit('connection', ws, req))
  })

  server.on('error', err => {
    rebooting = false
    proc.kill('SIGKILL')
    cleanup()
    if (err.code === 'EADDRINUSE') die(`port ${PORT} is busy (Zepp Simulator still open?). Quit it or pass --port <n>`)
    throw err
  })
  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://localhost:${PORT}`
    console.log(`simweb: ${url}`)
    if (!args['no-open']) openWindow(url)
  })
}

main()
