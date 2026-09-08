import { QwenStructuredClient } from '../src/ai/qwen';

test('LAN Qwen client requests strict JSON without a thinking preamble', async () => {
  let requestedUrl = '';
  let requestedBody: Record<string, unknown> | null = null;
  let requestedHeaders = new Headers();
  const fetchImpl: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requestedHeaders = new Headers(init?.headers);
    return new Response(
      JSON.stringify({
        model: 'qwen3.8-27b-huihui-abliterated-nvfp4',
        choices: [
          {
            message: { content: '{"content":"Vegeta lunges."}' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 80,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 5 },
        },
      }),
      { status: 200 },
    );
  };
  const client = new QwenStructuredClient(
    {
      baseUrl: 'http://192.168.10.30:8000/v1/',
      model: 'qwen3.8-27b-huihui-abliterated-nvfp4',
      timeoutMs: 300000,
    },
    fetchImpl,
  );
  const schema = {
    type: 'object',
    required: ['content'],
    properties: { content: { type: 'string' } },
  };

  const result = await client.run('Return one shot.', schema, 'score:submission-1');

  expect(requestedUrl).toBe(
    'http://192.168.10.30:8000/v1/chat/completions',
  );
  expect(requestedBody).toMatchObject({
    model: 'qwen3.8-27b-huihui-abliterated-nvfp4',
    temperature: 0.2,
    response_format: {
      type: 'json_schema',
      json_schema: { strict: true, schema },
    },
    chat_template_kwargs: { enable_thinking: false },
  });
  expect(requestedHeaders.get('x-qwen-user')).toBe(
    'crowdmovie:score:submission-1',
  );
  expect(
    (requestedBody.messages as Array<{ role: string; content: string }>)[0],
  ).toMatchObject({
    role: 'system',
    content: expect.stringContaining('primary structured-content worker'),
  });
  expect(result).toMatchObject({
    content: '{"content":"Vegeta lunges."}',
    model: 'qwen3.8-27b-huihui-abliterated-nvfp4',
    usage: {
      input_tokens: 80,
      cached_input_tokens: 5,
      output_tokens: 10,
      reasoning_output_tokens: 0,
    },
  });
});

test('automatic shot writing uses a higher temperature without changing other Qwen tasks', async () => {
  const temperatures: unknown[] = [];
  const client = new QwenStructuredClient(
    {
      baseUrl: 'http://192.168.10.30:8000/v1',
      model: 'qwen3.8-27b-huihui-abliterated-nvfp4',
      timeoutMs: 300000,
    },
    async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      temperatures.push(body.temperature);
      return new Response(
        JSON.stringify({
          model: 'qwen3.8-27b-huihui-abliterated-nvfp4',
          choices: [
            { message: { content: '{"ok":true}' }, finish_reason: 'stop' },
          ],
        }),
        { status: 200 },
      );
    },
  );

  await client.run('Write a shot.', {}, 'automatic:round-1');
  await client.run('Score it.', {}, 'score:submission-1');

  expect(temperatures).toEqual([0.7, 0.2]);
});

test('LAN Qwen client rejects truncated structured output', async () => {
  const client = new QwenStructuredClient(
    {
      baseUrl: 'http://192.168.10.30:8000/v1',
      model: 'qwen3.8-27b-huihui-abliterated-nvfp4',
      timeoutMs: 300000,
    },
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: '{"content":"unfinished' },
              finish_reason: 'length',
            },
          ],
        }),
        { status: 200 },
      ),
  );

  await expect(client.run('Return one shot.', {})).rejects.toThrow(
    /did not finish cleanly \(length\)/,
  );
});

test('director reserves token space for 8000 words without expanding scoring responses', async () => {
  const limits: number[] = [];
  const client = new QwenStructuredClient({ baseUrl: 'http://localhost/v1', model: 'qwen', timeoutMs: 1000 }, async (_url, init) => {
    limits.push(JSON.parse(String(init?.body)).max_tokens);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }));
  });
  await client.run('Plan', {}, 'director:round'); await client.run('Score', {}, 'score:submission');
  expect(limits).toEqual([32768, 16384]);
});

test('CrowdMovie queues a fourth Qwen call behind its three local slots', async () => {
  let releaseOne!: () => void;
  const firstRelease = new Promise<void>((resolve) => {
    releaseOne = resolve;
  });
  let entered = 0;
  let active = 0;
  let peak = 0;
  const client = new QwenStructuredClient(
    {
      baseUrl: 'http://192.168.10.30:8000/v1',
      model: 'qwen3.8-27b-huihui-abliterated-nvfp4',
      timeoutMs: 300000,
      maxConcurrency: 3,
    },
    async () => {
      entered += 1;
      active += 1;
      peak = Math.max(peak, active);
      if (entered <= 3) await firstRelease;
      active -= 1;
      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: '{"ok":true}' }, finish_reason: 'stop' },
          ],
        }),
        { status: 200 },
      );
    },
  );

  const calls = Array.from({ length: 4 }, (_, index) =>
    client.run('Return JSON.', {}, `task:${index}`),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(entered).toBe(3);
  expect(peak).toBe(3);

  releaseOne();
  await Promise.all(calls);
  expect(entered).toBe(4);
  expect(peak).toBe(3);
});
