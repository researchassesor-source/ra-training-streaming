const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { PutObjectCommand, ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { AccessToken, RoomServiceClient, EgressClient, EgressStatus, EncodedFileType, DataPacket_Kind, TrackSource } = require('livekit-server-sdk');
const { s3, storageConfigured, bucket, storageStatus } = require('./s3');
const { config, publicUrl } = require('./config');
const { buildInvitationMessage, invitationSharePayload } = require('./invitation-message');
const { log } = require('./logger');
const roomRegistry = require('./rooms');
const auth = require('./auth');
const meetings = require('./meetings');
const invitations = require('./invitations');
const audit = require('./audit');
const questions = require('./questions');
const pinnedMessages = require('./pinned-messages');
const transcriptions = require('./transcriptions');
const trainingSeries = require('./training-series');
const seriesAccesses = require('./series-accesses');
const speakerRequests = require('./speaker-requests');
const attendance = require('./attendance');
const liveKitWebhooks = require('./livekit-webhooks');
const idempotency = require('./idempotency');
const redis = require('./redis');
const db = require('./db');
const backgroundJobs = require('./background-jobs');
const externalSessions = require('./external-sessions');
const { classifyProviderError } = require('./provider-errors');
const { createTranscriptionProvider } = require('./transcription-provider');
const recordings = require('./recordings');
const { parseLimit } = require('./pagination');
const { createHealthRouter } = require('./routes/health.routes');
const {
  clearRoomCookie,
  createRoomSession,
  requireRoomCapability,
  requireRoomCsrf,
  requireRoomSession,
  roomCookie,
  updateConsents,
  updateDisplayName,
} = require('./room-session');
const {
  createSeriesSession,
  requireSeriesCsrf,
  requireSeriesSession,
  seriesCookie,
  updateSeriesSession,
} = require('./series-session');
const {
  invitationRolesForType,
  legacyDefaultMeetingRole,
  legacyRoleForMeetingRole,
  normalizeMeetingRole,
  normalizeMeetingType,
  resolvePublishSources,
  roleCapabilities,
} = require('./meeting-permissions');
const { createRateLimiter } = require('./rate-limit');
const { createLiveKitStatusProbe } = require('./livekit-status');
const { assertValidFileContent } = require('./file-validation');
const {
  facebookStateFromEgress,
  facebookStartFailureMessage,
  isRecordingEgress,
  isStreamingEgress,
  validateFacebookDestination,
} = require('./facebook-live');
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

const LIVEKIT_API_KEY = config.livekitApiKey;
const LIVEKIT_API_SECRET = config.livekitApiSecret;
const LIVEKIT_WS_URL = config.livekitWsUrl;
const LIVEKIT_HTTP_URL = LIVEKIT_WS_URL.replace(/^ws/, 'http');
const recordingConfigured = Boolean(
  process.env.RECORDING_S3_ACCESS_KEY &&
  process.env.RECORDING_S3_SECRET_KEY &&
  process.env.RECORDING_S3_BUCKET
);

function safeRequestPath(pathname) {
  return String(pathname || '').replace(/^\/(i|s)\/[^/]+/, '/$1/[redacted]').slice(0, 300);
}

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

function withoutSeriesLinkage(input) {
  const clean = { ...(input && typeof input === 'object' ? input : {}) };
  delete clean.seriesId;
  delete clean.sessionNumber;
  return clean;
}

function canManageSeries(actor, series) {
  if (!actor || !series) return false;
  if (actor.role === 'ADMIN') return true;
  return actor.role === 'ORGANIZER' && (series.createdBy === actor.u || series.trainerId === actor.u);
}

function participantMetadata(participant) {
  try {
    const value = JSON.parse(participant?.metadata || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function liveKitSourceValues(sourceNames = []) {
  return sourceNames.map((name) => TrackSource[name]).filter((value) => Number.isInteger(value));
}

function publishPermission(sourceNames = []) {
  const canPublishSources = liveKitSourceValues(sourceNames);
  return { permission: { canPublish: canPublishSources.length > 0, canPublishSources, canSubscribe: true, canPublishData: false } };
}

function simpleAccessMeetingRole(type, kind) {
  const meetingType = normalizeMeetingType(type);
  const normalized = String(kind || '').toUpperCase();
  if (normalized === 'HOST') return meetingType === 'CLASS' ? 'TEACHER' : 'HOST';
  if (normalized === 'PARTICIPANT') {
    if (meetingType === 'SESSION') return 'PARTICIPANT';
    if (meetingType === 'CLASS') return 'STUDENT';
    return 'ATTENDEE';
  }
  throw new AppError(400, 'Tipo de acceso no válido', 'VALIDATION_ERROR');
}

function simpleAccessKind(value) {
  const kind = String(value || '').toUpperCase();
  if (['HOST', 'PARTICIPANT'].includes(kind)) return kind;
  throw new AppError(400, 'Tipo de acceso no válido', 'VALIDATION_ERROR');
}

function simpleAccessSecret() {
  return config.invitationHashSecret || config.sessionSecret;
}

function signSimpleMeetingAccessPayload(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', simpleAccessSecret()).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function readSimpleMeetingAccessToken(token) {
  const text = String(token || '');
  const [body, signature, extra] = text.split('.');
  if (!body || !signature || extra || body.length > 900 || signature.length > 120) {
    throw new AppError(404, 'Acceso no válido', 'MEETING_ACCESS_INVALID');
  }
  const expected = crypto.createHmac('sha256', simpleAccessSecret()).update(body).digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new AppError(404, 'Acceso no válido', 'MEETING_ACCESS_INVALID');
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw new AppError(404, 'Acceso no válido', 'MEETING_ACCESS_INVALID'); }
  if (payload?.type !== 'meeting-access' || payload.v !== 1) throw new AppError(404, 'Acceso no válido', 'MEETING_ACCESS_INVALID');
  return payload;
}

function simpleMeetingAccessPayload(meeting, kind) {
  const accessKind = simpleAccessKind(kind);
  const meetingRole = simpleAccessMeetingRole(meeting.type, accessKind);
  const token = signSimpleMeetingAccessPayload({
    type: 'meeting-access',
    v: 1,
    room: meeting.room,
    meetingId: meeting.id,
    kind: accessKind,
    meetingRole,
  });
  const path = `/a/${token}`;
  const url = publicUrl(path);
  const message = buildInvitationMessage({ meeting, role: meetingRole, url, sharedAccess: true });
  return {
    kind: accessKind,
    role: accessKind === 'HOST' ? 'Anfitrión' : 'Participante',
    meetingRole,
    path,
    url,
    message,
    whatsappUrl: `https://wa.me/?text=${encodeURIComponent(message)}`,
  };
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
    log('error', 'audit_write_error', { action: event?.action, room: event?.room, errorName: error.name, errorCode: error.code });
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
  const storageProbe = overrides.storageProbe || storageStatus;
  const pendingMediaRequests = new Map();
  const facebookEgressByRoom = new Map();

  function isFacebookEgress(room, info) {
    return isStreamingEgress(info) || facebookEgressByRoom.get(room)?.egressId === info?.egressId;
  }

  async function facebookEgress(room) {
    const egresses = await egressClient.listEgress({ roomName: room });
    const tracked = facebookEgressByRoom.get(room);
    const matches = egresses.filter((info) => isFacebookEgress(room, info));
    const trackedMatch = matches.find((info) => info.egressId === tracked?.egressId);
    if (trackedMatch && facebookStateFromEgress(trackedMatch).active) return trackedMatch;
    return matches.find((info) => facebookStateFromEgress(info).active) || trackedMatch || matches.at(-1) || null;
  }

  function publicFacebookState(room, info) {
    const metadata = facebookEgressByRoom.get(room) || {};
    const state = facebookStateFromEgress(info, metadata);
    facebookEgressByRoom.set(room, {
      provider: 'facebook',
      egressId: state.egressId,
      status: state.state,
      startedAt: metadata.startedAt || (state.active ? new Date().toISOString() : null),
      stoppedAt: state.active ? null : metadata.stoppedAt || (metadata.egressId ? new Date().toISOString() : null),
    });
    return { ...state, startedAt: facebookEgressByRoom.get(room).startedAt, stoppedAt: facebookEgressByRoom.get(room).stoppedAt };
  }

  async function transcriptionStatus(options) {
    if (typeof transcriptionProvider.healthStatus === 'function') return transcriptionProvider.healthStatus(options);
    const configured = transcriptionProvider.isConfigured();
    return { configured, available: configured, checkedAt: new Date().toISOString() };
  }

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    req.requestId = requestId;
    res.setHeader('X-Request-ID', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), picture-in-picture=(self)');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    res.setHeader('Content-Security-Policy', `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self' ${LIVEKIT_WS_URL || ''} ${LIVEKIT_HTTP_URL || ''} wss://*.livekit.cloud https://*.livekit.cloud`.trim());
    if (config.isProductionLike) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (config.noIndex) res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    if (req.path.startsWith('/api/') || req.path.startsWith('/i/') || req.path.startsWith('/s/')) res.setHeader('Cache-Control', 'no-store');
    if (config.nodeEnv !== 'test') res.on('finish', () => log('info', 'http_request', { requestId, method: req.method, path: safeRequestPath(req.path), status: res.statusCode, durationMs: Date.now() - startedAt }));
    next();
  });
  app.post('/api/webhooks/livekit', express.raw({ type: '*/*', limit: config.maxJsonPayload }), asyncHandler(async (req, res) => {
    const result = await liveKitWebhooks.receiveLiveKitWebhook(req.body.toString('utf8'), req.headers.authorization || req.headers.authorize);
    res.json({ received: true, duplicate: result.duplicate === true });
  }));

  app.use(express.json({ limit: config.maxJsonPayload, strict: true }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.get('/robots.txt', (_req, res) => {
    res.type('text/plain').send(config.noIndex ? 'User-agent: *\nDisallow: /\n' : 'User-agent: *\nAllow: /\n');
  });
  app.use(express.static(path.join(__dirname, '..', 'public'), {
    etag: true,
    maxAge: config.isProduction ? '1h' : 0,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
    },
  }));
  app.use('/vendor/livekit-client', express.static(path.join(__dirname, '..', 'node_modules', 'livekit-client', 'dist')));
  if (config.appEnv === 'development' || config.appEnv === 'test') {
    app.use('/docs', express.static(path.join(__dirname, '..', 'docs'), { etag: true, maxAge: 0 }));
  } else {
    app.use('/docs', (_req, res) => res.status(404).send('Not found'));
  }

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

  async function requireManagedSeries(req, _res, next) {
    try {
      const series = await trainingSeries.getSeries(req.params.seriesId);
      if (!series) throw new AppError(404, 'Capacitaci\u00f3n no encontrada', 'NOT_FOUND');
      if (!canManageSeries(req.auth, series)) throw new AppError(403, 'No tienes permisos sobre esta capacitaci\u00f3n', 'FORBIDDEN');
      req.trainingSeries = series;
      next();
    } catch (error) { next(error); }
  }

  async function seriesPayload(series, now = new Date()) {
    const sessions = await trainingSeries.seriesSessions(series.id);
    return { ...series, sessions, resolution: trainingSeries.resolveSeriesSession(series, sessions, now) };
  }

  async function stopActiveEgresses(room) {
    try {
      const active = await egressClient.listEgress({ roomName: room, active: true });
      const results = await Promise.allSettled((active || []).map((info) => egressClient.stopEgress(info.egressId)));
      return {
        attempted: (active || []).length,
        stopped: results.filter((result) => result.status === 'fulfilled').length,
        failed: results.filter((result) => result.status === 'rejected').length,
      };
    } catch (error) {
      log('warn', 'series_archive_egress_stop_failed', { room, errorName: error.name, errorCode: error.code });
      return { attempted: 0, stopped: 0, failed: 1 };
    }
  }

  async function closeLiveKitRoom(room) {
    try {
      await roomService.deleteRoom(room);
      return true;
    } catch (error) {
      log('warn', 'series_archive_livekit_room_close_failed', { room, errorName: error.name, errorCode: error.code });
      return false;
    }
  }

  async function revokeSeriesAccesses(seriesId) {
    const active = (await seriesAccesses.listAccesses({ seriesId }))
      .filter((access) => access.status === 'ACTIVE' && !access.revokedAt);
    await Promise.all(active.map((access) => seriesAccesses.revokeAccess(access.id, seriesId)));
    return active.length;
  }

  async function revokeSessionInvitations(sessions) {
    let count = 0;
    for (const meeting of sessions) {
      const active = (await invitations.listInvitations({ room: meeting.room }))
        .filter((invitation) => invitation.status === 'ACTIVE' && !invitation.revokedAt);
      for (const invitation of active) {
        await invitations.revokeInvitation(invitation.id, meeting.room);
        count += 1;
      }
    }
    return count;
  }

  async function archiveTrainingSeries(series, req) {
    const sessions = await trainingSeries.seriesSessions(series.id, { includeDeleted: true });
    const sessionStates = { ...(series.archivedSessionStates || {}) };
    const now = new Date().toISOString();
    const summary = {
      archivedSessions: 0,
      restoredSessions: 0,
      revokedAccesses: 0,
      revokedInvitations: 0,
      stoppedEgresses: 0,
      egressStopFailures: 0,
      closedLivekitRooms: 0,
    };

    for (const meeting of sessions) {
      if (['DRAFT', 'SCHEDULED', 'LIVE'].includes(meeting.status)) {
        if (!sessionStates[meeting.room]) {
          sessionStates[meeting.room] = {
            id: meeting.id,
            room: meeting.room,
            status: meeting.status,
            scheduledAt: meeting.scheduledAt || null,
            archivedBySeriesAt: now,
          };
        }
        if (meeting.status === 'LIVE') {
          const egress = await stopActiveEgresses(meeting.room);
          summary.stoppedEgresses += egress.stopped;
          summary.egressStopFailures += egress.failed;
          if (await closeLiveKitRoom(meeting.room)) summary.closedLivekitRooms += 1;
        }
        const archived = await meetings.transitionMeeting(meeting.room, 'archive');
        await roomRegistry.revokeRoom(archived.room);
        summary.archivedSessions += 1;
      }
    }

    summary.revokedInvitations = await revokeSessionInvitations(sessions);
    summary.revokedAccesses = await revokeSeriesAccesses(series.id);
    const updated = await trainingSeries.archiveSeries(series.id, { archivedAt: now, sessionStates });
    if (series.status !== 'ARCHIVED') {
      await safeAudit({
        actor: req.auth.u,
        action: 'SERIES_ARCHIVED',
        target: updated.id,
        metadata: summary,
        ...auditContext(req),
      });
    }
    return updated;
  }

  async function restoreTrainingSeries(series, req) {
    const sessions = await trainingSeries.seriesSessions(series.id, { includeDeleted: true });
    const sessionStates = series.archivedSessionStates && typeof series.archivedSessionStates === 'object'
      ? series.archivedSessionStates
      : {};
    const summary = { restoredSessions: 0 };
    for (const meeting of sessions) {
      const previous = sessionStates[meeting.room];
      if (!previous || meeting.status !== 'ARCHIVED' || !['DRAFT', 'SCHEDULED'].includes(previous.status)) continue;
      const restored = await meetings.transitionMeeting(meeting.room, 'restore');
      await roomRegistry.createRoom(restored.room, { meetingId: restored.id });
      summary.restoredSessions += 1;
    }
    const updated = await trainingSeries.restoreSeries(series.id);
    if (series.status === 'ARCHIVED') {
      await safeAudit({
        actor: req.auth.u,
        action: 'SERIES_RESTORED',
        target: updated.id,
        metadata: summary,
        ...auditContext(req),
      });
    }
    return updated;
  }

  async function activeSeriesAccess(session) {
    const access = await seriesAccesses.getAccess(session?.accessId);
    if (!access || access.seriesId !== session.seriesId || access.status !== 'ACTIVE' || access.revokedAt) {
      throw new AppError(410, 'Tu acceso a la capacitaci\u00f3n fue revocado', 'SERIES_ACCESS_REVOKED');
    }
    const series = await trainingSeries.getSeries(access.seriesId);
    if (!series || ['DRAFT', 'CANCELLED', 'ARCHIVED'].includes(series.status)) {
      throw new AppError(410, 'La capacitaci\u00f3n ya no admite accesos', 'SERIES_NOT_JOINABLE');
    }
    return access;
  }

  async function ensureSeriesRoomAccess(session) {
    if (!session?.seriesAccessId) return null;
    const access = await seriesAccesses.getAccess(session.seriesAccessId);
    if (!access || access.status !== 'ACTIVE' || access.revokedAt || access.seriesId !== session.seriesId) {
      throw new AppError(410, 'Tu acceso a la capacitaci\u00f3n fue revocado', 'SERIES_ACCESS_REVOKED');
    }
    const series = await trainingSeries.getSeries(access.seriesId);
    if (!series || series.status !== 'ACTIVE') {
      throw new AppError(410, 'La capacitaci\u00f3n ya no admite acceso a sus salas', 'SERIES_NOT_JOINABLE');
    }
    return access;
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
      url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: config.transcriptionPresignedUrlTtlSeconds }),
      size: Number(object.Size) || 0,
      contentType: 'video/mp4',
      source: metadata.source || 'ROOM_COMPOSITE',
      participants: Array.isArray(metadata.participants) ? metadata.participants : [],
      tracks: Array.isArray(metadata.tracks) ? metadata.tracks : [],
      durationSeconds: Number(metadata.durationSeconds) || 0,
    };
  }

  const resolveRecording = overrides.recordingResolver || defaultRecordingResolver;

  async function resolveTranscriptionRecording(recordingId, meeting) {
    try {
      return await resolveRecording(recordingId, meeting);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(503, 'No fue posible acceder al almacenamiento de grabaciones', 'TRANSCRIPTION_STORAGE_UNAVAILABLE');
    }
  }

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

  function accessSharePayload(series, sessions, access) {
    if (!access.url) return access;
    const schedule = sessions.map((meeting) => {
      const date = new Date(meeting.scheduledAt);
      const formatted = Number.isNaN(date.getTime()) ? 'Fecha por confirmar' : new Intl.DateTimeFormat('es-EC', {
        timeZone: series.timezone, dateStyle: 'long', timeStyle: 'short',
      }).format(date);
      return `Sesi\u00f3n ${meeting.sessionNumber}: ${formatted}`;
    }).join('\n');
    const generalNotice = access.mode === 'GENERAL'
      ? '\n\nAcceso general del ciclo: cada asistente debe ingresar su propio nombre visible antes de entrar.'
      : '';
    const header = `Has sido invitado a:\n${series.title}\n\n${schedule}\n\nEste mismo enlace funciona para todas las sesiones.${generalNotice}\n${access.url}`;
    const next = trainingSeries.resolveSeriesSession(series, sessions).meeting;
    const scheduledAt = next?.scheduledAt ? new Date(next.scheduledAt).getTime() : null;
    return {
      ...access,
      invitationMessage: header,
      reminder2h: `Recordatorio: ${series.title}\nLa preparaci\u00f3n de tu pr\u00f3xima sesi\u00f3n est\u00e1 disponible. Usa el mismo enlace:\n${access.url}`,
      reminder15m: `Recordatorio: ${series.title} comienza en aproximadamente 15 minutos. Usa tu mismo enlace:\n${access.url}`,
      reminderSchedule: scheduledAt ? {
        preparationAt: new Date(scheduledAt - Number(series.earlyAccessMinutes || 0) * 60_000).toISOString(),
        reminder15mAt: new Date(scheduledAt - 15 * 60_000).toISOString(),
        automated: false,
      } : null,
      whatsappUrl: `https://wa.me/?text=${encodeURIComponent(header)}`,
    };
  }

  app.get('/api/series', auth.requireAuth, auth.requireRoles('ADMIN', 'ORGANIZER'), asyncHandler(async (req, res) => {
    const visible = (await trainingSeries.listSeries({ includeArchived: req.query.includeArchived === 'true' })).filter((series) => canManageSeries(req.auth, series));
    res.json({ items: await Promise.all(visible.map((series) => seriesPayload(series))) });
  }));

  app.post('/api/series', meetingLimiter, auth.requireAuth, auth.requireCsrf, auth.requireRoles('ADMIN', 'ORGANIZER'), asyncHandler(async (req, res) => {
    const result = await idempotency.runHttp(req, 'series:create', async () => {
      const created = await trainingSeries.createSeries({ ...req.body, createdBy: req.auth.u });
      for (const meeting of created.sessions) await roomRegistry.createRoom(meeting.room, { meetingId: meeting.id });
      await safeAudit({ actor: req.auth.u, action: 'SERIES_CREATED', target: created.series.id, metadata: { type: created.series.type, sessions: created.sessions.length }, ...auditContext(req) });
      for (const meeting of created.sessions) {
        await safeAudit({ actor: req.auth.u, action: 'MEETING_CREATED', target: meeting.id, room: meeting.room, metadata: { seriesId: created.series.id, sessionNumber: meeting.sessionNumber }, ...auditContext(req) });
      }
      return { status: 201, body: await seriesPayload(created.series) };
    });
    res.status(result.status).json(result.body);
  }));

  app.get('/api/series/:seriesId', auth.requireAuth, auth.requireRoles('ADMIN', 'ORGANIZER'), requireManagedSeries, asyncHandler(async (req, res) => {
    res.json(await seriesPayload(req.trainingSeries));
  }));

  app.patch('/api/series/:seriesId', auth.requireAuth, auth.requireCsrf, auth.requireRoles('ADMIN', 'ORGANIZER'), requireManagedSeries, asyncHandler(async (req, res) => {
    const requestedStatus = Object.prototype.hasOwnProperty.call(req.body || {}, 'status') ? String(req.body.status || '').toUpperCase() : null;
    const updated = requestedStatus === 'ARCHIVED'
      ? await archiveTrainingSeries(req.trainingSeries, req)
      : requestedStatus === 'ACTIVE' && req.trainingSeries.status === 'ARCHIVED'
        ? await restoreTrainingSeries(req.trainingSeries, req)
        : await trainingSeries.updateSeries(req.params.seriesId, req.body || {});
    if (!['ARCHIVED', 'ACTIVE'].includes(requestedStatus) || (requestedStatus === 'ACTIVE' && req.trainingSeries.status !== 'ARCHIVED')) {
      await safeAudit({ actor: req.auth.u, action: 'SERIES_UPDATED', target: updated.id, metadata: { status: updated.status }, ...auditContext(req) });
    }
    res.json(await seriesPayload(updated));
  }));

  app.get('/api/series/:seriesId/accesses', auth.requireAuth, auth.requireRoles('ADMIN', 'ORGANIZER'), requireManagedSeries, asyncHandler(async (req, res) => {
    const sessions = await trainingSeries.seriesSessions(req.trainingSeries.id);
    const items = (await seriesAccesses.listAccesses({ seriesId: req.trainingSeries.id }))
      .map((record) => accessSharePayload(req.trainingSeries, sessions, seriesAccesses.publicAccess(record, { includeUrl: true })));
    res.json({ items });
  }));

  app.post('/api/series/:seriesId/accesses', auth.requireAuth, auth.requireCsrf, auth.requireRoles('ADMIN', 'ORGANIZER'), requireManagedSeries, asyncHandler(async (req, res) => {
    const created = await seriesAccesses.createOrGetAccess({
      series: req.trainingSeries, participantName: req.body?.participantName, participantKey: req.body?.participantKey,
      meetingRole: req.body?.meetingRole, createdBy: req.auth.u,
    });
    const sessions = await trainingSeries.seriesSessions(req.trainingSeries.id);
    const access = accessSharePayload(req.trainingSeries, sessions, seriesAccesses.publicAccess(created.access, { includeUrl: true }));
    if (!created.reused) await safeAudit({ actor: req.auth.u, action: 'SERIES_ACCESS_CREATED', target: created.access.id, metadata: { seriesId: req.trainingSeries.id, participantKey: created.access.participantKey }, ...auditContext(req) });
    res.status(created.reused ? 200 : 201).json({ access, reused: created.reused });
  }));

  app.post('/api/series/:seriesId/general-access', auth.requireAuth, auth.requireCsrf, auth.requireRoles('ADMIN', 'ORGANIZER'), requireManagedSeries, asyncHandler(async (req, res) => {
    const created = await seriesAccesses.createOrGetGeneralAccess({ series: req.trainingSeries, createdBy: req.auth.u });
    const sessions = await trainingSeries.seriesSessions(req.trainingSeries.id);
    const access = accessSharePayload(req.trainingSeries, sessions, seriesAccesses.publicAccess(created.access, { includeUrl: true }));
    if (!created.reused) await safeAudit({ actor: req.auth.u, action: 'SERIES_ACCESS_CREATED', target: created.access.id, metadata: { seriesId: req.trainingSeries.id, mode: 'GENERAL' }, ...auditContext(req) });
    res.status(created.reused ? 200 : 201).json({ access, reused: created.reused });
  }));

  app.delete('/api/series/:seriesId/accesses/:accessId', auth.requireAuth, auth.requireCsrf, auth.requireRoles('ADMIN', 'ORGANIZER'), requireManagedSeries, asyncHandler(async (req, res) => {
    const access = await seriesAccesses.revokeAccess(req.params.accessId, req.trainingSeries.id);
    await safeAudit({ actor: req.auth.u, action: 'SERIES_ACCESS_REVOKED', target: access.id, metadata: { seriesId: access.seriesId, participantKey: access.participantKey }, ...auditContext(req) });
    res.json({ access: seriesAccesses.publicAccess(access) });
  }));

  app.post('/api/series/:seriesId/accesses/:accessId/regenerate', auth.requireAuth, auth.requireCsrf, auth.requireRoles('ADMIN', 'ORGANIZER'), requireManagedSeries, asyncHandler(async (req, res) => {
    const created = await seriesAccesses.regenerateAccess(req.params.accessId, req.trainingSeries, req.auth.u);
    const sessions = await trainingSeries.seriesSessions(req.trainingSeries.id);
    const access = accessSharePayload(req.trainingSeries, sessions, seriesAccesses.publicAccess(created.access, { includeUrl: true }));
    await safeAudit({ actor: req.auth.u, action: 'SERIES_ACCESS_REGENERATED', target: created.access.id, metadata: { seriesId: req.trainingSeries.id, participantKey: created.access.participantKey }, ...auditContext(req) });
    res.status(201).json({ access });
  }));

  app.get('/api/series/:seriesId/attendance', auth.requireAuth, auth.requireRoles('ADMIN', 'ORGANIZER'), requireManagedSeries, asyncHandler(async (req, res) => {
    const sessions = await trainingSeries.seriesSessions(req.trainingSeries.id);
    const records = await attendance.listSeriesAttendance(req.trainingSeries.id);
    const people = new Map();
    for (const record of records) {
      const person = people.get(record.participantKey) || { participantKey: record.participantKey, participantName: record.participantName, sessions: {} };
      person.sessions[record.sessionNumber] = {
        meetingId: record.meetingId, firstJoinedAt: record.firstJoinedAt, lastLeftAt: record.lastLeftAt,
        accumulatedMs: Number(record.accumulatedMs || 0) + (record.activeSince ? Math.max(0, Date.now() - new Date(record.activeSince).getTime()) : 0),
      };
      people.set(record.participantKey, person);
    }
    res.json({ totalSessions: sessions.length, items: [...people.values()] });
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
    const result = await idempotency.runHttp(req, 'meetings:create', async () => {
      const record = await meetings.createMeeting({ ...withoutSeriesLinkage(req.body), createdBy: req.auth.u });
      await roomRegistry.createRoom(record.room, { meetingId: record.id });
      await safeAudit({ actor: req.auth.u, action: 'MEETING_CREATED', target: record.id, room: record.room, metadata: { type: record.type, status: record.status }, ...auditContext(req) });
      return { status: 201, body: record };
    });
    res.status(result.status).json(result.body);
  }));

  app.get('/api/meetings/:room', auth.requireAuth, auth.requireRoles('ADMIN', 'ORGANIZER'), requireManagedMeeting, (req, res) => {
    res.json(req.meeting);
  });

  app.patch('/api/meetings/:room', auth.requireAuth, auth.requireCsrf, auth.requireRoles('ADMIN', 'ORGANIZER'), requireManagedMeeting, asyncHandler(async (req, res) => {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'status')) {
      throw new AppError(400, 'El estado de la reunión debe modificarse mediante una acción específica', 'MEETING_STATUS_IMMUTABLE');
    }
    const updated = await meetings.updateMeeting(req.params.room, withoutSeriesLinkage(req.body));
    if (updated.seriesId) await trainingSeries.touchSeries(updated.seriesId);
    await safeAudit({ actor: req.auth.u, action: 'MEETING_UPDATED', target: updated.id, room: updated.room, metadata: { status: updated.status }, ...auditContext(req) });
    res.json(updated);
  }));

  app.post('/api/meetings/:room/duplicate', meetingLimiter, auth.requireAuth, auth.requireCsrf, auth.requireRoles('ADMIN', 'ORGANIZER'), requireManagedMeeting, asyncHandler(async (req, res) => {
    const copy = await meetings.duplicateMeeting(req.params.room, withoutSeriesLinkage(req.body), req.auth.u);
    await roomRegistry.createRoom(copy.room, { meetingId: copy.id });
    await safeAudit({ actor: req.auth.u, action: 'MEETING_CREATED', target: copy.id, room: copy.room, metadata: { duplicatedFrom: req.meeting.id }, ...auditContext(req) });
    res.status(201).json(copy);
  }));

  app.post('/api/meetings/:room/actions/:action', auth.requireAuth, auth.requireCsrf, auth.requireRoles('ADMIN', 'ORGANIZER'), requireManagedMeeting, asyncHandler(async (req, res) => {
    const action = req.params.action;
    const allowed = new Set(['reschedule', 'cancel', 'archive', 'restore', 'complete']);
    if (!allowed.has(action)) throw new AppError(400, 'Acción no válida', 'VALIDATION_ERROR');
    const result = await idempotency.runHttp(req, `meetings:${req.params.room}:actions:${action}`, async () => {
      const updated = await meetings.transitionMeeting(req.params.room, action, req.body || {});
      if (updated.seriesId) await trainingSeries.touchSeries(updated.seriesId);
      if (action === 'cancel' || action === 'archive' || action === 'complete') await roomRegistry.revokeRoom(updated.room);
      if (action === 'restore') await roomRegistry.createRoom(updated.room, { meetingId: updated.id });
      const auditAction = {
        reschedule: 'MEETING_RESCHEDULED', cancel: 'MEETING_CANCELLED', archive: 'MEETING_ARCHIVED',
        restore: 'MEETING_RESTORED', complete: 'ROOM_ENDED',
      }[action];
      await safeAudit({ actor: req.auth.u, action: auditAction, target: updated.id, room: updated.room, ...auditContext(req) });
      if (action === 'reschedule' && updated.seriesId) {
        await safeAudit({ actor: req.auth.u, action: 'SERIES_RESCHEDULED', target: updated.seriesId, room: updated.room, metadata: { meetingId: updated.id, sessionNumber: updated.sessionNumber, scheduledAt: updated.scheduledAt }, ...auditContext(req) });
      }
      return { status: 200, body: updated };
    });
    res.status(result.status).json(result.body);
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
    const result = await idempotency.runHttp(req, `meetings:${req.params.room}:invitations:create`, async () => {
      const created = await invitations.createInvitation({
        meetingId: req.meeting.id,
        room: req.meeting.room,
        role: req.body?.role,
        meetingType: req.body?.meetingRole ? req.meeting.type : undefined,
        meetingRole: req.body?.meetingRole,
        expiresInMinutes: req.body?.expiresInMinutes,
        singleUse: req.body?.singleUse === true,
        maxUses: req.body?.maxUses,
        createdBy: req.auth.u,
      });
      await safeAudit({ actor: req.auth.u, action: 'INVITATION_CREATED', target: created.invitation.id, room: req.meeting.room, metadata: { role: created.invitation.role, meetingRole: created.invitation.meetingRole, expiresAt: created.invitation.expiresAt }, ...auditContext(req) });
      return { status: 201, body: { invitation: created.invitation, ...invitationSharePayload({ token: created.token, meeting: req.meeting, role: created.invitation.meetingRole }) } };
    });
    res.status(result.status).json(result.body);
  }));

  app.post('/api/meetings/:room/simple-accesses/:kind', auth.requireAuth, auth.requireCsrf, auth.requireRoles('ADMIN', 'ORGANIZER'), requireManagedMeeting, asyncHandler(async (req, res) => {
    if (req.meeting.deletedAt || ['CANCELLED', 'ARCHIVED', 'COMPLETED'].includes(req.meeting.status)) {
      throw new AppError(409, 'No se pueden crear accesos para esta reunión', 'MEETING_NOT_JOINABLE');
    }
    const access = simpleMeetingAccessPayload(req.meeting, req.params.kind);
    await safeAudit({
      actor: req.auth.u,
      action: 'INVITATION_CREATED',
      target: req.meeting.id,
      room: req.meeting.room,
      metadata: { accessKind: access.kind, meetingRole: access.meetingRole, stable: true },
      ...auditContext(req),
    });
    res.json({ access });
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
      throw new AppError(503, 'El servicio de videoconferencia no está disponible. Verifica la configuración de LiveKit.', 'LIVEKIT_UNAVAILABLE');
    }
    await roomRegistry.createRoom(req.meeting.room, { meetingId: req.meeting.id });
    const created = createRoomSession({
      room: req.meeting.room,
      meetingId: req.meeting.id,
      role: req.auth.role,
      meetingType: req.meeting.type,
      meetingRole: legacyDefaultMeetingRole(req.meeting.type, req.auth.role),
      legacyAccess: false,
      username: req.auth.u,
      displayName: req.auth.u,
    });
    res.setHeader('Set-Cookie', [roomCookie(created.token), roomCookie(created.token, created.session.sid)]);
    res.json({ redirect: `/presenter.html?roomSession=${encodeURIComponent(created.session.sid)}` });
  }));

  app.get('/api/livekit/status', auth.requireAuth, auth.requireRoles('ADMIN', 'ORGANIZER'), asyncHandler(async (_req, res) => {
    res.json(await livekitProbe({ fresh: true }));
  }));

  app.get('/s/:token', asyncHandler(async (req, res) => {
    const access = await seriesAccesses.resolveToken(req.params.token, { touch: true });
    const series = await trainingSeries.getSeries(access.seriesId);
    if (!series || ['DRAFT', 'CANCELLED', 'ARCHIVED'].includes(series.status)) throw new AppError(410, 'Esta capacitaci\u00f3n ya no admite accesos', 'SERIES_NOT_JOINABLE');
    const created = createSeriesSession(access);
    const sessions = await trainingSeries.seriesSessions(series.id);
    const resolution = trainingSeries.resolveSeriesSession(series, sessions);
    if (resolution.phase === 'LIVE' && resolution.meeting) {
      const meeting = resolution.meeting;
      const roomAccess = await roomRegistry.checkAccess(meeting.room);
      if (!roomAccess.allowed) throw new AppError(roomAccess.reason === 'ROOM_LOCKED' ? 423 : 403, roomAccess.reason === 'ROOM_LOCKED' ? 'La sala est\u00e1 bloqueada' : 'La sala no est\u00e1 disponible', roomAccess.reason);
      const role = legacyRoleForMeetingRole(meeting.type, access.meetingRole, 'VIEWER');
      const roomSession = createRoomSession({
        room: meeting.room, meetingId: meeting.id, role, meetingType: meeting.type, meetingRole: access.meetingRole,
        legacyAccess: false, displayName: null,
        identity: created.session.roomIdentity || `series-${access.id}`, seriesId: series.id, seriesAccessId: access.id,
        seriesAccessMode: access.mode || 'INDIVIDUAL', participantKey: created.session.participantKey || access.participantKey,
        consents: null, seriesPrepared: false,
      });
      res.setHeader('Set-Cookie', [seriesCookie(created.token), roomCookie(roomSession.token), roomCookie(roomSession.token, roomSession.session.sid)]);
      const viewerExperience = access.meetingRole === 'ATTENDEE';
      return res.redirect(303, `${viewerExperience ? '/viewer.html' : '/presenter.html'}?roomSession=${encodeURIComponent(roomSession.session.sid)}`);
    }
    res.setHeader('Set-Cookie', seriesCookie(created.token));
    return res.redirect(303, '/series-access.html');
  }));

  app.get('/api/series-access', requireSeriesSession, asyncHandler(async (req, res) => {
    const access = await activeSeriesAccess(req.seriesSession);
    const series = await trainingSeries.getSeries(access.seriesId);
    if (!series) throw new AppError(410, 'La capacitaci\u00f3n ya no est\u00e1 disponible', 'SERIES_NOT_JOINABLE');
    const sessions = await trainingSeries.seriesSessions(series.id);
    const resolution = trainingSeries.resolveSeriesSession(series, sessions);
    res.json({
      series: {
        id: series.id, title: series.title, description: series.description, type: series.type,
        trainerName: series.trainerName, timezone: series.timezone, earlyAccessMinutes: series.earlyAccessMinutes,
        status: series.status, sessions: sessions.map((meeting) => ({
          id: meeting.id, title: meeting.title, sessionNumber: meeting.sessionNumber, scheduledAt: meeting.scheduledAt,
          durationMinutes: meeting.durationMinutes, status: meeting.status,
        })),
      },
      resolution: {
        ...resolution,
        meeting: resolution.meeting ? {
          id: resolution.meeting.id, title: resolution.meeting.title, sessionNumber: resolution.meeting.sessionNumber,
          scheduledAt: resolution.meeting.scheduledAt, durationMinutes: resolution.meeting.durationMinutes, status: resolution.meeting.status,
        } : null,
      },
      access: { id: access.id, mode: access.mode || 'INDIVIDUAL', participantName: req.seriesSession.displayName || access.participantName || '', meetingRole: access.meetingRole },
      consents: req.seriesSession.consents || null,
      csrfToken: req.seriesSession.csrf,
    });
  }));

  app.patch('/api/series-access/profile', requireSeriesSession, requireSeriesCsrf, asyncHandler(async (req, res) => {
    await activeSeriesAccess(req.seriesSession);
    const displayName = sanitizeText(req.body?.displayName, { field: 'displayName', min: 2, max: 80, required: true });
    const updated = updateSeriesSession(req.seriesSession, { displayName });
    res.setHeader('Set-Cookie', seriesCookie(updated.token));
    res.json({ displayName, csrfToken: updated.session.csrf });
  }));

  app.post('/api/series-access/consent', requireSeriesSession, requireSeriesCsrf, asyncHandler(async (req, res) => {
    await activeSeriesAccess(req.seriesSession);
    if (req.body?.privacy !== true) throw new AppError(400, 'Debes aceptar el aviso de privacidad para continuar', 'PRIVACY_CONSENT_REQUIRED');
    const consents = { privacy: true, recording: req.body?.recording === true, transcription: req.body?.transcription === true, acceptedAt: new Date().toISOString() };
    const updated = updateSeriesSession(req.seriesSession, { consents });
    res.setHeader('Set-Cookie', seriesCookie(updated.token));
    res.json({ consents, csrfToken: updated.session.csrf });
  }));

  app.post('/api/series-access/enter', requireSeriesSession, requireSeriesCsrf, asyncHandler(async (req, res) => {
    const access = await activeSeriesAccess(req.seriesSession);
    const series = await trainingSeries.getSeries(access.seriesId);
    if (!series) throw new AppError(410, 'La capacitaci\u00f3n ya no est\u00e1 disponible', 'SERIES_NOT_JOINABLE');
    const sessions = await trainingSeries.seriesSessions(series.id);
    const resolution = trainingSeries.resolveSeriesSession(series, sessions);
    if (!resolution.meeting || !resolution.canEnter) throw new AppError(409, 'La sesi\u00f3n todav\u00eda no ha comenzado', 'MEETING_NOT_LIVE');
    if (!req.seriesSession.consents?.privacy) throw new AppError(403, 'Debes aceptar el aviso de privacidad antes de entrar', 'PRIVACY_CONSENT_REQUIRED');
    const displayName = sanitizeText(req.seriesSession.displayName, { field: 'displayName', min: 2, max: 80, required: true });
    const meeting = resolution.meeting;
    const roomAccess = await roomRegistry.checkAccess(meeting.room);
    if (!roomAccess.allowed) throw new AppError(roomAccess.reason === 'ROOM_LOCKED' ? 423 : 403, roomAccess.reason === 'ROOM_LOCKED' ? 'La sala est\u00e1 bloqueada' : 'La sala no est\u00e1 disponible', roomAccess.reason);
    const role = legacyRoleForMeetingRole(meeting.type, access.meetingRole, 'VIEWER');
    const created = createRoomSession({
      room: meeting.room, meetingId: meeting.id, role, meetingType: meeting.type, meetingRole: access.meetingRole,
      legacyAccess: false, displayName,
      identity: req.seriesSession.roomIdentity || `series-${access.id}`, seriesId: series.id, seriesAccessId: access.id,
      seriesAccessMode: access.mode || 'INDIVIDUAL', participantKey: req.seriesSession.participantKey || access.participantKey,
      consents: req.seriesSession.consents, seriesPrepared: true,
    });
    res.setHeader('Set-Cookie', [roomCookie(created.token), roomCookie(created.token, created.session.sid)]);
    await safeAudit({ actor: created.session.identity, action: 'SERIES_SESSION_ENTERED', target: meeting.id, room: meeting.room, metadata: { seriesId: series.id, sessionNumber: meeting.sessionNumber, accessId: access.id, accessMode: access.mode || 'INDIVIDUAL' }, ...auditContext(req) });
    const viewerExperience = access.meetingRole === 'ATTENDEE';
    res.json({ redirect: `${viewerExperience ? '/viewer.html' : '/presenter.html'}?roomSession=${encodeURIComponent(created.session.sid)}` });
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
      meetingType: meeting.type,
      meetingRole: invitation.meetingRole,
      legacyAccess: invitation.legacyAccess,
      invitationId: invitation.id,
    });
    res.setHeader('Set-Cookie', [roomCookie(created.token), roomCookie(created.token, created.session.sid)]);
    await safeAudit({ actor: created.session.identity, action: 'INVITATION_REDEEMED', target: invitation.id, room: meeting.room, metadata: { role: invitation.role, meetingRole: invitation.meetingRole, legacyAccess: invitation.legacyAccess }, ...auditContext(req) });
    const viewerAccess = invitation.legacyAccess ? invitation.role === 'VIEWER' : invitation.meetingRole === 'ATTENDEE';
    const destination = viewerAccess ? '/viewer.html' : '/presenter.html';
    res.redirect(303, `${destination}?roomSession=${encodeURIComponent(created.session.sid)}`);
  }));

  app.get('/a/:token', asyncHandler(async (req, res) => {
    const access = readSimpleMeetingAccessToken(req.params.token);
    const meeting = await meetings.getMeeting(access.room);
    if (!meeting || meeting.id !== access.meetingId || meeting.deletedAt || ['CANCELLED', 'ARCHIVED', 'COMPLETED'].includes(meeting.status)) {
      throw new AppError(410, 'Esta reunión ya no admite accesos', 'MEETING_NOT_JOINABLE');
    }
    const meetingRole = normalizeMeetingRole(meeting.type, access.meetingRole);
    const accessKind = simpleAccessKind(access.kind);
    const roomAccess = await roomRegistry.checkAccess(meeting.room, { allowLocked: accessKind === 'HOST' });
    if (!roomAccess.allowed) {
      const locked = roomAccess.reason === 'ROOM_LOCKED';
      throw new AppError(locked ? 423 : 503, locked ? 'La sala está bloqueada y no admite nuevos accesos' : 'La sala no está disponible', roomAccess.reason);
    }
    const role = legacyRoleForMeetingRole(meeting.type, meetingRole, accessKind === 'HOST' ? 'ORGANIZER' : 'VIEWER');
    const created = createRoomSession({
      room: meeting.room,
      meetingId: meeting.id,
      role,
      meetingType: meeting.type,
      meetingRole,
      legacyAccess: false,
      invitationId: `simple-${accessKind.toLowerCase()}`,
    });
    res.setHeader('Set-Cookie', [roomCookie(created.token), roomCookie(created.token, created.session.sid)]);
    await safeAudit({
      actor: created.session.identity,
      action: 'INVITATION_REDEEMED',
      target: meeting.id,
      room: meeting.room,
      metadata: { accessKind, meetingRole, stable: true },
      ...auditContext(req),
    });
    const viewerAccess = ['ATTENDEE', 'PARTICIPANT', 'STUDENT'].includes(meetingRole);
    res.redirect(303, `${viewerAccess ? '/viewer.html' : '/presenter.html'}?roomSession=${encodeURIComponent(created.session.sid)}`);
  }));

  app.get('/api/room-session', requireRoomSession, asyncHandler(async (req, res) => {
    const meeting = await meetings.getMeeting(req.roomSession.room);
    await ensureSeriesRoomAccess(req.roomSession);
    if (!meeting || meeting.id !== req.roomSession.meetingId || meeting.deletedAt) throw new AppError(410, 'La reunión ya no está disponible', 'MEETING_NOT_JOINABLE');
    const roomState = await roomRegistry.getRoom(meeting.room);
    const participantAccess = await roomRegistry.participantAccess(meeting.room, req.roomSession.identity);
    const meetingRole = normalizeMeetingRole(meeting.type, participantAccess.meetingRole || req.roomSession.meetingRole, req.roomSession.role);
    const capabilities = roleCapabilities(meeting.type, meetingRole);
    const publishSources = resolvePublishSources({
      type: meeting.type,
      meetingRole,
      legacyRole: req.roomSession.role,
      legacyRestricted: req.roomSession.legacyAccess && !participantAccess.meetingRole,
      grants: participantAccess.grants,
      settings: meeting,
    });
    res.json({
      room: req.roomSession.room,
      role: req.roomSession.role,
      meetingRole,
      meetingType: meeting.type,
      legacyAccess: req.roomSession.legacyAccess === true,
      consentRequired: req.roomSession.consentRequired === true,
      capabilities,
      publishSources,
      identity: req.roomSession.identity,
      displayName: req.roomSession.displayName,
      consents: req.roomSession.consents || null,
      seriesId: req.roomSession.seriesId || null,
      seriesPrepared: req.roomSession.seriesPrepared === true,
      csrfToken: req.roomSession.csrf,
      meeting: {
        id: meeting.id,
        title: meeting.title,
        trainerName: meeting.trainerName,
        status: meeting.status,
        type: meeting.type,
        scheduledAt: meeting.scheduledAt,
        startedAt: meeting.startedAt,
        livekitConfirmedAt: meeting.livekitConfirmedAt,
        endsAt: meeting.endsAt,
        durationMinutes: meeting.durationMinutes,
        allowRecording: meeting.allowRecording,
        recordingConsentRequired: meeting.recordingConsentRequired,
        allowTranscription: meeting.allowTranscription,
        transcriptionConsentRequired: meeting.transcriptionConsentRequired,
        allowChat: meeting.allowChat,
        allowFiles: meeting.allowFiles,
        allowReactions: meeting.allowReactions,
        allowRaiseHand: meeting.allowRaiseHand,
        allowQuestions: meeting.allowQuestions,
        allowPanelistScreenShare: meeting.allowPanelistScreenShare,
        allowParticipantScreenShare: meeting.allowParticipantScreenShare,
        allowStudentScreenShare: meeting.allowStudentScreenShare,
        roomLocked: roomState?.locked === true,
        seriesId: meeting.seriesId,
        sessionNumber: meeting.sessionNumber,
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

  app.post('/api/room-session/consent', requireRoomSession, requireRoomCsrf, roomMeeting, asyncHandler(async (req, res) => {
    const consents = {
      privacy: req.body?.privacy === true,
      recording: req.body?.recording === true,
      transcription: req.body?.transcription === true,
    };
    if (!consents.privacy) throw new AppError(400, 'Debes aceptar el aviso de privacidad para entrar', 'PRIVACY_CONSENT_REQUIRED');
    if (req.meeting.recordingConsentRequired && !consents.recording) throw new AppError(400, 'Debes confirmar el aviso de grabación para entrar', 'RECORDING_CONSENT_REQUIRED');
    if (req.meeting.transcriptionConsentRequired && !consents.transcription) throw new AppError(400, 'Debes confirmar el aviso de transcripción para entrar', 'TRANSCRIPTION_CONSENT_REQUIRED');
    const updated = updateConsents(req.roomSession, consents);
    res.setHeader('Set-Cookie', roomCookie(updated.token, req.roomSessionSelector));
    await safeAudit({
      actor: req.roomSession.identity,
      action: 'PARTICIPANT_CONSENT_RECORDED',
      target: req.meeting.id,
      room: req.meeting.room,
      metadata: updated.session.consents,
      ...auditContext(req),
    });
    res.json({ consents: updated.session.consents, csrfToken: updated.session.csrf });
  }));

  app.post('/api/room-session/leave', requireRoomSession, requireRoomCsrf, asyncHandler(async (req, res) => {
    await attendance.left({ seriesId: req.roomSession.seriesId, meetingId: req.roomSession.meetingId, participantKey: req.roomSession.participantKey }).catch(() => null);
    await roomRegistry.clearParticipantAccess(req.roomSession.room, req.roomSession.identity).catch(() => {});
    await safeAudit({ actor: req.roomSession.identity, action: 'PARTICIPANT_LEFT', target: req.roomSession.meetingId, room: req.roomSession.room, ...auditContext(req) });
    res.setHeader('Set-Cookie', [clearRoomCookie(), clearRoomCookie(req.roomSessionSelector)]);
    res.json({ left: true });
  }));

  app.get('/api/token', requireRoomSession, asyncHandler(async (req, res) => {
    const meeting = await meetings.getMeeting(req.roomSession.room);
    await ensureSeriesRoomAccess(req.roomSession);
    if (!meeting || meeting.id !== req.roomSession.meetingId || meeting.deletedAt || ['CANCELLED', 'ARCHIVED', 'COMPLETED'].includes(meeting.status)) {
      throw new AppError(410, 'La reunión finalizó o tu acceso fue retirado', 'ROOM_ENDED');
    }
    const access = await roomRegistry.checkAccess(meeting.room, { allowLocked: true });
    if (!access.allowed) throw new AppError(403, 'Tu acceso a la sala fue retirado', access.reason);
    const participantAccess = await roomRegistry.participantAccess(meeting.room, req.roomSession.identity);
    const meetingRole = normalizeMeetingRole(meeting.type, participantAccess.meetingRole || req.roomSession.meetingRole, req.roomSession.role);
    const capabilities = roleCapabilities(meeting.type, meetingRole);
    if (!capabilities.canStartMeeting && meeting.status !== 'LIVE') throw new AppError(409, 'La reunión todavía no ha comenzado', 'MEETING_NOT_LIVE');
    if (req.roomSession.consentRequired) {
      const consents = req.roomSession.consents || {};
      if (!consents.privacy) throw new AppError(403, 'Debes aceptar el aviso de privacidad antes de conectarte', 'PRIVACY_CONSENT_REQUIRED');
      if (meeting.recordingConsentRequired && !consents.recording) throw new AppError(403, 'Debes confirmar el aviso de grabación antes de conectarte', 'RECORDING_CONSENT_REQUIRED');
      if (meeting.transcriptionConsentRequired && !consents.transcription) throw new AppError(403, 'Debes confirmar el aviso de transcripción antes de conectarte', 'TRANSCRIPTION_CONSENT_REQUIRED');
    }
    const publishSources = resolvePublishSources({
      type: meeting.type,
      meetingRole,
      legacyRole: req.roomSession.role,
      legacyRestricted: req.roomSession.legacyAccess && !participantAccess.meetingRole,
      grants: participantAccess.grants,
      settings: meeting,
    });
    const canPublishSources = liveKitSourceValues(publishSources);
    const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: req.roomSession.identity,
      name: req.roomSession.displayName,
      metadata: JSON.stringify({ role: req.roomSession.role, meetingRole, meetingType: meeting.type, legacyAccess: req.roomSession.legacyAccess === true, invitationId: req.roomSession.invitationId || null, seriesId: req.roomSession.seriesId || null, seriesAccessId: req.roomSession.seriesAccessId || null, seriesAccessMode: req.roomSession.seriesAccessMode || null, participantKey: req.roomSession.participantKey || null, joinedAt: new Date().toISOString() }),
    });
    token.addGrant({
      room: meeting.room,
      roomJoin: true,
      canPublish: canPublishSources.length > 0,
      canPublishSources,
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
      meetingRole,
      capabilities,
      publishSources,
      recordingConfigured,
      transcriptionConfigured: transcriptionProvider.isConfigured(),
      meeting: { id: meeting.id, title: meeting.title, status: meeting.status, type: meeting.type, startedAt: meeting.startedAt, livekitConfirmedAt: meeting.livekitConfirmedAt, endsAt: meeting.endsAt, durationMinutes: meeting.durationMinutes, seriesId: meeting.seriesId, sessionNumber: meeting.sessionNumber },
    });
  }));

  async function roomMeeting(req, _res, next) {
    try {
      const meeting = await meetings.getMeeting(req.roomSession.room);
      await ensureSeriesRoomAccess(req.roomSession);
      if (!meeting || meeting.id !== req.roomSession.meetingId || meeting.deletedAt) throw new AppError(410, 'La reunión ya no está disponible', 'ROOM_ENDED');
      req.meeting = meeting;
      req.roomAccess = await roomRegistry.participantAccess(meeting.room, req.roomSession.identity);
      req.meetingRole = normalizeMeetingRole(meeting.type, req.roomAccess.meetingRole || req.roomSession.meetingRole, req.roomSession.role);
      req.roomCapabilities = roleCapabilities(meeting.type, req.meetingRole);
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

  function participantCanPublishSource(participant, source) {
    const permission = participant?.permission || participant?.permissions || {};
    const sources = permission.canPublishSources;
    if (!Array.isArray(sources) || sources.length === 0) return permission.canPublish === true;
    return sources.includes(TrackSource[source]);
  }

  function legacyRoleForParticipant(participant) {
    const metadata = participantMetadata(participant);
    if (metadata.role) return String(metadata.role).toUpperCase();
    const prefix = String(participant?.identity || '').split('-')[0].toUpperCase();
    return ['ADMIN', 'ORGANIZER', 'PANELIST', 'VIEWER'].includes(prefix) ? prefix : 'VIEWER';
  }

  async function participantPolicy(meeting, participant, { grants, meetingRole } = {}) {
    const access = await roomRegistry.participantAccess(meeting.room, participant.identity);
    const metadata = participantMetadata(participant);
    const legacyRole = legacyRoleForParticipant(participant);
    const effectiveMeetingRole = normalizeMeetingRole(meeting.type, meetingRole || access.meetingRole || metadata.meetingRole, legacyRole);
    const effectiveGrants = grants || access.grants;
    const sourceNames = resolvePublishSources({
      type: meeting.type,
      meetingRole: effectiveMeetingRole,
      legacyRole,
      legacyRestricted: metadata.legacyAccess === true && !meetingRole && !access.meetingRole,
      grants: effectiveGrants,
      settings: meeting,
    });
    return { access, legacyRole, meetingRole: effectiveMeetingRole, sourceNames };
  }

  async function assertModerationTarget(req, target) {
    const current = await participantPolicy(req.meeting, target);
    if (['HOST', 'TEACHER'].includes(current.meetingRole)) {
      throw new AppError(409, 'La función principal no puede modificarse desde los controles de moderación', 'PRIMARY_ROLE_PROTECTED');
    }
    return current;
  }

  app.post('/api/room/connection', requireRoomSession, requireRoomCsrf, roomMeeting, asyncHandler(async (req, res) => {
    const event = String(req.body?.event || 'connected').toLowerCase();
    if (!['attempt', 'retry', 'failed', 'connected', 'joined', 'reconnected'].includes(event)) throw new AppError(400, 'Evento de conexión no válido', 'VALIDATION_ERROR');
    const action = { attempt: 'ROOM_OPEN_ATTEMPT', retry: 'ROOM_RETRY', failed: 'ROOM_CONNECTION_FAILED' }[event];
    if (action) {
      await safeAudit({ actor: req.roomSession.identity, action, target: req.meeting.id, room: req.meeting.room, metadata: { reason: String(req.body?.reason || '').slice(0, 80) }, ...auditContext(req) });
      return res.json({ acknowledged: true, meetingStatus: req.meeting.status, startedAt: req.meeting.startedAt || null });
    }
    if (event === 'joined' || event === 'reconnected') {
      await assertCallerPresent(req);
      const attendanceRecord = await attendance.joined({
        seriesId: req.meeting.seriesId,
        meetingId: req.meeting.id,
        sessionNumber: req.meeting.sessionNumber,
        participantKey: req.roomSession.participantKey,
        participantIdentity: req.roomSession.identity,
        participantName: req.roomSession.displayName,
      }).catch(() => null);
      if (attendanceRecord) {
        await safeAudit({ actor: req.roomSession.identity, action: 'ATTENDANCE_UPDATED', target: req.meeting.id, room: req.meeting.room, metadata: { seriesId: req.meeting.seriesId, sessionNumber: req.meeting.sessionNumber, event }, ...auditContext(req) });
      }
      await safeAudit({ actor: req.roomSession.identity, action: event === 'joined' ? 'PARTICIPANT_JOINED' : 'PARTICIPANT_RECONNECTED', target: req.meeting.id, room: req.meeting.room, ...auditContext(req) });
      return res.json({ acknowledged: true, meetingStatus: req.meeting.status, startedAt: req.meeting.startedAt || null });
    }
    if (!req.roomCapabilities.canStartMeeting) throw new AppError(403, 'Solo el anfitrión o coanfitrión puede iniciar la reunión', 'ROOM_FORBIDDEN');
    const participants = await roomService.listParticipants(req.roomSession.room);
    if (!participants.some((participant) => participant.identity === req.roomSession.identity)) {
      throw new AppError(409, 'LiveKit todavía no confirma tu conexión', 'LIVEKIT_PARTICIPANT_NOT_CONFIRMED');
    }
    const hasConfirmedStart = req.meeting.status === 'LIVE' && Boolean(req.meeting.startedAt);
    const updated = hasConfirmedStart ? req.meeting : await meetings.transitionMeeting(req.meeting.room, 'start', { livekitConfirmedAt: new Date().toISOString() });
    if (!hasConfirmedStart) await safeAudit({ actor: req.roomSession.identity, action: 'ROOM_CONNECTED', target: updated.id, room: updated.room, ...auditContext(req) });
    res.json({ connected: true, meetingStatus: updated.status, started: !hasConfirmedStart, startedAt: updated.startedAt });
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

  app.post('/api/room/lock', requireRoomSession, requireRoomCsrf, interactionLimiter, roomMeeting, requireRoomCapability('canManageRoom'), asyncHandler(async (req, res) => {
    if (req.meeting.status !== 'LIVE') throw new AppError(409, 'La reunión no está en vivo', 'MEETING_NOT_LIVE');
    await assertCallerPresent(req);
    const locked = req.body?.locked === true;
    const state = await roomRegistry.setRoomLock(req.roomSession.room, locked, req.roomSession.identity);
    const message = { kind: 'room-lock', locked, changedBy: req.roomSession.displayName, sentAt: new Date().toISOString() };
    await relayRoomData(req, message);
    await safeAudit({ actor: req.roomSession.identity, action: locked ? 'ROOM_LOCKED' : 'ROOM_UNLOCKED', target: req.meeting.id, room: req.meeting.room, ...auditContext(req) });
    res.json({ locked: state.locked, lockedAt: state.lockedAt, message });
  }));

  app.post('/api/room/invitations', requireRoomSession, requireRoomCsrf, interactionLimiter, roomMeeting, requireRoomCapability('canManageInvitations'), asyncHandler(async (req, res) => {
    if (req.meeting.status !== 'LIVE') throw new AppError(409, 'La reunión no está en vivo', 'MEETING_NOT_LIVE');
    await assertCallerPresent(req);
    const created = await invitations.createInvitation({
      meetingId: req.meeting.id,
      room: req.meeting.room,
      role: req.body?.role,
      meetingType: req.body?.meetingRole ? req.meeting.type : undefined,
      meetingRole: req.body?.meetingRole,
      expiresInMinutes: req.body?.expiresInMinutes,
      singleUse: req.body?.singleUse === true,
      maxUses: req.body?.maxUses,
      createdBy: req.roomSession.username || req.roomSession.identity,
    });
    await safeAudit({ actor: req.roomSession.identity, action: 'INVITATION_CREATED', target: created.invitation.id, room: req.meeting.room, metadata: { role: created.invitation.role, meetingRole: created.invitation.meetingRole, source: 'in-room' }, ...auditContext(req) });
    res.status(201).json({ invitation: created.invitation, ...invitationSharePayload({ token: created.token, meeting: req.meeting, role: created.invitation.meetingRole }) });
  }));

  app.post('/api/room/simple-accesses/:kind', requireRoomSession, requireRoomCsrf, interactionLimiter, roomMeeting, requireRoomCapability('canManageInvitations'), asyncHandler(async (req, res) => {
    if (req.meeting.status !== 'LIVE') throw new AppError(409, 'La reunión no está en vivo', 'MEETING_NOT_LIVE');
    await assertCallerPresent(req);
    const access = simpleMeetingAccessPayload(req.meeting, req.params.kind);
    await safeAudit({
      actor: req.roomSession.identity,
      action: 'INVITATION_CREATED',
      target: req.meeting.id,
      room: req.meeting.room,
      metadata: { accessKind: access.kind, meetingRole: access.meetingRole, stable: true, source: 'in-room' },
      ...auditContext(req),
    });
    res.json({ access });
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
    const canModerate = req.roomCapabilities.canModerateQuestions;
    const visible = canModerate ? items : items.filter((item) => item.status !== 'DISMISSED');
    res.json({ questions: visible.map((item) => questions.publicQuestion(item, req.roomSession.identity)) });
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
      authorRole: req.meetingRole,
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
      identity: req.roomSession.identity, role: req.roomCapabilities.canModerateQuestions ? 'ORGANIZER' : req.roomSession.role, name: req.roomSession.displayName,
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
    const record = await questions.remove(req.roomSession.room, req.params.id, { identity: req.roomSession.identity, role: req.roomCapabilities.canModerateQuestions ? 'ORGANIZER' : req.roomSession.role });
    await relayRoomData(req, { kind: 'question-deleted', questionId: record.id, sentAt: new Date().toISOString() });
    res.json({ deleted: true });
  }));

  app.get('/api/room/speaker-requests', requireRoomSession, roomMeeting, asyncHandler(async (req, res) => {
    const canModerate = req.roomCapabilities.canManageParticipants || req.roomCapabilities.canModerateChat;
    const items = await speakerRequests.listRequests(req.roomSession.room, { activeOnly: true });
    res.json({ items: canModerate ? items : items.filter((item) => item.participantIdentity === req.roomSession.identity) });
  }));

  app.post('/api/participants/promote', requireRoomSession, requireRoomCsrf, interactionLimiter, roomMeeting, requireRoomCapability('canManageParticipants'), asyncHandler(async (req, res) => {
    if (req.meeting.status !== 'LIVE') throw new AppError(409, 'La reunión no está en vivo', 'MEETING_NOT_LIVE');
    const targetIdentity = sanitizeText(req.body?.targetIdentity, { field: 'targetIdentity', min: 5, max: 100, required: true });
    const participants = await assertCallerPresent(req);
    const target = participants.find((participant) => participant.identity === targetIdentity);
    if (!target) throw new AppError(404, 'Participante no encontrado', 'NOT_FOUND');
    const current = await assertModerationTarget(req, target);
    const nextGrants = { ...current.access.grants, microphone: true };
    const next = await participantPolicy(req.meeting, target, { grants: nextGrants });
    await roomService.updateParticipant(req.roomSession.room, targetIdentity, publishPermission(next.sourceNames));
    await roomRegistry.setSpeakerGrant(req.roomSession.room, targetIdentity, true, req.roomSession.identity);
    await speakerRequests.resolveSpeaker(req.roomSession.room, targetIdentity, 'GRANTED', req.roomSession.identity);
    await relayRoomData(req, { kind: 'hand-approved', targetIdentity, sentAt: new Date().toISOString() }, [targetIdentity]);
    await safeAudit({ actor: req.roomSession.identity, action: 'PARTICIPANT_PROMOTED', target: targetIdentity, room: req.roomSession.room, ...auditContext(req) });
    await safeAudit({ actor: req.roomSession.identity, action: 'SPEAKING_RIGHT_GRANTED', target: targetIdentity, room: req.roomSession.room, ...auditContext(req) });
    await safeAudit({ actor: req.roomSession.identity, action: 'SPEAKER_GRANTED', target: targetIdentity, room: req.roomSession.room, ...auditContext(req) });
    res.json({ promoted: true, targetIdentity, canPublish: next.sourceNames.length > 0, publishSources: next.sourceNames });
  }));

  app.post('/api/participants/demote', requireRoomSession, requireRoomCsrf, interactionLimiter, roomMeeting, requireRoomCapability('canManageParticipants'), asyncHandler(async (req, res) => {
    if (req.meeting.status !== 'LIVE') throw new AppError(409, 'La reunión no está en vivo', 'MEETING_NOT_LIVE');
    const targetIdentity = sanitizeText(req.body?.targetIdentity, { field: 'targetIdentity', min: 5, max: 100, required: true });
    const participants = await assertCallerPresent(req);
    const target = participants.find((participant) => participant.identity === targetIdentity);
    if (!target) throw new AppError(404, 'Participante no encontrado', 'NOT_FOUND');
    const current = await assertModerationTarget(req, target);
    const nextGrants = { ...current.access.grants };
    delete nextGrants.microphone;
    const next = await participantPolicy(req.meeting, target, { grants: nextGrants });
    await roomService.updateParticipant(req.roomSession.room, targetIdentity, publishPermission(next.sourceNames));
    await roomRegistry.setSpeakerGrant(req.roomSession.room, targetIdentity, false, req.roomSession.identity);
    await speakerRequests.resolveSpeaker(req.roomSession.room, targetIdentity, 'REVOKED', req.roomSession.identity);
    await relayRoomData(req, { kind: 'word-revoked', targetIdentity, sentAt: new Date().toISOString() }, [targetIdentity]);
    await safeAudit({ actor: req.roomSession.identity, action: 'PARTICIPANT_DEMOTED', target: targetIdentity, room: req.roomSession.room, ...auditContext(req) });
    await safeAudit({ actor: req.roomSession.identity, action: 'SPEAKING_RIGHT_REVOKED', target: targetIdentity, room: req.roomSession.room, ...auditContext(req) });
    await safeAudit({ actor: req.roomSession.identity, action: 'SPEAKER_REVOKED', target: targetIdentity, room: req.roomSession.room, ...auditContext(req) });
    res.json({ demoted: true, targetIdentity, canPublish: next.sourceNames.length > 0, publishSources: next.sourceNames });
  }));

  app.post('/api/participants/role', requireRoomSession, requireRoomCsrf, interactionLimiter, roomMeeting, requireRoomCapability('canManageParticipants'), asyncHandler(async (req, res) => {
    if (req.meeting.status !== 'LIVE') throw new AppError(409, 'La reunión no está en vivo', 'MEETING_NOT_LIVE');
    const targetIdentity = sanitizeText(req.body?.targetIdentity, { field: 'targetIdentity', min: 5, max: 100, required: true });
    const targetRole = sanitizeText(req.body?.meetingRole, { field: 'meetingRole', min: 4, max: 20, required: true }).toUpperCase();
    if (targetIdentity === req.roomSession.identity) throw new AppError(409, 'No puedes cambiar tu propia función durante la reunión', 'SELF_ROLE_CHANGE');
    if (!invitationRolesForType(req.meeting.type).includes(targetRole)) throw new AppError(400, 'La función no es válida para esta modalidad', 'VALIDATION_ERROR');
    if (['HOST', 'TEACHER'].includes(targetRole)) throw new AppError(409, 'La función principal no puede transferirse desde este control', 'PRIMARY_ROLE_PROTECTED');
    if (targetRole === 'COHOST' && !['HOST', 'TEACHER'].includes(req.meetingRole)) throw new AppError(403, 'Solo la función principal puede designar coanfitriones', 'ROOM_FORBIDDEN');
    const participants = await assertCallerPresent(req);
    const target = participants.find((participant) => participant.identity === targetIdentity);
    if (!target) throw new AppError(404, 'Participante no encontrado', 'NOT_FOUND');
    const current = await assertModerationTarget(req, target);
    const next = await participantPolicy(req.meeting, target, { meetingRole: targetRole, grants: {} });
    const metadata = { ...participantMetadata(target), meetingRole: targetRole, meetingType: req.meeting.type, roleChangedAt: new Date().toISOString() };
    await roomService.updateParticipant(req.roomSession.room, targetIdentity, { ...publishPermission(next.sourceNames), metadata: JSON.stringify(metadata) });
    await roomRegistry.setParticipantRole(req.roomSession.room, targetIdentity, targetRole, req.roomSession.identity);
    await relayRoomData(req, { kind: 'role-changed', targetIdentity, meetingRole: targetRole, publishSources: next.sourceNames, sentAt: new Date().toISOString() });
    await safeAudit({ actor: req.roomSession.identity, action: 'PARTICIPANT_ROLE_CHANGED', target: targetIdentity, room: req.roomSession.room, metadata: { from: current.meetingRole, to: targetRole }, ...auditContext(req) });
    res.json({ changed: true, targetIdentity, meetingRole: targetRole, publishSources: next.sourceNames });
  }));

  app.post('/api/participants/permissions', requireRoomSession, requireRoomCsrf, interactionLimiter, roomMeeting, requireRoomCapability('canManageParticipants'), asyncHandler(async (req, res) => {
    if (req.meeting.status !== 'LIVE') throw new AppError(409, 'La reunión no está en vivo', 'MEETING_NOT_LIVE');
    const targetIdentity = sanitizeText(req.body?.targetIdentity, { field: 'targetIdentity', min: 5, max: 100, required: true });
    const source = String(req.body?.source || '').toLowerCase();
    if (!['microphone', 'camera', 'screen'].includes(source)) throw new AppError(400, 'La fuente multimedia no es válida', 'VALIDATION_ERROR');
    const granted = req.body?.granted === true;
    const participants = await assertCallerPresent(req);
    const target = participants.find((participant) => participant.identity === targetIdentity);
    if (!target) throw new AppError(404, 'Participante no encontrado', 'NOT_FOUND');
    const current = await assertModerationTarget(req, target);
    const grants = { ...current.access.grants };
    grants[source] = granted;
    const next = await participantPolicy(req.meeting, target, { grants });
    await roomService.updateParticipant(req.roomSession.room, targetIdentity, publishPermission(next.sourceNames));
    await roomRegistry.setMediaGrant(req.roomSession.room, targetIdentity, source, granted, req.roomSession.identity);
    if (source === 'microphone') {
      await speakerRequests.resolveSpeaker(req.roomSession.room, targetIdentity, granted ? 'GRANTED' : 'REVOKED', req.roomSession.identity);
    }
    await relayRoomData(req, { kind: 'permission-changed', targetIdentity, source, granted, publishSources: next.sourceNames, sentAt: new Date().toISOString() }, [targetIdentity]);
    await safeAudit({ actor: req.roomSession.identity, action: granted ? 'MEDIA_PERMISSION_GRANTED' : 'MEDIA_PERMISSION_REVOKED', target: targetIdentity, room: req.roomSession.room, metadata: { source }, ...auditContext(req) });
    res.json({ changed: true, targetIdentity, source, granted, publishSources: next.sourceNames });
  }));

  app.post('/api/participants/self-demote', requireRoomSession, requireRoomCsrf, roomMeeting, asyncHandler(async (req, res) => {
    const participants = await assertCallerPresent(req);
    const target = participants.find((participant) => participant.identity === req.roomSession.identity);
    const current = await participantPolicy(req.meeting, target);
    const nextGrants = { ...current.access.grants };
    delete nextGrants.microphone;
    const next = await participantPolicy(req.meeting, target, { grants: nextGrants });
    await roomService.updateParticipant(req.roomSession.room, req.roomSession.identity, publishPermission(next.sourceNames));
    await roomRegistry.setSpeakerGrant(req.roomSession.room, req.roomSession.identity, false, req.roomSession.identity);
    await speakerRequests.resolveSpeaker(req.roomSession.room, req.roomSession.identity, 'REVOKED', req.roomSession.identity);
    await safeAudit({ actor: req.roomSession.identity, action: 'SPEAKER_REVOKED', target: req.roomSession.identity, room: req.roomSession.room, ...auditContext(req) });
    res.json({ demoted: true, canPublish: next.sourceNames.length > 0, publishSources: next.sourceNames });
  }));

  app.post('/api/participants/remove', requireRoomSession, requireRoomCsrf, interactionLimiter, roomMeeting, requireRoomCapability('canManageParticipants'), asyncHandler(async (req, res) => {
    if (req.meeting.status !== 'LIVE') throw new AppError(409, 'La reunión no está en vivo', 'MEETING_NOT_LIVE');
    const targetIdentity = sanitizeText(req.body?.targetIdentity, { field: 'targetIdentity', min: 5, max: 100, required: true });
    const participants = await assertCallerPresent(req);
    const target = participants.find((participant) => participant.identity === targetIdentity);
    if (!target) throw new AppError(404, 'Participante no encontrado', 'NOT_FOUND');
    await assertModerationTarget(req, target);
    await roomService.removeParticipant(req.roomSession.room, targetIdentity);
    await roomRegistry.clearParticipantAccess(req.roomSession.room, targetIdentity).catch(() => {});
    await safeAudit({ actor: req.roomSession.identity, action: 'PARTICIPANT_REMOVED', target: targetIdentity, room: req.roomSession.room, ...auditContext(req) });
    res.json({ removed: true });
  }));

  app.post('/api/participants/block', requireRoomSession, requireRoomCsrf, interactionLimiter, roomMeeting, requireRoomCapability('canManageParticipants'), asyncHandler(async (req, res) => {
    if (req.meeting.status !== 'LIVE') throw new AppError(409, 'La reunión no está en vivo', 'MEETING_NOT_LIVE');
    const targetIdentity = sanitizeText(req.body?.targetIdentity, { field: 'targetIdentity', min: 5, max: 100, required: true });
    const participants = await assertCallerPresent(req);
    const target = participants.find((participant) => participant.identity === targetIdentity);
    if (!target) throw new AppError(404, 'Participante no encontrado', 'NOT_FOUND');
    await assertModerationTarget(req, target);
    let metadata = {};
    try { metadata = JSON.parse(target.metadata || '{}'); } catch (_error) { metadata = {}; }
    let seriesAccessRevoked = false;
    if (metadata.seriesAccessId) {
      const access = await seriesAccesses.getAccess(metadata.seriesAccessId);
      if (access && access.mode !== 'GENERAL') {
        await seriesAccesses.revokeAccess(metadata.seriesAccessId, metadata.seriesId || null);
        seriesAccessRevoked = true;
      }
    } else if (metadata.invitationId) await invitations.revokeInvitation(metadata.invitationId, req.roomSession.room);
    await roomService.removeParticipant(req.roomSession.room, targetIdentity);
    await roomRegistry.clearParticipantAccess(req.roomSession.room, targetIdentity).catch(() => {});
    await safeAudit({ actor: req.roomSession.identity, action: 'PARTICIPANT_BLOCKED', target: targetIdentity, room: req.roomSession.room, metadata: { invitationRevoked: Boolean(metadata.invitationId), seriesAccessRevoked }, ...auditContext(req) });
    res.json({ blocked: true, invitationRevoked: Boolean(metadata.invitationId), seriesAccessRevoked });
  }));

  app.post('/api/participants/request-media', requireRoomSession, requireRoomCsrf, interactionLimiter, roomMeeting, requireRoomCapability('canManageParticipants'), asyncHandler(async (req, res) => {
    if (req.meeting.status !== 'LIVE') throw new AppError(409, 'La reunión no está en vivo', 'MEETING_NOT_LIVE');
    const targetIdentity = sanitizeText(req.body?.targetIdentity, { field: 'targetIdentity', min: 5, max: 100, required: true });
    const action = String(req.body?.action || 'request-microphone');
    if (!['request-microphone', 'request-camera-off'].includes(action)) throw new AppError(400, 'Solicitud multimedia no válida', 'VALIDATION_ERROR');
    const participants = await assertCallerPresent(req);
    const target = participants.find((participant) => participant.identity === targetIdentity);
    if (!target) throw new AppError(404, 'El participante ya no está conectado', 'PARTICIPANT_NOT_CONNECTED');
    await assertModerationTarget(req, target);
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
      if (pending.action === 'request-microphone' && !participantCanPublishSource(target, 'MICROPHONE')) {
        const current = await participantPolicy(req.meeting, target);
        const next = await participantPolicy(req.meeting, target, { grants: { ...current.access.grants, microphone: true } });
        await roomService.updateParticipant(req.roomSession.room, req.roomSession.identity, publishPermission(next.sourceNames));
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
      const current = await participantPolicy(req.meeting, target);
      const grants = { ...current.access.grants };
      delete grants.microphone;
      const next = await participantPolicy(req.meeting, target, { grants });
      await roomService.updateParticipant(req.roomSession.room, req.roomSession.identity, publishPermission(next.sourceNames));
      await roomRegistry.setSpeakerGrant(req.roomSession.room, req.roomSession.identity, false, pending.requesterIdentity);
    }
    pendingMediaRequests.delete(requestId);
    const auditAction = status === 'rejected' ? 'MICROPHONE_REQUEST_REJECTED' : status === 'failed' ? 'MICROPHONE_REQUEST_FAILED' : 'MICROPHONE_REQUEST_ACCEPTED';
    await safeAudit({ actor: req.roomSession.identity, action: auditAction, target: pending.requesterIdentity, room: req.roomSession.room, metadata: { status }, ...auditContext(req) });
    await relayRoomData(req, { kind: 'media-response', requestId, action: pending.action, status, targetIdentity: req.roomSession.identity, displayName: req.roomSession.displayName, sentAt: new Date().toISOString() }, [pending.requesterIdentity]);
    res.json({ acknowledged: true, status });
  }));

  app.post('/api/participants/mute', requireRoomSession, requireRoomCsrf, interactionLimiter, roomMeeting, requireRoomCapability('canManageParticipants'), asyncHandler(async (req, res) => {
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

  function canPinChat(meetingRole) {
    return ['HOST', 'TEACHER', 'COHOST'].includes(String(meetingRole || '').toUpperCase());
  }

  app.get('/api/chat/pins', requireRoomSession, roomMeeting, asyncHandler(async (req, res) => {
    const records = await pinnedMessages.list(req.roomSession.room);
    res.json({ pins: records.filter((pin) => pin.meetingId === req.meeting.id).map(pinnedMessages.publicPin) });
  }));

  app.post('/api/chat/pins', requireRoomSession, requireRoomCsrf, interactionLimiter, roomMeeting, asyncHandler(async (req, res) => {
    if (!canPinChat(req.meetingRole)) throw new AppError(403, 'No puedes fijar mensajes del chat', 'ROOM_FORBIDDEN');
    await assertCallerPresent(req);
    const record = await pinnedMessages.create({
      room: req.roomSession.room,
      meetingId: req.meeting.id,
      text: req.body?.text,
      authorName: req.body?.authorName || req.roomSession.displayName,
      authorRole: req.body?.authorRole || req.meetingRole,
      sourceSentAt: req.body?.sentAt,
      pinnedBy: req.roomSession.displayName || req.roomSession.identity,
    });
    await relayRoomData(req, { kind: 'chat-pins-changed', sentAt: record.pinnedAt });
    res.status(201).json({ pin: pinnedMessages.publicPin(record) });
  }));

  app.delete('/api/chat/pins/:id', requireRoomSession, requireRoomCsrf, interactionLimiter, roomMeeting, asyncHandler(async (req, res) => {
    if (!canPinChat(req.meetingRole)) throw new AppError(403, 'No puedes desfijar mensajes del chat', 'ROOM_FORBIDDEN');
    await assertCallerPresent(req);
    const record = await pinnedMessages.get(req.roomSession.room, req.params.id);
    if (!record || record.meetingId !== req.meeting.id) throw new AppError(404, 'Mensaje fijado no encontrado', 'NOT_FOUND');
    await pinnedMessages.remove(req.roomSession.room, record.id);
    await relayRoomData(req, { kind: 'chat-pins-changed', sentAt: new Date().toISOString() });
    res.json({ removed: true });
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
        role: req.meetingRole,
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
      const requestRecord = kind === 'hand-raise'
        ? await speakerRequests.requestSpeaker({
          meetingId: req.meeting.id,
          room: req.roomSession.room,
          participantIdentity: req.roomSession.identity,
          participantName: req.roomSession.displayName,
        })
        : await speakerRequests.resolveSpeaker(req.roomSession.room, req.roomSession.identity, 'REVOKED', req.roomSession.identity);
      message = {
        kind,
        identity: req.roomSession.identity,
        displayName: req.roomSession.displayName,
        requestId: requestRecord?.id || null,
        raisedAt: requestRecord?.requestedAt || new Date().toISOString(),
      };
      await safeAudit({
        actor: req.roomSession.identity,
        action: kind === 'hand-raise' ? 'SPEAKER_REQUESTED' : 'SPEAKER_REVOKED',
        target: requestRecord?.id || req.roomSession.identity,
        room: req.roomSession.room,
        ...auditContext(req),
      });
    } else if (kind === 'hand-rejected') {
      if (!req.roomCapabilities.canManageParticipants && !req.roomCapabilities.canModerateChat) throw new AppError(403, 'No puedes moderar manos levantadas', 'ROOM_FORBIDDEN');
      const targetIdentity = sanitizeText(req.body?.targetIdentity, { field: 'targetIdentity', min: 5, max: 100, required: true });
      if (!participants.some((participant) => participant.identity === targetIdentity)) throw new AppError(404, 'Participante no encontrado', 'NOT_FOUND');
      message = { kind, targetIdentity, sentAt: new Date().toISOString() };
      destinations = [targetIdentity];
      const requestRecord = await speakerRequests.resolveSpeaker(req.roomSession.room, targetIdentity, 'REJECTED', req.roomSession.identity);
      if (requestRecord) await safeAudit({ actor: req.roomSession.identity, action: 'SPEAKER_REJECTED', target: requestRecord.id, room: req.roomSession.room, ...auditContext(req) });
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
    assertValidFileContent(mimetype, req.file.buffer);
    const extension = path.extname(req.file.originalname || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
    const displayName = sanitizeText(path.basename(req.file.originalname || 'archivo'), { field: 'filename', min: 1, max: 120, required: true });
    const key = `chat-uploads/${req.roomSession.room}/${Date.now()}-${crypto.randomUUID()}${extension}`;
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: req.file.buffer, ContentType: mimetype }));
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 60 * 60 * 24 });
    const participants = await assertCallerPresent(req);
    const message = {
      kind: 'chat', type: 'file', url, filename: displayName, size: req.file.size, mimetype,
      role: req.meetingRole, from: req.roomSession.displayName, fromIdentity: req.roomSession.identity,
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
      const recording = active.find(isRecordingEgress);
      const state = recording ? recordingStateFromEgress(recording) : { state: 'IDLE', active: false, egressId: null };
      res.json({ ...state, configured: true });
    } catch {
      res.json({ state: 'FAILED', active: false, egressId: null, configured: true, message: 'No fue posible consultar Egress.' });
    }
  }));

  app.post('/api/recording/start', requireRoomSession, requireRoomCsrf, roomMeeting, requireRoomCapability('canManageRecording'), asyncHandler(async (req, res) => {
    let durableSession = null;
    try {
      if (!recordingConfigured) throw new AppError(400, 'La grabación no está configurada', 'RECORDING_NOT_CONFIGURED');
      if (!req.meeting.allowRecording || req.meeting.status !== 'LIVE') throw new AppError(409, 'La grabación no está permitida en esta reunión', 'RECORDING_DISABLED');
      const participants = await assertCallerPresent(req);
      const existing = await egressClient.listEgress({ roomName: req.roomSession.room, active: true });
      const currentRecording = existing.find(isRecordingEgress);
      if (currentRecording) return res.json({ ...recordingStateFromEgress(currentRecording), alreadyRunning: true });
      if (db.usingPostgres()) {
        const begun = await externalSessions.beginRecording({ meetingId: req.meeting.id, room: req.roomSession.room });
        durableSession = begun.session;
        if (!begun.created) return res.json({ state: 'PROCESSING', active: false, egressId: durableSession.egressId, alreadyRunning: true });
        await externalSessions.updateRecording(durableSession.id, { status: 'STARTING', startedAt: new Date().toISOString() });
      }
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
      if (durableSession) {
        await externalSessions.updateRecording(durableSession.id, {
          egressId: info.egressId,
          status: state.active ? 'RECORDING' : state.state === 'FAILED' ? 'FAILED' : 'PROCESSING',
          providerStatus: typeof info.status === 'string' ? info.status : EgressStatus[info.status] || null,
          outputObjectKey: `${filepath}.mp4`,
          metadata: { source: 'ROOM_COMPOSITE' },
        });
        await backgroundJobs.enqueue({ type: 'RECORDING_RECONCILE', dedupeKey: `recording-reconcile:${info.egressId}`, priority: 20, maxAttempts: 5, payload: { sessionId: durableSession.id, room: req.roomSession.room, egressId: info.egressId } });
      }
      await relayRoomData(req, { kind: 'recording-status', ...state, sentAt: new Date().toISOString() });
      await safeAudit({ actor: req.roomSession.identity, action: 'RECORDING_STARTED', target: info.egressId, room: req.roomSession.room, metadata: { state: state.state }, ...auditContext(req) });
      res.json({ ...state, alreadyRunning: false });
    } catch (error) {
      if (durableSession) {
        const classified = classifyProviderError(error, { provider: 'livekit', operation: 'startRecording', creatingSideEffect: true });
        await externalSessions.updateRecording(durableSession.id, {
          status: classified.unknownSideEffect ? 'PENDING_RECONCILIATION' : 'FAILED',
          lastErrorCode: classified.code,
          lastErrorMessage: classified.safeMessage,
        }).catch(() => null);
        if (classified.unknownSideEffect) {
          await backgroundJobs.enqueue({ type: 'RECORDING_RECONCILE', dedupeKey: `recording-reconcile:${durableSession.id}`, priority: 20, maxAttempts: 5, payload: { sessionId: durableSession.id, room: req.roomSession.room } }).catch(() => null);
        }
      }
      await safeAudit({ actor: req.roomSession.identity, action: 'RECORDING_FAILED', target: req.meeting.id, room: req.roomSession.room, metadata: { operation: 'start', code: error.code || 'EGRESS_ERROR' }, ...auditContext(req) });
      throw error;
    }
  }));

  app.post('/api/recording/stop', requireRoomSession, requireRoomCsrf, roomMeeting, requireRoomCapability('canManageRecording'), asyncHandler(async (req, res) => {
    try {
      await assertCallerPresent(req);
      const egressId = sanitizeText(req.body?.egressId, { field: 'egressId', min: 5, max: 120, required: true });
      const active = await egressClient.listEgress({ roomName: req.roomSession.room, active: true });
      if (!active.some((egress) => egress.egressId === egressId && isRecordingEgress(egress))) throw new AppError(404, 'Grabación activa no encontrada en esta sala', 'NOT_FOUND');
      const info = await egressClient.stopEgress(egressId);
      const state = recordingStateFromEgress(info);
      await backgroundJobs.enqueue({ type: 'RECORDING_RECONCILE', dedupeKey: `recording-reconcile:${egressId}`, priority: 20, maxAttempts: 5, payload: { room: req.roomSession.room, egressId } }).catch(() => null);
      const responseState = state.active ? state : { state: state.state === 'FAILED' ? 'FAILED' : 'PROCESSING', active: false, egressId: null };
      await relayRoomData(req, { kind: 'recording-status', ...responseState, sentAt: new Date().toISOString() });
      await safeAudit({ actor: req.roomSession.identity, action: 'RECORDING_STOPPED', target: egressId, room: req.roomSession.room, ...auditContext(req) });
      res.json({ stopped: true, ...responseState });
    } catch (error) {
      await safeAudit({ actor: req.roomSession.identity, action: 'RECORDING_FAILED', target: req.body?.egressId || req.meeting.id, room: req.roomSession.room, metadata: { operation: 'stop', code: error.code || 'EGRESS_ERROR' }, ...auditContext(req) });
      throw error;
    }
  }));

  app.get('/api/facebook-live/status', requireRoomSession, roomMeeting, asyncHandler(async (req, res) => {
    try {
      res.json(publicFacebookState(req.roomSession.room, await facebookEgress(req.roomSession.room)));
    } catch {
      res.json({ provider: 'facebook', state: 'ERROR', active: false, egressId: null, startedAt: null, stoppedAt: null, message: 'No fue posible consultar la señal externa.' });
    }
  }));

  app.post('/api/facebook-live/start', requireRoomSession, requireRoomCsrf, roomMeeting, requireRoomCapability('canManageRecording'), asyncHandler(async (req, res) => {
    if (req.meeting.status !== 'LIVE') throw new AppError(409, 'La reunión no está en vivo', 'MEETING_NOT_LIVE');
    if (config.isProductionLike && !req.secure) throw new AppError(400, 'Facebook Live requiere una conexión HTTPS', 'HTTPS_REQUIRED');
    await assertCallerPresent(req);
    const { output } = validateFacebookDestination(req.body?.serverUrl, req.body?.streamKey);
    let durableSession = null;
    try {
      const current = await facebookEgress(req.roomSession.room);
      const currentState = publicFacebookState(req.roomSession.room, current);
      if (currentState.active) return res.json({ ...currentState, alreadyRunning: true });
      if (db.usingPostgres()) {
        const begun = await externalSessions.beginFacebook({ meetingId: req.meeting.id, room: req.roomSession.room });
        durableSession = begun.session;
        if (!begun.created) return res.json({ provider: 'facebook', state: 'CONNECTING', active: false, egressId: durableSession.egressId, startedAt: durableSession.startedAt, stoppedAt: null, alreadyRunning: true });
        await externalSessions.updateFacebook(durableSession.id, { status: 'STARTING', startedAt: new Date().toISOString() });
      }
      const info = await egressClient.startRoomCompositeEgress(req.roomSession.room, output, { layout: 'speaker' });
      facebookEgressByRoom.set(req.roomSession.room, {
        provider: 'facebook', egressId: info.egressId, status: 'SENDING', startedAt: new Date().toISOString(), stoppedAt: null,
      });
      if (durableSession) {
        await externalSessions.updateFacebook(durableSession.id, { egressId: info.egressId, status: 'LIVE', metadata: { source: 'livekit-rtmp-egress' } });
        await backgroundJobs.enqueue({ type: 'FACEBOOK_RECONCILE', dedupeKey: `facebook-reconcile:${info.egressId}`, priority: 20, maxAttempts: 5, payload: { sessionId: durableSession.id, room: req.roomSession.room, egressId: info.egressId } });
      }
      const state = publicFacebookState(req.roomSession.room, info);
      await relayRoomData(req, { kind: 'external-stream-status', ...state, sentAt: new Date().toISOString() });
      res.status(201).json({ ...state, alreadyRunning: false });
    } catch (error) {
      if (durableSession) {
        const classified = classifyProviderError(error, { provider: 'livekit', operation: 'startFacebookLive', creatingSideEffect: true });
        await externalSessions.updateFacebook(durableSession.id, {
          status: classified.unknownSideEffect ? 'PENDING_RECONCILIATION' : 'FAILED',
          lastErrorCode: classified.code,
          lastErrorMessage: classified.safeMessage,
        }).catch(() => null);
        if (classified.unknownSideEffect) {
          await backgroundJobs.enqueue({ type: 'FACEBOOK_RECONCILE', dedupeKey: `facebook-reconcile:${durableSession.id}`, priority: 20, maxAttempts: 5, payload: { sessionId: durableSession.id, room: req.roomSession.room } }).catch(() => null);
        }
      }
      if (error instanceof AppError) throw error;
      throw new AppError(502, facebookStartFailureMessage(error), 'FACEBOOK_EGRESS_FAILED');
    } finally {
      output.urls.fill('');
      if (req.body) req.body.streamKey = '';
    }
  }));

  app.post('/api/facebook-live/stop', requireRoomSession, requireRoomCsrf, roomMeeting, requireRoomCapability('canManageRecording'), asyncHandler(async (req, res) => {
    await assertCallerPresent(req);
    try {
      const current = await facebookEgress(req.roomSession.room);
      const requestedId = req.body?.egressId
        ? sanitizeText(req.body.egressId, { field: 'egressId', min: 5, max: 120, required: true })
        : current?.egressId;
      if (!current || current.egressId !== requestedId || !publicFacebookState(req.roomSession.room, current).active) {
        throw new AppError(404, 'Transmisión externa activa no encontrada', 'FACEBOOK_EGRESS_NOT_FOUND');
      }
      const info = await egressClient.stopEgress(requestedId);
      const metadata = facebookEgressByRoom.get(req.roomSession.room) || {};
      facebookEgressByRoom.set(req.roomSession.room, { ...metadata, status: 'IDLE', stoppedAt: new Date().toISOString() });
      await backgroundJobs.enqueue({ type: 'FACEBOOK_RECONCILE', dedupeKey: `facebook-reconcile:${requestedId}`, priority: 20, maxAttempts: 5, payload: { room: req.roomSession.room, egressId: requestedId } }).catch(() => null);
      const state = publicFacebookState(req.roomSession.room, info);
      await relayRoomData(req, { kind: 'external-stream-status', ...state, sentAt: new Date().toISOString() });
      res.json({ stopped: true, ...state });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(502, 'No fue posible detener la señal hacia Facebook', 'FACEBOOK_EGRESS_STOP_FAILED');
    }
  }));

  app.post('/api/room/end', requireRoomSession, requireRoomCsrf, roomMeeting, requireRoomCapability('canEndMeeting'), asyncHandler(async (req, res) => {
    const result = await idempotency.runHttp(req, `room:${req.roomSession.room}:end`, async () => {
      await assertCallerPresent(req);
      try {
        const egresses = await egressClient.listEgress({ roomName: req.roomSession.room, active: true });
        const external = egresses.filter((info) => isFacebookEgress(req.roomSession.room, info));
        await Promise.allSettled(external.map((info) => egressClient.stopEgress(info.egressId)));
      } catch { /* An external destination must never block ending the meeting. */ }
      const updated = await meetings.transitionMeeting(req.roomSession.room, 'complete');
      await roomRegistry.revokeRoom(req.roomSession.room);
      await roomService.deleteRoom(req.roomSession.room).catch((error) => {
        if (!/not found/i.test(error.message || '')) throw error;
      });
      await safeAudit({ actor: req.roomSession.identity, action: 'ROOM_ENDED', target: updated.id, room: updated.room, ...auditContext(req) });
      return { status: 200, body: { ended: true } };
    });
    res.setHeader('Set-Cookie', [clearRoomCookie(), clearRoomCookie(req.roomSessionSelector)]);
    res.status(result.status).json(result.body);
  }));

  app.get('/api/recordings', auth.requireAuth, auth.requireRoles('ADMIN', 'ORGANIZER'), asyncHandler(async (req, res) => {
    if (!storageConfigured) throw new AppError(400, 'El almacenamiento no está configurado', 'STORAGE_NOT_CONFIGURED');
    const requestedRoom = req.query.room ? String(req.query.room) : null;
    const limit = parseLimit(req.query.limit, { defaultLimit: 50, maxLimit: 200 });
    if (requestedRoom) {
      const meeting = await meetings.getMeeting(requestedRoom);
      if (!meeting || !canManageMeeting(req.auth, meeting)) throw new AppError(403, 'No tienes permiso para ver estas grabaciones', 'FORBIDDEN');
    }
    if (db.usingPostgres()) {
      const page = await recordings.listPostgresRecordings({ room: requestedRoom, limit, cursor: req.query.cursor });
      const items = page.items
        .filter((item) => canManageMeeting(req.auth, item.meeting))
        .map(({ meeting, transcript, ...item }) => ({
          ...item,
          transcript: transcript ? transcriptions.transcriptSummary(transcript) : null,
          transcriptionAllowed: Boolean(item.transcriptionAllowed && transcriptionProvider.isConfigured()),
        }));
      return res.json({ items, nextCursor: page.nextCursor, transcriptionConfigured: transcriptionProvider.isConfigured() });
    }
    const allowedRooms = req.auth.role === 'ADMIN'
      ? null
      : new Set((await meetings.listMeetings({ includeDeleted: true })).filter((meeting) => canManageMeeting(req.auth, meeting)).map((meeting) => meeting.room));
    const listing = await recordings.listS3Recordings({ room: requestedRoom, limit, continuationToken: req.query.cursor || null });
    const items = await Promise.all((listing.objects || [])
      .filter((object) => object.Key.endsWith('.mp4'))
      .filter((object) => !allowedRooms || allowedRooms.has(object.Key.split('/')[1]))
       .map(async (object) => {
         const room = object.Key.split('/')[1];
         const meeting = await meetings.getMeeting(room);
         const transcript = meeting ? (await transcriptions.listTranscriptSummaries({ meetingId: meeting.id })).find((item) => item.recordingId === object.Key) : null;
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
           source: 'ROOM_COMPOSITE',
           participants: [],
           tracks: [],
           transcript: transcript || null,
           transcriptionAllowed: Boolean(meeting?.allowTranscription && meeting?.status === 'COMPLETED' && transcriptionProvider.isConfigured()),
         };
      }));
    items.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
    res.json({ items, nextCursor: listing.nextCursor, transcriptionConfigured: transcriptionProvider.isConfigured() });
  }));

  app.get('/api/recordings/download', auth.requireAuth, auth.requireRoles('ADMIN', 'ORGANIZER'), asyncHandler(async (req, res) => {
    if (!storageConfigured) throw new AppError(400, 'El almacenamiento no está configurado', 'STORAGE_NOT_CONFIGURED');
    const key = recordings.validateRecordingKey(req.query.key);
    const room = key.split('/')[1];
    const meeting = await meetings.getMeeting(room);
    if (!meeting || !canManageMeeting(req.auth, meeting)) throw new AppError(403, 'No tienes permiso para descargar esta grabación', 'FORBIDDEN');
    await safeAudit({ actor: req.auth.u, action: 'RECORDING_DOWNLOADED', target: key, room, ...auditContext(req) });
    res.json({ url: await recordings.signedRecordingUrl(key) });
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
    const requestedRecordingId = typeof req.body?.recordingId === 'string' ? req.body.recordingId.slice(0, 512) : null;
    await safeAudit({ actor: req.auth.u, action: 'TRANSCRIPTION_REQUESTED', target: meeting?.id || req.params.meetingId, room: meeting?.room || null, metadata: { recordingId: requestedRecordingId, language: req.body?.language || config.transcriptionLanguage, provider: config.transcriptionProvider }, ...auditContext(req) });
    try {
      if (!meeting) throw new AppError(404, 'Reunión no encontrada', 'NOT_FOUND');
      if (!canManageMeeting(req.auth, meeting)) throw new AppError(403, 'No tienes permiso para transcribir esta reunión', 'FORBIDDEN');
      const recording = await resolveTranscriptionRecording(req.body?.recordingId, meeting);
      if (!recording) throw new AppError(404, 'La reunión no tiene una grabación disponible', 'TRANSCRIPTION_RECORDING_NOT_FOUND');
      if (recording.status !== 'READY' || recording.available === false) throw new AppError(409, 'La grabación todavía no está lista', 'TRANSCRIPTION_RECORDING_NOT_READY');
      if (recording.durationSeconds && recording.durationSeconds > config.transcriptionMaxDurationMinutes * 60) {
        throw new AppError(413, 'La grabación supera la duración máxima permitida para transcripción', 'TRANSCRIPTION_RECORDING_TOO_LONG');
      }
      if (recording.size && recording.size > config.transcriptionMaxAudioBytes) {
        throw new AppError(413, 'La grabación supera el tamaño máximo permitido para transcripción', 'TRANSCRIPTION_RECORDING_TOO_LARGE');
      }
      const transcript = await transcriptions.createTranscript({
        meeting, recording, requestedBy: req.auth.u, language: req.body?.language, provider: transcriptionProvider,
      });
      await safeAudit({ actor: req.auth.u, action: 'TRANSCRIPTION_CREATED', target: transcript.id, room: meeting.room, metadata: { recordingId: transcript.recordingId, provider: transcript.provider, language: transcript.language, status: transcript.status }, ...auditContext(req) });
      res.status(201).json({ transcript: transcriptions.publicTranscript(transcript) });
    } catch (error) {
      await safeAudit({ actor: req.auth.u, action: 'TRANSCRIPTION_VALIDATION_FAILED', target: meeting?.id || req.params.meetingId, room: meeting?.room || null, metadata: { recordingId: requestedRecordingId, errorCode: error.code || 'TRANSCRIPTION_REQUEST_FAILED' }, ...auditContext(req) });
      throw error;
    }
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
    const recording = await resolveRecording(transcript.recordingId, req.transcriptMeeting).catch(() => null);
    if (!transcriptions.TERMINAL_STATUSES.has(transcript.status) && transcriptionProvider.isConfigured()) {
      const previous = transcript;
      transcript = await transcriptions.refreshTranscript(transcript, transcriptionProvider, recording || {});
      if (!previous.startedAt && transcript.startedAt) await safeAudit({ actor: req.auth.u, action: 'TRANSCRIPTION_STARTED', target: transcript.id, room: req.transcriptMeeting.room, metadata: { recordingId: transcript.recordingId, provider: transcript.provider, language: transcript.language }, ...auditContext(req) });
      if (!previous.providerSubmittedAt && transcript.providerSubmittedAt) await safeAudit({ actor: req.auth.u, action: 'TRANSCRIPTION_PROVIDER_SUBMITTED', target: transcript.id, room: req.transcriptMeeting.room, metadata: { recordingId: transcript.recordingId, provider: transcript.provider }, ...auditContext(req) });
      if (transcript.status === 'FAILED') await safeAudit({ actor: req.auth.u, action: 'TRANSCRIPTION_FAILED', target: transcript.id, room: req.transcriptMeeting.room, metadata: { errorCode: transcript.errorCode, providerRequestId: transcript.providerRequestId }, ...auditContext(req) });
      if (transcriptions.COMPLETE_STATUSES.has(transcript.status)) await safeAudit({ actor: req.auth.u, action: 'TRANSCRIPTION_COMPLETED', target: transcript.id, room: req.transcriptMeeting.room, metadata: { segments: transcript.segments.length, durationSeconds: transcript.durationSeconds, providerRequestId: transcript.providerRequestId }, ...auditContext(req) });
    }
    res.json({ transcript: transcriptions.publicTranscript(transcript), meeting: req.transcriptMeeting, recording: recording ? { id: recording.id, source: recording.source, status: recording.status } : null, configured: transcriptionProvider.isConfigured() });
  }));

  app.patch('/api/transcriptions/:id', auth.requireAuth, auth.requireCsrf, auth.requireRoles('ADMIN', 'ORGANIZER'), requireTranscript, asyncHandler(async (req, res) => {
    if (!canManageMeeting(req.auth, req.transcriptMeeting)) throw new AppError(403, 'No tienes permiso para editar esta transcripción', 'FORBIDDEN');
    const transcript = await transcriptions.editTranscript(req.transcript, {
      segments: req.body?.segments, language: req.body?.language, revision: req.body?.revision, editedBy: req.auth.u,
    });
    await safeAudit({ actor: req.auth.u, action: 'TRANSCRIPTION_EDITED', target: transcript.id, room: req.transcriptMeeting.room, metadata: { revision: transcript.revision }, ...auditContext(req) });
    res.json({ transcript: transcriptions.publicTranscript(transcript) });
  }));

  app.patch('/api/transcriptions/:id/speakers/:speakerId', auth.requireAuth, auth.requireCsrf, auth.requireRoles('ADMIN', 'ORGANIZER'), requireTranscript, asyncHandler(async (req, res) => {
    if (!canManageMeeting(req.auth, req.transcriptMeeting)) throw new AppError(403, 'No tienes permiso para renombrar hablantes de esta transcripción', 'FORBIDDEN');
    const transcript = await transcriptions.renameSpeaker(req.transcript, {
      speakerId: req.params.speakerId,
      participantName: req.body?.participantName,
      revision: req.body?.revision,
      editedBy: req.auth.u,
    });
    await safeAudit({ actor: req.auth.u, action: 'TRANSCRIPTION_SPEAKER_RENAMED', target: transcript.id, room: req.transcriptMeeting.room, metadata: { speakerId: req.params.speakerId, revision: transcript.revision }, ...auditContext(req) });
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
    const recording = await resolveTranscriptionRecording(req.transcript.recordingId, req.transcriptMeeting);
    if (!recording || recording.status !== 'READY') throw new AppError(409, 'La grabación ya no está disponible', 'TRANSCRIPTION_RECORDING_NOT_READY');
    if (recording.durationSeconds && recording.durationSeconds > config.transcriptionMaxDurationMinutes * 60) throw new AppError(413, 'La grabación supera la duración máxima permitida', 'TRANSCRIPTION_RECORDING_TOO_LONG');
    if (recording.size && recording.size > config.transcriptionMaxAudioBytes) throw new AppError(413, 'La grabación supera el tamaño máximo permitido', 'TRANSCRIPTION_RECORDING_TOO_LARGE');
    const transcript = await transcriptions.retryTranscript(req.transcript, { meeting: req.transcriptMeeting, recording, requestedBy: req.auth.u, provider: transcriptionProvider });
    await safeAudit({ actor: req.auth.u, action: 'TRANSCRIPTION_RETRIED', target: transcript.id, room: req.transcriptMeeting.room, ...auditContext(req) });
    res.json({ transcript: transcriptions.publicTranscript(transcript) });
  }));

  app.post('/api/transcriptions/:id/cancel', auth.requireAuth, auth.requireCsrf, auth.requireRoles('ADMIN', 'ORGANIZER'), requireTranscript, asyncHandler(async (req, res) => {
    if (!canManageMeeting(req.auth, req.transcriptMeeting)) throw new AppError(403, 'No tienes permiso para cancelar esta transcripción', 'FORBIDDEN');
    const recording = await resolveRecording(req.transcript.recordingId, req.transcriptMeeting).catch(() => null);
    const transcript = await transcriptions.cancelTranscript(req.transcript, transcriptionProvider, recording || {});
    const action = transcriptions.COMPLETE_STATUSES.has(transcript.status) ? 'TRANSCRIPTION_COMPLETED' : transcript.status === 'FAILED' ? 'TRANSCRIPTION_FAILED' : 'TRANSCRIPTION_CANCELLED';
    await safeAudit({ actor: req.auth.u, action, target: transcript.id, room: req.transcriptMeeting.room, metadata: { errorCode: transcript.errorCode, providerRequestId: transcript.providerRequestId }, ...auditContext(req) });
    res.json({ transcript: transcriptions.publicTranscript(transcript) });
  }));

  app.get('/api/transcriptions/:id/export', auth.requireAuth, auth.requireRoles('ADMIN', 'ORGANIZER', 'PANELIST'), requireTranscript, asyncHandler(async (req, res) => {
    const exported = transcriptions.exportTranscript(req.transcript, req.query.format);
    const filename = `${slugify(req.transcriptMeeting.title || 'transcripcion') || 'transcripcion'}-${req.transcript.id.slice(0, 8)}.${exported.extension}`;
    await safeAudit({ actor: req.auth.u, action: 'TRANSCRIPTION_EXPORTED', target: req.transcript.id, room: req.transcriptMeeting.room, metadata: { format: exported.extension }, ...auditContext(req) });
    res.setHeader('Content-Type', exported.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(exported.body);
  }));

  app.get('/api/audit', auth.requireAuth, auth.requireRoles('ADMIN'), asyncHandler(async (req, res) => {
    const limit = parseLimit(req.query.limit, { defaultLimit: 100, maxLimit: 500 });
    const result = await audit.listEvents({ limit, action: req.query.action, actor: req.query.actor, room: req.query.room, cursor: req.query.cursor, page: true });
    res.json(result);
  }));

  app.get('/api/dashboard/summary', auth.requireAuth, auth.requireRoles('ADMIN', 'ORGANIZER'), asyncHandler(async (req, res) => {
    const allMeetings = (await meetings.listMeetings({ includeDeleted: false })).filter((meeting) => meetingVisibleTo(req.auth, meeting));
    const today = localDateKey();
    const users = req.auth.role === 'ADMIN' ? await auth.listUsers() : [];
    const since = Date.now() - 24 * 60 * 60_000;
    const recentErrors = req.auth.role === 'ADMIN'
      ? (await audit.listEvents({ limit: 1_000 })).filter((item) => item.action === 'AUTH_LOGIN_FAILED' && new Date(item.timestamp).getTime() >= since).length
      : null;
    const [livekit, storage, transcription] = await Promise.all([livekitProbe(), storageProbe(), transcriptionStatus()]);
    const recordingAvailable = recordingConfigured && livekit.available === true && storage.available === true;
    res.json({
      meetingsToday: allMeetings.filter((meeting) => meeting.status === 'SCHEDULED' && localDateKey(meeting.scheduledAt) === today).length,
      activeMeetings: livekit.available ? allMeetings.filter((meeting) => meeting.status === 'LIVE' && meeting.livekitConfirmedAt).length : 0,
      nextMeeting: allMeetings.filter((meeting) => meeting.scheduledAt && new Date(meeting.scheduledAt) >= new Date() && !['CANCELLED', 'COMPLETED', 'ARCHIVED'].includes(meeting.status)).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))[0] || null,
      activeCredentials: users.filter((user) => user.active).length,
      recentErrors,
      app: { name: config.appName, environment: config.appEnv, displayEnvironment: config.appDisplayEnv, version: config.appVersion },
      storage,
      livekit,
      recordingConfigured,
      recordingAvailable,
      transcriptionConfigured: transcription.configured,
      transcriptionAvailable: transcription.available,
      transcriptionProvider: config.transcriptionProvider,
      environment: config.appEnv,
      displayEnvironment: config.appDisplayEnv,
      version: config.appVersion,
      security: { secureCookies: config.cookieSecure, openDevRooms: config.allowOpenDevRooms },
      missingConfiguration: [
        LIVEKIT_API_KEY === 'devkey' ? 'LIVEKIT_API_KEY' : null,
        !storageConfigured ? 'S3/R2' : null,
        !recordingConfigured ? 'RECORDING_S3_*' : null,
        !transcriptionProvider.isConfigured() ? 'TRANSCRIPTION_*' : null,
      ].filter(Boolean),
    });
  }));

  const healthRouter = createHealthRouter({ livekitProbe, storageProbe, transcriptionStatus, recordingConfigured });
  app.use('/', healthRouter);
  app.use('/api', healthRouter);

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint no encontrado', code: 'NOT_FOUND', requestId: _req.requestId || null }));
  app.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError) {
      const message = error.code === 'LIMIT_FILE_SIZE' ? 'El archivo supera el tamaño permitido' : 'No se pudo procesar el archivo';
      return res.status(400).json({ error: message, code: error.code });
    }
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'La solicitud supera el tamaño permitido', code: 'PAYLOAD_TOO_LARGE' });
    if (error instanceof SyntaxError && error.status === 400 && 'body' in error) return res.status(400).json({ error: 'JSON no válido', code: 'INVALID_JSON' });
    const status = error instanceof AppError ? error.status : 500;
    if (status >= 500 && !(error instanceof AppError)) log('error', 'request_error', { requestId: _req.requestId, method: _req.method, path: safeRequestPath(_req.path), errorName: error.name, errorCode: error.code });
    return res.status(status).json({
      error: error instanceof AppError ? error.message : status >= 500 ? 'Ocurrió un error interno' : error.message,
      code: error.code || 'INTERNAL_ERROR',
      requestId: _req.requestId || null,
    });
  });

  app.locals.services = services;
  app.locals.livekitProbe = livekitProbe;
  app.locals.storageProbe = storageProbe;
  app.locals.rateLimiters = { loginLimiter, meetingLimiter, transcriptionLimiter, chatLimiter, interactionLimiter };
  return app;
}

module.exports = { canManageMeeting, createApp, localDateKey, publishPermission, recordingConfigured, recordingStateFromEgress, safeRequestPath };
