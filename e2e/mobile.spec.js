const { test, expect } = require('@playwright/test');

const admin = { username: 'rootadmin', password: 'Bootstrap-password-123' };
const fakeLiveKit = `
(() => {
  const events = {
    DataReceived: 'dataReceived', ParticipantPermissionsChanged: 'permissionsChanged',
    ParticipantConnected: 'participantConnected', ParticipantDisconnected: 'participantDisconnected',
    TrackPublished: 'trackPublished', TrackUnpublished: 'trackUnpublished', TrackSubscribed: 'trackSubscribed',
    TrackUnsubscribed: 'trackUnsubscribed', TrackMuted: 'trackMuted', TrackUnmuted: 'trackUnmuted',
    LocalTrackPublished: 'localTrackPublished', LocalTrackUnpublished: 'localTrackUnpublished',
    ParticipantMetadataChanged: 'participantMetadataChanged', ParticipantNameChanged: 'participantNameChanged',
    Reconnecting: 'reconnecting', Reconnected: 'reconnected', Disconnected: 'disconnected',
    ConnectionQualityChanged: 'connectionQualityChanged'
  };
  const sources = { Camera: 'camera', Microphone: 'microphone', ScreenShare: 'screen_share', ScreenShareAudio: 'screen_share_audio' };
  function track(kind) {
    return { kind, mediaStreamTrack: { readyState: 'live', addEventListener() {} }, attach(el) { return el || document.createElement(kind === 'audio' ? 'audio' : 'video'); }, detach() { return []; }, setVolume() {}, setProcessor: async () => {} };
  }
  class Participant {
    constructor() { this.identity = 'mobile-e2e'; this.name = 'Mobile E2E'; this.isLocal = true; this.permissions = { canPublish: true, canSubscribe: true, canPublishData: true }; this._publications = new Map(); }
    getTrackPublication(source) { return this._publications.get(source); }
    async setMicrophoneEnabled(enabled) { enabled ? this._publications.set(sources.Microphone, { source: sources.Microphone, isMuted: false, track: track('audio') }) : this._publications.delete(sources.Microphone); }
    async setCameraEnabled(enabled) { enabled ? this._publications.set(sources.Camera, { source: sources.Camera, isMuted: false, track: track('video') }) : this._publications.delete(sources.Camera); }
    async setScreenShareEnabled(enabled) { enabled ? this._publications.set(sources.ScreenShare, { source: sources.ScreenShare, isMuted: false, track: track('video') }) : this._publications.delete(sources.ScreenShare); }
  }
  class Room {
    constructor() { this.localParticipant = new Participant(); this.remoteParticipants = new Map(); this._handlers = new Map(); }
    on(event, handler) { if (!this._handlers.has(event)) this._handlers.set(event, new Set()); this._handlers.get(event).add(handler); return this; }
    off(event, handler) { this._handlers.get(event)?.delete(handler); return this; }
    async connect() { this._handlers.get(events.ConnectionQualityChanged)?.forEach((fn) => fn('excellent', this.localParticipant)); }
    async disconnect() { this._handlers.get(events.Disconnected)?.forEach((fn) => fn('client')); }
    async switchActiveDevice() {}
  }
  window.LivekitClient = { Room, RoomEvent: events, Track: { Source: sources } };
})();
`;

async function installLiveKitMock(page) {
  await page.route('**/vendor/livekit-client/livekit-client.umd.js', (route) => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: fakeLiveKit,
  }));
}

async function login(page) {
  await page.goto('/index.html');
  await page.locator('#username').fill(admin.username);
  await page.locator('#password').fill(admin.password);
  await page.getByRole('button', { name: 'Acceder al panel' }).click();
  await expect(page.getByRole('heading', { name: 'Resumen' })).toBeVisible();
}

async function createMeetingViaApi(page) {
  return page.evaluate(async () => {
    const me = await fetch('/api/auth/me', { credentials: 'same-origin' }).then((r) => r.json());
    const response = await fetch('/api/meetings', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrfToken },
      body: JSON.stringify({
        title: `E2E Móvil ${Date.now()}`,
        trainerName: 'Capacitadora móvil',
        scheduledAt: new Date(Date.now() + 60_000).toISOString(),
        durationMinutes: 45,
        type: 'WEBINAR',
        capacity: 20,
        viewerAccessMode: 'INVITATION',
        panelistAccessMode: 'INVITATION',
        allowChat: true,
        allowRaiseHand: true,
        allowRecording: false,
      }),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
}

async function launchMeetingViaApi(page, room) {
  return page.evaluate(async ({ room }) => {
    const me = await fetch('/api/auth/me', { credentials: 'same-origin' }).then((r) => r.json());
    const response = await fetch(`/api/meetings/${encodeURIComponent(room)}/launch`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrfToken },
      body: JSON.stringify({}),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }, { room });
}

async function enterPrejoin(page) {
  await expect(page.getByRole('heading', { name: /Antes de entrar|Sala de preparación/ })).toBeVisible();
  await page.getByLabel('Nombre visible').fill('Host móvil E2E');
  await page.getByLabel(/He leído el aviso de privacidad/).check();
  await expect(page.getByRole('button', { name: 'Entrar a la reunión' })).toBeEnabled();
  await page.getByRole('button', { name: 'Entrar a la reunión' }).click();
  await expect(page.locator('#connectionStatus')).toHaveText('Conectado');
}

test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await installLiveKitMock(page);
});

test('dashboard y sala mantienen navegación y controles clave en 390px', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('button', { name: 'Abrir navegación' })).toBeVisible();
  await page.getByRole('button', { name: 'Abrir navegación' }).click();
  await expect(page.locator('#dashboardSidebar')).toBeVisible();
  await page.getByRole('button', { name: 'Reuniones' }).click();
  await expect(page.getByRole('heading', { name: 'Reuniones' })).toBeVisible();

  const created = await createMeetingViaApi(page);
  await page.goto('/dashboard.html');
  await page.getByRole('button', { name: 'Abrir navegación' }).click();
  await page.getByRole('button', { name: 'Reuniones' }).click();
  const meeting = created.meeting || created;
  const card = page.locator('.meeting-card').filter({ hasText: meeting.title }).first();
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: 'Iniciar' })).toBeVisible();
  const launched = await launchMeetingViaApi(page, meeting.room);
  await page.goto(launched.redirect);
  await enterPrejoin(page);

  await expect(page.locator('#btnMic')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Salir de la reunión' })).toBeVisible();
  await page.getByRole('button', { name: 'Más opciones' }).click();
  await expect(page.getByRole('heading', { name: 'Más opciones' })).toBeVisible();
});
