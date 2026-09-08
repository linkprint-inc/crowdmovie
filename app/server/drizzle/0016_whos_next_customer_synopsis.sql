-- Keep the public story-setting copy focused on what an audience member can
-- create and influence. The internal Bible and H3 visual policy remain
-- unchanged and continue to govern generation outside this customer-facing
-- synopsis.

UPDATE "movies"
SET "synopsis_i18n" = jsonb_set(
      "synopsis_i18n",
      '{zh-CN}',
      to_jsonb('轮到你来当导演：选择电影、游戏、动画、漫画、历史与艺术中的经典人物，也可以创造自己的角色；决定谁登场、在哪里相遇、如何交锋、使出什么招式。写下下一个镜头，为喜欢的剧情投票，让你的创意有机会成为接下来播放的电影片段。'::text),
      true
    ),
    "updated_at" = now()
WHERE "id" = '10000000-0000-4000-8000-000000000002';
--> statement-breakpoint
