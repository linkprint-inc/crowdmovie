// 故事设定的写入侧（《故事设定投稿技术规范》§4.2）—— 建草稿、存文、传图、提交。
//
// Everything in this file is account-only, which is the exception on this site
// rather than the rule: a claimed guest name can pitch a scene, vote and post a
// live comment, but not submit a story bible. The check is written once, in
// `requireAccount`, and every route in the file goes through it — an
// account-only rule enforced route by route is one route away from not being a
// rule.
//
// The public half — the board, its likes and its replies — lives in
// routes/stories.ts, because a guest may use all of it and mixing the two
// permission models in one file is how the wrong one gets copied.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

import { withTransaction } from '../../db/tx.js';
import { storyReviewJobKey } from '../../jobs/keys.js';
import { enqueue } from '../../jobs/ledger.js';
import { glen } from '../../lib/grapheme.js';
import {
  CAPTION_MAX,
  SYNOPSIS_MAX,
  SYNOPSIS_MIN,
  mixedCount,
} from '../../lib/mixed-count.js';
import { FixedWindowCounter } from '../../lib/rate-limit.js';
import {
  MAX_IMAGE_BYTES,
  deleteStoryImage,
  sha256,
  sniffImageType,
  writeStoryImage,
} from '../../lib/story-images.js';

/** 短字段，与站内其他短字段同口径（规范 §2）。 */
export const STORY_TITLE_MAX_GRAPHEMES = 80;

/** 2000 字/词的大纲最多几十 KB；其余是 JSON 开销与余量。 */
const STORY_BODY_LIMIT = 128 * 1024;

/** 编辑器每 2 秒自动保存一次，三个字段轮流写。这是防洪，不是配额。 */
const STORY_RATE_LIMIT = 240;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StoryAuthoringOptions {
  pool: Pool;
  /** `MEDIA_DIR` —— 图片落盘的根目录（规范 §4.4）。 */
  mediaDir: string;
  /** 写操作 per minute per IP and per identity; tests pin it. */
  storyRateLimit?: number;
}

interface ProposalRow {
  id: string;
  title: string;
  synopsis: string;
  status: string;
  reject_reason: string | null;
  created_at: Date;
  updated_at: Date;
  submitted_at: Date | null;
  published_at: Date | null;
}

const PROPOSAL_COLUMNS = `id, title, synopsis, status, reject_reason,
                          created_at, updated_at, submitted_at, published_at`;

function proposalView(row: ProposalRow): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    synopsis: row.synopsis,
    status: row.status,
    rejectReason: row.reject_reason,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    submittedAt: row.submitted_at?.toISOString() ?? null,
    publishedAt: row.published_at?.toISOString() ?? null,
  };
}

export async function storyAuthoringRoutes(
  app: FastifyInstance,
  options: StoryAuthoringOptions,
): Promise<void> {
  const { pool, mediaDir } = options;
  const limit = options.storyRateLimit ?? STORY_RATE_LIMIT;
  const counter = new FixedWindowCounter();

  // 上传的请求体就是图片本身。Registering the three image content types as raw
  // Buffers avoids a multipart dependency for a form that only ever sends one
  // file; the bytes are sniffed anyway, so the declared type decides nothing
  // beyond which parser runs.
  for (const contentType of ['image/jpeg', 'image/png', 'image/webp']) {
    app.addContentTypeParser(
      contentType,
      { parseAs: 'buffer', bodyLimit: MAX_IMAGE_BYTES },
      (_request, body, done) => {
        done(null, body);
      },
    );
  }

  /**
   * 401 for a browser with no identity, 403 for a claimed guest, and the user
   * otherwise. Returning null means a reply has already been sent.
   */
  function requireAccount(
    request: FastifyRequest,
    reply: FastifyReply,
  ): { id: string; usernameDisplay: string } | null {
    const user = request.currentUser;
    if (user === null) {
      void reply
        .code(401)
        .send({ error: 'identity_required', message: '请先认领用户名' });
      return null;
    }
    if (user.isGuest) {
      void reply.code(403).send({
        error: 'account_required',
        message: '提交故事设定需要注册账号',
      });
      return null;
    }
    return user;
  }

  /**
   * The caller's own proposal, or null (and a 404) when it is someone else's.
   *
   * 404 rather than 403 on purpose: another author's draft is not a thing you
   * are forbidden to touch, it is a thing you cannot see. A 403 would confirm
   * the id exists.
   */
  async function ownProposal(
    userId: string,
    proposalId: string,
    reply: FastifyReply,
  ): Promise<ProposalRow | null> {
    if (!UUID_RE.test(proposalId)) {
      void reply
        .code(404)
        .send({ error: 'proposal_not_found', message: '这份设定不存在' });
      return null;
    }
    const found = await pool.query<ProposalRow>(
      `SELECT ${PROPOSAL_COLUMNS} FROM story_proposals WHERE id = $1 AND user_id = $2`,
      [proposalId, userId],
    );
    const row = found.rows[0];
    if (row === undefined) {
      void reply
        .code(404)
        .send({ error: 'proposal_not_found', message: '这份设定不存在' });
      return null;
    }
    return row;
  }

  const rateLimited = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    if (counter.record(`ip:${request.ip}`) > limit) {
      void reply
        .code(429)
        .send({ error: 'rate_limited', message: '操作过于频繁，请稍后再试' });
    }
  };

  // --- POST /api/stories：开一份草稿 -----------------------------------------

  // Idempotent by design: the partial unique index allows one draft-or-pending
  // proposal per account, so a second call returns the one that is already
  // there rather than a 409 the composer would have to special-case.
  app.post(
    '/api/stories',
    { bodyLimit: STORY_BODY_LIMIT, onRequest: rateLimited },
    async (request, reply) => {
      const user = requireAccount(request, reply);
      if (user === null) return reply;

      const existing = await pool.query<ProposalRow>(
        `SELECT ${PROPOSAL_COLUMNS} FROM story_proposals
          WHERE user_id = $1 AND status IN ('draft','pending')`,
        [user.id],
      );
      if (existing.rows[0] !== undefined) {
        return reply.code(200).send(proposalView(existing.rows[0]));
      }

      const created = await pool.query<ProposalRow>(
        `INSERT INTO story_proposals (user_id) VALUES ($1)
         RETURNING ${PROPOSAL_COLUMNS}`,
        [user.id],
      );
      return reply.code(201).send(proposalView(created.rows[0]));
    },
  );

  // --- PUT /api/stories/:id：存标题与大纲 ------------------------------------

  app.put<{ Params: { id: string } }>(
    '/api/stories/:id',
    { bodyLimit: STORY_BODY_LIMIT, onRequest: rateLimited },
    async (request, reply) => {
      const user = requireAccount(request, reply);
      if (user === null) return reply;

      const proposal = await ownProposal(user.id, request.params.id, reply);
      if (proposal === null) return reply;
      if (proposal.status !== 'draft') {
        return reply.code(409).send({
          error: 'not_a_draft',
          message: '只有草稿可以修改',
        });
      }

      const body = request.body as { title?: unknown; synopsis?: unknown } | null;
      const title = typeof body?.title === 'string' ? body.title : proposal.title;
      const synopsis =
        typeof body?.synopsis === 'string' ? body.synopsis : proposal.synopsis;

      // 草稿期只校验上限：写到一半的稿子本来就不满 500（规范 §2）。
      if (glen(title) > STORY_TITLE_MAX_GRAPHEMES) {
        return reply.code(400).send({
          error: 'title_too_long',
          message: `标题最多 ${STORY_TITLE_MAX_GRAPHEMES} 个字符`,
          max: STORY_TITLE_MAX_GRAPHEMES,
        });
      }
      if (mixedCount(synopsis) > SYNOPSIS_MAX) {
        return reply.code(400).send({
          error: 'synopsis_too_long',
          message: `大纲最多 ${SYNOPSIS_MAX} 字`,
          max: SYNOPSIS_MAX,
        });
      }

      const saved = await pool.query<ProposalRow>(
        `UPDATE story_proposals
            SET title = $2, synopsis = $3, updated_at = now()
          WHERE id = $1
          RETURNING ${PROPOSAL_COLUMNS}`,
        [proposal.id, title, synopsis],
      );
      return proposalView(saved.rows[0]);
    },
  );

  // --- DELETE /api/stories/:id：丢掉草稿 -------------------------------------

  app.delete<{ Params: { id: string } }>(
    '/api/stories/:id',
    { onRequest: rateLimited },
    async (request, reply) => {
      const user = requireAccount(request, reply);
      if (user === null) return reply;

      const proposal = await ownProposal(user.id, request.params.id, reply);
      if (proposal === null) return reply;
      // A `pending` proposal has a review job pointing at it, and a published
      // one is not the author's to withdraw (§1.1「发布即锁定」).
      if (proposal.status !== 'draft') {
        return reply.code(409).send({
          error: 'not_a_draft',
          message: '只有草稿可以删除',
        });
      }

      // The rows go with the proposal (ON DELETE CASCADE), but the files do
      // not — nothing in PostgreSQL knows about the disk — so they are read
      // before the delete and removed after it.
      const images = await pool.query<{ file_url: string }>(
        'SELECT file_url FROM story_images WHERE proposal_id = $1',
        [proposal.id],
      );
      await pool.query('DELETE FROM story_proposals WHERE id = $1', [proposal.id]);
      for (const image of images.rows) {
        await deleteStoryImage(mediaDir, image.file_url);
      }
      return reply.code(204).send();
    },
  );

  // --- POST /api/stories/:id/images：传一张图 ---------------------------------

  const IMAGE_KINDS = ['character', 'world'] as const;

  app.post<{
    Params: { id: string };
    Querystring: { kind?: string; position?: string };
  }>(
    '/api/stories/:id/images',
    { bodyLimit: MAX_IMAGE_BYTES, onRequest: rateLimited },
    async (request, reply) => {
      const user = requireAccount(request, reply);
      if (user === null) return reply;

      const proposal = await ownProposal(user.id, request.params.id, reply);
      if (proposal === null) return reply;
      if (proposal.status !== 'draft') {
        return reply
          .code(409)
          .send({ error: 'not_a_draft', message: '只有草稿可以修改' });
      }

      const kind = request.query.kind;
      if (
        typeof kind !== 'string' ||
        !(IMAGE_KINDS as readonly string[]).includes(kind)
      ) {
        return reply.code(400).send({
          error: 'kind_invalid',
          message: '图片类型必须是 character 或 world',
        });
      }
      const position = Number(request.query.position);
      if (!Number.isInteger(position) || position < 0 || position > 5) {
        return reply.code(400).send({
          error: 'position_invalid',
          message: '图片位置必须是 0 到 5',
        });
      }

      const bytes = request.body;
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        return reply
          .code(400)
          .send({ error: 'image_required', message: '请选择一张图片' });
      }
      // §4.4: the bytes decide the format, not the declared Content-Type. An
      // SVG served from our own origin is stored XSS however it is labelled.
      const type = sniffImageType(bytes);
      if (type === null) {
        return reply.code(415).send({
          error: 'image_type_invalid',
          message: '只接受 JPEG、PNG 或 WebP 图片',
        });
      }

      // Replacing a slot: the row is upserted and the previous file removed.
      // The caption goes with the old image — a description written for a
      // picture that is no longer there is worse than an empty box.
      const previous = await pool.query<{ file_url: string }>(
        `SELECT file_url FROM story_images
          WHERE proposal_id = $1 AND kind = $2 AND position = $3`,
        [proposal.id, kind, position],
      );

      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO story_images
           (proposal_id, kind, position, caption, file_url, mime, bytes, sha256)
         VALUES ($1, $2, $3, '', '', $4, $5, $6)
         ON CONFLICT (proposal_id, kind, position) DO UPDATE SET
           caption = '',
           mime = EXCLUDED.mime,
           bytes = EXCLUDED.bytes,
           sha256 = EXCLUDED.sha256,
           updated_at = now()
         RETURNING id`,
        [proposal.id, kind, position, type.mime, bytes.length, sha256(bytes)],
      );
      const imageId = inserted.rows[0].id;

      // Written after the row exists so a file can never be orphaned by a
      // failed insert; the URL is then filled in, because it contains the id.
      const url = await writeStoryImage(
        mediaDir,
        proposal.id,
        imageId,
        type.ext,
        bytes,
      );
      await pool.query('UPDATE story_images SET file_url = $2 WHERE id = $1', [
        imageId,
        url,
      ]);
      // The id survives a replacement — ON CONFLICT updates the existing row
      // rather than inserting a new one — so the URL only changes when the
      // extension does. Same extension (JPEG replaced by JPEG): `url` equals
      // the previous file_url, writeStoryImage already overwrote that exact
      // path above, and deleting it here would remove the file just written,
      // leaving the row pointing at nothing. Different extension (JPEG
      // replaced by PNG): the old path is left behind at a different name and
      // has to be cleaned up. Comparing file_url to the new url is what makes
      // this guard correct in both directions.
      if (
        previous.rows[0] !== undefined &&
        previous.rows[0].file_url !== '' &&
        previous.rows[0].file_url !== url
      ) {
        await deleteStoryImage(mediaDir, previous.rows[0].file_url);
      }
      await pool.query(
        'UPDATE story_proposals SET updated_at = now() WHERE id = $1',
        [proposal.id],
      );

      return reply.code(201).send({
        id: imageId,
        kind,
        position,
        caption: '',
        url,
        mime: type.mime,
        bytes: bytes.length,
      });
    },
  );

  // --- PUT /api/stories/:id/images/:imageId：存这张图的说明 -------------------

  app.put<{ Params: { id: string; imageId: string } }>(
    '/api/stories/:id/images/:imageId',
    { bodyLimit: STORY_BODY_LIMIT, onRequest: rateLimited },
    async (request, reply) => {
      const user = requireAccount(request, reply);
      if (user === null) return reply;

      const proposal = await ownProposal(user.id, request.params.id, reply);
      if (proposal === null) return reply;
      if (!UUID_RE.test(request.params.imageId)) {
        return reply
          .code(404)
          .send({ error: 'image_not_found', message: '这张图不存在' });
      }
      if (proposal.status !== 'draft') {
        return reply
          .code(409)
          .send({ error: 'not_a_draft', message: '只有草稿可以修改' });
      }

      const caption = (request.body as { caption?: unknown } | null)?.caption;
      if (typeof caption !== 'string') {
        return reply
          .code(400)
          .send({ error: 'caption_invalid', message: '说明必须是字符串' });
      }
      if (mixedCount(caption) > CAPTION_MAX) {
        return reply.code(400).send({
          error: 'caption_too_long',
          message: `说明最多 ${CAPTION_MAX} 字`,
          max: CAPTION_MAX,
        });
      }

      const saved = await pool.query<{
        id: string;
        kind: string;
        position: number;
        caption: string;
        file_url: string;
      }>(
        `UPDATE story_images SET caption = $3, updated_at = now()
          WHERE id = $2 AND proposal_id = $1
          RETURNING id, kind, position, caption, file_url`,
        [proposal.id, request.params.imageId, caption],
      );
      const row = saved.rows[0];
      if (row === undefined) {
        return reply
          .code(404)
          .send({ error: 'image_not_found', message: '这张图不存在' });
      }
      return {
        id: row.id,
        kind: row.kind,
        position: row.position,
        caption: row.caption,
        url: row.file_url,
      };
    },
  );

  // --- DELETE /api/stories/:id/images/:imageId --------------------------------

  app.delete<{ Params: { id: string; imageId: string } }>(
    '/api/stories/:id/images/:imageId',
    { onRequest: rateLimited },
    async (request, reply) => {
      const user = requireAccount(request, reply);
      if (user === null) return reply;

      const proposal = await ownProposal(user.id, request.params.id, reply);
      if (proposal === null) return reply;
      if (!UUID_RE.test(request.params.imageId)) {
        return reply
          .code(404)
          .send({ error: 'image_not_found', message: '这张图不存在' });
      }
      if (proposal.status !== 'draft') {
        return reply
          .code(409)
          .send({ error: 'not_a_draft', message: '只有草稿可以修改' });
      }

      const removed = await pool.query<{ file_url: string }>(
        'DELETE FROM story_images WHERE id = $2 AND proposal_id = $1 RETURNING file_url',
        [proposal.id, request.params.imageId],
      );
      const row = removed.rows[0];
      if (row === undefined) {
        return reply
          .code(404)
          .send({ error: 'image_not_found', message: '这张图不存在' });
      }
      await deleteStoryImage(mediaDir, row.file_url);
      return reply.code(204).send();
    },
  );

  // --- POST /api/stories/:id/submit：提交送审 --------------------------------

  /** 每组图片的数量区间（规范 §1）。 */
  const IMAGES_MIN = 4;
  const IMAGES_MAX = 6;

  interface ImageRow {
    kind: 'character' | 'world';
    position: number;
    caption: string;
  }

  /**
   * Every unmet condition, all at once.
   *
   * Reporting one problem per attempt would make the author submit six times
   * to learn six things — and each attempt costs them a round trip through a
   * form holding twelve images.
   */
  function missingRequirements(
    proposal: ProposalRow,
    images: ImageRow[],
  ): string[] {
    const missing: string[] = [];
    if (proposal.title.trim() === '') missing.push('title_required');
    const synopsisUnits = mixedCount(proposal.synopsis);
    if (synopsisUnits < SYNOPSIS_MIN) missing.push('synopsis_too_short');
    if (synopsisUnits > SYNOPSIS_MAX) missing.push('synopsis_too_long');

    for (const kind of IMAGE_KINDS) {
      const group = images.filter((image) => image.kind === kind);
      if (group.length < IMAGES_MIN) missing.push(`${kind}_images_too_few`);
      if (group.length > IMAGES_MAX) missing.push(`${kind}_images_too_many`);
      for (const image of group) {
        // Counted from 1, the way the slot is labelled in the editor.
        const label = `${kind}:${image.position + 1}`;
        if (image.caption.trim() === '') {
          missing.push(`caption_required:${label}`);
        } else if (mixedCount(image.caption) > CAPTION_MAX) {
          missing.push(`caption_too_long:${label}`);
        }
      }
    }
    return missing;
  }

  app.post<{ Params: { id: string } }>(
    '/api/stories/:id/submit',
    { onRequest: rateLimited },
    async (request, reply) => {
      const user = requireAccount(request, reply);
      if (user === null) return reply;

      const proposal = await ownProposal(user.id, request.params.id, reply);
      if (proposal === null) return reply;
      if (proposal.status !== 'draft') {
        return reply.code(409).send({
          error: 'not_a_draft',
          message:
            proposal.status === 'pending' ? '这份设定正在审核中' : '只有草稿可以提交',
        });
      }

      const images = await pool.query<ImageRow>(
        `SELECT kind, position, caption FROM story_images
          WHERE proposal_id = $1 ORDER BY kind ASC, position ASC`,
        [proposal.id],
      );
      const missing = missingRequirements(proposal, images.rows);
      if (missing.length > 0) {
        return reply.code(400).send({
          error: 'incomplete',
          message: '这份设定还不完整',
          missing,
        });
      }

      // How many times this proposal has been sent for review. It is what makes
      // a resubmission after a rejection a genuinely new job instead of a
      // duplicate the ledger deduplicates away.
      const attempts = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM workflow_jobs
          WHERE job_type = 'story_review'
            AND payload_json->>'proposalId' = $1`,
        [proposal.id],
      );
      const attempt = Number(attempts.rows[0].n) + 1;

      const submitted = await withTransaction(pool, async (client) => {
        const updated = await client.query<ProposalRow>(
          `UPDATE story_proposals SET
             status = 'pending',
             reject_reason = NULL,
             submitted_at = now(),
             updated_at = now()
           WHERE id = $1 AND status = 'draft'
           RETURNING ${PROPOSAL_COLUMNS}`,
          [proposal.id],
        );
        if (updated.rows[0] === undefined) return null;

        // Same transaction as the status change, for the same reason §6.3
        // enqueues scoring with the submission: a proposal that reaches
        // `pending` without its review job would sit there for ever.
        await enqueue(client, {
          jobType: 'story_review',
          idempotencyKey: storyReviewJobKey(proposal.id, attempt),
          payload: { proposalId: proposal.id },
        });
        return updated.rows[0];
      });

      if (submitted === null) {
        return reply
          .code(409)
          .send({ error: 'not_a_draft', message: '只有草稿可以提交' });
      }
      return proposalView(submitted);
    },
  );

  // --- POST /api/stories/:id/reopen：退回草稿继续改 ---------------------------

  app.post<{ Params: { id: string } }>(
    '/api/stories/:id/reopen',
    { onRequest: rateLimited },
    async (request, reply) => {
      const user = requireAccount(request, reply);
      if (user === null) return reply;

      const proposal = await ownProposal(user.id, request.params.id, reply);
      if (proposal === null) return reply;

      // Only a verdict the author can act on can be reopened. A published
      // proposal stays published (§1.1「发布即锁定」— editing it would be a way
      // past review), and one still `pending` has a job pointing at it.
      if (proposal.status !== 'rejected' && proposal.status !== 'review_failed') {
        return reply.code(409).send({
          error: 'not_reopenable',
          message: '只有未通过或审核失败的设定可以退回草稿',
        });
      }

      // Every trace of the previous verdict goes, not just the reason the
      // author was shown. `review_output` and `review_model` describe a
      // judgement of text that is about to be rewritten, and a row that keeps
      // them is a row that can still be read as judged. This is the same
      // discipline jobs/scheduler.ts applies when a review dies: nothing on the
      // row may outlive the submission it was about.
      const reopened = await pool.query<ProposalRow>(
        `UPDATE story_proposals SET
           status = 'draft',
           reject_reason = NULL,
           review_output = NULL,
           review_model = NULL,
           submitted_at = NULL,
           reviewed_at = NULL,
           updated_at = now()
         WHERE id = $1
         RETURNING ${PROPOSAL_COLUMNS}`,
        [proposal.id],
      );
      return proposalView(reopened.rows[0]);
    },
  );

  // --- GET /api/me/story：我的草稿与历史 --------------------------------------

  // Not account-gated: a guest gets an empty answer rather than a 403, because
  // the page that calls this renders for everyone and an error there would be
  // about a permission the reader never asked to use.
  app.get('/api/me/story', async (request, reply) => {
    const user = request.currentUser;
    if (user === null) {
      return reply
        .code(401)
        .send({ error: 'identity_required', message: '请先认领用户名' });
    }

    const rows = await pool.query<ProposalRow>(
      `SELECT ${PROPOSAL_COLUMNS} FROM story_proposals
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [user.id],
    );
    const proposals = rows.rows.map(proposalView);
    const draft =
      rows.rows.find((row) => row.status === 'draft' || row.status === 'pending') ??
      null;

    // The draft's own pictures come back with it. `GET /api/stories/:id` only
    // serves published proposals, so this is the only way the editor can
    // repopulate its twelve slots after a reload — and an author who uploaded
    // twelve images, closed the tab and came back to empty boxes would
    // reasonably conclude the upload had never worked.
    const images =
      draft === null
        ? { rows: [] as ImageSlotRow[] }
        : await pool.query<ImageSlotRow>(
            `SELECT id, kind, position, caption, file_url FROM story_images
              WHERE proposal_id = $1 ORDER BY kind ASC, position`,
            [draft.id],
          );

    return {
      draft:
        draft === null
          ? null
          : {
              ...proposalView(draft),
              images: images.rows.map((row) => ({
                id: row.id,
                kind: row.kind,
                position: row.position,
                caption: row.caption,
                url: row.file_url,
              })),
            },
      proposals,
    };
  });
}

interface ImageSlotRow {
  id: string;
  kind: 'character' | 'world';
  position: number;
  caption: string;
  file_url: string;
}
