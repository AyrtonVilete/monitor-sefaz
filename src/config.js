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

// Regras da NFC-e. A Tecnospeed faz um envio de teste por UF a cada ~3 min, com status
// 1 Normal, 2 Lento, 3 Muito lento, 4 Timeout, 5 Erro (4 e 5 contam como falha).
// A cor de cada UF é calculada igual à da Tecnospeed: média dos status dos últimos 15 min, sem as casas decimais
// (1 verde, 2 amarelo, 3 laranja, 4-5 vermelho).
export const NFCE_RULE = {
  windowMin: 15, // mesma janela da Tecnospeed
  downConsecutive: 3, // UF fora do ar: os 3 envios mais recentes falharam
  upConsecutive: 2, // UF de volta: os 2 envios mais recentes OK
  downUfShare: 0.5, // autorizador fora do ar: pelo menos metade das UFs dele fora (com uma UF só, ela mesma)
  staleMin: 20, // sem envio novo há mais que isso => sem dados (não muda o estado)
};

// Alerta de instabilidade (sem menção): alguma UF do autorizador em laranja ou vermelho.
export const INTERMITTENT_ALERT = {
  startMin: 5, // avisa depois de 5 min seguidos instável
  clearMin: 3, // normaliza depois de 3 min seguidos sem nenhuma UF em laranja/vermelho (evita "normalizar" no meio de uma oscilação)
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
