const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'streaming-role-test-secret-with-32-characters';

const {
  SOURCE,
  invitationRolesForType,
  legacyRoleForMeetingRole,
  resolvePublishSources,
  roleCapabilities,
  roleDescription,
} = require('../server/meeting-permissions');
const { publishPermission } = require('../server/app');
const { createRoomSession } = require('../server/room-session');

const allSources = [SOURCE.CAMERA, SOURCE.MICROPHONE, SOURCE.SCREEN_SHARE, SOURCE.SCREEN_SHARE_AUDIO];

test('WEBINAR, SESSION and CLASS expose distinct canonical role matrices', () => {
  assert.deepEqual(invitationRolesForType('WEBINAR'), ['HOST', 'COHOST', 'MODERATOR', 'PANELIST', 'ATTENDEE']);
  assert.deepEqual(invitationRolesForType('SESSION'), ['HOST', 'COHOST', 'MODERATOR', 'PARTICIPANT']);
  assert.deepEqual(invitationRolesForType('CLASS'), ['TEACHER', 'COHOST', 'MODERATOR', 'STUDENT']);
  assert.equal(legacyRoleForMeetingRole('CLASS', 'TEACHER'), 'ORGANIZER');
  assert.equal(legacyRoleForMeetingRole('WEBINAR', 'ATTENDEE'), 'VIEWER');
  assert.match(roleDescription('WEBINAR', 'ATTENDEE'), /pedir la palabra/i);
});

test('role capabilities separate hosting, moderation, recording and participation', () => {
  const attendee = roleCapabilities('WEBINAR', 'ATTENDEE');
  const moderator = roleCapabilities('WEBINAR', 'MODERATOR');
  const cohost = roleCapabilities('WEBINAR', 'COHOST');
  const host = roleCapabilities('WEBINAR', 'HOST');
  assert.equal(attendee.canManageParticipants, false);
  assert.equal(attendee.canManageRecording, false);
  assert.equal(moderator.canModerateChat, true);
  assert.equal(moderator.canEndMeeting, false);
  assert.equal(cohost.canManageParticipants, true);
  assert.equal(cohost.canManageRecording, false);
  assert.equal(host.canManageRecording, true);
});

test('minimum publication sources follow modality and central screen settings', () => {
  assert.deepEqual(resolvePublishSources({ type: 'WEBINAR', meetingRole: 'ATTENDEE' }), []);
  assert.deepEqual(resolvePublishSources({ type: 'WEBINAR', meetingRole: 'PANELIST' }), allSources);
  assert.deepEqual(resolvePublishSources({ type: 'SESSION', meetingRole: 'PARTICIPANT', settings: { allowParticipantScreenShare: false } }), [SOURCE.CAMERA, SOURCE.MICROPHONE]);
  assert.deepEqual(resolvePublishSources({ type: 'CLASS', meetingRole: 'STUDENT' }), [SOURCE.CAMERA, SOURCE.MICROPHONE]);
  assert.deepEqual(resolvePublishSources({ type: 'CLASS', meetingRole: 'STUDENT', grants: { screen: true } }), allSources);
  assert.deepEqual(resolvePublishSources({ type: 'WEBINAR', meetingRole: 'PANELIST', grants: { microphone: false, screen: false } }), [SOURCE.CAMERA]);
});

test('legacy viewers remain non-publishers while historical panelists retain publishing compatibility', () => {
  assert.deepEqual(resolvePublishSources({ type: 'CLASS', meetingRole: 'STUDENT', legacyRole: 'VIEWER', legacyRestricted: true }), []);
  assert.deepEqual(resolvePublishSources({ type: 'CLASS', meetingRole: 'STUDENT', legacyRole: 'PANELIST', legacyRestricted: true }), allSources);
});

test('LiveKit permissions contain only resolved sources and disable data publication', () => {
  const attendee = publishPermission([]).permission;
  assert.deepEqual(attendee, { canPublish: false, canPublishSources: [], canSubscribe: true, canPublishData: false });
  const student = publishPermission([SOURCE.CAMERA, SOURCE.MICROPHONE]).permission;
  assert.equal(student.canPublish, true);
  assert.equal(student.canPublishSources.length, 2);
  assert.ok(student.canPublishSources.every(Number.isInteger));
  assert.equal(student.canPublishData, false);
});

test('profiled room sessions require consent while compatible legacy organizer sessions keep historical behavior', () => {
  const profiled = createRoomSession({
    room: 'class-profiled', meetingId: 'meeting-profiled', role: 'PANELIST',
    meetingType: 'CLASS', meetingRole: 'STUDENT', legacyAccess: false,
  });
  assert.equal(profiled.session.consentRequired, true);
  assert.equal(profiled.session.meetingRole, 'STUDENT');
  assert.equal(profiled.session.displayName, '');
  const legacy = createRoomSession({ room: 'legacy-room', meetingId: 'legacy-meeting', role: 'ORGANIZER' });
  assert.equal(legacy.session.legacyAccess, true);
  assert.equal(legacy.session.consentRequired, false);
});
