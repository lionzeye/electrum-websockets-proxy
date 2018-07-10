const { URL } = require('url')
const { Server } = require('ws')
const async = require('async')
const https = require('https')
const EventEmitter = require('events')
const net = require('net')
const tls = require('tls')
const os = require('os')

const Table = require('easy-table')

const defaults = require('../config')
const { $log, logger, uid, tplCompile } = require('./utils')

// Bans
const BAN_TIMEOUT = 5 * 6e4
const NEW_LINE = '\n'

/**
 * This class is used for an incoming websocket connection.
 * @class Peer
 * @extends {EventEmitter}
 * @param {WebSocket} [connection] Websocket connection
 */
class Peer extends EventEmitter {
  constructor (connection) {
    super()

    this.id = uid()
    logger(`peer:${this.id}`, this)

    this.job = null
    this.hashes = 0

    this.ws = connection
      .on('close', () => this.destroy())
      .on('message', (string) => {
        try {
          this.emit('message', JSON.parse(string))
        } catch (e) {
          this.log('failed to parse message from peer', e, string)
        }
      })
      .on('error', (err) => {
        this.log('[WEBSOCKET]', err.message, this.ip)
      })
  }

  get ip () {
    try {
      return this.ws._socket._peername.address
    } catch (e) {
      return ''
    }
  }

  /**
   * Send message to peer
   * @param  {string} type Message type
   * @param  {object} params Message params
   *
   * @chainable
   */
  pushMessage (type, params) {
    this.send({ type, params })
  }

  /**
   * @private
   * @param  {object} message Message object
   * @chainable
   */
  send (message) {
    try {
      this.ws.send(JSON.stringify(message))
    } catch (e) {
      this.log('error sending message: ', e.message)
    }
  }

  /**
   * Destroy peer and websocket connection
   */
  destroy () {
    this.emit('destroy', this)
    this.log('destroying')

    this.job = null
    this.hashes = 0

    if (this.ws) {
      this.ws.terminate()
      this.ws = null
    }
  }
}

/**
 * Let peer communicate with electrum server
 * @class PeerProxy
 * @extends {EventEmitter}
 * @param {string} uri electrum server uri
 * @param {Object} options Proxy options
 */
class PeerProxy extends EventEmitter {
  constructor (options) {
    super()

    this.uid = uid()
    this.url = new URL(options.uri)

    this.peers = new Map() // Map of connected peers
    this.socket = null // Socket connection

    this.id = null // peer id on server side

    logger(`client:${this.uid}`, this)
    this.connect()
  }

  /**
   * Send message to electrum server
   * @param {object} message Electrum message
   */
  send (message) {
    if (this.socket && this.socket.writable) {
      try {
        $log('<= send to electrum server:', message.method)
        this.socket.write(JSON.stringify(message) + NEW_LINE)
      } catch (e) {
        $log('error sending message: ', e.message)
        this.destroy()
      }
    }
  }

  /**
   * Perform connection to electrum server
   * @chainable
   */
  connect () {
    const { hostname, port, protocol, query } = this.url

    switch (protocol) {
      case 'ssl:':
        this.socket = tls.connect(
          +port,
          hostname,
          { rejectUnauthorized: !!query['rejectUnauthorized'] }
        )
        break
      case 'tcp:':
        this.socket = net.connect(+port, hostname)
        break
      default:
        this.log(`protocol "${protocol}" not supported yet!`)
        return this.destroy()
    }

    let buffer = '' // Buffer for storing chunks
    const handleChunk = (chunk) => {
      buffer += chunk
      while (buffer.includes(NEW_LINE)) {
        let newLineIndex = buffer.indexOf(NEW_LINE)
        const electrumMessage = buffer.slice(0, newLineIndex)
        buffer = buffer.slice(++newLineIndex)

        let data
        try {
          data = JSON.parse(electrumMessage)
        } catch (e) {
          $log('=== error while parse message from electrum server ===')
          $log(electrumMessage)
          $log('=== error while parse message from electrum server ===')
          return
        }

        $log(electrumMessage)

        const { id: peerId, error } = data
        const peer = this.peers.get(peerId)

        if (error) {
          this.log('=> error from electrum server:', error.message)
          if (peer) {
            peer.pushMessage('error', { error: error.message })
          }
          $log('[SOCKET] ERROR:', error)
        } else {
          const { result, method, params } = data

          if(peer) {
            if(result) {
              peer.pushMessage(method?method:'unknown', result)
            }
          }
          else {
            if(peerId && peerId === 'keepalive') {
              $log('keepalive')
            }
            else{
              this.peers.forEach(peer => peer.pushMessage(method?method:'unknown', params))
            }
          }
        }
      }
    }

    // Socket handlers setup
    this.socket
      .setEncoding('utf8')
      .on('connect', () => {
        buffer = ''
        $log(`connected: ${this.url}`)
        this.emit('connected', this.socket)
        const proxy = this
        setInterval(function(){proxy.send({
          id: 'keepalive',
          method: 'server.version',
          params: {
            
          }
        })}, 60000)
      })
      .on('data', handleChunk)
      .on('error', (err) => {
        $log('[SOCKET]', err)
        this.log('trying to reconnect in 5 seconds')
        this.emit('error', err)
      })
      .on('close', () => {
        this.log('socket closed!')
        this.emit('closed')
      })
  }

  /**
   * Used to associate a peer with the current proxy
   * @param  {Peer} peer A connected peer
   * @chainable
   */
  link (peer) {
    const { id } = peer

    const onMessage = ({ type: method, params }) => {
      var msg = {
        id: id,
        method: method,
        params: params
      };
      this.send(msg);
    }

    peer
      .on('message', onMessage)
      .once('destroy', (peer) => this.unlink(peer))

    this.peers.set(id, peer)
  }

  /**
   * Unassociate provided peer instance from current proxy
   * @param  {Peer} peer A websocket connected peer
   * @chainable
   */
  unlink (peer) {
    peer.removeAllListeners('message')
    peer.removeAllListeners('destroy')
    peer.destroy()

    this.log('- delete peer:', peer.id)
    this.peers.delete(peer.id)

    if (this.peers.size < 1) {
      this.destroy()
    }
  }

  /**
   * Destroy current proxy, close socket connection and unlink all peers
   */
  destroy () {
    this.emit('destroy', this)
    if (this.socket) {
      this.socket.destroy()
    }
    this.peers.forEach(peer => this.unlink(peer))
    this.peers.clear()
    this.log('Destroying!')
  }
}


/**
 * Populate provided set with local IP's
 * @param  {Set} set Store collected data to provided set
 */
const retrieveLocalAddresses = (set) => {
  let interfaces = os.networkInterfaces()
  Object.keys(interfaces).forEach((iface) => {
    interfaces[iface].forEach(addr => set.add(addr.address))
  })
}

/**
 * Useful for preventing peer sabotage!
 * @class Jail
 * @extends {Map}
 */
class Jail extends Map {
  /**
   * @param  {Number} timeout Ban timeout
   */
  constructor (timeout = BAN_TIMEOUT) {
    super()
    this.timeout = timeout
    this.locals = new Set()

    retrieveLocalAddresses(this.locals)
    logger('jail', this)
  }

  /**
   * Add IP address to ban-list
   * @param {string} ip IP address
   */
  add (ip) {
    if (this.locals.has(ip)) {
      return // No ban for locals clients
    }
    this.super(ip, Date.now())
    this.log('+', ip)
  }

  /**
   * Check if provided IP address is in ban-list
   * @param  {ip} ip IP address
   * @return {Boolean}
   */
  has (ip) {
    return this.get(ip) + this.timeout > Date.now() && !this.delete(ip)
  }

  /**
   * Remove provided IP address from ban-list
   * @param  {ip} ip IP address
   */
  delete (ip) {
    this.log('-', ip)
    return this.super(ip)
  }

  /**
   * Check if provided IP address is in ban-list
   * @param  {ip} ip IP address
   * @return {Promise}
   */
  checkBan (ip) {
	  $log('checkBan')
    return new Promise((resolve, reject) => {
      this.has(ip)
        ? reject(new Error('You banned!'))
        : resolve()
    })
  }
}

const peersProxyFactory = ({ servers, maxFails }) => {
  const serverConnectionFails = new Set()
  const connections = new Set()

  const getPeerId = () => os.hostname()

  process.on('SIGINT', () => {
    $log('Graceful Shutdown!')
    $log('Connections to destroy:', connections.size)
    connections.forEach(c => c.destroy())
    clearInterval(connectionsInfoInterval)
    process.exit(0)
  })

  return () => new Promise((resolve, reject) => {
    for (let peerProxy of connections) {
      return resolve(peerProxy)
    }

    let server = servers.find(server => !serverConnectionFails.has(server.uri || server))

    if (typeof server === 'string') {
      server = { uri: server }
    }

    if (server) {
      server = { ...server, peerId: getPeerId() }
      const peerProxy = new PeerProxy(server)
      peerProxy
        .on('error', () => {
          serverConnectionFails.add(server.uri)
          setTimeout(serverConnectionFails.delete.bind(serverConnectionFails), 6e4, server.uri) // 1 minute timeout
        })
        .on('destroy', () => {
          connections.delete(peerProxy)
        })
      resolve(peerProxy)
      connections.add(peerProxy)
    } else {
      reject(new Error('All electrum servers seem dead :('))
    }
  })
}

const createProxy = (proxyOptions = {}, { servers }) => {
  if (typeof proxyOptions !== 'object') {
    proxyOptions = { ...defaults.websockets, port: +proxyOptions }
  } else {
    if (!proxyOptions.server) {
      Object.assign(proxyOptions, defaults.websockets, proxyOptions)
    } else {
      proxyOptions.path = defaults.websockets.path
    }
  }

  if (!servers || !servers.length) {
    servers = defaults.servers
  }

  const wss = new Server(proxyOptions)
  const { server, path } = wss.options
  const method = server ? 'bound to server' : 'server is ready'

  const jail = new Jail()
  const selectProxy = peersProxyFactory(
    Object.assign(
      { servers },
      defaults.electrumProxy
    )
  )

  const heartbeat = function () {
    this.isAlive = true
  }

  const heartbeatInterval = setInterval(() => { // eslint-disable-line
    async.each(wss.clients, (websocket) => {
      if (websocket.isAlive === false) {
        return websocket.terminate()
      }
      websocket.isAlive = false
      websocket.ping('', false, true)
    })
  }, 6e4) // 1 minute

  const wssListening = () => {
    let protocol = 'ws'
    let host
    let port

    if (server) {
      if (server instanceof https.Server) {
        protocol += 's'
      }
      host = server.address().address
      port = server.address().port
    } else {
      host = wss.options.host
      port = wss.options.port
    }

    $log(`Web Sockets ${method} on ${protocol}://${host}:${port}${path}`)
  }

  const wssConnection = (websocket, req) => {
    const ip = req.connection.remoteAddress

    jail
      .checkBan(ip)
      .then(() => selectProxy())
      .then(peerProxy => {
        websocket.isAlive = true
        websocket.on('pong', heartbeat)
        const peer = new Peer(websocket)
        peerProxy.link(peer)
      })
      .catch(err => {
        websocket.send(JSON.stringify({ type: 'error', params: { error: err.message } }))
        websocket.terminate()
        $log(err)
      })
  }

  const wssError = (err) => $log('[WEBSOCKET SERVER]', err)

  return wss
    .on('listening', wssListening)
    .on('connection', wssConnection)
    .on('error', wssError)
}

module.exports = createProxy

// Handle Ctrl+C on windows host
if (process.platform === 'win32') {
  require('readline')
    .createInterface({
      input: process.stdin,
      output: process.stdout
    })
    .on('SIGINT', () => {
      process.emit('SIGINT')
    })
}
