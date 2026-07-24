// Renders a grid of video tiles for however many panelists are publishing.
// When any tile is a screen-share, it takes the main spotlight and every
// other tile (cameras, including the sharer's own) drops into a thumbnail strip.
function createStage(containerEl, placeholderText, onSpotlightChange) {
  const tileEls = new Map(); // `${identity}|${source}` -> { root, video, labelEl }
  const placeholder = document.createElement('div');
  placeholder.className = 'placeholder';
  placeholder.textContent = placeholderText || 'Esperando participantes…';
  let lastSpotlight = false;

  function getOrCreateTile(identity, source, label) {
    const key = `${identity}|${source}`;
    if (tileEls.has(key)) return tileEls.get(key);
    const root = document.createElement('div');
    root.className = 'tile' + (source === 'screen' ? ' screen' : '');
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    const labelEl = document.createElement('div');
    labelEl.className = 'tile-label';
    labelEl.textContent = label;
    root.appendChild(video);
    root.appendChild(labelEl);

    if (source === 'screen') {
      const fsBtn = document.createElement('button');
      fsBtn.type = 'button';
      fsBtn.className = 'tile-fullscreen';
      fsBtn.title = 'Pantalla completa';
      fsBtn.textContent = '⛶';
      fsBtn.onclick = () => {
        if (document.fullscreenElement) document.exitFullscreen();
        else root.requestFullscreen?.();
      };
      root.appendChild(fsBtn);
    }

    const entry = { root, video, labelEl };
    tileEls.set(key, entry);
    return entry;
  }

  function setTrack(identity, label, source, track, opts = {}) {
    const entry = getOrCreateTile(identity, source, label);
    entry.labelEl.textContent = label;
    if (opts.muted) entry.video.muted = true;
    track.attach(entry.video);
    layout();
  }

  // For your OWN screen share: deliberately never attach the live video
  // locally. If your captured screen includes this browser tab, rendering
  // your own share back to yourself creates an infinite "hall of mirrors"
  // zoom tunnel. Everyone else still gets the real live video as normal.
  function setSelfSharePlaceholder(identity, label) {
    const entry = getOrCreateTile(identity, 'screen', label);
    entry.video.style.display = 'none';
    if (!entry.placeholderEl) {
      const p = document.createElement('div');
      p.className = 'tile-self-placeholder';
      p.innerHTML = '<span class="big">🖥️</span><span>Estás compartiendo tu pantalla</span><span class="hint">Los demás ven tu pantalla en vivo</span>';
      entry.root.appendChild(p);
      entry.placeholderEl = p;
    }
    layout();
  }

  function removeTrack(identity, source) {
    const key = `${identity}|${source}`;
    const entry = tileEls.get(key);
    if (entry) {
      entry.root.remove();
      tileEls.delete(key);
    }
    layout();
  }

  function removeParticipant(identity) {
    removeTrack(identity, 'camera');
    removeTrack(identity, 'screen');
  }

  function notifySpotlight(active) {
    if (active === lastSpotlight) return;
    lastSpotlight = active;
    onSpotlightChange?.(active);
  }

  function layout() {
    containerEl.innerHTML = '';
    if (tileEls.size === 0) {
      containerEl.classList.remove('has-spotlight');
      containerEl.appendChild(placeholder);
      notifySpotlight(false);
      return;
    }
    const screenEntry = [...tileEls.entries()].find(([key]) => key.endsWith('|screen'));
    if (screenEntry) {
      containerEl.classList.add('has-spotlight');
      containerEl.appendChild(screenEntry[1].root);
      const thumbs = document.createElement('div');
      thumbs.className = 'spotlight-thumbs';
      for (const [key, entry] of tileEls) {
        if (key === screenEntry[0]) continue;
        thumbs.appendChild(entry.root);
      }
      if (thumbs.children.length) containerEl.appendChild(thumbs);
      notifySpotlight(true);
    } else {
      containerEl.classList.remove('has-spotlight');
      for (const entry of tileEls.values()) containerEl.appendChild(entry.root);
      notifySpotlight(false);
    }
  }

  layout();
  return { setTrack, setSelfSharePlaceholder, removeTrack, removeParticipant };
}

// Wires up a stage to every REMOTE participant's camera/screen tracks.
// (Local tracks never fire TrackSubscribed, so callers manage those themselves.)
function attachRemoteStageEvents(room, stage) {
  room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
    if (track.kind === 'audio') {
      track.attach(); // plays automatically via a hidden audio element
      return;
    }
    const source = publication.source === LivekitClient.Track.Source.ScreenShare ? 'screen' : 'camera';
    const label = source === 'screen' ? `${participant.identity} (pantalla)` : participant.identity;
    stage.setTrack(participant.identity, label, source, track);
  });

  room.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
    if (track.kind === 'audio') return;
    const source = publication.source === LivekitClient.Track.Source.ScreenShare ? 'screen' : 'camera';
    stage.removeTrack(participant.identity, source);
  });

  room.on(LivekitClient.RoomEvent.ParticipantDisconnected, (participant) => {
    stage.removeParticipant(participant.identity);
  });
}
