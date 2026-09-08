// The §5 pipeline, one handler per `job_type`.
//
import type { JobType } from '../ledger.js';
import { aiScreenwriterHandler } from './ai-screenwriter.js';
import { directorHandler } from './director.js';
import { episodeBootstrapHandler } from './episode-bootstrap.js';
import { episodeThemeHandler } from './episode-theme.js';
import { finalizeHandler } from './finalize.js';
import { maintenanceHandler } from './maintenance.js';
import { publishHandler } from './publish.js';
import { scoreHandler } from './score.js';
import { storyReviewHandler } from './story-review.js';
import { subtitleHandler } from './subtitle.js';
import { videoHandler } from './video.js';
import type { Handler } from './common.js';

export type HandlerRegistry = Partial<Record<JobType, Handler>>;

export const CONTENT_HANDLERS: HandlerRegistry = {
  submission_score: scoreHandler,
  round_finalize: finalizeHandler,
  episode_bootstrap: episodeBootstrapHandler,
  ai_screenwriter: aiScreenwriterHandler,
  episode_theme: episodeThemeHandler,
  scene_director: directorHandler,
  video_generate: videoHandler,
  subtitle_author: subtitleHandler,
  media_validate_publish: publishHandler,
  story_review: storyReviewHandler,
};

export const MAINTENANCE_HANDLERS: HandlerRegistry = {
  maintenance: maintenanceHandler,
};

export const HANDLERS: HandlerRegistry = {
  ...CONTENT_HANDLERS,
  ...MAINTENANCE_HANDLERS,
};

export * from './common.js';
export { maintenanceHandler } from './maintenance.js';
