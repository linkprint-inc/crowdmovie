// `story_review` — 用户提交的故事设定送审（《故事设定投稿技术规范》§5.4）。
// Channel `story` (concurrency 1).
//
// The job was enqueued inside the submit transaction, so it exists exactly when
// a proposal is `pending` — the same rule §6.3 applies to submission scoring,
// and for the same reason: a proposal that exists without its review job would
// sit at `pending` for ever.
//
// One submission, one isolated Codex agent/thread. All text, captions and image
// attachments are judged together so fictional context is not lost by asking
// disconnected per-image moderation calls.
import { access } from 'node:fs/promises';

import { withTransaction } from '../../db/tx.js';
import { storyImagePath } from '../../lib/story-images.js';
import { requirePayload, type Handler } from './common.js';

interface StoryReviewPayload {
  proposalId: string;
}

interface ProposalRow {
  id: string;
  title: string;
  synopsis: string;
  status: string;
}

interface ImageRow {
  id: string;
  kind: 'character' | 'world';
  position: number;
  caption: string;
  file_url: string;
  mime: string;
}

export const storyReviewHandler: Handler = async ({
  pool,
  reviewer,
  job,
  settings,
  log,
}) => {
  if (reviewer === undefined) {
    throw new Error('story reviewer is not configured');
  }
  const { proposalId } = requirePayload<StoryReviewPayload>(job, ['proposalId']);

  const found = await pool.query<ProposalRow>(
    'SELECT id, title, synopsis, status FROM story_proposals WHERE id = $1',
    [proposalId],
  );
  const proposal = found.rows[0];
  if (proposal === undefined) {
    // A draft may have been deleted between submit and claim. Nothing to review
    // and nothing to retry.
    return { kind: 'done', note: 'proposal is gone' };
  }
  // Re-verify before spending thirteen model calls: a stolen lease means
  // another worker may already have decided this one.
  if (proposal.status !== 'pending') {
    return { kind: 'done', note: `already ${proposal.status}` };
  }

  // 顺序是有意义的：`captions` 是一个没有 kind 标签的扁平数组，人物图在前、
  // 世界观图在后是接口契约里唯一区分两组的信号（ai/story-review.ts 的
  // ReviewTextInput.captions）。'character' < 'world'，所以是 ASC。
  const images = await pool.query<ImageRow>(
    `SELECT id, kind, position, caption, file_url, mime
       FROM story_images
      WHERE proposal_id = $1
      ORDER BY kind ASC, position ASC`,
    [proposalId],
  );

  const reviewImages = await Promise.all(images.rows.map(async (image) => {
    const path = storyImagePath(settings.mediaDir, image.file_url);
    if (path === null) {
      throw new Error(`image ${image.id} is not under ${settings.mediaDir}`);
    }
    // Check storage before starting a paid model turn. A missing upload is a
    // retryable platform failure, not a content refusal.
    await access(path);
    return {
      kind: image.kind,
      position: image.position,
      caption: image.caption,
      path,
      mime: image.mime,
    };
  }));

  const verdict = await reviewer.review({
    title: proposal.title,
    synopsis: proposal.synopsis,
    images: reviewImages,
  });
  if (!verdict.ok && verdict.reasons.length === 0) {
    throw new Error('story reviewer refused without an actionable reason');
  }
  if (verdict.ok && verdict.reasons.length > 0) {
    throw new Error('story reviewer approved while returning refusal reasons');
  }
  const approved = verdict.ok;
  const reasons = verdict.reasons;
  const wrote = await withTransaction(pool, async (client) => {
    // Conditional on status so a proposal another worker already decided is not
    // overwritten by this one's verdict.
    const updated = await client.query(
      `UPDATE story_proposals SET
         status = $2,
         reject_reason = $3,
         review_model = $4,
         review_output = $5::jsonb,
         reviewed_at = now(),
         published_at = CASE WHEN $2 = 'approved' THEN now() ELSE published_at END,
         updated_at = now()
       WHERE id = $1 AND status = 'pending'`,
      [
        proposalId,
        approved ? 'approved' : 'rejected',
        approved ? null : reasons.join('\n'),
        reviewer.identity.model,
        JSON.stringify({
          approved,
          reasons,
          provider: reviewer.identity.provider,
          model: reviewer.identity.model,
          ...(verdict.metadata === undefined
            ? {}
            : {
                policyVersion: verdict.metadata.policyVersion,
                codexThreadId: verdict.metadata.threadId,
                reasoningEffort: verdict.metadata.reasoningEffort,
                attempts: verdict.metadata.attempts,
                usage: verdict.metadata.usage,
              }),
        }),
      ],
    );
    return updated.rowCount !== 0;
  });

  if (!wrote) {
    log.warn({ proposalId }, 'story proposal was reviewed by another worker');
    return { kind: 'done', note: 'already reviewed' };
  }
  log.info({ proposalId, approved }, 'story proposal reviewed');
  return { kind: 'done' };
};
