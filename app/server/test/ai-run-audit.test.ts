import type { PoolClient } from 'pg';
import { describe, expect, test, vi } from 'vitest';

import { attachEngineRunMetadata, type ContentEngine } from '../src/ai/engine';
import {
  insertAiRun,
  insertFailedAiRun,
  loadRecentScenes,
} from '../src/jobs/handlers/common';

const engine = {
  identity: { provider: 'openai_codex', model: 'gpt-5.6-sol' },
} as ContentEngine;

describe('routed content audit identity', () => {
  test('successful score records Qwen/no-thinking from call metadata', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'ai-run-id' }] });
    const output = attachEngineRunMetadata(
      { eligible: true },
      {
        threadId: null,
        usage: { input_tokens: 10 },
        identity: {
          provider: 'qwen_vllm',
          model: 'qwen3.8-27b-huihui-abliterated-nvfp4',
        },
        reasoningEffort: 'none',
      },
    );

    await insertAiRun({ query } as unknown as PoolClient, engine, {
      roundId: 'round-id',
      submissionId: 'submission-id',
      runType: 'submission_score',
      input: { content: 'one shot' },
      output,
      latencyMs: 12,
    });

    const values = query.mock.calls[0][1] as unknown[];
    expect(values.slice(3, 7)).toEqual([
      'qwen_vllm',
      'qwen3.8-27b-huihui-abliterated-nvfp4',
      'none',
      null,
    ]);
  });

  test('failed score records the exact Qwen model and no-thinking effort', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await insertFailedAiRun({ query }, engine, {
      roundId: 'round-id',
      submissionId: 'submission-id',
      runType: 'submission_score',
      input: { content: 'one shot' },
      provider: 'qwen_vllm',
      model: 'qwen3.8-27b-huihui-abliterated-nvfp4',
      reasoningEffort: 'none',
      threadId: null,
      usage: null,
      latencyMs: 12,
      status: 'retryable_failed',
      errorCode: 'qwen_invocation_failed',
      errorSummary: 'bad output',
    });

    const values = query.mock.calls[0][1] as unknown[];
    expect(values.slice(3, 7)).toEqual([
      'qwen_vllm',
      'qwen3.8-27b-huihui-abliterated-nvfp4',
      'none',
      null,
    ]);
  });
});

test('score context reads only the current episode recent canon', async () => {
  const query = vi.fn().mockResolvedValue({
    rows: [
      { scene_index: 4, summary_zh: '第四幕', duration_seconds: '5.000' },
      { scene_index: 3, summary_zh: '第三幕', duration_seconds: '5.000' },
    ],
  });

  const scenes = await loadRecentScenes({ query }, 'movie-id', 'episode-id');

  expect(query.mock.calls[0][0]).toContain('WHERE movie_id = $1 AND episode_id = $2');
  expect(query.mock.calls[0][1]).toEqual(['movie-id', 'episode-id', 3]);
  expect(scenes.map((scene) => scene.sceneIndex)).toEqual([3, 4]);
});
