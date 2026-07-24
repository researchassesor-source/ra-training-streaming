const APP_NAME_HTML = 'Research Assesor <span class="accent">&amp;</span>Training';
const APP_TAGLINE = 'Excelencia en Educación en Línea · Webinars';

const LOGO_SVG = `
<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="RA&T">
  <defs>
    <linearGradient id="ratGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#123a9c"/>
      <stop offset="1" stop-color="#3d6bea"/>
    </linearGradient>
  </defs>
  <rect x="1" y="1" width="46" height="46" rx="12" fill="url(#ratGrad)"/>
  <text x="24" y="33" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="26" font-weight="700" fill="#ffffff">R</text>
  <rect x="33" y="7" width="6" height="6" rx="1.5" fill="#f5a623"/>
  <rect x="26" y="7" width="4" height="4" rx="1" fill="#f5a623" opacity="0.8"/>
</svg>`;

function renderBrand(container, { tagline = true } = {}) {
  if (!container) return;
  container.classList.add('brand');
  container.innerHTML = `
    <div class="brand-logo">${LOGO_SVG}</div>
    <div class="brand-text">
      <span class="brand-name">${APP_NAME_HTML}</span>
      ${tagline ? `<span class="brand-tagline">${APP_TAGLINE}</span>` : ''}
    </div>
  `;
}
