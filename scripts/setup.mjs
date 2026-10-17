// Cria o banco D1 (se ainda não existir), grava o database_id no wrangler.toml e publica o Worker.
// Pré-requisito: npx wrangler login

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const DB_NAME = 'monitor-sefaz';
const TOML = new URL('../wrangler.toml', import.meta.url);
const run = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const findDb = () => JSON.parse(run('npx wrangler d1 list --json')).find((d) => d.name === DB_NAME)?.uuid;

let toml = readFileSync(TOML, 'utf8');
if (toml.includes('PREENCHIDO_PELO_SETUP')) {
  let id = findDb();
  if (!id) {
    console.log(`Criando o banco D1 "${DB_NAME}"...`);
    run(`npx wrangler d1 create ${DB_NAME}`);
    id = findDb();
  }
  if (!id) throw new Error(`Não encontrei o D1 "${DB_NAME}". Rode "npx wrangler d1 list" e preencha o database_id no wrangler.toml.`);
  toml = toml.replace('PREENCHIDO_PELO_SETUP', id);
  writeFileSync(TOML, toml);
  console.log(`database_id gravado no wrangler.toml: ${id}`);
}

console.log('Publicando o Worker...');
execSync('npx wrangler deploy', { stdio: 'inherit' });
console.log('\nPronto. Falta só o webhook do Discord: npx wrangler secret put DISCORD_WEBHOOK_URL');
