// API do mapa web: situação de cada UF por documento (NF-e, NFC-e, CT-e), com a mesma conta da Tecnospeed.
// O resultado fica ~1 min em cache no D1, para várias pessoas com o mapa aberto não multiplicarem as consultas.

import { NFCE_AUTORIZADORES, NFE_AUTORIZADORES } from './config.js';
import { tecnoUf, fetchTecnoDoc, COLOR_BY_LEVEL, isFail, shortError } from './sources.js';
import { loadState } from './monitor.js';

export const DOCS = { nfe: 'NF-e', nfce: 'NFC-e', cte: 'CT-e' };
const UFS = NFCE_AUTORIZADORES.flatMap((a) => a.ufs).sort();
const AUTORIZADORES = { nfce: NFCE_AUTORIZADORES, nfe: NFE_AUTORIZADORES };
const CACHE_MS = 55000;
// A NF-e de SP tem envios espaçados (~15-30 min): mostra o último envio em vez de "sem dados".
const WEB_STALE_MIN = 60;

async function readCache(db, doc) {
  try {
    const row = await db.prepare('SELECT v FROM kv WHERE k = ?').bind(`mapa:${doc}`).first();
    return row ? JSON.parse(row.v) : null;
  } catch {
    return null;
  }
}

async function writeCache(db, doc, data) {
  try {
    await db
      .prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .bind(`mapa:${doc}`, JSON.stringify(data))
      .run();
  } catch {
    // cache é só otimização
  }
}

export async function mapaApi(env, doc, now = Date.now()) {
  const cached = await readCache(env.DB, doc);
  if (cached && now - Date.parse(cached.geradoEm) < CACHE_MS) return cached;

  const [{ byUf, errors }, state] = await Promise.all([fetchTecnoDoc(doc, UFS), loadState(env.DB)]);
  const autorizadorDe = {};
  for (const a of AUTORIZADORES[doc] ?? []) for (const uf of a.ufs) autorizadorDe[uf] = a.id;

  const ufs = {};
  for (const uf of UFS) {
    const u = tecnoUf(uf, byUf[uf], now, { staleMin: WEB_STALE_MIN });
    const aut = autorizadorDe[uf] ?? null;
    // queda confirmada pelo monitor (a mesma que gerou o alerta no Discord) => cinza
    const fora = !!aut && state?.components?.[`${doc}:${aut}`]?.status === 'OFFLINE';
    const win = u.win ?? [];
    const fails = win.filter(isFail);
    ufs[uf] = {
      status: fora ? 'fora' : u.unknown ? 'semdados' : COLOR_BY_LEVEL[u.level],
      media: u.unknown ? null : Math.round(u.avg * 100) / 100,
      ultimoMs: u.latest?.tempo ?? null,
      ultimoStatus: u.latest?.status ?? null,
      ultimoEnvio: u.latest ? new Date(u.latest.t).toISOString() : null,
      mediaMs: win.length ? Math.round(win.reduce((s, p) => s + p.tempo, 0) / win.length) : null,
      envios: win.length,
      falhas: fails.length,
      ultimoErro: fails.length ? shortError(fails.at(-1)) : null,
      autorizador: aut,
    };
  }

  const data = { doc, nome: DOCS[doc], geradoEm: new Date(now).toISOString(), ufsSemResposta: errors.length, ufs };
  if (errors.length < UFS.length) await writeCache(env.DB, doc, data);
  return data;
}
