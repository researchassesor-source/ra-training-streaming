const EMOJI_SET = [
  '😀','😂','😍','😎','🤔','😅','😢','😡','👍','👎','👏','🙌','🙏','💪','🔥','🎉',
  '❤️','✅','❌','⚠️','👋','🤝','😴','🤯','🥳','😮','🙋','💡','📌','⭐','🚀','👀',
];

// Shared chat helper built on LiveKit's data channel (no separate chat backend needed).
function setupChat(room, myIdentity, opts = {}) {
  const roomName = opts.roomName || 'webinar-demo';
  const messagesEl = document.getElementById('chatMessages');
  const formEl = document.getElementById('chatForm');
  const inputEl = document.getElementById('chatInput');
  const emojiBtn = document.getElementById('emojiBtn');
  const emojiPicker = document.getElementById('emojiPicker');
  const fileBtn = document.getElementById('fileBtn');
  const fileInput = document.getElementById('fileInput');
  const uploadStatus = document.getElementById('uploadStatus');
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function render(from, msg, isMe) {
    const row = document.createElement('div');
    if (msg.type === 'file') {
      row.className = 'chat-msg file';
      const who = document.createElement('span');
      who.className = 'who' + (isMe ? ' me' : '');
      who.textContent = from;
      row.appendChild(who);
      if (msg.mimetype && msg.mimetype.startsWith('image/')) {
        const img = document.createElement('img');
        img.className = 'file-preview';
        img.src = msg.url;
        img.alt = msg.filename;
        row.appendChild(img);
      }
      const link = document.createElement('a');
      link.className = 'file-link';
      link.href = msg.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = `📎 ${msg.filename} (${formatSize(msg.size)})`;
      row.appendChild(link);
    } else {
      row.className = 'chat-msg';
      row.innerHTML = `<span class="who${isMe ? ' me' : ''}">${from}</span><span></span>`;
      row.querySelector('span:last-child').textContent = msg.text;
    }
    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  room.on(LivekitClient.RoomEvent.DataReceived, (payload, participant) => {
    try {
      const msg = JSON.parse(decoder.decode(payload));
      if (msg.kind !== 'chat') return; // other kinds (e.g. recording-status) are handled elsewhere
      render(participant?.identity || 'desconocido', msg, false);
      opts.onMessage?.(participant?.identity, msg);
    } catch (e) {
      console.error('chat decode error', e);
    }
  });

  formEl.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = inputEl.value.trim();
    if (!text) return;
    const msg = { kind: 'chat', type: 'text', text };
    room.localParticipant.publishData(encoder.encode(JSON.stringify(msg)), { reliable: true });
    render(myIdentity, msg, true);
    inputEl.value = '';
  });

  if (emojiBtn && emojiPicker) {
    if (!emojiPicker.dataset.built) {
      for (const emoji of EMOJI_SET) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = emoji;
        b.onclick = () => {
          inputEl.value += emoji;
          inputEl.focus();
        };
        emojiPicker.appendChild(b);
      }
      emojiPicker.dataset.built = '1';
    }
    emojiBtn.onclick = () => {
      emojiPicker.hidden = !emojiPicker.hidden;
    };
    document.addEventListener('click', (ev) => {
      if (!emojiPicker.hidden && !emojiPicker.contains(ev.target) && ev.target !== emojiBtn) {
        emojiPicker.hidden = true;
      }
    });
  }

  if (fileBtn && fileInput) {
    fileBtn.onclick = () => fileInput.click();
    fileInput.onchange = async () => {
      const file = fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      if (uploadStatus) uploadStatus.textContent = `Subiendo ${file.name}…`;
      try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('room', roomName);
        const res = await fetch('/api/chat/upload', { method: 'POST', body: formData });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'error desconocido');
        const msg = { kind: 'chat', type: 'file', url: data.url, filename: data.filename, size: data.size, mimetype: data.mimetype };
        room.localParticipant.publishData(encoder.encode(JSON.stringify(msg)), { reliable: true });
        render(myIdentity, msg, true);
        if (uploadStatus) uploadStatus.textContent = '';
      } catch (err) {
        if (uploadStatus) uploadStatus.textContent = 'Error al subir: ' + err.message;
      }
    };
  }
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
