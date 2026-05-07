'use strict';

function loadProxy(configFromFile) {
  const proxy = {
    http: process.env.HTTP_PROXY || process.env.http_proxy || null,
    https: process.env.HTTPS_PROXY || process.env.https_proxy || null,
  };

  if (configFromFile) {
    if (!proxy.http && configFromFile.http) {
      proxy.http = configFromFile.http;
    }
    if (!proxy.https && configFromFile.https) {
      proxy.https = configFromFile.https;
    }
  }

  return proxy;
}

function hasProxy(proxy) {
  return !!(proxy && (proxy.http || proxy.https));
}

module.exports = { loadProxy, hasProxy };
