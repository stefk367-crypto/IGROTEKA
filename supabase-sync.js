/* ============================================================
   SUPABASE SYNC — синхронізація прогресу (монети, теми, рекорди)
   між пристроями через вхід Google / GitHub.
   Підключати після supabase-js (CDN) і config.js, перед або
   після engine.js — порядок з engine.js не важливий.
   ============================================================ */

(function () {
  const SUPA_URL = window.SUPABASE_URL || '';
  const SUPA_KEY = window.SUPABASE_ANON_KEY || '';

  let supa = null;
  if (window.supabase && SUPA_URL && SUPA_KEY && !SUPA_URL.includes('ВАШ-ПРОЕКТ')) {
    supa = window.supabase.createClient(SUPA_URL, SUPA_KEY);
  }

  // Ключі, які завжди синхронізуємо, + всі, що закінчуються на "_best"
  // (рекорди ігор: snake_best, flappy_best, simon_best, 2048_best, ...)
  const KNOWN_KEYS = [
    'koinzal_coins', 'koinzal_total_earned', 'koinzal_xp', 'koinzal_xp_boost_until', 'koinzal_theme',
    'koinzal_owned_themes', 'koinzal_frame', 'koinzal_owned_frames',
    'koinzal_daily_date', 'koinzal_daily_streak'
  ];
  function collectBestKeys() {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.endsWith('_best')) out.push(k);
      }
    } catch (e) {}
    return out;
  }

  function snapshotLocal() {
    const keys = KNOWN_KEYS.concat(collectBestKeys());
    const obj = {};
    keys.forEach(k => {
      try { const v = localStorage.getItem(k); if (v !== null) obj[k] = v; } catch (e) {}
    });
    return obj;
  }

  // Мерджимо так, щоб ніколи не втратити прогрес: числа — максимум,
  // списки тем — об'єднання, інше — remote виграє тільки якщо local порожній.
  function applyRemote(obj) {
    if (!obj) return;
    Object.keys(obj).forEach(k => {
      const remote = obj[k];
      if (remote === null || remote === undefined) return;
      let local = null;
      try { local = localStorage.getItem(k); } catch (e) {}

      const isNumeric = k.endsWith('_best') || k === 'koinzal_coins' ||
        k === 'koinzal_total_earned' || k === 'koinzal_daily_streak' || k === 'koinzal_xp' ||
        k === 'koinzal_xp_boost_until';

      if (isNumeric) {
        const rv = Number(remote) || 0, lv = Number(local) || 0;
        try { localStorage.setItem(k, String(Math.max(rv, lv))); } catch (e) {}
      } else if (k === 'koinzal_owned_themes' || k === 'koinzal_owned_frames') {
        try {
          const fallback = k === 'koinzal_owned_frames' ? '["none"]' : '["default"]';
          const remoteList = JSON.parse(remote || fallback);
          const localList = JSON.parse(local || fallback);
          const merged = Array.from(new Set([...remoteList, ...localList]));
          localStorage.setItem(k, JSON.stringify(merged));
        } catch (e) {}
      } else if (local === null) {
        try { localStorage.setItem(k, remote); } catch (e) {}
      }
    });
  }

  // Прибирає з адресного рядка залишки access_token/refresh_token після
  // обробки входу — без цього повторний логін накопичує токени в URL.
  function cleanUrlHash() {
    if (window.location.hash && window.location.hash.includes('access_token')) {
      try {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      } catch (e) {}
    }
  }

  const SupaSync = {
    user: null,
    ready: false,

    async init() {
      if (!supa) { this.ready = true; return; }
      const { data } = await supa.auth.getSession();
      this.user = data && data.session ? data.session.user : null;
      if (this.user) await this.pull();
      this.ready = true;
      cleanUrlHash();
      window.dispatchEvent(new CustomEvent('supa-auth-change', { detail: this.user }));

      supa.auth.onAuthStateChange(async (_event, session) => {
        this.user = session ? session.user : null;
        if (this.user) await this.pull();
        cleanUrlHash();
        window.dispatchEvent(new CustomEvent('supa-auth-change', { detail: this.user }));
      });
    },

    async signInGoogle() {
      if (!supa) return alert('Supabase не налаштовано — заповни config.js');
      await supa.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.href } });
    },
    async signInGithub() {
      if (!supa) return alert('Supabase не налаштовано — заповни config.js');
      await supa.auth.signInWithOAuth({ provider: 'github', options: { redirectTo: window.location.href } });
    },
    async signOut() {
      if (!supa) return;
      await this.push(); // зберегти останній стан перед виходом
      await supa.auth.signOut();
      // Перезавантажуємо сторінку: клієнт Supabase ще донастроює внутрішнє
      // сховище після виходу, і миттєвий повторний вхід без перезавантаження
      // іноді "провалюється" з першого кліку.
      window.location.reload();
    },

    async pull() {
      if (!supa || !this.user) return;
      const { data, error } = await supa.from('profiles').select('data').eq('id', this.user.id).maybeSingle();
      if (!error && data && data.data) applyRemote(data.data);
    },
    async push() {
      if (!supa || !this.user) return;
      const snap = snapshotLocal();
      await supa.from('profiles').upsert({ id: this.user.id, data: snap, updated_at: new Date().toISOString() });
    }
  };

  // Віджет входу: <button>Google</button> <button>GitHub</button>,
  // після входу — email/нік і кнопка "Вийти".
  function mountAuthWidget(container) {
    const wrap = document.createElement('div');
    wrap.className = 'auth-widget';
    wrap.style.cssText = 'display:flex;align-items:center;gap:8px;justify-content:center;margin-top:14px;flex-wrap:wrap;';

    function paint() {
      const u = SupaSync.user;
      if (u) {
        const label = u.email || (u.user_metadata && u.user_metadata.user_name) || 'Профіль';
        wrap.innerHTML = `<span style="font-family:var(--font-display);font-weight:700;font-size:12.5px;color:var(--text-dim);">${label}</span>
          <button id="authOut" style="font-family:var(--font-display);font-weight:700;font-size:12px;padding:8px 12px;background:var(--bg-panel-raised);color:var(--text);border:1px solid var(--line);border-radius:8px;cursor:pointer;">Вийти</button>`;
        wrap.querySelector('#authOut').onclick = () => SupaSync.signOut();
      } else {
        wrap.innerHTML = `<button id="authGoogle" style="font-family:var(--font-display);font-weight:700;font-size:12px;padding:8px 12px;background:var(--bg-panel-raised);color:var(--text);border:1px solid var(--line);border-radius:8px;cursor:pointer;">Увійти через Google</button>
          <button id="authGithub" style="font-family:var(--font-display);font-weight:700;font-size:12px;padding:8px 12px;background:var(--bg-panel-raised);color:var(--text);border:1px solid var(--line);border-radius:8px;cursor:pointer;">Увійти через GitHub</button>`;
        wrap.querySelector('#authGoogle').onclick = () => SupaSync.signInGoogle();
        wrap.querySelector('#authGithub').onclick = () => SupaSync.signInGithub();
      }
    }
    paint();
    window.addEventListener('supa-auth-change', paint);
    container.appendChild(wrap);
    return wrap;
  }

  window.SupaSync = SupaSync;
  window.mountAuthWidget = mountAuthWidget;

  document.addEventListener('DOMContentLoaded', () => {
    SupaSync.init();
    window.addEventListener('beforeunload', () => { SupaSync.push(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') SupaSync.push();
    });
    setInterval(() => SupaSync.push(), 30000);
  });
})();
