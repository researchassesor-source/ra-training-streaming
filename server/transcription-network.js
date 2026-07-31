const dns = require('node:dns').promises;
const net = require('node:net');
const { AppError } = require('./http-utils');

function isPrivateAddress(address) {
  const value = String(address || '').toLowerCase().split('%')[0].replace(/^\[|\]$/g, '');
  if (net.isIP(value) === 4) {
    const [a, b] = value.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIP(value) === 6) {
    if (value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') || /^fe[89ab]/.test(value)) return true;
    if (value.startsWith('::ffff:')) return isPrivateAddress(value.slice(7));
  }
  return false;
}

function validateProviderUrl(apiUrl, {
  allowedHosts = new Set(),
  exactHostname = null,
  exactPathname = null,
  productionLike = true,
  allowLocalDevelopment = false,
} = {}) {
  try {
    const parsed = new URL(String(apiUrl || ''));
    const hostname = parsed.hostname.toLowerCase();
    const localDevelopment = allowLocalDevelopment && !productionLike && parsed.protocol === 'http:' && hostname === 'localhost';
    if (!localDevelopment && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    if (exactHostname && hostname !== exactHostname) return null;
    if (exactPathname && parsed.pathname.replace(/\/+$/, '') !== exactPathname.replace(/\/+$/, '')) return null;
    if (hostname.endsWith('.local') || isPrivateAddress(hostname)) return null;
    if (productionLike && !allowedHosts.has(hostname)) return null;
    if (exactHostname && !allowedHosts.has(hostname)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function assertPublicProviderTarget(apiUrl, {
  lookupImpl = dns.lookup,
  productionLike = true,
} = {}) {
  if (!productionLike) return;
  const parsed = new URL(apiUrl);
  const hostname = parsed.hostname.toLowerCase();
  if (hostname.endsWith('.local') || isPrivateAddress(hostname)) {
    throw new AppError(503, 'El destino del proveedor de transcripci\u00f3n no es v\u00e1lido', 'TRANSCRIPTION_PROVIDER_TARGET_INVALID');
  }
  let addresses;
  try {
    addresses = await lookupImpl(hostname, { all: true, verbatim: true });
  } catch {
    throw new AppError(502, 'No fue posible resolver el proveedor de transcripci\u00f3n', 'TRANSCRIPTION_DEEPGRAM_UNAVAILABLE');
  }
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new AppError(503, 'El destino del proveedor de transcripci\u00f3n no es v\u00e1lido', 'TRANSCRIPTION_PROVIDER_TARGET_INVALID');
  }
}

module.exports = { assertPublicProviderTarget, isPrivateAddress, validateProviderUrl };
