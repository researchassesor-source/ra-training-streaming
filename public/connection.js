function attachConnectionUI(room, { statusBadge, countBadge, qualityBadge, floatingModel, onParticipantsChanged, onReconnected, onQualityChanged, onParticipantEvent }) {
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
    participantConnected(participant) { updateCount(); playJoinSound(); onParticipantEvent?.('joined', participant); },
    participantDisconnected(participant) { updateCount(); playLeaveSound(); onParticipantEvent?.('left', participant); },
    permissionsChanged() { onParticipantsChanged?.(participants()); },
    mediaChanged() { onParticipantsChanged?.(participants()); },
    reconnecting() { machine.set('reconnecting'); playAlert('unstable'); systemNotification('Problema de conexión', 'Intentando reconectar con la reunión.'); },
    reconnected() { machine.set('connected'); updateCount(); playAlert('reconnected'); onReconnected?.(); },
    disconnected(reason) { machine.set(String(reason || '').toLowerCase().includes('removed') ? 'removed' : 'disconnected'); playAlert('critical'); },
    qualityChanged(quality, participant) {
      if (!participant?.isLocal) return;
      const value = String(quality || '').toLowerCase();
      const normalized = value.includes('excellent') ? 'excellent' : value.includes('good') ? 'good' : value.includes('poor') ? 'poor' : 'unknown';
      if (normalized === 'poor') machine.set('poor_connection');
      else if (['good', 'excellent'].includes(normalized) && machine.state === 'poor_connection') machine.set('connected');
      if (qualityBadge) {
        const labels = { excellent: 'Red excelente', good: 'Red buena', poor: 'Red inestable', unknown: 'Red sin medir' };
        qualityBadge.textContent = labels[normalized];
        qualityBadge.className = `quality-badge quality-${normalized}`;
      }
      floatingModel?.update({ quality: normalized });
      onQualityChanged?.(normalized);
    },
  };

  room.on(LivekitClient.RoomEvent.ParticipantConnected, handlers.participantConnected);
  room.on(LivekitClient.RoomEvent.ParticipantDisconnected, handlers.participantDisconnected);
  room.on(LivekitClient.RoomEvent.ParticipantPermissionsChanged, handlers.permissionsChanged);
  const mediaEvents = [
    LivekitClient.RoomEvent.TrackPublished,
    LivekitClient.RoomEvent.TrackUnpublished,
    LivekitClient.RoomEvent.TrackSubscribed,
    LivekitClient.RoomEvent.TrackUnsubscribed,
    LivekitClient.RoomEvent.TrackMuted,
    LivekitClient.RoomEvent.TrackUnmuted,
    LivekitClient.RoomEvent.LocalTrackPublished,
    LivekitClient.RoomEvent.LocalTrackUnpublished,
  ].filter(Boolean);
  mediaEvents.forEach((event) => room.on(event, handlers.mediaChanged));
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
        if (name === 'mediaChanged') continue;
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
      mediaEvents.forEach((event) => room.off(event, handlers.mediaChanged));
    },
  };
}
