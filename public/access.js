const roomSessionStorageKey = 'rat:room-session-id';
let roomSessionSelector = '';

if (typeof window !== 'undefined') {
  const candidate = new URLSearchParams(window.location.search).get('roomSession') || '';
  if (/^[a-f0-9-]{36}$/i.test(candidate)) {
    roomSessionSelector = candidate;
    window.sessionStorage?.setItem(roomSessionStorageKey, candidate);
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete('roomSession');
    window.history.replaceState(null, '', `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
  } else {
    const stored = window.sessionStorage?.getItem(roomSessionStorageKey) || '';
    if (/^[a-f0-9-]{36}$/i.test(stored)) roomSessionSelector = stored;
  }
}

function roomErrorMessage(status, code, message) {
  if (message) return message;
  if (status === 401 || code === 'ROOM_SESSION_REQUIRED') return 'Tu sesión de sala expiró. Vuelve a entrar.';
  if (status === 403 || code === 'ROOM_FORBIDDEN') return 'No tienes permiso para realizar esta acción.';
  if (status === 404) return 'El participante o recurso ya no está disponible.';
  if (status === 409) return 'La acción entra en conflicto con el estado actual de la reunión.';
  if (status === 429) return 'Hay demasiadas solicitudes. Espera un momento antes de reintentar.';
  return 'No fue posible completar la solicitud de sala.';
}

async function roomRequest(path, options = {}, csrfToken = '') {
  const headers = { ...(options.headers || {}) };
  if (roomSessionSelector) headers['X-Room-Session-ID'] = roomSessionSelector;
  if (options.body !== undefined && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (csrfToken && options.method && options.method !== 'GET') headers['X-Room-CSRF'] = csrfToken;
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers,
    body: options.body === undefined || options.body instanceof FormData ? options.body : JSON.stringify(options.body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(roomErrorMessage(response.status, data.code, data.error));
    error.code = data.code;
    error.status = response.status;
    throw error;
  }
  return data;
}

function getRoomSessionSelector() { return roomSessionSelector; }

function getRoomSession() {
  return roomRequest('/api/room-session');
}

function updateRoomProfile(displayName, csrfToken) {
  return roomRequest('/api/room-session/profile', { method: 'PATCH', body: { displayName } }, csrfToken);
}

function requestToken() {
  return roomRequest('/api/token');
}

function requestLiveKitStatus() {
  return roomRequest('/api/room/livekit-status');
}

function reportRoomConnection(event, csrfToken, reason = '') {
  return roomRequest('/api/room/connection', { method: 'POST', body: { event, reason } }, csrfToken);
}
