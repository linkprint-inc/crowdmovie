// Explicit operator command. Writes local evidence only; never mutates canon.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCodexEngine } from '../ai/codex.js';
import { getEngineRunMetadata, type DirectSceneInput } from '../ai/engine.js';
import { FILM_CAPABILITIES } from '../ai/film-plan.js';

export function createFilmCanaryEngine() {
return createCodexEngine({
  CODEX_SCORE_MODEL: 'gpt-5.6-terra', CODEX_MODEL: 'gpt-5.6-sol',
  CODEX_WORKSTATION_DIR: resolve(process.env.CODEX_WORKSTATION_DIR ?? '../workstation'),
  CODEX_SCORE_REASONING_EFFORT: 'high', CODEX_FINAL_REASONING_EFFORT: 'xhigh', CODEX_DIRECTOR_REASONING_EFFORT: 'xhigh',
  CODEX_OUTPUT_RETRIES: 2, QWEN_COPYRIGHT_FALLBACK_BASE_URL: process.env.QWEN_COPYRIGHT_FALLBACK_BASE_URL ?? 'http://192.168.10.30:8000/v1',
  QWEN_COPYRIGHT_FALLBACK_MODEL: process.env.QWEN_COPYRIGHT_FALLBACK_MODEL ?? 'qwen3.8-27b-huihui-abliterated-nvfp4',
}, {
  codex: { startThread: () => { throw new Error('Canary must use Qwen'); }, resumeThread: () => { throw new Error('Canary must use Qwen'); } },
  directorThreads: { load: async () => null, save: async () => { throw new Error('Canary must not save a thread'); } },
});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const directory = resolve(process.argv[2] ?? 'output/film-quality-canary');
await mkdir(directory, { recursive: true });
const engine = createFilmCanaryEngine();
const input: DirectSceneInput = process.argv[3] ? JSON.parse(await readFile(process.argv[3], 'utf8')) as DirectSceneInput : {
  roundId: randomUUID(), episodeIndex: 1, episodeTitle: 'Wet stone rooftop',
  episodeTheme: 'Batman and Spider-Man fight inside the rail of a wet stone rooftop at night. Keep the steel vent on the left, the brick stairwell behind them and the distant blue skyline. One physical exchange changes their footing.',
  selectedSubmission: { id: randomUUID(), authorUsername: 'internal_canary', content: 'Spider-Man drives his right foot toward Batman’s chest. Batman blocks with his left forearm; his right boot slides back on the wet stone. Spider-Man recoils from the block and plants both feet inside the railing.' },
  selectionMode: 'ai', recentScenes: [], previousScene: null,
  h3Capabilities: { version: FILM_CAPABILITIES },
};
await writeFile(resolve(directory, 'input.json'), JSON.stringify(input, null, 2));
let output;
try { output = await engine.directScene(input); } catch (error) {
  await writeFile(resolve(directory, 'failure.json'), JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
await writeFile(resolve(directory, 'director.json'), JSON.stringify(output, null, 2));
await writeFile(resolve(directory, 'prompt.txt'), output.h3PromptEn);
await writeFile(resolve(directory, 'metadata.json'), JSON.stringify(getEngineRunMetadata(output), null, 2));
console.log(JSON.stringify({ directory, roundId: input.roundId, duration: output.durationSeconds, metadata: getEngineRunMetadata(output) }));
}
