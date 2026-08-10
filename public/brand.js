const APP_NAME_HTML = 'R.A. Training';
const APP_PRODUCT = 'Streaming';
const APP_TAGLINE = 'Excelencia en educación en línea';

function renderBrand(container, { tagline = true } = {}) {
  if (!container) return;
  container.classList.add('brand');
  container.innerHTML = `
    <img class="brand-app-icon" src="assets/streaming-app-logo.png" width="44" height="44" alt="Logo oficial de R.A. Training Streaming" />
    <div class="brand-text">
      <span class="brand-name">${APP_NAME_HTML}</span>
      <span class="brand-product">${APP_PRODUCT}</span>
      ${tagline ? `<span class="brand-tagline">${APP_TAGLINE}</span>` : ''}
    </div>`;
}
