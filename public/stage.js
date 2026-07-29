function createStage(containerElement, placeholderText, onSpotlightChange) {
  const tiles = new Map();
  const placeholder = document.createElement('div');
  placeholder.className = 'placeholder';
  placeholder.textContent = placeholderText || 'Esperando participantes…';
  let spotlightActive = false;

  function tile(identity, source, label) {
    const key = `${identity}|${source}`;
    if (tiles.has(key)) return tiles.get(key);
    const root = document.createElement('article'); root.className = `tile${source === 'screen' ? ' screen' : ''}`;
    const video = document.createElement('video'); video.autoplay = true; video.playsInline = true; video.muted = true;
    const labelElement = document.createElement('div'); labelElement.className = 'tile-label'; labelElement.textContent = label;
    root.append(video, labelElement);
    if (source === 'screen') {
      const fullscreen = document.createElement('button'); fullscreen.type = 'button'; fullscreen.className = 'tile-fullscreen'; fullscreen.textContent = 'Pantalla completa'; fullscreen.setAttribute('aria-label', 'Mostrar pantalla compartida en pantalla completa');
      fullscreen.onclick = () => document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen?.(); root.appendChild(fullscreen);
    }
    const entry = { root, video, labelElement }; tiles.set(key, entry); return entry;
  }

  function setTrack(identity, label, source, track) {
    const entry = tile(identity, source, label); entry.labelElement.textContent = label;
    track.attach(entry.video); entry.video.play?.().catch(() => {}); layout();
  }

  function setSelfSharePlaceholder(identity, label) {
    const entry = tile(identity, 'screen', label); entry.video.hidden = true;
    let message = entry.root.querySelector('.tile-self-placeholder');
    if (!message) { message = document.createElement('div'); message.className = 'tile-self-placeholder'; message.textContent = 'Estás compartiendo tu pantalla. Los demás la ven en vivo.'; entry.root.appendChild(message); }
    layout();
  }

  function removeTrack(identity, source) {
    const key = `${identity}|${source}`; const entry = tiles.get(key);
    if (entry) { entry.video.srcObject = null; entry.root.remove(); tiles.delete(key); }
    layout();
  }
  function removeParticipant(identity) { removeTrack(identity, 'camera'); removeTrack(identity, 'screen'); }

  function layout() {
    containerElement.replaceChildren();
    if (!tiles.size) { containerElement.classList.remove('has-spotlight'); containerElement.appendChild(placeholder); notify(false); return; }
    const screenEntry = [...tiles.entries()].find(([key]) => key.endsWith('|screen'));
    if (screenEntry) {
      containerElement.classList.add('has-spotlight'); containerElement.appendChild(screenEntry[1].root);
      const thumbnails = document.createElement('div'); thumbnails.className = 'spotlight-thumbs';
      for (const [key, entry] of tiles) if (key !== screenEntry[0]) thumbnails.appendChild(entry.root);
      if (thumbnails.children.length) containerElement.appendChild(thumbnails); notify(true);
    } else {
      containerElement.classList.remove('has-spotlight'); for (const entry of tiles.values()) containerElement.appendChild(entry.root); notify(false);
    }
  }

  function notify(active) { if (active !== spotlightActive) { spotlightActive = active; onSpotlightChange?.(active); } }
  layout();
  return { setTrack, setSelfSharePlaceholder, removeTrack, removeParticipant };
}

function attachRemoteStageEvents(room, stage) {
  if (!document.documentElement.dataset.mediaResumeBound) {
    document.documentElement.dataset.mediaResumeBound = 'true';
    document.addEventListener('click', () => document.querySelectorAll('video, audio').forEach((media) => { if (media.paused) media.play?.().catch(() => {}); }));
  }
  room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
    if (track.kind === 'audio') { const element = track.attach(); const speaker = document.getElementById('speakerSelect')?.value; if (speaker) element.setSinkId?.(speaker).catch(() => {}); return; }
    const source = publication.source === LivekitClient.Track.Source.ScreenShare ? 'screen' : 'camera';
    const label = participant.name || participant.identity;
    stage.setTrack(participant.identity, source === 'screen' ? `${label} (pantalla)` : label, source, track);
  });
  room.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
    if (track.kind !== 'audio') stage.removeTrack(participant.identity, publication.source === LivekitClient.Track.Source.ScreenShare ? 'screen' : 'camera');
    track.detach?.().forEach?.((element) => element.remove());
  });
  room.on(LivekitClient.RoomEvent.ParticipantDisconnected, (participant) => stage.removeParticipant(participant.identity));
}
