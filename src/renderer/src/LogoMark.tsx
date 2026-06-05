import React from 'react'
import logoSrc from './assets/logo.png'

interface Props {
  size: number
}

export default function LogoMark({ size }: Props): React.ReactElement {
  return (
    <img
      src={logoSrc}
      width={size}
      height={size}
      style={{ flexShrink: 0, display: 'block' }}
      alt="mypa"
    />
  )
}
