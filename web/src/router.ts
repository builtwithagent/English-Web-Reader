/**
 * 极简路由 —— **只读形态**。
 *
 * 全站只有两个页面（阅读器 `/`、访问统计 `/stats`）。为这个装一个
 * react-router-dom 换来的是一个运行时依赖、一次大版本升级、一套
 * 与项目其余部分无关的概念（loader / outlet / data router…），
 * 而它要解决的问题在这里只有二十行。
 *
 * 哪天页面涨到五六个、或者需要嵌套布局与参数，再换库；
 * 现在这个规模的正确做法是**不引**。
 *
 * 它只做一件事：**读出当前地址**。跳转一律走浏览器原生的链接（`<a href>`），
 * 整页刷新在这里是可以接受的成本（两个页面、没有要保活的中间状态）。
 * 之前的 `navigate()` 只为统计页那个「返回阅读器」按钮存在，按钮删了它也就没了 ——
 * 真需要站内无刷新跳转时再加 `history.pushState` + 通知订阅者，
 * 但别为了一个按钮先把那套机制留在代码里。
 *
 * 两个实现细节值得说明：
 *
 * 1. 用 `useSyncExternalStore` 订阅 `popstate`，而不是直接读
 *    `window.location.pathname`。后者在浏览器前进 / 后退时 React 不会重渲染 ——
 *    地址变了、页面没变，而且这种 bug 只在你按后退键时才出现。
 *
 * 2. `getSnapshot` 返回的是**字符串**。`useSyncExternalStore` 用 `Object.is`
 *    比较快照，字符串比的是值，所以每次新建一个字符串也没关系
 *    （换成对象就会变成无限重渲染，这是这个 API 最常见的坑）。
 */

import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  return () => window.removeEventListener('popstate', onChange);
}

function getSnapshot(): string {
  return normalizePath(window.location.pathname);
}

/** 当前路径。永远以 `/` 开头，且没有结尾斜杠 */
export function usePathname(): string {
  // 第三个参数是服务端渲染的兜底值。这个应用只在浏览器里跑，但 API 要求它存在
  return useSyncExternalStore(subscribe, getSnapshot, () => '/');
}

/**
 * 归一化路径：`/stats/`、`/stats`、`//stats` 视作同一个页面。
 *
 * 不做这件事的话，用户手打一个结尾斜杠就会掉进"没有匹配的路由"分支 ——
 * 这种失败很难自查，因为界面上看起来就是"白屏了"。
 */
export function normalizePath(pathname: string): string {
  const collapsed = pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return collapsed === '' ? '/' : collapsed;
}
