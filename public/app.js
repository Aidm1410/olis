const board = document.querySelector('#board');
const field = document.querySelector('#field');
const status = document.querySelector('#status');
const statusText = document.querySelector('#status-text');
const mineCounter = document.querySelector('#mines');
const timeCounter = document.querySelector('#time');
const flagMode = document.querySelector('#flag-mode');
const reward = document.querySelector('#reward');
const claim = document.querySelector('#claim');
const rewardLink = document.querySelector('#reward-link');
const instructions = document.querySelector('#instructions');
const soundToggle = document.querySelector('#sound-toggle');
const Audio = window.AudioContext ?? window.webkitAudioContext;

const sounds = {
  reveal: ['triangle', [[420, 570, 0, 0.09]]],
  flag: ['sine', [[660, 880, 0, 0.11]]],
  unflag: ['sine', [[880, 520, 0, 0.09]]],
  loss: ['sawtooth', [[125, 42, 0, 0.36]]],
  win: ['triangle', [[523.25, 523.25, 0, 0.16], [659.25, 659.25, 0.10, 0.16], [783.99, 783.99, 0.20, 0.28]]],
};

let game;
let busy = false;
let flagging = false;
let activeCell = 0;
let resetTimer;
let clockStartedAt;
let claimPending = false;
let audio;
let volume;
let soundEnabled = true;
const cells = [];

async function prepareSound() {
  if (!Audio || !soundEnabled) return;

  try {
    if (!audio) {
      audio = new Audio();
      volume = audio.createGain();
      volume.gain.value = 0.12;
      volume.connect(audio.destination);
    }
    if (audio.state !== 'running') await audio.resume();
  } catch (error) {
    console.warn('Звук недоступен.', error);
  }
}

function playSound(name) {
  if (!soundEnabled || audio?.state !== 'running') return;
  const [wave, notes] = sounds[name];
  const now = audio.currentTime;

  for (const [frequency, endFrequency, delay, duration] of notes) {
    const start = now + delay;
    const end = start + duration;
    const oscillator = audio.createOscillator();
    const envelope = audio.createGain();
    oscillator.type = wave;
    oscillator.frequency.setValueAtTime(frequency, start);
    oscillator.frequency.exponentialRampToValueAtTime(endFrequency, end);
    envelope.gain.setValueAtTime(0.001, start);
    envelope.gain.exponentialRampToValueAtTime(0.55, start + 0.015);
    envelope.gain.exponentialRampToValueAtTime(0.001, end);
    oscillator.connect(envelope);
    envelope.connect(volume);
    oscillator.addEventListener('ended', () => {
      oscillator.disconnect();
      envelope.disconnect();
    }, { once: true });
    oscillator.start(start);
    oscillator.stop(end);
  }
}

function playMoveSound(action, next) {
  if (next.revision === game.revision || action === 'reset') return;
  if (next.status === 'lost') playSound('loss');
  else if (next.status === 'won') playSound('win');
  else if (action === 'flag') playSound(next.flags.length > game.flags.length ? 'flag' : 'unflag');
  else playSound('reveal');
}

async function request(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { code: response.status, data: await response.json() };
}

function makeBoard(rows, columns) {
  const fragment = document.createDocumentFragment();

  for (let index = 0; index < rows * columns; index++) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cell';
    button.dataset.index = index;
    button.tabIndex = index === activeCell ? 0 : -1;
    cells.push(button);
    fragment.append(button);
  }

  board.append(fragment);
}

function drawCells() {
  const open = new Map(game.cells);
  const flags = new Set(game.flags);

  for (const [index, cell] of cells.entries()) {
    const count = open.get(index);
    let appearance = 'closed';
    let value = '';
    let description = 'закрыта';

    if (index === game.exploded) {
      appearance = 'exploded';
      value = '✹';
      description = 'взрыв';
    } else if (count !== undefined) {
      appearance = 'open';
      value = count ? String(count) : '';
      description = count ? `мин рядом ${count}` : 'пустая';
    } else if (flags.has(index)) {
      appearance = 'flagged';
      value = '⚑';
      description = 'флажок';
    }

    const cellState = `${appearance}:${value}`;
    if (cell.dataset.state === cellState) continue;

    const row = Math.floor(index / game.columns) + 1;
    const column = index % game.columns + 1;
    cell.dataset.state = cellState;
    cell.className = `cell ${appearance}`;
    cell.textContent = value;
    cell.setAttribute('aria-label', `Строка ${row}, столбец ${column}, ${description}`);
    if (count) cell.dataset.count = count;
    else delete cell.dataset.count;
  }
}

function drawTime() {
  if (!game) return;
  const elapsedMs = game.status === 'playing' ? performance.now() - clockStartedAt : game.elapsedMs;
  const elapsed = Math.floor(elapsedMs / 1000);
  const minutes = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const seconds = String(elapsed % 60).padStart(2, '0');
  timeCounter.textContent = `${minutes}:${seconds}`;
}

function render(next) {
  game = next;
  if (!cells.length) makeBoard(game.rows, game.columns);
  clockStartedAt = performance.now() - game.elapsedMs;
  drawCells();
  drawTime();

  field.dataset.state = game.status;
  status.dataset.state = game.status;
  const remaining = game.status === 'won' ? 0 : game.totalMines - game.flags.length;
  mineCounter.textContent = String(remaining).padStart(3, '0');
  const messages = {
    ready: 'Выберите первую клетку',
    playing: `Осталось безопасных клеток: ${game.remainingSafe}`,
    lost: 'Подрыв. Готовим новое поле…',
    won: 'Победа! Секретная ссылка доступна.',
  };
  statusText.textContent = messages[game.status];

  reward.hidden = game.status !== 'won';
  if (reward.hidden) {
    rewardLink.hidden = true;
    rewardLink.removeAttribute('href');
    claim.hidden = false;
  }

  clearTimeout(resetTimer);
  if (game.status === 'lost') resetTimer = setTimeout(resetLostGame, Math.max(100, game.resetIn));
}

function setFlagMode(value) {
  flagging = value;
  flagMode.setAttribute('aria-pressed', String(value));
}

async function connect() {
  try {
    const result = await request('/api/game');
    if (result.code !== 200) throw new Error(result.data.error);
    render(result.data);
  } catch (error) {
    statusText.textContent = error.message || 'Связь с сервером потеряна.';
  }
}

async function move(action, index) {
  if (busy) return;
  if (!game && action !== 'reset') return;
  if (action !== 'reset' && (game.status === 'won' || game.status === 'lost')) return;
  busy = true;

  try {
    if (!game) {
      await connect();
      return;
    }

    if (action !== 'reset') void prepareSound();
    const body = { action, index, revision: game.revision };
    let result = await request('/api/move', body);
    if (result.code === 429 && result.data.retryIn) {
      await new Promise((resolve) => setTimeout(resolve, result.data.retryIn + 10));
      result = await request('/api/move', body);
    }

    if (result.code === 200 || result.code === 409) {
      if (result.code === 200) playMoveSound(action, result.data);
      if (action === 'reset' && result.data.status === 'ready') setFlagMode(false);
      render(result.data);
    } else if (result.code === 401) {
      setFlagMode(false);
      await connect();
    } else {
      throw new Error(result.data.error);
    }
  } catch (error) {
    statusText.textContent = error.message || 'Связь с сервером потеряна.';
    if (game?.status === 'lost') {
      clearTimeout(resetTimer);
      resetTimer = setTimeout(resetLostGame, 1500);
    }
  } finally {
    busy = false;
  }
}

function resetLostGame() {
  if (game?.status !== 'lost') return;
  if (busy) {
    resetTimer = setTimeout(resetLostGame, 100);
    return;
  }
  void move('reset');
}

function findCell(event) {
  return event.target.closest('.cell');
}

board.addEventListener('click', (event) => {
  const cell = findCell(event);
  if (cell) void move(flagging ? 'flag' : 'reveal', Number(cell.dataset.index));
});

board.addEventListener('contextmenu', (event) => {
  const cell = findCell(event);
  if (!cell) return;
  event.preventDefault();
  void move('flag', Number(cell.dataset.index));
});

board.addEventListener('focusin', (event) => {
  const cell = findCell(event);
  if (!cell) return;
  cells[activeCell].tabIndex = -1;
  activeCell = Number(cell.dataset.index);
  cell.tabIndex = 0;
});

board.addEventListener('keydown', (event) => {
  const cell = findCell(event);
  if (!cell) return;
  const index = Number(cell.dataset.index);
  let target = index;

  switch (event.key) {
    case 'ArrowLeft':
      if (index % game.columns) target--;
      break;
    case 'ArrowRight':
      if (index % game.columns < game.columns - 1) target++;
      break;
    case 'ArrowUp':
      target -= game.columns;
      break;
    case 'ArrowDown':
      target += game.columns;
      break;
    default:
      if (event.code === 'KeyF') {
        event.preventDefault();
        if (!event.repeat) void move('flag', index);
      }
      return;
  }

  event.preventDefault();
  cells[target]?.focus();
});

document.querySelector('#new-game').addEventListener('click', () => void move('reset'));
flagMode.addEventListener('click', () => setFlagMode(!flagging));
soundToggle.hidden = !Audio;
soundToggle.addEventListener('click', () => {
  soundEnabled = !soundEnabled;
  soundToggle.setAttribute('aria-pressed', String(soundEnabled));
  soundToggle.textContent = soundEnabled ? 'Звук вкл.' : 'Звук выкл.';
  if (volume) volume.gain.value = soundEnabled ? 0.12 : 0;
  if (soundEnabled) void prepareSound();
});
document.querySelector('#help').addEventListener('click', () => instructions.showModal());
document.querySelector('#close-help').addEventListener('click', () => instructions.close());

claim.addEventListener('click', async () => {
  if (claimPending || game?.status !== 'won') return;
  const revision = game.revision;
  claimPending = true;
  try {
    const result = await request('/api/reward');
    if (game.revision !== revision || game.status !== 'won') return;
    if (result.code !== 200) throw new Error(result.data.error);
    rewardLink.href = result.data.url;
    rewardLink.hidden = false;
    claim.hidden = true;
    rewardLink.focus();
  } catch (error) {
    statusText.textContent = error.message || 'Не удалось получить награду.';
  } finally {
    claimPending = false;
  }
});

setInterval(drawTime, 250);
void move('reset');
