// Configuração do monitor: fontes, autorizadores e regras de alerta.

export const TZ = 'America/Sao_Paulo';
export const UA = 'Mozilla/5.0 (compatible; MonitorServicos/1.0)';

export const TECNOSPEED_URL = 'https://monitor.tecnospeed.com.br/monitores';
// O portal só negocia cifras TLS antigas (CBC), que o runtime do Workers pode recusar;
// por isso tenta HTTPS e cai para HTTP (página pública, somente leitura).
const PORTAL_NFE_PATH =
  '://www.nfe.fazenda.gov.br/portal/disponibilidade.aspx?versao=0.00&tipoConteudo=P2c98tUpxrI=&AspxAutoDetectCookieSupport=1';
export const PORTAL_NFE_URLS = [`https${PORTAL_NFE_PATH}`, `http${PORTAL_NFE_PATH}`];
export const EVEO_STATUS_URL = 'https://api.status.io/1.0/status/66d5ff1580a4e633c1aec154';

export const SERVICES = {
  eveo: { name: 'Eveo Status (SP1/SP2)', short: 'Eveo', source: 'status.eveo.com.br' },
  nfce: { name: 'SEFAZ NFC-e', short: 'NFC-e', source: 'Monitor Tecnospeed' },
  nfe: { name: 'SEFAZ NF-e', short: 'NF-e', source: 'Portal Nacional da NF-e' },
};
export const SERVICE_ORDER = ['eveo', 'nfce', 'nfe'];

// NFC-e: autorizador -> UFs. Conferido pelas URLs dos erros reais da Tecnospeed
// (CE e SC enviam NFC-e para nfce.svrs.rs.gov.br).
export const NFCE_AUTORIZADORES = [
  { id: 'AM', ufs: ['AM'] },
  { id: 'GO', ufs: ['GO'] },
  { id: 'MG', ufs: ['MG'] },
  { id: 'MS', ufs: ['MS'] },
  { id: 'MT', ufs: ['MT'] },
  { id: 'PR', ufs: ['PR'] },
  { id: 'RS', ufs: ['RS'] },
  { id: 'SP', ufs: ['SP'] },
  {
    id: 'SVRS',
    ufs: ['AC', 'AL', 'AP', 'BA', 'CE', 'DF', 'ES', 'MA', 'PA', 'PB', 'PE', 'PI', 'RJ', 'RN', 'RO', 'RR', 'SC', 'SE', 'TO'],
  },
];

// NF-e: linhas do Portal Nacional. SVC-AN e SVC-RS (contingência) ficam de fora.
export const NFE_AUTORIZADORES = [
  { id: 'AM', ufs: ['AM'] },
  { id: 'BA', ufs: ['BA'] },
  { id: 'GO', ufs: ['GO'] },
  { id: 'MG', ufs: ['MG'] },
  { id: 'MS', ufs: ['MS'] },
  { id: 'MT', ufs: ['MT'] },
  { id: 'PE', ufs: ['PE'] },
  { id: 'PR', ufs: ['PR'] },
  { id: 'RS', ufs: ['RS'] },
  { id: 'SP', ufs: ['SP'] },
  { id: 'SVAN', ufs: ['MA'] },
  {
    id: 'SVRS',
    ufs: ['AC', 'AL', 'AP', 'CE', 'DF', 'ES', 'PA', 'PB', 'PI', 'RJ', 'RN', 'RO', 'RR', 'SC', 'SE', 'TO'],
  },
];

// Colunas do portal que derrubam o autorizador quando ficam vermelhas.
// As demais (Consulta Cadastro, Recepção Evento...) só aparecem como aviso.
export const NFE_CORE_COLUMNS = ['autorizacao4', 'retornoautorizacao4', 'statusservico4'];

// Regra de queda/retorno da NFC-e. A Tecnospeed faz um envio de teste por UF a cada ~3 min;
// status 4 (Timeout > 30s) e 5 (Erro) contam como falha.
export const NFCE_RULE = {
  windowMin: 10, // janela analisada, contada a partir da medição mais recente
  minProbes: 2, // mínimo de medições na janela para decidir
  downRatio: 0.5, // >= 50% das medições com falha...
  downMinFails: 2, // ...e pelo menos 2 falhas => OFFLINE
  upRatio: 0.3, // <= 30% de falhas => volta a ONLINE (o SVRS oscila entre 4% e 27% em dia normal)
  unstableRatio: 0.25, // > 25% com pelo menos 2 falhas, sem chegar a OFFLINE => "com falha" (vermelho no mapa)
  intermittentRatio: 0.1, // >= 10% de falhas (1 falha isolada já conta numa UF só) => "intermitente" (laranja)
  slowRatio: 0.3, // >= 30% dos envios "muito lentos" (status 3, > 5s) também conta como intermitente
  staleMin: 20, // sem medição nova há mais que isso => sem dados (não muda o estado)
};

// Alerta de intermitência (sem menção). Normaliza na primeira leitura OK.
export const INTERMITTENT_ALERT = {
  startMin: 5, // avisa quando o autorizador fica intermitente (ou pior) por 5 min seguidos
};

// Lembrete (sem menção) a cada 30 min enquanto o autorizador continuar fora do ar ou intermitente.
export const REMINDER_MIN = 30;

// Execuções seguidas (1 por minuto) confirmando a mudança antes de alertar.
export const CONFIRM_RUNS = { eveo: 1, nfce: 1, nfe: 2 };

// Execuções seguidas com a fonte inacessível antes de avisar no Discord.
export const SOURCE_ALERT_AFTER = 5;

// Muitos autorizadores de NFC-e caindo juntos costuma ser problema na própria Tecnospeed.
export const MASS_FAILURE_MIN = 5;

export function autorizadorLabel(a) {
  return a.ufs.length === 1 && a.ufs[0] === a.id ? a.id : `${a.id} (${a.ufs.join(', ')})`;
}

export function incidentName(a) {
  return a.ufs.length === 1 && a.ufs[0] === a.id ? `Sefaz ${a.id}` : autorizadorLabel(a);
}
