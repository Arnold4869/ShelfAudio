/**
 * 视图历史栈（纯逻辑：无 DOM、无渲染 —— node 单测覆盖，scripts/test-view-stack.mjs）
 *
 * 为什么需要（老板 2026-09-14 报「首页进收藏，返回没回首页」）：
 * 之前每个页面的返回键都**硬编码目标**（收藏页写死 go('settings')），
 * 从书架进去也回设置页，从设置进去也回设置页 —— 入口不同、返回不同，写死必错。
 * 现在记录真实的访问顺序，返回 = 回上一页；入口随便变都对。
 *
 * 从 app.js 抽出（2026-10-12 审计修 §3.2 配套）：返回栈的参数语义
 * （keep/replace 合并、一次性参数剥离）是纯数据操作，放进独立模块才能被
 * node 单测直接驱动 —— 之前只能在 app.js 里跟着 DOM 一起跑，测不到。
 *
 * app.js 仍负责渲染（go/goBack），这里只管栈。
 */
const TAB_VIEWS = new Set(['kidhome', 'search', 'settings'])
let viewStack = []   // [{ name, params }]，栈顶 = 当前页

/** 当前视图名（调试/测试用） */
export function currentView() {
  return viewStack.length ? viewStack[viewStack.length - 1].name : ''
}

/** 历史栈快照（测试断言用，别在业务里依赖） */
export function viewHistory() {
  return viewStack.map(v => v.name)
}

/** 栈快照（go 用：路由放弃进入时回滚） */
export function snapshotViewStack() {
  return viewStack.slice()
}

/** 回滚到某次快照（go 用） */
export function restoreViewStack(snap) {
  viewStack = Array.isArray(snap) ? snap.slice() : []
}

/** 栈顶条目（没有则 null） */
export function topView() {
  return viewStack.length ? viewStack[viewStack.length - 1] : null
}

/**
 * 记录一次视图切换（go 的栈操作部分）。
 *
 * - 普通 push：压栈；同页换参数（统计页切日期）原位替换，不灌历史；
 *   页签（kidhome/search/settings）是「根」，切页签清空历史另起一条。
 * - replace：原地替换（返回时用），栈深度不变。
 *   - 2026-10-10 审计修：replace 一律整体覆盖 params 会把栈顶的深链参数洗掉
 *     （album 的 id、stats 的 day/cal）。改成**合并**：新参数覆盖同名键，旧键保留。
 *   - 2026-10-12 审计修（P1 §3.2）：goBack 用 replace 把上一页自己的参数当
 *     「渲染入参」传进来，合并的仍是「上一页的快照」—— stats.cal 丢失、
 *     album.id 变空被踢回首页。keep 语义：忽略传入 params，只更新 name，
 *     参数原样保留栈顶已存的（goBack 已单独剥过 songId，这里不再动 params）。
 */
export function rememberView(name, params, opts = {}) {
  if (opts.replace) {
    if (opts.keep) {
      if (viewStack.length) {
        viewStack[viewStack.length - 1] = {
          name,
          params: viewStack[viewStack.length - 1].params,
        }
      }
      else viewStack = [{ name, params }]
      return
    }
    if (viewStack.length) {
      viewStack[viewStack.length - 1] = {
        name,
        params: { ...viewStack[viewStack.length - 1].params, ...params },
      }
    }
    else viewStack = [{ name, params }]
    return
  }
  if (TAB_VIEWS.has(name)) {
    // 页签是「根」：切页签等于另起一条路径，清空历史
    viewStack = [{ name, params }]
    return
  }
  const top = viewStack[viewStack.length - 1]
  if (top && top.name === name) {
    // 同页换参数（如统计页切日期）不算新页面，否则历史会被灌满
    viewStack[viewStack.length - 1] = { name, params }
    return
  }
  viewStack.push({ name, params })
}

/**
 * 返回一步（goBack 的栈操作部分）：弹出当前页，返回新的栈顶。
 * 栈里只有一页（没有更早历史）时返回 null —— 调用方走 fallback。
 *
 * ⚠️ 返回时必须把一次性参数剥掉：album 页的 songId 是「点歌跳转时」的一次性
 * 起播指令（0.7.2 引入，老板「我自己选个单曲播放」）。不剥的话：从搜索/歌手页
 * 点歌 → 专辑页自动起播 → 进播放页 → 按返回 → 回专辑页 → 又自动起播 →
 * 立刻被踢回播放页 = **在播放页按返回永远出不去**（老板 2026-09-20 实测卡死）。
 * album 页起播过一次后这条指令已经消费掉了，返回必须是「安静地看专辑」。
 * （album.js 消费后立刻 delete 是第一道，这里是第二道。）
 */
export function popForBack() {
  if (viewStack.length <= 1) return null
  viewStack.pop()
  const prev = viewStack[viewStack.length - 1]
  if (prev.name === 'album' && prev.params?.songId) {
    const { songId, ...rest } = prev.params
    prev.params = rest
  }
  return prev
}

/** 测试用：清空栈 */
export function resetViewStack() {
  viewStack = []
}
