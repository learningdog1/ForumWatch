/**
 * 设置页组头（settings.md §2；TASTE-UPGRADE §B-5 拆两级）：
 * 第一行组名 .group-head（15px/600 前景字色），desc 存在时第二行释义
 * .group-sub（fs-12/text-3）——「组头 15 > 卡题 14 > 标签 13 > hint 12」
 * 四级节奏的第一级（修 audit #15「17 卡节奏全平」）。带圈序号 ①-⑥ 只保留
 * 在子导航 label，组头不带编号。
 * 外层包一层 div 让两行成组：.settings-group 是带 gap 的纵向 flex，h2/p 直接
 * 平铺会被 gap 拆成两个独立 flex 项（行距 18px），成组的 4px 紧距就没了。
 * id/锚点由外层 .settings-group 槽承载，本组件只负责呈现。
 */
export function GroupHeader(props: { name: string; desc?: string }) {
  return (
    <div>
      <h2 className="group-head">{props.name}</h2>
      {props.desc != null && <p className="group-sub">{props.desc}</p>}
    </div>
  )
}
