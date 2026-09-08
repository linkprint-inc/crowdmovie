// Exports a reviewable edit manifest from durable published scenes; no DB writes.
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import type { AuthorSubtitlesOutput } from '../ai/engine.js';
import type { EpisodeEdit } from '../media/episode-edit.js';

const [movieId, episodeId, destination] = process.argv.slice(2);
if (!movieId || !episodeId || !destination || !process.env.DATABASE_URL) throw new Error('Usage: DATABASE_URL=... episode-edit-export movie-id episode-id manifest.json');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const result = await pool.query<{
    id: string; title: string; media: { video: string; sha256: string }; duration_seconds: string;
    credit: string | null; subtitles: AuthorSubtitlesOutput;
  }>(`SELECT s.id, e.title, s.media, s.duration_seconds, u.username_display AS credit, a.output_json AS subtitles
        FROM scenes s JOIN episodes e ON e.id=s.episode_id
        JOIN ai_runs a ON a.id=s.subtitle_ai_run_id LEFT JOIN users u ON u.id=s.credit_user_id
       WHERE s.movie_id=$1 AND s.episode_id=$2 AND s.takedown_at IS NULL ORDER BY s.scene_index`, [movieId, episodeId]);
  if (!result.rows.length) throw new Error('No published source clips in this movie/episode');
  const edit: EpisodeEdit = { version: 'episode-edit-v1', movieId, episodeId, title: result.rows[0].title,
    clips: result.rows.map((row) => ({ sceneId: row.id, source: row.media.video, sha256: row.media.sha256,
      durationSeconds: Number(row.duration_seconds), inSeconds: 0, outSeconds: Number(row.duration_seconds), credit: row.credit, cues: row.subtitles.cues })) };
  await writeFile(destination, JSON.stringify(edit, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ destination, clips: edit.clips.length, databaseWrites: false }));
} finally { await pool.end(); }
