import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Open links externally via the Electron shell instead of navigating in-app.
const markdownComponents = {
  a: ({ href, children }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { children?: React.ReactNode }) => (
    <a
      href={href}
      onClick={(e) => {
        if (href) {
          e.preventDefault()
          window.electron.system.openExternal(href)
        }
      }}
    >
      {children}
    </a>
  )
}

interface Props {
  children: string
  className?: string
}

/**
 * Renders a markdown string using the project-standard md-text styles.
 * Drop-in for any plain-text field whose content may carry Markdown formatting
 * (bold, lists, inline code, links) produced by the LLM.
 */
export default function MarkdownText({ children, className }: Props): React.ReactElement {
  return (
    <div className={['md-text', className].filter(Boolean).join(' ')}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {children}
      </ReactMarkdown>
    </div>
  )
}
