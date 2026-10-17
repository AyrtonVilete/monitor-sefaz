// Monta o PNG do mapa trocando só a paleta do mapa-base pré-renderizado (src/map-data.js).

import { GROUPS, LEVELS, MAPS } from './map-data.js';

export const MAP_COLORS = {
  ok: [0x1f, 0x9d, 0x55], // verde: normal
  falha: [0xda, 0x37, 0x3c], // vermelho: com falha
  fora: [0x80, 0x84, 0x8e], // cinza: fora do ar
  semdados: [0x4e, 0x50, 0x58], // cinza escuro: sem dados
  bg: [0x23, 0x24, 0x28],
};
const WHITE = [0xff, 0xff, 0xff];

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const fromB64 = (s) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
const decoded = {};

function groupColor(group, ufStatus) {
  if (group === 'bg') return MAP_COLORS.bg;
  if (group.startsWith('lg_')) return MAP_COLORS[group.slice(3)];
  return MAP_COLORS[ufStatus[group]] ?? MAP_COLORS.semdados;
}

// ufStatus: { AC: 'ok' | 'falha' | 'fora' | 'semdados', ... }
export function renderMap(service, ufStatus) {
  const base = (decoded[service] ??= { head: fromB64(MAPS[service].head), tail: fromB64(MAPS[service].tail) });

  const n = GROUPS.length * LEVELS + 1;
  const plte = new Uint8Array(12 + n * 3);
  const view = new DataView(plte.buffer);
  view.setUint32(0, n * 3);
  plte.set([0x50, 0x4c, 0x54, 0x45], 4); // "PLTE"
  GROUPS.forEach((g, gi) => {
    const fill = groupColor(g, ufStatus);
    for (let q = 0; q < LEVELS; q++) {
      const t = q / LEVELS;
      const o = 8 + (gi * LEVELS + q) * 3;
      for (let k = 0; k < 3; k++) plte[o + k] = Math.round(fill[k] * (1 - t) + WHITE[k] * t);
    }
  });
  plte.set(WHITE, 8 + (n - 1) * 3);
  view.setUint32(8 + n * 3, crc32(plte.subarray(4, 8 + n * 3)));

  const png = new Uint8Array(base.head.length + plte.length + base.tail.length);
  png.set(base.head, 0);
  png.set(plte, base.head.length);
  png.set(base.tail, base.head.length + plte.length);
  return png;
}
