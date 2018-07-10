const crypto = require('crypto')

const ts = (date = new Date()) => {
  return `[${date.toISOString()}]`
}

const $log = (...args) => console.log(ts(), ...args)

module.exports = {

  $log,

  logger (name, obj) {
    let log = () => {}
    try {
      log = require('debug')(`[${name}]`)
    } catch (e) {}
    if (obj) {
      obj.log = log
    } else {
      return log
    }
  },

  uid (length = 16) {
    return crypto.randomBytes(length).toString('hex')
  },

  tplCompile (tpl, locals = {}) {
    let re = /%([^%]+)?%/g
    let code = 'with (this) {'
    let cursor = 0
    let match
    let add = function (line, js) {
      code += `r.push(${js ? line : `"${line.replace(/"/g, '\\"')}"`});`
    }
    code += 'const r=[];'
    while ((match = re.exec(tpl))) {
      add(tpl.slice(cursor, match.index))
      add(match[1], true)
      cursor = match.index + match[0].length
    }
    add(tpl.substr(cursor, tpl.length - cursor))
    code += 'return r.join("");'
    code += '}'
    return new Function(code.replace(/[\r\t\n]/g, '')).apply(locals) // eslint-disable-line
  }
}
