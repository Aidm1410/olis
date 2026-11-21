import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { gameView, newGame, play, SIZE } from './game.js';

const SESSION_TTL = 24 * 60 * 60 * 1000;
const SESSION_NAME = 'minesweeper_session';
const NEW_SESSION_WINDOW = 15 * 60 * 1000;
const NEW_SESSION_LIMIT = 24;
const MOVE_INTERVAL = 65;
const PUBLIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function hash(token) {
  return createHash('sha256').update(token).digest('base64url');
}

function sessionToken(request) {
  const cookies = (request.headers.cookie ?? '').split(';').map((part) => part.trim());
  const prefix = `${SESSION_NAME}=`;
  const token = cookies.find((part) => part.startsWith(prefix))?.slice(prefix.length);
  return /^[\w-]{43}$/.test(token ?? '') ? token : null;
}

function verifyOrigin(request, origin, secureCookie) {
  const protocol = secureCookie || request.socket.encrypted ? 'https' : 'http';
  const expected = origin ?? `${protocol}://${request.headers.host}`;
  return request.headers.origin === expected && request.headers['sec-fetch-site'] !== 'cross-site';
}

async function readMove(request) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') return null;

  let input = '';
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    input += chunk.toString('utf8');
    if (input.length > 512) {
      request.resume();
      return null;
    }
  }

  let move;
  try {
    move = JSON.parse(input);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }

  if (!Number.isSafeInteger(move?.revision) || move.revision < 0) return null;
  if (move.action === 'reset') return move;
  if (move.action !== 'reveal' && move.action !== 'flag') return null;
  if (!Number.isInteger(move.index) || move.index < 0 || move.index >= SIZE) return null;
  return move;
}

export function createGameServer({ rewardUrl, databasePath, origin, secureCookie = false }) {
  if (rewardUrl) {
    const destination = URL.parse(rewardUrl);
    if (!destination || destination.protocol !== 'https:' || destination.username || destination.password) {
      throw new Error('REWARD_URL должен содержать HTTPS-ссылку.');
    }
  }

  if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      state TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS games_expiry ON games (expires_at);
  `);
  const findGame = db.prepare('SELECT * FROM games WHERE id = ? AND expires_at > ?');
  const insertGame = db.prepare('INSERT INTO games VALUES (?, 0, ?, ?, ?)');
  const updateGame = db.prepare(`
    UPDATE games SET revision = revision + 1, state = ?, updated_at = ?, expires_at = ?
    WHERE id = ? AND revision = ?
  `);
  const deleteExpired = db.prepare('DELETE FROM games WHERE expires_at <= ?');
  const sources = new Map();
  let nextCleanup = 0;

  const files = new Map(Array.from(PUBLIC_FILES, ([path, [name, type]]) => [path, {
    type,
    content: readFileSync(new URL(`./public/${name}`, import.meta.url)),
  }]));

  function createSession(request, response, now) {
    if (now >= nextCleanup) {
      deleteExpired.run(now);
      for (const [ip, limit] of sources) {
        if (limit.until <= now) sources.delete(ip);
      }
      nextCleanup = now + 60_000;
    }

    const ip = request.socket.remoteAddress;
    let limit = sources.get(ip);
    if (!limit || limit.until <= now) {
      limit = { count: 0, until: now + NEW_SESSION_WINDOW };
      sources.set(ip, limit);
    }
    if (limit.count >= NEW_SESSION_LIMIT) {
      response.setHeader('Retry-After', Math.ceil((limit.until - now) / 1000));
      return json(response, 429, { error: 'Слишком много новых сессий. Попробуйте позже.' });
    }
    limit.count++;

    const token = randomBytes(32).toString('base64url');
    const game = newGame();
    insertGame.run(hash(token), JSON.stringify(game), 0, now + SESSION_TTL);
    const secure = secureCookie || request.socket.encrypted ? '; Secure' : '';
    response.setHeader('Set-Cookie', `${SESSION_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/${secure}`);
    return json(response, 200, gameView(game, 0, now));
  }

  async function handle(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");

    const path = request.url.split('?')[0];
    const file = files.get(path);
    if (file && (request.method === 'GET' || request.method === 'HEAD')) {
      response.writeHead(200, { 'Content-Type': file.type, 'Content-Length': file.content.length });
      return response.end(request.method === 'HEAD' ? undefined : file.content);
    }

    const route = `${request.method} ${path}`;
    if (!['POST /api/game', 'POST /api/move', 'POST /api/reward'].includes(route)) {
      return json(response, 404, { error: 'Страница не найдена.' });
    }
    if (!verifyOrigin(request, origin, secureCookie)) {
      return json(response, 403, { error: 'Запрос отклонён.' });
    }

    const move = route === 'POST /api/move' ? await readMove(request) : null;
    if (route === 'POST /api/move' && !move) {
      return json(response, 400, { error: 'Недопустимый ход.' });
    }

    const now = Date.now();
    const token = sessionToken(request);
    const row = token ? findGame.get(hash(token), now) : undefined;
    if (!row) {
      if (route === 'POST /api/game') return createSession(request, response, now);
      return json(response, 401, { error: 'Сессия истекла.' });
    }

    const game = JSON.parse(row.state);
    if (route === 'POST /api/game') {
      return json(response, 200, gameView(game, row.revision, now));
    }
    if (route === 'POST /api/reward') {
      if (game.status !== 'won') return json(response, 403, { error: 'Сначала завершите партию.' });
      if (!rewardUrl) return json(response, 503, { error: 'Награда пока недоступна.' });
      return json(response, 200, { url: rewardUrl });
    }
    if (move.revision !== row.revision) {
      return json(response, 409, gameView(game, row.revision, now));
    }
    if (row.updated_at + MOVE_INTERVAL > now) {
      return json(response, 429, { retryIn: row.updated_at + MOVE_INTERVAL - now });
    }

    const next = play(game, move.action, move.index, now);
    if (next === game) return json(response, 200, gameView(game, row.revision, now));

    const result = updateGame.run(JSON.stringify(next), now, now + SESSION_TTL, row.id, row.revision);
    if (!result.changes) {
      const latest = findGame.get(row.id, now);
      return json(response, 409, gameView(JSON.parse(latest.state), latest.revision, now));
    }
    return json(response, 200, gameView(next, row.revision + 1, now));
  }

  const server = createServer({ requestTimeout: 10_000, headersTimeout: 5000 }, (request, response) => {
    handle(request, response).catch((error) => {
      console.error(error);
      if (response.headersSent) response.destroy();
      else json(response, 500, { error: 'Внутренняя ошибка сервера.' });
    });
  });
  server.on('close', () => db.close());
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 3000);
  const server = createGameServer({
    rewardUrl: process.env.REWARD_URL,
    databasePath: resolve('.data', 'games.sqlite'),
    origin: process.env.PUBLIC_ORIGIN,
    secureCookie: process.env.COOKIE_SECURE === '1',
  });
  server.listen(port, host, () => {
    console.log(`Сапёр запущен: http://${host}:${server.address().port}`);
  });
}
