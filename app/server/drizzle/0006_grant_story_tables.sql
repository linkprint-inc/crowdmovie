-- Custom SQL migration file, put your code below! --

-- Production role grants for the four story-proposal tables, following the
-- same shape as 0001_grant_prod_roles.sql: the two prod login roles exist only
-- in production, so each block checks pg_roles first and is a graceful no-op on
-- a fresh local or CI database.
--
-- Intent, matching 0001:
--   * crowdmovie_web + crowdmovie_worker: SELECT, INSERT, UPDATE on all four.
--   * crowdmovie_web additionally needs DELETE on story_proposals (an author
--     may throw away a draft) and on story_images and story_likes (replacing a
--     slot deletes the old row; un-liking deletes the like). No DELETE on
--     story_comments: a reply is taken down with status = 'hidden', the way a
--     scene is taken down with takedown_at.
--   * story_comments.id is GENERATED ALWAYS AS IDENTITY, so table-level INSERT
--     is sufficient and no sequence USAGE grant is required.

DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crowdmovie_web') THEN
		GRANT SELECT, INSERT, UPDATE ON
			"story_proposals", "story_images", "story_likes", "story_comments"
		TO crowdmovie_web;
		GRANT DELETE ON
			"story_proposals", "story_images", "story_likes"
		TO crowdmovie_web;
	END IF;

	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crowdmovie_worker') THEN
		GRANT SELECT, INSERT, UPDATE ON
			"story_proposals", "story_images", "story_likes", "story_comments"
		TO crowdmovie_worker;
	END IF;
END
$$;
