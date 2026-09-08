// Env validation. A service that starts with a half-configured environment is
// worse than one that refuses to start, so every failure here must name the
// offending key loudly enough to read it out of `journalctl`.
import { loadConfig } from '../src/config';

const VALID = {
  SERVICE_ROLE: 'web',
  DATABASE_URL: 'postgresql://localhost:5432/crowdmovie',
  SESSION_SECRET: 'x'.repeat(32),
};

test('empty env throws and names every missing required key', () => {
  let message = '';
  expect(() => {
    try {
      loadConfig({});
    } catch (err) {
      message = (err as Error).message;
      throw err;
    }
  }).toThrow();
  expect(message).toContain('SERVICE_ROLE');
  expect(message).toContain('DATABASE_URL');
  expect(message).toContain('SESSION_SECRET');
});

test('unknown SERVICE_ROLE throws and names SERVICE_ROLE', () => {
  expect(() => loadConfig({ ...VALID, SERVICE_ROLE: 'admin' })).toThrow(
    /SERVICE_ROLE/,
  );
});

test('SESSION_SECRET shorter than 32 characters throws', () => {
  expect(() =>
    loadConfig({ ...VALID, SESSION_SECRET: 'x'.repeat(31) }),
  ).toThrow(/SESSION_SECRET/);
});

test('empty DATABASE_URL throws', () => {
  expect(() => loadConfig({ ...VALID, DATABASE_URL: '' })).toThrow(
    /DATABASE_URL/,
  );
});

test('valid env returns a typed config with defaults applied', () => {
  const config = loadConfig(VALID);
  expect(config.SERVICE_ROLE).toBe('web');
  expect(config.DATABASE_URL).toBe(VALID.DATABASE_URL);
  expect(config.PORT).toBe(3100);
  expect(typeof config.PORT).toBe('number');
  expect(config.HOST).toBe('127.0.0.1');
  expect(config.LOG_LEVEL).toBe('info');
  expect(config.CODEX_SCORE_MODEL).toBe('gpt-5.6-terra');
  expect(config.CODEX_MODEL).toBe('gpt-5.6-sol');
  expect(config.CODEX_SCORE_REASONING_EFFORT).toBe('high');
  expect(config.CODEX_FINAL_REASONING_EFFORT).toBe('xhigh');
  expect(config.QWEN_COPYRIGHT_FALLBACK_BASE_URL).toBe(
    'http://192.168.10.30:8000/v1',
  );
  expect(config.QWEN_COPYRIGHT_FALLBACK_MODEL).toBe(
    'qwen3.8-27b-huihui-abliterated-nvfp4',
  );
  expect(config.QWEN_COPYRIGHT_FALLBACK_TIMEOUT_MS).toBe(300000);
  expect(config.QWEN_MAX_CONCURRENCY).toBe(3);
  expect(config.H3_BASE_URL).toBe('http://192.168.10.20:8191');
});

test('CrowdMovie Qwen concurrency is configurable only within its three-slot cap', () => {
  expect(
    loadConfig({ ...VALID, QWEN_MAX_CONCURRENCY: '2' }).QWEN_MAX_CONCURRENCY,
  ).toBe(2);
  expect(() =>
    loadConfig({ ...VALID, QWEN_MAX_CONCURRENCY: '4' }),
  ).toThrow(/QWEN_MAX_CONCURRENCY/);
});

// §5.4「直采阈值由 CROWD_AI_MOVIE_VOTE_ADOPT_THRESHOLD（默认 10）配置」. The
// deployment sets no such key, so this default *is* the number the site runs
// on and the one the 集横幅 publishes to the page.
test('VOTE_ADOPT_THRESHOLD defaults to 10 and is coerced from its env string', () => {
  expect(loadConfig(VALID).VOTE_ADOPT_THRESHOLD).toBe(10);
  const tuned = loadConfig({ ...VALID, VOTE_ADOPT_THRESHOLD: '35' });
  expect(tuned.VOTE_ADOPT_THRESHOLD).toBe(35);
  expect(typeof tuned.VOTE_ADOPT_THRESHOLD).toBe('number');
});

// 净赞 is the compared value, so a threshold of 0 would adopt an unvoted pitch.
test('VOTE_ADOPT_THRESHOLD below 1 throws and names the key', () => {
  expect(() => loadConfig({ ...VALID, VOTE_ADOPT_THRESHOLD: '0' })).toThrow(
    /VOTE_ADOPT_THRESHOLD/,
  );
});

test('PORT is coerced from its string env value to a number', () => {
  const config = loadConfig({ ...VALID, PORT: '3200' });
  expect(config.PORT).toBe(3200);
});

test('out-of-range PORT throws and names PORT', () => {
  expect(() => loadConfig({ ...VALID, PORT: '70000' })).toThrow(/PORT/);
});

test('non-numeric PORT throws and names PORT', () => {
  expect(() => loadConfig({ ...VALID, PORT: 'http' })).toThrow(/PORT/);
});

test('worker and codex roles validate', () => {
  expect(loadConfig({ ...VALID, SERVICE_ROLE: 'worker' }).SERVICE_ROLE).toBe(
    'worker',
  );
  expect(loadConfig({ ...VALID, SERVICE_ROLE: 'codex' }).SERVICE_ROLE).toBe(
    'codex',
  );
});

test('model and effort cannot silently fall back from the pinned contract', () => {
  expect(
    loadConfig({ ...VALID, CODEX_SCORE_MODEL: 'gpt-5.6-sol' })
      .CODEX_SCORE_MODEL,
  ).toBe('gpt-5.6-sol');
  expect(() => loadConfig({ ...VALID, CODEX_MODEL: 'gpt-5.6' })).toThrow(
    /CODEX_MODEL/,
  );
  expect(() =>
    loadConfig({ ...VALID, CODEX_SCORE_MODEL: 'gpt-5.6-luna' }),
  ).toThrow(/CODEX_SCORE_MODEL/);
  expect(() =>
    loadConfig({ ...VALID, CODEX_SCORE_REASONING_EFFORT: 'medium' }),
  ).toThrow(/CODEX_SCORE_REASONING_EFFORT/);
  expect(() =>
    loadConfig({ ...VALID, CODEX_DIRECTOR_REASONING_EFFORT: 'high' }),
  ).toThrow(/CODEX_DIRECTOR_REASONING_EFFORT/);
});

test('loadConfig does not mutate the env object it was given', () => {
  const env = { ...VALID };
  loadConfig(env);
  expect(env).toEqual(VALID);
});
