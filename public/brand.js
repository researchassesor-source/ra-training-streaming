const APP_NAME_HTML = 'Research Assesor <span class="accent">&amp;</span>Training';
const APP_TAGLINE = 'Excelencia en Educación en Línea · Webinars';

function renderBrand(container, { tagline = true } = {}) {
  if (!container) return;
  container.classList.add('brand');
  container.innerHTML = `
    <div class="brand-logo"><img src="assets/logo.png" alt="Research Assesor & Training" /></div>
    <div class="brand-text">
      <span class="brand-name">${APP_NAME_HTML}</span>
      ${tagline ? `<span class="brand-tagline">${APP_TAGLINE}</span>` : ''}
    </div>
  `;
}
