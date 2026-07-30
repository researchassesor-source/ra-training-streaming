const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { PutObjectCommand, ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { AccessToken, RoomServiceClient, EgressClient, EgressStatus, EncodedFileType, DataPacket_Kind } = require('livekit-server-sdk');
const { s3, storageConfigured, bucket } = require('./s3');
const { config } = require('./config');
const roomRegistry = require('./rooms');
const auth = require('./auth');
const meetings = require('./meetings');
const invitations = require('./invitations');
const audit = require('./audit');
const questions = require('./questions');
const transcriptions = require('./transcriptions');
const { createTranscriptionProvider } = require('./transcription-provider');
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
const { createLiveKitStatusProbe } = require('./livekit-status');
const {
  AppError,
  asyncHandler,
  limitedUserAgent,
  requestIp,
  sanitizeText,
  slugify,
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
    transcriptionProvider: createTranscriptionProvider(),
  };
}

function recordingStateFromEgress(info) {
  if (!info) return { state: 'IDLE', active: false, egressId: null };
  const status = typeof info.status === 'string' ? info.status : EgressStatus[info.status];
  const states = {
    EGRESS_STARTING: 'STARTING', EGRESS_ACTIVE: 'RECORDING', EGRESS_ENDING: 'STOPPING',
    EGRESS_COMPLETE: 'PROCESSING', EGRESS_FAILED: 'FAILED', EGRESS_ABORTED: 'FAILED', EGRESS_LIMIT_REACHED: 'FAILED',
  };
  const state = states[status] || 'FAILED';
  return { state, active: state === 'RECORDING', egressId: state === 'RECORDING' ? info.egressId : null };
}

function localDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
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
  const transcriptionProvider = services.transcriptionProvider;
  const livekitProbe = overrides.livekitProbe || createLiveKitStatusProbe({ roomService, wsUrl: LIVEKIT_WS_URL });
  const pendingMediaRequests = new Map();

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
  app.use('/docs', express.static(path.join(__dirname, '..', 'docs'), { etag: true, maxAge: 0 }));

  const loginLimiter = createRateLimiter({
    windowMs: config.loginRateLimitWindowMs,
    max: config.loginRateLimitMax,
    key: (req) => `${req.ip}:${String(req.body?.username || '').toLowerCase()}`,
    message: 'Demasiados intentos de acceso. Intenta más tarde.',
  });
  const meetingLimiter = createRateLimiter({ windowMs: 60 * 60_000, max: config.meetingRateLimitMax });
  const transcriptionLimiter = createRateLimiter({
    windowMs: 60 * 60_000,
    max: config.transcriptionRateLimitMax,
    key: (req) => `${req.auth?.u || req.ip}:transcription`,
    message: 'Has realizado demasiadas solicitudes de transcripción. Intenta más tarde.',
  });
  const chatLimiter = createRateLimiter({
    windowMs: 60_000,
    max: config.chatRateLimitMax,
    key: (req) => req.roomSession?.sid || req.ip,
    message: 'Has enviado demasiados mensajes o archivos. Espera un momento.',
  });
  const interactionLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 30,
    key: (req) => `${req.roomSession?.sid || req.ip}:interaction`,
    message: 'Has realizado demasiadas acciones seguidas. Espera un momento.',
  });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxChatFileSize, files: 1, fields: 2 },
  });

  async function meetingByReference(reference) {
    const direct = await meetings.getMeeting(reference);
    if (direct) return direct;
    return (await meetings.listMeetings({ includeDeleted: true })).find((meeting) => meeting.id === reference);
  }

  function canViewTranscript(actor, meeting) {
    if (canManageMeeting(actor, meeting)) return true;
    return actor?.role === 'PANELIST' && meeting?.allowPanelistTranscriptAccess === true && meeting?.trainerId === actor.u;
  }

  async function defaultRecordingResolver(recordingId, meeting) {
    if (!storageConfigured) return null;
    const key = sanitizeText(recordingId, { field: 'recordingId', min: 10, max: 512, required: true });
    if (!/^recordings\/[a-z0-9-]{3,80}\/.+\.mp4$/i.test(key) || key.includes('..') || key.split('/')[1] !== meeting.room) return null;
    const listing = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: key, MaxKeys: 2 }));
    const object = (listing.Contents || []).find((item) => item.Key === key);
    if (!object) return null;
    let metadata = {};
    const metadataKey = key.replace(/\.mp4$/i, '.metadata.json');
    try {
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: metadataKey }));
      metadata = JSON.parse(await response.Body.transformToString());
    } catch (error) {
      if (error.name !== 'NoSuchKey' && error.$metadata?.httpStatusCode !== 404) throw error;
    }
    return {
      id: key,
      key,
      meetingId: meeting.id,
      room: meeting.room,
      status: 'READY',
      available: true,
      url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 15 * 60 }),
      source: metadata.source || 'ROOM_COMPOSITE',
      participants: Array.isArray(metadata.participants) ? metadata.participants : [],
      tracks: Array.isArray(metadata.tracks) ? metadata.tracks : [],
      durationSeconds: Number(metadata.durationSeconds) || 0,
    };
  }

  const resolveRecording = overrides.recordingResolver || defaultRecordingResolver;

  async function requireTranscript(req, _res, next) {
    try {
      const transcript = await transcriptions.getTranscript(req.params.id);
      if (!transcript) throw new AppError(404, 'Transcripción no encontrada', 'NOT_FOUND');
      const meeting = await meetingByReference(transcript.meetingId);
      if (!meeting) throw new AppError(404, 'Reunión asociada no encontrada', 'NOT_FOUND');
      if (!canViewTranscript(req.auth, meeting)) throw new AppError(403, 'No tienes permiso para acceder a esta transcripción', 'FORBIDDEN');
      req.transcript = transcript;
      req.transcriptMeeting = meeting;
      next();
    } catch (error) {
      next(error);
    }
  }

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
    const allowed = new Set(['reschedule', 'cancel', 'archive', 'restore', 'complete']);
    if (!allowed.has(action)) throw new AppError(400, 'Acción no válida', 'VALIDATION_ERROR');
    const updated = await meetings.transitionMeeting(req.params.room, action, req.body || {});
    if (action === 'cancel' || action === 'archive' || action === 'complete') await roomRegistry.revokeRoom(updated.room);
    if (action === 'restore') await roomRegistry.createRoom(updated.room, { meetingId: updated.id });
    const auditAction = {
      reschedule: 'MEETING_RESCHEDULED', cancel: 'MEETING_CANCELLED', archive: 'MEETING_ARCHIVED',
      restore: 'MEETING_RESTORED', complete: 'ROOM_ENDED',
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
    await safeAudit({ actor: req.auth.u, action: 'ROOM_OPEN_ATTEMPT', target: req.meeting.id, room: req.meeting.room, ...auditContext(req) });
    const livekit = await livekitProbe({ fresh: true });
    if (!livekit.available) {
      await safeAudit({ actor: req.auth.u, action: 'ROOM_CONNECTION_FAILED', target: req.meeting.id, room: req.meeting.room, metadata: { reason: livekit.errorCode || livekit.state }, ...auditContext(req) });
      throw new AppError(503, 'El servicio de videoconferencia no está disponible. Inicia LiveKit local antes de abrir la sala.', 'LIVEKIT_UNAVAILABLE');
    }
    await roomRegistry.createRoom(req.meeting.room, { meetingId: req.meeting.id });
    const created = createRoomSession({ room: req.meeting.room, meetingId: req.meeting.id, role: req.auth.role, username: req.auth.u, displayName: req.auth.u });
    res.setHeader('Set-Cookie', [roomCookie(created.token), roomCookie(created.token, created.session.sid)]);
    res.json({ redirect: `/presenter.html?roomSession=${encodeURIComponent(created.session.sid)}` });
  }));

  app.get('/api/livekit/status', auth.requireAuth, auth.requireRoles('ADMIN', 'ORGANIZER'), asyncHandler(async (_req, res) => {
    res.json(await livekitProbe({ fresh: true }));
  }));

  app.get('/i/:token', asyncHandler(async (req, res) => {
    const preview = await invitations.peekInvitation(req.params.token);
    const meeting = await meetings.getMeeting(preview.room);
    if (!meeting || meeting.deletedAt || ['CANCELLED', 'ARCHIVED', 'COMPLETED'].includes(meeting.status)) {
      throw new AppError(410, 'Esta reunión ya no admite accesos', 'MEETING_NOT_JOINABLE');
    }
    const invitation = await roomRegistry.withAdmissionLock(meeting.room, async () => {
      const access = await roomRegistry.checkAccess(meeting.room);
      if (!access.allowed) {
        const locked = access.reason === 'ROOM_LOCKED';
        throw new AppError(locked ? 423 : 503, locked ? 'La sala está bloqueada y no admite nuevos accesos' : 'La sala no está disponible', access.reason);
      }
      return invitations.consumeInvitation(req.params.token);
    });
    const created = createRoomSession({
      room: meeting.room,
      meetingId: meeting.id,
      role: invitation.role,
      invitationId: invitation.id,
    });
    res.setHeader('Set-Cookie', [roomCookie(created.token), roomCookie(created.token, created.session.sid)]);
    await safeAudit({ actor: created.session.identity, action: 'INVITATION_REDEEMED', target: invitation.id, room: meeting.room, metadata: { role: invitation.role }, ...auditContext(req) });
    const destination = invitation.role === 'PANELIST' ? '/presenter.html' : '/viewer.html';
    res.redirect(303, `${destination}?roomSession=${encodeURIComponent(created.session.sid)}`);
  }));

  app.get('/api/room-session', requireRoomSession, asyncHandler(async (req, res) => {
    const meeting = await meetings.getMeeting(req.roomSession.room);
    if (!meeting || meeting.id !== req.roomSession.meetingId || meeting.deletedAt) throw new AppError(410, 'La reunión ya no está disponible', 'MEETING_NOT_JOINABLE');
    const roomState = await roomRegistry.getRoom(meeting.room);
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
        type: meeting.type,
        scheduledAt: meeting.scheduledAt,
        startedAt: meeting.startedAt,
        allowRecording: meeting.allowRecording,
        recordingConsentRequired: meeting.recordingConsentRequired,
        allowTranscription: meeting.allowTranscription,
        transcriptionConsentRequired: meeting.transcriptionConsentRequired,
        allowChat: meeting.allowChat,
        allowFiles: meeting.allowFiles,
        allowReactions: meeting.allowReactions,
        allowRaiseHand: meeting.allowRaiseHand,
        allowQuestions: meeting.allowQuestions,
        roomLocked: roomState?.locked === true,
      },
    });
  }));

  app.get('/api/room/livekit-status', requireRoomSession, asyncHandler(async (_req, res) => {
    res.json(await livekitProbe({ fresh: true }));
  }));

  app.patch('/api/room-session/profile', requireRoomSession, requireRoomCsrf, asyncHandler(async (req, res) => {
    const displayName = sanitizeText(req.body?.displayName, { field: 'displayName', min: 2, max: 80, required: true });
    const updated = updateDisplayName(req.roomSession, displayName);
    res.setHeader('Set-Cookie', roomCookie(updated.token, req.roomSessionSelector));
    res.json({ displayName, csrfToken: updated.session.csrf });
  }));

  app.post('/api/room-session/leave', requireRoomSession, requireRoomCsrf, asyncHandler(async (req, res) => {
    await roomRegistry.setSpeakerGrant(req.roomSession.room, req.roomSession.identity, false).catch(() => {});
    await safeAudit({ actor: req.roomSession.identity, action: 'PARTICIPANT_LEFT', target: req.roomSession.meetingId, room: req.roomSession.room, ...auditContext(req) });
    res.setHeader('Set-Cookie', [clearRoomCookie(), clearRoomCookie(req.roomSessionSelector)]);
    res.json({ left: true });
  }));

  app.get('/api/token', requireRoomSession, asyncHandler(async (req, res) => {
    const meeting = await meetings.getMeeting(req.roomSession.room);
    if (!meeting || meeting.id !== req.roomSession.meetingId || meeting.deletedAt || ['CANCELLED', 'ARCHIVED', 'COMPLETED'].includes(meeting.status)) {
      throw new AppError(410, 'La reunión finalizó o tu acceso fue retirado', 'ROOM_ENDED');
    }
    const access = await roomRegistry.checkAccess(meeting.room, { allowLocked: true });
    if (!access.allowed) throw new AppError(403, 'Tu acceso a la sala fue retirado', access.reason);
    if (req.roomSession.role === 'VIEWER' && meeting.status !== 'LIVE') throw new AppError(409, 'La reunión todavía no ha comenzado', 'MEETING_NOT_LIVE');
    const canPublish = ['ADMIN', 'ORGANIZER', 'PANELIST'].includes(req.roomSession.role) || await roomRegistry.hasSpeakerGrant(meeting.room, req.roomSession.identity);
    const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: req.roomSession.identity,
      name: req.roomSession.displayName,
      metadata: JSON.stringify({ role: req.roomSession.role, invitationId: req.roomSession.invitationId || null, joinedAt: new Date().toISOString() }),
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
      transcriptionConfigured: transcriptionProvider.isConfigured(),
      meeting: { id: meeting.id, title: meeting.title, status: meeting.status, type: meeting.type, startedAt: meeting.startedAt },
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

  function participantCanPublish(participant) {
    const permission = participant?.permission || participant?.permissions || {};
    return permission.canPublish === true;
  }

  function publishPermission(canPublish) {
    return { permission: { canPublish, canSubscribe: true, canPublishData: false } };
  }

  app.post('/api/room/connection', requireRoomSession, requireRoomCsrf, roomMeeting, asyncHandler(async (req, res) => {
    const event = String(req.body?.event || 'connected').toLowerCase();
    if (!['attempt', 'retry', 'failed', 'connected', 'joined', 'reconnected'].includes(event)) throw new AppError(400, 'Evento de conexión no válido', 'VALIDATION_ERROR');
    const action = { attempt: 'ROOM_OPEN_ATTEMPT', retry: 'ROOM_RETRY', failed: 'ROOM_CONNECTION_FAILED' }[event];
    if (action) {
      await safeAudit({ actor: req.roomSession.identity, action, target: req.meeting.id, room: req.meeting.room, metadata: { reason: String(req.body?.reason || '').slice(0, 80) }, ...auditContext(req) });
      return res.json({ acknowledged: true, meetingStatus: req.meeting.status });
    }
    if (event === 'joined' || event === 'reconnected') {
      await assertCallerPresent(req);
      await safeAudit({ actor: req.roomSession.identity, action: event === 'joined' ? 'PARTICIPANT_JOINED' : 'PARTICIPANT_RECONNECTED', target: req.meeting.id, room: req.meeting.room, ...auditContext(req) });
      return res.json({ acknowledged: true, meetingStatus: req.meeting.status });
    }
    if (!['ADMIN', 'ORGANIZER', 'PANELIST'].includes(req.roomSession.role)) throw new AppError(403, 'Solo un organizador o panelista puede iniciar la reunión', 'ROOM_FORBIDDEN');
    const participants = await roomService.listParticipants(req.roomSession.room);
    if (!participants.some((participant) => participant.identity === req.roomSession.identity)) {
      throw new AppError(409, 'LiveKit todavía no confirma tu conexión', 'LIVEKIT_PARTICIPANT_NOT_CONFIRMED');
    }
    const hasConfirmedStart = req.meeting.status === 'LIVE' && Boolean(req.meeting.startedAt);
    const updated = hasConfirmedStart ? req.meeting : await meetings.transitionMeeting(req.meeting.room, 'start', { livekitConfirmedAt: new Date().toISOString() });
    if (!hasConfirmedStart) await safeAudit({ actor: req.roomSession.identity, action: 'ROOM_CONNECTED', target: updated.id, room: updated.room, ...auditContext(req) });
    res.json({ connected: true, meetingStatus: updated.status, started: !hasConfirmedStart });
  }));

  async function relayRoomData(req, message, destinationIdentities) {
    const data = Buffer.from(JSON.stringify(message), 'utf8');
    const options = destinationIdentities ? { destinationIdentities } : {};
    await roomService.sendData(req.roomSession.room, data, DataPacket_Kind.RELIABLE, options);
  }

  app.get('/api/room/lock', requireRoomSession, roomMeeting, asyncHandler(async (req, res) => {
    const state = await roomRegistry.getRoom(req.roomSession.room);
    res.json({ locked: state?.locked === true, lockedAt: state?.lockedAt || null });
  }));

  app.post('/api/room/lock', requireRoomSession, requireRoomCsrf, requireRoomRoles('ADMIN', 'ORGANIZER'), interactionLimiter, roomMeeting, asyncHandler(async (req, res) => {
    if (req.meeting.status !== 'LIVE') throw new AppError(409, 'La reunión no está en vivo', 'MEETING_NOT_LIVE');
    await assertCallerPresent(req);
    const locked = req.body?.locked === true;
    const state = await roomRegistry.setRoomLock(req.roomSession.room, locked, req.roomSession.identity);
    const message = { kind: 'room-lock', locked, changedBy: req.roomSession.displayName, sentAt: new Date().toISOString() };
    await relayRoomData(req, message);
    await safeAudit({ actor: req.roomSession.identity, action: locked ? 'ROOM_LOCKED' : 'ROOM_UNLOCKED', target: req.meeting.id, room: req.meeting.room, ...auditContext(req) });
    res.json({ locked: state.locked, lockedAt: state.lockedAt, message });
  }));

  app.post('/api/room/invitations', requireRoomSession, requireRoomCsrf, requireRoomRoles('ADMIN', 'ORGANIZER'), interactionLimiter, roomMeeting, asyncHandler(async (req, res) => {
    if (req.meeting.status !== 'LIVE') throw new AppError(409, 'La reunión no está en vivo', 'MEETING_NOT_LIVE');
    await assertCallerPresent(req);
    const created = await invitations.createInvitation({
      meetingId: req.meeting.id,
      room: req.meeting.room,
      role: req.body?.role,
      expiresInMinutes: req.body?.expiresInMinutes,
      singleUse: req.body?.singleUse === true,
      maxUses: req.body?.maxUses,
      createdBy: req.roomSession.username || req.roomSession.identity,
    });
    await safeAudit({ actor: req.roomSession.identity, action: 'INVITATION_CREATED', target: created.invitation.id, room: req.meeting.room, metadata: { role: created.invitation.role, source: 'in-room' }, ...auditContext(req) });
    res.status(201).json({ invitation: created.invitation, path: `/i/${created.token}` });
  }));

  app.post('/api/room/media-state', requireRoomSession, requireRoomCsrf, interactionLimiter, roomMeeting, asyncHandler(async (req, res) => {
    if (req.meeting.status !== 'LIVE') throw new AppError(409, 'La reunión no está en vivo', 'MEETING_NOT_LIVE');
    const event = String(req.body?.event || '').toLowerCase();
    const actions = {
      'microphone-muted': 'MICROPHONE_MUTED',
      'screen-started': 'SCREEN_SHARE_STARTED',
      'screen-stopped': 'SCREEN_SHARE_STOPPED',
    };
    if (!actions[event]) throw new AppError(400, 'Estado multimedia no válido', 'VALIDATION_ERROR');
    await assertCallerPresent(req);
    await safeAudit({ actor: req.roomSession.identity, action: actions[event], target: req.meeting.id, room: req.meeting.room, ...auditContext(req) });
    if (event.startsWith('screen-')) await relayRoomData(req, { kind: 'screen-status', event, identity: req.roomSession.identity, displayName: req.roomSession.displayName, sentAt: new Date().toISOString() });
    res.json({ acknowledged: true });
  }));

  app.get('/api/questions', requireRoomSession, roomMeeting, asyncHandler(async (req, res) => {
    const items = await questions.list(req.roomSession.room);
    res.json({ questions: items.map((item) => questions.publicQuestion(item, req.roomSession.identity)) });
  }));

  app.post('/api/questions', requireRoomSession, requireRoomCsrf, chatLimiter, roomMeeting, asyncHandler(async (req, res) => {
    if (!req.meeting.allowQuestions || req.meeting.status !== 'LIVE') throw new AppError(409, 'Las preguntas no están disponibles', 'QUESTIONS_DISABLED');
    await assertCallerPresent(req);
    const record = await questions.create({
      room: req.roomSession.room,
      meetingId: req.meeting.id,
      text: req.body?.text,
      authorIdentity: req.roomSession.identity,
      authorName: req.roomSession.displayName,
      authorRole: req.roomSession.role,
    });
    const item = questions.publicQuestion(record, req.roomSession.identity);
    await relayRoomData(req, { kind: 'question-changed', questionId: record.id, sentAt: record.createdAt });
    await safeAudit({ actor: req.roomSession.identity, action: 'QUESTION_CREATED', target: record.id, room: req.meeting.room, ...auditContext(req) });
    res.status(201).json({ question: item });
  }));

  app.patch('/api/questions/:id', requireRoomSession, requireRoomCsrf, interactionLimiter, roomMeeting, asyncHandler(async (req, res) => {
    if (req.meeting.status !== 'LIVE') throw new AppError(409, 'La reunión no está en vivo', 'MEETING_NOT_LIVE');
    await assertCallerPresent(req);
    const before = await questions.get(req.roomSession.room, req.params.id);
    const record = await questions.update(req.roomSession.room, req.params.id, req.body || {}, {
      identity: req.roomSession.identity, role: req.roomSession.role, name: req.roomSession.displayName,
    });
    await relayRoomData(req, { kind: 'question-changed', questionId: record.id, sentAt: record.updatedAt });
    let action = 'QUESTION_EDITED';
    if (record.status === 'DISMISSED' && before?.status !== record.status) action = 'QUESTION_DISMISSED';
    else if (record.status.startsWith('ANSWERED') && before?.status !== record.status) action = 'QUESTION_ANSWERED';
    await safeAudit({ actor: req.roomSession.identity, action, target: record.id, room: req.meeting.room, metadata: { status: record.status }, ...auditContext(req) });
    res.json({ question: questions.publicQuestion(record, req.roomSession.identity) });
  }));

  app.post('/api/questions/:id/vote', requireRoomSession, requireRoomCsrf, interactionLimiter, roomMeeting, asyncHandler(async (req, res) => {
    if (req.meeting.status !== 'LIVE') throw new AppError(409, 'La reunión no está en vivo', 'MEETING_NOT_LIVE');
    await assertCallerPresent(req);
    const record = await questions.toggleVote(req.roomSession.room, req.params.id, req.roomSession.identity);
    await relayRoomData(req, { kind: 'question-changed', questionId: record.id, sentAt: record.updatedAt });
    res.json({ question: questions.publicQuestion(record, req.roomSession.identity) });
  }));

  app.delete('/api/questions/:id', requireRoomSession, requireRoomCsrf, interactionLimiter, roomMeeting, asyncHandler(async (req, res) => {
    if (req.meeting.status !== 'LIVE') throw new AppError(409, 'La reunión no está en vivo', 'MEETING_NOT_LIVE');
    await assertCallerPresent(req);
    const record = await questions.remove(req.roomSession.room, req.params.id, { identity: req.roomSession.identity, role: req.roomSession.role });
    await relayRoomData(req, { kind: 'question-deleted', questionId: record.id, sentAt: new Date().toISOString() });
    res.json({ deleted: true });
  }));

  app.post('/api/participants/promote', requireRoomSession, requireRoomCsrf, requireRoomRoles('ADMIN', 'ORGANIZER'), interactionLimiter, roomMeeting, asyncHandler(async (req, res) => {
    if (req.meeting.status !== 'LIVE') throw new AppError(409, 'La reunión no está en vivo', 'MEETING_NOT_LIVE');
    const targetIdentity = sanitizeText(req.body?.targetIdentity, { field: 'targetIdentity', min: 5, max: 100, required: true });
    const participants = await assertCallerPresent(req);
    if (!participants.some((participant) => participant.identity === targetIdentity)) throw new AppError(404, 'Participante no encontrado', 'NOT_FOUND');
    await roomService.updateParticipant(req.roomSession.room, targetIdentity, publishPermission(true));
    await roomRegistry.setSpeakerGrant(req.roomSession.room, targetIdentity, true, req.roomSession.identity);
    await relayRoomData(req, { kind: 'hand-approved', targetIdentity, sentAt: new Date().toISOString() }, [targetIdentity]);
    await safeAudit({ actor: req.roomSession.identity, action: 'PARTICIPANT_PROMOTED', target: targetIdentity, room: req.roomSession.room, ...auditContext(req) });
    await safeAudit({ actor: req.roomSession.identity, action: 'SPEAKING_RIGHT_GRANTED', target: targetIdentity, room: req.roomSession.room, ...auditContext(req) });
    res.json({ promoted: true, targetIdentity, canPublish: true });
  }));

  app.post('/api/participants/demote', requireRoomSession, requireRoomCsrf, requireRoomRoles('ADMIN', 'ORGANIZER'), interactionLimiter, roomMeeting, asyncHandler(async (req, res) => {
    if (req.meeting.status !== 'LIVE') throw new AppError(409, 'La reunión no está en vivo', 'MEETING_NOT_LIVE');
    const targetIdentity = sanitizeText(req.body?.targetIdentity, { field: 'targetIdentity', min: 5, max: 100, required: true });
    const participants = await assertCallerPresent(req);
    if (!participants.some((participant) => participant.identity === targetIdentity)) throw new AppError(404, 'Participante no encontrado', 'NOT_FOUND');
    await roomService.updateParticipant(req.roomSession.room, targetIdentity, publishPermission(false));
    await roomRegistry.setSpeakerGrant(req.roomSession.room, targetIdentity, false, req.roomSession.identity);
    await relayRoomData(req, { kind: 'word-revoked', targetIdentity, sentAt: new Date().toISOString() }, [targetIdentity]);
    await safeAudit({ actor: req.roomSession.identity, action: 'PARTICIPANT_DEMOTED', target: targetIdentity, room: req.roomSession.room, ...auditContext(req) });
    await safeAudit({ actor: req.roomSession.identity, action: 'SPEAKING_RIGHT_REVOKED', target: targetIdentity, room: req.roomSession.room, ...auditContext(req) });
    res.json({ demoted: true, targetIdentity, canPublish: false });
  }));

  app.post('/api/participants/self-demote', requireRoomSession, requireRoomCsrf, roomMeeting, asyncHandler(async (req, res) => {
    await roomService.updateParticipant(req.roomSession.room, req.roomSession.identity, publishPermission(false));
    await roomRegistry.setSpeakerGrant(req.roomSession.room, req.roomSession.identity, false, req.roomSession.identity);
    res.json({ demoted: true });
  }));

  app.post('/api/participants/remove', requireRoomSession, requireRoomCsrf, requireRoomRoles('ADMIN', 'ORGANIZER'), interactionLimiter, roomMeeting, asyncHandler(async (req, res) => {
    if (req.meeting.status !== 'LIVE') throw new AppError(409, 'La reunión no está en vivo', 'MEETING_NOT_LIVE');
    const targetIdentity = sanitizeText(req.body?.targetIdentity, { field: 'targetIdentity', min: 5, max: 100, required: true });
    const participants = await assertCallerPresent(req);
    if (!participants.some((participant) => participant.identity === targetIdentity)) throw new AppError(404, 'Participante no encontrado', 'NOT_FOUND');
    await roomService.removeParticipant(req.roomSession.room, targetIdentity);
    await roomRegistry.setSpeakerGrant(req.roomSession.room, targetIdentity, false, req.roomSession.identity).catch(() => {});
    await safeAudit({ actor: req.roomSession.identity, action: 'PARTICIPANT_REMOVED', target: targetIdentity, room: req.roomSession.room, ...auditContext(req) });
    res.json({ removed: true });
  }));

  app.post('/api/participants/block', requireRoomSession, requireRoomCsrf, requireRoomRoles('ADMIN', 'ORGANIZER'), interactionLimiter, roomMeeting, asyncHandler(async (req, res) => {
    if (req.meeting.status !== 'LIVE') throw new AppError(409, 'La reunión no está en vivo', 'MEETING_NOT_LIVE');
    const targetIdentity = sanitizeText(req.body?.targetIdentity, { field: 'targetIdentity', min: 5, max: 100, required: true });
    const participants = await assertCallerPresent(req);
    const target = participants.find((participant) => participant.identity === targetIdentity);
    if (!target) throw new AppError(404, 'Participante no encontrado', 'NOT_FOUND');
    let metadata = {};
    try { metadata = JSON.parse(target.metadata || '{}'); } catch (_error) { metadata = {}; }
    if (metadata.invitationId) await invitations.revokeInvitation(metadata.invitationId, req.roomSession.room);
    await roomService.removeParticipant(req.roomSession.room, targetIdentity);
    await roomRegistry.setSpeakerGrant(req.roomSession.room, targetIdentity, false, req.roomSession.identity).catch(() => {});
    await safeAudit({ actor: req.roomSession.identity, action: 'PARTICIPANT_BLOCKED', target: targetIdentity, room: req.roomSession.room, metadata: { invitationRevoked: Boolean(metadata.invitationId) }, ...auditContext(req) });
    res.json({ blocked: true, invitationRevoked: Boolean(metadata.invitationId) });
  }));

  app.post('/api/participants/request-media', requireRoomSession, requireRoomCsrf, requireRoomRoles('ADMIN', 'ORGANIZER'), interactionLimiter, roomMeeting, asyncHandler(async (req, res) => {
    if (req.meeting.status !== 'LIVE') throw new AppError(409, 'La reunión no está en vivo', 'MEETING_NOT_LIVE');
    const targetIdentity = sanitizeText(req.body?.targetIdentity, { field: 'targetIdentity', min: 5, max: 100, required: true });
    const action = String(req.body?.action || 'request-microphone');
    if (!['request-microphone', 'request-camera-off'].includes(action)) throw new AppError(400, 'Solicitud multimedia no válida', 'VALIDATION_ERROR');
    const participants = await assertCallerPresent(req);
    const target = participants.find((participant) => participant.identity === targetIdentity);
    if (!target) throw new AppError(404, 'El participante ya no está conectado', 'PARTICIPANT_NOT_CONNECTED');
    const now = Date.now();
    for (const [id, pending] of pendingMediaRequests) if (pending.expiresAt <= now) pendingMediaRequests.delete(id);
    const duplicate = [...pendingMediaRequests.values()].find((pending) => pending.room === req.roomSession.room && pending.targetIdentity === targetIdentity && pending.action === action);
    if (duplicate) throw new AppError(409, 'Ya existe una solicitud pendiente para este participante', 'MEDIA_REQUEST_PENDING');
    const requestId = crypto.randomUUID();
    pendingMediaRequests.set(requestId, {
      requestId,
      room: req.roomSession.room,
      targetIdentity,
      requesterIdentity: req.roomSession.identity,
      requesterName: req.roomSession.displayName,
      action,
      accepted: false,
      permissionGranted: false,
      expiresAt: now + 60_000,
    });
    await relayRoomData(req, { kind: action, requestId, from: req.roomSession.displayName, fromIdentity: req.roomSession.identity, sentAt: new Date(now).toISOString() }, [targetIdentity]);
    if (action === 'request-microphone') await safeAudit({ actor: req.roomSession.identity, action: 'MICROPHONE_REQUESTED', target: targetIdentity, room: req.roomSession.room, ...auditContext(req) });
    res.json({ sent: true, requestId, expiresInMs: 60_000 });
  }));

  app.post('/api/participants/media-response', requireRoomSession, requireRoomCsrf, interactionLimiter, roomMeeting, asyncHandler(async (req, res) => {
    const requestId = sanitizeText(req.body?.requestId, { field: 'requestId', min: 36, max: 36, required: true });
    const status = String(req.body?.status || '').toLowerCase();
    if (!['accepted', 'activated', 'rejected', 'failed'].includes(status)) throw new AppError(400, 'Respuesta multimedia no válida', 'VALIDATION_ERROR');
    const pending = pendingMediaRequests.get(requestId);
    if (!pending || pending.room !== req.roomSession.room || pending.expiresAt <= Date.now()) {
      pendingMediaRequests.delete(requestId);
      throw new AppError(404, 'La solicitud ya no está disponible', 'MEDIA_REQUEST_NOT_FOUND');
    }
    if (pending.targetIdentity !== req.roomSession.identity) throw new AppError(403, 'No puedes responder esta solicitud', 'ROOM_FORBIDDEN');
    const participants = await assertCallerPresent(req);
    const target = participants.find((participant) => participant.identity === req.roomSession.identity);
    if (!participants.some((participant) => participant.identity === pending.requesterIdentity)) {
      pendingMediaRequests.delete(requestId);
      throw new AppError(404, 'El organizador ya no está conectado', 'PARTICIPANT_NOT_CONNECTED');
    }
    if (status === 'accepted') {
      if (pending.accepted) throw new AppError(409, 'La solicitud ya fue aceptada', 'MEDIA_REQUEST_ALREADY_ACCEPTED');
      if (pending.action === 'request-microphone' && !participantCanPublish(target)) {
        await roomService.updateParticipant(req.roomSession.room, req.roomSession.identity, publishPermission(true));
        await roomRegistry.setSpeakerGrant(req.roomSession.room, req.roomSession.identity, true, pending.requesterIdentity);
        pending.permissionGranted = true;
      }
      pending.accepted = true;
      pending.expiresAt = Date.now() + 30_000;
      await relayRoomData(req, { kind: 'media-response', requestId, action: pending.action, status, targetIdentity: req.roomSession.identity, displayName: req.roomSession.displayName, sentAt: new Date().toISOString() }, [pending.requesterIdentity]);
      return res.json({ accepted: true, permissionGranted: pending.permissionGranted, canPublish: true });
    }
    if (status === 'activated' && !pending.accepted) throw new AppError(409, 'Primero debes aceptar la solicitud', 'MEDIA_REQUEST_NOT_ACCEPTED');
    if (status === 'failed' && pending.permissionGranted) {
      await roomService.updateParticipant(req.roomSession.room, req.roomSession.identity, publishPermission(false));
      await roomRegistry.setSpeakerGrant(req.roomSession.room, req.roomSession.identity, false, pending.requesterIdentity);
    }
    pendingMediaRequests.delete(requestId);
    const auditAction = status === 'rejected' ? 'MICROPHONE_REQUEST_REJECTED' : status === 'failed' ? 'MICROPHONE_REQUEST_FAILED' : 'MICROPHONE_REQUEST_ACCEPTED';
    await safeAudit({ actor: req.roomSession.identity, action: auditAction, target: pending.requesterIdentity, room: req.roomSession.room, metadata: { status }, ...auditContext(req) });
    await relayRoomData(req, { kind: 'media-response', requestId, action: pending.action, status, targetIdentity: req.roomSession.identity, displayName: req.roomSession.displayName, sentAt: new Date().toISOString() }, [pending.requesterIdentity]);
    res.json({ acknowledged: true, status });
  }));

  app.post('/api/participants/mute', requireRoomSession, requireRoomCsrf, requireRoomRoles('ADMIN', 'ORGANIZER'), interactionLimiter, roomMeeting, asyncHandler(async (req, res) => {
    if (req.meeting.status !== 'LIVE') throw new AppError(409, 'La reunión no está en vivo', 'MEETING_NOT_LIVE');
    const targetIdentity = sanitizeText(req.body?.targetIdentity, { field: 'targetIdentity', min: 5, max: 100, required: true });
    const participants = await assertCallerPresent(req);
    const target = participants.find((participant) => participant.identity === targetIdentity);
    if (!target) throw new AppError(404, 'Participante no encontrado', 'NOT_FOUND');
    const microphoneTrack = (target.tracks || []).find((track) => String(track.source).toUpperCase().includes('MICROPHONE') || track.type === 0);
    if (!microphoneTrack?.sid) throw new AppError(409, 'El participante no tiene un micrófono publicado', 'MICROPHONE_NOT_PUBLISHED');
    await roomService.mutePublishedTrack(req.roomSession.room, targetIdentity, microphoneTrack.sid, true);
    await safeAudit({ actor: req.roomSession.identity, action: 'MICROPHONE_MUTED', target: targetIdentity, room: req.roomSession.room, ...auditContext(req) });
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
      await safeAudit({ actor: req.roomSession.identity, action: 'HAND_REJECTED', target: targetIdentity, room: req.roomSession.room, ...auditContext(req) });
    } else if (kind === 'reaction') {
      if (!req.meeting.allowReactions) throw new AppError(409, 'Las reacciones están deshabilitadas', 'REACTIONS_DISABLED');
      const reaction = sanitizeText(req.body?.reaction, { field: 'reaction', min: 1, max: 8, required: true });
      if (!['👏', '👍', '❤️', '😂', '🎉', '✅'].includes(reaction)) throw new AppError(400, 'Reacción no válida', 'VALIDATION_ERROR');
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

  app.get('/api/recording/status', requireRoomSession, roomMeeting, asyncHandler(async (req, res) => {
    if (!recordingConfigured || !req.meeting.allowRecording) return res.json({ state: 'DISABLED', active: false, egressId: null, configured: false });
    try {
      const active = await egressClient.listEgress({ roomName: req.roomSession.room, active: true });
      const state = active.length ? recordingStateFromEgress(active[0]) : { state: 'IDLE', active: false, egressId: null };
      res.json({ ...state, configured: true });
    } catch {
      res.json({ state: 'FAILED', active: false, egressId: null, configured: true, message: 'No fue posible consultar Egress.' });
    }
  }));

  app.post('/api/recording/start', requireRoomSession, requireRoomCsrf, requireRoomRoles('ADMIN', 'ORGANIZER'), roomMeeting, asyncHandler(async (req, res) => {
    try {
      if (!recordingConfigured) throw new AppError(400, 'La grabación no está configurada', 'RECORDING_NOT_CONFIGURED');
      if (!req.meeting.allowRecording || req.meeting.status !== 'LIVE') throw new AppError(409, 'La grabación no está permitida en esta reunión', 'RECORDING_DISABLED');
      const participants = await assertCallerPresent(req);
      const existing = await egressClient.listEgress({ roomName: req.roomSession.room, active: true });
      if (existing.length > 0) return res.json({ ...recordingStateFromEgress(existing[0]), alreadyRunning: true });
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
      const metadata = {
        source: 'ROOM_COMPOSITE', meetingId: req.meeting.id, room: req.meeting.room, egressId: info.egressId,
        createdAt: new Date().toISOString(),
        participants: participants.map((participant) => ({ identity: participant.identity, name: participant.name || participant.identity })),
        tracks: participants.flatMap((participant) => (participant.tracks || []).map((track) => ({
          trackSid: track.sid, participantIdentity: participant.identity, participantName: participant.name || participant.identity,
          source: track.source, type: track.type,
        }))),
      };
      if (s3 && bucket) {
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `${filepath}.metadata.json`, Body: JSON.stringify(metadata), ContentType: 'application/json' })).catch(() => null);
      }
      const state = recordingStateFromEgress(info);
      await relayRoomData(req, { kind: 'recording-status', ...state, sentAt: new Date().toISOString() });
      await safeAudit({ actor: req.roomSession.identity, action: 'RECORDING_STARTED', target: info.egressId, room: req.roomSession.room, metadata: { state: state.state }, ...auditContext(req) });
      res.json({ ...state, alreadyRunning: false });
    } catch (error) {
      await safeAudit({ actor: req.roomSession.identity, action: 'RECORDING_FAILED', target: req.meeting.id, room: req.roomSession.room, metadata: { operation: 'start', code: error.code || 'EGRESS_ERROR' }, ...auditContext(req) });
      throw error;
    }
  }));

  app.post('/api/recording/stop', requireRoomSession, requireRoomCsrf, requireRoomRoles('ADMIN', 'ORGANIZER'), roomMeeting, asyncHandler(async (req, res) => {
    try {
      await assertCallerPresent(req);
      const egressId = sanitizeText(req.body?.egressId, { field: 'egressId', min: 5, max: 120, required: true });
      const active = await egressClient.listEgress({ roomName: req.roomSession.room, active: true });
      if (!active.some((egress) => egress.egressId === egressId)) throw new AppError(404, 'Grabación activa no encontrada en esta sala', 'NOT_FOUND');
      const info = await egressClient.stopEgress(egressId);
      const state = recordingStateFromEgress(info);
      const responseState = state.active ? state : { state: state.state === 'FAILED' ? 'FAILED' : 'PROCESSING', active: false, egressId: null };
      await relayRoomData(req, { kind: 'recording-status', ...responseState, sentAt: new Date().toISOString() });
      await safeAudit({ actor: req.roomSession.identity, action: 'RECORDING_STOPPED', target: egressId, room: req.roomSession.room, ...auditContext(req) });
      res.json({ stopped: true, ...responseState });
    } catch (error) {
      await safeAudit({ actor: req.roomSession.identity, action: 'RECORDING_FAILED', target: req.body?.egressId || req.meeting.id, room: req.roomSession.room, metadata: { operation: 'stop', code: error.code || 'EGRESS_ERROR' }, ...auditContext(req) });
      throw error;
    }
  }));

  app.post('/api/room/end', requireRoomSession, requireRoomCsrf, requireRoomRoles('ADMIN', 'ORGANIZER'), roomMeeting, asyncHandler(async (req, res) => {
    await assertCallerPresent(req);
    const updated = await meetings.transitionMeeting(req.roomSession.room, 'complete');
    await roomRegistry.revokeRoom(req.roomSession.room);
    await roomService.deleteRoom(req.roomSession.room).catch((error) => {
      if (!/not found/i.test(error.message || '')) throw error;
    });
    res.setHeader('Set-Cookie', [clearRoomCookie(), clearRoomCookie(req.roomSessionSelector)]);
    await safeAudit({ actor: req.roomSession.identity, action: 'ROOM_ENDED', target: updated.id, room: updated.room, ...auditContext(req) });
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
         const resolved = meeting ? await defaultRecordingResolver(object.Key, meeting) : null;
         const transcript = meeting ? (await transcriptions.listTranscripts({ meetingId: meeting.id })).find((item) => item.recordingId === object.Key) : null;
         return {
           id: object.Key,
           key: object.Key,
           room,
           meetingId: meeting?.id || null,
           title: meeting?.title || room,
           trainerName: meeting?.trainerName || 'Capacitador por definir',
           size: object.Size,
           lastModified: object.LastModified,
           status: 'READY',
           source: resolved?.source || 'ROOM_COMPOSITE',
           participants: resolved?.participants || [],
           tracks: resolved?.tracks || [],
           url: resolved?.url,
           transcript: transcript ? transcriptions.publicTranscript(transcript) : null,
           transcriptionAllowed: Boolean(meeting?.allowTranscription && meeting?.status === 'COMPLETED'),
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

  app.post('/api/meetings/:meetingId/transcriptions', auth.requireAuth, auth.requireCsrf, auth.requireRoles('ADMIN', 'ORGANIZER'), transcriptionLimiter, asyncHandler(async (req, res) => {
    const meeting = await meetingByReference(req.params.meetingId);
    if (!meeting) throw new AppError(404, 'Reunión no encontrada', 'NOT_FOUND');
    if (!canManageMeeting(req.auth, meeting)) throw new AppError(403, 'No tienes permiso para transcribir esta reunión', 'FORBIDDEN');
    const recording = await resolveRecording(req.body?.recordingId, meeting);
    if (!recording) throw new AppError(409, 'La reunión no tiene una grabación disponible', 'RECORDING_NOT_FOUND');
    if (recording.status !== 'READY') throw new AppError(409, 'La grabación todavía no está lista', 'RECORDING_NOT_READY');
    if (recording.durationSeconds && recording.durationSeconds > config.transcriptionMaxDurationMinutes * 60) {
      throw new AppError(413, 'La grabación supera la duración máxima permitida para transcripción', 'TRANSCRIPTION_TOO_LONG');
    }
    const transcript = await transcriptions.createTranscript({
      meeting, recording, requestedBy: req.auth.u, language: req.body?.language, provider: transcriptionProvider,
    });
    await safeAudit({ actor: req.auth.u, action: 'TRANSCRIPTION_CREATED', target: transcript.id, room: meeting.room, metadata: { recordingId: recording.id, provider: transcript.provider }, ...auditContext(req) });
    res.status(201).json({ transcript: transcriptions.publicTranscript(transcript) });
  }));

  app.get('/api/meetings/:meetingId/transcriptions', auth.requireAuth, auth.requireRoles('ADMIN', 'ORGANIZER', 'PANELIST'), asyncHandler(async (req, res) => {
    const meeting = await meetingByReference(req.params.meetingId);
    if (!meeting) throw new AppError(404, 'Reunión no encontrada', 'NOT_FOUND');
    if (!canViewTranscript(req.auth, meeting)) throw new AppError(403, 'No tienes permiso para ver estas transcripciones', 'FORBIDDEN');
    const items = (await transcriptions.listTranscripts({ meetingId: meeting.id })).map(transcriptions.publicTranscript);
    res.json({ items, configured: transcriptionProvider.isConfigured(), allowed: meeting.allowTranscription });
  }));

  app.get('/api/transcriptions/:id', auth.requireAuth, auth.requireRoles('ADMIN', 'ORGANIZER', 'PANELIST'), requireTranscript, asyncHandler(async (req, res) => {
    let transcript = req.transcript;
    let recording = await resolveRecording(transcript.recordingId, req.transcriptMeeting).catch(() => null);
    if (!transcriptions.TERMINAL_STATUSES.has(transcript.status) && transcriptionProvider.isConfigured()) {
      transcript = await transcriptions.refreshTranscript(transcript, transcriptionProvider, recording || {});
      if (transcript.status === 'FAILED') await safeAudit({ actor: req.auth.u, action: 'TRANSCRIPTION_FAILED', target: transcript.id, room: req.transcriptMeeting.room, metadata: { code: transcript.errorCode }, ...auditContext(req) });
      if (transcriptions.COMPLETE_STATUSES.has(transcript.status)) await safeAudit({ actor: req.auth.u, action: 'TRANSCRIPTION_COMPLETED', target: transcript.id, room: req.transcriptMeeting.room, metadata: { segments: transcript.segments.length }, ...auditContext(req) });
    }
    res.json({ transcript: transcriptions.publicTranscript(transcript), meeting: req.transcriptMeeting, recording: recording ? { id: recording.id, url: recording.url, source: recording.source } : null, configured: transcriptionProvider.isConfigured() });
  }));

  app.patch('/api/transcriptions/:id', auth.requireAuth, auth.requireCsrf, auth.requireRoles('ADMIN', 'ORGANIZER'), requireTranscript, asyncHandler(async (req, res) => {
    if (!canManageMeeting(req.auth, req.transcriptMeeting)) throw new AppError(403, 'No tienes permiso para editar esta transcripción', 'FORBIDDEN');
    const transcript = await transcriptions.editTranscript(req.transcript, {
      segments: req.body?.segments, language: req.body?.language, revision: req.body?.revision, editedBy: req.auth.u,
    });
    await safeAudit({ actor: req.auth.u, action: 'TRANSCRIPTION_EDITED', target: transcript.id, room: req.transcriptMeeting.room, metadata: { revision: transcript.revision }, ...auditContext(req) });
    res.json({ transcript: transcriptions.publicTranscript(transcript) });
  }));

  app.delete('/api/transcriptions/:id', auth.requireAuth, auth.requireCsrf, auth.requireRoles('ADMIN', 'ORGANIZER'), requireTranscript, asyncHandler(async (req, res) => {
    if (!canManageMeeting(req.auth, req.transcriptMeeting)) throw new AppError(403, 'No tienes permiso para eliminar esta transcripción', 'FORBIDDEN');
    if (!transcriptions.TERMINAL_STATUSES.has(req.transcript.status)) throw new AppError(409, 'Cancela el trabajo antes de eliminar la transcripción', 'TRANSCRIPTION_ACTIVE');
    await transcriptions.deleteTranscript(req.transcript);
    await safeAudit({ actor: req.auth.u, action: 'TRANSCRIPTION_DELETED', target: req.transcript.id, room: req.transcriptMeeting.room, ...auditContext(req) });
    res.json({ deleted: true });
  }));

  app.post('/api/transcriptions/:id/retry', auth.requireAuth, auth.requireCsrf, auth.requireRoles('ADMIN', 'ORGANIZER'), transcriptionLimiter, requireTranscript, asyncHandler(async (req, res) => {
    if (!canManageMeeting(req.auth, req.transcriptMeeting)) throw new AppError(403, 'No tienes permiso para regenerar esta transcripción', 'FORBIDDEN');
    const recording = await resolveRecording(req.transcript.recordingId, req.transcriptMeeting);
    if (!recording || recording.status !== 'READY') throw new AppError(409, 'La grabación ya no está disponible', 'RECORDING_NOT_READY');
    const transcript = await transcriptions.retryTranscript(req.transcript, { meeting: req.transcriptMeeting, recording, requestedBy: req.auth.u, provider: transcriptionProvider });
    await safeAudit({ actor: req.auth.u, action: 'TRANSCRIPTION_RETRIED', target: transcript.id, room: req.transcriptMeeting.room, ...auditContext(req) });
    res.json({ transcript: transcriptions.publicTranscript(transcript) });
  }));

  app.post('/api/transcriptions/:id/cancel', auth.requireAuth, auth.requireCsrf, auth.requireRoles('ADMIN', 'ORGANIZER'), requireTranscript, asyncHandler(async (req, res) => {
    if (!canManageMeeting(req.auth, req.transcriptMeeting)) throw new AppError(403, 'No tienes permiso para cancelar esta transcripción', 'FORBIDDEN');
    const transcript = await transcriptions.cancelTranscript(req.transcript, transcriptionProvider);
    await safeAudit({ actor: req.auth.u, action: 'TRANSCRIPTION_CANCELLED', target: transcript.id, room: req.transcriptMeeting.room, ...auditContext(req) });
    res.json({ transcript: transcriptions.publicTranscript(transcript) });
  }));

  app.get('/api/transcriptions/:id/export', auth.requireAuth, auth.requireRoles('ADMIN', 'ORGANIZER', 'PANELIST'), requireTranscript, asyncHandler(async (req, res) => {
    const exported = transcriptions.exportTranscript(req.transcript, req.query.format);
    const filename = `${slugify(req.transcriptMeeting.title || 'transcripcion') || 'transcripcion'}-${req.transcript.id.slice(0, 8)}.${exported.extension}`;
    res.setHeader('Content-Type', exported.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(exported.body);
  }));

  app.get('/api/audit', auth.requireAuth, auth.requireRoles('ADMIN'), asyncHandler(async (req, res) => {
    const limit = Number.parseInt(req.query.limit || '200', 10);
    res.json({ items: await audit.listEvents({ limit, action: req.query.action, actor: req.query.actor, room: req.query.room }) });
  }));

  app.get('/api/dashboard/summary', auth.requireAuth, auth.requireRoles('ADMIN', 'ORGANIZER'), asyncHandler(async (req, res) => {
    const allMeetings = (await meetings.listMeetings({ includeDeleted: false })).filter((meeting) => meetingVisibleTo(req.auth, meeting));
    const today = localDateKey();
    const users = req.auth.role === 'ADMIN' ? await auth.listUsers() : [];
    const since = Date.now() - 24 * 60 * 60_000;
    const recentErrors = req.auth.role === 'ADMIN'
      ? (await audit.listEvents({ limit: 1_000 })).filter((item) => item.action === 'AUTH_LOGIN_FAILED' && new Date(item.timestamp).getTime() >= since).length
      : null;
    const livekit = await livekitProbe();
    res.json({
      meetingsToday: allMeetings.filter((meeting) => meeting.status === 'SCHEDULED' && localDateKey(meeting.scheduledAt) === today).length,
      activeMeetings: livekit.available ? allMeetings.filter((meeting) => meeting.status === 'LIVE' && meeting.livekitConfirmedAt).length : 0,
      nextMeeting: allMeetings.filter((meeting) => meeting.scheduledAt && new Date(meeting.scheduledAt) >= new Date() && !['CANCELLED', 'COMPLETED', 'ARCHIVED'].includes(meeting.status)).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))[0] || null,
      activeCredentials: users.filter((user) => user.active).length,
      recentErrors,
      storage: storageConfigured ? 'configured' : 'local',
      livekit,
      recordingConfigured,
      transcriptionConfigured: transcriptionProvider.isConfigured(),
      transcriptionProvider: config.transcriptionProvider,
      environment: config.nodeEnv,
      version: String(process.env.RENDER_GIT_COMMIT || 'local').slice(0, 12),
      security: { secureCookies: config.cookieSecure, openDevRooms: config.allowOpenDevRooms },
      missingConfiguration: [
        LIVEKIT_API_KEY === 'devkey' ? 'LIVEKIT_API_KEY' : null,
        !storageConfigured ? 'S3/R2' : null,
        !recordingConfigured ? 'RECORDING_S3_*' : null,
        !transcriptionProvider.isConfigured() ? 'TRANSCRIPTION_*' : null,
      ].filter(Boolean),
    });
  }));

  app.get('/api/health', asyncHandler(async (_req, res) => {
    const livekit = await livekitProbe();
    res.json({ ok: true, storage: storageConfigured ? 's3' : 'local', livekit, recordingConfigured, transcriptionConfigured: transcriptionProvider.isConfigured() });
  }));

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint no encontrado', code: 'NOT_FOUND' }));
  app.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError) {
      const message = error.code === 'LIMIT_FILE_SIZE' ? 'El archivo supera el tamaño permitido' : 'No se pudo procesar el archivo';
      return res.status(400).json({ error: message, code: error.code });
    }
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'La solicitud supera el tamaño permitido', code: 'PAYLOAD_TOO_LARGE' });
    if (error instanceof SyntaxError && error.status === 400 && 'body' in error) return res.status(400).json({ error: 'JSON no válido', code: 'INVALID_JSON' });
    const status = error instanceof AppError ? error.status : 500;
    if (status >= 500 && !(error instanceof AppError)) console.error('request error', error.message);
    return res.status(status).json({
      error: error instanceof AppError ? error.message : status >= 500 ? 'Ocurrió un error interno' : error.message,
      code: error.code || 'INTERNAL_ERROR',
    });
  });

  app.locals.services = services;
  app.locals.livekitProbe = livekitProbe;
  app.locals.rateLimiters = { loginLimiter, meetingLimiter, transcriptionLimiter, chatLimiter, interactionLimiter };
  return app;
}

module.exports = { canManageMeeting, createApp, localDateKey, recordingConfigured, recordingStateFromEgress };
