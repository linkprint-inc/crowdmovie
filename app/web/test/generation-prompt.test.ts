import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import GenerationPromptPanel from '../src/components/GenerationPromptPanel.vue';
import { api, type GenerationPrompt } from '../src/lib/api';
import { viewingMovieSlug } from '../src/stores/movies';
import { setLocale } from '../src/i18n';

enableAutoUnmount(afterEach);
beforeEach(() => { setLocale('zh-CN'); viewingMovieSlug.value = 'whos-next'; vi.useFakeTimers(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const generation: GenerationPrompt = {
  mode: 'current', roundIndex: 37, status: 'generating', durationSeconds: 10.125,
  prompt: 'Shot 1\n0–5s: move.\n<d>Hello</d>\n<script>bad()</script>',
};

it('renders the complete plain text and switches to latest generation during polling', async () => {
  const fetch = vi.spyOn(api, 'generationPrompt').mockResolvedValue({ generation });
  const wrapper = mount(GenerationPromptPanel);
  await flushPromises();
  expect(wrapper.text()).toContain('正在生成');
  expect(wrapper.get('[data-test="h3-prompt"]').text()).toBe(generation.prompt);
  expect(wrapper.find('script').exists()).toBe(false);
  expect(wrapper.find('d').exists()).toBe(false);
  fetch.mockResolvedValue({ generation: { ...generation, mode: 'latest', status: 'published' } });
  await vi.advanceTimersByTimeAsync(5000);
  expect(wrapper.text()).toContain('最后一次生成');
  expect(wrapper.text()).toContain('已发布');
});

it('clears the old movie and ignores late responses after switching', async () => {
  let resolveOld!: (value: { generation: GenerationPrompt }) => void;
  vi.spyOn(api, 'generationPrompt')
    .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
    .mockResolvedValueOnce({ generation: null });
  const wrapper = mount(GenerationPromptPanel);
  viewingMovieSlug.value = 'inland-empire-high';
  await flushPromises();
  resolveOld({ generation });
  await flushPromises();
  expect(wrapper.find('[data-test="h3-prompt"]').exists()).toBe(false);
  expect(wrapper.text()).toContain('暂无已提交给 H3 的提示词');
});

it('failed refresh does not keep claiming that an old task is generating', async () => {
  const fetch = vi.spyOn(api, 'generationPrompt').mockResolvedValue({ generation });
  const wrapper = mount(GenerationPromptPanel);
  await flushPromises();
  fetch.mockRejectedValue(new Error('offline'));
  await vi.advanceTimersByTimeAsync(5000);
  expect(wrapper.text()).toContain('暂时无法读取提示词');
  expect(wrapper.text()).not.toContain('正在生成');
  wrapper.unmount();
  const count = fetch.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10000);
  expect(fetch).toHaveBeenCalledTimes(count);
});
