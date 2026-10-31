/**
 * autocache-item.js：把 app.js 的 getItem 隔成动态依赖。
 * autocache.js 已经动态 import 了 app.js（拿 state），再静态引 hub 会形成
 * app.js → autocache.js → app.js 的静态循环；把「按 id 取详情」放进这个小模块，
 * 在函数体内动态 import servers.js，运行时才解析 —— 循环消失。
 * app.js 的 hub / servers.js 的 hub 是同一个实例（app.js 只 re-export），无歧义。
 */
export async function getItem(id) {
  const { hub } = await import('./servers.js')
  return hub.getItem(id)
}
