require('dotenv').config({ quiet: true });
const path = require('path');
const express = require('express');
const { AccessToken, RoomServiceClient, EgressClient, EncodedFileType } = require('livekit-server-sdk');

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

// Issues a LiveKit access token scoped to a role.
// presenter: can publish camera/screen-share and send chat data.
// viewer: can only subscribe to tracks and send chat data.
app.get('/api/token', async (req, res) => {
  const room = String(req.query.room || 'webinar-demo');
  const identity = String(req.query.identity || `user-${Math.random().toString(36).slice(2, 8)}`);
  const role = req.query.role === 'presenter' ? 'presenter' : 'viewer';

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

app.listen(PORT, () => {
  console.log(`Token server listening on http://localhost:${PORT}`);
  console.log(`LiveKit: ${LIVEKIT_WS_URL} | Recording configured: ${recordingConfigured}`);
});
