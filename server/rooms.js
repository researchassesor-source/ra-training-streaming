// In-memory room access registry. Resets on server restart — fine for this
// stage; move to a real datastore if rooms need to survive redeploys.
const rooms = new Map();

function createRoom(room, { hostCode, viewerPassword } = {}) {
  rooms.set(room, {
    hostCode: hostCode ? String(hostCode) : null,
    viewerPassword: viewerPassword ? String(viewerPassword) : null,
    createdAt: Date.now(),
  });
  return rooms.get(room);
}

function getRoom(room) {
  return rooms.get(room);
}

// Rooms that were never explicitly created (or created with no codes) stay
// open, so the simple "type a room name and join" flow keeps working.
function checkAccess(room, role, suppliedCode) {
  const config = rooms.get(room);
  if (!config) return { allowed: true };

  const requiredCode = role === 'presenter' ? config.hostCode : config.viewerPassword;
  if (!requiredCode) return { allowed: true };
  if (suppliedCode && suppliedCode === requiredCode) return { allowed: true };
  return { allowed: false, requiresCode: true };
}

module.exports = { createRoom, getRoom, checkAccess };
