// Shared chat helper built on LiveKit's data channel (no separate chat backend needed).
function setupChat(room, myIdentity) {
  const messagesEl = document.getElementById('chatMessages');
  const formEl = document.getElementById('chatForm');
  const inputEl = document.getElementById('chatInput');
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function render(from, text, isMe) {
    const row = document.createElement('div');
    row.className = 'chat-msg';
    row.innerHTML = `<span class="who${isMe ? ' me' : ''}">${from}</span><span></span>`;
    row.querySelector('span:last-child').textContent = text;
    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  room.on(LivekitClient.RoomEvent.DataReceived, (payload, participant) => {
    try {
      const msg = JSON.parse(decoder.decode(payload));
      if (msg.kind !== 'chat') return; // other kinds (e.g. recording-status) are handled elsewhere
      render(participant?.identity || 'desconocido', msg.text, false);
    } catch (e) {
      console.error('chat decode error', e);
    }
  });

  formEl.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = inputEl.value.trim();
    if (!text) return;
    const payload = encoder.encode(JSON.stringify({ kind: 'chat', text }));
    room.localParticipant.publishData(payload, { reliable: true });
    render(myIdentity, text, true);
    inputEl.value = '';
  });
}

// Broadcasts recording on/off so every participant's UI can show a live indicator.
function broadcastRecordingStatus(room, active) {
  const encoder = new TextEncoder();
  const payload = encoder.encode(JSON.stringify({ kind: 'recording-status', active }));
  room.localParticipant.publishData(payload, { reliable: true });
}

function onRecordingStatus(room, callback) {
  const decoder = new TextDecoder();
  room.on(LivekitClient.RoomEvent.DataReceived, (payload) => {
    try {
      const msg = JSON.parse(decoder.decode(payload));
      if (msg.kind === 'recording-status') callback(msg.active);
    } catch (e) {
      console.error('recording-status decode error', e);
    }
  });
}
