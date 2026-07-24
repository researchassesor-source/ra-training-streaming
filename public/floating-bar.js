// Makes an element draggable by a handle within it (mouse + touch via
// Pointer Events), clamped to the viewport. Buttons/inputs inside the
// element are excluded from starting a drag automatically.
function makeDraggable(el, handleEl) {
  handleEl = handleEl || el;
  let dragging = false;
  let startX, startY, startLeft, startTop;

  function onPointerDown(e) {
    if (e.target.closest('button, input, a, label')) return;
    dragging = true;
    const rect = el.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    el.style.left = `${startLeft}px`;
    el.style.top = `${startTop}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    el.style.transform = 'none';
    handleEl.setPointerCapture?.(e.pointerId);
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
  }

  function onPointerMove(e) {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const maxLeft = window.innerWidth - el.offsetWidth - 4;
    const maxTop = window.innerHeight - el.offsetHeight - 4;
    el.style.left = `${Math.max(4, Math.min(maxLeft, startLeft + dx))}px`;
    el.style.top = `${Math.max(4, Math.min(maxTop, startTop + dy))}px`;
  }

  function onPointerUp() {
    dragging = false;
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
  }

  handleEl.addEventListener('pointerdown', onPointerDown);
  handleEl.style.touchAction = 'none';
}

// Toggles an element between its normal in-page position and a floating
// overlay appended directly to <body> (position:fixed while nested deep in
// the layout can behave unreliably if an ancestor ever gains a transform;
// body-level appending sidesteps that entirely — same trick already used
// for the participants panel and access-code gate).
function createFloatController(el) {
  const originalParent = el.parentElement;
  const originalNextSibling = el.nextElementSibling;
  let isFloating = false;

  function setFloating(floating) {
    if (floating === isFloating) return;
    isFloating = floating;
    if (floating) {
      document.body.appendChild(el);
      el.classList.add('floating');
    } else {
      el.classList.remove('floating');
      el.style.left = '';
      el.style.top = '';
      el.style.right = '';
      el.style.bottom = '';
      el.style.transform = '';
      if (originalNextSibling) originalParent.insertBefore(el, originalNextSibling);
      else originalParent.appendChild(el);
    }
  }

  return { setFloating, get isFloating() { return isFloating; } };
}

// Document Picture-in-Picture keeps a real OS-level always-on-top window —
// the only way a web page can stay visible over OTHER applications (e.g.
// while presenting a different app during screen share). Chrome-only; the
// pin button hides itself where unsupported.
function attachPinOnTop(btn, sourceEl) {
  if (!btn) return;
  if (!('documentPictureInPicture' in window)) {
    btn.hidden = true;
    return;
  }
  let pipWindow = null;
  let placeholder = null;

  btn.onclick = async () => {
    if (pipWindow) {
      pipWindow.close();
      return;
    }
    try {
      pipWindow = await documentPictureInPicture.requestWindow({
        width: sourceEl.offsetWidth || 360,
        height: sourceEl.offsetHeight || 90,
      });
      [...document.styleSheets].forEach((sheet) => {
        try {
          const link = pipWindow.document.createElement('link');
          link.rel = 'stylesheet';
          link.href = sheet.href || '';
          if (sheet.href) pipWindow.document.head.appendChild(link);
        } catch (e) { /* cross-origin stylesheet, skip */ }
      });
      placeholder = document.createComment('pinned-on-top-placeholder');
      sourceEl.replaceWith(placeholder);
      pipWindow.document.body.style.margin = '0';
      pipWindow.document.body.style.background = 'transparent';
      pipWindow.document.body.appendChild(sourceEl);
      btn.textContent = '📌 Quitar de encima';
      pipWindow.addEventListener('pagehide', () => {
        placeholder.replaceWith(sourceEl);
        pipWindow = null;
        btn.textContent = '📌 Fijar encima';
      });
    } catch (err) {
      console.error('Document PiP error', err);
      alert('Tu navegador no pudo activar el modo "siempre encima".');
    }
  };
}
