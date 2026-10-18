# Monitor SEFAZ / Eveo: 24/7 na nuvem

Substitui o bot do Discord que dependia de um computador ligado. Roda como **Cloudflare Worker** (plano grátis), a cada 1 minuto, 24/7. Os alertas vão para o Discord só no **horário comercial, das 07:30 às 22:00** (`ALERT_HOURS` no `wrangler.toml`), no mesmo formato do bot antigo:

- 🔴 **Serviço Fora do Ar** (com `@everyone`) quando um autorizador cai
- ✅ **Serviço Recuperado** só depois de **10 min seguidos OK** (≈ 5 envios da Tecnospeed), com o horário em que voltou. Se cair de novo nesse meio tempo, não sai nada (`CONFIRM_UP` em `src/config.js`)
- 🟠 **Instabilidade Detectada** (sem menção) quando alguma UF do autorizador fica laranja/vermelha por 5 min seguidos, e ✅ **Instabilidade Normalizada** depois de **10 min seguidos** limpos
- 🟡 **Recuperação/Normalização Parcial** quando um autorizador volta mas o serviço ainda tem estado com problema (nunca diz "normalizado" com estado em vermelho)
- 🔴 **Continua Fora do Ar** / 🟠 **Instabilidade Continua** (sem menção): lembrete a cada 30 min enquanto o problema durar (`REMINDER_MIN` em `src/config.js`)
- ☀️ **Abertura do Expediente** às 07:30, **só se** algo aconteceu fora do horário ou ainda está com problema (com `@everyone` se houver queda em andamento). Noite tranquila = nenhuma mensagem
- 📋 **Relatório de Status** às **12h, 18h e 22h** (`REPORT_HOURS`), com as quedas e instabilidades das últimas 24h
- ⚠️ **Fonte de Dados Indisponível** se uma fonte ficar 5 min sem responder (o monitor não fica "cego" calado)
- 🗺️ **Mapa do Brasil** anexado nos alertas de SEFAZ e no relatório (um para NFC-e, outro para NF-e), mais o campo "Estados" com as UFs fora e com falha

## Mapa

Na **NFC-e** a cor de cada UF é calculada **igual à da Tecnospeed**: média dos status dos envios da UF nos últimos 15 min, sem as casas decimais (status 1 Normal, 2 Lento, 3 Muito lento, 4 Timeout, 5 Erro).

| Cor | NFC-e (média 15 min, como na Tecnospeed) | NF-e (portal) |
|---|---|---|
| 🟩 Verde | 1 (Normal) | tudo verde |
| 🟨 Amarelo | 2 (Lento) | serviço principal lento (amarelo) |
| 🟧 Laranja | 3 (Intermitente) | — |
| 🟥 Vermelho | 4 ou 5 (Com falha) | algum serviço em vermelho |
| ⬜ Cinza | Fora do ar: queda confirmada (alerta disparado) | idem |
| ⬛ Cinza escuro | Sem dados da fonte | idem |

Laranja ou vermelho por 5 min viram o aviso 🟠 Instabilidade, sem menção (`INTERMITTENT_ALERT` em `src/config.js`).
Na NF-e não há dados por UF: a UF recebe a cor do autorizador que a atende.
O mapa atual também fica disponível no navegador: `https://<url-do-worker>/mapa/nfce.png` e `/mapa/nfe.png`.

O desenho do mapa (malha oficial do IBGE) é pré-renderizado em `src/map-data.js`; no Worker só a paleta de cores muda, então gerar a imagem custa ~0,05 ms. Só rode `npm run build:map` se quiser mudar o layout em `scripts/build-map.mjs`.

## O que é monitorado

| Serviço | Fonte | Quando vira OFFLINE |
|---|---|---|
| **Eveo (SP1/SP2)** | API pública do status.eveo.com.br (Status.io) | qualquer DC SP1/SP2 diferente de "Operational" |
| **SEFAZ NFC-e** | Envios de teste da Tecnospeed, por UF, agrupados por autorizador | os 3 envios mais recentes falharam (Timeout/Erro); no SVRS, em pelo menos metade das UFs. Volta com os 2 envios mais recentes OK |
| **SEFAZ NF-e** | Portal Nacional da NF-e (disponibilidade) | Autorização4, Retorno Autorização4 ou Status Serviço4 em vermelho por 2 leituras seguidas |

Autorizadores de NFC-e: AM, GO, MG, MS, MT, PR, RS, SP e SVRS (AC, AL, AP, BA, CE, DF, ES, MA, PA, PB, PE, PI, RJ, RN, RO, RR, SC, SE, TO).
Autorizadores de NF-e: AM, BA, GO, MG, MS, MT, PE, PR, RS, SP, SVAN (MA) e SVRS (16 UFs).

> A regra de NFC-e foi calibrada com dados reais e com a fórmula da própria Tecnospeed (25 de 27 UFs batem exatamente; as outras diferem só pelo segundo da leitura). Uma falha isolada não derruba nem dispara alerta.

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

## Mapa web (para quem não usa o Discord)

**https://monitor-sefaz.monitor-sefaz.workers.dev** (o endereço do próprio Worker):

- Mapa 3D do Brasil com a cor de cada estado (mesma conta da Tecnospeed), atualizado a cada minuto
- Filtros **NF-e / NFC-e / CT-e** (link direto: `/#nfe`, `/#nfce`, `/#cte`)
- Passe o mouse (ou toque, no celular) em um estado: ele sobe em 3D e mostra o **tempo de resposta em ms** do último envio, a média dos 15 min, falhas, autorizador e último erro
- Resumo por cor e lista dos estados que pedem atenção

Rotas do Worker:

| Rota | O que é |
|---|---|
| `/` | mapa web |
| `/api/mapa?doc=nfce` | situação de cada UF em JSON (`nfe`, `nfce` ou `cte`), com cache de 1 min no D1 |
| `/api/status` | último resultado do monitor em JSON (autorizadores, fontes, incidentes, fila do Discord) |
| `/mapa/nfce.png`, `/mapa/nfe.png` | o mesmo mapa PNG enviado ao Discord |
| `/geo.json` | geometria dos estados (malha do IBGE) |

Na NF-e, o mapa web usa os envios da Tecnospeed (que têm o tempo em ms por estado); os alertas de queda do Discord continuam usando o portal nacional. O CT-e aparece só no mapa web (sem alertas no Discord).

## Conferir se está rodando

- Abra `/api/status` no endereço do Worker: mostra em JSON a última execução, o status de cada autorizador e se há mensagens pendentes.
- Logs em tempo real: `npm run logs`
- Painel: dash.cloudflare.com → Workers & Pages → monitor-sefaz

## Ajustes

Em `wrangler.toml` (depois rode `npm run deploy`):
- `REPORT_HOURS = "12,18,22"`: horas dos relatórios
- `ALERT_HOURS = "07:30-22:00"`: horário comercial dos alertas (`""` = 24h)
- `MENTION = "@everyone"`: use `""` para não mencionar ninguém, ou `"<@&ID_DO_CARGO>"` para mencionar um cargo

Em `src/config.js`: regra da NFC-e (`NFCE_RULE`), leituras para confirmar (`CONFIRM_RUNS`), mapa de autorizadores.

Para testar mudanças sem publicar:
- `npm test`: simula um dia inteiro (quedas, retorno falso, lembretes, instabilidade, noite e abertura) com relógio simulado e confere cada mensagem contra o esperado; não envia nada ao Discord (os mapas ficam em `test/saida/`)
- `npm run test:discord`: envia 3 mensagens marcadas como 🧪 TESTE (relatório, queda simulada do SVRS e retorno) para o webhook do arquivo `.dev.vars`, sem @everyone

## Limites e custos

- Plano grátis da Cloudflare: 100 mil execuções/dia (usamos 1.440) e 10 ms de CPU por execução (usamos ~2–3 ms). **Custo: R$ 0.**
- Se o Discord estiver fora, as mensagens ficam numa fila e são reenviadas no minuto seguinte.
- A API da Tecnospeed não é documentada oficialmente. Se mudar, chega o aviso "Fonte de Dados Indisponível".
- O portal da NF-e só aceita cifras TLS antigas; o monitor tenta HTTPS e, se falhar, lê a mesma página pública por HTTP.
