// Real, bounded Codex story-review canary. It starts one isolated review agent
// with a fixed fictional-violence submission plus one harmless local image.
// It never opens PostgreSQL, creates workflow jobs, or contacts H3.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCodexStoryReviewer } from '../ai/codex-story-review.js';

// A valid 1x1 white PNG. Keeping the fixture in memory avoids depending on any
// user upload or production media path during the canary.
const WHITE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4KsAAAAASUVORK5CYII=',
  'base64',
);

const retries = Number(process.env.CODEX_OUTPUT_RETRIES ?? 2);
const timeoutSeconds = Number(process.env.CODEX_TURN_TIMEOUT_SECONDS ?? 300);
if (!Number.isInteger(retries) || retries < 0 || retries > 2) {
  throw new Error('CODEX_OUTPUT_RETRIES must be an integer from 0 to 2');
}
if (
  !Number.isInteger(timeoutSeconds) ||
  timeoutSeconds < 30 ||
  timeoutSeconds > 1800
) {
  throw new Error('CODEX_TURN_TIMEOUT_SECONDS must be an integer from 30 to 1800');
}
const config = {
  CODEX_MODEL: 'gpt-5.6-sol',
  CODEX_WORKSTATION_DIR:
    process.env.CODEX_WORKSTATION_DIR ?? '/opt/crowdmovie/workstation',
  CODEX_SCORE_REASONING_EFFORT: 'high' as const,
  CODEX_OUTPUT_RETRIES: retries,
  CODEX_TURN_TIMEOUT_SECONDS: timeoutSeconds,
};
const reviewDir = await mkdtemp(join(tmpdir(), 'crowdmovie-story-review-canary-'));
const imagePath = join(reviewDir, 'reference-card.png');

try {
  await writeFile(imagePath, WHITE_PNG, { mode: 0o600 });
  const reviewer = createCodexStoryReviewer(config);
  const verdict = await reviewer.review({
    title: 'Fictional Action Film Safety Canary',
    synopsis:
      'A fictional adult action hero fights monsters through a war-torn city. ' +
      'The movie contains weapons, blood, gore, death, explosions, horror, and ' +
      'large-scale destruction, but no sexual content, no minors in sexual ' +
      'situations, and no advocacy of real-world crimes against humanity.',
    images: [
      {
        kind: 'world',
        position: 0,
        caption: 'A plain white production reference card with no unsafe content.',
        path: imagePath,
        mime: 'image/png',
      },
    ],
  });

  const output = {
    ok: verdict.ok,
    reasons: verdict.reasons,
    provider: reviewer.identity.provider,
    model: reviewer.identity.model,
    policyVersion: verdict.metadata?.policyVersion ?? null,
    reasoningEffort: verdict.metadata?.reasoningEffort ?? null,
    threadId: verdict.metadata?.threadId ?? null,
    attempts: verdict.metadata?.attempts ?? null,
    usage: verdict.metadata?.usage ?? null,
    fictionalViolenceExpected: 'approved',
    databaseWrites: false,
    gpuRequested: false,
  };
  console.log(JSON.stringify(output));
  if (!verdict.ok) process.exitCode = 1;
} finally {
  await rm(reviewDir, { recursive: true, force: true });
}
