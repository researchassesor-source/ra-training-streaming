const { AppError } = require('./http-utils');

function startsWith(buffer, signature) {
  return signature.every((byte, index) => buffer[index] === byte);
}

function isLikelyPlainText(buffer) {
  for (const byte of buffer) {
    if (byte === 0) return false;
    if (byte < 0x09) return false;
    if (byte > 0x0d && byte < 0x20) return false;
  }
  return true;
}

function hasValidMagicBytes(mimetype, buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  switch (String(mimetype || '').toLowerCase()) {
    case 'image/png':
      return bytes.length >= 8 && startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg':
      return bytes.length >= 3 && startsWith(bytes, [0xff, 0xd8, 0xff]);
    case 'image/webp':
      return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    case 'application/pdf':
      return bytes.length >= 5 && bytes.toString('ascii', 0, 5) === '%PDF-';
    case 'text/plain':
      return isLikelyPlainText(bytes);
    default:
      return false;
  }
}

function assertValidFileContent(mimetype, buffer) {
  if (!hasValidMagicBytes(mimetype, buffer)) {
    throw new AppError(415, 'El contenido del archivo no coincide con el tipo declarado', 'UNSUPPORTED_MEDIA_TYPE');
  }
}

module.exports = { assertValidFileContent, hasValidMagicBytes };
