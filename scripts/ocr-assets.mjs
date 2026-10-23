import {mkdir,copyFile,readdir} from 'node:fs/promises';
const target='public/ocr'; await mkdir(target,{recursive:true});
await copyFile('node_modules/tesseract.js/dist/worker.min.js',`${target}/worker.min.js`);
for(const f of await readdir('node_modules/tesseract.js-core')) if(f.endsWith('.wasm.js')||f.endsWith('.wasm'))await copyFile(`node_modules/tesseract.js-core/${f}`,`${target}/${f}`);
await copyFile('node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz',`${target}/eng.traineddata.gz`);
