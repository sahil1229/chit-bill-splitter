import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
export default defineConfig({ plugins: [react()], base: './', resolve: { alias: { '@instinct/files': path.resolve('./src/shim-files.tsx') } }, build: { outDir: 'dist' } });
