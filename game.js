import { randomInt } from 'node:crypto';

export const ROWS = 16;
export const COLUMNS = 30;
export const MINES = 99;
export const SIZE = ROWS * COLUMNS;
export const RESET_DELAY = 1900;

const neighbors = Array.from({ length: SIZE }, (_, index) => {
  const row = Math.floor(index / COLUMNS);
  const column = index % COLUMNS;
  const adjacent = [];

  for (let y = Math.max(0, row - 1); y <= Math.min(ROWS - 1, row + 1); y++) {
    for (let x = Math.max(0, column - 1); x <= Math.min(COLUMNS - 1, column + 1); x++) {
      const candidate = y * COLUMNS + x;
      if (candidate !== index) adjacent.push(candidate);
    }
  }

  return adjacent;
});

export function newGame() {
  return {
    status: 'ready',
    mines: [],
    revealed: [],
    flags: [],
    exploded: null,
    startedAt: null,
    endedAt: null,
  };
}

function placeMines(firstCell) {
  const safe = new Set([firstCell, ...neighbors[firstCell]]);
  const candidates = Array.from({ length: SIZE }, (_, index) => index)
    .filter((index) => !safe.has(index));

  for (let index = 0; index < MINES; index++) {
    const swap = randomInt(index, candidates.length);
    [candidates[index], candidates[swap]] = [candidates[swap], candidates[index]];
  }

  return candidates.slice(0, MINES);
}

function countMines(index, mines) {
  return neighbors[index].filter((cell) => mines.has(cell)).length;
}

export function play(game, action, index, now) {
  if (action === 'reset') {
    if (game.status === 'lost' && now < game.endedAt + RESET_DELAY) return game;
    return newGame();
  }

  if (game.status === 'won' || game.status === 'lost') return game;

  const revealed = new Set(game.revealed);
  const flags = new Set(game.flags);

  if (action === 'flag') {
    if (revealed.has(index)) return game;
    if (flags.has(index)) flags.delete(index);
    else if (flags.size < MINES) flags.add(index);
    else return game;
    return { ...game, flags: [...flags] };
  }

  if (flags.has(index)) return game;

  const current = game.status === 'ready'
    ? { ...game, status: 'playing', mines: placeMines(index), startedAt: now }
    : game;
  const mines = new Set(current.mines);
  let pending = [index];

  if (revealed.has(index)) {
    const adjacentFlags = neighbors[index].filter((cell) => flags.has(cell)).length;
    if (adjacentFlags !== countMines(index, mines)) return game;
    pending = neighbors[index].filter((cell) => !revealed.has(cell) && !flags.has(cell));
    if (!pending.length) return game;
  }

  for (const cell of pending) {
    if (revealed.has(cell) || flags.has(cell)) continue;
    if (mines.has(cell)) {
      return { ...current, status: 'lost', exploded: cell, endedAt: now };
    }
    revealed.add(cell);
    if (!countMines(cell, mines)) pending.push(...neighbors[cell]);
  }

  const next = { ...current, revealed: [...revealed] };
  if (revealed.size === SIZE - MINES) {
    return { ...next, status: 'won', endedAt: now };
  }
  return next;
}

export function gameView(game, revision, now) {
  const mines = new Set(game.mines);

  return {
    rows: ROWS,
    columns: COLUMNS,
    totalMines: MINES,
    revision,
    status: game.status,
    cells: game.revealed.map((index) => [index, countMines(index, mines)]),
    flags: game.flags,
    exploded: game.exploded,
    remainingSafe: SIZE - MINES - game.revealed.length,
    elapsedMs: game.startedAt === null ? 0 : (game.endedAt ?? now) - game.startedAt,
    resetIn: game.status === 'lost' ? Math.max(0, game.endedAt + RESET_DELAY - now) : 0,
  };
}
