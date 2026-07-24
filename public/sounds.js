// Short notification tones synthesized with the Web Audio API — no external
// audio files to host or license. Muting preference persists across visits.
const SOUNDS_MUTE_KEY = 'ratSoundsMuted';
let audioCtx = null;

function isMuted() {
  return localStorage.getItem(SOUNDS_MUTE_KEY) === '1';
}

function setMuted(muted) {
  localStorage.setItem(SOUNDS_MUTE_KEY, muted ? '1' : '0');
}

function getAudioCtx() {
  if (!audioCtx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioCtx();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function tone(startTime, freq, duration, peakGain) {
  const ctx = getAudioCtx();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(peakGain, startTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startTime);
  osc.stop(startTime + duration + 0.05);
}

function playIfUnmuted(fn) {
  if (isMuted()) return;
  try {
    fn();
  } catch (e) {
    console.warn('sound playback failed', e);
  }
}

// You successfully joined the room.
function playConnectedSound() {
  playIfUnmuted(() => {
    const t = getAudioCtx().currentTime;
    tone(t, 523.25, 0.14, 0.12); // C5
    tone(t + 0.1, 783.99, 0.2, 0.12); // G5
  });
}

// Someone else joined.
function playJoinSound() {
  playIfUnmuted(() => {
    const t = getAudioCtx().currentTime;
    tone(t, 659.25, 0.1, 0.09); // E5
    tone(t + 0.08, 880.0, 0.16, 0.09); // A5
  });
}

// Someone left.
function playLeaveSound() {
  playIfUnmuted(() => {
    const t = getAudioCtx().currentTime;
    tone(t, 587.33, 0.1, 0.09); // D5
    tone(t + 0.08, 392.0, 0.18, 0.09); // G4 (descending = leaving)
  });
}

function attachSoundToggle(btn) {
  if (!btn) return;
  function render() {
    btn.textContent = isMuted() ? '🔇' : '🔊';
    btn.title = isMuted() ? 'Activar sonidos' : 'Silenciar sonidos';
  }
  btn.onclick = () => {
    setMuted(!isMuted());
    render();
  };
  render();
}
