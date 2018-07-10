module.exports = {
  websockets: {
    host: '0.0.0.0',
    port: 8080,
    path: '/proxy'
  },
  electrumProxy: {
    maxFails: 5
  },
  servers: [
    'tcp://188.166.191.80:50001',
  ]
}
