// Envia mensagens de TESTE reais para o webhook do .dev.vars: relatório inicial, queda simulada do
// SVRS (NFC-e) e o retorno. Usa dados reais das fontes, sem @everyone.
// Uso: npm run test:discord

import { readFileSync } from 'node:fs';
import { runMonitor } from '../src/monitor.js';

const vars = Object.fromEntries(
  readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
if (!vars.DISCORD_WEBHOOK_URL) throw new Error('Defina DISCORD_WEBHOOK_URL no arquivo .dev.vars');

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

const SVRS = /sefaz_nfce_envio_(ac|al|ap|ba|ce|df|es|ma|pa|pb|pe|pi|rj|rn|ro|rr|sc|se|to)&/;
const TAG = '🧪 **TESTE** do novo monitor SEFAZ (pode ignorar)';
const realFetch = globalThis.fetch;
let svrsFora = false;

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.startsWith('https://discord.com/api/webhooks/')) {
    // marca como teste e garante que ninguém é mencionado
    const mark = (p) => ({ ...p, content: TAG, allowed_mentions: { parse: [] } });
    if (init.body instanceof FormData) {
      const form = new FormData();
      for (const [k, v] of init.body.entries()) {
        if (k === 'payload_json') form.append(k, JSON.stringify(mark(JSON.parse(v))));
        else form.append(k, v, v.name);
      }
      init = { ...init, body: form };
    } else {
      init = { ...init, body: JSON.stringify(mark(JSON.parse(init.body))) };
    }
    return realFetch(input, init);
  }
  const res = await realFetch(input, init);
  if (!svrsFora || !SVRS.test(url)) return res;
  const d = await res.json();
  d.slice(-4).forEach((p) => Object.assign(p, { status: 5, tempo: 32150, erro: 'The operation timed out - URL:https://nfce.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx' }));
  return Response.json(d);
};

const env = { DB, DISCORD_WEBHOOK_URL: vars.DISCORD_WEBHOOK_URL, MENTION: '', REPORT_HOURS: '18' };
for (const [label, fora] of [
  ['relatório inicial', false],
  ['queda simulada do SVRS (NFC-e)', true],
  ['retorno do SVRS', false],
]) {
  svrsFora = fora;
  const out = await runMonitor(env, Date.now());
  console.log(`${label}: ${out.sent} mensagem(ns) enviada(s), ${out.pending} pendente(s)`);
}
