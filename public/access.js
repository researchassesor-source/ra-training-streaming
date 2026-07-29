async function roomRequest(path, options = {}, csrfToken = '') {
  const headers = { ...(options.headers || {}) };
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
    const error = new Error(data.error || 'No fue posible validar el acceso');
    error.code = data.code;
    error.status = response.status;
    throw error;
  }
  return data;
}

function getRoomSession() {
  return roomRequest('/api/room-session');
}

function updateRoomProfile(displayName, csrfToken) {
  return roomRequest('/api/room-session/profile', { method: 'PATCH', body: { displayName } }, csrfToken);
}

function requestToken() {
  return roomRequest('/api/token');
}
