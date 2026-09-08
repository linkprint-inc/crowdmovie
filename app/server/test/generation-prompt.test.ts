import pg from 'pg';
import { runMigrations } from '../src/db/migrate';
import { buildApp } from '../src/web/app';
import { ensureDatabase, resetStory, testConfig, TEST_URL } from './helpers';
import { createScene } from './scene-fixture';

let pool: pg.Pool;
let app: ReturnType<typeof buildApp>;
beforeAll(async () => {
  await ensureDatabase();
  await runMigrations(TEST_URL);
  pool = new pg.Pool({ connectionString: TEST_URL });
  app = buildApp(testConfig, pool, { events: false });
  await app.ready();
}, 60_000);
afterAll(async () => { await app?.close(); await pool?.end(); });
beforeEach(async () => { await resetStory(pool); });

async function fixture(prompt: string, state = 'published', submitted = true) {
  const scene = await createScene(pool);
  const result = await pool.query<{ round_id: string; director_ai_run_id: string }>(
    'SELECT round_id, director_ai_run_id FROM scenes WHERE movie_id=$1 AND scene_index=$2',
    [scene.movieId, scene.sceneIndex],
  );
  const row = result.rows[0];
  await pool.query('UPDATE ai_runs SET output_json=$2::jsonb WHERE id=$1', [row.director_ai_run_id, JSON.stringify({
    durationSeconds: 10.125, secretInternalNotes: 'PRIVATE',
    comfyuiWorkflow: { prompt: {
      arbitraryNodeId: { class_type: 'MiniMaxH3ImageToVideo', inputs: { prompt, secret: 'PRIVATE' } },
      another: { class_type: 'OtherNode', inputs: { prompt: 'NOT THE H3 TEXT' } },
    } },
  })]);
  await pool.query('UPDATE rounds SET status=$2 WHERE id=$1', [row.round_id, state]);
  await pool.query(`INSERT INTO workflow_jobs (movie_id, round_id, job_type, status, upstream_job_id, payload_json)
    VALUES ($1,$2,'video_generate',$3,$4,$5::jsonb)`, [scene.movieId, row.round_id,
    state === 'generating' ? 'running' : 'succeeded', submitted ? 'actual-upstream-id' : null,
    JSON.stringify({ directorAiRunId: row.director_ai_run_id, privateToken: 'PRIVATE' }),
  ]);
  return row;
}
const url = '/api/movies/inland-empire-high/generation-prompt';

test('no submitted H3 task returns an explicit empty result', async () => {
  await fixture('not submitted', 'generating', false);
  const response = await app.inject({ method: 'GET', url });
  expect(response.json()).toEqual({ generation: null });
  expect(response.headers['cache-control']).toBe('no-store');
});

test('idle falls back to exact last submitted text, not newer unsubmitted drafts', async () => {
  await fixture('  Shot 1\n0–5s: move.\n<d>Hello</d>  ');
  await fixture('never sent', 'generating', false);
  const response = await app.inject({ method: 'GET', url });
  expect(response.json()).toEqual({ generation: {
    mode: 'latest', roundIndex: 1, status: 'published',
    prompt: 'Shot 1\n0–5s: move.\n<d>Hello</d>', durationSeconds: 10.125,
  } });
  expect(response.body).not.toContain('PRIVATE');
  expect(response.body).not.toContain('comfyuiWorkflow');
});

test('currently generating takes precedence over a later historical task', async () => {
  await fixture('current', 'generating');
  await fixture('history');
  const response = await app.inject({ method: 'GET', url });
  expect(response.json().generation).toMatchObject({ mode: 'current', roundIndex: 1, prompt: 'current' });
});

test('failed submitted task remains labelled as the last generation, not currently running', async () => {
  await fixture('last attempt', 'generation_failed');
  const response = await app.inject({ method: 'GET', url });
  expect(response.json().generation).toMatchObject({ mode: 'latest', status: 'generation_failed', prompt: 'last attempt' });
});

test('movie boundary, malformed prompt and removed content are not exposed', async () => {
  const row = await fixture('private after takedown');
  const other = await app.inject({ method: 'GET', url: '/api/movies/whos-next/generation-prompt' });
  expect(other.json()).toEqual({ generation: null });
  await pool.query('UPDATE scenes SET takedown_at=now() WHERE round_id=$1', [row.round_id]);
  expect((await app.inject({ method: 'GET', url })).json()).toEqual({ generation: null });
  await pool.query('UPDATE scenes SET takedown_at=null WHERE round_id=$1', [row.round_id]);
  await pool.query(`UPDATE ai_runs SET output_json='{"comfyuiWorkflow":{"prompt":[]}}'::jsonb WHERE id=$1`, [row.director_ai_run_id]);
  expect((await app.inject({ method: 'GET', url })).json()).toEqual({ generation: null });
  expect((await app.inject({ method: 'GET', url: '/api/movies/no-such-movie/generation-prompt' })).statusCode).toBe(404);
});
