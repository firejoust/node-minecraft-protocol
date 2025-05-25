const Proxy = require("./proxy");

function createProxy(options) {
  return new Proxy(options);
}

module.exports = createProxy;
