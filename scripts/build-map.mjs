// Gera src/map-data.js: mapa do Brasil (malha oficial do IBGE) pré-renderizado como PNG de paleta.
// Cada pixel guarda (grupo, intensidade do branco das bordas/textos). No Worker só a paleta muda,
// então colorir os estados custa microssegundos de CPU.
// Uso: npm run build:map   (precisa de internet para baixar a malha do IBGE)

import { Resvg } from '@resvg/resvg-js';
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const IBGE_URL =
  'https://servicodados.ibge.gov.br/api/v3/malhas/paises/BR?formato=application/vnd.geo%2Bjson&qualidade=minima&intrarregiao=UF';
const COD = {
  11: 'RO', 12: 'AC', 13: 'AM', 14: 'RR', 15: 'PA', 16: 'AP', 17: 'TO', 21: 'MA', 22: 'PI',
  23: 'CE', 24: 'RN', 25: 'PB', 26: 'PE', 27: 'AL', 28: 'SE', 29: 'BA', 31: 'MG', 32: 'ES',
  33: 'RJ', 35: 'SP', 41: 'PR', 42: 'SC', 43: 'RS', 50: 'MS', 51: 'MT', 52: 'GO', 53: 'DF',
};
export const UFS = Object.values(COD).sort();
const LEGEND = [
  ['lg_ok', 'Normal'],
  ['lg_falha', 'Com falha'],
  ['lg_fora', 'Fora do ar'],
  ['lg_semdados', 'Sem dados'],
];
const GROUPS = [...UFS, 'bg', ...LEGEND.map(([g]) => g)];
const LEVELS = 7; // intensidades de branco por grupo (0..6) + 1 índice de branco puro compartilhado
const WHITE = GROUPS.length * LEVELS;

// ---------------------------------------------------------------- layout
const W = 820;
const H = 776;
const MAP = { x: 28, y: 92, w: 640 };
const FONT = "font-family=\"Segoe UI, Arial, sans-serif\" font-weight=\"700\"";
const LABEL_SIZE = 19;

// Estados pequenos demais para o rótulo caber dentro: rótulo fora, com linha guia (dx, dy em px).
const EXTERNAL = {
  RN: [58, -16], PB: [64, 2], PE: [72, 20], AL: [62, 34], SE: [58, 46],
  ES: [52, 6], RJ: [44, 34], DF: [42, -30],
};
// Rótulos externos que caem sobre outros estados ganham um fundo escuro.
const PILL = new Set(['DF']);
function pillRect(s, fill) {
  const [px, py] = s.pole.p;
  const [dx, dy] = EXTERNAL[s.uf];
  return `<rect x="${(px + dx - 7).toFixed(1)}" y="${(py + dy - 13).toFixed(1)}" width="38" height="26" rx="7" fill="${fill}"/>`;
}

// ---------------------------------------------------------------- geometria
const area = (ring) => ring.reduce((a, [x1, y1], i) => {
  const [x2, y2] = ring[(i + 1) % ring.length];
  return a + x1 * y2 - x2 * y1;
}, 0) / 2;

function inside([px, py], ring) {
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}

function segDist([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

// Ponto interno mais distante das bordas (onde o rótulo cabe melhor).
function pole(ring) {
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  let best = { p: ring[0], d: 0 };
  for (let x = Math.min(...xs); x <= Math.max(...xs); x += 1.5) {
    for (let y = Math.min(...ys); y <= Math.max(...ys); y += 1.5) {
      if (!inside([x, y], ring)) continue;
      let d = Infinity;
      for (let i = 0; i < ring.length; i++) d = Math.min(d, segDist([x, y], ring[i], ring[(i + 1) % ring.length]));
      if (d > best.d) best = { p: [x, y], d };
    }
  }
  return best;
}

const geo = await (await fetch(IBGE_URL)).json();
const states = geo.features.map((f) => {
  const uf = COD[f.properties.codarea];
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  const maxA = Math.max(...polys.map((p) => Math.abs(area(p[0]))));
  // descarta ilhas pequenas (Fernando de Noronha, Trindade...) que só esticariam o mapa
  return { uf, polys: polys.filter((p) => Math.abs(area(p[0])) >= maxA * 0.02).map((p) => p[0]) };
});

const all = states.flatMap((s) => s.polys.flat());
const lonMin = Math.min(...all.map((p) => p[0]));
const lonMax = Math.max(...all.map((p) => p[0]));
const latMin = Math.min(...all.map((p) => p[1]));
const latMax = Math.max(...all.map((p) => p[1]));
const kx = Math.cos((((latMin + latMax) / 2) * Math.PI) / 180);
const scale = MAP.w / ((lonMax - lonMin) * kx);
const proj = ([lon, lat]) => [MAP.x + (lon - lonMin) * kx * scale, MAP.y + (latMax - lat) * scale];
for (const s of states) {
  s.rings = s.polys.map((r) => r.map(proj));
  const main = s.rings.reduce((a, b) => (Math.abs(area(b)) > Math.abs(area(a)) ? b : a));
  s.pole = pole(main);
}
const mapH = (latMax - latMin) * scale;

// ---------------------------------------------------------------- SVGs (ids sem antialias + overlay branco)
const pathOf = (s) => s.rings.map((r) => `M${r.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L')}Z`).join('');
const idColor = (g) => `rgb(${GROUPS.indexOf(g)},120,200)`;
const legendItems = LEGEND.map(([g, text], i) => ({ g, text, x: 606, y: 50 + i * 36 }));

function svgIds() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" shape-rendering="crispEdges">
  <rect width="${W}" height="${H}" fill="${idColor('bg')}"/>
  ${states.map((s) => `<path d="${pathOf(s)}" fill="${idColor(s.uf)}"/>`).join('\n')}
  ${states.filter((s) => PILL.has(s.uf)).map((s) => pillRect(s, idColor('bg'))).join('\n')}
  ${legendItems.map((l) => `<rect x="${l.x}" y="${l.y - 20}" width="26" height="26" rx="6" fill="${idColor(l.g)}"/>`).join('\n')}
</svg>`;
}

function svgOverlay(title) {
  const labels = states.map((s) => {
    const [px, py] = s.pole.p;
    const ext = EXTERNAL[s.uf];
    if (!ext) {
      return `<text x="${px.toFixed(1)}" y="${(py + LABEL_SIZE * 0.36).toFixed(1)}" font-size="${LABEL_SIZE}" text-anchor="middle" ${FONT} fill="#fff">${s.uf}</text>`;
    }
    const [lx, ly] = [px + ext[0], py + ext[1]];
    return `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="2.6" fill="#fff"/>
      <line x1="${px.toFixed(1)}" y1="${py.toFixed(1)}" x2="${(lx - 4).toFixed(1)}" y2="${ly.toFixed(1)}" stroke="#fff" stroke-width="1.4" stroke-opacity="0.75"/>
      <text x="${lx.toFixed(1)}" y="${(ly + LABEL_SIZE * 0.36).toFixed(1)}" font-size="${LABEL_SIZE - 2}" ${FONT} fill="#fff">${s.uf}</text>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#000"/>
  <text x="32" y="52" font-size="34" ${FONT} fill="#fff">${title}</text>
  <text x="34" y="78" font-size="17" font-family="Segoe UI, Arial, sans-serif" fill="#fff" fill-opacity="0.62">Status por estado</text>
  ${states.map((s) => `<path d="${pathOf(s)}" fill="none" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/>`).join('\n')}
  ${states.filter((s) => PILL.has(s.uf)).map((s) => pillRect(s, '#000')).join('\n')}
  ${labels.join('\n')}
  ${legendItems.map((l) => `<text x="${l.x + 36}" y="${l.y}" font-size="19" font-family="Segoe UI, Arial, sans-serif" fill="#fff" fill-opacity="0.9">${l.text}</text>`).join('\n')}
</svg>`;
}

const render = (svg) =>
  new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: 'Arial' } }).render().pixels; // RGBA

// ---------------------------------------------------------------- PNG indexado (IHDR + IDAT pré-montados)
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function buildMap(title) {
  const ids = render(svgIds());
  const ov = render(svgOverlay(title));
  const raw = Buffer.alloc((W + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const g = ids[i + 1] === 120 && ids[i + 2] === 200 && ids[i] < GROUPS.length ? ids[i] : GROUPS.indexOf('bg');
      const q = Math.round((ov[i] / 255) * LEVELS);
      raw[y * (W + 1) + 1 + x] = q >= LEVELS ? WHITE : g * LEVELS + q;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr.set([8, 3, 0, 0, 0], 8); // 8 bits, paleta
  return {
    head: Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)]).toString('base64'),
    tail: Buffer.concat([chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]).toString('base64'),
  };
}

const maps = { nfce: buildMap('SEFAZ NFC-e'), nfe: buildMap('SEFAZ NF-e') };
writeFileSync(
  new URL('../src/map-data.js', import.meta.url),
  `// Gerado por scripts/build-map.mjs a partir da malha do IBGE. Não editar à mão.\n` +
    `export const GROUPS = ${JSON.stringify(GROUPS)};\n` +
    `export const LEVELS = ${LEVELS};\n` +
    `export const MAPS = ${JSON.stringify(maps, null, 1)};\n`,
);

for (const s of [...states].sort((a, b) => a.pole.d - b.pole.d).slice(0, 12)) {
  console.log(`${s.uf}: espaço interno ${s.pole.d.toFixed(1)}px${EXTERNAL[s.uf] ? ' (rótulo externo)' : ''}`);
}
console.log(`mapa ${W}x${H}, ${(maps.nfce.tail.length * 0.75 / 1024).toFixed(1)} KB por imagem`);
