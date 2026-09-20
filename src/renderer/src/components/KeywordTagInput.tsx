/**
 * 标签输入：回车添加、叉号（IconX，§C-2）删除、空输入退格删最后一个；忽略大小写去重。
 * 中文支持：IME 组合期间（isComposing / keyCode 229 / composition 事件）的
 * 回车是选词确认，不当作提交。
 *
 * 重复词反馈（audit #14，阶段 5b）：不再静默忽略——输入框 200ms 抖动 +
 * aria-live 播报「「vps」已在列表中，未重复添加」（sr-only 活动区，不占版面）。
 *
 * longText 变体：给"兴趣描述"这类一句自然语言条目用——标签可换行
 * （不截断 ellipsis），且不做大小写折叠去重（自然语句区分大小写才有意义）。
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { IconX } from './icons'

/** 重复提示的驻留时长（比抖动长——留出读屏播报与扫读时间） */
const DUP_NOTE_MS = 2500
/** 抖动时长（settings.md §5.4：200ms） */
const SHAKE_MS = 200

export function KeywordTagInput(props: {
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  label?: string
  /** 允许长文本标签（自然语言句子）：标签换行展示、精确去重 */
  longText?: boolean
}) {
  const [text, setText] = useState('')
  const [shake, setShake] = useState(false)
  const [dupNote, setDupNote] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const composingRef = useRef(false)
  const shakeTimerRef = useRef<number | null>(null)
  const noteTimerRef = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (shakeTimerRef.current != null) window.clearTimeout(shakeTimerRef.current)
      if (noteTimerRef.current != null) window.clearTimeout(noteTimerRef.current)
    },
    []
  )

  function exists(kw: string): boolean {
    return props.longText
      ? props.value.includes(kw)
      : props.value.some((t) => t.toLowerCase() === kw.toLowerCase())
  }

  /** 重复词反馈：抖动（rAF 两拍置位，连续重复也能重启动画）+ aria-live 播报 */
  function signalDuplicate(kw: string): void {
    setDupNote(`「${kw}」已在列表中，未重复添加`)
    setShake(false)
    requestAnimationFrame(() => setShake(true))
    if (shakeTimerRef.current != null) window.clearTimeout(shakeTimerRef.current)
    if (noteTimerRef.current != null) window.clearTimeout(noteTimerRef.current)
    shakeTimerRef.current = window.setTimeout(() => setShake(false), SHAKE_MS)
    noteTimerRef.current = window.setTimeout(() => setDupNote(null), DUP_NOTE_MS)
  }

  function add(): void {
    const kw = text.trim()
    setText('')
    if (kw === '') return
    if (exists(kw)) {
      signalDuplicate(kw)
      return
    }
    setDupNote(null)
    props.onChange([...props.value, kw])
  }

  function remove(kw: string): void {
    props.onChange(props.value.filter((t) => t !== kw))
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.nativeEvent.isComposing || composingRef.current || e.keyCode === 229) return
    if (e.key === 'Enter') {
      e.preventDefault()
      add()
    } else if (e.key === 'Backspace' && text === '' && props.value.length > 0) {
      props.onChange(props.value.slice(0, -1))
    }
  }

  return (
    <div
      className={`tags${props.longText ? ' tags-longtext' : ''}${shake ? ' shake' : ''}`}
      onClick={() => inputRef.current?.focus()}
      role="group"
      aria-label={props.label ?? '关键词标签'}
    >
      {props.value.map((kw) => (
        <span className="tag" key={kw} title={kw}>
          <span className="label">{kw}</span>
          <button
            type="button"
            className="x"
            aria-label={`删除 ${kw}`}
            onClick={() => remove(kw)}
          >
            <IconX size={12} />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        value={text}
        placeholder={props.value.length === 0 ? (props.placeholder ?? '输入后回车添加') : ''}
        aria-label={props.label ?? '新关键词'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onCompositionStart={() => {
          composingRef.current = true
        }}
        onCompositionEnd={() => {
          composingRef.current = false
        }}
      />
      <span className="sr-only" aria-live="polite">
        {dupNote ?? ''}
      </span>
    </div>
  )
}
