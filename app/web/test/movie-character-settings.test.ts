import { enableAutoUnmount, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { nextTick } from 'vue';
import MovieCharacterCard from '../src/components/MovieCharacterCard.vue';
import { CHARACTERS } from '../src/data/characters';
import { setLocale } from '../src/i18n';
import type { MovieCharacter } from '../src/lib/api';

enableAutoUnmount(afterEach);
beforeEach(() => setLocale('zh-CN'));
const character = (key: string, position = 1): MovieCharacter => ({
  key, position, copyI18n: { 'zh-CN': { name: key, role: '学生' }, en: { name: key, role: 'Student' } },
  visualIdentity: {}, referenceAssets: [],
});

it.each(CHARACTERS)('shows the approved settings for $key even when display positions change', (official) => {
  const wrapper = mount(MovieCharacterCard, { props: { character: character(official.key, 99), movieSlug: 'inland-empire-high' } });
  const text = official.copy['zh-CN'];
  for (const field of ['grade', 'archetype', 'personality', 'props', 'fn', 'voice'] as const) {
    expect(text[field]).toBeTruthy();
    expect(wrapper.text()).toContain(text[field]);
  }
  expect(wrapper.get('img').attributes('src')).toBe(official.image);
  expect(wrapper.findAll('[data-setting]')).toHaveLength(4);
  expect(wrapper.text()).not.toContain('按当前影片 Bible 固定');
});

it('changes all character details with the interface language', async () => {
  const wrapper = mount(MovieCharacterCard, { props: { character: character('koishi'), movieSlug: 'inland-empire-high' } });
  setLocale('en');
  await nextTick();
  expect(wrapper.text()).toContain(CHARACTERS[0].copy.en.personality);
  expect(wrapper.text()).toContain(CHARACTERS[0].copy.en.voice);
  expect(wrapper.text()).not.toContain(CHARACTERS[0].copy['zh-CN'].personality);
});

it('never assigns another movie these settings just because its character key or position matches', () => {
  const wrapper = mount(MovieCharacterCard, { props: { character: character('koishi'), movieSlug: 'another-movie' } });
  expect(wrapper.find('img').exists()).toBe(false);
  expect(wrapper.find('[data-setting]').exists()).toBe(false);
  expect(wrapper.text()).toContain('详细设定尚未公开');
});

it('prefers populated public settings, and keeps slim cards compact', async () => {
  const entry = character('koishi');
  entry.copyI18n['zh-CN'].personality = '公开的角色性格';
  const wrapper = mount(MovieCharacterCard, { props: { character: entry, movieSlug: 'inland-empire-high' } });
  expect(wrapper.get('[data-setting="personality"]').text()).toContain('公开的角色性格');
  expect(wrapper.text()).toContain(CHARACTERS[0].copy['zh-CN'].props);
  await wrapper.setProps({ slim: true });
  expect(wrapper.find('[data-setting]').exists()).toBe(false);
});
