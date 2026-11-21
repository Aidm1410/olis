import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { MINES, RESET_DELAY, SIZE } from '../game.js';
import { createGameServer } from '../server.js';

const REWARD = "https://example.test/#secret-reward+)&$'?[]#";

async function start(t) {
  const directory = mkdtempSync(join(tmpdir(), 'minesweeper-'));
  const databasePath = join(directory, 'test.sqlite');
  const server = createGameServer({ rewardUrl: REWARD, databasePath });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const db = new DatabaseSync(databasePath);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(directory, { recursive: true });
  });

  async function post(path, { cookie, body, requestOrigin = origin } = {}) {
    const headers = { Origin: requestOrigin };
    if (cookie) headers.Cookie = cookie;
    if (body) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${origin}/api/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    return { code: response.status, data: await response.json(), headers: response.headers };
  }

  async function game() {
    const response = await post('game');
    assert.equal(response.code, 200);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const id = createHash('sha256').update(cookie.slice(cookie.indexOf('=') + 1)).digest('base64url');
    const saved = () => JSON.parse(db.prepare('SELECT state FROM games WHERE id = ?').get(id).state);
    const move = async (action, index, revision) => {
      const body = { action, index, revision };
      const response = await post('move', { cookie, body });
      if (response.code !== 429) return response;
      await setTimeout(response.data.retryIn + 10);
      return post('move', { cookie, body });
    };
    return { response, cookie, id, saved, move };
  }

  return { db, game, origin, post };
}

test('startup exposes only public files and rejects direct and cross-origin reward requests', async (t) => {
  const { game, origin, post } = await start(t);
  const player = await game();
  assert.match(player.response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal(player.response.headers.get('cache-control'), 'no-store');
  assert.equal(player.response.data.remainingSafe, 381);
  assert.equal((await post('reward')).code, 401);
  assert.equal((await post('reward', { cookie: player.cookie })).code, 403);
  assert.equal((await post('game', { cookie: player.cookie, requestOrigin: 'https://example.test' })).code, 403);
  assert.equal((await post('move', { cookie: player.cookie, body: { action: 'reveal', index: -1, revision: 0 } })).code, 400);

  for (const path of ['/', '/app.js', '/style.css']) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), /secret-reward/);
  }
  for (const path of ['/.env', '/server.js', '/game.js', '/package.json', '/.data/games.sqlite', '/%2e%2e/.env']) {
    assert.equal((await fetch(`${origin}${path}`)).status, 404);
  }
});

test('a first reveal opens a safe area, stale moves cannot branch, and a loss replaces the board', async (t) => {
  const { game, post } = await start(t);
  const player = await game();
  const first = await player.move('reveal', 0, 0);
  assert.equal(first.data.status, 'playing');
  assert.equal(new Map(first.data.cells).get(0), 0);
  assert.equal(first.data.mines, undefined);
  assert.equal(first.data.url, undefined);
  const mines = player.saved().mines;
  assert.equal(new Set(mines).size, MINES);

  await setTimeout(75);
  const next = { action: 'reveal', index: mines[0], revision: first.data.revision };
  const moves = await Promise.all([
    post('move', { cookie: player.cookie, body: next }),
    post('move', { cookie: player.cookie, body: next }),
  ]);
  assert.deepEqual(moves.map((entry) => entry.code).sort(), [200, 409]);
  const loss = moves.find((entry) => entry.code === 200).data;
  assert.equal(loss.status, 'lost');
  assert.equal(loss.exploded, mines[0]);
  assert.equal(loss.mines, undefined);
  assert.equal((await post('reward', { cookie: player.cookie })).code, 403);
  assert.equal((await player.move('reset', undefined, loss.revision)).data.status, 'lost');

  await setTimeout(RESET_DELAY);
  const reset = await player.move('reset', undefined, loss.revision);
  assert.equal(reset.data.status, 'ready');
  assert.deepEqual(reset.data.cells, []);
  const replacement = await player.move('reveal', 0, reset.data.revision);
  assert.equal(replacement.data.status, 'playing');
  assert.notDeepEqual(player.saved().mines.slice().sort(), mines.slice().sort());
});

test('only a session with a completed board can claim the unmodified HTTPS link', async (t) => {
  const { db, game, post } = await start(t);
  const winner = await game();
  const other = await game();
  const first = await winner.move('reveal', 0, 0);
  const saved = winner.saved();
  const mines = new Set(saved.mines);
  const remaining = Array.from({ length: SIZE }, (_, index) => index)
    .find((index) => !mines.has(index) && !saved.revealed.includes(index));
  saved.revealed = Array.from({ length: SIZE }, (_, index) => index)
    .filter((index) => !mines.has(index) && index !== remaining);
  db.prepare('UPDATE games SET state = ? WHERE id = ?').run(JSON.stringify(saved), winner.id);

  assert.equal((await post('reward', { cookie: winner.cookie, body: { status: 'won' } })).code, 403);
  const last = await winner.move('reveal', remaining, first.data.revision);
  assert.equal(last.data.status, 'won');
  assert.equal(last.data.remainingSafe, 0);
  assert.equal(last.data.url, undefined);
  assert.equal((await post('reward', { cookie: other.cookie })).code, 403);
  const claim = await post('reward', { cookie: winner.cookie });
  assert.equal(claim.code, 200);
  assert.deepEqual(claim.data, { url: REWARD });
  assert.equal(claim.headers.get('cache-control'), 'no-store');

  await winner.move('reset', undefined, last.data.revision);
  assert.equal((await post('reward', { cookie: winner.cookie })).code, 403);
});
