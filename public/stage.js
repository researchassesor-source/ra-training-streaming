function normalizeTrackSource(source) {
  return String(source || '').toLowerCase().replace(/[^a-z]/g, '');
}

function classifyTrackSource(publication) {
  const source = normalizeTrackSource(publication?.source);
  if (source.includes('screenshareaudio')) return 'screen-audio';
  if (source.includes('screenshare') || source === 'screen') return 'screen';
  if (source.includes('camera')) return 'camera';
  if (source.includes('microphone')) return 'microphone';
  return publication?.track?.kind === 'audio' ? 'audio' : 'camera';
}

function createStage(containerElement, placeholderText, onSpotlightChange) {
  const tiles = new Map();
  const participantStates = new Map();
  const screenAudioStates = new Map();
  let spotlightActive = false;
  const placeholder = document.createElement('div');
  placeholder.className = 'stage-placeholder';
  placeholder.textContent = placeholderText;

  function initials(label) {
    return String(label || 'P').replace(/\s*\([^)]*\)\s*/g, ' ').trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  }

  function makeContainedDraggable(entry) {
    if (entry.dragBound) return;
    entry.dragBound = true;
    let drag = null;
    const move = (event) => {
      if (!drag || !entry.root.classList.contains('local-overlay')) return;
      const bounds = containerElement.getBoundingClientRect();
      const width = entry.root.offsetWidth;
      const height = entry.root.offsetHeight;
      entry.root.style.left = `${Math.max(8, Math.min(bounds.width - width - 8, drag.left + event.clientX - drag.x))}px`;
      entry.root.style.top = `${Math.max(8, Math.min(bounds.height - height - 8, drag.top + event.clientY - drag.y))}px`;
      entry.root.style.right = 'auto';
      entry.root.style.bottom = 'auto';
      entry.dragPosition = { left: entry.root.style.left, top: entry.root.style.top };
    };
    const end = () => {
      drag = null;
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', end);
    };
    entry.root.addEventListener('pointerdown', (event) => {
      if (!entry.root.classList.contains('local-overlay') || event.target.closest('button')) return;
      const rootRect = entry.root.getBoundingClientRect();
      const bounds = containerElement.getBoundingClientRect();
      drag = { x: event.clientX, y: event.clientY, left: rootRect.left - bounds.left, top: rootRect.top - bounds.top };
      entry.root.setPointerCapture?.(event.pointerId);
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', end);
    });
  }

  function tile(identity, source, label, options = {}) {
    const key = `${identity}|${source}`;
    if (tiles.has(key)) return tiles.get(key);
    const root = document.createElement('article');
    root.className = `tile video-tile ${source} source-${source}`;
    root.dataset.identity = identity;
    root.dataset.source = source;
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    const avatar = document.createElement('div');
    avatar.className = 'video-avatar';
    avatar.textContent = initials(label);
    const labelElement = document.createElement('span');
    labelElement.className = 'tile-label';
    labelElement.textContent = label;
    const mic = document.createElement('span');
    mic.className = 'tile-media-state';
    mic.setAttribute('aria-label', 'Micrófono apagado');
    mic.textContent = 'Mic apagado';
    root.append(video, avatar, labelElement, mic);
    const entry = { root, video, avatar, labelElement, mic, identity, source, track: null, local: options.local === true, dragBound: false, dragPosition: null };
    tiles.set(key, entry);
    makeContainedDraggable(entry);
    return entry;
  }

  function applyParticipantState(entry) {
    const state = participantStates.get(entry.identity) || {};
    if (entry.source === 'camera') {
      entry.root.classList.toggle('camera-off', !entry.root.classList.contains('has-video'));
      entry.mic.hidden = state.microphone === true;
      entry.mic.textContent = state.speaking ? 'Hablando' : 'Mic apagado';
      entry.root.classList.toggle('is-speaking', state.speaking === true);
    }
  }

  function setParticipantState(identity, label, state = {}) {
    const previous = participantStates.get(identity) || {};
    const next = { ...previous, ...state, label };
    participantStates.set(identity, next);
    let entry = tiles.get(`${identity}|camera`);
    if (!entry && (state.local || state.keepVisible)) entry = tile(identity, 'camera', label, { local: state.local });
    if (entry) {
      entry.local = next.local === true;
      entry.labelElement.textContent = label;
      entry.avatar.textContent = initials(label);
      applyParticipantState(entry);
    }
    layout();
  }

  function setTrack(identity, label, source, track, options = {}) {
    const entry = tile(identity, source, label, options);
    if (!track || track.kind !== 'video') return false;
    if (entry.track === track && entry.root.classList.contains('has-video')) return true;
    if (entry.track && entry.track !== track) entry.track.detach?.(entry.video);
    entry.track = track;
    entry.local = options.local === true || participantStates.get(identity)?.local === true;
    entry.labelElement.textContent = label;
    entry.avatar.textContent = initials(label);
    entry.video.hidden = false;
    entry.root.classList.remove('self-share-placeholder');
    entry.root.querySelector('.tile-self-placeholder')?.remove();
    track.attach(entry.video);
    entry.root.classList.add('has-video');
    entry.video.muted = options.muted === true;
    entry.video.play?.().catch(() => {});
    applyParticipantState(entry);
    if (source === 'screen') setScreenAudio(identity, screenAudioStates.get(identity) === true);
    layout();
    return true;
  }

  function setSelfSharePlaceholder(identity, label, { audio = false } = {}) {
    const entry = tile(identity, 'screen', label, { local: true });
    entry.root.classList.add('self-share-placeholder');
    entry.video.hidden = true;
    let message = entry.root.querySelector('.tile-self-placeholder');
    if (!message) {
      message = document.createElement('div');
      message.className = 'tile-self-placeholder';
      entry.root.appendChild(message);
    }
    message.innerHTML = `<strong>Estás compartiendo tu pantalla</strong><span>Los demás la ven en vivo.</span><span class="screen-audio-indicator">${audio ? 'Audio de pantalla incluido' : 'Sin audio de pantalla'}</span>`;
    layout();
  }

  function setScreenAudio(identity, active) {
    screenAudioStates.set(identity, active === true);
    const entry = tiles.get(`${identity}|screen`);
    if (!entry) return;
    let indicator = entry.root.querySelector('.screen-audio-indicator');
    if (!indicator) {
      indicator = document.createElement('span');
      indicator.className = 'screen-audio-indicator';
      entry.root.appendChild(indicator);
    }
    indicator.textContent = active ? 'Audio de pantalla activo' : 'Sin audio de pantalla';
    indicator.classList.toggle('active', active);
  }

  function removeTrack(identity, source) {
    const key = `${identity}|${source}`;
    const entry = tiles.get(key);
    if (!entry) return;
    entry.track?.detach?.(entry.video);
    entry.track = null;
    entry.root.classList.remove('has-video');
    if (source === 'camera' && participantStates.get(identity)?.keepVisible) {
      entry.video.srcObject = null;
      applyParticipantState(entry);
    } else {
      entry.video.srcObject = null;
      entry.root.remove();
      tiles.delete(key);
    }
    layout();
  }

  function removeParticipant(identity) {
    participantStates.delete(identity);
    screenAudioStates.delete(identity);
    for (const source of ['camera', 'screen']) {
      const entry = tiles.get(`${identity}|${source}`);
      entry?.track?.detach?.(entry.video);
      if (entry?.video) entry.video.srcObject = null;
      entry?.root.remove();
      tiles.delete(`${identity}|${source}`);
    }
    layout();
  }

  function setSpeaking(identities) {
    const active = new Set(identities || []);
    for (const [identity, state] of participantStates) participantStates.set(identity, { ...state, speaking: active.has(identity) });
    for (const entry of tiles.values()) applyParticipantState(entry);
  }

  function setParticipantVisibility(identity, visible) {
    const entry = tiles.get(`${identity}|camera`);
    if (!entry) return;
    entry.root.hidden = visible === false;
  }

  function layout() {
    containerElement.replaceChildren();
    if (!tiles.size) {
      containerElement.classList.remove('has-spotlight');
      containerElement.appendChild(placeholder);
      notify(false);
      return;
    }
    const screenEntry = [...tiles.entries()].find(([key]) => key.endsWith('|screen'));
    if (screenEntry) {
      containerElement.classList.add('has-spotlight');
      containerElement.appendChild(screenEntry[1].root);
      const thumbnails = document.createElement('div');
      thumbnails.className = 'spotlight-thumbs';
      for (const [key, entry] of tiles) {
        if (key === screenEntry[0]) continue;
        entry.root.classList.toggle('local-overlay', entry.local);
        if (entry.local) {
          containerElement.appendChild(entry.root);
          if (entry.dragPosition) Object.assign(entry.root.style, { left: entry.dragPosition.left, top: entry.dragPosition.top, right: 'auto', bottom: 'auto' });
        } else thumbnails.appendChild(entry.root);
      }
      if (thumbnails.children.length) containerElement.appendChild(thumbnails);
      notify(true);
    } else {
      containerElement.classList.remove('has-spotlight');
      for (const entry of tiles.values()) {
        entry.root.classList.remove('local-overlay');
        entry.root.style.removeProperty('left');
        entry.root.style.removeProperty('top');
        entry.root.style.removeProperty('right');
        entry.root.style.removeProperty('bottom');
        containerElement.appendChild(entry.root);
      }
      notify(false);
    }
  }

  function notify(active) {
    if (active !== spotlightActive) {
      spotlightActive = active;
      onSpotlightChange?.(active);
    }
  }

  layout();
  return { setTrack, setSelfSharePlaceholder, setScreenAudio, setParticipantState, setParticipantVisibility, setSpeaking, removeTrack, removeParticipant };
}

function attachRemoteStageEvents(room, stage) {
  const audioElements = new Map();
  if (!document.documentElement.dataset.mediaResumeBound) {
    document.documentElement.dataset.mediaResumeBound = 'true';
    document.addEventListener('click', () => document.querySelectorAll('video, audio').forEach((media) => { if (media.paused) media.play?.().catch(() => {}); }));
  }
  const handlers = {
    subscribed(track, publication, participant) {
      const source = classifyTrackSource(publication);
      if (track.kind === 'audio') {
        const element = track.attach();
        const key = `${participant.identity}|${source}`;
        const previous = audioElements.get(key);
        if (previous?.element && previous.element !== element) previous.track?.detach?.(previous.element);
        previous?.element?.remove();
        element.classList.add('room-remote-audio');
        element.dataset.identity = participant.identity;
        element.dataset.source = source;
        document.body.appendChild(element);
        audioElements.set(key, { element, track });
        const speaker = document.getElementById('speakerSelect')?.value;
        if (speaker) element.setSinkId?.(speaker).catch(() => {});
        if (source === 'screen-audio') stage.setScreenAudio(participant.identity, true);
        return;
      }
      const label = participant.name || participant.identity;
      stage.setParticipantState(participant.identity, label, { microphone: publicationHasActiveMicrophone(participant), keepVisible: true });
      stage.setTrack(participant.identity, source === 'screen' ? `${label} (pantalla)` : label, source, track);
    },
    unsubscribed(track, publication, participant) {
      const source = classifyTrackSource(publication);
      if (track.kind !== 'audio') stage.removeTrack(participant.identity, source);
      else {
        const key = `${participant.identity}|${source}`;
        const attached = audioElements.get(key);
        attached?.track?.detach?.(attached.element);
        attached?.element?.remove();
        audioElements.delete(key);
        if (source === 'screen-audio') stage.setScreenAudio(participant.identity, false);
      }
      track.detach?.().forEach?.((element) => element.remove());
    },
    published(publication, participant) {
      const source = classifyTrackSource(publication);
      if (publication.track?.kind === 'video' && publication.isMuted !== true) handlers.subscribed(publication.track, publication, participant);
      else if (source === 'camera') stage.setParticipantState(participant.identity, participant.name || participant.identity, { keepVisible: true });
    },
    unpublished(publication, participant) {
      const source = classifyTrackSource(publication);
      if (source === 'screen-audio') stage.setScreenAudio(participant.identity, false);
      else if (source === 'screen' || source === 'camera') stage.removeTrack(participant.identity, source);
    },
    participantDisconnected(participant) { stage.removeParticipant(participant.identity); },
    activeSpeakers(participants) { stage.setSpeaking(participants.map((participant) => participant.identity)); },
    trackMuted(publication, participant) {
      const source = classifyTrackSource(publication);
      if (source === 'microphone') stage.setParticipantState(participant.identity, participant.name || participant.identity, { microphone: false, keepVisible: true });
      if (source === 'camera' || source === 'screen') stage.removeTrack(participant.identity, source);
    },
    trackUnmuted(publication, participant) {
      const source = classifyTrackSource(publication);
      if (source === 'microphone') stage.setParticipantState(participant.identity, participant.name || participant.identity, { microphone: true, keepVisible: true });
      if ((source === 'camera' || source === 'screen') && publication.track) handlers.subscribed(publication.track, publication, participant);
    },
  };
  function publicationHasActiveMicrophone(participant) {
    const publication = participant.getTrackPublication?.(LivekitClient.Track.Source.Microphone);
    const mediaTrack = publication?.track?.mediaStreamTrack;
    return Boolean(publication?.track && !publication.isMuted && (!mediaTrack || mediaTrack.readyState === 'live'));
  }
  const bindings = [
    [LivekitClient.RoomEvent.TrackSubscribed, handlers.subscribed],
    [LivekitClient.RoomEvent.TrackUnsubscribed, handlers.unsubscribed],
    [LivekitClient.RoomEvent.TrackPublished, handlers.published],
    [LivekitClient.RoomEvent.TrackUnpublished, handlers.unpublished],
    [LivekitClient.RoomEvent.ParticipantDisconnected, handlers.participantDisconnected],
    [LivekitClient.RoomEvent.ActiveSpeakersChanged, handlers.activeSpeakers],
    [LivekitClient.RoomEvent.TrackMuted, handlers.trackMuted],
    [LivekitClient.RoomEvent.TrackUnmuted, handlers.trackUnmuted],
  ].filter(([event]) => event);
  bindings.forEach(([event, handler]) => room.on(event, handler));
  return { dispose() {
    bindings.forEach(([event, handler]) => room.off(event, handler));
    for (const { element, track } of audioElements.values()) {
      track?.detach?.(element);
      element.remove();
    }
    audioElements.clear();
  } };
}

if (typeof module === 'object' && module.exports) module.exports = { classifyTrackSource, normalizeTrackSource };
