// Builds dist/extension.js for Roam Depot (developer mode: load the dist folder).
import * as esbuild from 'esbuild';
import fs from 'node:fs';

await esbuild.build({
  entryPoints: ['src/index.js'], bundle: true, minify: false, target: 'es2022', legalComments: 'none',
  format: 'esm', outfile: 'dist/extension.js', logLevel: 'warning',
});
for (const f of ['README.md', 'CHANGELOG.md']) fs.copyFileSync(f, `dist/${f}`);
console.log('built dist/extension.js', fs.statSync('dist/extension.js').size, 'bytes');
