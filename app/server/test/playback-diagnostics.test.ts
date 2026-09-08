import Fastify from 'fastify';
import { playbackDiagnosticRoutes } from '../src/web/routes/playback-diagnostics';

const payload = { id: '12345678-1234-1234-1234-123456789abc', kind: 'media_error', source: '/media/whos-next/000014.mp4', sceneIndex: 14, events: ['loadstart:123', 'error:456'] };
test('records bounded playback diagnostics without needing a user or database', async () => {
  const lines: string[] = [];
  const app = Fastify({ logger: { stream: { write: (line: string) => { lines.push(line); } } } });
  app.register(playbackDiagnosticRoutes);
  const result = await app.inject({ method: 'POST', url: '/api/diagnostics/playback', payload, headers: { 'user-agent': 'Mobile Safari' } });
  expect(result.statusCode).toBe(204);
  const entry = lines.map(line => JSON.parse(line)).find(line => line.msg === 'client_playback_failure');
  expect(entry.diagnostic.sceneIndex).toBe(14);
  expect(entry.userAgent).toBe('Mobile Safari');
  const recovered = await app.inject({ method: 'POST', url: '/api/diagnostics/playback', payload: {
    ...payload, kind: 'buffered_playing', delivery: 'buffered', bufferedBytes: 6726001,
  } });
  expect(recovered.statusCode).toBe(204);
  const recovery = lines.map(line => JSON.parse(line)).find(line => line.diagnostic?.kind === 'buffered_playing');
  expect(recovery.diagnostic).toMatchObject({ delivery: 'buffered', bufferedBytes: 6726001 });
  const check = await app.inject({ method: 'POST', url: '/api/diagnostics/playback', payload: {
    ...payload, kind: 'check_result', context: 'minimal_fullscreen', mediaErrorMessage: 'AVFoundationErrorDomain -11800',
  } });
  expect(check.statusCode).toBe(204);
  const external = await app.inject({ method: 'POST', url: '/api/diagnostics/playback', payload: {
    ...payload, kind: 'check_result', context: 'external_control', source: '/media/cc0-videos/flower.mp4', sceneIndex: 0,
  } });
  expect(external.statusCode).toBe(204);
  await app.close();
});
test('rejects arbitrary URLs and bounds event data and request rate', async () => {
  const app = Fastify(); app.register(playbackDiagnosticRoutes);
  const post = (body: object) => app.inject({ method: 'POST', url: '/api/diagnostics/playback', payload: body });
  expect((await post({ ...payload, source: 'https://example.com/?secret=1' })).statusCode).toBe(400);
  expect((await post({ ...payload, events: Array(17).fill('error:1') })).statusCode).toBe(400);
  for (let i = 0; i < 20; i++) expect((await post(payload)).statusCode).toBe(204);
  expect((await post(payload)).statusCode).toBe(429);
  await app.close();
});
