// Worker: o cron roda o monitor a cada minuto. Rotas somente leitura:
//   GET /                 último resultado em JSON
//   GET /mapa/nfce.png    mapa atual da NFC-e (idem /mapa/nfe.png)

import { runMonitor, loadState } from './monitor.js';
import { renderMap } from './map.js';

export default {
  async scheduled(controller, env, ctx) {
    await runMonitor(env, Date.now());
  },

  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const map = pathname.match(/^\/mapa\/(nfce|nfe)\.png$/);
    if (pathname !== '/' && !map) return new Response('Not found', { status: 404 });

    const state = await loadState(env.DB);
    if (map) {
      return new Response(renderMap(map[1], state?.lastRun?.maps?.[map[1]] ?? {}), {
        headers: { 'content-type': 'image/png', 'cache-control': 'no-store' },
      });
    }
    if (!state) return Response.json({ msg: 'O monitor ainda não rodou. Aguarde o primeiro minuto.' });
    return new Response(
      JSON.stringify(
        {
          ativoDesde: new Date(state.startedAt).toISOString(),
          ultimaExecucao: state.lastRun,
          discordWebhookConfigurado: !!env.DISCORD_WEBHOOK_URL,
          mensagensPendentes: state.outbox?.length ?? 0,
          fontes: state.sources,
          incidentes: state.incidents,
        },
        null,
        2,
      ),
      { headers: { 'content-type': 'application/json; charset=utf-8' } },
    );
  },
};
