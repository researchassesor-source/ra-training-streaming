function attachConnectionUI(room, { statusBadge, countBadge, floatingModel, onParticipantsChanged }) {
  const machine = new RATCore.ConnectionStateMachine((snapshot) => {
    if (statusBadge) {
      statusBadge.textContent = snapshot.label;
      statusBadge.dataset.state = snapshot.state;
      statusBadge.className = `connection-status state-${snapshot.state}`;
    }
    floatingModel?.update({ connection: snapshot.state, live: snapshot.connected });
  });

  function participants() {
    return [room.localParticipant, ...room.remoteParticipants.values()];
  }

  function updateCount() {
    const count = participants().length;
    if (countBadge) countBadge.textContent = `${count} participante${count === 1 ? '' : 's'}`;
    floatingModel?.update({ participants: count });
    onParticipantsChanged?.(participants());
  }

  const handlers = {
    participantConnected() { updateCount(); playJoinSound(); },
    participantDisconnected() { updateCount(); playLeaveSound(); },
    permissionsChanged() { onParticipantsChanged?.(participants()); },
    reconnecting() { machine.set('reconnecting'); playAlert('unstable'); systemNotification('Problema de conexión', 'Intentando reconectar con la reunión.'); },
    reconnected() { machine.set('connected'); playAlert('reconnected'); },
    disconnected(reason) { machine.set(String(reason || '').toLowerCase().includes('removed') ? 'removed' : 'disconnected'); playAlert('critical'); },
    qualityChanged(quality, participant) {
      if (participant?.isLocal && String(quality).toLowerCase().includes('poor')) machine.set('poor_connection');
    },
  };

  room.on(LivekitClient.RoomEvent.ParticipantConnected, handlers.participantConnected);
  room.on(LivekitClient.RoomEvent.ParticipantDisconnected, handlers.participantDisconnected);
  room.on(LivekitClient.RoomEvent.ParticipantPermissionsChanged, handlers.permissionsChanged);
  room.on(LivekitClient.RoomEvent.Reconnecting, handlers.reconnecting);
  room.on(LivekitClient.RoomEvent.Reconnected, handlers.reconnected);
  room.on(LivekitClient.RoomEvent.Disconnected, handlers.disconnected);
  if (LivekitClient.RoomEvent.ConnectionQualityChanged) room.on(LivekitClient.RoomEvent.ConnectionQualityChanged, handlers.qualityChanged);
  updateCount();
  return {
    machine,
    updateCount,
    dispose() {
      for (const [name, handler] of Object.entries(handlers)) {
        const eventName = {
          participantConnected: LivekitClient.RoomEvent.ParticipantConnected,
          participantDisconnected: LivekitClient.RoomEvent.ParticipantDisconnected,
          permissionsChanged: LivekitClient.RoomEvent.ParticipantPermissionsChanged,
          reconnecting: LivekitClient.RoomEvent.Reconnecting,
          reconnected: LivekitClient.RoomEvent.Reconnected,
          disconnected: LivekitClient.RoomEvent.Disconnected,
          qualityChanged: LivekitClient.RoomEvent.ConnectionQualityChanged,
        }[name];
        if (eventName) room.off(eventName, handler);
      }
    },
  };
}
