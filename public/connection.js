// Shared connection-state UI: live participant count + reconnect banner.
// `getLabel()` should return whatever text the page normally wants in the
// status badge (e.g. "en vivo · sala X" or "🔴 grabando · sala X") so we can
// restore it once a reconnect succeeds.
function attachConnectionUI(room, { statusBadge, countBadge, getLabel }) {
  function updateCount() {
    if (!countBadge) return;
    const n = room.remoteParticipants.size + 1;
    countBadge.textContent = `${n} conectado${n === 1 ? '' : 's'}`;
  }

  function restoreLabel() {
    if (!statusBadge) return;
    statusBadge.textContent = getLabel ? getLabel() : 'en vivo';
    statusBadge.className = 'badge live';
  }

  room.on(LivekitClient.RoomEvent.ParticipantConnected, updateCount);
  room.on(LivekitClient.RoomEvent.ParticipantDisconnected, updateCount);

  room.on(LivekitClient.RoomEvent.Reconnecting, () => {
    if (!statusBadge) return;
    statusBadge.textContent = '⚠️ reconectando…';
    statusBadge.className = 'badge warn';
  });
  room.on(LivekitClient.RoomEvent.Reconnected, restoreLabel);
  room.on(LivekitClient.RoomEvent.Disconnected, () => {
    if (!statusBadge) return;
    statusBadge.textContent = '🔌 desconectado — intenta recargar la página';
    statusBadge.className = 'badge warn';
  });

  updateCount();
  return { updateCount, restoreLabel };
}
