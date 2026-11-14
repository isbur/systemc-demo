/**
 * Свободное место для нового блока.
 * Координаты — левый верхний угол, прямоугольники не должны пересекаться с зазором.
 */

export function rectsOverlap(a, b, gap = 0) {
  return a.x < b.x + b.width + gap
    && a.x + a.width + gap > b.x
    && a.y < b.y + b.height + gap
    && a.y + a.height + gap > b.y;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * @param {Array<{x:number,y:number,width:number,height:number}>} blocks
 * @param {number} width
 * @param {number} height
 * @param {{x:number,y:number}|null} prefer  точка, рядом с которой хочется встать
 * @param {{width:number,height:number}} bounds  видимая область канвы
 * @param {number} [gap]
 * @returns {{x:number,y:number}}
 */
export function findFreeTopLeft(blocks, width, height, prefer, bounds, gap = 28) {
  const min = 16;
  const viewW = Math.max(bounds?.width || 0, width + min * 2);
  const viewH = Math.max(bounds?.height || 0, height + min * 2);
  const maxX = Math.max(min, viewW - width - 16);
  const maxY = Math.max(min, viewH - height - 16);
  const startX = clamp(snap(prefer?.x ?? min), min, maxX);
  const startY = clamp(snap(prefer?.y ?? min), min, maxY);
  const taken = (x, y) => blocks.some((block) => rectsOverlap({ x, y, width, height }, block, gap));

  if (!taken(startX, startY)) return { x: startX, y: startY };

  const step = 16;
  for (let radius = step; radius <= 2400; radius += step) {
    for (let dx = -radius; dx <= radius; dx += step) {
      for (const dy of [-radius, radius]) {
        const x = clamp(snap(startX + dx), min, maxX);
        const y = clamp(snap(startY + dy), min, maxY);
        if (!taken(x, y)) return { x, y };
      }
    }
    for (let dy = -radius + step; dy <= radius - step; dy += step) {
      for (const dx of [-radius, radius]) {
        const x = clamp(snap(startX + dx), min, maxX);
        const y = clamp(snap(startY + dy), min, maxY);
        if (!taken(x, y)) return { x, y };
      }
    }
  }

  // В видимой области места нет — ставим правее всех, без наложения.
  // С канвы это можно утащить обратно.
  let x = snap(blocks.reduce((max, block) => Math.max(max, block.x + block.width + gap), min));
  let y = min;
  let guard = 0;
  while (taken(x, y) && guard < 80) {
    y = snap(y + height + gap);
    if (y > viewH * 3) {
      y = min;
      x = snap(x + width + gap);
    }
    guard += 1;
  }
  return { x, y };
}

function snap(value) {
  return Math.round(value / 10) * 10;
}
