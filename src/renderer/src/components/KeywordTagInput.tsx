/**
 * 标签输入：回车添加、× 删除、空输入退格删最后一个；忽略大小写去重。
 * 中文支持：IME 组合期间（isComposing / keyCode 229 / composition 事件）的
 * 回车是选词确认，不当作提交。
 *
 * longText 变体：给"兴趣描述"这类一句自然语言条目用——标签可换行
 * （不截断 ellipsis），且不做大小写折叠去重（自然语句区分大小写才有意义）。
 */
import { useRef, useState, type KeyboardEvent } from 'react'

export function KeywordTagInput(props: {
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  label?: string
  /** 允许长文本标签（自然语言句子）：标签换行展示、精确去重 */
  longText?: boolean
}) {
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const composingRef = useRef(false)

  function exists(kw: string): boolean {
    return props.longText
      ? props.value.includes(kw)
      : props.value.some((t) => t.toLowerCase() === kw.toLowerCase())
  }

  function add(): void {
    const kw = text.trim()
    setText('')
    if (kw === '') return
    if (exists(kw)) return
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
      className={`tags${props.longText ? ' tags-longtext' : ''}`}
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
            ×
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
    </div>
  )
}
