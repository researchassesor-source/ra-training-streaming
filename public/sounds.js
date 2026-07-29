const SOUND_SETTINGS_KEY = 'ratSoundSettingsV2';
const SOUND_TYPES = Object.freeze({
  message: { label: 'Nuevo mensaje', notes: [659, 784] },
  reaction: { label: 'Nueva reacción', notes: [784] },
  hand: { label: 'Mano levantada', notes: [523, 659, 784] },
  join: { label: 'Participante conectado', notes: [659, 880] },
  leave: { label: 'Participante desconectado', notes: [587, 392] },
  unstable: { label: 'Conexión inestable', notes: [330, 277] },
  reconnected: { label: 'Reconexión', notes: [440, 659] },
  recordingStart: { label: 'Grabación iniciada', notes: [392, 523] },
  recordingStop: { label: 'Grabación detenida', notes: [523, 392] },
  critical: { label: 'Error crítico', notes: [220, 185] },
});

let soundContext = null;
const lastPlayed = new Map();

function defaultSoundSettings() {
  return { enabled: true, volume: 0.45, types: Object.fromEntries(Object.keys(SOUND_TYPES).map((type) => [type, true])) };
}

function getSoundSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(SOUND_SETTINGS_KEY) || 'null');
    return { ...defaultSoundSettings(), ...(stored || {}), types: { ...defaultSoundSettings().types, ...(stored?.types || {}) } };
  } catch { return defaultSoundSettings(); }
}

function saveSoundSettings(settings) {
  localStorage.setItem(SOUND_SETTINGS_KEY, JSON.stringify(settings));
}

function audioContext() {
  if (!soundContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    soundContext = new AudioContextClass();
  }
  if (soundContext.state === 'suspended') soundContext.resume().catch(() => {});
  return soundContext;
}

function soundTone(context, start, frequency, duration, gainValue) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = 'sine'; oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(gainValue, start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain); gain.connect(context.destination);
  oscillator.start(start); oscillator.stop(start + duration + 0.03);
}

function playAlert(type) {
  const settings = getSoundSettings();
  if (!settings.enabled || !settings.types[type] || !SOUND_TYPES[type]) return;
  const now = Date.now();
  const cooldown = ['message', 'reaction'].includes(type) ? 1_200 : 500;
  if (now - (lastPlayed.get(type) || 0) < cooldown) return;
  lastPlayed.set(type, now);
  try {
    const context = audioContext();
    if (!context) return;
    const start = context.currentTime;
    SOUND_TYPES[type].notes.forEach((frequency, index) => soundTone(context, start + index * .09, frequency, .14, Math.max(.015, settings.volume * .13)));
  } catch (error) { console.warn('No se pudo reproducir la alerta', error); }
}

function attachSoundToggle(button) {
  if (!button) return;
  function render() {
    const settings = getSoundSettings();
    button.textContent = settings.enabled ? 'Sonido activo' : 'Sonido apagado';
    button.setAttribute('aria-pressed', String(settings.enabled));
  }
  button.addEventListener('click', () => {
    const settings = getSoundSettings(); settings.enabled = !settings.enabled; saveSoundSettings(settings); render();
    if (settings.enabled) playAlert('reconnected');
  });
  render();
}

function renderSoundSettings(container) {
  if (!container) return;
  const settings = getSoundSettings();
  container.replaceChildren();
  const volumeLabel = document.createElement('label'); volumeLabel.textContent = 'Volumen';
  const volume = document.createElement('input'); volume.type = 'range'; volume.min = '0'; volume.max = '1'; volume.step = '.05'; volume.value = String(settings.volume);
  volume.addEventListener('input', () => { settings.volume = Number(volume.value); saveSoundSettings(settings); });
  volumeLabel.appendChild(volume); container.appendChild(volumeLabel);
  for (const [type, detail] of Object.entries(SOUND_TYPES)) {
    const label = document.createElement('label'); label.className = 'check-row';
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = settings.types[type];
    input.addEventListener('change', () => { settings.types[type] = input.checked; saveSoundSettings(settings); });
    label.append(input, document.createTextNode(detail.label)); container.appendChild(label);
  }
}

async function requestNotificationPermission() {
  if (!('Notification' in window)) throw new Error('Este navegador no admite notificaciones del sistema.');
  if (Notification.permission === 'granted') return true;
  return (await Notification.requestPermission()) === 'granted';
}

function systemNotification(title, body) {
  if (document.visibilityState === 'visible' || !('Notification' in window) || Notification.permission !== 'granted') return;
  const notification = new Notification(title, { body, icon: '/assets/logo.png', tag: `rat-${title}` });
  notification.onclick = () => { window.focus(); notification.close(); };
}

function playConnectedSound() { playAlert('reconnected'); }
function playJoinSound() { playAlert('join'); }
function playLeaveSound() { playAlert('leave'); }
