# Monitor SEFAZ / Eveo: 24/7 na nuvem

Substitui o bot do Discord que dependia de um computador ligado. Roda como **Cloudflare Worker** (plano grátis), a cada 1 minuto, e posta no Discord no mesmo formato do bot antigo:

- 🔴 **Serviço Fora do Ar** (com `@everyone`) quando um autorizador cai
- ✅ **Serviço Recuperado** quando volta, com o tempo que ficou fora
- 📋 **Relatório de Status** todo dia às 18h (horário de Brasília), com as quedas das últimas 24h
- ⚠️ **Fonte de Dados Indisponível** se uma fonte ficar 5 min sem responder (o monitor não fica "cego" calado)
- 🗺️ **Mapa do Brasil** anexado nos alertas de SEFAZ e no relatório (um para NFC-e, outro para NF-e), mais o campo "Estados" com as UFs fora e com falha

## Mapa

| Cor | Significado |
|---|---|
| 🟩 Verde | Normal |
| 🟥 Vermelho | Com falha: o autorizador da UF está com erros/timeouts (NFC-e: mais de 25% dos envios em 10 min) ou serviço lento/fora no portal (NF-e), mas ainda não caiu |
| ⬜ Cinza | Fora do ar: o autorizador da UF está OFFLINE (alerta disparado) |
| ⬛ Cinza escuro | Sem dados da fonte |

A cor de cada UF é a do autorizador que a atende (ex.: SVRS fora → as 19 UFs do SVRS ficam cinza na NFC-e).
O mapa atual também fica disponível no navegador: `https://<url-do-worker>/mapa/nfce.png` e `/mapa/nfe.png`.

O desenho do mapa (malha oficial do IBGE) é pré-renderizado em `src/map-data.js`; no Worker só a paleta de cores muda, então gerar a imagem custa ~0,05 ms. Só rode `npm run build:map` se quiser mudar o layout em `scripts/build-map.mjs`.

## O que é monitorado

| Serviço | Fonte | Quando vira OFFLINE |
|---|---|---|
| **Eveo (SP1/SP2)** | API pública do status.eveo.com.br (Status.io) | qualquer DC SP1/SP2 diferente de "Operational" |
| **SEFAZ NFC-e** | Envios de teste da Tecnospeed, por UF, agrupados por autorizador | ≥ 50% dos envios com Timeout/Erro nos últimos 10 min (mínimo de 2 falhas). Volta com ≤ 20% |
| **SEFAZ NF-e** | Portal Nacional da NF-e (disponibilidade) | Autorização4, Retorno Autorização4 ou Status Serviço4 em vermelho por 2 leituras seguidas |

Autorizadores de NFC-e: AM, GO, MG, MS, MT, PR, RS, SP e SVRS (AC, AL, AP, BA, CE, DF, ES, MA, PA, PB, PE, PI, RJ, RN, RO, RR, SC, SE, TO).
Autorizadores de NF-e: AM, BA, GO, MG, MS, MT, PE, PR, RS, SP, SVAN (MA) e SVRS (16 UFs).

> A regra de NFC-e foi calibrada com dados reais. Alertar a cada falha isolada geraria ~5 alertas a cada 2h só no RJ; com a regra atual, só degradações de verdade disparam alerta.

## Instalação (uma vez, ~10 min)

Pré-requisito: Node.js instalado.

1. **Crie uma conta grátis na Cloudflare:** https://dash.cloudflare.com/sign-up
2. **Na pasta `monitor-sefaz`, instale e faça login** (abre o navegador para autorizar):
   ```
   npm install
   npx wrangler login
   ```
3. **Crie o banco e publique o Worker:**
   ```
   npm run setup
   ```
4. **Crie o webhook no Discord:** no canal dos alertas → *Editar canal → Integrações → Webhooks → Novo webhook*. Dê o nome `PDV-SEFAZ/EVEO`, coloque o mesmo avatar do bot antigo e clique em *Copiar URL do webhook*.
5. **Guarde a URL como segredo no Cloudflare** (cole quando pedir):
   ```
   npx wrangler secret put DISCORD_WEBHOOK_URL
   ```

Em até 1 minuto chega no canal o **📋 Relatório de Status** com "🚀 Monitor ativado". Depois disso, **desligue o bot antigo** para não duplicar alertas.

### Opcional: alerta se o próprio monitor parar

Crie um check grátis em https://healthchecks.io (período 1 min, tolerância 5 min), ligue a integração do Discord lá e grave a URL de ping:
```
npx wrangler secret put HEALTHCHECK_URL
```

## Conferir se está rodando

- Abra a URL do Worker (aparece no fim do `npm run setup`, algo como `https://monitor-sefaz.<sua-conta>.workers.dev`). Ela mostra em JSON a última execução, o status de cada autorizador e se há mensagens pendentes.
- Logs em tempo real: `npm run logs`
- Painel: dash.cloudflare.com → Workers & Pages → monitor-sefaz

## Ajustes

Em `wrangler.toml` (depois rode `npm run deploy`):
- `REPORT_HOURS = "18"`: horas do relatório, ex.: `"8,12,18"`
- `MENTION = "@everyone"`: use `""` para não mencionar ninguém, ou `"<@&ID_DO_CARGO>"` para mencionar um cargo

Em `src/config.js`: regra da NFC-e (`NFCE_RULE`), leituras para confirmar (`CONFIRM_RUNS`), mapa de autorizadores.

Para testar mudanças sem publicar:
- `npm test`: usa dados reais, simula quedas e não envia nada ao Discord (os mapas gerados ficam em `test/saida/`)
- `npm run test:discord`: envia 3 mensagens marcadas como 🧪 TESTE (relatório, queda simulada do SVRS e retorno) para o webhook do arquivo `.dev.vars`, sem @everyone

## Limites e custos

- Plano grátis da Cloudflare: 100 mil execuções/dia (usamos 1.440) e 10 ms de CPU por execução (usamos ~2–3 ms). **Custo: R$ 0.**
- Se o Discord estiver fora, as mensagens ficam numa fila e são reenviadas no minuto seguinte.
- A API da Tecnospeed não é documentada oficialmente. Se mudar, chega o aviso "Fonte de Dados Indisponível".
- O portal da NF-e só aceita cifras TLS antigas; o monitor tenta HTTPS e, se falhar, lê a mesma página pública por HTTP.
