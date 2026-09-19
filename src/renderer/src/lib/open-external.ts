/**
 * openExternal 的点击侧包装（评审修复：拒绝不能完全静默）。
 * 主进程拒绝（非 https / host 不在"来源派生域 ∪ github.com"白名单）或打开
 * 失败都返回 {ok:false}——此前 UI 对此完全无感，点了没反应像"坏了"。
 * 这里不弹层、不打断交互：console.warn 一条（排障可观测）+ 把被点元素的
 * title 临时换成提示文案，1.5s 后还原（元素若已因列表重渲染而卸载，改动
 * 落在游离节点上，无害）。
 */
export function openExternalWithTitleHint(el: HTMLElement, url: string): void {
  const originalTitle = el.title
  void window.api
    .openExternal(url)
    .then((r) => {
      if (r !== undefined && r.ok) return
      let host = ''
      try {
        host = new URL(url).hostname
      } catch {
        /* 非 URL 形态（空串等）：提示不带 host */
      }
      console.warn(`[openExternal] 外链未放行（非 https 或域不在白名单）：${url}`)
      el.title = host !== '' ? `未放行的外链域：${host}` : '外链未放行（非 https 或域不在白名单）'
      window.setTimeout(() => {
        el.title = originalTitle
      }, 1500)
    })
    .catch(() => {
      /* IPC 契约本不 reject；真异常时同样静默（不打断点击流） */
    })
}
