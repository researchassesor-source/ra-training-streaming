const { log } = require('./logger');

function createShutdown({ serverRef, redis, db, exit = process.exit, timeoutMs = 10_000 } = {}) {
  let shuttingDown = false;
  return function shutdown(signal = 'UNKNOWN', exitCode = 0) {
    if (shuttingDown) return false;
    shuttingDown = true;
    log(exitCode ? 'error' : 'info', 'server_shutdown', { signal });
    const closeResources = () => Promise.allSettled([
      redis?.disconnect?.(),
      db?.closePool?.(),
    ]).finally(() => exit(exitCode));
    const server = typeof serverRef === 'function' ? serverRef() : serverRef;
    const timeout = setTimeout(() => {
      log('warn', 'server_shutdown_timeout', { signal, timeoutMs });
      exit(1);
    }, timeoutMs);
    timeout.unref?.();
    if (!server) {
      closeResources().finally(() => clearTimeout(timeout));
      return true;
    }
    server.close(() => {
      closeResources().finally(() => clearTimeout(timeout));
    });
    return true;
  };
}

module.exports = { createShutdown };
