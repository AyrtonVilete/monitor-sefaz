// Simulação com relógio: dados reais das fontes "limpos" (tudo normal) + falhas injetadas, minuto a minuto.
// Confere cada mensagem do Discord contra o esperado (horário e título) e sai com erro se algo divergir.
// Não envia nada ao Discord: as mensagens são capturadas e os mapas gravados em test/saida/.
// Uso: npm test

import { writeFileSync, mkdirSync } from 'node:fs';
import { runMonitor } from '../src/monitor.js';

// --- D1 em memória
const mem = new Map();
const DB = {
  prepare(sql) {
    let args = [];
    return {
      bind(...a) {
        args = a;
        return this;
      },
      first: async () => (mem.has(args[0]) ? { v: mem.get(args[0]) } : null),
      run: async () => void (/^INSERT/i.test(sql) && mem.set(args[0], args[1])),
    };
  },
  exec: async () => {},
};

// --- relógio simulado (horário de Brasília = UTC-3)
const REAL0 = Date.now();
const [Y, M, D] = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(REAL0).split('-').map(Number);
const at = (hhmm, day = 0) => {
  const [h, m] = hhmm.split(':').map(Number);
  return Date.UTC(Y, M - 1, D + day, h + 3, m);
};
const hm = (ms) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }).format(ms);
let simNow = at('10:58');

// --- fetch: busca real uma vez (cache), limpa os dados e aplica as falhas do momento
const realFetch = globalThis.fetch;
const cache = new Map();
const events = [];
let faults = new Set();
let saved = 0;
mkdirSync(new URL('./saida/', import.meta.url), { recursive: true });

const SVRS_NFCE = /sefaz_nfce_envio_(ac|al|ap|ba|ce|df|es|ma|pa|pb|pe|pi|rj|rn|ro|rr|sc|se|to)&/;
const setLast = (d, statuses) =>
  d.slice(-statuses.length).forEach((p, i) =>
    Object.assign(p, statuses[i] >= 4 ? { status: statuses[i], tempo: 32100, erro: 'The operation timed out' } : { status: 1, tempo: 300, erro: '' }),
  );

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.startsWith('https://discord.test/')) {
    const payload = init.body instanceof FormData ? JSON.parse(init.body.get('payload_json')) : JSON.parse(init.body);
    if (init.body instanceof FormData) {
      for (const [field, file] of init.body.entries()) {
        if (field.startsWith('files[')) {
          writeFileSync(new URL(`./saida/${String(++saved).padStart(3, '0')}-${file.name}`, import.meta.url), Buffer.from(await file.arrayBuffer()));
        }
      }
    }
    for (const e of payload.embeds) if (e.title) events.push({ time: hm(simNow), title: e.title, mention: !!payload.content, embed: e });
    return new Response('{}', { status: 200 });
  }
  if (faults.has('tecnospeed_fora') && url.includes('tecnospeed')) throw new TypeError('fetch failed (simulado)');

  if (!cache.has(url)) {
    const res = await realFetch(url, init);
    cache.set(url, { status: res.status, body: await res.text(), type: res.headers.get('content-type') });
  }
  const c = cache.get(url);
  let body = c.body;

  if (url.includes('tecnospeed')) {
    const d = JSON.parse(body);
    const shift = simNow - REAL0; // medições "andam" junto com o relógio simulado
    d.forEach((p) => Object.assign(p, { status: 1, tempo: 300, erro: '', datahora: new Date(Date.parse(p.datahora) + shift).toISOString() }));
    if (faults.has('mt_fora') && url.includes('sefaz_nfce_envio_mt&')) setLast(d, [5, 5, 5]);
    if (faults.has('svrs_fora') && SVRS_NFCE.test(url)) setLast(d, [5, 5, 5, 5]);
    if (faults.has('go_intermitente') && url.includes('sefaz_nfce_envio_go&')) setLast(d, [5, 5, 1, 5]);
    body = JSON.stringify(d);
  }
  if (url.includes('disponibilidade.aspx')) body = body.replace(/bola_(amarela|vermelho)/gi, 'bola_verde');
  if (url.includes('status.io')) {
    const d = JSON.parse(body);
    for (const s of d.result.status) for (const k of s.containers ?? []) Object.assign(k, { status_code: 100, status: 'Operational' });
    d.result.incidents = [];
    body = JSON.stringify(d);
  }
  return new Response(body, { status: c.status, headers: { 'content-type': c.type ?? 'text/plain' } });
};

const env = {
  DB,
  DISCORD_WEBHOOK_URL: 'https://discord.test/webhook',
  MENTION: '@everyone',
  REPORT_HOURS: '12,18,22',
  ALERT_HOURS: '07:30-22:00',
};

// roda minuto a minuto até (inclusive) o horário dado, com as falhas indicadas
async function until(hhmm, day, f = []) {
  faults = new Set(f);
  const end = at(hhmm, day);
  while (simNow <= end) {
    await runMonitor(env, simNow);
    simNow += 60000;
  }
}
const jump = (hhmm, day) => (simNow = at(hhmm, day));

// ------------------------------------------------------------ roteiro (dia 0 = hoje)
await until('11:02', 0); // 10:58 primeira execução
await until('11:08', 0, ['mt_fora']); // A. MT cai às 11:03
await until('11:24', 0); //    volta às 11:09: só avisa após 10 min estável (11:18)
await until('11:25', 0, ['mt_fora']); // B. cai de novo às 11:25...
await until('11:30', 0); //    volta 5 min (11:26-11:30): não avisa nada
await until('11:33', 0, ['mt_fora']); //    cai de novo antes de completar 10 min
await until('11:49', 0); //    volta às 11:34 e fica estável: avisa às 11:43
await until('12:21', 0, ['svrs_fora']); // C. SVRS cai às 11:50, relatório das 12h, lembrete às 12:20
await until('12:39', 0); //    volta às 12:22, avisa às 12:31
await until('12:46', 0, ['go_intermitente']); // D. GO intermitente: aviso no 5º minuto (12:44)
await until('12:59', 0); //    normaliza após 10 min limpos (12:56)
await until('13:04', 0, ['tecnospeed_fora']); // E. Tecnospeed inacessível 5 min
await until('13:06', 0);
jump('21:55', 0);
await until('22:09', 0); // F. relatório das 22h
await until('22:40', 0, ['mt_fora']); //    queda fora do horário: não avisa
await until('22:55', 0);
jump('06:45', 1);
await until('06:49', 1);
await until('07:40', 1, ['svrs_fora']); // G. SVRS cai às 06:50 (fora do horário); abertura às 07:30
await until('07:55', 1); //    volta às 07:41, avisa às 07:50
jump('07:28', 2);
await until('07:35', 2); // H. noite tranquila: sem abertura

// ------------------------------------------------------------ conferência
const expected = [
  ['10:58', '📋 Relatório de Status'],
  ['11:03', '🔴 Serviço Fora do Ar', true],
  ['11:18', '✅ Serviço Recuperado'],
  ['11:25', '🔴 Serviço Fora do Ar', true],
  ['11:43', '✅ Serviço Recuperado'],
  ['11:50', '🔴 Serviço Fora do Ar', true],
  ['12:00', '📋 Relatório de Status'],
  ['12:20', '🔴 Continua Fora do Ar'],
  ['12:31', '✅ Serviço Recuperado'],
  ['12:44', '🟠 Instabilidade Detectada'],
  ['12:56', '✅ Instabilidade Normalizada'],
  ['13:04', '⚠️ Fonte de Dados Indisponível'],
  ['13:05', '✅ Fonte de Dados Normalizada'],
  ['22:00', '📋 Relatório de Status'],
  ['07:30', '☀️ Abertura do Expediente', true],
  ['07:50', '✅ Serviço Recuperado'],
];

let fail = 0;
const n = Math.max(expected.length, events.length);
console.log('hora   menção  mensagem');
for (let i = 0; i < n; i++) {
  const e = events[i];
  const [t, title, mention = false] = expected[i] ?? [];
  const ok = e && e.time === t && e.title === title && e.mention === mention;
  if (!ok) fail++;
  const detail = e?.embed.fields?.find((f) => f.name === '📋 Detalhe' || f.name.startsWith('🌙'))?.value.split('\n')[0] ?? '';
  console.log(
    `${ok ? '✔' : '✘'} ${e ? `${e.time}  ${e.mention ? '@all ' : '     '}  ${e.title}  ${detail ? `— ${detail}` : ''}` : '(faltou)'}` +
      (ok ? '' : `   ← esperado: ${t ?? '(nenhuma)'} ${title ?? ''}${mention ? ' (@all)' : ''}`),
  );
}
console.log(`\n${events.length} mensagens; ${fail ? `${fail} divergência(s)` : 'tudo conforme o esperado'}.`);
writeFileSync(new URL('./saida-simulacao.json', import.meta.url), JSON.stringify(events, null, 2));
if (fail) process.exitCode = 1;
