function browserSessionStorage() {
  try { return globalThis.sessionStorage; } catch { return null; }
}

export function createConversationContext({ storage = browserSessionStorage(), makeId = () => globalThis.crypto?.randomUUID?.()
  ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` } = {}) {
  const sessions = new Map();
  return {
    idFor(endpoint = '') {
      const normalized = String(endpoint).replace(/\/+$/, '') || 'local-core';
      if (sessions.has(normalized)) return sessions.get(normalized);
      const key = `jarvis.conversation.${encodeURIComponent(normalized)}`;
      let stored;
      try { stored = storage?.getItem(key); } catch {}
      const valid = typeof stored === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(stored);
      const id = valid ? stored : `cc-${makeId()}`;
      sessions.set(normalized, id);
      try { storage?.setItem(key, id); } catch {}
      return id;
    }
  };
}

export const conversationContext = createConversationContext();
