require('dotenv').config({ quiet: true });
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { PutObjectCommand, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { AccessToken, RoomServiceClient, EgressClient, EncodedFileType } = require('livekit-server-sdk');
const { s3, storageConfigured, bucket } = require('./s3');
const roomRegistry = require('./rooms');
const auth = require('./auth');
const meetings = require('./meetings');

const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'devkey';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'secret';
const LIVEKIT_WS_URL = process.env.LIVEKIT_WS_URL || 'ws://localhost:7880';
// Egress talks to the server over its HTTP API, so http(s):// instead of ws(s)://
const LIVEKIT_HTTP_URL = LIVEKIT_WS_URL.replace(/^ws/, 'http');
const PORT = process.env.PORT || 3000;

const recordingConfigured = Boolean(
  process.env.RECORDING_S3_ACCESS_KEY && process.env.RECORDING_S3_SECRET_KEY && process.env.RECORDING_S3_BUCKET
);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
// Serve the LiveKit client SDK from node_modules instead of an external CDN.
app.use('/vendor/livekit-client', express.static(path.join(__dirname, '..', 'node_modules', 'livekit-client', 'dist')));

const roomService = new RoomServiceClient(LIVEKIT_HTTP_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
const egressClient = new EgressClient(LIVEKIT_HTTP_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Registers a room with an optional host code (required to join as panelist)
// and/or viewer password. Rooms that are never registered stay open.
app.post('/api/rooms', async (req, res) => {
  const { room, hostCode, viewerPassword } = req.body || {};
  if (!room) return res.status(400).json({ error: 'room es requerido' });
  try {
    const config = await roomRegistry.createRoom(String(room), { hostCode, viewerPassword });
    res.json({ room, requiresHostCode: Boolean(config.hostCode), requiresViewerPassword: Boolean(config.viewerPassword) });
  } catch (err) {
    console.error('rooms/create error', err);
    res.status(500).json({ error: 'No se pudo crear la sala' });
  }
});

// Lets the join screen know whether to show a code/password field before
// it even tries to fetch a token.
app.get('/api/rooms/:room', async (req, res) => {
  const config = await roomRegistry.getRoom(req.params.room);
  res.json({
    exists: Boolean(config),
    requiresHostCode: Boolean(config?.hostCode),
    requiresViewerPassword: Boolean(config?.viewerPassword),
  });
});

// Issues a LiveKit access token scoped to a role.
// presenter: can publish camera/screen-share and send chat data (multiple people may hold this role at once).
// viewer: can only subscribe to tracks and send chat data.
app.get('/api/token', async (req, res) => {
  const room = String(req.query.room || 'webinar-demo');
  const identity = String(req.query.identity || `user-${Math.random().toString(36).slice(2, 8)}`);
  const role = req.query.role === 'presenter' ? 'presenter' : 'viewer';
  const code = req.query.code ? String(req.query.code) : undefined;

  const access = await roomRegistry.checkAccess(room, role, code);
  if (!access.allowed) {
    return res.status(403).json({ error: 'Código o contraseña incorrectos', requiresCode: true });
  }

  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    name: identity,
  });

  at.addGrant({
    room,
    roomJoin: true,
    canPublish: role === 'presenter',
    canPublishData: true,
    canSubscribe: true,
  });

  const token = await at.toJwt();
  res.json({ token, wsUrl: LIVEKIT_WS_URL, room, identity, role, recordingConfigured });
});

// Confirms the requesting identity actually holds publish rights in the room
// before letting it control recording, since anyone can call this HTTP endpoint.
async function assertIsPresenter(room, identity) {
  const participants = await roomService.listParticipants(room);
  const participant = participants.find((p) => p.identity === identity);
  return Boolean(participant?.permission?.canPublish);
}

// Grants a viewer publish rights (camera/mic) after a panelist approves their
// raised hand. Only someone who already holds canPublish in the room may do this.
app.post('/api/participants/promote', async (req, res) => {
  const { room, panelistIdentity, targetIdentity } = req.body || {};
  if (!room || !panelistIdentity || !targetIdentity) {
    return res.status(400).json({ error: 'room, panelistIdentity y targetIdentity son requeridos' });
  }
  try {
    const isPresenter = await assertIsPresenter(room, panelistIdentity);
    if (!isPresenter) return res.status(403).json({ error: 'Solo un panelista puede conceder la palabra' });

    await roomService.updateParticipant(room, targetIdentity, {
      permission: { canPublish: true, canSubscribe: true, canPublishData: true },
    });
    res.json({ promoted: true });
  } catch (err) {
    console.error('participants/promote error', err);
    res.status(500).json({ error: 'No se pudo conceder la palabra' });
  }
});

// Reverses a promotion — back to view-only.
app.post('/api/participants/demote', async (req, res) => {
  const { room, panelistIdentity, targetIdentity } = req.body || {};
  if (!room || !panelistIdentity || !targetIdentity) {
    return res.status(400).json({ error: 'room, panelistIdentity y targetIdentity son requeridos' });
  }
  try {
    const isPresenter = await assertIsPresenter(room, panelistIdentity);
    if (!isPresenter) return res.status(403).json({ error: 'Solo un panelista puede quitar la palabra' });

    await roomService.updateParticipant(room, targetIdentity, {
      permission: { canPublish: false, canSubscribe: true, canPublishData: true },
    });
    res.json({ demoted: true });
  } catch (err) {
    console.error('participants/demote error', err);
    res.status(500).json({ error: 'No se pudo quitar la palabra' });
  }
});

app.post('/api/recording/start', async (req, res) => {
  if (!recordingConfigured) {
    return res.status(400).json({ error: 'La grabación no está configurada (faltan credenciales S3 en el servidor).' });
  }
  const { room, identity } = req.body || {};
  if (!room || !identity) return res.status(400).json({ error: 'room e identity son requeridos' });

  try {
    const isPresenter = await assertIsPresenter(room, identity);
    if (!isPresenter) return res.status(403).json({ error: 'Solo el presentador puede iniciar la grabación' });

    const existing = await egressClient.listEgress({ roomName: room, active: true });
    if (existing.length > 0) {
      return res.json({ egressId: existing[0].egressId, alreadyRunning: true });
    }

    const filepath = `recordings/${room}/${Date.now()}`;
    const info = await egressClient.startRoomCompositeEgress(
      room,
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

    res.json({ egressId: info.egressId, alreadyRunning: false });
  } catch (err) {
    console.error('recording/start error', err);
    res.status(500).json({ error: 'No se pudo iniciar la grabación' });
  }
});

app.post('/api/recording/stop', async (req, res) => {
  const { egressId } = req.body || {};
  if (!egressId) return res.status(400).json({ error: 'egressId es requerido' });
  try {
    await egressClient.stopEgress(egressId);
    res.json({ stopped: true });
  } catch (err) {
    console.error('recording/stop error', err);
    res.status(500).json({ error: 'No se pudo detener la grabación' });
  }
});

// Chat file sharing: uploads go straight to R2/S3 under chat-uploads/{room}/...
// and we hand back a time-limited signed URL instead of making the bucket public.
app.post('/api/chat/upload', upload.single('file'), async (req, res) => {
  if (!storageConfigured) {
    return res.status(400).json({ error: 'El almacenamiento no está configurado en el servidor.' });
  }
  const room = String(req.body?.room || 'webinar-demo');
  if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });

  const safeName = req.file.originalname.replace(/[^\w.\-() ]/g, '_');
  const key = `chat-uploads/${room}/${Date.now()}-${safeName}`;

  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      })
    );
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 60 * 60 * 24 * 7 });
    res.json({ url, filename: req.file.originalname, size: req.file.size, mimetype: req.file.mimetype });
  } catch (err) {
    console.error('chat/upload error', err);
    res.status(500).json({ error: 'No se pudo subir el archivo' });
  }
});

// Lists recordings for a room from the bucket, with a signed download URL for each.
// Organizer-only — recordings can contain sensitive session content.
app.get('/api/recordings', auth.requireAuth, async (req, res) => {
  if (!storageConfigured) {
    return res.status(400).json({ error: 'El almacenamiento no está configurado en el servidor.' });
  }
  const room = req.query.room ? String(req.query.room) : null;
  const prefix = room ? `recordings/${room}/` : 'recordings/';

  try {
    const listing = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
    const items = await Promise.all(
      (listing.Contents || [])
        .filter((obj) => obj.Key.endsWith('.mp4'))
        .map(async (obj) => ({
          key: obj.Key,
          size: obj.Size,
          lastModified: obj.LastModified,
          url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: obj.Key }), { expiresIn: 60 * 60 * 24 }),
        }))
    );
    items.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
    res.json({ items });
  } catch (err) {
    console.error('recordings list error', err);
    res.status(500).json({ error: 'No se pudieron listar las grabaciones' });
  }
});

// --- Organizer auth ---
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username y password son requeridos' });
  const ok = await auth.verifyLogin(String(username), String(password));
  if (!ok) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  res.json({ token: auth.signSession(String(username)), username });
});

app.get('/api/auth/me', auth.requireAuth, (req, res) => {
  res.json({ username: req.username });
});

// Creates additional organizer credentials. Any logged-in organizer can do
// this for now — there's no separate "admin-only" tier yet.
app.post('/api/auth/users', auth.requireAuth, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username y password son requeridos' });
  if (String(password).length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  try {
    const user = await auth.createUser(String(username), String(password));
    res.json(user);
  } catch (err) {
    console.error('auth/users error', err);
    res.status(500).json({ error: err.message || 'No se pudo crear el usuario' });
  }
});

app.get('/api/auth/users', auth.requireAuth, async (req, res) => {
  res.json({ users: await auth.listUsers() });
});

// --- Scheduled meetings (organizer dashboard) ---
app.post('/api/meetings', auth.requireAuth, async (req, res) => {
  const { title, room, scheduledAt } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title es requerido' });

  const roomName = String(room || title)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || `sala-${Date.now()}`;

  const hostCode = crypto.randomBytes(4).toString('hex');
  const viewerPassword = crypto.randomBytes(4).toString('hex');

  try {
    await roomRegistry.createRoom(roomName, { hostCode, viewerPassword });
    const record = await meetings.createMeeting({
      room: roomName,
      title: String(title),
      scheduledAt: scheduledAt || null,
      hostCode,
      viewerPassword,
      createdBy: req.username,
    });
    res.json(record);
  } catch (err) {
    console.error('meetings/create error', err);
    res.status(500).json({ error: 'No se pudo crear la reunión' });
  }
});

app.get('/api/meetings', auth.requireAuth, async (req, res) => {
  try {
    res.json({ items: await meetings.listMeetings() });
  } catch (err) {
    console.error('meetings/list error', err);
    res.status(500).json({ error: 'No se pudieron listar las reuniones' });
  }
});

app.patch('/api/meetings/:room', auth.requireAuth, async (req, res) => {
  const { title, scheduledAt } = req.body || {};
  try {
    const updated = await meetings.updateMeeting(req.params.room, {
      ...(title !== undefined ? { title } : {}),
      ...(scheduledAt !== undefined ? { scheduledAt } : {}),
    });
    res.json(updated);
  } catch (err) {
    res.status(404).json({ error: err.message || 'No se pudo actualizar la reunión' });
  }
});

app.delete('/api/meetings/:room', auth.requireAuth, async (req, res) => {
  try {
    await meetings.deleteMeeting(req.params.room);
    await roomRegistry.revokeRoom(req.params.room);
    res.json({ deleted: true });
  } catch (err) {
    console.error('meetings/delete error', err);
    res.status(500).json({ error: 'No se pudo eliminar la reunión' });
  }
});

app.listen(PORT, () => {
  console.log(`Token server listening on http://localhost:${PORT}`);
  console.log(`LiveKit: ${LIVEKIT_WS_URL} | Recording configured: ${recordingConfigured}`);
});
