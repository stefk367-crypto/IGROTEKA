/* ============================================================
   КОІНЗАЛ ENGINE — спільний рушій для всіх ігор порталу.
   Дає: фіксований game loop, синтезований звук (Web Audio,
   без файлів), систему частинок, шейк камери та дрібні
   фізичні хелпери (lerp, clamp, AABB).
   ============================================================ */

/* ---------- Звук: усе синтезується на льоту, файли не потрібні ---------- */
class SoundFX {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.volume = 0.8;
    try { this.muted = localStorage.getItem('koinzal_muted') === '1'; } catch (e) { /* localStorage недоступний — це нормально */ }
    try { const v = localStorage.getItem('koinzal_volume'); if (v !== null) this.volume = Number(v); } catch (e) {}
  }
  ensure() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }
  toggleMute() {
    this.muted = !this.muted;
    try { localStorage.setItem('koinzal_muted', this.muted ? '1' : '0'); } catch (e) { /* ігноруємо, якщо сховище недоступне */ }
    return this.muted;
  }
  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    try { localStorage.setItem('koinzal_volume', this.volume); } catch (e) {}
  }
  tone(freq, duration, type = 'square', vol = 0.15, glideTo = null) {
    if (this.muted || this.volume <= 0) return;
    this.ensure();
    const t0 = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + duration);
    const v = vol * this.volume;
    gain.gain.setValueAtTime(v, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t0);
    osc.stop(t0 + duration);
  }
  blip()   { this.tone(660, 0.05, 'square', 0.10); }
  move()   { this.tone(220, 0.03, 'square', 0.06); }
  eat()    { this.tone(440, 0.08, 'square', 0.15, 880); }
  coin()   { this.tone(988, 0.06, 'square', 0.13, 1568); }
  jump()   { this.tone(300, 0.12, 'triangle', 0.16, 600); }
  land()   { this.tone(150, 0.05, 'square', 0.08); }
  hit()    { this.tone(160, 0.22, 'sawtooth', 0.18, 50); }
  rotate() { this.tone(240, 0.04, 'square', 0.08); }
  drop()   { this.tone(120, 0.09, 'square', 0.13, 50); }
  hold()   { this.tone(500, 0.05, 'triangle', 0.1); }
  clear(n = 1) {
    const base = 523;
    for (let i = 0; i < Math.min(n, 4); i++) {
      setTimeout(() => this.tone(base + i * 130, 0.09, 'square', 0.14, base + i * 130 + 200), i * 55);
    }
  }
  levelUp() {
    [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.tone(f, 0.1, 'square', 0.14), i * 75));
  }
  gameOver() {
    [392, 330, 262, 196].forEach((f, i) => setTimeout(() => this.tone(f, 0.25, 'sawtooth', 0.15), i * 130));
  }
  win() {
    [523, 659, 784, 1046, 1318].forEach((f, i) => setTimeout(() => this.tone(f, 0.15, 'square', 0.15), i * 95));
  }
}

/* ---------- Частинки: іскри, пил, вибухи при подіях ---------- */
class Particles {
  constructor() { this.list = []; }
  burst(x, y, color, count = 10, opts = {}) {
    const { speed = 3, life = 26, gravity = 0.15, size = 4, spread = Math.PI * 2 } = opts;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * spread - spread / 2;
      const s = (0.4 + Math.random() * 0.6) * speed;
      this.list.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life, maxLife: life, gravity, color, size: size * (0.6 + Math.random() * 0.8)
      });
    }
  }
  update() {
    this.list.forEach(p => { p.x += p.vx; p.y += p.vy; p.vy += p.gravity; p.life--; });
    this.list = this.list.filter(p => p.life > 0);
  }
  draw(ctx) {
    this.list.forEach(p => {
      ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    });
    ctx.globalAlpha = 1;
  }
}

/* ---------- Шейк камери при ударах / приземленнях ---------- */
class ScreenShake {
  constructor() { this.t = 0; this.mag = 0; this.duration = 1; }
  trigger(mag = 6, duration = 10) { this.mag = mag; this.t = duration; this.duration = duration; }
  update() { if (this.t > 0) this.t--; }
  apply(ctx) {
    if (this.t > 0) {
      const k = this.t / this.duration;
      const dx = (Math.random() - 0.5) * this.mag * k;
      const dy = (Math.random() - 0.5) * this.mag * k;
      ctx.translate(dx, dy);
    }
  }
}

/* ---------- Фіксований game loop з інтерполяцією рендеру ---------- */
class Loop {
  constructor(update, render) {
    this.update = update;   // update(dtSeconds) — викликається з фіксованим кроком
    this.render = render;   // render(alpha) — alpha 0..1 для інтерполяції між кроками
    this.raf = null;
    this.last = 0;
    this.acc = 0;
    this.step = 1000 / 60;
    this.running = false;
  }
  start() {
    this.running = true;
    this.last = performance.now();
    this.acc = 0;
    const frame = (now) => {
      if (!this.running) return;
      let dt = now - this.last;
      this.last = now;
      if (dt > 250) dt = 250;
      this.acc += dt;
      while (this.acc >= this.step) {
        this.update(this.step / 1000);
        this.acc -= this.step;
        if (!this.running) break; // update() could have called stop()
      }
      this.render(this.acc / this.step);
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }
  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
  }
}

/* ---------- Дрібні хелпери ---------- */
function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function aabb(a, b) { return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }

/* ---------- Монети: єдиний гаманець для всього порталу ---------- */
const CoinBank = {
  KEY: 'koinzal_coins',
  KEY_TOTAL: 'koinzal_total_earned',
  get() {
    try { return Number(localStorage.getItem(this.KEY) || 0); } catch (e) { return 0; }
  },
  getTotalEarned() {
    try { return Number(localStorage.getItem(this.KEY_TOTAL) || 0); } catch (e) { return 0; }
  },
  add(amount) {
    const inc = Math.max(0, Math.floor(amount));
    const v = this.get() + inc;
    try {
      localStorage.setItem(this.KEY, v);
      localStorage.setItem(this.KEY_TOTAL, this.getTotalEarned() + inc);
    } catch (e) {}
    return v;
  },
  spend(amount) {
    const cur = this.get();
    if (cur < amount) return false;
    try { localStorage.setItem(this.KEY, cur - amount); } catch (e) {}
    return true;
  }
};

/* ---------- Щоденний бонус: раз на день, з бонусом за серію ---------- */
const DailyBonus = {
  KEY_DATE: 'koinzal_daily_date',
  KEY_STREAK: 'koinzal_daily_streak',
  todayStr() { return new Date().toISOString().slice(0, 10); },
  getStreak() {
    try { return Number(localStorage.getItem(this.KEY_STREAK) || 0); } catch (e) { return 0; }
  },
  canClaim() {
    try { return localStorage.getItem(this.KEY_DATE) !== this.todayStr(); } catch (e) { return true; }
  },
  claim() {
    if (!this.canClaim()) return null;
    let lastDate = null;
    try { lastDate = localStorage.getItem(this.KEY_DATE); } catch (e) {}
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    let streak = this.getStreak();
    streak = (lastDate === yesterday) ? streak + 1 : 1;
    const amount = Math.min(50, 10 + (streak - 1) * 5);
    try {
      localStorage.setItem(this.KEY_DATE, this.todayStr());
      localStorage.setItem(this.KEY_STREAK, streak);
    } catch (e) {}
    CoinBank.add(amount);
    return { amount, streak };
  }
};

/* ---------- Теми: акцентні кольори, які можна купити в магазині ---------- */
const THEMES = {
  default:  { name: 'Смарагд',   price: 0,   cyan: '#5fd0c2', magenta: '#ef6b52', yellow: '#f0a93b', bg: '#15302e', bgPanel: '#1d3e3b', bgPanelRaised: '#244a46', line: '#35564f' },
  ocean:    { name: 'Океан',     price: 40,  cyan: '#4fb8e0', magenta: '#2f6fb0', yellow: '#8fe0d0', bg: '#0d2438', bgPanel: '#123049', bgPanelRaised: '#173c5c', line: '#2c5a78' },
  ember:    { name: "Вогонь",    price: 40,  cyan: '#f0a93b', magenta: '#e2503a', yellow: '#ffd166', bg: '#2a1408', bgPanel: '#3a1d0c', bgPanelRaised: '#4a2610', line: '#6b3a18' },
  lavender: { name: 'Лаванда',   price: 60,  cyan: '#b79ce8', magenta: '#e05fa8', yellow: '#f0c93b', bg: '#221a35', bgPanel: '#2c2248', bgPanelRaised: '#382c5c', line: '#4a3d78' },
  gold:     { name: 'Золото',    price: 100, cyan: '#e8c874', magenta: '#c99a3c', yellow: '#fff1c2', bg: '#241c08', bgPanel: '#332810', bgPanelRaised: '#443318', line: '#5c4720' },
  neon:     { name: 'Неон',      price: 80,  cyan: '#00f0ff', magenta: '#ff2fd6', yellow: '#ffe94d', bg: '#0a0a12', bgPanel: '#12121e', bgPanelRaised: '#1a1a2c', line: '#2a2a45' },
  sakura:   { name: 'Сакура',    price: 50,  cyan: '#f2a6c9', magenta: '#e85d94', yellow: '#ffd1e0', bg: '#2a1620', bgPanel: '#391d2c', bgPanelRaised: '#4a2638', line: '#6b3550' },
  midnight: { name: 'Північ',    price: 70,  cyan: '#4a5fc1', magenta: '#7b3fe4', yellow: '#2b2f5e', bg: '#0c0f2a', bgPanel: '#131838', bgPanelRaised: '#1c234a', line: '#2f3768' },
  citrus:   { name: 'Цитрус',    price: 45,  cyan: '#ffb347', magenta: '#ff6f3c', yellow: '#c8e066', bg: '#241505', bgPanel: '#331d08', bgPanelRaised: '#44280c', line: '#5c3812' },
  forest:   { name: 'Ліс',       price: 55,  cyan: '#4caf7d', magenta: '#2e7d4f', yellow: '#a8d08d', bg: '#0f2417', bgPanel: '#15311f', bgPanelRaised: '#1c3f29', line: '#2c5a3c' },
  candy:    { name: 'Цукерка',   price: 65,  cyan: '#ff9ecf', magenta: '#c58cf0', yellow: '#fff07a', bg: '#241328', bgPanel: '#331a38', bgPanelRaised: '#44234a', line: '#5c3268' },
  volcano:  { name: 'Вулкан',    price: 90,  cyan: '#ff4d4d', magenta: '#992d1f', yellow: '#ff9d3b', bg: '#200a08', bgPanel: '#2e0f0c', bgPanelRaised: '#3d1510', line: '#5c1f18' },
  arctic:   { name: 'Арктика',   price: 60,  cyan: '#b8e6f0', magenta: '#6fa8c9', yellow: '#f0faff', bg: '#0e2028', bgPanel: '#152c36', bgPanelRaised: '#1d3a46', line: '#2e5060' },
  royal:    { name: 'Королівський', price: 120, cyan: '#9b59d0', magenta: '#5b2c8a', yellow: '#e8c96b', bg: '#180a28', bgPanel: '#221138', bgPanelRaised: '#2e1848', line: '#452468' },
  sunset:   { name: 'Захід сонця', price: 85, cyan: '#ff8c69', magenta: '#e0559b', yellow: '#ffcf5c', bg: '#280f1c', bgPanel: '#361528', bgPanelRaised: '#461c34', line: '#642c4a' },
  mint:     { name: "М'ята",     price: 50,  cyan: '#7fd9c4', magenta: '#4fae94', yellow: '#e0fff5', bg: '#0a2420', bgPanel: '#12332c', bgPanelRaised: '#1a423a', line: '#2a5c50' }
};

const ThemeManager = {
  KEY_ACTIVE: 'koinzal_theme',
  KEY_OWNED: 'koinzal_owned_themes',
  getActive() {
    try { return localStorage.getItem(this.KEY_ACTIVE) || 'default'; } catch (e) { return 'default'; }
  },
  getOwned() {
    try {
      const raw = localStorage.getItem(this.KEY_OWNED);
      const list = raw ? JSON.parse(raw) : ['default'];
      if (!list.includes('default')) list.push('default');
      return list;
    } catch (e) { return ['default']; }
  },
  own(id) {
    const owned = this.getOwned();
    if (!owned.includes(id)) owned.push(id);
    try { localStorage.setItem(this.KEY_OWNED, JSON.stringify(owned)); } catch (e) {}
  },
  setActive(id) {
    try { localStorage.setItem(this.KEY_ACTIVE, id); } catch (e) {}
    this.apply();
  },
  apply() {
    const id = this.getActive();
    const theme = THEMES[id] || THEMES.default;
    const root = document.documentElement.style;
    root.setProperty('--cyan', theme.cyan);
    root.setProperty('--magenta', theme.magenta);
    root.setProperty('--yellow', theme.yellow);
    root.setProperty('--bg', theme.bg);
    root.setProperty('--bg-panel', theme.bgPanel);
    root.setProperty('--bg-panel-raised', theme.bgPanelRaised);
    root.setProperty('--line', theme.line);
  }
};
ThemeManager.apply();

/* ---------- Досягнення: рахуються з уже наявних даних, без зайвого стеження ---------- */
function safeNum(key) { try { return Number(localStorage.getItem(key) || 0); } catch (e) { return 0; } }

const ACHIEVEMENTS = [
  { id: 'first_coins',  name: 'Перші монети',   icon: '🪙', desc: 'Заробити перші монети',            check: () => CoinBank.getTotalEarned() >= 1 },
  { id: 'saver',        name: 'Скарбничка',     icon: '💰', desc: 'Заробити 100 монет за все життя',  check: () => CoinBank.getTotalEarned() >= 100 },
  { id: 'rich',         name: 'Багатій',        icon: '👑', desc: 'Заробити 500 монет за все життя',  check: () => CoinBank.getTotalEarned() >= 500 },
  { id: 'tycoon',       name: 'Магнат',         icon: '💎', desc: 'Заробити 1500 монет за все життя', check: () => CoinBank.getTotalEarned() >= 1500 },
  { id: 'streak3',      name: 'Три дні поспіль',icon: '🔥', desc: 'Заходити 3 дні поспіль',           check: () => DailyBonus.getStreak() >= 3 },
  { id: 'streak7',      name: 'Тижневий фанат', icon: '🌟', desc: 'Заходити 7 днів поспіль',          check: () => DailyBonus.getStreak() >= 7 },
  { id: 'streak14',     name: 'Два тижні поспіль', icon: '🌠', desc: 'Заходити 14 днів поспіль',      check: () => DailyBonus.getStreak() >= 14 },
  { id: 'snake_50',     name: 'Довга змійка',   icon: '🐍', desc: 'Рахунок 50+ у Змійці',             check: () => safeNum('snake_best') >= 50 },
  { id: 'snake_100',    name: 'Гігантська змійка', icon: '🐲', desc: 'Рахунок 100+ у Змійці',         check: () => safeNum('snake_best') >= 100 },
  { id: 'flappy_10',    name: 'Впевнений пілот',icon: '🐦', desc: 'Рахунок 10+ у Літайлику',          check: () => safeNum('flappy_best') >= 10 },
  { id: 'flappy_25',    name: 'Ас неба',        icon: '🦅', desc: 'Рахунок 25+ у Літайлику',          check: () => safeNum('flappy_best') >= 25 },
  { id: 'simon_5',      name: "Пам'ять-майстер",icon: '🧠', desc: '5+ раундів у Саймоні',             check: () => safeNum('simon_best') >= 5 },
  { id: 'simon_10',     name: "Залізна пам'ять",icon: '🧩', desc: '10+ раундів у Саймоні',            check: () => safeNum('simon_best') >= 10 },
  { id: '2048_tile',    name: 'Зібрав 2048',    icon: '🀄', desc: 'Дійти до плитки 2048',             check: () => safeNum('2048_best') >= 2048 },
  { id: 'pong_5wins',   name: 'Король ракетки', icon: '🏓', desc: 'Перемогти комп\u2019ютер у Понг 5 разів', check: () => safeNum('pong_wins') >= 5 },
  { id: 'arkanoid_win', name: 'Руйнівник',      icon: '🧱', desc: 'Розбити всі цеглинки в Цеглинках', check: () => safeNum('arkanoid_won') >= 1 },
  { id: 'platformer_win', name: 'Скорений стрибок', icon: '🏃', desc: 'Зібрати всі монети в Стрибуні', check: () => safeNum('platformer_won') >= 1 },
  { id: 'spaceshooter_150', name: 'Захисник галактики', icon: '🚀', desc: 'Рахунок 150+ у Космобої',  check: () => safeNum('spaceshooter_best') >= 150 },
  { id: 'minesweeper_win', name: 'Сапер-професіонал', icon: '💣', desc: 'Перемогти в Сапері',         check: () => safeNum('minesweeper_wins') >= 1 },
  { id: 'moles_30',     name: 'Мисливець на кротів', icon: '🔨', desc: 'Рахунок 30+ у Кротах',        check: () => safeNum('moles_best') >= 30 },
  { id: 'puzzle15_win', name: "П'ятнашки зібрано", icon: '🔢', desc: 'Зібрати П\u2019ятнашки',        check: () => safeNum('puzzle15_solved') >= 1 },
  { id: 'memory_fast',  name: 'Фотографічна пам\u2019ять', icon: '🃏', desc: 'Зібрати Пам\u2019ять за 14 спроб або менше', check: () => { const v = safeNum('memory_best_moves'); return v > 0 && v <= 14; } },
  { id: 'tetris_2000',  name: 'Майстер блоків', icon: '🧊', desc: 'Рахунок 2000+ у Блоках',           check: () => safeNum('tetris_best') >= 2000 },
  { id: 'collector',    name: 'Колекціонер тем',icon: '🎨', desc: 'Мати 3+ теми в магазині',          check: () => ThemeManager.getOwned().length >= 3 },
  { id: 'collector_all', name: 'Повна колекція', icon: '🖼️', desc: 'Мати всі теми в магазині',         check: () => ThemeManager.getOwned().length >= Object.keys(THEMES).length },
];

const Achievements = {
  unlocked() { return ACHIEVEMENTS.filter(a => a.check()); },
  all() { return ACHIEVEMENTS; }
};

function mountCoinBadge(container, rootPrefix) {
  const el = document.createElement('a');
  el.href = (rootPrefix || '') + 'shop.html';
  el.className = 'coin-badge';
  el.innerHTML = '<span class="coin-dot">●</span><span class="coin-num"></span>';
  const paint = () => { el.querySelector('.coin-num').textContent = CoinBank.get(); };
  paint();
  container.appendChild(el);
  window.addEventListener('focus', paint);
  return { el, refresh: paint };
}

function mountMuteButton(sound, container) {
  const btn = document.createElement('button');
  btn.className = 'mute-btn';
  btn.type = 'button';
  const paint = () => { btn.textContent = sound.muted ? '🔇' : '🔊'; };
  paint();
  btn.addEventListener('click', () => { sound.toggleMute(); paint(); });
  container.appendChild(btn);
  return btn;
}

window.Engine = { SoundFX, Particles, ScreenShake, Loop, lerp, clamp, aabb, mountMuteButton, mountCoinBadge, CoinBank, THEMES, ThemeManager, DailyBonus, Achievements };
