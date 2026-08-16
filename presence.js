import { supabase } from './supabaseClient.js';

let onlineIds = new Set();
let listeners = [];

function notifyListeners() {
  for (const cb of listeners) cb(new Set(onlineIds));
}

export function trackPresence(userId) {
  const channel = supabase.channel('online-users', {
    config: { presence: { key: userId } },
  });

  channel
    .on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState();
      onlineIds = new Set(Object.keys(state));
      notifyListeners();
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await channel.track({ id: userId, online_at: new Date().toISOString() });
      }
    });

  return channel;
}

export function subscribeOnlineUsers(callback) {
  listeners.push(callback);
  callback(new Set(onlineIds));
  return () => {
    listeners = listeners.filter((cb) => cb !== callback);
  };
}
