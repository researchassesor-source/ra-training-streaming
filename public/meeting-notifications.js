function createMeetingNotifier(container) {
  const active = new Map();
  const lastAt = new Map();
  const cooldownMs = 1_800;

  function permissionState() {
    if (!('Notification' in window)) return 'unsupported';
    return Notification.permission;
  }

  function renderToast(key, { title, message, tone = 'info', actionLabel, onAction, secondaryLabel, onSecondary, duration = 5_000 }) {
    const existing = active.get(key);
    if (existing) {
      existing.count += 1;
      existing.message.textContent = `${message} (${existing.count})`;
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => dismiss(key), duration);
      return;
    }
    const root = document.createElement('article');
    root.className = `meeting-toast tone-${tone}`;
    root.setAttribute('role', tone === 'critical' ? 'alert' : 'status');
    const heading = document.createElement('strong');
    heading.textContent = title;
    const body = document.createElement('span');
    body.textContent = message;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Cerrar aviso');
    close.textContent = '×';
    close.onclick = () => dismiss(key);
    root.append(heading, body, close);
    if (actionLabel && onAction) {
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'text-button';
      action.textContent = actionLabel;
      action.onclick = () => { onAction(); dismiss(key); };
      root.appendChild(action);
    }
    if (secondaryLabel && onSecondary) {
      const secondary = document.createElement('button');
      secondary.type = 'button';
      secondary.className = 'text-button secondary-action';
      secondary.textContent = secondaryLabel;
      secondary.onclick = () => { onSecondary(); dismiss(key); };
      root.appendChild(secondary);
    }
    container.appendChild(root);
    const record = { root, message: body, count: 1, timer: setTimeout(() => dismiss(key), duration) };
    active.set(key, record);
  }

  function dismiss(key) {
    const record = active.get(key);
    if (!record) return;
    clearTimeout(record.timer);
    record.root.remove();
    active.delete(key);
  }

  function notify(key, options) {
    const now = Date.now();
    const recently = now - (lastAt.get(key) || 0) < cooldownMs;
    lastAt.set(key, now);
    renderToast(key, options);
    if (!recently && options.sound) playAlert(options.sound);
    if (!recently && options.system !== false && document.hidden) systemNotification(options.title, options.message);
  }

  async function requestPermission() {
    const granted = await requestNotificationPermission();
    return { granted, state: permissionState() };
  }

  return { notify, dismiss, permissionState, requestPermission, dispose() { for (const key of [...active.keys()]) dismiss(key); } };
}

if (typeof module === 'object' && module.exports) module.exports = { createMeetingNotifier };
