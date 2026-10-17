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

function nfceGroup(a, byUf, now) {
  const R = NFCE_RULE;
  const base = { id: a.id, name: incidentName(a), label: autorizadorLabel(a) };
  const probes = a.ufs
    .flatMap((uf) =>
      (byUf[uf] ?? []).map((p) => ({
        uf,
        t: Date.parse(p.datahora),
        status: Number(p.status),
        tempo: Number(p.tempo),
        erro: p.erro,
      })),
    )
    .filter((p) => Number.isFinite(p.t));
  if (!probes.length) return { ...base, unknown: true, info: ['sem dados da Tecnospeed'] };

  const last = Math.max(...probes.map((p) => p.t));
  const ageMin = (now - last) / 60000;
  if (ageMin > R.staleMin) return { ...base, unknown: true, info: [`sem medição nova há ${Math.round(ageMin)} min`] };

  const win = probes.filter((p) => p.t > last - R.windowMin * 60000);
  const fails = win.filter((p) => p.status >= 4);
  const ratio = win.length ? fails.length / win.length : 0;
  const enough = win.length >= R.minProbes;

  const info = [];
  if (fails.length) {
    const ufs = [...new Set(fails.map((p) => p.uf))];
    info.push(
      `${fails.length} de ${win.length} envios com falha nos últimos ${R.windowMin} min` +
        (a.ufs.length > 1 ? ` (${ufs.join(', ')})` : ''),
    );
    info.push(`Último erro: ${shortError(fails.reduce((x, y) => (y.t > x.t ? y : x)))}`);
  }

  const slow = win.filter((p) => p.status === 3).length;
  if (win.length && slow / win.length >= R.slowRatio) info.push(`${slow} de ${win.length} envios muito lentos (> 5s)`);

  const fail = enough && fails.length >= R.downMinFails && ratio >= R.downRatio;
  const unstable = !fail && fails.length >= R.downMinFails && ratio > R.unstableRatio;
  const intermittent =
    !fail && !unstable && enough && ((fails.length >= 1 && ratio >= R.intermittentRatio) || slow / win.length >= R.slowRatio);
  return {
    ...base,
    fail,
    ok: enough && ratio <= R.upRatio,
    unstable,
    intermittent,
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

      // com falha: algum serviço secundário fora; intermitente: serviço principal lento (amarelo secundário é só aviso)
      const unstable = !red.length && side.some((x) => x.value === 'vermelho');
      const intermittent = !red.length && !unstable && yellow.length > 0;
      return { ...base, fail: red.length > 0, ok: !red.length, unstable, intermittent, info };
    });
    return { key: 'nfe', ok: true, ms, verificado, components };
  } catch (e) {
    return failed('nfe', e, Date.now() - t0);
  }
}
