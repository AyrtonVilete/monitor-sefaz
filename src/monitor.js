// Uma execução do monitor: consulta as fontes, atualiza o estado no D1 e avisa no Discord quando algo muda.

import {
  SERVICE_ORDER,
  CONFIRM_DOWN,
  CONFIRM_UP,
  SOURCE_ALERT_AFTER,
  INTERMITTENT_ALERT,
  REMINDER_MIN,
} from './config.js';
import { checkEveo, checkNfce, checkNfe } from './sources.js';
import {
  downEmbed,
  upEmbed,
  downRemindEmbed,
  intStartEmbed,
  intRemindEmbed,
  intEndEmbed,
  sourceEmbed,
  reportItems,
  openingItems,
  toPayloads,
  sendDiscord,
  brtParts,
  ufStatuses,
} from './discord.js';

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

const openIncident = (state, svc, id, kind) =>
  state.incidents.findLast((i) => i.svc === svc && i.id === id && !i.end && (i.kind ?? 'down') === kind);

const REMINDER_MS = REMINDER_MIN * 60000;

function applyResult(state, r, now) {
  const out = { down: [], up: [], downRemind: [], intStart: [], intRemind: [], intEnd: [] };
  if (!r.ok) return out; // fonte fora: mantém o último estado conhecido (e pausa os lembretes)

  for (const c of r.components) {
    if (c.unknown) continue;
    const id = `${r.key}:${c.id}`;
    const s = state.components[id];
    if (!s) {
      state.components[id] = { status: c.fail ? 'OFFLINE' : 'ONLINE', since: now, pendN: 0, remindAt: now };
      continue;
    }
    const target = s.status === 'ONLINE' ? (c.fail ? 'OFFLINE' : null) : c.ok ? 'ONLINE' : null;
    const confirm = (target === 'OFFLINE' ? CONFIRM_DOWN : CONFIRM_UP)[r.key] ?? 1;
    if (!target) Object.assign(s, { pendN: 0, pendSince: null }); // piorou de novo: a contagem recomeça sem aviso
    else {
      if (!s.pendN) s.pendSince = now; // primeiro minuto da mudança (horário real da queda/retorno)
      if (++s.pendN >= confirm) {
        const at = s.pendSince ?? now;
        const downMs = at - s.since;
        Object.assign(s, { status: target, since: at, pendN: 0, pendSince: null, remindAt: now });
        if (target === 'OFFLINE') {
          out.down.push(c);
          state.incidents.push({ svc: r.key, id: c.id, kind: 'down', start: at, end: null });
        } else {
          out.up.push({ ...c, downMs, backAt: at });
          const open = openIncident(state, r.key, c.id, 'down');
          if (open) open.end = at;
        }
      }
    }
    // lembrete só enquanto continua fora de verdade (não durante os 10 min de confirmação do retorno)
    if (s.status === 'OFFLINE' && !s.pendN && now - (s.remindAt ?? s.since) >= REMINDER_MS) {
      s.remindAt = now;
      out.downRemind.push({ ...c, downMs: now - s.since });
    }
    intermittentStep(state, r.key, c, s, now, out);
  }
  return out;
}

// Instabilidade (alguma UF em laranja/vermelho): aviso após N min seguidos, lembrete a cada 30 min,
// normaliza depois de alguns minutos seguidos limpos.
function intermittentStep(state, key, c, s, now, out) {
  const R = INTERMITTENT_ALERT;
  delete s.hist; // campos de regras antigas
  delete s.cleanN;
  const closeOpen = (end) => {
    const open = openIncident(state, key, c.id, 'int');
    if (open) open.end = Math.max(open.start, end);
  };
  if (s.status === 'OFFLINE') {
    // a queda tem alerta próprio: encerra a instabilidade sem aviso e recomeça a contagem depois do retorno
    if (s.intOn) closeOpen(now);
    Object.assign(s, { intOn: false, badN: 0, okN: 0 });
    return;
  }
  const bad = !!(c.fail || c.problem);
  if (!s.intOn) {
    s.badN = bad ? (s.badN ?? 0) + 1 : 0;
    if (s.badN >= R.startMin) {
      const start = now - (s.badN - 1) * 60000;
      Object.assign(s, { intOn: true, intSince: start, remindAt: now, okN: 0 });
      out.intStart.push(c);
      state.incidents.push({ svc: key, id: c.id, kind: 'int', start, end: null });
    }
    return;
  }
  s.okN = bad ? 0 : (s.okN ?? 0) + 1;
  if (s.okN >= R.clearMin) {
    const end = now - (R.clearMin - 1) * 60000; // primeiro minuto limpo
    out.intEnd.push({ ...c, intMs: Math.max(60000, end - s.intSince), backAt: end });
    Object.assign(s, { intOn: false, badN: 0, okN: 0 });
    closeOpen(end);
  } else if (bad && now - s.remindAt >= REMINDER_MS) {
    s.remindAt = now;
    out.intRemind.push({ ...c, intMs: now - s.intSince });
  }
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
          problem: !!(c.fail || c.problem),
          unknown: !!c.unknown,
          info: c.info,
        })),
      };
    }),
  };
}

// ---------------------------------------------------------------- execução

// "07:30-22:00" => { start: 450, end: 1320 } em minutos do dia (horário de Brasília); vazio = avisa 24h
function parseWindow(s) {
  const m = String(s ?? '').match(/^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/);
  return m ? { start: +m[1] * 60 + +m[2], end: +m[3] * 60 + +m[4] } : null;
}

export async function runMonitor(env, now = Date.now()) {
  const state = (await loadState(env.DB)) ?? { components: {}, sources: {}, incidents: [], outbox: [] };
  const firstRun = !state.startedAt;
  const list = await Promise.all([checkEveo(), checkNfce(now), checkNfe()]);
  const results = Object.fromEntries(list.map((r) => [r.key, r]));

  const items = [];
  for (const key of SERVICE_ORDER) {
    const r = results[key];
    const { down, up, downRemind, intStart, intRemind, intEnd } = applyResult(state, r, now);
    const src = sourceHealth(state, r, now);
    if (firstRun) continue; // primeira execução só registra o estado atual
    if (down.length) items.push(downEmbed(key, r, down, state, now));
    if (up.length) items.push(upEmbed(key, r, up, state, now));
    if (downRemind.length) items.push(downRemindEmbed(key, r, downRemind, state, now));
    if (intStart.length) items.push(intStartEmbed(key, r, intStart, state, now));
    if (intRemind.length) items.push(intRemindEmbed(key, r, intRemind, state, now));
    if (intEnd.length) items.push(intEndEmbed(key, r, intEnd, state, now));
    if (src) items.push(sourceEmbed(key, r, state.sources[key], now, src === 'down'));
  }

  // Horário comercial: fora dele o monitor continua registrando tudo, mas não avisa no Discord.
  const { dateKey, hour, minute } = brtParts(now);
  const win = parseWindow(env.ALERT_HOURS);
  const mins = hour * 60 + minute;
  const inHours = !win || (mins >= win.start && mins < win.end);
  if (!inHours) items.length = 0;

  // Abertura do expediente: um resumo só se algo aconteceu fora do horário ou ainda está com problema.
  if (win && inHours && mins - win.start < 30 && state.lastOpening !== dateKey) {
    state.lastOpening = dateKey;
    const nightMin = 24 * 60 - (win.end - win.start);
    const nightStart = now - (mins - win.start + nightMin) * 60000;
    const opening = firstRun ? null : openingItems(results, state, now, nightStart);
    if (opening) items.push(...opening);
  }

  // Relatórios nos horários configurados (independem do horário comercial).
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
