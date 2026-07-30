function localMode(wsUrl) {
  try {
    const hostname = new URL(wsUrl).hostname;
    return ['localhost', '127.0.0.1', '::1'].includes(hostname) ? 'local' : 'remoto';
  } catch {
    return 'no configurado';
  }
}

function createLiveKitStatusProbe({ roomService, wsUrl, timeoutMs = 1_800, cacheMs = 3_000 } = {}) {
  let cached = null;
  let pending = null;

  async function check() {
    const checkedAt = new Date().toISOString();
    const mode = localMode(wsUrl);
    if (!roomService || !wsUrl || mode === 'no configurado') {
      return { configured: false, available: false, state: 'DISABLED', mode, checkedAt };
    }
    let timer;
    try {
      await Promise.race([
        roomService.listRooms(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Tiempo de espera agotado'), { code: 'LIVEKIT_TIMEOUT' })), timeoutMs); }),
      ]);
      return { configured: true, available: true, state: 'AVAILABLE', mode, checkedAt };
    } catch (error) {
      return {
        configured: true,
        available: false,
        state: 'UNAVAILABLE',
        mode,
        checkedAt,
        errorCode: error.code === 'LIVEKIT_TIMEOUT' ? 'LIVEKIT_TIMEOUT' : 'LIVEKIT_UNREACHABLE',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return async function probe({ fresh = false } = {}) {
    if (!fresh && cached && Date.now() - cached.cachedAt < cacheMs) return cached.value;
    if (pending) return pending;
    pending = check().then((value) => {
      cached = { cachedAt: Date.now(), value };
      return value;
    }).finally(() => { pending = null; });
    return pending;
  };
}

module.exports = { createLiveKitStatusProbe, localMode };
