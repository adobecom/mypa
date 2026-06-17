import React from 'react'

export interface TabItem {
  id: string
  label: string
  icon?: React.ReactNode
  count?: number
}

export default function Tabs({
  items,
  active,
  onChange,
  className,
}: {
  items: TabItem[]
  active: string
  onChange: (id: string) => void
  className?: string
}): React.ReactElement {
  return (
    <div className={`tabs${className ? ` ${className}` : ''}`}>
      {items.map((item) => (
        <button
          key={item.id}
          className={`tab${active === item.id ? ' tab--active' : ''}`}
          onClick={() => onChange(item.id)}
        >
          {item.icon}
          {item.label}
          {item.count !== undefined && item.count > 0 && (
            <span className={`tab__count${active === item.id ? ' tab__count--active' : ''}`}>
              {item.count}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}
