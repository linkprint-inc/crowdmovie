import { expect, test } from "vitest";

import indexHtml from "../index.html?raw";

test("entry HTML has no inline script or event handler under the production CSP", () => {
  expect(indexHtml).not.toMatch(/\son[a-z]+\s*=/i);
  expect(indexHtml).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
});
