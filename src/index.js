// Worker: o cron roda o monitor a cada minuto. Rotas (somente leitura):
//   GET /                      mapa 3D web com filtros NF-e / NFC-e / CT-e
//   GET /api/mapa?doc=nfce     situação de cada UF (nfe, nfce ou cte), usada pelo mapa web
//   GET /api/status            último resultado do monitor em JSON
//   GET /geo.json              geometria dos estados (malha do IBGE)
//   GET /mapa/nfce.png         mapa atual em PNG (idem /mapa/nfe.png), o mesmo enviado ao Discord

import { runMonitor, loadState } from './monitor.js';
import { renderMap } from './map.js';
import { mapaApi, DOCS } from './api.js';
import PAGE from './web/index.html';
import GEO from './web/geo.json';

const json = (data, headers = {}, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

async function statusJson(env) {
  const state = await loadState(env.DB);
  if (!state) return json({ msg: 'O monitor ainda não rodou. Aguarde o primeiro minuto.' });
  return json({
    ativoDesde: new Date(state.startedAt).toISOString(),
    ultimaExecucao: state.lastRun,
    discordWebhookConfigurado: !!env.DISCORD_WEBHOOK_URL,
    mensagensPendentes: state.outbox?.length ?? 0,
    fontes: state.sources,
    incidentes: state.incidents,
  });
}

export default {
  async scheduled(controller, env, ctx) {
    await runMonitor(env, Date.now());
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === '/') {
      return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } });
    }
    if (pathname === '/geo.json') {
      return new Response(JSON.stringify(GEO), {
        headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=86400' },
      });
    }
    if (pathname === '/api/mapa') {
      const doc = url.searchParams.get('doc');
      if (!DOCS[doc]) return json({ erro: 'use doc=nfe, nfce ou cte' }, {}, 400);
      return json(await mapaApi(env, doc), { 'access-control-allow-origin': '*' });
    }
    if (pathname === '/api/status') return statusJson(env);

    const map = pathname.match(/^\/mapa\/(nfce|nfe)\.png$/);
    if (map) {
      const state = await loadState(env.DB);
      return new Response(renderMap(map[1], state?.lastRun?.maps?.[map[1]] ?? {}), {
        headers: { 'content-type': 'image/png', 'cache-control': 'no-store' },
      });
    }
    return new Response('Not found', { status: 404 });
  },
};
