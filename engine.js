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

// Каже SupaSync зберегти прогрес найближчим часом (з дебаунсом) —
// викликається після кожної значущої зміни: монети, XP, покупка теми/рамки.
// Для гостя (без входу) чи коли Supabase не підключено — просто нічого не робить.
function pingSync() { if (window.SupaSync) SupaSync.schedulePush(); }

/* ---------- Монети: єдиний гаманець для всього порталу ---------- */
const CoinBank = {
  KEY_TOTAL: 'koinzal_total_earned',
  KEY_SPENT: 'koinzal_total_spent',
  getTotalEarned() {
    try { return Number(localStorage.getItem(this.KEY_TOTAL) || 0); } catch (e) { return 0; }
  },
  getTotalSpent() {
    try { return Number(localStorage.getItem(this.KEY_SPENT) || 0); } catch (e) { return 0; }
  },
  // Баланс = зароблено за все життя мінус витрачено. Обидва лічильники
  // тільки зростають, тому синхронізація між пристроями (бере максимум)
  // ніколи не "повертає" вже витрачені монети — на відміну від зберігання
  // самого балансу, який можна було випадково відкотити назад.
  get() { return Math.max(0, this.getTotalEarned() - this.getTotalSpent()); },
  // Нараховує монети без нарахування досвіду — використовується для
  // самих рівневих нагород, щоб уникнути рекурсії з LevelManager.
  addSilent(amount) {
    const inc = Math.max(0, Math.floor(amount));
    try { localStorage.setItem(this.KEY_TOTAL, this.getTotalEarned() + inc); } catch (e) {}
    pingSync();
    return this.get();
  },
  add(amount) {
    const inc = Math.max(0, Math.floor(amount));
    const v = this.addSilent(inc);
    if (inc > 0) {
      LevelManager.addXp(inc);
      DailyMissions.addCoins(inc);
    }
    return v;
  },
  spend(amount) {
    if (this.get() < amount) return false;
    try { localStorage.setItem(this.KEY_SPENT, this.getTotalSpent() + amount); } catch (e) {}
    pingSync();
    return true;
  }
};

// Одноразова міграція для тих, хто грав до цього фіксу: старий ключ
// "koinzal_coins" зберігав сам баланс (а не earned/spent окремо). Тут
// рахуємо, скільки вже "витрачено" було на момент фіксу, щоб баланс
// після оновлення не стрибнув ані вгору, ані вниз.
(function migrateCoinBalance() {
  try {
    if (localStorage.getItem('koinzal_total_spent') === null) {
      const earned = Number(localStorage.getItem('koinzal_total_earned') || 0);
      const oldBalance = localStorage.getItem('koinzal_coins');
      const spent = oldBalance !== null ? Math.max(0, earned - Number(oldBalance)) : 0;
      localStorage.setItem('koinzal_total_spent', spent);
    }
  } catch (e) {}
})();

/* ---------- Рівні: досвід = монети, зароблені за все життя. Рівні 1-100
   дають монетну нагороду за кожен новий рівень; після 100-го рівень
   продовжує рости, але нагород більше немає. ---------- */
const LEVEL_XP_BASE = 50;
const LEVEL_XP_STEP = 25;
const MAX_REWARD_LEVEL = 100;

// Звання за діапазонами рівнів — суто декоративні, показують прогрес одним словом.
const RANKS = [
  { min: 1,   name: 'Новачок',        icon: '🌱' },
  { min: 10,  name: 'Аматор',         icon: '🎯' },
  { min: 20,  name: 'Гравець',        icon: '🎮' },
  { min: 30,  name: 'Умілець',        icon: '🛠️' },
  { min: 40,  name: 'Знавець',        icon: '🥉' },
  { min: 50,  name: 'Експерт',        icon: '🥈' },
  { min: 60,  name: 'Майстер',        icon: '🥇' },
  { min: 70,  name: 'Чемпіон',        icon: '🏆' },
  { min: 80,  name: 'Елітний гравець',icon: '💠' },
  { min: 90,  name: 'Легенда',        icon: '👑' },
  { min: 101, name: 'Безсмертний',    icon: '✨' }
];

/* ---------- Рамки профілю: косметичні нагороди за рівень, не купуються
   за монети — тільки видаються автоматично при досягненні рівня. ---------- */
const FRAMES = {
  none:      { name: 'Без рамки',        css: 'transparent' },
  bronze:    { name: 'Бронзова рамка',   css: 'linear-gradient(135deg,#cd7f32,#8a5a2b)' },
  silver:    { name: 'Срібна рамка',     css: 'linear-gradient(135deg,#e6e6e6,#9a9a9a)' },
  gold:      { name: 'Золота рамка',     css: 'linear-gradient(135deg,#ffd76a,#c9962f)' },
  emerald:   { name: 'Смарагдова рамка', css: 'linear-gradient(135deg,#6ee7b7,#1f9d6c)' },
  diamond:   { name: 'Діамантова рамка', css: 'linear-gradient(135deg,#8ff0ff,#3fa8c9)' },
  legendary: { name: 'Легендарна рамка', css: 'linear-gradient(135deg,#ff6bd6,#8f4bff 50%,#ffd76a)' }
};

// Ексклюзивні теми — так само нагорода за рівень, у магазині за монети не продаються.
const EXCLUSIVE_THEMES = {
  aurora:  { name: 'Аврора',  cyan: '#6ee7ff', magenta: '#a78bfa', yellow: '#f5f3ff', bg: '#0b1230', bgPanel: '#131a44', bgPanelRaised: '#1b2458', line: '#2c3868' },
  phoenix: { name: 'Фенікс',  cyan: '#ff8a3d', magenta: '#ff3d59', yellow: '#ffd23d', bg: '#280a05', bgPanel: '#3a0f08', bgPanelRaised: '#4c150b', line: '#6b2210' }
};

// На яких рівнях видаються немонетні нагороди (рамка і/або ексклюзивна тема).
const LEVEL_REWARDS = {
  5:   { frame: 'bronze' },
  15:  { frame: 'silver' },
  20:  { theme: 'aurora' },
  30:  { frame: 'gold' },
  50:  { frame: 'emerald', theme: 'phoenix' },
  75:  { frame: 'diamond' },
  100: { frame: 'legendary' }
};

// Скільки XP треба, щоб піднятися з рівня lvl на lvl+1.
function xpStepForLevel(lvl) { return LEVEL_XP_BASE + LEVEL_XP_STEP * lvl; }

// Кумулятивні пороги XP: LEVEL_THRESHOLDS[n] = скільки всього XP треба,
// щоб досягти рівня n+1 (LEVEL_THRESHOLDS[0] = 0 — старт на рівні 1).
const LEVEL_THRESHOLDS = (() => {
  const arr = [0];
  let total = 0;
  for (let lvl = 1; lvl <= MAX_REWARD_LEVEL; lvl++) {
    total += xpStepForLevel(lvl);
    arr.push(total);
  }
  return arr;
})();

/* ---------- XP-бустер: тимчасовий множник XP, купується за монети в
   магазині — розблоковується після купівлі всіх тем (див. shop.html). ---------- */
const XpBooster = {
  KEY_UNTIL: 'koinzal_xp_boost_until',
  DURATION_MS: 30 * 60 * 1000,
  MULTIPLIER: 2,
  getUntil() { return safeNum(this.KEY_UNTIL); },
  isActive() { return Date.now() < this.getUntil(); },
  remainingMs() { return Math.max(0, this.getUntil() - Date.now()); },
  // Активація продовжує поточний бустер, якщо він ще діє, а не перезаписує його.
  activate() {
    const now = Date.now();
    const base = Math.max(now, this.getUntil());
    try {
      localStorage.setItem(this.KEY_UNTIL, base + this.DURATION_MS);
      localStorage.setItem('koinzal_booster_uses', safeNum('koinzal_booster_uses') + 1);
    } catch (e) {}
  }
};

/* ---------- Обмін монет на XP: сенс витрачати монети, коли всі теми вже куплені.
   Кілька рівнів обміну — що більша сума одразу, то вигідніший курс. ---------- */
const XpExchange = {
  TIERS: [
    { coins: 100,  xp: 50 },   // курс 2:1 — базовий
    { coins: 500,  xp: 300 },  // курс ~1.67:1 — +20% вигідніше за базовий
    { coins: 1000, xp: 700 }   // курс ~1.43:1 — +40% вигідніше за базовий
  ],
  exchange(coins, xp) {
    if (!CoinBank.spend(coins)) return false;
    LevelManager.addXp(xp);
    try {
      localStorage.setItem('koinzal_xp_exchange_count', safeNum('koinzal_xp_exchange_count') + 1);
      if (coins >= 1000) localStorage.setItem('koinzal_used_1000_exchange', '1');
    } catch (e) {}
    return true;
  }
};

const LevelManager = {
  KEY_XP: 'koinzal_xp',
  MAX_REWARD_LEVEL,
  getXp() { return safeNum(this.KEY_XP); },
  // Визначає рівень за кількістю XP. Після MAX_REWARD_LEVEL крок XP
  // фіксується на значенні 100-го рівня — рівень і далі росте безкінечно.
  getLevel(xp) {
    const v = xp == null ? this.getXp() : xp;
    if (v >= LEVEL_THRESHOLDS[MAX_REWARD_LEVEL]) {
      const step = xpStepForLevel(MAX_REWARD_LEVEL);
      const over = v - LEVEL_THRESHOLDS[MAX_REWARD_LEVEL];
      return MAX_REWARD_LEVEL + 1 + Math.floor(over / step);
    }
    for (let lvl = 1; lvl <= MAX_REWARD_LEVEL; lvl++) {
      if (v < LEVEL_THRESHOLDS[lvl]) return lvl;
    }
    return MAX_REWARD_LEVEL;
  },
  // Прогрес усередині поточного рівня: {level, xp, xpIntoLevel, xpForNext, progress, rewardsOver}
  getProgress(xp) {
    const v = xp == null ? this.getXp() : xp;
    const level = this.getLevel(v);
    let base, need;
    if (level > MAX_REWARD_LEVEL) {
      const step = xpStepForLevel(MAX_REWARD_LEVEL);
      const over = v - LEVEL_THRESHOLDS[MAX_REWARD_LEVEL];
      base = LEVEL_THRESHOLDS[MAX_REWARD_LEVEL] + Math.floor(over / step) * step;
      need = step;
    } else {
      base = LEVEL_THRESHOLDS[level - 1];
      need = xpStepForLevel(level);
    }
    return {
      level, xp: v,
      xpIntoLevel: v - base,
      xpForNext: need,
      progress: Math.min(1, (v - base) / need),
      rewardsOver: level > MAX_REWARD_LEVEL
    };
  },
  rewardForLevel(level) { return 10 + level; },
  // Звання (текстовий "ранг") для даного рівня, за таблицею RANKS.
  getRank(level) {
    const lvl = level == null ? this.getLevel() : level;
    let cur = RANKS[0];
    for (const r of RANKS) { if (lvl >= r.min) cur = r; else break; }
    return cur;
  },
  // Дані для екрана "усі рівні й нагороди": масив {level, reward, rankStart, extra}
  // для 1..MAX_REWARD_LEVEL, rankStart — об'єкт звання (якщо на цьому рівні
  // воно змінюється), extra — рамка/тема з LEVEL_REWARDS, якщо є.
  getRewardTable() {
    const rows = [];
    for (let lvl = 1; lvl <= MAX_REWARD_LEVEL; lvl++) {
      const rankStart = RANKS.find(r => r.min === lvl) || null;
      rows.push({ level: lvl, reward: lvl === 1 ? 0 : this.rewardForLevel(lvl), rankStart, extra: LEVEL_REWARDS[lvl] || null });
    }
    return rows;
  },
  // Додає XP і, якщо перетнули один чи кілька рівнів, нараховує монетну
  // нагороду (тільки <=100) та видає рамки/ексклюзивні теми з LEVEL_REWARDS.
  addXp(amount) {
    let inc = Math.max(0, Math.floor(amount));
    if (inc <= 0) return null;
    if (XpBooster.isActive()) inc *= XpBooster.MULTIPLIER;
    const before = this.getXp();
    const beforeLevel = this.getLevel(before);
    const after = before + inc;
    try { localStorage.setItem(this.KEY_XP, after); } catch (e) {}
    pingSync();
    const afterLevel = this.getLevel(after);
    let rewardCoins = 0;
    const extras = [];
    if (afterLevel > beforeLevel) {
      for (let lvl = beforeLevel + 1; lvl <= afterLevel; lvl++) {
        if (lvl <= MAX_REWARD_LEVEL) rewardCoins += this.rewardForLevel(lvl);
        const extra = LEVEL_REWARDS[lvl];
        if (extra) {
          if (extra.frame) { FrameManager.own(extra.frame); extras.push({ type: 'frame', name: FRAMES[extra.frame].name }); }
          if (extra.theme) { ThemeManager.own(extra.theme); extras.push({ type: 'theme', name: (EXCLUSIVE_THEMES[extra.theme] || {}).name || extra.theme }); }
        }
      }
      if (rewardCoins > 0) CoinBank.addSilent(rewardCoins);
      const toastLines = [`⭐ Рівень ${afterLevel}${rewardCoins > 0 ? ' · +' + rewardCoins + ' монет' : ''}`];
      extras.forEach(e => toastLines.push(`${e.type === 'frame' ? '🖼️' : '🎨'} Нова нагорода: ${e.name}`));
      showToast(toastLines);
    }
    return { beforeLevel, afterLevel, leveledUp: afterLevel > beforeLevel, rewardCoins, extras };
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

/* ---------- Щоденні місії: 3 випадкові (за датою) завдання на день,
   дають багато XP одразу при виконанні — привід зайти щодня. ---------- */
const MISSION_POOL = [
  { id: 'coins50',    desc: 'Заробити 50 монет за сьогодні',         xp: 60,  target: 50,  type: 'coins' },
  { id: 'coins120',   desc: 'Заробити 120 монет за сьогодні',        xp: 110, target: 120, type: 'coins' },
  { id: 'games2',     desc: 'Зіграти у 2 різні ігри',                xp: 50,  target: 2,   type: 'uniqueGames' },
  { id: 'games3',     desc: 'Зіграти у 3 різні ігри',                xp: 80,  target: 3,   type: 'uniqueGames' },
  { id: 'sessions3',  desc: 'Зіграти 3 раунди (будь-які ігри)',      xp: 40,  target: 3,   type: 'sessions' },
  { id: 'sessions6',  desc: 'Зіграти 6 раундів (будь-які ігри)',     xp: 90,  target: 6,   type: 'sessions' },
  { id: 'achieve1',   desc: 'Розблокувати нове досягнення',          xp: 100, target: 1,   type: 'achievements' }
];

const DailyMissions = {
  KEY_DATE: 'koinzal_missions_date',
  KEY_PICKED: 'koinzal_missions_picked',
  KEY_CLAIMED: 'koinzal_missions_claimed',
  KEY_COINS: 'koinzal_missions_coins_today',
  KEY_SESSIONS: 'koinzal_missions_sessions_today',
  KEY_GAMES: 'koinzal_missions_games_today',
  KEY_ACH: 'koinzal_missions_ach_today',

  todayStr() { return new Date().toISOString().slice(0, 10); },

  // Детермінований вибір 3 місій із пулу — однаковий набір на весь день
  // і на всіх пристроях гравця, без потреби синхронізувати вибір окремо.
  _pickForToday() {
    let seed = 0;
    for (const ch of this.todayStr()) seed += ch.charCodeAt(0);
    const used = new Set();
    const picked = [];
    let x = seed || 1;
    while (picked.length < 3 && used.size < MISSION_POOL.length) {
      x = (x * 9301 + 49297) % 233280;
      const i = x % MISSION_POOL.length;
      if (!used.has(i)) { used.add(i); picked.push(MISSION_POOL[i].id); }
    }
    return picked;
  },

  ensureToday() {
    let storedDate = null;
    try { storedDate = localStorage.getItem(this.KEY_DATE); } catch (e) {}
    if (storedDate === this.todayStr()) return;
    try {
      localStorage.setItem(this.KEY_DATE, this.todayStr());
      localStorage.setItem(this.KEY_CLAIMED, '[]');
      localStorage.setItem(this.KEY_COINS, '0');
      localStorage.setItem(this.KEY_SESSIONS, '0');
      localStorage.setItem(this.KEY_GAMES, '[]');
      localStorage.setItem(this.KEY_ACH, '0');
      localStorage.setItem(this.KEY_PICKED, JSON.stringify(this._pickForToday()));
    } catch (e) {}
  },

  getPicked() {
    this.ensureToday();
    try {
      const ids = JSON.parse(localStorage.getItem(this.KEY_PICKED) || '[]');
      return ids.map(id => MISSION_POOL.find(m => m.id === id)).filter(Boolean);
    } catch (e) { return []; }
  },

  getClaimed() {
    try { return JSON.parse(localStorage.getItem(this.KEY_CLAIMED) || '[]'); } catch (e) { return []; }
  },

  _counterFor(type) {
    if (type === 'coins') return safeNum(this.KEY_COINS);
    if (type === 'sessions') return safeNum(this.KEY_SESSIONS);
    if (type === 'achievements') return safeNum(this.KEY_ACH);
    if (type === 'uniqueGames') {
      try { return (JSON.parse(localStorage.getItem(this.KEY_GAMES) || '[]')).length; } catch (e) { return 0; }
    }
    return 0;
  },

  // Місії дня разом із прогресом і статусом — для відображення в UI.
  getStatus() {
    this.ensureToday();
    const claimed = this.getClaimed();
    return this.getPicked().map(m => {
      const progress = Math.min(m.target, this._counterFor(m.type));
      return { ...m, progress, done: progress >= m.target, claimed: claimed.includes(m.id) };
    });
  },

  // Перевіряє всі сьогоднішні місії й одразу видає XP за щойно виконані.
  _checkAndClaim() {
    const claimed = new Set(this.getClaimed());
    const toastLines = [];
    const picked = this.getPicked();
    picked.forEach(m => {
      if (claimed.has(m.id)) return;
      if (this._counterFor(m.type) >= m.target) {
        LevelManager.addXp(m.xp);
        claimed.add(m.id);
        toastLines.push(`✅ Місія виконана: ${m.desc} · +${m.xp} XP`);
      }
    });
    if (toastLines.length) {
      try { localStorage.setItem(this.KEY_CLAIMED, JSON.stringify(Array.from(claimed))); } catch (e) {}
      showToast(toastLines);
    }
    // Лічильник "ідеальних днів" (усі 3 місії за день) — для ачивок
    // 'perfect_day' і 'perfect_week'. Рахуємо один раз за календарний
    // день, навіть якщо _checkAndClaim викликається кілька разів поспіль.
    if (picked.length && claimed.size >= picked.length) {
      try {
        const countedDate = localStorage.getItem('koinzal_perfect_day_counted_date');
        if (countedDate !== this.todayStr()) {
          localStorage.setItem('koinzal_perfect_day_counted_date', this.todayStr());
          localStorage.setItem('koinzal_perfect_days_count', safeNum('koinzal_perfect_days_count') + 1);
        }
      } catch (e) {}
    }
  },

  addCoins(amount) {
    this.ensureToday();
    const v = safeNum(this.KEY_COINS) + Math.max(0, Math.floor(amount));
    try { localStorage.setItem(this.KEY_COINS, v); } catch (e) {}
    this._checkAndClaim();
  },

  addAchievements(count) {
    if (count <= 0) return;
    this.ensureToday();
    const v = safeNum(this.KEY_ACH) + count;
    try { localStorage.setItem(this.KEY_ACH, v); } catch (e) {}
    this._checkAndClaim();
  },

  // Викликається автоматично при заході на сторінку відомої гри.
  registerGameSession(gameId) {
    this.ensureToday();
    const sessions = safeNum(this.KEY_SESSIONS) + 1;
    try { localStorage.setItem(this.KEY_SESSIONS, sessions); } catch (e) {}
    try {
      const games = JSON.parse(localStorage.getItem(this.KEY_GAMES) || '[]');
      if (!games.includes(gameId)) {
        games.push(gameId);
        localStorage.setItem(this.KEY_GAMES, JSON.stringify(games));
      }
    } catch (e) {}
    this._checkAndClaim();
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
    pingSync();
  },
  setActive(id) {
    try { localStorage.setItem(this.KEY_ACTIVE, id); } catch (e) {}
    pingSync();
    this.apply();
  },
  // Метадані теми — шукає як серед звичайних (магазинних), так і серед
  // ексклюзивних (нагородних) тем.
  getThemeMeta(id) { return THEMES[id] || EXCLUSIVE_THEMES[id] || null; },
  apply() {
    const id = this.getActive();
    const theme = THEMES[id] || EXCLUSIVE_THEMES[id] || THEMES.default;
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

/* ---------- Рамки профілю: керування активною/отриманими рамками ---------- */
const FrameManager = {
  KEY_ACTIVE: 'koinzal_frame',
  KEY_OWNED: 'koinzal_owned_frames',
  getActive() {
    try { return localStorage.getItem(this.KEY_ACTIVE) || 'none'; } catch (e) { return 'none'; }
  },
  getOwned() {
    try {
      const raw = localStorage.getItem(this.KEY_OWNED);
      const list = raw ? JSON.parse(raw) : ['none'];
      if (!list.includes('none')) list.push('none');
      return list;
    } catch (e) { return ['none']; }
  },
  own(id) {
    const owned = this.getOwned();
    if (!owned.includes(id)) owned.push(id);
    try { localStorage.setItem(this.KEY_OWNED, JSON.stringify(owned)); } catch (e) {}
    pingSync();
  },
  setActive(id) {
    try { localStorage.setItem(this.KEY_ACTIVE, id); } catch (e) {}
    pingSync();
  }
};

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
  { id: 'pong_10wins',  name: 'Чемпіон Понгу',  icon: '🏆', desc: 'Перемогти комп\u2019ютер у Понг 10 разів', check: () => safeNum('pong_wins') >= 10 },
  { id: 'minesweeper_5wins', name: 'Ветеран сапер', icon: '🎖️', desc: 'Перемогти в Сапері 5 разів',  check: () => safeNum('minesweeper_wins') >= 5 },
  { id: 'tetris_5000',  name: 'Легенда блоків', icon: '⭐', desc: 'Рахунок 5000+ у Блоках',            check: () => safeNum('tetris_best') >= 5000 },
  { id: 'all_rounder',  name: 'Різносторонній', icon: '🎯', desc: 'Пройти Цеглинки, Стрибуна, Сапера і П\u2019ятнашки хоча б раз', check: () => safeNum('arkanoid_won') >= 1 && safeNum('platformer_won') >= 1 && safeNum('minesweeper_wins') >= 1 && safeNum('puzzle15_solved') >= 1 },
  { id: 'streak30',     name: 'Місяць відданості', icon: '🏵️', desc: 'Заходити 30 днів поспіль',      check: () => DailyBonus.getStreak() >= 30 },
  { id: 'night_owl',    name: 'Нічна сова',     icon: '🦉', desc: 'Зайти на сайт вночі (00:00–05:00)', check: () => safeNum('played_late_night') >= 1 },
  { id: 'early_bird',   name: 'Рання пташка',   icon: '🐤', desc: 'Зайти на сайт рано вранці (05:00–08:00)', check: () => safeNum('played_early_morning') >= 1 },
  { id: 'level10',      name: 'Досвідчений гравець', icon: '🎮', desc: 'Досягти 10 рівня', check: () => LevelManager.getLevel() >= 10 },
  { id: 'level50',      name: 'Ветеран порталу', icon: '🥈', desc: 'Досягти 50 рівня', check: () => LevelManager.getLevel() >= 50 },
  { id: 'level100',     name: 'Максимальний рівень', icon: '🥇', desc: 'Досягти 100 рівня', check: () => LevelManager.getLevel() >= 100 },
  { id: 'exchanger',    name: 'Оптовий обмін',   icon: '🔄', desc: 'Обміняти монети на XP 10 разів', check: () => safeNum('koinzal_xp_exchange_count') >= 10 },
  { id: 'bulk_trader',  name: 'Оптовик',         icon: '💸', desc: 'Обміняти 1000 монет на XP за раз', check: () => safeNum('koinzal_used_1000_exchange') >= 1 },
  { id: 'boosted',      name: 'Прискорювач',     icon: '⚡', desc: 'Купити XP-бустер хоча б раз', check: () => safeNum('koinzal_booster_uses') >= 1 },
  { id: 'frame_collector', name: 'Колекціонер рамок', icon: '🖼️', desc: 'Мати 3+ рамки профілю', check: () => FrameManager.getOwned().length >= 3 },
  { id: 'legendary_frame', name: 'Максимальний стиль', icon: '✨', desc: 'Отримати легендарну рамку (100 рівень)', check: () => FrameManager.getOwned().includes('legendary') },
  { id: 'exclusive_themes', name: 'Ексклюзивний смак', icon: '🌈', desc: 'Отримати обидві ексклюзивні теми (Аврора і Фенікс)', check: () => ['aurora','phoenix'].every(id => ThemeManager.getOwned().includes(id)) },
  { id: 'tried_all',    name: 'Спробував усе',   icon: '🎮', desc: 'Зіграти хоча б раунд у кожній з 13 ігор', check: () => { try { return (JSON.parse(localStorage.getItem('koinzal_games_played_ever') || '[]')).length >= 13; } catch (e) { return false; } } },
  { id: 'perfect_day',  name: 'Ідеальний день',  icon: '📅', desc: 'Виконати всі 3 щоденні місії за один день', check: () => safeNum('koinzal_perfect_days_count') >= 1 },
  { id: 'perfect_week',  name: 'Тижневий ідеал',  icon: '📆', desc: 'Виконати всі 3 щоденні місії 5 різних днів', check: () => safeNum('koinzal_perfect_days_count') >= 5 },
  { id: 'legend',       name: 'Легенда порталу', icon: '👑', desc: 'Розблокувати всі інші досягнення', check: () => ACHIEVEMENTS.filter(a => a.id !== 'legend').every(a => a.check()) },
];

const Achievements = {
  KEY_GRANTED: 'koinzal_ach_xp_granted',
  unlocked() { return ACHIEVEMENTS.filter(a => a.check()); },
  all() { return ACHIEVEMENTS; },
  // XP за розблоковане досягнення — окреме від монет джерело досвіду.
  xpForAchievement(id) { return id === 'legend' ? 300 : 30; },
  getGranted() {
    try { return JSON.parse(localStorage.getItem(this.KEY_GRANTED) || '[]'); } catch (e) { return []; }
  },
  // Перевіряє всі розблоковані досягнення й нараховує XP за ті, що ще
  // не враховані — це і є заднім числом для тих, хто мав їх до появи XP.
  grantXp() {
    const grantedSet = new Set(this.getGranted());
    const newly = [];
    this.unlocked().forEach(a => {
      if (!grantedSet.has(a.id)) {
        const xp = this.xpForAchievement(a.id);
        LevelManager.addXp(xp);
        grantedSet.add(a.id);
        newly.push({ id: a.id, name: a.name, icon: a.icon, xp });
      }
    });
    if (newly.length) {
      try { localStorage.setItem(this.KEY_GRANTED, JSON.stringify(Array.from(grantedSet))); } catch (e) {}
    }
    return newly;
  }
};

// Загальне спливаюче сповіщення знизу екрана — рядок тексту на картку.
function showToast(messages) {
  if (!messages || !messages.length) return;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:999;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;';
  document.body.appendChild(wrap);
  messages.forEach((text, i) => {
    setTimeout(() => {
      const card = document.createElement('div');
      card.style.cssText = 'font-family:var(--font-display, sans-serif);font-weight:700;font-size:13px;background:var(--bg-panel,#1d3e3b);color:var(--text,#f4ede0);border:2px solid var(--yellow,#f0a93b);border-radius:12px;padding:10px 16px;box-shadow:0 8px 20px -6px rgba(0,0,0,0.5);opacity:0;transition:opacity .25s ease, transform .25s ease;transform:translateY(8px);';
      card.textContent = text;
      wrap.appendChild(card);
      requestAnimationFrame(() => { card.style.opacity = '1'; card.style.transform = 'translateY(0)'; });
      setTimeout(() => {
        card.style.opacity = '0';
        card.style.transform = 'translateY(8px)';
        setTimeout(() => card.remove(), 300);
      }, 3600);
    }, i * 450);
  });
}

// На кожному завантаженні сторінки — перевіряємо нові досягнення й
// одразу нараховуємо XP (включно заднім числом за вже наявні).
(function grantAchievementXpOnLoad() {
  const newly = Achievements.grantXp();
  if (newly.length) {
    showToast(newly.map(it => `${it.icon || '🏆'} ${it.name} · +${it.xp} XP`));
    DailyMissions.addAchievements(newly.length);
  }
})();

// Заднім числом видає рамки/ексклюзивні теми за рівні, які гравець
// пройшов ДО того, як ці нагороди з'явилися в LEVEL_REWARDS.
(function grantLevelRewardsOnLoad() {
  const currentLevel = LevelManager.getLevel();
  const toastLines = [];
  Object.entries(LEVEL_REWARDS).forEach(([lvlStr, r]) => {
    if (Number(lvlStr) > currentLevel) return;
    if (r.frame && !FrameManager.getOwned().includes(r.frame)) {
      FrameManager.own(r.frame);
      toastLines.push(`🖼️ Отримано рамку: ${FRAMES[r.frame].name}`);
    }
    if (r.theme && !ThemeManager.getOwned().includes(r.theme)) {
      ThemeManager.own(r.theme);
      const meta = EXCLUSIVE_THEMES[r.theme];
      toastLines.push(`🎨 Отримано тему: ${meta ? meta.name : r.theme}`);
    }
  });
  if (toastLines.length) showToast(toastLines);
})();

// Якщо поточна сторінка — одна з відомих ігор, зараховуємо ігровий раунд
// у прогрес щоденних місій (унікальні ігри + кількість раундів за сьогодні).
const KNOWN_GAME_IDS = [
  'snake', 'tetris', '2048', 'flappy', 'arkanoid', 'memory', 'minesweeper',
  'moles', 'platformer', 'pong', 'puzzle15', 'simon', 'spaceshooter'
];
(function registerGameSessionOnLoad() {
  try {
    const pageId = (location.pathname.split('/').pop() || '').replace(/\.html?$/i, '');
    if (KNOWN_GAME_IDS.includes(pageId)) {
      DailyMissions.registerGameSession(pageId);
      // Окремий довічний список зіграних ігор — на відміну від денного
      // прогресу місій, ніколи не скидається. Потрібен для ачивки 'tried_all'.
      const played = JSON.parse(localStorage.getItem('koinzal_games_played_ever') || '[]');
      if (!played.includes(pageId)) {
        played.push(pageId);
        localStorage.setItem('koinzal_games_played_ever', JSON.stringify(played));
      }
    }
  } catch (e) {}
})();

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

// Кнопка "на весь екран" — розгортає документ через Fullscreen API
// і масштабує ігрове поле (canvas #board або .simon), зберігаючи пропорції.
function scaleBoardForFullscreen(active) {
  const el = document.getElementById('board') || document.querySelector('.simon');
  if (!el) return;
  const isCanvas = el.tagName === 'CANVAS';
  if (active) {
    const intrinsicW = isCanvas ? el.width : (Number(el.dataset._origW) || el.offsetWidth);
    const intrinsicH = isCanvas ? el.height : (Number(el.dataset._origH) || el.offsetHeight);
    if (!isCanvas) { el.dataset._origW = intrinsicW; el.dataset._origH = intrinsicH; }
    if (!intrinsicW || !intrinsicH) return;
    const maxW = window.innerWidth * 0.94;
    const maxH = window.innerHeight * 0.88;
    const scale = Math.min(maxW / intrinsicW, maxH / intrinsicH);
    el.style.width = Math.round(intrinsicW * scale) + 'px';
    el.style.height = Math.round(intrinsicH * scale) + 'px';
  } else {
    el.style.width = '';
    el.style.height = '';
  }
}

function mountFullscreenButton(container) {
  if (!document.documentElement.requestFullscreen && !document.documentElement.webkitRequestFullscreen) {
    return null; // API недоступне (рідкісний браузер) — просто не показуємо кнопку
  }
  const btn = document.createElement('button');
  btn.className = 'fullscreen-btn';
  btn.type = 'button';
  const isFs = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
  const paint = () => {
    btn.textContent = isFs() ? '⤦' : '⛶';
    btn.title = isFs() ? 'Вийти з повного екрана' : 'На весь екран';
    scaleBoardForFullscreen(isFs());
  };
  paint();
  btn.addEventListener('click', () => {
    if (isFs()) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else {
      const el = document.documentElement;
      (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
    }
  });
  document.addEventListener('fullscreenchange', paint);
  document.addEventListener('webkitfullscreenchange', paint);
  window.addEventListener('resize', () => { if (isFs()) scaleBoardForFullscreen(true); });
  container.appendChild(btn);
  return btn;
}

// Позначаємо, якщо людина грає вночі чи рано вранці — для окремих досягнень.
(function trackPlayTime() {
  const h = new Date().getHours();
  try {
    if (h >= 0 && h < 5) localStorage.setItem('played_late_night', '1');
    if (h >= 5 && h < 8) localStorage.setItem('played_early_morning', '1');
  } catch (e) {}
})();

/* ---------- Значок нових нагород: чи з'явилось щось нове (ачивка,
   тема, рамка) відтоді, як гравець востаннє відкривав профіль. ---------- */
const RewardsBadge = {
  KEY_SEEN: 'koinzal_rewards_seen',
  _snapshotCount() {
    return Achievements.unlocked().length + FrameManager.getOwned().length + ThemeManager.getOwned().length;
  },
  hasUnseen() {
    let seen = 0;
    try { seen = Number(localStorage.getItem(this.KEY_SEEN) || 0); } catch (e) {}
    return this._snapshotCount() > seen;
  },
  // Викликати на сторінці профілю — позначає все поточне як "переглянуте".
  markSeen() {
    try { localStorage.setItem(this.KEY_SEEN, this._snapshotCount()); } catch (e) {}
  }
};

window.Engine = { SoundFX, Particles, ScreenShake, Loop, lerp, clamp, aabb, mountMuteButton, mountFullscreenButton, mountCoinBadge, CoinBank, THEMES, EXCLUSIVE_THEMES, ThemeManager, FRAMES, FrameManager, LEVEL_REWARDS, DailyBonus, DailyMissions, Achievements, LevelManager, XpBooster, XpExchange, RewardsBadge };
