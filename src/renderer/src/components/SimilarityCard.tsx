/**
 * 「相似降噪」卡（阶段 5a 自 Settings.tsx inline 段拆出，settings.md §7）：
 * 开关 + 相似阈值滑杆，内容与 hint 照搬（§3.6 保留清单），48 小时窗口 aux 保留。
 */
import { Field } from './Field'

export function SimilarityCard(props: {
  enabled: boolean
  threshold: number
  onToggle: () => void
  onThresholdChange: (v: number) => void
}) {
  return (
    <section className="card smon">
      <div className="card-head">
        <span className="card-title">相似降噪</span>
        <span className="card-title-aux">48 小时窗口</span>
      </div>
      <Field
        label="开关"
        hint={
          <span>
            命中推送前与近 48 小时已推送的标题比对相似度，相似则不再推。只抑制
            <strong>装饰级</strong>转发变体（加标签 / emoji / 全角半角 / 大小写等）；
            换词改写的重复帖抑制不了（相似度不够），那是 AI 语义通道的取舍。
          </span>
        }
      >
        <div className="switch-row">
          <button
            type="button"
            role="switch"
            className="switch"
            aria-checked={props.enabled}
            aria-label="相似降噪"
            onClick={props.onToggle}
          />
          <span className="feedback muted">{props.enabled ? '开启' : '关闭'}</span>
        </div>
      </Field>
      <Field
        label="相似阈值"
        htmlFor="similarity-threshold"
        hint={
          <span>
            标题归一化后按 3-gram Jaccard 相似度 ≥ 阈值判为相似。调低拦得更狠
            （可能误杀正常新帖），调高只拦几乎相同的标题。默认 0.72。
          </span>
        }
      >
        <div className="input-row">
          <input
            id="similarity-threshold"
            className="input-range"
            type="range"
            min={0.5}
            max={0.95}
            step={0.01}
            value={props.threshold}
            onChange={(e) => props.onThresholdChange(Number(e.target.value))}
            aria-label="相似阈值"
          />
          <span className="feedback muted num">{props.threshold.toFixed(2)}</span>
        </div>
      </Field>
    </section>
  )
}
