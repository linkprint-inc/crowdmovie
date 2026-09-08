// node dist/ops/episode-edit.js source-manifest.json MEDIA_DIR destination-dir
import { readFile } from 'node:fs/promises';
import { renderEpisodeEdit, type EpisodeEdit } from '../media/episode-edit.js';

const [manifest, mediaDir, destination] = process.argv.slice(2);
if (!manifest || !mediaDir || !destination) throw new Error('Usage: episode-edit manifest.json MEDIA_DIR destination-dir');
const edit = JSON.parse(await readFile(manifest, 'utf8')) as EpisodeEdit;
const result = await renderEpisodeEdit(edit, mediaDir, destination);
console.log(JSON.stringify({ directory: result.directory, durationSeconds: result.manifest.timeline.durationSeconds, sha256: result.manifest.sha256, audio: result.manifest.audio }));
