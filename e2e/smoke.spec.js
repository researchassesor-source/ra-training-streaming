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
    constructor(identity = 'local-e2e', name = 'E2E') {
      this.identity = identity; this.name = name; this.isLocal = true; this.permissions = { canPublish: true, canSubscribe: true, canPublishData: true };
      this._publications = new Map();
    }
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

test.describe.configure({ mode: 'serial' });

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

async function createMeetingViaApi(page, suffix = Date.now()) {
  return page.evaluate(async ({ suffix }) => {
    const me = await fetch('/api/auth/me', { credentials: 'same-origin' }).then((r) => r.json());
    const response = await fetch('/api/meetings', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrfToken },
      body: JSON.stringify({
        title: `E2E Sala ${suffix}`,
        trainerName: 'Capacitador E2E',
        scheduledAt: new Date(Date.now() + 60_000).toISOString(),
        durationMinutes: 45,
        type: 'WEBINAR',
        capacity: 30,
        viewerAccessMode: 'INVITATION',
        panelistAccessMode: 'INVITATION',
        allowChat: true,
        allowRaiseHand: true,
        allowRecording: false,
      }),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }, { suffix });
}

async function createInvitationViaApi(page, room, meetingRole = 'ATTENDEE') {
  return page.evaluate(async ({ room, meetingRole }) => {
    const me = await fetch('/api/auth/me', { credentials: 'same-origin' }).then((r) => r.json());
    const response = await fetch(`/api/meetings/${encodeURIComponent(room)}/invitations`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrfToken },
      body: JSON.stringify({ meetingRole, singleUse: false, expiresInMinutes: 120 }),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }, { room, meetingRole });
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

async function enterPrejoin(page, name = 'Persona E2E') {
  await expect(page.getByRole('heading', { name: /Antes de entrar|Sala de preparación/ })).toBeVisible();
  await page.getByLabel('Nombre visible').fill(name);
  await page.getByLabel(/He leído el aviso de privacidad/).check();
  await expect(page.getByRole('button', { name: 'Entrar a la reunión' })).toBeEnabled();
  await page.getByRole('button', { name: 'Entrar a la reunión' }).click();
  await expect(page.locator('#connectionStatus')).toHaveText('Conectado');
}

test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await installLiveKitMock(page);
});

test('login incorrecto muestra error genérico y login correcto carga dashboard', async ({ page }) => {
  await page.goto('/index.html');
  await page.locator('#username').fill('usuario-e2e');
  await page.locator('#password').fill('incorrecta');
  await page.getByRole('button', { name: 'Acceder al panel' }).click();
  await expect(page.getByRole('alert')).toContainText(/No fue posible|credenciales|contraseña|solicitud/i);
  await expect(page.locator('#password')).toHaveAttribute('aria-invalid', 'false');
  await login(page);
  await expect(page.locator('#dashboardSidebar')).toBeVisible();
});

test('dashboard crea, valida, edita y comparte una reunión', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Nueva reunión' }).first().click();
  await page.getByRole('button', { name: 'Guardar reunión' }).click();
  await expect(page.getByRole('alert')).toContainText('título');
  await expect(page.locator('#meetingTitle')).toBeFocused();

  const title = `E2E UI ${Date.now()}`;
  await page.locator('#meetingTitle').fill(title);
  await page.locator('#meetingTrainer').fill('Capacitadora E2E');
  await page.locator('#meetingDuration').fill('45');
  await page.getByRole('button', { name: 'Guardar reunión' }).click();
  await expect(page.getByText('Reunión creada.')).toBeVisible();
  await page.getByRole('button', { name: 'Reuniones' }).click();
  await expect(page.locator('.meeting-card').filter({ hasText: title }).first()).toBeVisible();

  const card = page.locator('.meeting-card').filter({ hasText: title }).first();
  await card.getByRole('button', { name: 'Editar' }).click();
  await page.locator('#meetingTitle').fill(`${title} editada`);
  await page.getByRole('button', { name: 'Guardar reunión' }).click();
  await expect(page.getByText('Reunión actualizada.')).toBeVisible();
  await page.getByRole('button', { name: 'Reuniones' }).click();

  const edited = page.locator('.meeting-card').filter({ hasText: `${title} editada` }).first();
  await edited.getByText('Más acciones').click();
  await edited.getByRole('button', { name: /Preparar acceso de asistente/i }).click();
  await expect(page.getByRole('dialog').filter({ hasText: 'Invitación profesional' })).toBeVisible();
  await expect(page.locator('#invitationRole')).toContainText('Asistente');
  await page.getByRole('button', { name: 'Copiar enlace' }).click();
  await expect(page.getByText('Enlace privado copiado.')).toBeVisible();
});

test('participant happy path: invitation, prejoin, room, chat, Q&A, hand and leave', async ({ page, context }) => {
  await login(page);
  const created = await createMeetingViaApi(page, `flow-${Date.now()}`);
  const meeting = created.meeting || created;
  await page.goto('/dashboard.html');
  await page.getByRole('button', { name: 'Reuniones' }).click();
  await expect(page.locator('.meeting-card').filter({ hasText: meeting.title }).first().getByRole('button', { name: 'Iniciar' })).toBeVisible();
  const launched = await launchMeetingViaApi(page, meeting.room);
  await page.goto(launched.redirect);
  await enterPrejoin(page, 'Host E2E');
  await page.getByRole('button', { name: 'Más opciones' }).click();
  await expect(page.getByRole('button', { name: /Finalizar para todos/i })).toBeVisible();
  await page.getByRole('button', { name: 'Cerrar opciones' }).click();

  await page.goto('/dashboard.html');
  const invitation = await createInvitationViaApi(page, meeting.room, 'ATTENDEE');
  const attendee = await context.newPage();
  await installLiveKitMock(attendee);
  await attendee.goto(invitation.url);
  await enterPrejoin(attendee, 'Asistente E2E');
  await attendee.getByRole('button', { name: 'Más opciones' }).click();
  await expect(attendee.getByRole('button', { name: /Iniciar grabación/i })).toBeHidden();
  await expect(attendee.getByRole('button', { name: /Finalizar para todos/i })).toBeHidden();
  await attendee.getByRole('button', { name: 'Cerrar opciones' }).click();

  await attendee.locator('#chatInput').fill('Hola desde E2E https://example.com');
  await attendee.getByRole('button', { name: 'Enviar' }).click();
  await expect(attendee.getByText('Enviado')).toBeVisible();

  await attendee.locator('#chatKind').selectOption('question');
  await attendee.locator('#chatInput').fill('¿Pregunta E2E?');
  await attendee.getByRole('button', { name: 'Enviar' }).click();
  await expect(attendee.getByText('Pregunta enviada')).toBeVisible();

  await attendee.getByRole('button', { name: /Mano/ }).click();
  await expect(attendee.getByRole('button', { name: /Cancelar|Mano/ })).toBeVisible();

  await attendee.getByRole('button', { name: /Salir de la reunión/ }).click();
  await expect(attendee.getByRole('heading', { name: 'Iniciar sesión' })).toBeVisible();
  await attendee.close();
});
