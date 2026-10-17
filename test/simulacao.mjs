// Simulação local com dados REAIS das fontes + falhas injetadas.
// Não envia nada ao Discord: as mensagens são capturadas e gravadas em test/saida-simulacao.json.
// Uso: npm test

import { writeFileSync } from 'node:fs';
import { runMonitor } from '../src/monitor.js';
import { brtParts } from '../src/discord.js';
import { renderMap } from '../src/map.js';

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
      async first() {
        return mem.has(args[0]) ? { v: mem.get(args[0]) } : null;
      },
      async run() {
        if (/^INSERT/i.test(sql)) mem.set(args[0], args[1]);
      },
    };
  },
  async exec() {},
};

// --- fetch: busca real uma vez (cache) e aplica as falhas do cenário atual
const realFetch = globalThis.fetch;
const cache = new Map();
const discord = [];
let faults = new Set();
let simOffset = 0;

async function cached(url, init) {
  if (!cache.has(url)) {
    const res = await realFetch(url, init);
    cache.set(url, { status: res.status, body: await res.text(), type: res.headers.get('content-type') });
  }
  return cache.get(url);
}

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.startsWith('https://discord.test/')) {
    if (init.body instanceof FormData) {
      const payload = JSON.parse(init.body.get('payload_json'));
      for (const [field, file] of init.body.entries()) {
        if (field.startsWith('files[')) {
          const out = `saida/${String(discord.length + 1).padStart(2, '0')}-${file.name}`;
          writeFileSync(new URL(`./${out}`, import.meta.url), Buffer.from(await file.arrayBuffer()));
          (payload.savedFiles ??= []).push(`test/${out}`);
        }
      }
      discord.push(payload);
    } else discord.push(JSON.parse(init.body));
    return new Response('{}', { status: 200 });
  }
  if (faults.has('tecnospeed_fora') && url.includes('tecnospeed')) throw new TypeError('fetch failed (simulado)');

  const c = await cached(url, init);
  let body = c.body;
  if (url.includes('tecnospeed')) {
    // relógio simulado: empurra as medições junto com o tempo para elas não ficarem "velhas"
    const d = JSON.parse(body);
    d.forEach((p) => (p.datahora = new Date(Date.parse(p.datahora) + simOffset).toISOString()));
    body = JSON.stringify(d);
  }
  if (faults.has('nfce_mt') && url.includes('sefaz_nfce_envio_mt')) {
    const d = JSON.parse(body);
    d.slice(-3).forEach((p) => Object.assign(p, { status: 5, tempo: 32140, erro: 'The operation timed out - URL:https://nfce.sefaz.mt.gov.br/nfcews/services/NfeAutorizacao4' }));
    body = JSON.stringify(d);
  }
  if (faults.has('nfce_svrs') && /sefaz_nfce_envio_(ac|al|ap|ba|ce|df|es|ma|pa|pb|pe|pi|rj|rn|ro|rr|sc|se|to)&/.test(url)) {
    const d = JSON.parse(body);
    d.slice(-4).forEach((p) => Object.assign(p, { status: 5, tempo: 32150, erro: 'The operation timed out - URL:https://nfce.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx' }));
    body = JSON.stringify(d);
  }
  if (faults.has('nfce_go_intermitente') && url.includes('sefaz_nfce_envio_go&')) {
    // alterna falha e sucesso: média dos últimos 15 min em laranja/vermelho, sem 3 falhas seguidas
    const d = JSON.parse(body);
    d.slice(-4).forEach((p, i) => Object.assign(p, [5, 5, 1, 5][i] === 5 ? { status: 5, erro: 'Service Unavailable (503)' } : { status: 1, erro: '' }));
    body = JSON.stringify(d);
  }
  if (faults.has('nfce_go_1falha') && url.includes('sefaz_nfce_envio_go&')) {
    const d = JSON.parse(body);
    d.slice(-1).forEach((p) => Object.assign(p, { status: 5, tempo: 1200, erro: 'Service Unavailable (503)' }));
    body = JSON.stringify(d);
  }
  if (faults.has('nfe_mt') && url.includes('disponibilidade.aspx')) {
    body = body.replace(/(<td>MT<\/td>[\s\S]*?)bola_verde/i, '$1bola_vermelho');
  }
  if (faults.has('eveo_sp1') && url.includes('status.io')) {
    const d = JSON.parse(body);
    const k = d.result.status[0].containers.find((x) => /SP1/.test(x.name));
    Object.assign(k, { status_code: 500, status: 'Service Disruption' });
    body = JSON.stringify(d);
  }
  return new Response(body, { status: c.status, headers: { 'content-type': c.type ?? 'text/plain' } });
};

// --- impressão legível das mensagens
function show(payload) {
  if (payload.content) console.log(`   ${payload.content}`);
  if (payload.savedFiles) console.log(`   📎 ${payload.savedFiles.join(', ')}`);
  for (const e of payload.embeds) {
    console.log(`   ┃ ${e.title}`);
    if (e.description) e.description.split('\n').forEach((l) => console.log(`   ┃ ${l}`));
    for (const f of e.fields ?? []) {
      console.log(`   ┃ [${f.name}]`);
      f.value.split('\n').forEach((l) => console.log(`   ┃   ${l}`));
    }
    console.log('   ┗━━');
  }
}

const env = { DB, DISCORD_WEBHOOK_URL: 'https://discord.test/webhook', REPORT_HOURS: '18', MENTION: '@everyone' };
const log = [];
const BASE = Date.now();
let minute = 0; // cada execução simulada = 1 minuto real, como o cron
const simNow = () => BASE + minute * 60000;

async function step(label, f = [], extraEnv = {}, { quiet = false } = {}) {
  faults = new Set(f);
  simOffset = minute * 60000;
  const before = discord.length;
  const t0 = performance.now();
  const out = await runMonitor({ ...env, ...extraEnv }, simNow());
  minute++;
  const ms = performance.now() - t0;
  const msgs = discord.slice(before);
  if (quiet && !msgs.length) return out;
  console.log(`\n▶ ${label}  →  ${msgs.length} mensagem(ns) | ${ms.toFixed(1)} ms`);
  msgs.forEach(show);
  log.push({ label, faults: f, messages: msgs, ms });
  return out;
}

const first = await step('1. primeira execução (estado atual real)');
for (const s of first.state.lastRun.services) {
  console.log(`   fonte ${s.key}: ${s.ok ? 'OK' : 'FALHA ' + s.error} (${s.ms} ms)` +
    ` | ${s.components.map((c) => `${c.id}=${c.status}${c.problem ? '~' : ''}${c.unknown ? '?' : ''}`).join(' ')}`);
}
await step('2. sem mudanças');
await step('3. MT NFC-e com timeouts + Eveo SP1 fora + MT NF-e vermelho (1ª leitura)', ['nfce_mt', 'eveo_sp1', 'nfe_mt']);
await step('4. falhas continuam (NF-e confirma na 2ª leitura)', ['nfce_mt', 'eveo_sp1', 'nfe_mt']);
await step('5. NFC-e e Eveo normalizam (NF-e ainda vermelho)', ['nfe_mt']);
await step('6. NF-e: 1ª leitura verde');
await step('7. NF-e: 2ª leitura verde, confirma retorno');
await step('7b. SVRS NFC-e cai (19 UFs)', ['nfce_svrs']);
await step('7c. SVRS NFC-e volta');
const inter = await step('7d. GO NFC-e com 1 falha isolada (amarelo/lento como na Tecnospeed, sem alerta)', ['nfce_go_1falha']);
console.log(`   mapa: GO=${inter.state.lastRun.maps.nfce.GO}`);
writeFileSync(new URL('./saida/intermitente-nfce.png', import.meta.url), renderMap('nfce', inter.state.lastRun.maps.nfce));
for (let i = 1; i <= 5; i++) await step(`8.${i} Tecnospeed inacessível`, ['tecnospeed_fora']);
await step('9. Tecnospeed volta');
// Instabilidade: aviso no 5º minuto, lembrete 30 min depois, normaliza após 3 min limpos
for (let i = 1; i <= 36; i++) await step(`11.${i} GO intermitente (minuto ${i})`, ['nfce_go_intermitente'], {}, { quiet: true });
for (let i = 1; i <= 3; i++) await step(`11.${36 + i} GO normal (minuto ${i} limpo)`, [], {}, { quiet: true });
// Queda longa: alerta na hora (com menção) e lembrete a cada 30 min (sem menção)
for (let i = 1; i <= 31; i++) await step(`13.${i} MT NFC-e fora (minuto ${i})`, ['nfce_mt'], {}, { quiet: true });
await step('13.32 MT NFC-e volta (recuperação na hora)', [], {}, { quiet: true });
const st = JSON.parse(mem.get('state'));
mem.set('state', JSON.stringify({ ...st, lastReport: null }));
await step('10. relatório agendado (hora atual configurada como hora do relatório)', [], {
  REPORT_HOURS: String(brtParts(simNow()).hour),
});

writeFileSync(new URL('./saida-simulacao.json', import.meta.url), JSON.stringify(log, null, 2));
const times = log.slice(1).map((x) => x.ms);
console.log(`\nTempo por execução com respostas em cache (≈ CPU): média ${(times.reduce((a, b) => a + b) / times.length).toFixed(1)} ms, máx ${Math.max(...times).toFixed(1)} ms`);
