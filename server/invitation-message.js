const { config, publicUrl } = require('./config');
const {
  ROLE_LABELS,
  legacyDefaultMeetingRole,
  normalizeMeetingRole,
  normalizeMeetingType,
  roleDescription,
} = require('./meeting-permissions');

function cleanShareText(value, fallback) {
  const normalized = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[\s\r\n]+/g, ' ').trim();
  return (normalized || fallback).replace(/[*_~`]/g, '').slice(0, 240);
}

function capitalize(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function durationLabel(minutes) {
  const value = Number.isFinite(Number(minutes)) ? Math.max(1, Math.round(Number(minutes))) : 60;
  if (value === 60) return '1 hora';
  if (value % 60 === 0) return `${value / 60} horas`;
  return `${value} minutos`;
}

function meetingSchedule(meeting, { timeZone, timeZoneLabel } = {}) {
  const zone = timeZone || config.appTimeZone;
  const zoneLabel = timeZoneLabel || config.appTimeZoneLabel;
  const scheduledAt = meeting?.scheduledAt;
  const date = scheduledAt ? new Date(scheduledAt) : null;
  if (!date || Number.isNaN(date.getTime())) return { date: 'Por confirmar', time: 'Por confirmar', timeZone: zoneLabel };
  return {
    date: capitalize(new Intl.DateTimeFormat('es-EC', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: zone }).format(date)),
    time: new Intl.DateTimeFormat('es-EC', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: zone }).format(date),
    timeZone: zoneLabel,
  };
}

function buildInvitationMessage({ meeting, role, url, timeZone, timeZoneLabel } = {}) {
  const meetingType = normalizeMeetingType(meeting?.meetingType || meeting?.type);
  const requestedRole = String(role || '').toUpperCase();
  const meetingRole = ['ADMIN', 'ORGANIZER', 'PANELIST', 'VIEWER'].includes(requestedRole)
    ? legacyDefaultMeetingRole(meetingType, requestedRole)
    : normalizeMeetingRole(meetingType, requestedRole);
  const roleLabel = ROLE_LABELS[meetingRole] || 'Participante';
  const title = cleanShareText(meeting?.title, 'Capacitación R.A. Training');
  const trainer = cleanShareText(meeting?.trainerName, 'Equipo R.A. Training');
  const schedule = meetingSchedule(meeting, { timeZone, timeZoneLabel });
  const typeLabels = { WEBINAR: 'Webinar', SESSION: 'Sesión', CLASS: 'Clase' };
  const privileged = ['HOST', 'TEACHER', 'COHOST', 'PANELIST'].includes(meetingRole);
  const lines = [
    'Hola 👋',
    '',
    meetingRole === 'PANELIST' ? 'Has sido invitado como panelista a:' : `Te invitamos a participar en ${title}.`,
    '',
    `*${title}*`,
    '',
    `Tipo de reunión: ${typeLabels[meetingType]}.`,
    `Tu acceso: ${roleLabel}.`,
    roleDescription(meetingType, meetingRole),
    '',
    `📅 Fecha: ${schedule.date}`,
    `🕒 Hora: ${schedule.time} (${schedule.timeZone})`,
    `👤 Capacitador: ${trainer}`,
    `⏱ Duración estimada: ${durationLabel(meeting?.durationMinutes)}`,
    '',
    'Ingresa desde este enlace:',
    url,
    '',
    'Te recomendamos conectarte unos minutos antes y comprobar tu audio.',
  ];
  if (privileged) lines.push('', 'Este enlace es personal y habilita permisos mayores. No lo compartas públicamente.');
  lines.push('', config.appName);
  return lines.join('\n');
}

function invitationSharePayload({ token, meeting, role } = {}) {
  const path = `/i/${token}`;
  const url = publicUrl(path);
  const message = buildInvitationMessage({ meeting, role, url });
  return {
    path,
    url,
    message,
    whatsappUrl: `https://wa.me/?text=${encodeURIComponent(message)}`,
  };
}

module.exports = {
  buildInvitationMessage,
  cleanShareText,
  durationLabel,
  invitationSharePayload,
  meetingSchedule,
};
