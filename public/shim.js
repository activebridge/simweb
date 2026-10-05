// Injected ahead of Zepp's hosted side-service / app-settings bundles. Recreates the
// window bridge objects the Electron preloads define (preload/side-service-preload.js,
// preload/setting-preload.js) and carries them over one websocket to the helper.
(function () {
  var role = document.currentScript.dataset.role
  var queue = []
  var ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/bridge?role=' + role)
  ws.onopen = function () { queue.splice(0).forEach(function (f) { ws.send(f) }) }
  function post (ch, msg) {
    var frame = JSON.stringify({ ch: ch, msg: msg })
    if (ws.readyState === 1) ws.send(frame)
    else queue.push(frame)
  }
  function channel (postMessage) {
    return { onError: function () {}, onMessage: function () {}, postMessage: postMessage }
  }

  // Mirror console output into simweb's console pane.
  ;['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    var orig = console[level]
    console[level] = function () {
      orig.apply(console, arguments)
      try {
        post('CONSOLE', level.toUpperCase() + ' ' + Array.prototype.map.call(arguments, function (a) {
          return typeof a === 'string' ? a : JSON.stringify(a)
        }).join(' '))
      } catch (e) {}
    }
  })

  // The side framework runs the app's app-side code in a Web Worker, whose console the
  // mirror above can't see. Give every classic worker a prelude that forwards its console
  // over a BroadcastChannel (separate from the framework's own worker messages).
  if (role === 'side' && window.Worker && window.BroadcastChannel) {
    var bc = new BroadcastChannel('simweb-console')
    bc.onmessage = function (e) { post('CONSOLE', e.data) }
    var NativeWorker = window.Worker
    var prelude = '(function(){var bc=new BroadcastChannel("simweb-console");["log","info","warn","error","debug"].forEach(function(l){var o=console[l];console[l]=function(){o.apply(console,arguments);try{bc.postMessage(l.toUpperCase()+" "+Array.prototype.map.call(arguments,function(a){return typeof a==="string"?a:JSON.stringify(a)}).join(" "))}catch(e){}}})})();'
    window.Worker = function (url, opts) {
      if (opts && opts.type === 'module') return new NativeWorker(url, opts)
      var src = new URL(url, location.href).href
      var blob = new Blob([prelude + 'importScripts(' + JSON.stringify(src) + ');'], { type: 'text/javascript' })
      return new NativeWorker(URL.createObjectURL(blob), opts)
    }
    window.Worker.prototype = NativeWorker.prototype
  }

  if (role === 'settings') {
    window.RPC = channel(function (arg) { post('STREAM', JSON.parse(arg)) })
    window.LOG = channel(function (arg) { post('LOG', JSON.parse(arg)) })
    window.DATA = channel(function (arg) { post('DATA', JSON.parse(arg)) })
    ws.onmessage = function (e) {
      var f = JSON.parse(e.data)
      if (f.ch === 'STREAM') window.RPC.onMessage(JSON.stringify(f.msg))
      else if (f.ch === 'DATA') window.DATA.onMessage(JSON.stringify(f.msg))
    }
    return
  }

  var dev = '1000:1000'
  window[dev + '.BLE'] = channel(function (hex) { post('BLE', hex) })
  window[dev + '.LOG'] = channel(function (arg) { post('LOG', JSON.parse(arg)) })
  window[dev + '.RPC'] = channel(function (arg) { post('STREAM', JSON.parse(arg)) })
  window[dev + '.DATA'] = channel(function (arg) { post('DATA', JSON.parse(arg)) })
  window['0:0.RPC'] = channel(function (arg) { post('GATEWAY', JSON.parse(arg)) })
  window['0:0.LOG'] = channel(function (arg) { post('GATEWAY_LOG', JSON.parse(arg)) })
  window['0:1.RPC'] = channel(function (arg) { post('GATEWAY', JSON.parse(arg)) })
  window['0:2.RPC'] = channel(function () {})
  window.ZEPP_ENV = { is_simulator: 1 }

  function bleEvent (type) {
    post('STREAM', {
      jsonrpc: 'hmV1.0',
      method: { module: 'message.notification.system', action: 'eventHappened' },
      params: { type: type, target: 'device' },
    })
  }
  ws.onmessage = function (e) {
    var f = JSON.parse(e.data)
    if (f.ch === 'STREAM') window[dev + '.RPC'].onMessage(f.msg)
    else if (f.ch === 'DATA') window[dev + '.DATA'].onMessage(f.msg)
    else if (f.ch === 'GATEWAY') window['0:0.RPC'].onMessage(f.msg)
    else if (f.ch === 'BLE') window[dev + '.BLE'].onMessage(f.msg)
    else if (f.ch === 'BLE_OPEN') bleEvent('bleConnected')
    else if (f.ch === 'BLE_CLOSE') bleEvent('bleDisconnected')
  }
})()
