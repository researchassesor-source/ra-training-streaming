const MEETING_TYPES = Object.freeze(['WEBINAR', 'SESSION', 'CLASS']);

const MEETING_ROLES = Object.freeze({
  WEBINAR: Object.freeze(['HOST', 'COHOST', 'MODERATOR', 'PANELIST', 'ATTENDEE']),
  SESSION: Object.freeze(['HOST', 'COHOST', 'MODERATOR', 'PARTICIPANT']),
  CLASS: Object.freeze(['TEACHER', 'COHOST', 'MODERATOR', 'STUDENT']),
});

const ROLE_LABELS = Object.freeze({
  HOST: 'Anfitrión',
  TEACHER: 'Docente',
  COHOST: 'Coanfitrión',
  MODERATOR: 'Moderador',
  PANELIST: 'Panelista',
  ATTENDEE: 'Asistente',
  PARTICIPANT: 'Participante',
  STUDENT: 'Estudiante',
});

const SOURCE = Object.freeze({
  CAMERA: 'CAMERA',
  MICROPHONE: 'MICROPHONE',
  SCREEN_SHARE: 'SCREEN_SHARE',
  SCREEN_SHARE_AUDIO: 'SCREEN_SHARE_AUDIO',
});

function normalizeMeetingType(value) {
  const type = String(value || 'WEBINAR').toUpperCase();
  return MEETING_TYPES.includes(type) ? type : 'WEBINAR';
}

function legacyDefaultMeetingRole(type, legacyRole) {
  const meetingType = normalizeMeetingType(type);
  const role = String(legacyRole || 'VIEWER').toUpperCase();
  if (role === 'ADMIN' || role === 'ORGANIZER') return meetingType === 'CLASS' ? 'TEACHER' : 'HOST';
  if (role === 'PANELIST') {
    if (meetingType === 'SESSION') return 'PARTICIPANT';
    if (meetingType === 'CLASS') return 'STUDENT';
    return 'PANELIST';
  }
  if (meetingType === 'SESSION') return 'PARTICIPANT';
  if (meetingType === 'CLASS') return 'STUDENT';
  return 'ATTENDEE';
}

function normalizeMeetingRole(type, value, legacyRole = 'VIEWER') {
  const meetingType = normalizeMeetingType(type);
  const requested = String(value || '').toUpperCase();
  return MEETING_ROLES[meetingType].includes(requested)
    ? requested
    : legacyDefaultMeetingRole(meetingType, legacyRole);
}

function legacyRoleForMeetingRole(type, meetingRole, fallback = 'VIEWER') {
  const role = normalizeMeetingRole(type, meetingRole, fallback);
  if (role === 'HOST' || role === 'TEACHER' || role === 'COHOST') return 'ORGANIZER';
  if (role === 'ATTENDEE') return 'VIEWER';
  return 'PANELIST';
}

function roleCapabilities(type, meetingRole) {
  const meetingType = normalizeMeetingType(type);
  const role = normalizeMeetingRole(meetingType, meetingRole);
  const host = role === 'HOST' || role === 'TEACHER';
  const cohost = role === 'COHOST';
  const moderator = role === 'MODERATOR';
  const capabilities = {
    canStartMeeting: host || cohost,
    canEndMeeting: host || cohost,
    canManageRoom: host || cohost,
    canManageInvitations: host || cohost,
    canManageParticipants: host || cohost,
    canModerateChat: host || cohost || moderator,
    canModerateQuestions: host || cohost || moderator,
    canManageRecording: host,
    canViewDiagnostics: host || cohost,
    canUsePresenterPanel: role !== 'ATTENDEE',
    canRaiseHand: !host && !cohost,
  };
  return Object.freeze(capabilities);
}

function basePublishSources(type, meetingRole, settings = {}) {
  const meetingType = normalizeMeetingType(type);
  const role = normalizeMeetingRole(meetingType, meetingRole);
  if (meetingType === 'WEBINAR') {
    if (['HOST', 'COHOST'].includes(role)) return [SOURCE.CAMERA, SOURCE.MICROPHONE, SOURCE.SCREEN_SHARE, SOURCE.SCREEN_SHARE_AUDIO];
    if (role === 'PANELIST') return settings.allowPanelistScreenShare === false
      ? [SOURCE.CAMERA, SOURCE.MICROPHONE]
      : [SOURCE.CAMERA, SOURCE.MICROPHONE, SOURCE.SCREEN_SHARE, SOURCE.SCREEN_SHARE_AUDIO];
    if (role === 'MODERATOR') return [SOURCE.CAMERA, SOURCE.MICROPHONE];
    return [];
  }
  if (meetingType === 'SESSION') return role === 'PARTICIPANT' && settings.allowParticipantScreenShare === false
    ? [SOURCE.CAMERA, SOURCE.MICROPHONE]
    : [SOURCE.CAMERA, SOURCE.MICROPHONE, SOURCE.SCREEN_SHARE, SOURCE.SCREEN_SHARE_AUDIO];
  if (['TEACHER', 'COHOST'].includes(role)) return [SOURCE.CAMERA, SOURCE.MICROPHONE, SOURCE.SCREEN_SHARE, SOURCE.SCREEN_SHARE_AUDIO];
  if (role === 'STUDENT' && settings.allowStudentScreenShare === true) return [SOURCE.CAMERA, SOURCE.MICROPHONE, SOURCE.SCREEN_SHARE, SOURCE.SCREEN_SHARE_AUDIO];
  return [SOURCE.CAMERA, SOURCE.MICROPHONE];
}

function resolvePublishSources({ type, meetingRole, legacyRole, legacyRestricted = false, grants = {}, settings = {} } = {}) {
  const normalizedLegacyRole = String(legacyRole || 'VIEWER').toUpperCase();
  let sources = legacyRestricted
    ? (['ADMIN', 'ORGANIZER', 'PANELIST'].includes(normalizedLegacyRole)
      ? [SOURCE.CAMERA, SOURCE.MICROPHONE, SOURCE.SCREEN_SHARE, SOURCE.SCREEN_SHARE_AUDIO]
      : [])
    : basePublishSources(type, meetingRole, settings);
  const enabled = new Set(sources);
  if (grants.microphone === true) enabled.add(SOURCE.MICROPHONE);
  if (grants.microphone === false) enabled.delete(SOURCE.MICROPHONE);
  if (grants.camera === true) enabled.add(SOURCE.CAMERA);
  if (grants.camera === false) enabled.delete(SOURCE.CAMERA);
  if (grants.screen === true) {
    enabled.add(SOURCE.SCREEN_SHARE);
    enabled.add(SOURCE.SCREEN_SHARE_AUDIO);
  }
  if (grants.screen === false) {
    enabled.delete(SOURCE.SCREEN_SHARE);
    enabled.delete(SOURCE.SCREEN_SHARE_AUDIO);
  }
  return [...enabled];
}

function invitationRolesForType(type) {
  return [...MEETING_ROLES[normalizeMeetingType(type)]];
}

function roleDescription(type, role) {
  const meetingType = normalizeMeetingType(type);
  const normalized = normalizeMeetingRole(meetingType, role);
  const descriptions = {
    HOST: 'Podrás dirigir la reunión, administrar participantes y finalizarla para todos.',
    TEACHER: 'Podrás dirigir la clase, administrar estudiantes y finalizarla para todos.',
    COHOST: 'Podrás administrar la sala y participantes; la grabación queda reservada al anfitrión.',
    MODERATOR: 'Podrás moderar el chat, las preguntas y las solicitudes de participación.',
    PANELIST: 'Podrás usar audio, cámara y pantalla, además de chat, preguntas y reacciones.',
    ATTENDEE: 'Podrás ver la transmisión, usar el chat, reaccionar y pedir la palabra.',
    PARTICIPANT: 'Podrás usar audio, cámara, pantalla, chat y reacciones.',
    STUDENT: 'Podrás usar audio, cámara, chat, preguntas y mano; la pantalla requiere autorización.',
  };
  return descriptions[normalized];
}

module.exports = {
  MEETING_ROLES,
  MEETING_TYPES,
  ROLE_LABELS,
  SOURCE,
  basePublishSources,
  invitationRolesForType,
  legacyDefaultMeetingRole,
  legacyRoleForMeetingRole,
  normalizeMeetingRole,
  normalizeMeetingType,
  resolvePublishSources,
  roleCapabilities,
  roleDescription,
};
