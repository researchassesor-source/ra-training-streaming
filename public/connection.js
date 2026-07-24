// Shared connection-state UI: live participant count + reconnect banner +
// a floating "who's connected" panel toggled by clicking the count badge.
// `getLabel()` should return whatever text the page normally wants in the
// status badge (e.g. "en vivo · sala X" or "🔴 grabando · sala X") so we can
// restore it once a reconnect succeeds.
function attachConnectionUI(room, { statusBadge, countBadge, getLabel }) {
  function updateCount() {
    if (!countBadge) return;
    const n = room.remoteParticipants.size + 1;
    countBadge.textContent = `👥 ${n} conectado${n === 1 ? '' : 's'}`;
  }

  function restoreLabel() {
    if (!statusBadge) return;
    statusBadge.textContent = getLabel ? getLabel() : 'en vivo';
    statusBadge.className = 'badge live';
  }

  // --- Floating participants panel ---
  let panel = null;

  function participantRow(p, isLocal) {
    const canPublish = Boolean((p.permissions || p.permission || {}).canPublish);
    const icon = canPublish ? '🎙️' : '👀';
    const row = document.createElement('div');
    row.className = 'participant-row';
    row.textContent = `${icon} ${p.identity}${isLocal ? ' (tú)' : ''}`;
    return row;
  }

  function renderPanel() {
    if (!panel) return;
    updateCount();
    const list = panel.querySelector('.participants-list');
    list.innerHTML = '';
    list.appendChild(participantRow(room.localParticipant, true));
    for (const p of room.remoteParticipants.values()) list.appendChild(participantRow(p, false));
  }

  function togglePanel() {
    if (panel) {
      panel.remove();
      panel = null;
      return;
    }
    panel = document.createElement('div');
    panel.className = 'floating-panel';
    panel.innerHTML = `
      <div class="floating-panel-header">
        <span>Participantes</span>
        <button type="button" class="close-btn">✕</button>
      </div>
      <div class="participants-list"></div>
    `;
    document.body.appendChild(panel);
    panel.querySelector('.close-btn').onclick = togglePanel;
    renderPanel();
  }

  if (countBadge) {
    countBadge.classList.add('clickable');
    countBadge.onclick = togglePanel;
  }

  room.on(LivekitClient.RoomEvent.ParticipantConnected, renderPanel);
  room.on(LivekitClient.RoomEvent.ParticipantDisconnected, renderPanel);
  room.on(LivekitClient.RoomEvent.ParticipantPermissionsChanged, renderPanel);

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
