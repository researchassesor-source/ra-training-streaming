const crypto = require('crypto');
const { WebhookReceiver } = require('livekit-server-sdk');
const { config } = require('./config');
const db = require('./db');
const localStore = require('./local-store');
const meetings = require('./meetings');
const attendance = require('./attendance');
const audit = require('./audit');
const { AppError } = require('./http-utils');

const memoryEvents = new Set();
let lastProcessingError = null;

function parseJson(rawBody) {
  try {
    const parsed = JSON.parse(String(rawBody || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function safePayload(payload) {
  const clean = {
    event: payload.event || payload.type || null,
    id: payload.id || payload.eventId || payload.event_id || null,
    room: payload.room ? { sid: payload.room.sid || null, name: payload.room.name || null } : null,
    participant: payload.participant ? {
      sid: payload.participant.sid || null,
      identity: payload.participant.identity || null,
      name: payload.participant.name || null,
      metadata: payload.participant.metadata || null,
    } : null,
    createdAt: payload.createdAt || payload.created_at || payload.createdAtNs || null,
  };
  return clean;
}

function parseMetadata(participant) {
  try {
    const value = JSON.parse(participant?.metadata || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function eventTimestamp(payload) {
  const value = payload.createdAt || payload.created_at || payload.createdAtNs;
  if (typeof value === 'number' || /^\d+$/.test(String(value || ''))) {
    const numeric = Number(value);
    const millis = numeric > 10_000_000_000 ? Math.floor(numeric / 1_000_000) : numeric * 1000;
    const date = new Date(millis);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  if (value) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

function eventId(payload, rawBody) {
  const explicit = payload.id || payload.eventId || payload.event_id || payload.webhookId || payload.webhook_id;
  if (explicit) return String(explicit).slice(0, 200);
  const room = payload.room?.sid || payload.room?.name || '';
  const participant = payload.participant?.sid || payload.participant?.identity || '';
  const at = payload.createdAt || payload.created_at || payload.createdAtNs || '';
  return crypto.createHash('sha256').update(`${payload.event || ''}\n${room}\n${participant}\n${at}\n${rawBody}`).digest('hex');
}

async function domainEffects(payload, eventAt) {
  const event = payload.event;
  if (!['room_started', 'room_finished', 'participant_joined', 'participant_left'].includes(event)) return { ignored: true };
  const roomName = payload.room?.name;
  if (!roomName) return { ignored: true };
  const meeting = await meetings.getMeeting(roomName);
  if (!meeting || meeting.deletedAt) return { ignored: true };

  if (event === 'participant_joined' || event === 'participant_left') {
    const participant = payload.participant || {};
    const metadata = parseMetadata(participant);
    const record = await attendance.applyLiveKitEvent({
      event,
      room: roomName,
      meeting,
      participantIdentity: participant.identity || null,
      participantKey: metadata.participantKey || participant.identity || null,
      participantName: participant.name || participant.identity || 'Participante',
      eventAt,
    });
    if (record) {
      await audit.logEvent({
        actor: participant.identity || 'livekit',
        action: event === 'participant_joined' ? 'PARTICIPANT_JOINED' : 'PARTICIPANT_LEFT',
        target: meeting.id,
        room: roomName,
        metadata: { source: 'livekit-webhook', seriesId: meeting.seriesId || null, participantKey: metadata.participantKey || null },
      });
    }
    return { attendance: Boolean(record) };
  }

  await audit.logEvent({
    actor: 'livekit',
    action: event === 'room_started' ? 'ROOM_CONNECTED' : 'ROOM_ENDED',
    target: meeting.id,
    room: roomName,
    metadata: { source: 'livekit-webhook', operationalOnly: true },
  });
  return { operational: true };
}

async function processDurably({ payload, rawBody, eventAt, id }) {
  if (!db.usingPostgres()) {
    if (memoryEvents.has(id)) return { duplicate: true };
    const effects = await domainEffects(payload, eventAt);
    memoryEvents.add(id);
    return { duplicate: false, effects };
  }

  return localStore.withTransaction(async () => {
    const client = localStore.currentClient();
    const inserted = await client.query(
      `INSERT INTO livekit_webhook_events (event_id, event_type, room_name, participant_identity, event_at, payload, status)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'PROCESSING')
       ON CONFLICT DO NOTHING`,
      [id, payload.event || '', payload.room?.name || null, payload.participant?.identity || null, eventAt, JSON.stringify(safePayload(payload))]
    );
    if (inserted.rowCount === 0) return { duplicate: true };
    const effects = await domainEffects(payload, eventAt);
    await client.query(
      `UPDATE livekit_webhook_events
       SET status = $2, processed_at = now()
       WHERE event_id = $1`,
      [id, effects.ignored ? 'IGNORED' : 'PROCESSED']
    );
    return { duplicate: false, effects };
  });
}

async function receiveLiveKitWebhook(rawBody, authorization, { skipAuth = false } = {}) {
  const receiver = new WebhookReceiver(config.livekitApiKey, config.livekitApiSecret);
  let event;
  try {
    event = await receiver.receive(String(rawBody || ''), authorization, skipAuth);
  } catch (error) {
    throw new AppError(401, 'Firma LiveKit inválida', 'LIVEKIT_WEBHOOK_INVALID_SIGNATURE');
  }
  const payload = { ...parseJson(rawBody), event: event.event || parseJson(rawBody).event };
  const eventAt = eventTimestamp(payload);
  const id = eventId(payload, rawBody);
  try {
    return await processDurably({ payload, rawBody, eventAt, id });
  } catch (error) {
    lastProcessingError = { name: error.name, code: error.code || null, event: payload.event || null };
    throw error;
  }
}

function diagnostics() {
  return { lastProcessingError };
}

function resetMemoryForTest() {
  memoryEvents.clear();
  lastProcessingError = null;
}

module.exports = {
  diagnostics,
  eventId,
  eventTimestamp,
  receiveLiveKitWebhook,
  resetMemoryForTest,
  safePayload,
};
