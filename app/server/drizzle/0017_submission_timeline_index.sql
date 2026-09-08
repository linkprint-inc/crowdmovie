CREATE INDEX IF NOT EXISTS "submissions_movie_timeline_idx"
  ON "submissions" USING btree ("movie_id", "created_at" DESC, "id" DESC)
  WHERE "kind" = 'next_shot';
