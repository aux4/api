const { nodeResolve } = require('@rollup/plugin-node-resolve');
const commonjs = require('@rollup/plugin-commonjs');
const json = require('@rollup/plugin-json');

module.exports = {
  input: 'index.js',
  output: {
    file: 'package/lib/server.js',
    format: 'cjs',
    inlineDynamicImports: true
  },
  plugins: [
    json(),
    nodeResolve({
      preferBuiltins: true
    }),
    commonjs()
  ]
};
