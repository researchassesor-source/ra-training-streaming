(function exposeAppCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RATCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildAppCore() {
  const CONNECTION_STATES = Object.freeze({
    validating_invitation: 'Validando invitación…',
    waiting_for_room: 'Esperando al organizador…',
    requesting_permissions: 'Solicitando permisos…',
    connecting_signaling: 'Conectando con la reunión…',
    connecting_media: 'Conectando audio y video…',
    connected: 'Conectado',
    poor_connection: 'Conexión inestable',
    reconnecting: 'Reconectando…',
    disconnected: 'No fue posible reconectar',
    access_denied: 'Tu acceso fue retirado',
    removed: 'Tu acceso fue retirado',
    room_ended: 'El organizador finalizó la reunión',
  });

  class ConnectionStateMachine {
    constructor(onChange, initial = 'validating_invitation') {
      this.onChange = typeof onChange === 'function' ? onChange : () => {};
      this.state = null;
      this.set(initial);
    }

    set(next, detail = '') {
      if (!Object.prototype.hasOwnProperty.call(CONNECTION_STATES, next)) throw new Error(`Estado desconocido: ${next}`);
      if (next === this.state && !detail) return this.snapshot();
      this.state = next;
      const snapshot = this.snapshot(detail);
      this.onChange(snapshot);
      return snapshot;
    }

    snapshot(detail = '') {
      return {
        state: this.state,
        label: detail || CONNECTION_STATES[this.state],
        connected: this.state === 'connected' || this.state === 'poor_connection',
        terminal: ['disconnected', 'access_denied', 'removed', 'room_ended'].includes(this.state),
      };
    }
  }

  function createUnreadCounter(onChange) {
    let count = 0;
    const emit = () => {
      if (typeof onChange === 'function') onChange(count);
      return count;
    };
    return {
      increment(amount = 1) { count = Math.max(0, count + amount); return emit(); },
      clear() { count = 0; return emit(); },
      get value() { return count; },
    };
  }

  class HandQueue {
    constructor() {
      this.items = [];
    }

    raise(identity, displayName = identity, raisedAt = new Date().toISOString()) {
      const existing = this.items.find((item) => item.identity === identity);
      if (existing) return existing;
      const item = { identity, displayName, raisedAt, status: 'PENDING', order: this.items.length + 1 };
      this.items.push(item);
      return item;
    }

    update(identity, status) {
      const item = this.items.find((entry) => entry.identity === identity);
      if (!item) return null;
      item.status = status;
      return item;
    }

    remove(identity) {
      const index = this.items.findIndex((entry) => entry.identity === identity);
      if (index < 0) return false;
      this.items.splice(index, 1);
      this.items.forEach((item, itemIndex) => { item.order = itemIndex + 1; });
      return true;
    }

    list() { return this.items.map((item) => ({ ...item })); }
  }

  function createFloatingModel(initial = {}) {
    const state = {
      live: false,
      title: '',
      participants: 1,
      raisedHands: 0,
      unreadMessages: 0,
      recording: false,
      connection: 'validating_invitation',
      microphone: false,
      camera: false,
      ...initial,
    };
    const listeners = new Set();
    return {
      update(patch) {
        Object.assign(state, patch);
        for (const listener of listeners) listener({ ...state });
        return { ...state };
      },
      subscribe(listener) { listeners.add(listener); listener({ ...state }); return () => listeners.delete(listener); },
      snapshot() { return { ...state }; },
    };
  }

  function safeHttpUrl(value, base = 'http://localhost') {
    try {
      const parsed = new URL(String(value), base);
      return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null;
    } catch {
      return null;
    }
  }

  return { CONNECTION_STATES, ConnectionStateMachine, HandQueue, createFloatingModel, createUnreadCounter, safeHttpUrl };
}));
