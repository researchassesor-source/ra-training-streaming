renderBrand(document.getElementById('brand'), { tagline: false });
const list = document.getElementById('recordingList');

async function loadRecordings() {
  list.textContent = 'Cargando…';
  const room = document.getElementById('roomFilter').value.trim();
  try {
    const response = await fetch(`/api/recordings${room ? `?room=${encodeURIComponent(room)}` : ''}`, { credentials: 'same-origin' });
    if (response.status === 401) return void window.location.replace('/index.html');
    const data = await response.json();
    if (!response.ok) { const error = new Error(data.error || 'No se pudieron cargar las grabaciones'); error.code = data.code; throw error; }
    list.replaceChildren();
    if (!data.items.length) { list.className = 'empty-state branded-empty'; const image = document.createElement('img'); image.src = 'assets/icon-192.png'; image.alt = 'Icono de R.A. Training Streaming'; const message = document.createElement('strong'); message.textContent = 'No hay grabaciones disponibles.'; list.append(image, message); return; }
    list.className = 'recordings-list';
    for (const item of data.items) {
      const card = document.createElement('article'); card.className = 'recording-card';
      const info = document.createElement('div');
      const title = document.createElement('h2'); title.textContent = item.title;
      const date = new Date(item.lastModified); const safeDate = Number.isNaN(date.getTime()) ? 'Fecha por definir' : date.toLocaleString('es-EC');
      const meta = document.createElement('p'); meta.className = 'muted'; meta.textContent = `${item.trainerName || 'Capacitador por definir'} · ${safeDate} · ${(Number(item.size || 0) / 1024 / 1024).toFixed(1)} MB`;
      const link = document.createElement('a'); link.className = 'button secondary'; link.href = item.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Abrir';
      const actions = document.createElement('div'); actions.className = 'meeting-actions'; if (item.url) actions.appendChild(link);
      if (item.transcript) { const transcript = document.createElement('a'); transcript.className = 'button primary'; transcript.href = `/transcription.html?id=${encodeURIComponent(item.transcript.id)}`; transcript.textContent = 'Ver transcripción'; actions.appendChild(transcript); }
      info.append(title, meta); card.append(info, actions); list.appendChild(card);
    }
  } catch (error) {
    list.replaceChildren(); list.className = error.code === 'STORAGE_NOT_CONFIGURED' ? 'empty-state branded-empty' : 'form-error';
    if (error.code === 'STORAGE_NOT_CONFIGURED') { const image = document.createElement('img'); image.src = 'assets/icon-192.png'; image.alt = 'Icono de R.A. Training Streaming'; const title = document.createElement('strong'); title.textContent = 'Las grabaciones no están disponibles en este entorno.'; const detail = document.createElement('span'); detail.textContent = 'Revisa el estado de almacenamiento y grabación en Configuración.'; const actions = document.createElement('div'); actions.className = 'dialog-actions'; const settings = document.createElement('a'); settings.href = '/dashboard.html#settings'; settings.className = 'button secondary compact'; settings.textContent = 'Ver configuración'; const guide = document.createElement('a'); guide.href = '/docs/LOCAL_DEVELOPMENT.md'; guide.className = 'button secondary compact'; guide.textContent = 'Consultar guía'; guide.target = '_blank'; guide.rel = 'noopener'; actions.append(settings, guide); list.append(image, title, detail, actions); }
    else list.textContent = error.message;
  }
}

document.getElementById('searchButton').addEventListener('click', loadRecordings);
loadRecordings();
