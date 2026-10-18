// Mensagens do Discord no mesmo formato do bot antigo, mais o envio via webhook.

import {
  SERVICES,
  SERVICE_ORDER,
  MASS_FAILURE_MIN,
  TZ,
  NFCE_AUTORIZADORES,
  NFE_AUTORIZADORES,
  INTERMITTENT_ALERT,
  CONFIRM_UP,
} from './config.js';
import { renderMap } from './map.js';

const COLORS = { green: 0x57f287, red: 0xed4245, yellow: 0xfee75c, orange: 0xe67e22 };
const MAP_SERVICES = { nfce: NFCE_AUTORIZADORES, nfe: NFE_AUTORIZADORES };
const FOOTER = { text: 'Monitor de Serviços • Cloudflare 24/7' };
const BADGE = {
  ONLINE: '✅ `ONLINE`',
  OFFLINE: '🔴 `OFFLINE`',
  NORMAL: '✅ `NORMAL`',
  INTERMITENTE: '🟠 `INTERMITENTE`',
};

const timeFmt = new Intl.DateTimeFormat('pt-BR', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
const partsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const hmFmt = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export const fmtTime = (ms) => timeFmt.format(ms);
const fmtHM = (ms) => hmFmt.format(ms);

export function brtParts(ms) {
  const p = Object.fromEntries(partsFmt.formatToParts(ms).map((x) => [x.type, x.value]));
  return { dateKey: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}

export function fmtDur(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}

function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  return ms >= 10000 ? `${(ms / 1000).toFixed(1).replace('.', ',')}s` : `${Math.round(ms)}ms`;
}

const code = (s) => `\`${s}\``;
const clip = (s, n = 1024) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const quote = (lines) => lines.map((l) => `> ${l}`).join('\n');
const statusOf = (state, key, c) => state.components[`${key}:${c.id}`]?.status;

// Autorizador normal = no ar e sem nenhuma UF em laranja/vermelho.
const isNormal = (state, key, c) => statusOf(state, key, c) === 'ONLINE' && !c.unknown && !c.fail && !c.problem;

function okLine(key, r, state) {
  const ok = r.components.filter((c) => isNormal(state, key, c));
  if (key === 'eveo') return ok[0]?.info?.[0] ?? 'DCs SP1/SP2 operacionais';
  return `${ok.length} autorizador(es) normais: ${ok.map((c) => c.label).join(', ') || '—'}`;
}

// O que ainda está com problema no serviço (para não dizer "normalizado" com estado em vermelho).
function stillBad(key, r, state) {
  return {
    fora: r.components.filter((c) => statusOf(state, key, c) === 'OFFLINE').map((c) => c.id),
    instavel: r.components.filter((c) => statusOf(state, key, c) === 'ONLINE' && (c.fail || c.problem)).map((c) => c.id),
  };
}

function badLines({ fora, instavel }) {
  const lines = [];
  if (fora.length) lines.push(`❌ Ainda fora: ${fora.join(', ')}`);
  if (instavel.length) lines.push(`🟠 Ainda instável: ${instavel.join(', ')}`);
  return lines;
}

// Cor de cada UF no mapa: queda confirmada => cinza; senão, a cor da UF calculada como na Tecnospeed.
export function ufStatuses(key, r, state) {
  const out = {};
  for (const a of MAP_SERVICES[key]) {
    const c = r.components.find((x) => x.id === a.id);
    const offline = state.components[`${key}:${a.id}`]?.status === 'OFFLINE';
    for (const uf of a.ufs) {
      out[uf] = offline ? 'fora' : r.ok && c && !c.unknown ? (c.ufColors?.[uf] ?? 'semdados') : 'semdados';
    }
  }
  return out;
}

// Anexo do mapa + campo com as UFs por situação (só para os serviços SEFAZ).
function withMap(item, key, r, state) {
  if (!MAP_SERVICES[key]) return item;
  const ufs = ufStatuses(key, r, state);
  const of = (v) => Object.keys(ufs).filter((u) => ufs[u] === v).sort();
  const lines = [];
  if (of('fora').length) lines.push(`**Fora do ar:** ${of('fora').join(', ')}`);
  if (of('falha').length) lines.push(`**Com falha:** ${of('falha').join(', ')}`);
  if (of('intermitente').length) lines.push(`**Intermitente:** ${of('intermitente').join(', ')}`);
  if (of('lento').length) lines.push(`**Lento:** ${of('lento').join(', ')}`);
  if (of('semdados').length) lines.push(`**Sem dados:** ${of('semdados').join(', ')}`);
  const name = `mapa-${key}.png`;
  item.embed.fields?.push({ name: '🗺️ Estados', value: clip(lines.join('\n') || 'Todos os estados OK.') });
  item.embed.image = { url: `attachment://${name}` };
  item.files = [{ name, service: key, ufs }];
  return item;
}

function changeFields(key, r, comps, from, to) {
  return [
    { name: '🖥️ Serviço', value: code(SERVICES[key].name), inline: true },
    { name: '🔄 Mudança', value: `${BADGE[from]} → ${BADGE[to]}`, inline: true },
    { name: '⏱️ Tempo de Resposta', value: code(fmtMs(comps[0]?.tempoMs ?? r.ms)), inline: true },
  ];
}

export function downEmbed(key, r, comps, state, now) {
  const lines = comps.map((c) => {
    const head = `Incidente: ${SERVICES[key].short}: ${c.name} (Offline)`;
    return c.info?.length ? `${head}\n${quote(c.info)}` : head;
  });
  if (key === 'nfce' && r.components.filter((c) => c.fail).length >= MASS_FAILURE_MIN) {
    lines.push('⚠️ Vários autorizadores falhando ao mesmo tempo: pode ser instabilidade na própria Tecnospeed.');
  }
  return withMap(
    {
      mention: true,
      embed: {
        title: '🔴 Serviço Fora do Ar',
        description: 'O serviço não está respondendo ou retornou um erro.',
        color: COLORS.red,
        fields: [...changeFields(key, r, comps, 'ONLINE', 'OFFLINE'), { name: '📋 Detalhe', value: clip(lines.join('\n')) }],
        footer: FOOTER,
        timestamp: new Date(now).toISOString(),
      },
    },
    key,
    r,
    state,
  );
}

export function upEmbed(key, r, comps, state, now) {
  const bad = stillBad(key, r, state);
  const partial = bad.fora.length + bad.instavel.length > 0;
  const stable = CONFIRM_UP[key] ?? 1;
  const lines = comps.map((c) => `${c.name} voltou às ${fmtHM(c.backAt ?? now)}, depois de ${fmtDur(c.downMs)} fora.`);
  lines.push(okLine(key, r, state), ...badLines(bad));
  return withMap(
    {
      mention: false,
      embed: {
        title: partial ? '🟡 Recuperação Parcial' : '✅ Serviço Recuperado',
        description: partial
          ? `${comps.map((c) => c.id).join(', ')} voltou e está estável há ${stable} min, mas o serviço ainda tem estados com problema (veja o mapa).`
          : `O serviço voltou e está estável há ${stable} min.`,
        color: partial ? COLORS.yellow : COLORS.green,
        fields: [...changeFields(key, r, comps, 'OFFLINE', 'ONLINE'), { name: '📋 Detalhe', value: clip(lines.join('\n')) }],
        footer: FOOTER,
        timestamp: new Date(now).toISOString(),
      },
    },
    key,
    r,
    state,
  );
}

// Lembretes: sem menção, com o mapa, a cada REMINDER_MIN enquanto o problema continuar.
function remindItem(key, r, comps, state, now, { title, description, color, badge, lineOf }) {
  const lines = comps.map((c) => (c.info?.length ? `${lineOf(c)}\n${quote(c.info)}` : lineOf(c)));
  return withMap(
    {
      mention: false,
      embed: {
        title,
        description,
        color,
        fields: [
          { name: '🖥️ Serviço', value: code(SERVICES[key].name), inline: true },
          { name: '🔄 Situação', value: badge, inline: true },
          { name: '⏱️ Tempo de Resposta', value: code(fmtMs(comps[0]?.tempoMs ?? r.ms)), inline: true },
          { name: '📋 Detalhe', value: clip(lines.join('\n')) },
        ],
        footer: FOOTER,
        timestamp: new Date(now).toISOString(),
      },
    },
    key,
    r,
    state,
  );
}

export function downRemindEmbed(key, r, comps, state, now) {
  return remindItem(key, r, comps, state, now, {
    title: '🔴 Continua Fora do Ar',
    description: `O serviço segue sem responder há ${fmtDur(comps[0].downMs)}.`,
    color: COLORS.red,
    badge: `${BADGE.OFFLINE} há ${fmtDur(comps[0].downMs)}`,
    lineOf: (c) => `Ainda fora: ${SERVICES[key].short}: ${c.name} (há ${fmtDur(c.downMs)})`,
  });
}

export function intRemindEmbed(key, r, comps, state, now) {
  return remindItem(key, r, comps, state, now, {
    title: '🟠 Instabilidade Continua',
    description: `O autorizador segue intermitente há ${fmtDur(comps[0].intMs)}, mas ainda não caiu.`,
    color: COLORS.orange,
    badge: `${BADGE.INTERMITENTE} há ${fmtDur(comps[0].intMs)}`,
    lineOf: (c) => `Ainda intermitente: ${SERVICES[key].short}: ${c.name} (há ${fmtDur(c.intMs)})`,
  });
}

// Instabilidade: sem menção, com o mapa (laranja nas UFs afetadas).
export function intStartEmbed(key, r, comps, state, now) {
  const lines = comps.map((c) => {
    const head = `Intermitente: ${SERVICES[key].short}: ${c.name}`;
    return c.info?.length ? `${head}\n${quote(c.info)}` : head;
  });
  return withMap(
    {
      mention: false,
      embed: {
        title: '🟠 Instabilidade Detectada',
        description: `O autorizador está intermitente (alternando falhas, lentidão e envios normais) há ${INTERMITTENT_ALERT.startMin} min, mas ainda não caiu.`,
        color: COLORS.orange,
        fields: [...changeFields(key, r, comps, 'NORMAL', 'INTERMITENTE'), { name: '📋 Detalhe', value: clip(lines.join('\n')) }],
        footer: FOOTER,
        timestamp: new Date(now).toISOString(),
      },
    },
    key,
    r,
    state,
  );
}

export function intEndEmbed(key, r, comps, state, now) {
  const bad = stillBad(key, r, state);
  const partial = bad.fora.length + bad.instavel.length > 0;
  const stable = INTERMITTENT_ALERT.clearMin;
  const lines = comps.map(
    (c) => `${c.name} normalizou às ${fmtHM(c.backAt ?? now)}, depois de ${fmtDur(c.intMs)} instável.`,
  );
  lines.push(okLine(key, r, state), ...badLines(bad));
  return withMap(
    {
      mention: false,
      embed: {
        title: partial ? '🟡 Normalização Parcial' : '✅ Instabilidade Normalizada',
        description: partial
          ? `${comps.map((c) => c.id).join(', ')} está estável há ${stable} min, mas o serviço ainda tem estados com problema (veja o mapa).`
          : `Todos os estados do serviço estão estáveis há ${stable} min.`,
        color: partial ? COLORS.yellow : COLORS.green,
        fields: [...changeFields(key, r, comps, 'INTERMITENTE', 'NORMAL'), { name: '📋 Detalhe', value: clip(lines.join('\n')) }],
        footer: FOOTER,
        timestamp: new Date(now).toISOString(),
      },
    },
    key,
    r,
    state,
  );
}

export function sourceEmbed(key, r, src, now, isDown) {
  const svc = SERVICES[key];
  return {
    mention: false,
    embed: isDown
      ? {
          title: '⚠️ Fonte de Dados Indisponível',
          description: `Não consigo consultar **${svc.source}** há ${fmtDur(now - src.since)}. Os alertas de ${svc.name} ficam suspensos até a fonte voltar.`,
          color: COLORS.yellow,
          fields: [{ name: '📋 Erro', value: clip(code(r.error ?? 'desconhecido')) }],
          footer: FOOTER,
          timestamp: new Date(now).toISOString(),
        }
      : {
          title: '✅ Fonte de Dados Normalizada',
          description: `**${svc.source}** voltou a responder. Alertas de ${svc.name} reativados.`,
          color: COLORS.green,
          footer: FOOTER,
          timestamp: new Date(now).toISOString(),
        },
  };
}

function incidentSummary(state, now, since = now - 24 * 3600e3) {
  const groups = new Map();
  for (const i of state.incidents.filter((x) => (x.end ?? now) >= since)) {
    const kind = i.kind ?? 'down';
    const k = `${SERVICES[i.svc]?.short ?? i.svc} ${i.id}|${kind}`;
    const g = groups.get(k) ?? { kind, n: 0, ms: 0, open: false, ranges: [] };
    g.n++;
    g.ms += (i.end ?? now) - Math.max(i.start, since);
    g.open ||= !i.end;
    g.ranges.push(`${fmtHM(i.start)}–${i.end ? fmtHM(i.end) : 'agora'}`);
    groups.set(k, g);
  }
  if (!groups.size) return 'Nenhuma queda ou instabilidade registrada.';
  return [...groups]
    .sort(([, a], [, b]) => (a.kind === b.kind ? 0 : a.kind === 'down' ? -1 : 1))
    .map(([k, g]) => {
      const what = g.kind === 'down' ? `🔴 ${g.n} queda(s), ${fmtDur(g.ms)} fora` : `🟠 ${g.n} instabilidade(s), ${fmtDur(g.ms)} instável`;
      const when = g.n <= 2 ? ` (${g.ranges.join(', ')})` : '';
      return `• ${k.split('|')[0]}: ${what}${when}${g.open ? ' — em andamento' : ''}`;
    })
    .join('\n');
}

// Abertura do expediente: só manda se algo aconteceu fora do horário ou ainda está com problema.
export function openingItems(results, state, now, nightStart) {
  const night = state.incidents.filter((i) => (i.end ?? now) >= nightStart);
  const comps = SERVICE_ORDER.flatMap((k) => results[k].components.map((c) => state.components[`${k}:${c.id}`] ?? {}));
  const offline = comps.some((s) => s.status === 'OFFLINE');
  const unstable = comps.some((s) => s.intOn);
  const sourceDown = Object.values(state.sources ?? {}).some((s) => s.alerted);
  if (!night.length && !offline && !unstable && !sourceDown) return null;
  const items = reportItems(results, state, now, { opening: nightStart });
  items[0].mention = offline; // queda que começou fora do horário: é o primeiro aviso dela
  return items;
}

// Relatório + um embed de mapa por serviço SEFAZ (NFC-e e NF-e).
export function reportItems(results, state, now, opts = {}) {
  const report = reportEmbed(results, state, now, opts);
  const maps = Object.keys(MAP_SERVICES).map((key) => {
    const name = `mapa-${key}.png`;
    return {
      mention: false,
      embed: { color: report.embed.color, image: { url: `attachment://${name}` } },
      files: [{ name, service: key, ufs: ufStatuses(key, results[key], state) }],
    };
  });
  return [report, ...maps];
}

function reportEmbed(results, state, now, { startup = false, opening = null } = {}) {
  const fields = [];
  let problems = 0;
  let instabilities = 0;
  for (const key of SERVICE_ORDER) {
    const r = results[key];
    const svc = SERVICES[key];
    const off = r.components.filter((c) => statusOf(state, key, c) === 'OFFLINE');
    const lines = [];
    let head = '✅ **ONLINE**';
    if (!r.ok) {
      head = '⚠️ **SEM DADOS**';
      lines.push(`Fonte indisponível (${svc.source}): ${r.error}`);
      problems++;
    } else {
      const unstable = r.components.filter((c) => statusOf(state, key, c) === 'ONLINE' && (c.fail || c.problem));
      if (off.length) {
        head = '🔴 **OFFLINE**';
        problems++;
        for (const c of off) lines.push(`❌ Fora: ${c.id}${c.info?.length ? ` — ${c.info.join('; ')}` : ''}`);
      } else if (unstable.length) {
        head = '🟠 **INSTÁVEL**';
        instabilities++;
      }
      lines.push(okLine(key, r, state));
      for (const c of unstable) lines.push(`🟠 Instável: ${c.id} — ${c.info.join('; ')}`);
      for (const c of r.components) if (c.unknown) lines.push(`❔ Sem dados: ${c.id} — ${c.info.join('; ')}`);
    }
    const resp = `Resposta: ${code(fmtMs(r.tempoMs ?? r.ms))} • Verificado: ${code(fmtTime(now))}`;
    fields.push({ name: svc.name, value: clip(`${head}\n${resp}\n${quote(lines)}`) });
  }
  fields.push(
    opening
      ? { name: `🌙 Fora do horário (desde ${fmtHM(opening)})`, value: clip(incidentSummary(state, now, opening)) }
      : { name: '📉 Últimas 24h', value: clip(incidentSummary(state, now)) },
  );

  const summary = problems
    ? `⚠️ ${problems} serviço(s) com problema.`
    : instabilities
      ? `🟠 Todos os serviços no ar, ${instabilities} com instabilidade.`
      : '✅ Todos os serviços operacionais.';
  const sub = startup
    ? '🚀 *Monitor ativado: rodando 24/7 na nuvem (Cloudflare).*'
    : opening
      ? '☀️ *Situação no início do expediente e o que aconteceu fora do horário.*'
      : `📅 *Relatório das ${brtParts(now).hour}h*`;
  return {
    mention: false,
    embed: {
      title: opening ? '☀️ Abertura do Expediente' : '📋 Relatório de Status',
      description: `${summary}\n${sub}`,
      color: problems ? COLORS.yellow : instabilities ? COLORS.orange : COLORS.green,
      fields,
      footer: FOOTER,
      timestamp: new Date(now).toISOString(),
    },
  };
}

// Junta os embeds da execução em mensagens de até 10 embeds; menciona só se houver queda.
export function toPayloads(items, mention) {
  const payloads = [];
  for (let i = 0; i < items.length; i += 10) {
    const chunk = items.slice(i, i + 10);
    const ping = mention && chunk.some((x) => x.mention);
    // mesmo mapa citado por dois embeds da mensagem: anexa uma vez só (o último estado vale)
    const files = [...new Map(chunk.flatMap((x) => x.files ?? []).map((f) => [f.name, f])).values()];
    payloads.push({
      ...(ping ? { content: mention, allowed_mentions: { parse: ['everyone', 'roles', 'users'] } } : {}),
      embeds: chunk.map((x) => x.embed),
      ...(files.length ? { files } : {}),
    });
  }
  return payloads;
}

// Os mapas são guardados na fila só como { service, ufs } e viram PNG na hora do envio.
// Se a imagem falhar, a mensagem segue sem o mapa: o alerta nunca pode travar por causa dele.
function requestBody(payload) {
  const { files, ...body } = payload;
  const asJson = (b) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  if (!files?.length) return asJson(body);
  try {
    const form = new FormData();
    form.append('payload_json', JSON.stringify({ ...body, attachments: files.map((f, i) => ({ id: i, filename: f.name })) }));
    files.forEach((f, i) => form.append(`files[${i}]`, new Blob([renderMap(f.service, f.ufs)], { type: 'image/png' }), f.name));
    return { body: form };
  } catch (e) {
    console.error(`Mapa: ${e.message}; enviando sem imagem`);
    const embeds = body.embeds.map(({ image, ...e }) => e).filter((e) => e.title || e.description || e.fields);
    return asJson({ ...body, embeds });
  }
}

// true = enviado; 'drop' = payload rejeitado pelo Discord (não adianta reenviar); false = tentar de novo depois
export async function sendDiscord(webhookUrl, payload) {
  try {
    const res = await fetch(`${webhookUrl}${webhookUrl.includes('?') ? '&' : '?'}wait=true`, {
      method: 'POST',
      ...requestBody(payload),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) return true;
    console.error(`Discord HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.status === 400 ? 'drop' : false;
  } catch (e) {
    console.error(`Discord: ${e.message}`);
    return false;
  }
}
