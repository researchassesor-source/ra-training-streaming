const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { PutObjectCommand, ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { AccessToken, RoomServiceClient, EgressClient, EncodedFileType, DataPacket_Kind } = require('livekit-server-sdk');
const { s3, storageConfigured, bucket } = require('./s3');
const { config } = require('./config');
const roomRegistry = require('./rooms');
const auth = require('./auth');
const meetings = require('./meetings');
const invitations = require('./invitations');
const audit = require('./audit');
const {
  clearRoomCookie,
  createRoomSession,
  requireRoomCsrf,
  requireRoomRoles,
  requireRoomSession,
  roomCookie,
  updateDisplayName,
} = require('./room-session');
const { createRateLimiter } = require('./rate-limit');
const {
  AppError,
  asyncHandler,
  limitedUserAgent,
  requestIp,
  sanitizeText,
  validatePassword,
  validateUsername,
} = require('./http-utils');

const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'devkey';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'secret';
const LIVEKIT_WS_URL = process.env.LIVEKIT_WS_URL || 'ws://localhost:7880';
const LIVEKIT_HTTP_URL = LIVEKIT_WS_URL.replace(/^ws/, 'http');
const recordingConfigured = Boolean(
  process.env.RECORDING_S3_ACCESS_KEY &&
  process.env.RECORDING_S3_SECRET_KEY &&
  process.env.RECORDING_S3_BUCKET
);

function defaultServices() {
  return {
    roomService: new RoomServiceClient(LIVEKIT_HTTP_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET),
    egressClient: new EgressClient(LIVEKIT_HTTP_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET),
  };
}

function canManageMeeting(actor, meeting) {
  if (!actor || !meeting) return false;
  if (actor.role === 'ADMIN') return true;
  return actor.role === 'ORGANIZER' && (
    meeting.createdBy === actor.u || meeting.trainerId === actor.u
  );
}

function meetingVisibleTo(actor, meeting) {
  return actor.role === 'ADMIN' || canManageMeeting(actor, meeting);
}

async function requireManagedMeeting(req, _res, next) {
  try {
    const meeting = await meetings.getMeeting(req.params.room);
    if (!meeting) throw new AppError(404, 'Reunión no encontrada', 'NOT_FOUND');
    if (!canManageMeeting(req.auth, meeting)) throw new AppError(403, 'No tienes permisos sobre esta reunión', 'FORBIDDEN');
    req.meeting = meeting;
    next();
  } catch (error) {
    next(error);
  }
}

async function safeAudit(event) {
  try {
    return await audit.logEvent(event);
  } catch (error) {
    console.error('audit/write error', error.message);
    return null;
  }
}

function auditContext(req) {
  return { ip: requestIp(req), userAgent: limitedUserAgent(req) };
}

function createApp(overrides = {}) {
  const app = express();
  const services = { ...defaultServices(), ...(overrides.services || {}) };
  const roomService = services.roomService;
  const egressClient = services.egressClient;

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), picture-in-picture=(self)');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    if (req.path.startsWith('/api/') || req.path.startsWith('/i/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: config.maxJsonPayload, strict: true }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), {
    etag: true,
    maxAge: config.isProduction ? '1h' : 0,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
    },
  }));
  app.use('/vendor/livekit-client', express.static(path.join(__dirname, '..', 'node_modules', 'livekit-client', 'dist')));

  const loginLimiter = createRateLimiter({
    windowMs: config.loginRateLimitWindowMs,
    max: config.loginRateLimitMax,
    key: (req) => `${req.ip}:${String(req.body?.username || '').toLowerCase()}`,
    message: 'Demasiados intentos de acceso. Intenta más tarde.',
  });
  const meetingLimiter = createRateLimiter({ windowMs: 60 * 60_000, max: config.meetingRateLimitMax });
  const chatLimiter = createRateLimiter({
    windowMs: 60_000,
    max: config.chatRateLimitMax,
    key: (req) => req.roomSession?.sid || req.ip,
    message: 'Has enviado demasiados mensajes o archivos. Espera un momento.',
  });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxChatFileSize, files: 1, fields: 2 },
  });

  app.post('/api/auth/login', loginLimiter, asyncHandler(async (req, res) => {
    const username = validateUsername(req.body?.username);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const user = await auth.authenticate(username, password);
    if (!user) {
      await safeAudit({ actor: username, action: 'AUTH_LOGIN_FAILED', target: username, ...auditContext(req) });
      throw new AppError(401, 'Usuario o contraseña incorrectos', 'INVALID_CREDENTIALS');
    }
    const token = auth.signSession(user);
    const session = await auth.verifySession(token);
    res.setHeader('Set-Cookie', auth.authCookie(token));
    await safeAudit({ actor: user.username, action: 'AUTH_LOGIN', target: user.username, ...auditContext(req) });
    res.json({ user: auth.publicUser(user), csrfToken: session.csrf });
  }));

  app.post('/api/auth/logout', auth.requireAuth, auth.requireCsrf, asyncHandler(async (req, res) => {
    res.setHeader('Set-Cookie', auth.clearAuthCookie());
    await safeAudit({ actor: req.auth.u, action: 'AUTH_LOGOUT', target: req.auth.u, ...auditContext(req) });
    res.json({ loggedOut: true });
  }));

  app.get('/api/auth/me', auth.requireAuth, (req, res) => {
    res.json({ user: req.auth.user, csrfToken: req.auth.csrf });
  });

  app.get('/api/auth/users', auth.requireAuth, auth.requireRoles('ADMIN'), asyncHandler(async (_req, res) => {
    res.json({ users: await auth.listUsers() });
  }));

  app.post('/api/auth/users', auth.requireAuth, auth.requireCsrf, auth.requireRoles('ADMIN', 'ORGANIZER'), asyncHandler(async (req, res) => {
    const role = auth.normalizeRole(req.body?.role, 'ORGANIZER');
    if (req.auth.role !== 'ADMIN' && role === 'ADMIN') throw new AppError(403, 'Solo un ADMIN puede crear otro ADMIN', 'FORBIDDEN');
    const user = await auth.createUser({
      username: req.body?.username,
      password: req.body?.password,
      role,
      active: req.body?.active !== false,
    });
    await safeAudit({ actor: req.auth.u, action: 'USER_CREATED', target: user.username, metadata: { role: user.role }, ...auditContext(req) });
    res.status(201).json({ user });
  }));

  app.patch('/api/auth/users/:username', auth.requireAuth, auth.requireCsrf, auth.requireRoles('ADMIN'), asyncHandler(async (req, res) => {
    if (req.auth.u === String(req.params.username).toLowerCase() && req.body?.active === false) {
      throw new AppError(409, 'No puedes desactivar tu propia sesión administrativa', 'SELF_DEACTIVATE');
    }
    const before = await auth.getUser(req.params.username);
    const user = await auth.updateUser(req.params.username, { role: req.body?.role, active: req.body?.active });
    const action = before?.role !== user.role ? 'USER_ROLE_CHANGED' : user.active ? 'USER_UPDATED' : 'USER_DEACTIVATED';
    await safeAudit({ actor: req.auth.u, action, target: user.username, metadata: { role: user.role, active: user.active }, ...auditContext(req) });
    res.json({ user });
  }));

  app.post('/api/auth/users/:username/password', auth.requireAuth, auth.requireCsrf, auth.requireRoles('ADMIN'), asyncHandler(async (req, res) => {
    const user = await auth.resetPassword(req.params.username, validatePassword(req.body?.password));
    await safeAudit({ actor: req.auth.u, action: 'USER_PASSWORD_RESET', target: user.username, ...auditContext(req) });
    res.json({ user });
  }));

  app.post('/api/auth/users/:username/revoke-sessions', auth.requireAuth, auth.requireCsrf, auth.requireRoles('ADMIN'), asyncHandler(async (req, res) => {
    const user = await auth.revokeSessions(req.params.username);
    await safeAudit({ actor: req.auth.u, action: 'USER_SESSIONS_REVOKED', target: user.username, ...auditContext(req) });
    res.json({ user });
  }));

  app.delete('/api/auth/users/:username', auth.requireAuth, auth.requireCsrf, auth.requireRoles('ADMIN'), asyncHandler(async (req, res) => {
    if (req.auth.u === String(req.params.username).toLowerCase()) throw new AppError(409, 'No puedes eliminar tu propia cuenta', 'SELF_DELETE');
    await auth.deleteUser(req.params.username);
    await safeAudit({ actor: req.auth.u, action: 'USER_DELETED', target: req.params.username, ...auditContext(req) });
    res.json({ deleted: true });
  }));

  app.get('/api/meetings', auth.requireAuth, auth.requireRoles('ADMIN', 'ORGANIZER'), asyncHandler(async (req, res) => {
    const includeDeleted = req.query.includeDeleted === 'true' && req.auth.role === 'ADMIN';
    const items = (await meetings.listMeetings({ includeDeleted })).filter((meeting) => meetingVisibleTo(req.auth, meeting));
    res.json({ items });
  }));

  app.post('/api/rooms', auth.requireAuth, auth.requireCsrf, auth.requireRoles('ADMIN', 'ORGANIZER'), asyncHandler(async (req, res) => {
    const room = sanitizeText(req.body?.room, { field: 'room', min: 3, max: 80, required: true });
    const meeting = await meetings.getMeeting(room);
    if (!meeting) throw new AppError(404, 'La sala debe pertenecer a una reunión existente', 'NOT_FOUND');
    if (!canManageMeeting(req.auth, meeting)) throw new AppError(403, 'No tienes permisos sobre esta sala', 'FORBIDDEN');
    if (meeting.deletedAt || ['CANCELLED', 'ARCHIVED', 'COMPLETED'].includes(meeting.status)) throw new AppError(409, 'La reunión no admite una sala activa', 'MEETING_NOT_JOINABLE');
    const roomRecord = await roomRegistry.createRoom(meeting.room, { meetingId: meeting.id });
    res.json({ room: roomRecord.room, meetingId: roomRecord.meetingId, status: roomRecord.status });
  }));

  app.post('/api/meetings', meetingLimiter, auth.requireAuth, auth.requireCsrf, auth.requireRoles('ADMIN', 'ORGANIZER'), asyncHandler(async (req, res) => {
    const record = await meetings.createMeeting({ ...req.body, createdBy: req.auth.u });
    await roomRegistry.createRoom(record.room, { meetingId: record.id });
    await safeAudit({ actor: req.auth.u, action: 'MEETING_CREATED', target: record.id, room: record.room, metadata: { type: record.type, status: record.status }, ...auditContext(req) });
    res.status(201).json(record);
  }));

  app.get('/api/meetings/:room', auth.requireAuth, auth.requireRoles('ADMIN', 'ORGANIZER'), requireManagedMeeting, (req, res) => {
    res.json(req.meeting);
  });

  app.patch('/api/meetings/:room', auth.requireAuth, auth.requireCsrf, auth.requireRoles('ADMIN', 'ORGANIZER'), requireManagedMeeting, asyncHandler(async (req, res) => {
    const updated = await meetings.updateMeeting(req.params.room, req.body || {});
    await safeAudit({ actor: req.auth.u, action: 'MEETING_UPDATED', target: updated.id, room: updated.room, metadata: { status: updated.status }, ...auditContext(req) });
    res.json(updated);
  }));

  app.post('/api/meetings/:room/duplicate', meetingLimiter, auth.requireAuth, auth.requireCsrf, auth.requireRoles('ADMIN', 'ORGANIZER'), requireManagedMeeting, asyncHandler(async (req, res) => {
    const copy = await meetings.duplicateMeeting(req.params.room, req.body || {}, req.auth.u);
    await roomRegistry.createRoom(copy.room, { meetingId: copy.id });
    await safeAudit({ actor: req.auth.u, action: 'MEETING_CREATED', target: copy.id, room: copy.room, metadata: { duplicatedFrom: req.meeting.id }, ...auditContext(req) });
    res.status(201).json(copy);
  }));

  app.post('/api/meetings/:room/actions/:action', auth.requireAuth, auth.requireCsrf, auth.requireRoles('ADMIN', 'ORGANIZER'), requireManagedMeeting, asyncHandler(async (req, res) => {
    const action = req.params.action;
    const allowed = new Set(['reschedule', 'cancel', 'archive', 'restore', 'start', 'complete']);
    if (!allowed.has(action)) throw new AppError(400, 'Acción no válida', 'VALIDATION_ERROR');
    const updated = await meetings.transitionMeeting(req.params.room, action, req.body || {});
    if (action === 'cancel' || action === 'archive' || action === 'complete') await roomRegistry.revokeRoom(updated.room);
    if (action === 'restore' || action === 'start') await roomRegistry.createRoom(updated.room, { meetingId: updated.id });
    const auditAction = {
      reschedule: 'MEETING_RESCHEDULED', cancel: 'MEETING_CANCELLED', archive: 'MEETING_ARCHIVED',
      restore: 'MEETING_RESTORED', start: 'MEETING_STARTED', complete: 'MEETING_ENDED',
    }[action];
    await safeAudit({ actor: req.auth.u, action: auditAction, target: updated.id, room: updated.room, ...auditContext(req) });
    res.json(updated);
  }));

  app.delete('/api/meetings/:room', auth.requireAuth, auth.requireCsrf, auth.requireRoles('ADMIN'), requireManagedMeeting, asyncHandler(async (req, res) => {
    const updated = await meetings.deleteMeeting(req.params.room);
    await roomRegistry.revokeRoom(req.params.room);
    await safeAudit({ actor: req.auth.u, action: 'MEETING_DELETED', target: updated.id, room: updated.room, ...auditContext(req) });
    res.json({ deleted: true, meeting: updated });
  }));

  app.get('/api/meetings/:room/invitations', auth.requireAuth, auth.requireRoles('ADMIN', 'ORGANIZER'), requireManagedMeeting, asyncHandler(async (req, res) => {
    res.json({ items: await invitations.listInvitations({ room: req.params.room }) });
  }));

  app.post('/api/meetings/:room/invitations', auth.requireAuth, auth.requireCsrf, auth.requireRoles('ADMIN', 'ORGANIZER'), requireManagedMeeting, asyncHandler(async (req, res) => {
    if (req.meeting.deletedAt || ['CANCELLED', 'ARCHIVED', 'COMPLETED'].includes(req.meeting.status)) {
      throw new AppError(409, 'No se pueden crear invitaciones para esta reunión', 'MEETING_NOT_JOINABLE');
    }
    const created = await invitations.createInvitation({
      meetingId: req.meeting.id,
      room: req.meeting.room,
      role: req.body?.role,
      expiresInMinutes: req.body?.expiresInMinutes,
      singleUse: req.body?.singleUse === true,
      maxUses: req.body?.maxUses,
      createdBy: req.auth.u,
    });
    await safeAudit({ actor: req.auth.u, action: 'INVITATION_CREATED', target: created.invitation.id, room: req.meeting.room, metadata: { role: created.invitation.role, expiresAt: created.invitation.expiresAt }, ...auditContext(req) });
    res.status(201).json({ invitation: created.invitation, path: `/i/${created.token}` });
  }));

  app.delete('/api/meetings/:room/invitations/:id', auth.requireAuth, auth.requireCsrf, auth.requireRoles('ADMIN', 'ORGANIZER'), requireManagedMeeting, asyncHandler(async (req, res) => {
    const invitation = await invitations.revokeInvitation(req.params.id, req.params.room);
    await safeAudit({ actor: req.auth.u, action: 'INVITATION_REVOKED', target: invitation.id, room: invitation.room, ...auditContext(req) });
    res.json({ invitation });
  }));

  app.post('/api/meetings/:room/launch', auth.requireAuth, auth.requireCsrf, auth.requireRoles('ADMIN', 'ORGANIZER'), requireManagedMeeting, asyncHandler(async (req, res) => {
    if (req.meeting.deletedAt || ['CANCELLED', 'ARCHIVED', 'COMPLETED'].includes(req.meeting.status)) {
      throw new AppError(409, 'La reunión no se puede iniciar en su estado actual', 'MEETING_NOT_JOINABLE');
    }
    const updated = req.meeting.status === 'LIVE' ? req.meeting : await meetings.transitionMeeting(req.params.room, 'start');
    await roomRegistry.createRoom(updated.room, { meetingId: updated.id });
    const created = createRoomSession({ room: updated.room, meetingId: updated.id, role: req.auth.role, username: req.auth.u, displayName: req.auth.u });
    res.setHeader('Set-Cookie', roomCookie(created.token));
    await safeAudit({ actor: req.auth.u, action: 'MEETING_STARTED', target: updated.id, room: updated.room, ...auditContext(req) });
    res.json({ redirect: '/presenter.html' });
  }));

  app.get('/i/:token', asyncHandler(async (req, res) => {
    const invitation = await invitations.consumeInvitation(req.params.token);
    const meeting = await meetings.getMeeting(invitation.room);
    if (!meeting || meeting.deletedAt || ['CANCELLED', 'ARCHIVED', 'COMPLETED'].includes(meeting.status)) {
      throw new AppError(410, 'Esta reunión ya no admite accesos', 'MEETING_NOT_JOINABLE');
    }
    const access = await roomRegistry.checkAccess(meeting.room);
    if (!access.allowed) throw new AppError(503, 'La sala no está disponible', access.reason);
    const created = createRoomSession({
      room: meeting.room,
      meetingId: meeting.id,
      role: invitation.role,
      invitationId: invitation.id,
    });
    res.setHeader('Set-Cookie', roomCookie(created.token));
    await safeAudit({ actor: created.session.identity, action: 'INVITATION_REDEEMED', target: invitation.id, room: meeting.room, metadata: { role: invitation.role }, ...auditContext(req) });
    res.redirect(303, invitation.role === 'PANELIST' ? '/presenter.html' : '/viewer.html');
  }));

  app.get('/api/room-session', requireRoomSession, asyncHandler(async (req, res) => {
    const meeting = await meetings.getMeeting(req.roomSession.room);
    if (!meeting || meeting.id !== req.roomSession.meetingId || meeting.deletedAt) throw new AppError(410, 'La reunión ya no está disponible', 'MEETING_NOT_JOINABLE');
    res.json({
      room: req.roomSession.room,
      role: req.roomSession.role,
      identity: req.roomSession.identity,
      displayName: req.roomSession.displayName,
      csrfToken: req.roomSession.csrf,
      meeting: {
        id: meeting.id,
        title: meeting.title,
        trainerName: meeting.trainerName,
        status: meeting.status,
        scheduledAt: meeting.scheduledAt,
        recordingConsentRequired: meeting.recordingConsentRequired,
        allowChat: meeting.allowChat,
        allowFiles: meeting.allowFiles,
        allowReactions: meeting.allowReactions,
        allowRaiseHand: meeting.allowRaiseHand,
      },
    });
  }));

  app.patch('/api/room-session/profile', requireRoomSession, requireRoomCsrf, asyncHandler(async (req, res) => {
    const displayName = sanitizeText(req.body?.displayName, { field: 'displayName', min: 2, max: 80, required: true });
    const updated = updateDisplayName(req.roomSession, displayName);
    res.setHeader('Set-Cookie', roomCookie(updated.token));
    res.json({ displayName, csrfToken: updated.session.csrf });
  }));

  app.post('/api/room-session/leave', requireRoomSession, requireRoomCsrf, (req, res) => {
    res.setHeader('Set-Cookie', clearRoomCookie());
    res.json({ left: true });
  });

  app.get('/api/token', requireRoomSession, asyncHandler(async (req, res) => {
    const meeting = await meetings.getMeeting(req.roomSession.room);
    if (!meeting || meeting.id !== req.roomSession.meetingId || meeting.deletedAt || ['CANCELLED', 'ARCHIVED', 'COMPLETED'].includes(meeting.status)) {
      throw new AppError(410, 'La reunión finalizó o tu acceso fue retirado', 'ROOM_ENDED');
    }
    const access = await roomRegistry.checkAccess(meeting.room);
    if (!access.allowed) throw new AppError(403, 'Tu acceso a la sala fue retirado', access.reason);
    const canPublish = ['ADMIN', 'ORGANIZER', 'PANELIST'].includes(req.roomSession.role);
    const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: req.roomSession.identity,
      name: req.roomSession.displayName,
      metadata: JSON.stringify({ role: req.roomSession.role }),
    });
    token.addGrant({
      room: meeting.room,
      roomJoin: true,
      canPublish,
      canPublishData: false,
      canSubscribe: true,
    });
    res.json({
      token: await token.toJwt(),
      wsUrl: LIVEKIT_WS_URL,
      room: meeting.room,
      identity: req.roomSession.identity,
      displayName: req.roomSession.displayName,
      role: req.roomSession.role,
      recordingConfigured,
      meeting: { id: meeting.id, title: meeting.title, status: meeting.status },
    });
  }));

  async function roomMeeting(req, _res, next) {
    try {
      const meeting = await meetings.getMeeting(req.roomSession.room);
      if (!meeting || meeting.id !== req.roomSession.meetingId || meeting.deletedAt) throw new AppError(410, 'La reunión ya no está disponible', 'ROOM_ENDED');
      req.meeting = meeting;
      next();
    } catch (error) {
      next(error);
    }
  }

  async function assertCallerPresent(req) {
    const participants = await roomService.listParticipants(req.roomSession.room);
    const caller = participants.find((participant) => participant.identity === req.roomSession.identity);
    if (!caller) throw new AppError(403, 'Debes estar conectado a la sala para realizar esta acción', 'NOT_IN_ROOM');
    return participants;
  }

  async function relayRoomData(req, message, destinationIdentities) {
    const data = Buffer.from(JSON.stringify(message), 'utf8');
    const options = destinationIdentities ? { destinationIdentities } : {};
    await roomService.sendData(req.roomSession.room, data, DataPacket_Kind.RELIABLE, options);
  }

  app.post('/api/participants/promote', requireRoomSession, requireRoomCsrf, requireRoomRoles('ADMIN', 'ORGANIZER', 'PANELIST'), roomMeeting, asyncHandler(async (req, res) => {
    if (req.meeting.status !== 'LIVE') throw new AppError(409, 'La reunión no está en vivo', 'MEETING_NOT_LIVE');
    const targetIdentity = sanitizeText(req.body?.targetIdentity, { field: 'targetIdentity', min: 5, max: 100, required: true });
    const participants = await assertCallerPresent(req);
    if (!participants.some((participant) => participant.identity === targetIdentity)) throw new AppError(404, 'Participante no encontrado', 'NOT_FOUND');
    await roomService.updateParticipant(req.roomSession.room, targetIdentity, {
      permission: { canPublish: true, canSubscribe: true, canPublishData: false },
    });
    await relayRoomData(req, { kind: 'hand-approved', targetIdentity, sentAt: new Date().toISOString() }, [targetIdentity]);
    await safeAudit({ actor: req.roomSession.identity, action: 'PARTICIPANT_PROMOTED', target: targetIdentity, room: req.roomSession.room, ...auditContext(req) });
    res.json({ promoted: true });
  }));

  app.post('/api/participants/demote', requireRoomSession, requireRoomCsrf, requireRoomRoles('ADMIN', 'ORGANIZER', 'PANELIST'), roomMeeting, asyncHandler(async (req, res) => {
    if (req.meeting.status !== 'LIVE') throw new AppError(409, 'La reunión no está en vivo', 'MEETING_NOT_LIVE');
    const targetIdentity = sanitizeText(req.body?.targetIdentity, { field: 'targetIdentity', min: 5, max: 100, required: true });
    await assertCallerPresent(req);
    await roomService.updateParticipant(req.roomSession.room, targetIdentity, {
      permission: { canPublish: false, canSubscribe: true, canPublishData: false },
    });
    await relayRoomData(req, { kind: 'word-revoked', targetIdentity, sentAt: new Date().toISOString() }, [targetIdentity]);
    await safeAudit({ actor: req.roomSession.identity, action: 'PARTICIPANT_DEMOTED', target: targetIdentity, room: req.roomSession.room, ...auditContext(req) });
    res.json({ demoted: true });
  }));

  app.post('/api/participants/self-demote', requireRoomSession, requireRoomCsrf, roomMeeting, asyncHandler(async (req, res) => {
    await roomService.updateParticipant(req.roomSession.room, req.roomSession.identity, {
      permission: { canPublish: false, canSubscribe: true, canPublishData: false },
    });
    res.json({ demoted: true });
  }));

  app.post('/api/participants/remove', requireRoomSession, requireRoomCsrf, requireRoomRoles('ADMIN', 'ORGANIZER'), roomMeeting, asyncHandler(async (req, res) => {
    const targetIdentity = sanitizeText(req.body?.targetIdentity, { field: 'targetIdentity', min: 5, max: 100, required: true });
    await assertCallerPresent(req);
    await roomService.removeParticipant(req.roomSession.room, targetIdentity);
    await safeAudit({ actor: req.roomSession.identity, action: 'PARTICIPANT_REMOVED', target: targetIdentity, room: req.roomSession.room, ...auditContext(req) });
    res.json({ removed: true });
  }));

  app.post('/api/participants/mute', requireRoomSession, requireRoomCsrf, requireRoomRoles('ADMIN', 'ORGANIZER'), roomMeeting, asyncHandler(async (req, res) => {
    const targetIdentity = sanitizeText(req.body?.targetIdentity, { field: 'targetIdentity', min: 5, max: 100, required: true });
    const participants = await assertCallerPresent(req);
    const target = participants.find((participant) => participant.identity === targetIdentity);
    if (!target) throw new AppError(404, 'Participante no encontrado', 'NOT_FOUND');
    const microphoneTrack = (target.tracks || []).find((track) => String(track.source).toUpperCase().includes('MICROPHONE') || track.type === 0);
    if (!microphoneTrack?.sid) throw new AppError(409, 'El participante no tiene un micrófono publicado', 'MICROPHONE_NOT_PUBLISHED');
    await roomService.mutePublishedTrack(req.roomSession.room, targetIdentity, microphoneTrack.sid, true);
    res.json({ muted: true });
  }));

  app.post('/api/chat/message', requireRoomSession, requireRoomCsrf, chatLimiter, roomMeeting, (req, res, next) => {
    Promise.resolve().then(async () => {
      if (!req.meeting.allowChat || req.meeting.status !== 'LIVE') throw new AppError(409, 'El chat no está disponible', 'CHAT_DISABLED');
      const text = sanitizeText(req.body?.text, { field: 'Mensaje', min: 1, max: config.maxChatMessageLength, required: true });
      const kind = req.body?.kind === 'question' ? 'question' : 'chat';
      const participants = await assertCallerPresent(req);
      const message = {
        text,
        kind,
        type: 'text',
        sentAt: new Date().toISOString(),
        role: req.roomSession.role,
        from: req.roomSession.displayName,
        fromIdentity: req.roomSession.identity,
      };
      const destinations = participants.filter((participant) => participant.identity !== req.roomSession.identity).map((participant) => participant.identity);
      if (destinations.length) await relayRoomData(req, message, destinations);
      res.json({ allowed: true, message });
    }).catch(next);
  });

  app.post('/api/room/events', requireRoomSession, requireRoomCsrf, chatLimiter, roomMeeting, asyncHandler(async (req, res) => {
    if (req.meeting.status !== 'LIVE') throw new AppError(409, 'La reunión no está en vivo', 'MEETING_NOT_LIVE');
    const kind = String(req.body?.kind || '');
    const participants = await assertCallerPresent(req);
    let message;
    let destinations = participants.filter((participant) => participant.identity !== req.roomSession.identity).map((participant) => participant.identity);
    if (kind === 'hand-raise' || kind === 'hand-lower') {
      if (!req.meeting.allowRaiseHand) throw new AppError(409, 'La función de mano levantada está deshabilitada', 'HAND_DISABLED');
      message = {
        kind,
        identity: req.roomSession.identity,
        displayName: req.roomSession.displayName,
        raisedAt: new Date().toISOString(),
      };
    } else if (kind === 'hand-rejected') {
      if (!['ADMIN', 'ORGANIZER', 'PANELIST'].includes(req.roomSession.role)) throw new AppError(403, 'No puedes moderar manos levantadas', 'ROOM_FORBIDDEN');
      const targetIdentity = sanitizeText(req.body?.targetIdentity, { field: 'targetIdentity', min: 5, max: 100, required: true });
      if (!participants.some((participant) => participant.identity === targetIdentity)) throw new AppError(404, 'Participante no encontrado', 'NOT_FOUND');
      message = { kind, targetIdentity, sentAt: new Date().toISOString() };
      destinations = [targetIdentity];
    } else if (kind === 'reaction') {
      if (!req.meeting.allowReactions) throw new AppError(409, 'Las reacciones están deshabilitadas', 'REACTIONS_DISABLED');
      const reaction = sanitizeText(req.body?.reaction, { field: 'reaction', min: 1, max: 8, required: true });
      if (!['👏', '👍', '❤️', '🎉', '✅'].includes(reaction)) throw new AppError(400, 'Reacción no válida', 'VALIDATION_ERROR');
      message = { kind, reaction, from: req.roomSession.displayName, fromIdentity: req.roomSession.identity, sentAt: new Date().toISOString() };
    } else {
      throw new AppError(400, 'Evento de sala no válido', 'VALIDATION_ERROR');
    }
    if (destinations.length) await relayRoomData(req, message, destinations);
    res.json({ sent: true, message });
  }));

  app.post('/api/chat/upload', requireRoomSession, requireRoomCsrf, chatLimiter, roomMeeting, upload.single('file'), asyncHandler(async (req, res) => {
    if (!storageConfigured) throw new AppError(400, 'El almacenamiento no está configurado', 'STORAGE_NOT_CONFIGURED');
    if (!req.meeting.allowChat || !req.meeting.allowFiles || req.meeting.status !== 'LIVE') throw new AppError(409, 'Los archivos no están habilitados en esta reunión', 'FILES_DISABLED');
    if (!req.file) throw new AppError(400, 'No se recibió ningún archivo', 'VALIDATION_ERROR');
    const mimetype = String(req.file.mimetype || '').toLowerCase();
    if (!config.allowedChatMimeTypes.has(mimetype)) throw new AppError(415, 'El tipo de archivo no está permitido', 'UNSUPPORTED_MEDIA_TYPE');
    const extension = path.extname(req.file.originalname || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
    const displayName = sanitizeText(path.basename(req.file.originalname || 'archivo'), { field: 'filename', min: 1, max: 120, required: true });
    const key = `chat-uploads/${req.roomSession.room}/${Date.now()}-${crypto.randomUUID()}${extension}`;
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: req.file.buffer, ContentType: mimetype }));
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 60 * 60 * 24 });
    const participants = await assertCallerPresent(req);
    const message = {
      kind: 'chat', type: 'file', url, filename: displayName, size: req.file.size, mimetype,
      role: req.roomSession.role, from: req.roomSession.displayName, fromIdentity: req.roomSession.identity,
      sentAt: new Date().toISOString(),
    };
    const destinations = participants.filter((participant) => participant.identity !== req.roomSession.identity).map((participant) => participant.identity);
    if (destinations.length) await relayRoomData(req, message, destinations);
    await safeAudit({ actor: req.roomSession.identity, action: 'CHAT_FILE_UPLOADED', target: key, room: req.roomSession.room, metadata: { mimetype, size: req.file.size }, ...auditContext(req) });
    res.json(message);
  }));

  app.post('/api/recording/start', requireRoomSession, requireRoomCsrf, requireRoomRoles('ADMIN', 'ORGANIZER'), roomMeeting, asyncHandler(async (req, res) => {
    if (!recordingConfigured) throw new AppError(400, 'La grabación no está configurada', 'RECORDING_NOT_CONFIGURED');
    if (!req.meeting.allowRecording || req.meeting.status !== 'LIVE') throw new AppError(409, 'La grabación no está permitida en esta reunión', 'RECORDING_DISABLED');
    await assertCallerPresent(req);
    const existing = await egressClient.listEgress({ roomName: req.roomSession.room, active: true });
    if (existing.length > 0) return res.json({ egressId: existing[0].egressId, alreadyRunning: true });
    const filepath = `recordings/${req.roomSession.room}/${Date.now()}`;
    const info = await egressClient.startRoomCompositeEgress(
      req.roomSession.room,
      {
        file: {
          fileType: EncodedFileType.MP4,
          filepath,
          output: {
            case: 's3',
            value: {
              accessKey: process.env.RECORDING_S3_ACCESS_KEY,
              secret: process.env.RECORDING_S3_SECRET_KEY,
              bucket: process.env.RECORDING_S3_BUCKET,
              region: process.env.RECORDING_S3_REGION || 'us-east-1',
              endpoint: process.env.RECORDING_S3_ENDPOINT || undefined,
            },
          },
        },
      },
      { layout: 'speaker' }
    );
    await relayRoomData(req, { kind: 'recording-status', active: true, sentAt: new Date().toISOString() });
    await safeAudit({ actor: req.roomSession.identity, action: 'RECORDING_STARTED', target: info.egressId, room: req.roomSession.room, ...auditContext(req) });
    res.json({ egressId: info.egressId, alreadyRunning: false });
  }));

  app.post('/api/recording/stop', requireRoomSession, requireRoomCsrf, requireRoomRoles('ADMIN', 'ORGANIZER'), roomMeeting, asyncHandler(async (req, res) => {
    const egressId = sanitizeText(req.body?.egressId, { field: 'egressId', min: 5, max: 120, required: true });
    const active = await egressClient.listEgress({ roomName: req.roomSession.room, active: true });
    if (!active.some((egress) => egress.egressId === egressId)) throw new AppError(404, 'Grabación activa no encontrada en esta sala', 'NOT_FOUND');
    await egressClient.stopEgress(egressId);
    await relayRoomData(req, { kind: 'recording-status', active: false, sentAt: new Date().toISOString() });
    await safeAudit({ actor: req.roomSession.identity, action: 'RECORDING_STOPPED', target: egressId, room: req.roomSession.room, ...auditContext(req) });
    res.json({ stopped: true });
  }));

  app.post('/api/room/end', requireRoomSession, requireRoomCsrf, requireRoomRoles('ADMIN', 'ORGANIZER'), roomMeeting, asyncHandler(async (req, res) => {
    await assertCallerPresent(req);
    const updated = await meetings.transitionMeeting(req.roomSession.room, 'complete');
    await roomRegistry.revokeRoom(req.roomSession.room);
    await roomService.deleteRoom(req.roomSession.room).catch((error) => {
      if (!/not found/i.test(error.message || '')) throw error;
    });
    res.setHeader('Set-Cookie', clearRoomCookie());
    await safeAudit({ actor: req.roomSession.identity, action: 'MEETING_ENDED', target: updated.id, room: updated.room, ...auditContext(req) });
    res.json({ ended: true });
  }));

  app.get('/api/recordings', auth.requireAuth, auth.requireRoles('ADMIN', 'ORGANIZER'), asyncHandler(async (req, res) => {
    if (!storageConfigured) throw new AppError(400, 'El almacenamiento no está configurado', 'STORAGE_NOT_CONFIGURED');
    const requestedRoom = req.query.room ? String(req.query.room) : null;
    if (requestedRoom) {
      const meeting = await meetings.getMeeting(requestedRoom);
      if (!meeting || !canManageMeeting(req.auth, meeting)) throw new AppError(403, 'No tienes permiso para ver estas grabaciones', 'FORBIDDEN');
    }
    const allowedRooms = req.auth.role === 'ADMIN'
      ? null
      : new Set((await meetings.listMeetings({ includeDeleted: true })).filter((meeting) => canManageMeeting(req.auth, meeting)).map((meeting) => meeting.room));
    const prefix = requestedRoom ? `recordings/${requestedRoom}/` : 'recordings/';
    const listing = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
    const items = await Promise.all((listing.Contents || [])
      .filter((object) => object.Key.endsWith('.mp4'))
      .filter((object) => !allowedRooms || allowedRooms.has(object.Key.split('/')[1]))
      .map(async (object) => {
        const room = object.Key.split('/')[1];
        const meeting = await meetings.getMeeting(room);
        return {
          key: object.Key,
          room,
          title: meeting?.title || room,
          trainerName: meeting?.trainerName || null,
          size: object.Size,
          lastModified: object.LastModified,
          status: 'READY',
          url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: object.Key }), { expiresIn: 60 * 60 }),
        };
      }));
    items.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
    res.json({ items });
  }));

  app.delete('/api/recordings', auth.requireAuth, auth.requireCsrf, auth.requireRoles('ADMIN'), asyncHandler(async (req, res) => {
    if (!storageConfigured) throw new AppError(400, 'El almacenamiento no está configurado', 'STORAGE_NOT_CONFIGURED');
    const key = sanitizeText(req.body?.key, { field: 'key', min: 10, max: 512, required: true });
    if (!/^recordings\/[a-z0-9-]{3,80}\/.+\.mp4$/i.test(key) || key.includes('..')) throw new AppError(400, 'Clave de grabación no válida', 'VALIDATION_ERROR');
    const room = key.split('/')[1];
    const meeting = await meetings.getMeeting(room);
    if (!meeting) throw new AppError(404, 'Reunión asociada no encontrada', 'NOT_FOUND');
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    await safeAudit({ actor: req.auth.u, action: 'RECORDING_DELETED', target: key, room, ...auditContext(req) });
    res.json({ deleted: true });
  }));

  app.get('/api/audit', auth.requireAuth, auth.requireRoles('ADMIN'), asyncHandler(async (req, res) => {
    const limit = Number.parseInt(req.query.limit || '200', 10);
    res.json({ items: await audit.listEvents({ limit, action: req.query.action, actor: req.query.actor, room: req.query.room }) });
  }));

  app.get('/api/dashboard/summary', auth.requireAuth, auth.requireRoles('ADMIN', 'ORGANIZER'), asyncHandler(async (req, res) => {
    const allMeetings = (await meetings.listMeetings({ includeDeleted: false })).filter((meeting) => meetingVisibleTo(req.auth, meeting));
    const today = new Date().toISOString().slice(0, 10);
    const users = req.auth.role === 'ADMIN' ? await auth.listUsers() : [];
    const recentErrors = req.auth.role === 'ADMIN'
      ? (await audit.listEvents({ limit: 100 })).filter((item) => item.action === 'AUTH_LOGIN_FAILED').length
      : null;
    res.json({
      meetingsToday: allMeetings.filter((meeting) => String(meeting.scheduledAt || '').startsWith(today)).length,
      activeMeetings: allMeetings.filter((meeting) => meeting.status === 'LIVE').length,
      nextMeeting: allMeetings.filter((meeting) => meeting.scheduledAt && new Date(meeting.scheduledAt) >= new Date()).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))[0] || null,
      activeCredentials: users.filter((user) => user.active).length,
      recentErrors,
      storage: storageConfigured ? 'configured' : 'local',
      livekit: LIVEKIT_WS_URL.startsWith('ws://localhost') ? 'local' : 'configured',
      recordingConfigured,
    });
  }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, storage: storageConfigured ? 's3' : 'local', livekitConfigured: LIVEKIT_API_KEY !== 'devkey', recordingConfigured });
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint no encontrado', code: 'NOT_FOUND' }));
  app.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError) {
      const message = error.code === 'LIMIT_FILE_SIZE' ? 'El archivo supera el tamaño permitido' : 'No se pudo procesar el archivo';
      return res.status(400).json({ error: message, code: error.code });
    }
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'La solicitud supera el tamaño permitido', code: 'PAYLOAD_TOO_LARGE' });
    if (error instanceof SyntaxError && error.status === 400 && 'body' in error) return res.status(400).json({ error: 'JSON no válido', code: 'INVALID_JSON' });
    const status = error instanceof AppError ? error.status : 500;
    if (status >= 500) console.error('request error', error);
    return res.status(status).json({
      error: status >= 500 ? 'Ocurrió un error interno' : error.message,
      code: error.code || 'INTERNAL_ERROR',
    });
  });

  app.locals.services = services;
  app.locals.rateLimiters = { loginLimiter, meetingLimiter, chatLimiter };
  return app;
}

module.exports = { canManageMeeting, createApp, recordingConfigured };
