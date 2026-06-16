// MedTracker / TargetPG — Service Worker v3.0
// Background notifications with reply action

const DB_NAME = 'targetpg-db';

// ── IndexedDB helpers ──
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = e => e.target.result.createObjectStore('s', { keyPath: 'k' });
    r.onsuccess = e => res(e.target.result);
    r.onerror = () => rej(r.error);
  });
}
async function dbGet(k) {
  try {
    const db = await openDB();
    return new Promise(res => {
      const r = db.transaction('s','readonly').objectStore('s').get(k);
      r.onsuccess = () => res(r.result ? r.result.v : null);
      r.onerror = () => res(null);
    });
  } catch { return null; }
}
async function dbSet(k, v) {
  try {
    const db = await openDB();
    return new Promise(res => {
      const tx = db.transaction('s','readwrite');
      tx.objectStore('s').put({ k, v });
      tx.oncomplete = res; tx.onerror = res;
    });
  } catch {}
}

// ── INSTALL & ACTIVATE ──
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil(clients.claim().then(() => scheduleCheck()));
});

// ── RECEIVE SETTINGS FROM APP ──
self.addEventListener('message', async e => {
  if (!e.data) return;
  if (e.data.type === 'SCHEDULE_UPDATE') {
    await dbSet('wakeHour',    e.data.wakeHour    ?? 8);
    await dbSet('sleepHour',   e.data.sleepHour   ?? 1);
    await dbSet('notifEnabled',e.data.notifEnabled ?? true);
    await dbSet('cheatDays',   e.data.cheatDays   ?? {});
    // Confirm to app
    const cl = await clients.matchAll({ type: 'window' });
    cl.forEach(c => c.postMessage({ type: 'SW_READY' }));
    console.log('[SW] Settings saved');
  }
  // App saved the hourly log — dismiss notification
  if (e.data.type === 'LOG_SAVED') {
    const notifications = await self.registration.getNotifications({ tag: 'hourly-log' });
    notifications.forEach(n => n.close());
  }
});

// ── SCHEDULER ──
function scheduleCheck() {
  const now = new Date();
  const msToNextMin = (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 200;
  setTimeout(async () => {
    await doCheck();
    scheduleCheck();
  }, msToNextMin);
}

async function doCheck() {
  const now     = new Date();
  const h       = now.getHours();
  const m       = now.getMinutes();
  if (m > 3) return;

  const wakeH   = (await dbGet('wakeHour'))    ?? 8;
  const sleepH  = (await dbGet('sleepHour'))   ?? 1;
  const enabled = (await dbGet('notifEnabled')) ?? false;
  const cheats  = (await dbGet('cheatDays'))   ?? {};
  const lastH   = (await dbGet('lastH'))       ?? -1;

  if (!enabled) return;

  const today = now.toISOString().split('T')[0];
  if (cheats[today]) return;
  if (h === lastH) return;

  // Active hours check
  let active;
  if (sleepH <= wakeH) {
    // Overnight: e.g wake 8, sleep 1 → active 8–24 OR 0–1
    active = h >= wakeH || h < sleepH;
  } else {
    // Same day: e.g wake 8, sleep 22
    active = h >= wakeH && h < sleepH;
  }
  if (!active) return;

  await dbSet('lastH', h);

  // Is app open & visible? Skip SW notif — app will show its own popup
  const cl = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (cl.some(c => c.visibilityState === 'visible')) return;

  // Previous hour slot
  const pH  = (h - 1 + 24) % 24;
  const lbl = String(pH).padStart(2,'0') + ':00 – ' + String(h).padStart(2,'0') + ':00';

  await self.registration.showNotification('⏰ ' + lbl + ' | TargetPG', {
    body: 'Is ghante mein kya kiya? Neeche Reply karo ya tap karo! 📝',
    icon:  'https://abhivanshsomvanshi-oss.github.io/Targetpg/icon-192.png',
    badge: 'https://abhivanshsomvanshi-oss.github.io/Targetpg/icon-192.png',
    tag: 'hourly-log',
    renotify: true,
    requireInteraction: true,
    vibrate: [300, 100, 300, 100, 500],
    silent: false,
    data: {
      hour: pH,
      label: lbl,
      url: 'https://abhivanshsomvanshi-oss.github.io/Targetpg/'
    },
    actions: [
      {
        action: 'reply',
        title: '📝 Kya kiya likho',
        type: 'text',
        placeholder: 'e.g. Pathology - 20 pages padha...'
      },
      {
        action: 'open',
        title: '📱 App Kholo'
      },
      {
        action: 'skip',
        title: '⏭ Skip'
      }
    ]
  });
}

// ── NOTIFICATION CLICK & REPLY ──
self.addEventListener('notificationclick', async e => {
  const action = e.action;
  const data   = e.notification.data || {};
  const url    = data.url || 'https://abhivanshsomvanshi-oss.github.io/Targetpg/';

  e.notification.close();

  if (action === 'skip') return;

  if (action === 'reply' && e.reply) {
    // User typed something in notification — save to IndexedDB
    const replyText = e.reply.trim();
    if (replyText) {
      const today  = new Date().toISOString().split('T')[0];
      const hour   = data.hour ?? new Date().getHours();
      const slotKey = String(hour).padStart(2,'0') + ':00-' + String((hour+1)%24).padStart(2,'0') + ':00';

      // Save to hourlyLog in DB
      const existing = (await dbGet('hourlyLog_' + today)) ?? {};
      existing[slotKey] = replyText;
      await dbSet('hourlyLog_' + today, existing);

      // Confirm notification
      await self.registration.showNotification('✅ Saved! | TargetPG', {
        body: '"' + replyText.slice(0,60) + (replyText.length>60?'…':'') + '" — log saved!',
        icon: 'https://abhivanshsomvanshi-oss.github.io/Targetpg/icon-192.png',
        tag: 'save-confirm',
        vibrate: [100, 50, 100],
        requireInteraction: false
      });

      // Tell app to refresh its data
      const cl = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      cl.forEach(c => c.postMessage({
        type: 'SW_LOG_SAVED',
        date: today,
        slot: slotKey,
        text: replyText
      }));
    }
    return;
  }

  // 'open' action or tap — open app
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cl => {
      for (const c of cl) { if ('focus' in c) return c.focus(); }
      return clients.openWindow(url);
    })
  );
});
