const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  facebookStateFromEgress,
  isRecordingEgress,
  isStreamingEgress,
  validateFacebookDestination,
} = require('../server/facebook-live');

test('Facebook destination accepts only bounded RTMP/RTMPS server and key values', () => {
  const secure = validateFacebookDestination('rtmps://live-api-s.facebook.com:443/rtmp/', 'stream-key_123');
  assert.equal(secure.output.protocol, 1);
  assert.deepEqual(secure.output.urls, ['rtmps://live-api-s.facebook.com:443/rtmp/stream-key_123']);
  assert.deepEqual(validateFacebookDestination('rtmp://example.test/live', 'stream-key_456').output.urls, ['rtmp://example.test/live/stream-key_456']);
  for (const invalid of ['https://facebook.example/live', 'ftp://facebook.example/live', 'file:///tmp/live', 'javascript:alert(1)']) {
    assert.throws(() => validateFacebookDestination(invalid, 'stream-key_123'), /Solo se permiten|servidor RTMP/);
  }
  assert.throws(() => validateFacebookDestination('rtmps://example.test/live?secret=value', 'stream-key_123'), /Solo se permiten/);
  assert.throws(() => validateFacebookDestination('rtmps://example.test/live', 'key/with/path'), /clave de transmisión/);
  assert.throws(() => validateFacebookDestination('rtmps://example.test/live', 'x'.repeat(513)), /clave de transmisión/);
});

test('streaming and recording Egress stay distinct and expose honest states', () => {
  const stream = {
    egressId: 'facebook-egress', status: 'EGRESS_ACTIVE', streamResults: [{}],
    request: { value: { streamOutputs: [{ urls: ['[redacted]'] }] } },
  };
  const recording = {
    egressId: 'recording-egress', status: 'EGRESS_ACTIVE', fileResults: [{}],
    request: { value: { fileOutputs: [{ filepath: 'recording.mp4' }] } },
  };
  assert.equal(isStreamingEgress(stream), true);
  assert.equal(isRecordingEgress(stream), false);
  assert.equal(isRecordingEgress(recording), true);
  assert.equal(isStreamingEgress(recording), false);
  assert.deepEqual(
    { state: facebookStateFromEgress(stream).state, active: facebookStateFromEgress(stream).active },
    { state: 'ACTIVE', active: true }
  );
  assert.equal(facebookStateFromEgress({ egressId: 'failed', status: 'EGRESS_FAILED' }).state, 'ERROR');
  assert.equal(facebookStateFromEgress({ egressId: 'complete', status: 'EGRESS_COMPLETE' }).active, false);
});

test('prejoin, meeting volume and Facebook UI keep the directed browser contracts', () => {
  const publicDir = path.join(__dirname, '..', 'public');
  const presenter = fs.readFileSync(path.join(publicDir, 'presenter.html'), 'utf8');
  const viewer = fs.readFileSync(path.join(publicDir, 'viewer.html'), 'utf8');
  const roomUi = fs.readFileSync(path.join(publicDir, 'room-ui.js'), 'utf8');
  for (const html of [presenter, viewer]) {
    assert.match(html, /id="privacyConsent" type="checkbox" required[^>]*>[\s\S]*?He leído el aviso de privacidad y acepto participar\./);
    assert.match(html, /class="privacy-consent-text">He leído el aviso de privacidad y acepto participar\.<\/span>/);
    assert.match(html, /style\.css\?v=20260812-prejoin-consent1/);
    assert.match(html, /id="facebookStreamKey" type="password"[^>]*autocomplete="off"/);
    assert.match(html, /Obtén estos datos desde Facebook Live Producer/);
    assert.match(html, /R\.A\. Training confirma el envío de señal, no que Facebook ya la haya publicado/);
    assert.doesNotMatch(html, /Facebook está público|En vivo en Facebook/);
  }
  assert.match(roomUi, /button\.disabled = !ui\.livekitAvailable \|\| !accepted/);
  assert.match(roomUi, /ui\.meetingVolume = 1;[\s\S]*?setMeetingVolume\(ui\.meetingVolume\)/);
  assert.doesNotMatch(roomUi, /rat:meeting-volume/);
  assert.doesNotMatch(roomUi, /localStorage[\s\S]{0,120}facebook|facebook[\s\S]{0,120}localStorage/i);
  assert.doesNotMatch(roomUi, /sessionStorage[\s\S]{0,120}facebook|facebook[\s\S]{0,120}sessionStorage/i);
  assert.match(roomUi, /ACTIVE: '🔴 Señal enviada a Facebook'/);
  assert.doesNotMatch(roomUi, /Facebook está público|Facebook está en vivo|Transmisión activa/);
});
