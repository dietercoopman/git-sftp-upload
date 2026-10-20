// Bundles the extension into a single out/extension.js for the Marketplace package.
// ssh2's optional native modules are left external: they are not shipped, and ssh2 falls back to pure JS.
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  outfile: 'out/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode', 'cpu-features', './crypto/build/Release/sshcrypto.node'],
  // Prefer ES module builds: jsonc-parser's UMD build uses a dynamic require that cannot be bundled.
  mainFields: ['module', 'main'],
  sourcemap: watch,
  minify: false,
  logLevel: 'info',
});
if (watch) await ctx.watch();
else {
  await ctx.rebuild();
  await ctx.dispose();
}
