'use strict';
// Собирает images.js из файлов папки images/. Запуск из корня проекта: node tools/build-images.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'images');
const OK = /\.(avif|webp|png|jpe?g|gif|svg)$/i;

const files = fs.existsSync(DIR)
  ? fs.readdirSync(DIR).filter((f) => OK.test(f) && !f.startsWith('.')).sort((a, b) => a.localeCompare(b))
  : [];
fs.writeFileSync(path.join(ROOT, 'images.js'), `window.PRIVAL_IMAGES = ${JSON.stringify(files, null, 2)};\n`);
console.log(`images.js: ${files.length} файл(ов)`);
