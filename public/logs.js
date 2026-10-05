// Log pane: parses watch serial, side-service and settings output into rows of
// time · level · tag · message. App lines show by default; firmware and framework lines
// are "system" and show with the ⚙ toggle. Decoded watch↔phone messages and install /
// restart separators come from the helper as structured entries.

const ANSI = /\x1b\[[0-9;]*m/g
const LEVELS = {
  E: { name: 'ERR', glyph: '✖' },
  W: { name: 'WARN', glyph: '▲' },
  I: { name: 'INFO', glyph: 'ℹ' },
  L: { name: 'LOG', glyph: '●' },
  D: { name: 'DEBUG', glyph: '◦' },
}
const FW_LEVEL = { E: 'E', W: 'W', I: 'I', D: 'D', V: 'D' }
const JSFWK_LEVEL = { error: 'E', warn: 'W', info: 'I', log: 'L', debug: 'D' }
const CONSOLE_LEVEL = { ERROR: 'E', WARN: 'W', INFO: 'I', LOG: 'L', DEBUG: 'D' }

// "10/5 [0]16:34:52.100 I/quickjs-libc SBEngine: msg"
const FW_LINE = /^\d+\/\d+ \[\d+\](\d\d:\d\d:\d\d\.\d{3}) ([DVIWE])\/(\S+) (\S+?):\s?(.*)$/
// "[Scope] [2026-10-05T16:34:52.097Z] [jsfwk.log  ] [name] [-] msg"
const JSFWK = /^\[([^\]]+)\] \[(\d{4}-\d\d-\d\dT[\d:.]+Z)\] \[jsfwk\.(\w+)\s*\] \[([^\]]+)\] \[[^\]]*\] ?(.*)$/
// Side framework loggers. The app-side worker's scope (w-proc-…) is shared with the app's own
// loggers, so there only these framework logger names count as system.
const FRAMEWORK_SCOPE = /^(gateway|side|settings|app-settings|device)-\d|^worker(-sdk)?$|^m-proc-/
const FRAMEWORK_NAME = /^(app-channel|worker-channel|worker$|messaging-socket|process$|network$|schedule|boot|registry-service|ping-service|monitor-service|device-service)/
const FRAMEWORK_CONSOLE = /^(app-side-service start|main start|settings run ok)$/
// Framework chatter that reaches the watch's app channel (from Zepp's own console filter).
const WATCH_NOISE = /^current filepath:|framework|^----->>>current|on (init|create) invoke$|newCtx\{|ctx\{.*\}\.apply=|^\[object Object\]$|^\d+$|^\[jsrt-|\$\$localstorage\$\$/
const JS_ERROR = /^(Mini Program Error|(?:Type|Reference|Syntax|Range|Internal)?Error:|Uncaught)/
const STACK = /^\s*(at |error stack)/

function utcClock (hms) {
  // Firmware clock and jsfwk ISO stamps are UTC; show local wall time.
  const d = new Date()
  const [h, m, rest] = hms.split(':')
  d.setUTCHours(+h, +m, Math.floor(+rest), Math.round((+rest % 1) * 1000))
  return d
}
const fmtTime = d => d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0')

export function parse (entry) {
  const base = { src: entry.src, time: new Date(entry.t) }
  if (entry.sep) return { ...base, type: 'sep', text: entry.sep, appHex: entry.appId }
  if (entry.msg) return { ...base, type: 'msg', msg: entry.msg, level: 'L', sys: entry.msg.kind === 'shake' || entry.msg.kind === 'close' }
  const raw = String(entry.line).replace(ANSI, '').replace(/\s+$/, '')
  if (!raw) return null
  return entry.src === 'watch' ? parseWatch(raw, base) : parsePage(raw, base, entry.sys)
}

function parseWatch (raw, base) {
  const m = FW_LINE.exec(raw)
  if (!m) {
    if (JS_ERROR.test(raw)) return { ...base, type: 'line', level: 'E', tag: 'js', text: raw, sys: false }
    if (STACK.test(raw)) return { ...base, type: 'stack', text: raw.trim() }
    return { ...base, type: 'line', level: 'I', tag: 'fw', text: raw, sys: true }
  }
  const [, hms, lvl, tag, , msg] = m
  const time = utcClock(hms)
  const app = JSFWK.exec(msg)
  if (app && tag === 'quickjs-libc') {
    const [, scope, , level, name, text] = app
    return { ...base, time, type: 'line', level: JSFWK_LEVEL[level] || 'L', tag: name, text, sys: FRAMEWORK_SCOPE.test(scope) || WATCH_NOISE.test(name + ' ' + text) }
  }
  if (JS_ERROR.test(msg)) return { ...base, time, type: 'line', level: 'E', tag: 'js', text: msg, sys: false }
  if (STACK.test(msg)) return { ...base, time, type: 'stack', text: msg.trim() }
  // Plain console.log on the watch lands as quickjs-libc without the jsfwk wrapper.
  const appLog = tag === 'quickjs-libc' && !WATCH_NOISE.test(msg)
  return { ...base, time, type: 'line', level: FW_LEVEL[lvl] || 'I', tag: appLog ? 'console' : tag, text: msg, sys: !appLog }
}

function parsePage (raw, base, sys) {
  const c = /^(ERROR|WARN|INFO|LOG|DEBUG) ([\s\S]*)$/.exec(raw)
  let level = c ? CONSOLE_LEVEL[c[1]] : 'L'
  let text = c ? c[2] : raw
  const fw = /^\[([^\]]+)\] \[(\d{4}-[^\]]+)\] \[jsfwk\.(\w+)\s*\] \[([^\]]+)\] \[[^\]]*\] ?([\s\S]*)$/.exec(text)
  if (fw) {
    const [, scope, , lvl, name, msg] = fw  // its "Z" stamp is really local time; use arrival
    level = JSFWK_LEVEL[lvl] || level
    const framework = FRAMEWORK_SCOPE.test(scope) || FRAMEWORK_NAME.test(name)
    const lifecycle = /^App LifeCycle Status: ([^.]+)/.exec(msg)
    if (lifecycle) return { ...base, type: 'line', level: 'I', tag: 'lifecycle', text: '♻ ' + lifecycle[1], sys: false }
    // [RAW] frames are decoded by the helper and shown as messages instead.
    return { ...base, type: 'line', level, tag: name, text: msg, sys: framework || /^\[RAW\]/.test(msg) }
  }
  if (JS_ERROR.test(text)) level = 'E'
  return { ...base, type: 'line', level, tag: base.src === 'side' ? 'app-side' : 'settings', text, sys: !!sys || FRAMEWORK_CONSOLE.test(text) }
}

// ---- watch insights: app/page load cost, permissions, heap ----
// From firmware lines the default view hides:
//   js_runtime  "malloc_size:N before|after load app|page"
//   jsRtApkMng  "js_rt_loadApp2: file: /storage/data/js_apps/<HEX>/app.js", "[js_rt_loadApp2] api-level: 200",
//               "js_rt_loadContiner2: file: /storage/data/js_apps/<HEX>/page/home/index.page.js"
//   quickjs     "js_trigger_gc *****rt->malloc_gc_threshold is now T, malloc_size N"
//   js_manager_event "appid:0x<HEX>, Permission[i]:data:os.device.info"
export class Insights {
  constructor () {
    this.names = {} // app hex -> name, from install separators
    this.heap = 0
    this.peak = 0
    this.threshold = 0
    this.history = [] // heap samples for the sparkline
    this.pending = {} // 'app' | 'page' -> { size, time }
    this.app = null // { hex, system, api }
    this.page = null
    this.perms = null // { hex, list, time }
  }
  sample (n) {
    this.heap = n
    this.peak = Math.max(this.peak, n)
    this.history.push(n)
    if (this.history.length > 240) this.history.shift()
  }
  // Returns rows to insert before `row` (flushed permissions) and after it (load results).
  feed (row) {
    const out = []
    if (row.type === 'sep' && row.appHex) this.names[row.appHex] = row.text.replace(/^installed /, '')
    if (row.type !== 'line' || row.src !== 'watch') return out
    const t = row.text
    let m
    if ((m = /^appid:0x([0-9A-F]+), Permission\[\d+\]:(.*)$/.exec(t))) {
      if (!this.perms || this.perms.hex !== m[1]) { this.flushPerms(out); this.perms = { hex: m[1], list: [], time: row.time } }
      this.perms.list.push(m[2])
      return out
    }
    this.flushPerms(out)
    if ((m = /^malloc_size:(\d+) (before|after) load (app|page)$/.exec(t))) {
      const size = +m[1]
      const what = m[3]
      this.sample(size)
      if (m[2] === 'before') { this.pending[what] = { size, time: row.time }; return out }
      const start = this.pending[what]
      delete this.pending[what]
      if (!start) return out
      const ctx = what === 'app' ? this.app : this.page
      out.push({
        src: 'watch', time: row.time, type: 'insight', kind: what, level: 'I',
        name: what === 'app' ? (ctx && (this.names[ctx.hex] || ctx.name)) || 'app' : (ctx && ctx.name) || 'page',
        api: what === 'app' && ctx ? ctx.api : null,
        delta: size - start.size, heap: size, ms: row.time - start.time,
        sys: !ctx || ctx.system,
      })
      out[out.length - 1].text = out[out.length - 1].name
      return out
    }
    if ((m = /malloc_gc_threshold is now (\d+), malloc_size (\d+)/.exec(t))) {
      this.threshold = +m[1]
      this.sample(+m[2])
      return out
    }
    // Older firmware: "js_rt_loadApp2: file: <path>"; newer: "[js_rt_loadApp2] path: <path>".
    if ((m = /^\[?js_rt_loadApp2\]?:? (?:file|path): (\S+)/.exec(t))) {
      const hex = (/js_(?:apps|watchfaces)\/([0-9A-F]+)\//.exec(m[1]) || [])[1]
      this.app = { hex, system: !/\/storage\/data\/js_apps\//.test(m[1]), name: /js_watchfaces/.test(m[1]) ? 'watchface' : hex, api: null }
      return out
    }
    if ((m = /api-level: (\d+)/.exec(t)) && this.app) { this.app.api = (+m[1] / 100).toFixed(1); return out }
    if ((m = /^\[?js_rt_loadContiner2\]?:? (?:file|path): \S*?js_(?:apps|watchfaces)\/[0-9A-F]+\/(\S+)$/.exec(t))) {
      this.page = { name: m[1].replace(/\/index\.page\.(js|bin)$|(\.page)?\.(js|bin)$/, ''), system: this.app ? this.app.system : true }
    }
    return out
  }
  flushPerms (out) {
    if (!this.perms) return
    const p = this.perms
    this.perms = null
    out.push({ src: 'watch', time: p.time, type: 'perms', level: 'I', name: this.names[p.hex] || p.hex, list: p.list, text: p.list.join(' '), sys: false })
  }
}

const kb = n => (n >= 0 ? '+' : '−') + Math.round(Math.abs(n) / 1024) + ' KB'
export const mb = n => (n / 1048576).toFixed(2) + ' MB'

// ---- rendering ----

const TAG_HUES = [200, 160, 280, 30, 330, 100, 240, 50]
function tagHue (tag) {
  let h = 0
  for (const ch of tag) h = (h * 31 + ch.charCodeAt(0)) | 0
  return TAG_HUES[Math.abs(h) % TAG_HUES.length]
}

function el (tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

function pretty (text) {
  try { return JSON.stringify(JSON.parse(text), null, 2) } catch { return null }
}

// Long text and JSON render one line, click to expand.
function body (text) {
  const span = el('span', 'msg', text)
  const json = /^[{[]/.test(text.trim()) && pretty(text)
  if (json || text.length > 120 || text.includes('\n')) {
    span.classList.add('expandable')
    span.title = 'click to expand'
    span.onclick = () => {
      const open = span.classList.toggle('open')
      span.textContent = open ? (json || text) : text
    }
  }
  return span
}

const MSG_GLYPH = { request: '⇢', response: '⇠', notify: '✉', data: '⇄', shake: '🤝', close: '✂' }

export function render (row) {
  if (row.type === 'sep') {
    const icon = /^installed/.test(row.text) ? '📦' : /^booting/.test(row.text) ? '⌚' : /^settings/.test(row.text) ? '⚙️' : '🔌'
    return el('div', 'sep', `${icon} ${row.text} · ${fmtTime(row.time).slice(0, 8)}`)
  }
  const div = el('div', 'row' + (row.sys ? ' sys' : '') + ` lv-${row.level}`)
  div.append(el('span', 'time', fmtTime(row.time)))
  if (row.type === 'insight') {
    div.classList.add('insight')
    div.append(el('span', 'lvl', row.kind === 'app' ? '🧠 APP' : '📄 PAGE'))
    div.append(el('span', 'tag', row.name))
    const facts = el('span', 'msg facts')
    facts.append(el('b', row.delta > 150 * 1024 ? 'hot' : null, kb(row.delta)), ` · heap ${mb(row.heap)} · ${row.ms} ms`)
    if (row.api) facts.append(` · api ${row.api}`)
    div.append(facts)
    return div
  }
  if (row.type === 'perms') {
    div.classList.add('insight')
    div.append(el('span', 'lvl', '🔐 PERM'), el('span', 'tag', row.name))
    const pills = el('span', 'msg')
    for (const p of row.list) pills.append(el('span', 'pill', p.replace(/^(data|device):os\./, '')))
    div.append(pills)
    return div
  }
  if (row.type === 'msg') {
    const m = row.msg
    const toWatch = m.dir === 'out'
    div.classList.add('wire', toWatch ? 'to-watch' : 'from-watch')
    div.append(el('span', 'lvl', toWatch ? '→ ⌚' : '← ⌚'))
    div.append(el('span', 'tag', `${MSG_GLYPH[m.kind] || '⇄'} ${m.kind}${m.id != null ? ' #' + m.id : ''}`))
    if (m.body != null) div.append(body(m.body))
    else if (m.size != null) div.append(el('span', 'msg dim', `${m.size} B binary`))
    if (m.size != null && m.body != null) div.append(el('span', 'size', `${m.size} B`))
    if (m.note) div.append(el('span', 'note', '⚡ ' + m.note))
    return div
  }
  const lv = LEVELS[row.level] || LEVELS.L
  div.append(el('span', 'lvl', `${lv.glyph} ${lv.name}`))
  const tag = el('span', 'tag', row.sys ? '⚙ ' + row.tag : row.tag)
  if (!row.sys) tag.style.color = `hsl(${tagHue(row.tag)} 65% 68%)`
  div.append(tag, body(row.text))
  if (row.stack?.length) {
    const st = el('div', 'stack')
    for (const s of row.stack) st.append(el('div', null, s))
    div.append(st)
  }
  if (row.count > 1) div.append(el('span', 'count', '×' + row.count))
  return div
}

// ---- one log (per tab) ----

export class Log {
  constructor () {
    this.rows = []
  }
  // Returns { row, merged } — merged when it folded into the previous row (repeat/stack).
  add (row) {
    const last = this.rows[this.rows.length - 1]
    if (row.type === 'stack') {
      if (last && last.type === 'line') { (last.stack ||= []).push(row.text); return { row: last, merged: true } }
      row = { ...row, type: 'line', level: 'E', tag: 'js', sys: false }
    }
    if (last && last.type === 'line' && row.type === 'line' && last.text === row.text && last.tag === row.tag && last.level === row.level && !last.stack) {
      last.count = (last.count || 1) + 1
      last.time = row.time
      return { row: last, merged: true }
    }
    this.rows.push(row)
    if (this.rows.length > 5000) this.rows.shift()
    return { row, merged: false }
  }
}
