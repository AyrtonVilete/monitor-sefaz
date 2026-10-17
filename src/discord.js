// Mensagens do Discord no mesmo formato do bot antigo, mais o envio via webhook.

import { SERVICES, SERVICE_ORDER, MASS_FAILURE_MIN, TZ, NFCE_AUTORIZADORES, NFE_AUTORIZADORES } from './config.js';
import { renderMap } from './map.js';

const COLORS = { green: 0x57f287, red: 0xed4245, yellow: 0xfee75c };
const MAP_SERVICES = { nfce: NFCE_AUTORIZADORES, nfe: NFE_AUTORIZADORES };
const FOOTER = { text: 'Monitor de Serviços • Cloudflare 24/7' };
const BADGE = { ONLINE: '✅ `ONLINE`', OFFLINE: '🔴 `OFFLINE`' };

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
  hourCycle: 'h23',
});

export const fmtTime = (ms) => timeFmt.format(ms);

export function brtParts(ms) {
  const p = Object.fromEntries(partsFmt.formatToParts(ms).map((x) => [x.type, x.value]));
  return { dateKey: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
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

function okLine(key, r, state) {
  const ok = r.components.filter((c) => statusOf(state, key, c) === 'ONLINE');
  if (key === 'eveo') return ok[0]?.info?.[0] ?? 'DCs SP1/SP2 operacionais';
  return `${ok.length} autorizador(es) OK: ${ok.map((c) => c.label).join(', ') || '—'}`;
}

// Cor de cada UF no mapa = situação do autorizador que atende a UF.
export function ufStatuses(key, r, state) {
  const out = {};
  for (const a of MAP_SERVICES[key]) {
    const c = r.components.find((x) => x.id === a.id);
    let v = 'semdados';
    if (state.components[`${key}:${a.id}`]?.status === 'OFFLINE') v = 'fora';
    else if (r.ok && c && !c.unknown) v = c.fail || c.unstable ? 'falha' : c.intermittent ? 'intermitente' : 'ok';
    for (const uf of a.ufs) out[uf] = v;
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
  const stillDown = r.components.filter((c) => statusOf(state, key, c) === 'OFFLINE');
  const lines = comps.map((c) => `${c.name} voltou após ${fmtDur(c.downMs)}.`);
  lines.push(okLine(key, r, state));
  if (stillDown.length) lines.push(`❌ Ainda fora: ${stillDown.map((c) => c.label).join(', ')}`);
  return withMap(
    {
      mention: false,
      embed: {
        title: stillDown.length ? '🟡 Recuperação Parcial' : '✅ Serviço Recuperado',
        description: stillDown.length
          ? 'Parte do serviço voltou, mas ainda há autorizador fora.'
          : 'O serviço voltou a operar normalmente.',
        color: stillDown.length ? COLORS.yellow : COLORS.green,
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

function incidentSummary(state, now) {
  const since = now - 24 * 3600e3;
  const groups = new Map();
  for (const i of state.incidents.filter((x) => (x.end ?? now) >= since)) {
    const k = `${SERVICES[i.svc]?.short ?? i.svc} ${i.id}`;
    const g = groups.get(k) ?? { n: 0, ms: 0, open: false };
    g.n++;
    g.ms += (i.end ?? now) - Math.max(i.start, since);
    g.open ||= !i.end;
    groups.set(k, g);
  }
  if (!groups.size) return 'Nenhuma queda registrada.';
  return [...groups]
    .map(([k, g]) => `• ${k}: ${g.n} queda(s), ${fmtDur(g.ms)} fora${g.open ? ' (em andamento)' : ''}`)
    .join('\n');
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

function reportEmbed(results, state, now, { startup = false } = {}) {
  const fields = [];
  let problems = 0;
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
      if (off.length) {
        head = '🔴 **OFFLINE**';
        problems++;
        for (const c of off) lines.push(`❌ Fora: ${c.id}${c.info?.length ? ` — ${c.info.join('; ')}` : ''}`);
      }
      lines.push(okLine(key, r, state));
      for (const c of r.components) {
        if (statusOf(state, key, c) === 'ONLINE' && c.unstable) lines.push(`⚠️ Com falha: ${c.id} — ${c.info.join('; ')}`);
        else if (statusOf(state, key, c) === 'ONLINE' && c.intermittent) lines.push(`〰️ Intermitente: ${c.id} — ${c.info.join('; ')}`);
        if (c.unknown) lines.push(`❔ Sem dados: ${c.id} — ${c.info.join('; ')}`);
      }
    }
    const resp = `Resposta: ${code(fmtMs(r.tempoMs ?? r.ms))} • Verificado: ${code(fmtTime(now))}`;
    fields.push({ name: svc.name, value: clip(`${head}\n${resp}\n${quote(lines)}`) });
  }
  fields.push({ name: '📉 Quedas nas últimas 24h', value: clip(incidentSummary(state, now)) });

  const summary = problems ? `⚠️ ${problems} serviço(s) com problema.` : '✅ Todos os serviços operacionais.';
  const sub = startup
    ? '🚀 *Monitor ativado: rodando 24/7 na nuvem (Cloudflare).*'
    : `📅 *Relatório das ${brtParts(now).hour}h*`;
  return {
    mention: false,
    embed: {
      title: '📋 Relatório de Status',
      description: `${summary}\n${sub}`,
      color: problems ? COLORS.yellow : COLORS.green,
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
