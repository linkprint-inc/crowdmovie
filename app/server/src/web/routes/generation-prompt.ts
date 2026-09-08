import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

import { findPublicMovie } from '../../movies/catalog.js';

// Follow the exact director run referenced by the submitted video job. A newer
// draft/repair run is not evidence of what H3 received. The gateway validates
// this node's text and only trims surrounding whitespace before forwarding it.
export const GENERATION_PROMPT_SQL = `
  SELECT r.round_index, r.status, h3.prompt,
         a.output_json->>'durationSeconds' AS duration_seconds,
         (r.status = 'generating' AND j.status IN ('pending', 'running', 'retryable_failed')) AS is_current
    FROM workflow_jobs j
    JOIN rounds r ON r.id = j.round_id AND r.movie_id = j.movie_id
    JOIN ai_runs a ON a.id::text = j.payload_json->>'directorAiRunId'
      AND a.round_id = r.id AND a.movie_id = r.movie_id
      AND a.run_type = 'scene_director' AND a.status = 'succeeded'
    JOIN LATERAL (
      SELECT max(node.value #>> '{inputs,prompt}') AS prompt, count(*) AS node_count
        FROM jsonb_each(CASE
          WHEN jsonb_typeof(a.output_json #> '{comfyuiWorkflow,prompt}') = 'object'
          THEN a.output_json #> '{comfyuiWorkflow,prompt}' ELSE '{}'::jsonb END) node
       WHERE node.value->>'class_type' = 'MiniMaxH3ImageToVideo'
         AND jsonb_typeof(node.value #> '{inputs,prompt}') = 'string'
    ) h3 ON h3.node_count = 1 AND length(trim(h3.prompt)) > 0
   WHERE j.movie_id = $1 AND j.job_type = 'video_generate'
     AND nullif(j.upstream_job_id, '') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM scenes s WHERE s.round_id = r.id AND s.takedown_at IS NOT NULL)
   ORDER BY is_current DESC, r.round_index DESC, j.created_at DESC
   LIMIT 1`;

export async function generationPromptRoutes(app: FastifyInstance, { pool }: { pool: Pool }): Promise<void> {
  app.get<{ Params: { movieSlug: string } }>('/api/movies/:movieSlug/generation-prompt', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const movie = await findPublicMovie(pool, request.params.movieSlug);
    if (movie === null) {
      return reply.code(404).send({ error: 'movie_not_found', message: '影片不存在' });
    }
    const result = await pool.query<{
      round_index: string; status: string; prompt: string;
      duration_seconds: string | null; is_current: boolean;
    }>(GENERATION_PROMPT_SQL, [movie.id]);
    const row = result.rows[0];
    if (row === undefined) return { generation: null };
    const duration = Number(row.duration_seconds);
    return {
      generation: {
        mode: row.is_current ? 'current' : 'latest',
        roundIndex: Number(row.round_index),
        status: row.status,
        prompt: row.prompt.trim(),
        durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
      },
    };
  });
}
