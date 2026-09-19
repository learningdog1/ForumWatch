/**
 * 设置表单的字段行：左标签右控件，hint 占满右列（可传带色的 ReactNode）。
 */
import type { ReactNode } from 'react'

export function Field(props: { label: string; children: ReactNode; hint?: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={props.htmlFor}>
        {props.label}
      </label>
      <div className="field-control">{props.children}</div>
      {props.hint != null && <div className="field-hint">{props.hint}</div>}
    </div>
  )
}
