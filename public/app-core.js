(function exposeAppCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RATCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildAppCore() {
  const CONNECTION_STATES = Object.freeze({
    validating_invitation: 'Validando invitación…',
    waiting_for_room: 'Esperando al organizador…',
    requesting_permissions: 'Solicitando permisos…',
    connecting_signaling: 'Conectando con la reunión…',
    connecting_media: 'Conectando audio y video…',
    connected: 'Conectado',
    poor_connection: 'Conexión inestable',
    reconnecting: 'Reconectando…',
    disconnected: 'No fue posible reconectar',
    access_denied: 'Tu acceso fue retirado',
    removed: 'Tu acceso fue retirado',
    room_ended: 'El organizador finalizó la reunión',
  });

  const RECORDING_STATES = Object.freeze({
    DISABLED: 'No disponible',
    IDLE: 'Lista para iniciar',
    STARTING: 'Iniciando…',
    RECORDING: 'Grabando',
    STOPPING: 'Deteniendo…',
    PROCESSING: 'Procesando grabación…',
    FAILED: 'No se pudo consultar la grabación',
  });

  const ROLE_LABELS = Object.freeze({
    ADMIN: 'Administrador',
    ORGANIZER: 'Organizador',
    PANELIST: 'Panelista',
    VIEWER: 'Asistente',
  });

  const MEETING_DEFAULTS = Object.freeze({
    description: '', trainerName: 'Capacitador por definir', durationMinutes: 60,
    type: 'WEBINAR', status: 'SCHEDULED', capacity: 100, allowChat: true,
    allowFiles: true, allowReactions: true, allowRaiseHand: true, allowRecording: false,
    allowQuestions: true,
    recordingConsentRequired: false, allowTranscription: false,
    transcriptionConsentRequired: false, transcriptionLanguage: 'es',
    transcriptionRetentionDays: 90, allowPanelistTranscriptAccess: false,
    deletedAt: null, cancelledAt: null, archivedAt: null,
  });

  function validDate(value) {
    if (!value) return null;
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function localDateKey(value) {
    const date = validDate(value);
    if (!date) return '';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function calendarRange(anchor, view = 'month') {
    const date = validDate(anchor) || new Date();
    let start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    let count = 1;
    if (view === 'month') {
      start = new Date(date.getFullYear(), date.getMonth(), 1);
      start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
      count = 42;
    } else if (view === 'week') {
      start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
      count = 7;
    }
    return Array.from({ length: count }, (_, index) => {
      const day = new Date(start);
      day.setDate(start.getDate() + index);
      return day;
    });
  }

  function meetingsForLocalDay(items, day) {
    const key = localDateKey(day);
    return (Array.isArray(items) ? items : [])
      .filter((meeting) => localDateKey(meeting?.scheduledAt) === key)
      .sort((a, b) => String(a.scheduledAt || '').localeCompare(String(b.scheduledAt || '')));
  }

  function upcomingMeetings(items, now = new Date(), limit = 5) {
    const threshold = (validDate(now) || new Date()).getTime();
    return (Array.isArray(items) ? items : [])
      .filter((meeting) => {
        const scheduled = validDate(meeting?.scheduledAt);
        return scheduled && scheduled.getTime() >= threshold && !['CANCELLED', 'COMPLETED', 'ARCHIVED'].includes(meeting.status);
      })
      .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))
      .slice(0, Math.max(0, limit));
  }

  function normalizeMeeting(raw = {}) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const durationMinutes = Number.isInteger(Number(source.durationMinutes)) && Number(source.durationMinutes) > 0 ? Number(source.durationMinutes) : 60;
    const capacity = Number.isInteger(Number(source.capacity)) && Number(source.capacity) >= 0 ? Number(source.capacity) : 100;
    const scheduledDate = validDate(source.scheduledAt);
    const endDate = validDate(source.endsAt) || (scheduledDate ? new Date(scheduledDate.getTime() + durationMinutes * 60_000) : null);
    const meeting = {
      ...MEETING_DEFAULTS,
      ...source,
      title: typeof source.title === 'string' && source.title.trim() ? source.title : 'Reunión sin título',
      room: typeof source.room === 'string' && source.room.trim() ? source.room : 'sala-por-definir',
      description: typeof source.description === 'string' ? source.description : '',
      trainerName: typeof source.trainerName === 'string' && source.trainerName.trim() ? source.trainerName : 'Capacitador por definir',
      durationMinutes,
      capacity,
      scheduledAt: scheduledDate ? scheduledDate.toISOString() : null,
      endsAt: endDate ? endDate.toISOString() : null,
    };
    for (const [name, fallback] of Object.entries(MEETING_DEFAULTS)) {
      if (typeof fallback === 'boolean' && typeof source[name] !== 'boolean') meeting[name] = fallback;
    }
    return meeting;
  }

  class RecordingStateMachine {
    constructor(onChange, configured = false) {
      this.onChange = typeof onChange === 'function' ? onChange : () => {};
      this.state = configured ? 'IDLE' : 'DISABLED';
      this.egressId = null;
      this.emit();
    }

    set(next, { egressId = null, active = false, message = '' } = {}) {
      const state = Object.prototype.hasOwnProperty.call(RECORDING_STATES, next) ? next : 'FAILED';
      this.state = state;
      this.egressId = state === 'RECORDING' && active === true ? egressId : null;
      return this.emit(message);
    }

    emit(message = '') {
      const snapshot = {
        state: this.state,
        label: message || RECORDING_STATES[this.state],
        active: this.state === 'RECORDING' && Boolean(this.egressId),
        busy: ['STARTING', 'STOPPING'].includes(this.state),
        egressId: this.egressId,
      };
      this.onChange(snapshot);
      return snapshot;
    }
  }

  function shouldSubmitChat(event = {}) {
    return event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
  }

  function roleLabel(role) {
    return ROLE_LABELS[String(role || '').toUpperCase()] || 'Participante';
  }

  function roomConnectionErrorMessage(error = {}) {
    const message = typeof error.message === 'string' ? error.message.trim() : '';
    const code = String(error.code || error.name || '').toUpperCase();
    const status = Number(error.status || 0);
    if (status === 401 || status === 403 || status === 410 || ['ROOM_ENDED', 'ROOM_REVOKED', 'ROOM_NOT_REGISTERED', 'MEETING_NOT_JOINABLE'].includes(code)) {
      return message || 'Tu acceso a la reunión ya no está disponible.';
    }
    return 'No se pudo conectar al servicio de videoconferencia. Verifica la disponibilidad del servidor LiveKit e inténtalo nuevamente.';
  }

  class ConnectionStateMachine {
    constructor(onChange, initial = 'validating_invitation') {
      this.onChange = typeof onChange === 'function' ? onChange : () => {};
      this.state = null;
      this.set(initial);
    }

    set(next, detail = '') {
      if (!Object.prototype.hasOwnProperty.call(CONNECTION_STATES, next)) throw new Error(`Estado desconocido: ${next}`);
      if (next === this.state && !detail) return this.snapshot();
      this.state = next;
      const snapshot = this.snapshot(detail);
      this.onChange(snapshot);
      return snapshot;
    }

    snapshot(detail = '') {
      return {
        state: this.state,
        label: detail || CONNECTION_STATES[this.state],
        connected: this.state === 'connected' || this.state === 'poor_connection',
        terminal: ['disconnected', 'access_denied', 'removed', 'room_ended'].includes(this.state),
      };
    }
  }

  function createUnreadCounter(onChange) {
    let count = 0;
    const emit = () => {
      if (typeof onChange === 'function') onChange(count);
      return count;
    };
    return {
      increment(amount = 1) { count = Math.max(0, count + amount); return emit(); },
      clear() { count = 0; return emit(); },
      get value() { return count; },
    };
  }

  class HandQueue {
    constructor() {
      this.items = [];
    }

    raise(identity, displayName = identity, raisedAt = new Date().toISOString()) {
      const existing = this.items.find((item) => item.identity === identity);
      if (existing) return existing;
      const item = { identity, displayName, raisedAt, status: 'PENDING', order: this.items.length + 1 };
      this.items.push(item);
      return item;
    }

    update(identity, status) {
      const item = this.items.find((entry) => entry.identity === identity);
      if (!item) return null;
      item.status = status;
      return item;
    }

    remove(identity) {
      const index = this.items.findIndex((entry) => entry.identity === identity);
      if (index < 0) return false;
      this.items.splice(index, 1);
      this.items.forEach((item, itemIndex) => { item.order = itemIndex + 1; });
      return true;
    }

    list() { return this.items.map((item) => ({ ...item })); }
  }

  function createFloatingModel(initial = {}) {
    const state = {
      live: false,
      title: '',
      participants: 1,
      raisedHands: 0,
      unreadMessages: 0,
      unreadQuestions: 0,
      pendingQuestions: 0,
      recentReaction: '',
      recording: false,
      connection: 'validating_invitation',
      microphone: false,
      camera: false,
      screen: false,
      handRaised: false,
      panel: 'chat',
      elapsedSeconds: 0,
      quality: 'unknown',
      locked: false,
      role: 'VIEWER',
      mode: 'WEBINAR',
      chatMessages: [],
      chatDraft: '',
      participantItems: [],
      ...initial,
    };
    const listeners = new Set();
    return {
      update(patch) {
        Object.assign(state, patch);
        for (const listener of listeners) listener({ ...state });
        return { ...state };
      },
      subscribe(listener) { listeners.add(listener); listener({ ...state }); return () => listeners.delete(listener); },
      snapshot() { return { ...state }; },
    };
  }

  function safeHttpUrl(value, base = 'https://app.invalid') {
    try {
      const parsed = new URL(String(value), base);
      return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null;
    } catch {
      return null;
    }
  }

  function isLivePublication(publication, kind) {
    const track = publication?.track;
    if (!track || publication.isMuted === true || (kind && track.kind !== kind)) return false;
    const mediaTrack = track.mediaStreamTrack;
    return !mediaTrack || mediaTrack.readyState === 'live';
  }

  return {
    CONNECTION_STATES,
    MEETING_DEFAULTS,
    RECORDING_STATES,
    ROLE_LABELS,
    ConnectionStateMachine,
    HandQueue,
    RecordingStateMachine,
    createFloatingModel,
    createUnreadCounter,
    calendarRange,
    localDateKey,
    meetingsForLocalDay,
    isLivePublication,
    normalizeMeeting,
    roleLabel,
    roomConnectionErrorMessage,
    safeHttpUrl,
    shouldSubmitChat,
    upcomingMeetings,
    validDate,
  };
}));
