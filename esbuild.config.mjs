import * as esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');

/** @type {esbuild.BuildOptions} */
const buildOptions = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    external: ['vscode', '@huggingface/transformers'],  // vscode + transformers.js (ESM-only) must not be bundled
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: false,
    minify: false,
    // Handle __dirname/__filename for ONNX runtime etc.
    define: {
        'process.env.NODE_ENV': '"production"',
    },
};

if (isWatch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('[esbuild] Watching for changes...');
} else {
    await esbuild.build(buildOptions);
    console.log('[esbuild] Build complete → dist/extension.js');
}
