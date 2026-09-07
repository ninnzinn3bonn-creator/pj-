import { copyFile } from 'node:fs/promises';
for (const file of ['architecture-viewer.js', 'architecture-viewer.css']) {
  await copyFile(new URL(`../../public/${file}`, import.meta.url), new URL(`../public/${file}`, import.meta.url));
}
