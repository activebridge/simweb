// Port of the Electron simulator's main-process router (process/ipc.js + process/module/*).
// Zepp's hosted side-service and app-settings pages talk to it through window bridge
// objects that public/shim.js defines; here we route their JSON-RPC between each other,
// storage, the network and the watch.
import fs from 'node:fs'
import path from 'node:path'
import WebSocket from 'ws'

const JSONRPC = 'hmV1.0'
const PERMISSION_LIST = [
  'access_activity', 'access_aod', 'access_app_cluster_storage', 'access_calendars',
  'access_exercise', 'access_heart_rate', 'access_internet', 'access_location',
  'run_background', 'access_sleep', 'access_user_profile',
]
const DEVICE = {
  deviceId: '1000',
  mac: '11:11:11:11:11:11',
  deviceSource: 'test',
  deviceType: 1,
  channelGroupId: '1000:1000',
  sideServiceId: 1000,
}

// Watch <-> side BLE frames, decoded for the App-side log. Outer frame (16 B, Zepp):
// flag u8, version u8, type u16 (1 shake, 2 close, 4/5 data), ports, appId, extra.
// Body: the amazla MessageBuilder header (0x5a, flags, id u16, seq u8) when present,
// else Zepp's template builder, whose JSON we just find after its binary header.
function frameDecoder () {
  const sessions = new Map()
  return (dir, buf) => {
    if (buf.length < 16 || buf[0] !== 1) return { dir, kind: 'data', size: buf.length, body: null }
    const type = buf.readUInt16LE(2)
    if (type === 1) return { dir, kind: 'shake' }
    if (type === 2) return { dir, kind: 'close' }
    const body = buf.subarray(16)
    if (body.length >= 5 && body[0] === 0x5a) {
      const flags = body[1]
      const kind = flags & 3
      const id = body.readUInt16LE(2)
      const seq = body[4]
      const part = body.subarray(5)
      let payload = part
      if (seq !== 0 || !(flags & 4)) {
        const key = `${dir}${id}:${kind}`
        const chunks = seq === 0 ? [] : sessions.get(key) || []
        chunks.push(part)
        if (!(flags & 4)) { sessions.set(key, chunks); return null }
        sessions.delete(key)
        payload = Buffer.concat(chunks)
      }
      return { dir, kind: ['data', 'request', 'response', 'notify'][kind], id, size: payload.length, body: flags & 8 ? null : payload.toString('utf8') }
    }
    const text = body.toString('utf8')
    const at = text.search(/[{[]/)
    return { dir, kind: 'data', size: body.length, body: at >= 0 ? text.slice(at) : null }
  }
}

const result = (id, res) => ({ jsonrpc: JSONRPC, id: `${id}`, result: res })
const error = (id, code, message) => ({ jsonrpc: JSONRPC, ...(id !== undefined && { id: `${id}` }), error: { code, message } })
const notify = (method, params) => ({ jsonrpc: JSONRPC, method, params })

// electron-store equivalent: one JSON file, app_<id>.SETTINGS / .LOCAL, live_<dev>_<id>.
class Store {
  constructor (file) {
    this.file = file
    try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { this.data = {} }
  }
  bucket (a, b) {
    this.data[a] ??= {}
    if (b) this.data[a][b] ??= {}
    return b ? this.data[a][b] : this.data[a]
  }
  save () {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.data))
  }
}

// Phone-side faults on demand (the Zepp simulator can't do any of these):
//   link     false: the BLE link to the watch is down
//   network  'online' | 'slow' (+2 s) | 'failing' (HTTP 500) | 'offline' for the side service's fetch
//   latency  ms added to every watch <-> phone frame
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export function createBridge ({ storeFile, fwUrl, log, onOpenSettings, onSide }) {
  const chaos = { link: true, network: 'online', latency: 0 }
  let sideKilled = false
  let sideBound = false // the side page's framework has answered our bind
  const store = new Store(storeFile)
  const peers = { side: null, settings: null } // bridge websockets per page
  let app = null // { appId, dir, json } of the installed app
  let gateway = null // pending JSON-RPC calls to the side page's 0:0 gateway

  function send (role, ch, msg) {
    const ws = peers[role]
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ ch, msg }))
  }
  const toSide = msg => send('side', 'STREAM', msg)
  const toSettings = msg => send('settings', 'STREAM', msg)

  function readAppFile (rel) {
    if (!app) throw new Error('no app installed')
    return fs.readFileSync(path.join(app.dir, rel))
  }

  // ---- storage (process/module/storage.js) ----
  function settingsStorage (from, action, data) {
    const reply = from === 'worker' ? toSide : toSettings
    try {
      const { appId, key, newValue } = data.params || {}
      const bucket = store.bucket(`app_${appId}`, 'SETTINGS')
      switch (action) {
        case 'getSettingsStorage':
          reply(result(data.id, bucket))
          return
        case 'setSettingsStorage': bucket[key] = newValue; break
        case 'removeSettingsStorage': delete bucket[key]; break
        case 'clearSettingsStorage': delete store.data[`app_${appId}`].SETTINGS; break
      }
      store.save()
      if (from === 'worker') toSettings(notify({ module: 'message.notification.settingsStorage', action: 'settingsChanged' }, data.params))
      else toSide(notify({ module: 'message.notification.launch', action: 'settingsChanged' }, data.params))
      reply(result(data.id, 'success'))
    } catch (err) {
      reply(error(undefined, -1, err.message))
    }
  }

  function keyedStorage (prefix, kind, action, data) {
    try {
      const { key, newValue } = data.params
      const bucket = kind ? store.bucket(prefix, kind) : store.bucket(prefix)
      let res = 'success'
      const verb = action.replace(/(Local|Live)Storage$/, '')
      if (verb === 'get') res = bucket
      else if (verb === 'set') bucket[key] = newValue
      else if (verb === 'remove') delete bucket[key]
      else if (verb === 'clear') { if (kind) delete store.data[prefix][kind]; else delete store.data[prefix] }
      else return
      store.save()
      toSide(result(data.id, res))
    } catch (err) {
      toSide(error(undefined, -1, err.message))
    }
  }

  // ---- network (process/module/network.js): side service fetch, no CORS here ----
  async function network (data, reply) {
    const { url, _v = 'v1', ...options } = data.params
    if (_v === 'v2' && options.body) options.body = Buffer.from(options.body, 'hex')
    if (chaos.network === 'offline') {
      log({ src: 'side', line: `WARN network offline (simweb): ${url}` })
      reply(error(data.id, 0, 'Network request failed'))
      return
    }
    if (chaos.network === 'failing') {
      log({ src: 'side', line: `WARN network failing (simweb): ${url} → 500` })
      reply(result(data.id, { headers: {}, status: 500, statusText: 'Internal Server Error', body: _v === 'v2' ? '' : 'simweb: simulated failure', _v }))
      return
    }
    if (chaos.network === 'slow') await sleep(2000)
    try {
      const res = await fetch(url, options)
      const headers = {}
      res.headers.forEach((v, k) => { headers[k] ??= v })
      const body = _v === 'v2' ? Buffer.from(await res.arrayBuffer()).toString('hex') : await res.text()
      reply(result(data.id, { headers, status: res.status, statusText: res.statusText, body, _v }))
    } catch (err) {
      log({ src: 'side', line: `ERROR network ${url}: ${err.message}` })
      reply(error(data.id, 0, err.message))
    }
  }

  // ---- files (process/module/common.js) ----
  function resolveAppPath (url) {
    if (url.startsWith('app-side://')) return path.join(app.dir, 'app-side', url.slice(11))
    return path.join(app.dir, 'data', url.startsWith('data://') ? url.slice(7) : url)
  }

  function filesystem (role, action, data) {
    const reply = msg => send(role, 'STREAM', msg)
    try {
      const { filePath, encoding = 'hex' } = data.params
      const file = resolveAppPath(filePath)
      if (action === 'readFile') {
        reply(result(data.id, { data: { value: fs.readFileSync(file).toString(encoding), encoding, type: 'bin' } }))
      } else if (action === 'writeFile') {
        const d = data.params.data
        if (d.type !== 'bin') throw new Error('data is not binary')
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, Buffer.from(d.value, d.encoding ?? 'hex'))
        reply(result(data.id, {}))
      }
    } catch (err) {
      reply(error(data.id, -9000, err.message))
    }
  }

  // ---- STREAM router (process/ipc.js) ----
  function stream (role, data) {
    if (!data?.method?.module || !data.method.action) return
    const [top, module, sub] = data.method.module.split('.')
    const action = data.method.action
    const reply = msg => send(role, 'STREAM', msg)
    switch (top) {
      case 'appSettings':
        if (sub === 'code') reply(result(data.id, { content: readAppFile('app-side/setting.js').toString('utf8') }))
        else if (sub === 'settingsStorage') settingsStorage('appSettings', action, data)
        else if (sub === 'userSettings') reply(result(data.id, { lang: 'en-US' }))
        else if (sub === 'system') reply(result(data.id, {}))
        else if (sub === 'auth') onOpenSettings({ auth: data.params?.targetUrl })
        break
      case 'worker':
        if (sub === 'settingsStorage') settingsStorage('worker', action, data)
        else if (sub === 'localStorage') keyedStorage(`app_${data.params.appId}`, 'LOCAL', action, data)
        else if (sub === 'liveStorage') keyedStorage(`live_${data.params.devId}_${data.params.liveStorageId}`, null, action, data)
        else if (sub === 'network') network(data, toSide)
        break
      case 'main':
        if (sub === 'code') toSide(result(data.id, { content: readAppFile('app-side/app-side.js').toString('utf8') }))
        else if (sub === 'permission') {
          const granted = app?.json.permissions || []
          toSide(result(data.id, Object.fromEntries(PERMISSION_LIST.filter(p => granted.includes(p)).map(p => [p, true]))))
        }
        break
      case 'app':
        if (module === 'internal') {
          if (sub === 'network') network(data, reply)
          else if (sub === 'user') reply(result(data.id, {}))
          else if (sub === 'devices' && action === 'getAll') reply(result(data.id, { list: [{ ...DEVICE, deviceId: '1212', startTime: Date.now() }] }))
        } else if (module === 'sapp' && sub === 'page') {
          onOpenSettings({ url: data.params?.runtime?.type === 'web' ? data.params.path : null })
        }
        break
      case 'common':
        if (module !== 'system') break
        if (sub === 'data') {
          const to = data.params?.to?.appType
          if (to === 'side') toSide(data)
          else if (to === 'sapp') toSettings(data)
        } else if (sub === 'file' && action === 'read' && data.params.type === 'side') {
          toSide(result(data.id, { data: { value: readAppFile(path.join('app-side', data.params.fileName)).toString('hex'), type: 'bin' } }))
        } else if (sub === 'filesystem') filesystem(role, action, data)
        break
      case 'message':
        if (module === 'notification') toSide(data)
        break
    }
  }

  // ---- gateway: bind the side service to our one fake device (process/side-service.js) ----
  // One bind loop at a time: a second side page (another tab) starts a new one, and the old
  // loop must stop — its replies go to the replaced gateway, so it would never see "bound"
  // and keep re-binding, and every bind restarts the side app (losing the watch's port).
  let bindGen = 0
  function bindSideService () {
    const gen = ++bindGen
    const pending = new Map()
    let bound = false
    let seq = 0
    gateway = {
      onMessage (msg) {
        if (msg.id && (msg.result !== undefined || msg.error)) {
          const cb = pending.get(msg.id)
          pending.delete(msg.id)
          cb?.(msg)
          return
        }
        if (msg.id && msg.method) {
          const key = `${msg.method.module}.${msg.method.action}`.toLowerCase()
          if (key === 'app.internal.devices.getall') send('side', 'GATEWAY', result(msg.id, { list: [{ ...DEVICE, startTime: Date.now() }] }))
          else send('side', 'GATEWAY', error(msg.id, -1, 'No method support'))
        }
      },
    }
    const tryBind = () => {
      if (bound || gen !== bindGen || !peers.side) return
      const id = `simweb-${++seq}`
      pending.set(id, msg => {
        if (!msg.error) { bound = true; sideBound = true; log({ src: 'side', line: 'INFO side service bound', sys: true }); flushHeld() }
      })
      send('side', 'GATEWAY', {
        jsonrpc: JSONRPC,
        id,
        method: { module: 'app.internal.sideServices', action: 'bind' },
        params: { deviceId: 1000, sideServiceId: 1000, channelGroupId: '1000:1000' },
      })
      setTimeout(tryBind, 2000)
    }
    tryBind()
  }

  // ---- the phone's BLE link: the firmware socket with subprotocol HMSDK, hex frames ----
  // It belongs to the bridge, not the side page — on a phone the Zepp app owns the link and
  // outlives the side service. While the side service is killed, a watch Shake respawns it
  // (the frame is held and delivered once it's up) and anything else gets a Close back, as
  // the Zepp app answers a dead port.
  const decode = frameDecoder()
  const logFrame = (dir, buf, note) => {
    const msg = decode(dir, buf)
    if (msg) log({ src: 'side', msg: note ? { ...msg, note } : msg })
  }
  let ble = null
  let held = [] // watch frames waiting for a respawned side service
  function openLink () {
    if (ble || !chaos.link) return
    const ws = new WebSocket(fwUrl(), 'HMSDK')
    ble = ws
    ws.binaryType = 'nodebuffer'
    ws.on('open', () => { if (ble === ws) send('side', 'BLE_OPEN', null) })
    ws.on('message', d => {
      const buf = Buffer.from(d)
      setTimeout(() => fromWatch(buf), chaos.latency)
    })
    ws.on('close', () => {
      if (ble !== ws) return
      ble = null
      send('side', 'BLE_CLOSE', null)
      if (chaos.link) setTimeout(openLink, 2000) // firmware restarting: keep trying
    })
    ws.on('error', () => {})
  }
  function closeLink () {
    const ws = ble
    ble = null
    ws?.close()
    send('side', 'BLE_CLOSE', null)
  }
  function fromWatch (buf) {
    if (!sideKilled && !sideBound) {
      // Side page (re)loading — after an install the watch app shakes right away, before
      // the new page can take it. Hold until bound, or the watch never learns the port.
      held.push(buf)
      if (held.length > 50) held.shift()
      return
    }
    if (!sideKilled) {
      logFrame('in', buf)
      send('side', 'BLE', buf.toString('hex'))
      return
    }
    const type = buf.length >= 4 && buf[0] === 1 ? buf.readUInt16LE(2) : 0
    if (type === 1) {
      logFrame('in', buf, 'respawns the side service')
      held.push(buf)
      startSide()
    } else if (type === 4 || type === 5) {
      logFrame('in', buf, 'side service is dead')
      const close = Buffer.concat([buf.subarray(0, 16), Buffer.from([0])])
      close.writeUInt16LE(2, 2)
      logFrame('out', close, 'Zepp app answers a dead port')
      if (ble?.readyState === 1) ble.send(close)
    }
  }
  // Frames that respawned the side service, delivered once it is bound.
  function flushHeld () {
    const pending = held
    held = []
    for (const buf of pending) { logFrame('in', buf); send('side', 'BLE', buf.toString('hex')) }
  }
  function toWatch (buf) {
    if (!ble || ble.readyState !== 1) { logFrame('out', buf, 'dropped: link down'); return }
    setTimeout(() => { logFrame('out', buf); ble?.readyState === 1 && ble.send(buf) }, chaos.latency)
  }
  function killSide () {
    if (sideKilled) return
    sideKilled = true
    log({ src: 'side', sep: 'side service killed' })
    onSide('kill')
    peers.side?.close()
  }
  function startSide () {
    if (!sideKilled) return
    sideKilled = false
    onSide('start')
  }
  function setChaos (next) {
    const wasUp = chaos.link
    Object.assign(chaos, next)
    if (wasUp && !chaos.link) { log({ src: 'side', sep: 'phone link down' }); closeLink() }
    if (!wasUp && chaos.link) { log({ src: 'side', sep: 'phone link up' }); openLink() }
  }

  // ---- page connections ----
  function connect (role, ws) {
    peers[role]?.close()
    peers[role] = ws
    if (role === 'settings') log({ src: 'settings', sep: 'settings opened' })
    if (role === 'side') {
      sideKilled = false // any fresh side page (install, reload, respawn) is alive
      sideBound = false
      log({ src: 'side', sep: 'side service started' })
      openLink()
      if (ble?.readyState === 1) send('side', 'BLE_OPEN', null)
      bindSideService()
    }
    ws.on('message', raw => {
      let frame
      try { frame = JSON.parse(raw) } catch { return }
      const { ch, msg } = frame
      try {
        if (ch === 'STREAM') stream(role === 'side' ? 'side' : 'settings', msg)
        else if (ch === 'DATA') send(role === 'side' ? 'settings' : 'side', 'DATA', msg)
        else if (ch === 'GATEWAY') gateway?.onMessage(msg)
        else if (ch === 'BLE') toWatch(Buffer.from(msg, 'hex'))
        // LOG / GATEWAY_LOG repeat what the pages already print; Electron mutes them too.
        else if (ch === 'CONSOLE') log({ src: role, line: msg })
      } catch (err) {
        log({ src: role, line: `ERROR bridge: ${err.message}` })
      }
    })
    ws.on('close', () => {
      if (peers[role] !== ws) return
      peers[role] = null
      if (role === 'side') sideBound = false
    })
  }

  return {
    connect,
    setChaos,
    killSide,
    startSide,
    get chaos () { return { ...chaos, sideKilled } },
    setApp (next) { app = next },
    get app () { return app },
  }
}
