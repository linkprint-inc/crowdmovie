/*
 * 规范 §6 的客户端。The upload call is the one worth a test of its own: it
 * sends the file as a raw body with the browser's own Content-Type, and a
 * client that JSON-encoded it would fail only at runtime, against a server
 * that answers 415 for a reason nobody would guess from the code.
 */
import { beforeEach, expect, test, vi } from "vitest";

import { api } from "../src/lib/api";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

test("列表带上排序与分页", async () => {
  await api.stories({ sort: "new", limit: 10, offset: 20 });

  const url = fetchMock.mock.calls[0][0] as string;
  expect(url).toContain("sort=new");
  expect(url).toContain("limit=10");
  expect(url).toContain("offset=20");
});

test("详情按 id 取", async () => {
  await api.story("abc-123");

  expect(fetchMock.mock.calls[0][0]).toBe("/api/stories/abc-123");
});

test("上传把文件当原始请求体发出去，不做 JSON 编码", async () => {
  const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], "a.jpg", {
    type: "image/jpeg",
  });

  await api.uploadStoryImage("story-1", "character", 2, file);

  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toContain("kind=character");
  expect(url).toContain("position=2");
  expect(init.method).toBe("POST");
  expect(init.body).toBe(file);
  // 文件自己的类型决定 Content-Type；客户端不能把它盖成 application/json。
  expect((init.headers as Record<string, string>)["Content-Type"]).toBe("image/jpeg");
});

test("点赞发的是 1 或 0", async () => {
  await api.likeStory("story-1", 1);

  const init = fetchMock.mock.calls[0][1] as RequestInit;
  expect(JSON.parse(init.body as string)).toEqual({ value: 1 });
});

test("提交不带请求体", async () => {
  await api.submitStory("story-1");

  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("/api/stories/story-1/submit");
  expect(init.body).toBeUndefined();
});

test("incomplete 的 missing 数组能从错误里读出来", async () => {
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        error: "incomplete",
        message: "这份设定还不完整",
        missing: ["title_required", "synopsis_too_short"],
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    ),
  );

  await expect(api.submitStory("story-1")).rejects.toMatchObject({
    code: "incomplete",
    detail: { missing: ["title_required", "synopsis_too_short"] },
  });
});
