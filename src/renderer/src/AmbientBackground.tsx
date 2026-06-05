import React from 'react'

interface Props {
  variant?: 'main' | 'widget'
}

export default function AmbientBackground({ variant = 'main' }: Props): React.ReactElement {
  return (
    <div className={`ambient-bg ambient-bg--${variant}`} aria-hidden="true">
      <div className="ambient-orb ambient-orb--1" />
      <div className="ambient-orb ambient-orb--2" />
      <div className="ambient-orb ambient-orb--3" />
    </div>
  )
}
