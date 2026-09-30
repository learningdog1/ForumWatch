/**
 * 命中详情抽屉（Watchtower 步骤 I；概念稿 §3.10 抽屉形制 + JS openDrawer 的
 * 数据用法——标题/来源/规则/价格/置信度逐字段对位，见 concept.html :723-744）。
 *
 * 宿主组件：App 根部与 ToastHost 同位挂载一次（挂载点由后续步骤接线，本组件
 * 自持全生命周期）；开关流消费 lib/hit-drawer 订阅，业务侧只管 openDrawer()。
 * 样式全部在 styles/overlays.css（.bk/.drawer/.d-*），徽标/按钮走 primitives。
 *
 * 结构与数据契约（不造假：字段缺失如实显示 '—' 或整段省略）：
 * - d-meta：来源（src mono 小字）+ 时间 + 命中方式徽标（.badge b-kw/b-price/b-ai，
 *   matchedByBadge 与 HitRow 变体同源）+ 归因短句（matchedRule / 命中词）。
 * - d-title：衬线大题（overlays.css 扩展位）。复用 .hit-title 的按钮 reset 与
 *   点状下划线可点语言——点击走 openExternalWithTitleHint 白名单机制开原帖
 *   （与 HitRow list 变体同一条受控跳转路径）。
 * - d-price：extractDeal(title) 现算价格（周期/金额；无价格 '—'；USD 原币种
 *   如实显示不折算）+ 语义置信度（semanticScore 缺失 '—'）。
 * - 命中原因 · 逐条可解释：
 *   · 事实层——从 HitRecord 派生（命中方式→关键词/规则名/semanticReason；
 *     推送三态；extractDeal 复算的价格摘要），逐条 check 图标行；失败行用
 *     ✗ 图标（无 .ic 绿描边）如实区分；不为旧记录伪造去重/排除词结论。
 *   · 解释层——「按当前配置复判」按钮真跑 matchTest 判定管线（useAi=true，
 *     消耗一次 LLM 调用），渲染 MatchStageResult[] 各阶段；恒标注
 *     「按当前配置复判，可能与命中当时不同」；pending / 失败态齐全。
 * - AI 锐评：commentary 存在才渲染整段（.quote 衬线块），缺失整段省略。
 * - 反馈：fb-row 👍有用 / 👎无关——复用 HitRow VoteButtons 的 hitFeedback IPC
 *   调用形态与三态语义（未投记票 / 同向再投 undo / 异向改票；乐观更新、失败
 *   回滚 + 行内 err 1.5s 复原）；成功 showToast。
 *
 * 键盘与焦点：
 * - Esc 关闭：window **捕获阶段** keydown——先于 History / Dispositions /
 *   Settings 的页级 Esc（均为 bubble 监听）与 React 根的合成 onKeyDown，
 *   开着抽屉时 stopPropagation 短路，「只关抽屉」。
 * - backdrop 点击关闭；关闭时焦点还原到触发元素（store 侧尽力而为）。
 * - 打开时焦点移入抽屉面板（tabIndex=-1）；关闭态 inert（离屏不进 Tab 序）。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { HitRecord } from '@shared/types'
import type { MatchStageResult, MatchTestResult } from '@shared/ipc'
import { closeDrawer, drawerHit, subscribeDrawer } from '../lib/hit-drawer'
import { showToast } from '../lib/toast'
import { openExternalWithTitleHint } from '../lib/open-external'
import { formatClock } from '../lib/time'
import { sourceLabel } from '../lib/status'
import {
  dealPriceText,
  dealSummaryText,
  formatHitTimestamp,
  hitRowKey,
  matchAttribution,
  matchedByBadge
} from './HitRow'
import {
  IconBolt,
  IconCheck,
  IconDot,
  IconMinus,
  IconThumbDown,
  IconThumbUp,
  IconX
} from './icons'

/** 投票失败行内反馈的复原延时（对齐 HitRow VoteButtons） */
const VOTE_ERR_MS = 1500

/** 事实层 check 图标（overlays.css .d-sec li .ic 绿描边） */
const MARK_CHECK: ReactNode = <IconCheck size={13} className="ic" />
/** 事实层 ✗（无 .ic：保持 li 的 muted 底色，不伪装成「通过」） */
const MARK_X: ReactNode = <IconX size={13} />

/**
 * 复判阶段 → 行首符号与口径词（词义对齐 MatchTestCard 图例：通过=放行/命中；
 * 否决=一票否决；未评估=短路或未提供；无命中=评估但无命中）。仅 pass 用
 * .ic 绿档，其余保持 muted——阶段结论色不靠 CSS 伪装。
 */
const STAGE_OUTCOME: Record<MatchStageResult['outcome'], { word: string; mark: ReactNode }> = {
  pass: { word: '通过', mark: <IconCheck size={13} className="ic" /> },
  block: { word: '否决', mark: <IconX size={13} /> },
  skip: { word: '未评估', mark: <IconMinus size={13} /> },
  info: { word: '无命中', mark: <IconDot size={8} /> }
}

/**
 * 解释层：按当前配置复判。matchTest 只读诊断（不写 seen、不推送、不产生
 * HitRecord）；useAi=true 真调一次语义评估（消耗一次 LLM 调用）。请求带上
 * 该帖的来源/分类/作者元数据——per-source 过滤按真实输入参与判定。
 */
function ReJudgeBlock(props: { hit: HitRecord }) {
  const { hit } = props
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<MatchTestResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function run(): Promise<void> {
    if (running) return
    setRunning(true)
    setError(null)
    try {
      const r = await window.api.matchTest({
        title: hit.topic.title,
        sourceId: hit.topic.sourceId,
        useAi: true,
        ...(hit.topic.category !== '' ? { category: hit.topic.category } : {}),
        ...(hit.topic.author !== '' ? { author: hit.topic.author } : {})
      })
      setResult(r)
    } catch (err: unknown) {
      // IPC 契约面不 reject（桌面收敛 / web-shim 兜底）；此处防御传输层异常
      setError(
        `复判失败：${err instanceof Error ? err.message : '与主进程通信异常'}，请重试`
      )
    } finally {
      setRunning(false)
    }
  }

  return (
    <div>
      <div className="fb-row">
        <button
          type="button"
          className={`btn btn-sm${running ? ' busy' : ''}`}
          disabled={running}
          title="按已保存配置跑一遍判定管线（含一次 AI 语义评估调用，若已配置）"
          onClick={() => void run()}
        >
          {!running && <IconBolt size={12} />}
          {running ? '复判中…' : '按当前配置复判'}
        </button>
        <span className="fh">按当前配置复判，可能与命中当时不同</span>
      </div>
      {running && result == null && (
        <div className="feedback pending" role="status">
          正在按当前配置跑判定管线…
        </div>
      )}
      {error != null && <div className="feedback err">{error}</div>}
      {result != null && (
        <div>
          <div className={`feedback ${result.wouldPush ? 'ok' : 'err'}`}>
            复判结论：{result.wouldPush ? '会推送（若为新帖且推送开关开启）' : '不会推送'} ·
            按当前配置复判，可能与命中当时不同
          </div>
          <ul>
            {result.stages.map((s) => {
              const view = STAGE_OUTCOME[s.outcome]
              return (
                <li key={s.stage} title={s.outcome}>
                  {view.mark}
                  <span>
                    {s.label} · {view.word} —— {s.detail}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

/**
 * 抽屉内反馈（复用 HitRow VoteButtons 的 IPC 调用形态与三态语义：未投=记票；
 * 已投同向再点=undo 撤销；已投异向=改票）。三态 UI：进行中（busy+禁用）/
 * 成功 voted（.voted 描边）/ 失败（回滚 + 行内 err 1.5s 复原）。
 */
function DrawerFeedback(props: { hit: HitRecord }) {
  const { hit } = props
  const [voted, setVoted] = useState<'positive' | 'negative' | null>(null)
  /** 进行中方向（null = 空闲）；期间两钮禁用 */
  const [pending, setPending] = useState<'positive' | 'negative' | null>(null)
  /** 提交失败的行内反馈（乐观高亮已回滚，失败必须可见） */
  const [voteErr, setVoteErr] = useState(false)
  const errTimerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (errTimerRef.current != null) window.clearTimeout(errTimerRef.current)
    }
  }, [])

  /** 亮出失败文案 1.5s 后复原；连续失败重置计时（对齐 VoteButtons） */
  function flashVoteErr(): void {
    if (errTimerRef.current != null) window.clearTimeout(errTimerRef.current)
    setVoteErr(true)
    errTimerRef.current = window.setTimeout(() => {
      errTimerRef.current = null
      setVoteErr(false)
    }, VOTE_ERR_MS)
  }

  function vote(direction: 'positive' | 'negative'): void {
    if (pending != null) return
    const action = voted === direction ? 'undo' : direction
    const prev = voted
    setVoted(action === 'undo' ? null : direction)
    setPending(direction)
    void window.api
      .hitFeedback({
        sourceId: hit.topic.sourceId,
        topicId: hit.topic.id,
        title: hit.topic.title,
        direction: action
      })
      .then((r) => {
        if (r.ok) {
          showToast(
            action === 'undo'
              ? '已撤销反馈'
              : `已记录「${action === 'positive' ? '有用' : '无关'}」· 将用于调优语义匹配`
          )
        } else {
          setVoted(prev)
          flashVoteErr()
          console.warn('[HitDetailDrawer] 反馈提交失败：', r.error)
        }
      })
      .catch((err: unknown) => {
        setVoted(prev)
        flashVoteErr()
        console.warn('[HitDetailDrawer] 反馈请求异常：', err)
      })
      .finally(() => {
        setPending(null)
      })
  }

  const upTitle =
    voted === 'positive'
      ? '已标记为有用：再点一次撤销反馈'
      : voted === 'negative'
        ? '改为有用（撤销「无关」标记）'
        : '标记为有用：同类新帖更可能被判相关（AI 反馈）'
  const downTitle =
    voted === 'negative'
      ? '已标记为无关：再点一次撤销反馈'
      : voted === 'positive'
        ? '改为无关（撤销「有用」标记）'
        : '标记为无关：同类新帖更可能被判不相关（AI 反馈）'

  return (
    <div className="fb-row">
      <button
        type="button"
        className={`btn btn-sm${voted === 'positive' ? ' voted' : ''}${pending === 'positive' ? ' busy' : ''}`}
        disabled={pending != null}
        title={upTitle}
        aria-label={upTitle}
        onClick={() => vote('positive')}
      >
        <IconThumbUp size={14} />
        有用
      </button>
      <button
        type="button"
        className={`btn btn-sm${voted === 'negative' ? ' voted' : ''}${pending === 'negative' ? ' busy' : ''}`}
        disabled={pending != null}
        title={downTitle}
        aria-label={downTitle}
        onClick={() => vote('negative')}
      >
        <IconThumbDown size={14} />
        无关
      </button>
      <span className="fh">反馈将进入语义匹配的调优样本</span>
      {voteErr && <span className="feedback err">反馈提交失败，已还原</span>}
    </div>
  )
}

/** 单条命中的抽屉正文（key=hitRowKey 由宿主控制：换目标即重置复判/反馈态） */
function DrawerContent(props: { hit: HitRecord }) {
  const { hit } = props
  const badge = matchedByBadge(hit)
  const attribution = matchAttribution(hit)
  const timeIso = hit.notifiedAt ?? hit.topic.lastActiveAt
  const commentary = hit.commentary ?? null
  const dealSummary = dealSummaryText(hit.topic.title)

  const conf =
    typeof hit.semanticScore === 'number' && Number.isFinite(hit.semanticScore)
      ? hit.semanticScore.toFixed(2)
      : null

  /** 事实层（从 HitRecord 派生；缺失省略、不伪造） */
  const facts: { key: string; mark: ReactNode; text: string }[] = []
  if (hit.matchedBy === 'literal') {
    facts.push({
      key: 'how',
      mark: MARK_CHECK,
      text:
        hit.matchedKeywords.length > 0
          ? `命中方式：关键词（字面）· 命中词：${hit.matchedKeywords.join('、')}`
          : '命中方式：关键词（字面，记录未带命中词）'
    })
  } else if (hit.matchedBy === 'semantic') {
    facts.push({
      key: 'how',
      mark: MARK_CHECK,
      text: `命中方式：AI 语义${conf != null ? ` · 置信度 ${conf}` : ''}`
    })
    if (hit.semanticReason != null && hit.semanticReason !== '') {
      facts.push({ key: 'reason', mark: MARK_CHECK, text: `AI 判定理由：${hit.semanticReason}` })
    }
  } else if (hit.matchedBy === 'rule') {
    const rule = hit.matchedRule ?? null
    facts.push({
      key: 'how',
      mark: MARK_CHECK,
      text:
        rule != null && rule !== ''
          ? `命中方式：价格规则「${rule}」`
          : '命中方式：价格规则（记录未带规则名）'
    })
  } else {
    facts.push({
      key: 'how',
      mark: MARK_CHECK,
      text: '命中方式：来源级全匹配（该来源开启全匹配，新帖直接命中）'
    })
  }
  if (hit.notifiedAt !== null) {
    facts.push({
      key: 'push',
      mark: MARK_CHECK,
      text: `推送结果：已推送 · ${formatHitTimestamp(hit.notifiedAt)}`
    })
  } else if (hit.notifyError !== null) {
    facts.push({ key: 'push', mark: MARK_X, text: `推送结果：推送失败 · ${hit.notifyError}` })
  } else {
    facts.push({
      key: 'push',
      mark: MARK_CHECK,
      text: '推送结果：未推送 · 静音（推送总开关关闭，或无就绪通道）'
    })
  }
  if (dealSummary != null) {
    facts.push({ key: 'deal', mark: MARK_CHECK, text: `价格提取（按标题现算）：${dealSummary}` })
  }

  return (
    <>
      <div className="d-meta">
        <span className="src num" title={`来源：${sourceLabel(hit.topic.sourceId)}`}>
          {sourceLabel(hit.topic.sourceId)}
        </span>
        <time className="num" title={timeIso ?? undefined}>
          {formatClock(timeIso)}
        </time>
        <span className={`badge ${badge.cls}`} title={badge.title}>
          {badge.label}
        </span>
        {attribution != null && (
          <span className="rname" title={attribution.title}>
            {attribution.text}
          </span>
        )}
      </div>
      <button
        type="button"
        className="d-title hit-title"
        title={`打开原帖：${hit.topic.title}`}
        onClick={(e) => {
          void openExternalWithTitleHint(e.currentTarget, hit.topic.url)
        }}
      >
        {hit.topic.title}
      </button>
      <div className="d-price">
        <span className="price" title={dealSummary ?? '标题未提取出价格'}>
          {dealPriceText(hit.topic.title)}
        </span>
        <span className="conf">
          语义置信度 <b>{conf ?? '—'}</b>
        </span>
      </div>
      <div className="d-sec">
        <h5>命中原因 · 逐条可解释</h5>
        <ul>
          {facts.map((f) => (
            <li key={f.key}>
              {f.mark}
              <span>{f.text}</span>
            </li>
          ))}
        </ul>
        <ReJudgeBlock hit={hit} />
      </div>
      {commentary != null && commentary !== '' && (
        <div className="d-sec">
          <h5>AI 锐评</h5>
          <div className="quote">{commentary}</div>
        </div>
      )}
      <div className="d-sec">
        <h5>这条推送有用吗？</h5>
        <DrawerFeedback hit={hit} />
      </div>
    </>
  )
}

/**
 * 抽屉宿主：常驻渲染遮罩与抽屉壳（类名切换驱动 overlays.css 过渡；关闭态
 * inert 离屏不进 Tab 序）。关闭瞬间保留上一条内容滑出（内容态本地缓存）。
 */
export function HitDetailDrawer() {
  const [hit, setHit] = useState<HitRecord | null>(() => drawerHit())
  const drawerRef = useRef<HTMLElement | null>(null)
  /** 关闭瞬间滑出过渡期间保留的上一条（aria 隐藏 + inert，纯视觉余像） */
  const lastHitRef = useRef<HitRecord | null>(null)

  useEffect(() => subscribeDrawer(setHit), [])

  const open = hit !== null
  if (hit !== null) lastHitRef.current = hit
  const shown = hit ?? lastHitRef.current

  // Esc 关闭：捕获阶段监听，先于页级 Esc（History/Dispositions/Settings 的
  // bubble 监听与 React 根合成事件）；开着抽屉时短路——「只关抽屉」
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.isComposing) return
      e.preventDefault()
      e.stopPropagation()
      closeDrawer()
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [open])

  // 打开时焦点移入抽屉面板（键盘用户即达）；关闭还原由 store 侧负责
  useEffect(() => {
    if (open) drawerRef.current?.focus()
  }, [open])

  return (
    <>
      <div
        className={open ? 'bk on' : 'bk'}
        aria-hidden="true"
        onClick={closeDrawer}
      />
      <aside
        ref={drawerRef}
        className={open ? 'drawer open' : 'drawer'}
        role="dialog"
        aria-modal="true"
        aria-label="命中详情"
        aria-hidden={!open}
        inert={!open}
        tabIndex={-1}
      >
        <div className="d-head">
          <span className="card-title-aux">Hit Detail · 命中详情</span>
          <button
            type="button"
            className="d-close"
            aria-label="关闭命中详情"
            title="关闭（Esc）"
            onClick={closeDrawer}
          >
            <IconX size={13} className="ic" />
          </button>
        </div>
        <div className="d-body">
          {shown != null && <DrawerContent key={hitRowKey(shown)} hit={shown} />}
        </div>
      </aside>
    </>
  )
}
