// import typescript from '@rollup/plugin-typescript';
	import typescript from 'rollup-plugin-typescript2'; // Swap the import
import {nodeResolve} from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import url from '@rollup/plugin-url';

export default {
  input: 'main.ts',
  output: {
    dir: '.',
    sourcemap: 'inline',
    format: 'cjs',
    exports: 'default'
  },
  external: ['obsidian'],
  plugins: [
    typescript(),
    nodeResolve({browser: true, extensions: ['.mjs', '.js', '.json', '.node', '.wasm']}),
    commonjs(),
    json(),
    url({ include: ['**/*.wasm'], limit: Infinity }),
  ]
};