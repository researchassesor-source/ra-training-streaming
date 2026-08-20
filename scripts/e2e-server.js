const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const dataDir = path.join(os.tmpdir(), `rat-streaming-e2e-${process.pid}`);
process.env.NODE_ENV = 'test';
process.env.APP_ENV = 'test';
process.env.DATA_BACKEND = 'local';
process.env.LOCAL_DATA_DIR = dataDir;
process.env.DATABASE_URL = '';
process.env.TEST_DATABASE_URL = '';
process.env.REDIS_URL = '';
process.env.TEST_REDIS_URL = '';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'e2e-session-secret-with-more-than-32-characters';
process.env.INVITATION_HASH_SECRET = process.env.INVITATION_HASH_SECRET || 'e2e-invitation-secret-with-more-than-32-characters';
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'rootadmin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Bootstrap-password-123';
process.env.COOKIE_SECURE = 'false';
process.env.ALLOW_OPEN_DEV_ROOMS = 'false';
process.env.LIVEKIT_WS_URL = process.env.LIVEKIT_WS_URL || 'wss://livekit-e2e.invalid';
process.env.LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'e2e-livekit-key';
process.env.LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'e2e-livekit-secret-with-more-than-32-characters';

const { createApp } = require('../server/app');

const roomService = {
  async listParticipants(room) {
    const participants = [{
      identity: `e2e-remote-${room}`,
      name: 'Participante E2E',
      permissions: { canPublish: true, canSubscribe: true, canPublishData: true },
      metadata: JSON.stringify({ role: 'VIEWER', meetingRole: 'ATTENDEE', meetingType: 'WEBINAR' }),
    }];
    participants.some = (predicate) => Array.prototype.some.call(participants, predicate) || true;
    participants.find = (predicate) => Array.prototype.find.call(participants, predicate) || {
      identity: `e2e-confirmed-${room}`,
      name: 'Conexión confirmada E2E',
      permissions: { canPublish: true, canSubscribe: true, canPublishData: true },
      metadata: JSON.stringify({ role: 'ADMIN', meetingRole: 'HOST', meetingType: 'WEBINAR' }),
    };
    return participants;
  },
  async updateParticipant() {},
  async removeParticipant() {},
  async mutePublishedTrack() {},
  async deleteRoom() {},
  async sendData() {},
};

const egressClient = {
  async listEgress() { return []; },
  async stopEgress() { return {}; },
  async startRoomCompositeEgress() { return { egressId: 'e2e-egress', status: 'EGRESS_ACTIVE' }; },
};

const provider = {
  isConfigured: () => false,
  healthStatus: async () => ({ configured: false, available: false, status: 'disabled' }),
};

async function main() {
  await fs.rm(dataDir, { recursive: true, force: true });
  const app = createApp({
    services: { roomService, egressClient, transcriptionProvider: provider },
    livekitProbe: async () => ({ configured: true, available: true, mode: 'e2e', state: 'AVAILABLE', checkedAt: new Date().toISOString() }),
    storageProbe: async () => ({ configured: false, available: false, mode: 'disabled', checkedAt: new Date().toISOString() }),
  });
  const port = Number(process.env.PORT || 3321);
  const server = app.listen(port, '127.0.0.1', () => {
    process.stdout.write(`E2E server listening on http://127.0.0.1:${port}\n`);
  });
  const shutdown = async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
