// award-game-result
//
// Клієнт більше НЕ рахує й НЕ надсилає "earned" (скільки монет дати) —
// він шле лише сирі результати раунду (score/moves/round/won тощо), а
// ЦЯ функція — єдине джерело правди — сама рахує нагороду за формулою
// гри і сама пише її в базу через service_role (в обхід RLS, але тригери
// на таблицях все одно спрацьовують як другий рубіж захисту).
//
// Формули продубльовані з відповідних games/*.html — якщо міняєш нагороду
// в грі, онови і тут, інакше сервер відхилить легітимний результат.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

type Metrics = Record<string, unknown>;

function num(m: Metrics, key: string, def = 0): number {
  const v = Number(m[key]);
  return Number.isFinite(v) ? v : def;
}
function bool(m: Metrics, key: string): boolean {
  return m[key] === true;
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function computeReward(game: string, m: Metrics): { earned: number; records: Record<string, number> } {
  switch (game) {
    case 'snake': {
      const score = clamp(num(m, 'score'), 0, 50000);
      return { earned: Math.max(1, Math.floor(score / 5)), records: { snake_best: score } };
    }
    case 'tetris': {
      const score = clamp(num(m, 'score'), 0, 999999);
      return { earned: Math.max(1, Math.floor(score / 100)), records: { tetris_best: score } };
    }
    case '2048': {
      const score = clamp(num(m, 'score'), 0, 400000);
      return { earned: Math.max(1, Math.floor(score / 50)), records: { '2048_best': score } };
    }
    case 'flappy': {
      const score = clamp(num(m, 'score'), 0, 2000);
      return { earned: Math.max(1, score * 2), records: { flappy_best: score } };
    }
    case 'simon': {
      const round = clamp(num(m, 'round'), 0, 200);
      return { earned: Math.max(1, round * 4), records: { simon_best: round } };
    }
    case 'pong': {
      const won = bool(m, 'won');
      if (won) {
        return { earned: 25 + 7, records: {} };
      }
      const score = clamp(num(m, 'score'), 0, 6);
      return { earned: Math.max(1, score * 2), records: {} };
    }
    case 'spaceshooter': {
      const score = clamp(num(m, 'score'), 0, 200000);
      return { earned: Math.max(1, Math.floor(score / 8)), records: { spaceshooter_best: score } };
    }
    case 'minesweeper': {
      const won = bool(m, 'won');
      if (!won) return { earned: 0, records: {} };
      const seconds = clamp(num(m, 'seconds'), 0, 99999);
      return { earned: Math.max(10, 100 - seconds), records: {} };
    }
    case 'moles': {
      const score = clamp(num(m, 'score'), 0, 10000);
      return { earned: Math.max(1, score), records: { moles_best: score } };
    }
    case 'memory': {
      const moves = clamp(num(m, 'moves'), 8, 100000);
      return { earned: Math.max(5, 60 - moves * 2), records: { memory_best_moves: moves } };
    }
    case 'arkanoid': {
      const won = bool(m, 'won');
      const score = clamp(num(m, 'score'), 0, 100000);
      if (won) return { earned: Math.floor(score / 10) + 20, records: { arkanoid_won: 1 } };
      return { earned: Math.max(1, Math.floor(score / 10)), records: {} };
    }
    case 'platformer': {
      const won = bool(m, 'won');
      if (won) return { earned: 10 * 3 + 20, records: { platformer_won: 1 } };
      const collected = clamp(num(m, 'collected'), 0, 10);
      return { earned: Math.max(1, collected * 2), records: {} };
    }
    case 'puzzle15': {
      const moves = clamp(num(m, 'moves'), 0, 100000);
      return { earned: Math.max(10, 120 - moves), records: { puzzle15_solved: 1 } };
    }
    default:
      throw new Error(`unknown game: ${game}`);
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405 });
  }

  const authHeader = req.headers.get('Authorization') || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  if (!jwt) {
    return new Response(JSON.stringify({ error: 'missing Authorization' }), { status: 401 });
  }

  const anonClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: userData, error: userErr } = await anonClient.auth.getUser(jwt);
  if (userErr || !userData?.user) {
    return new Response(JSON.stringify({ error: 'invalid session' }), { status: 401 });
  }
  const userId = userData.user.id;

  let body: { game?: string; metrics?: Metrics };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid json' }), { status: 400 });
  }
  const game = String(body.game || '');
  const metrics = body.metrics || {};

  let reward;
  try {
    reward = computeReward(game, metrics);
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error).message) }), { status: 400 });
  }

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: profileRow } = await db.from('profiles').select('data, updated_at').eq('id', userId).maybeSingle();
  const prevData: Record<string, unknown> = (profileRow?.data as Record<string, unknown>) || {};

  const prevEarned = Number(prevData['koinzal_total_earned']) || 0;
  const prevXp = Number(prevData['koinzal_xp']) || 0;

  const nextData: Record<string, unknown> = { ...prevData };
  nextData['koinzal_total_earned'] = prevEarned + reward.earned;
  nextData['koinzal_xp'] = prevXp + reward.earned;

  for (const [key, val] of Object.entries(reward.records)) {
    const prevVal = Number(prevData[key]);
    if (key === 'memory_best_moves') {
      nextData[key] = Number.isFinite(prevVal) ? Math.min(prevVal, val) : val;
    } else if (key.endsWith('_won') || key.endsWith('_solved')) {
      nextData[key] = 1;
    } else {
      nextData[key] = Number.isFinite(prevVal) ? Math.max(prevVal, val) : val;
    }
  }
  if (game === 'pong' && bool(metrics, 'won')) {
    nextData['pong_wins'] = (Number(prevData['pong_wins']) || 0) + 1;
  }
  if (game === 'minesweeper' && bool(metrics, 'won')) {
    nextData['minesweeper_wins'] = (Number(prevData['minesweeper_wins']) || 0) + 1;
  }

  const { error: upsertErr } = await db.from('profiles').upsert({
    id: userId,
    data: nextData,
    updated_at: new Date().toISOString(),
  });
  if (upsertErr) {
    return new Response(JSON.stringify({ error: 'db write failed: ' + upsertErr.message }), { status: 500 });
  }

  return new Response(JSON.stringify({ earned: reward.earned }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
