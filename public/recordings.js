renderBrand(document.getElementById('brand'), { tagline: false });
const list = document.getElementById('recordingList');

async function loadRecordings() {
  list.textContent = 'Cargando…';
  const room = document.getElementById('roomFilter').value.trim();
  try {
    const response = await fetch(`/api/recordings${room ? `?room=${encodeURIComponent(room)}` : ''}`, { credentials: 'same-origin' });
    if (response.status === 401) return void window.location.replace('/index.html');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'No se pudieron cargar las grabaciones');
    list.replaceChildren();
    if (!data.items.length) { list.className = 'empty-state'; list.textContent = 'No hay grabaciones disponibles.'; return; }
    list.className = 'recordings-list';
    for (const item of data.items) {
      const card = document.createElement('article'); card.className = 'recording-card';
      const info = document.createElement('div');
      const title = document.createElement('h2'); title.textContent = item.title;
      const meta = document.createElement('p'); meta.className = 'muted'; meta.textContent = `${item.trainerName || 'Sin capacitador'} · ${new Date(item.lastModified).toLocaleString('es-EC')} · ${(item.size / 1024 / 1024).toFixed(1)} MB`;
      const link = document.createElement('a'); link.className = 'button secondary'; link.href = item.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Abrir';
      info.append(title, meta); card.append(info, link); list.appendChild(card);
    }
  } catch (error) { list.className = 'form-error'; list.textContent = error.message; }
}

document.getElementById('searchButton').addEventListener('click', loadRecordings);
loadRecordings();
