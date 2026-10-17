// Uma execução do monitor: consulta as fontes, atualiza o estado no D1 e avisa no Discord quando algo muda.

import { SERVICE_ORDER, CONFIRM_RUNS, SOURCE_ALERT_AFTER } from './config.js';
import { checkEveo, checkNfce, checkNfe } from './sources.js';
import { downEmbed, upEmbed, sourceEmbed, reportItems, toPayloads, sendDiscord, brtParts, ufStatuses } from './discord.js';

const OUTBOX_MAX = 25;
const INCIDENT_KEEP_MS = 7 * 24 * 3600e3;

// ---------------------------------------------------------------- estado (uma linha no D1)

export async function loadState(db) {
  try {
    const row = await db.prepare('SELECT v FROM kv WHERE k = ?').bind('state').first();
    return row ? JSON.parse(row.v) : null;
  } catch (e) {
    if (!/no such table/i.test(String(e?.message ?? e))) throw e;
    await db.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    return null;
  }
}

async function saveState(db, state) {
  await db
    .prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .bind('state', JSON.stringify(state))
    .run();
}

// ---------------------------------------------------------------- transições

function applyResult(state, r, now) {
  const down = [];
  const up = [];
  if (!r.ok) return { down, up }; // fonte fora: mantém o último estado conhecido
  const confirm = CONFIRM_RUNS[r.key] ?? 1;

  for (const c of r.components) {
    if (c.unknown) continue;
    const id = `${r.key}:${c.id}`;
    const s = state.components[id];
    if (!s) {
      state.components[id] = { status: c.fail ? 'OFFLINE' : 'ONLINE', since: now, pendN: 0 };
      continue;
    }
    const target = s.status === 'ONLINE' ? (c.fail ? 'OFFLINE' : null) : c.ok ? 'ONLINE' : null;
    if (!target) {
      s.pendN = 0;
      continue;
    }
    s.pendN = (s.pendN ?? 0) + 1;
    if (s.pendN < confirm) continue;

    const downMs = now - s.since;
    Object.assign(s, { status: target, since: now, pendN: 0 });
    if (target === 'OFFLINE') {
      down.push(c);
      state.incidents.push({ svc: r.key, id: c.id, start: now, end: null });
    } else {
      up.push({ ...c, downMs });
      const open = state.incidents.findLast((i) => i.svc === r.key && i.id === c.id && !i.end);
      if (open) open.end = now;
    }
  }
  return { down, up };
}

function sourceHealth(state, r, now) {
  const s = (state.sources[r.key] ??= { fails: 0, alerted: false, since: null });
  if (r.ok) {
    const recovered = s.alerted;
    Object.assign(s, { fails: 0, alerted: false, since: null });
    return recovered ? 'up' : null;
  }
  s.fails++;
  s.since ??= now;
  if (!s.alerted && s.fails >= SOURCE_ALERT_AFTER) {
    s.alerted = true;
    return 'down';
  }
  return null;
}

function summarize(results, state, now) {
  return {
    at: new Date(now).toISOString(),
    maps: { nfce: ufStatuses('nfce', results.nfce, state), nfe: ufStatuses('nfe', results.nfe, state) },
    services: SERVICE_ORDER.map((key) => {
      const r = results[key];
      return {
        key,
        ok: r.ok,
        error: r.error ?? null,
        ms: r.ms,
        verificadoPortal: r.verificado,
        components: r.components.map((c) => ({
          id: c.id,
          status: state.components[`${key}:${c.id}`]?.status ?? 'SEM DADOS',
          unstable: !!c.unstable,
          unknown: !!c.unknown,
          info: c.info,
        })),
      };
    }),
  };
}

// ---------------------------------------------------------------- execução

export async function runMonitor(env, now = Date.now()) {
  const state = (await loadState(env.DB)) ?? { components: {}, sources: {}, incidents: [], outbox: [] };
  const firstRun = !state.startedAt;
  const list = await Promise.all([checkEveo(), checkNfce(now), checkNfe()]);
  const results = Object.fromEntries(list.map((r) => [r.key, r]));

  const items = [];
  for (const key of SERVICE_ORDER) {
    const r = results[key];
    const { down, up } = applyResult(state, r, now);
    const src = sourceHealth(state, r, now);
    if (firstRun) continue; // primeira execução só registra o estado atual
    if (down.length) items.push(downEmbed(key, r, down, state, now));
    if (up.length) items.push(upEmbed(key, r, up, state, now));
    if (src) items.push(sourceEmbed(key, r, state.sources[key], now, src === 'down'));
  }

  const { dateKey, hour } = brtParts(now);
  const reportKey = `${dateKey}T${hour}`;
  const reportHours = String(env.REPORT_HOURS ?? '18')
    .split(',')
    .map((h) => Number(h.trim()))
    .filter(Number.isInteger);
  if (firstRun || (reportHours.includes(hour) && state.lastReport !== reportKey)) {
    items.push(...reportItems(results, state, now, { startup: firstRun }));
    state.lastReport = reportKey;
  }
  state.startedAt ??= now;

  // Fila de saída: se o Discord falhar, as mensagens ficam guardadas e são reenviadas na próxima execução.
  const mention = env.MENTION ?? '@everyone';
  state.outbox = [...(state.outbox ?? []), ...toPayloads(items, mention)].slice(-OUTBOX_MAX);
  let sent = 0;
  if (env.DISCORD_WEBHOOK_URL) {
    while (state.outbox.length) {
      const res = await sendDiscord(env.DISCORD_WEBHOOK_URL, state.outbox[0]);
      if (!res) break;
      state.outbox.shift();
      if (res === true) sent++;
    }
  }

  state.incidents = state.incidents.filter((i) => !i.end || now - i.end < INCIDENT_KEEP_MS);
  state.lastRun = summarize(results, state, now);
  await saveState(env.DB, state);

  if (env.HEALTHCHECK_URL) await fetch(env.HEALTHCHECK_URL, { signal: AbortSignal.timeout(10000) }).catch(() => {});
  return { results, items, sent, pending: state.outbox.length, state };
}
