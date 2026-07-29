// Node ESM loader: 把 src/ 内的 .js 导入解析到同名 .ts，让源码（.js 导入）在 Node 测试里直接跑。
// 只处理项目内相对路径的 .js -> .ts 重写，绝不碰 node_modules。

import { fileURLToPath } from 'node:url';

export function resolve(specifier, context, nextResolve) {
  if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    specifier.endsWith('.js') &&
    context.parentURL &&
    !context.parentURL.includes('node_modules')
  ) {
    const tsSpecifier = specifier.slice(0, -3) + '.ts';
    try {
      return nextResolve(tsSpecifier, context);
    } catch {
      // .ts 不存在就回退到 .js（正常解析）
    }
  }
  return nextResolve(specifier, context);
}
