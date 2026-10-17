// Consulta das fontes. Cada check nunca lança erro: devolve { ok: false, error } quando a fonte falha.

import {
  UA,
  TECNOSPEED_URL,
  PORTAL_NFE_URLS,
  EVEO_STATUS_URL,
  NFCE_AUTORIZADORES,
  NFE_AUTORIZADORES,
  NFE_CORE_COLUMNS,
  NFCE_RULE,
  autorizadorLabel,
  incidentName,
} from './config.js';

async function get(url, headers = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, ...headers },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

function failed(key, error, ms) {
  return { key, ok: false, error: String(error?.message ?? error), ms, components: [] };
}

function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// ---------------------------------------------------------------- Eveo (Status.io)

export async function checkEveo() {
  const t0 = Date.now();
  try {
    const { result } = await (await get(EVEO_STATUS_URL)).json();
    const ms = Date.now() - t0;
    const dcs = (result?.status ?? []).flatMap((c) =>
      (c.containers ?? [])
        .filter((k) => /\bSP[12]\b/.test(k.name))
        .map((k) => ({ servico: c.name, dc: k.name, code: k.status_code, status: k.status })),
    );
    if (!dcs.length) throw new Error('nenhum DC SP1/SP2 na resposta do Status.io');

    const bad = dcs.filter((d) => d.code !== 100);
    const info = bad.length
      ? bad.map((d) => `${d.servico} – ${d.dc}: ${d.status}`)
      : [`${dcs.length} DC(s) operacionais`];
    for (const i of result.incidents ?? []) info.push(`Incidente Eveo: ${i.name ?? i.title ?? 'sem título'}`);

    const component = { id: 'SP1/SP2', name: 'SP1/SP2', label: 'SP1/SP2', fail: bad.length > 0, ok: !bad.length, info };
    return { key: 'eveo', ok: true, ms, components: [component] };
  } catch (e) {
    return failed('eveo', e, Date.now() - t0);
  }
}

// ---------------------------------------------------------------- NFC-e (Tecnospeed)

function shortError(p) {
  if (p.erro) return p.erro.split(' - URL:')[0].trim().slice(0, 120);
  return p.status === 4 ? 'Timeout (> 30s)' : 'Erro';
}

// Cor da UF pelo nível da Tecnospeed (média truncada dos status dos últimos 15 min).
const COLOR_BY_LEVEL = { 1: 'ok', 2: 'lento', 3: 'intermitente', 4: 'falha', 5: 'falha' };
const isFail = (p) => p.status >= 4;
const fmtAvg = (n) => n.toFixed(2).replace('.', ',');

function nfceUf(uf, raw, now) {
  const R = NFCE_RULE;
  const probes = (raw ?? [])
    .map((p) => ({ uf, t: Date.parse(p.datahora), status: Number(p.status), tempo: Number(p.tempo), erro: p.erro }))
    .filter((p) => Number.isFinite(p.t) && p.status >= 1)
    .sort((x, y) => x.t - y.t);
  const latest = probes.at(-1);
  if (!latest || now - latest.t > R.staleMin * 60000) return { uf, unknown: true };

  const win = probes.filter((p) => p.t > now - R.windowMin * 60000);
  if (!win.length) win.push(latest);
  const avg = win.reduce((s, p) => s + p.status, 0) / win.length;
  return {
    uf,
    avg,
    level: Math.min(5, Math.max(1, Math.trunc(avg))),
    win,
    down: probes.length >= R.downConsecutive && probes.slice(-R.downConsecutive).every(isFail),
    up: probes.length >= R.upConsecutive && probes.slice(-R.upConsecutive).every((p) => !isFail(p)),
  };
}

function nfceGroup(a, byUf, now) {
  const R = NFCE_RULE;
  const base = { id: a.id, name: incidentName(a), label: autorizadorLabel(a) };
  const ufs = a.ufs.map((uf) => nfceUf(uf, byUf[uf], now));
  const known = ufs.filter((u) => !u.unknown);
  if (!known.length) return { ...base, unknown: true, info: ['sem envios recentes na Tecnospeed'] };

  // queda: N envios seguidos falhando (no SVRS, em pelo menos metade das UFs); retorno: 2 envios seguidos OK
  const down = known.filter((u) => u.down);
  const fail = down.length > 0 && down.length / known.length >= R.downUfShare;
  const ok = !fail && known.filter((u) => u.up).length / known.length > 1 - R.downUfShare;
  const problemUfs = known.filter((u) => u.level >= 3);

  const win = known.flatMap((u) => u.win);
  const fails = win.filter(isFail);
  const info = [];
  if (fails.length) {
    const fu = [...new Set(fails.map((p) => p.uf))].sort();
    info.push(
      `${fails.length} de ${win.length} envios com falha nos últimos ${R.windowMin} min` +
        (a.ufs.length > 1 ? ` (${fu.join(', ')})` : ''),
    );
    info.push(`Último erro: ${shortError(fails.reduce((x, y) => (y.t > x.t ? y : x)))}`);
  }
  if (problemUfs.length) {
    info.push(`Média 15 min (Tecnospeed): ${problemUfs.map((u) => `${u.uf} ${fmtAvg(u.avg)}`).join(' · ')}`);
  }
  if (down.length && a.ufs.length > 1) {
    info.push(`${down.length} de ${known.length} UFs com ${R.downConsecutive} falhas seguidas: ${down.map((u) => u.uf).join(', ')}`);
  }
  const noData = ufs.filter((u) => u.unknown).map((u) => u.uf);
  if (noData.length) info.push(`Sem envios recentes: ${noData.join(', ')}`);

  return {
    ...base,
    fail,
    ok,
    problem: !fail && problemUfs.length > 0, // alguma UF em laranja ou vermelho
    ufColors: Object.fromEntries(known.map((u) => [u.uf, COLOR_BY_LEVEL[u.level]])),
    tempoMs: median(win.map((p) => p.tempo)),
    info,
  };
}

export async function checkNfce(now = Date.now()) {
  const t0 = Date.now();
  const ufs = NFCE_AUTORIZADORES.flatMap((a) => a.ufs);
  const settled = await Promise.allSettled(
    ufs.map(async (uf) => {
      const url = `${TECNOSPEED_URL}?last=true&worker_id=sefaz_nfce_envio_${uf.toLowerCase()}&filterStatus=all&by=status`;
      const data = await (await get(url, { accept: 'application/json' })).json();
      if (!Array.isArray(data)) throw new Error('resposta inesperada');
      return data;
    }),
  );
  const ms = Date.now() - t0;

  const byUf = {};
  const errors = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') byUf[ufs[i]] = s.value;
    else errors.push(`${ufs[i]}: ${s.reason?.message ?? s.reason}`);
  });

  const components = NFCE_AUTORIZADORES.map((a) => nfceGroup(a, byUf, now));
  const known = components.filter((c) => !c.unknown);
  if (errors.length > ufs.length / 2 || !known.length) {
    return failed('nfce', errors[0] ?? 'nenhuma medição recente na Tecnospeed', ms);
  }
  return { key: 'nfce', ok: true, ms, tempoMs: median(known.map((c) => c.tempoMs)), components };
}

// ---------------------------------------------------------------- NF-e (Portal Nacional)

function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function norm(s) {
  return decode(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

async function fetchPortal() {
  let lastError;
  for (const url of PORTAL_NFE_URLS) {
    const t0 = Date.now();
    try {
      const html = await (await get(url, { cookie: 'AspxAutoDetectCookieSupport=1' })).text();
      return { html, ms: Date.now() - t0 };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

export async function checkNfe() {
  const t0 = Date.now();
  try {
    const { html, ms } = await fetchPortal();
    const table = html.match(/<table[^>]*tabelaListagemDados[\s\S]*?<\/table>/i)?.[0];
    if (!table) throw new Error('tabela de disponibilidade não encontrada no portal');

    const rows = [...table.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((r) =>
      [...r[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => {
        const ball = c[1].match(/bola_(verde|amarela|vermelho)/i);
        return ball ? ball[1].toLowerCase() : decode(c[1].replace(/<[^>]+>/g, '')).trim();
      }),
    );
    const [header, ...body] = rows;
    const cols = header.map(norm);
    if (!NFE_CORE_COLUMNS.every((c) => cols.includes(c))) throw new Error('colunas do portal mudaram');
    const byId = new Map(body.map((r) => [r[0], r]));
    const verificado = html.match(/Verifica[^:]{0,30}:\s*(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2})/)?.[1];

    const components = NFE_AUTORIZADORES.map((a) => {
      const base = { id: a.id, name: incidentName(a), label: autorizadorLabel(a) };
      const row = byId.get(a.id);
      if (!row) return { ...base, unknown: true, info: ['autorizador não aparece no portal'] };

      const cells = cols.map((c, i) => ({ col: c, title: header[i], value: row[i] })).slice(1);
      const core = cells.filter((x) => NFE_CORE_COLUMNS.includes(x.col));
      const others = cells.filter((x) => !NFE_CORE_COLUMNS.includes(x.col) && x.col !== 'tempomedio');
      const red = core.filter((x) => x.value === 'vermelho');
      const yellow = core.filter((x) => x.value === 'amarela');
      const side = others.filter((x) => x.value === 'vermelho' || x.value === 'amarela');

      const info = [];
      if (red.length) info.push(`Indisponível: ${red.map((x) => x.title).join(', ')}`);
      if (yellow.length) info.push(`Lento: ${yellow.map((x) => x.title).join(', ')}`);
      if (side.length) info.push(`Outros serviços: ${side.map((x) => `${x.title} ${x.value === 'vermelho' ? '🔴' : '🟡'}`).join(', ')}`);

      // com falha: serviço principal ou secundário em vermelho; lento: serviço principal em amarelo (amarelo secundário é só aviso)
      const sideRed = side.some((x) => x.value === 'vermelho');
      const color = red.length || sideRed ? 'falha' : yellow.length ? 'lento' : 'ok';
      return {
        ...base,
        fail: red.length > 0,
        ok: !red.length,
        problem: !red.length && sideRed,
        ufColors: Object.fromEntries(a.ufs.map((uf) => [uf, color])),
        info,
      };
    });
    return { key: 'nfe', ok: true, ms, verificado, components };
  } catch (e) {
    return failed('nfe', e, Date.now() - t0);
  }
}
