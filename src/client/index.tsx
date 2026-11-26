import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './terminal.module.css'

function syncHostTheme(): void {
  const doc = document.documentElement
  const computed = getComputedStyle(doc)
  const bg = computed.getPropertyValue('--background').trim() || computed.backgroundColor

  let isLight = false
  if (bg && document.body) {
    const probe = document.createElement('span')
    probe.style.color = bg
    probe.style.display = 'none'
    document.body.appendChild(probe)
    const rgb = getComputedStyle(probe).color
    probe.remove()

    const match = rgb.match(/\d+(\.\d+)?/g)
    if (match && match.length >= 3) {
      const r = Number(match[0])
      const g = Number(match[1])
      const b = Number(match[2])
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
      isLight = lum > 0.52
    }
  } else if (window.matchMedia?.('(prefers-color-scheme: light)').matches) {
    isLight = true
  }

  const nextTheme = isLight ? 'light' : 'dark'
  if (doc.getAttribute('data-theme') !== nextTheme) {
    doc.setAttribute('data-theme', nextTheme)
  }
}

class OpsErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 16,
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
            fontSize: 13,
            color: 'var(--foreground, #e4e4e7)',
            background: 'var(--background, #181818)',
            height: '100vh',
            boxSizing: 'border-box',
          }}
        >
          <strong>Pulse failed to render</strong>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              marginTop: 8,
              opacity: 0.85,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              fontSize: 12,
            }}
          >
            {this.state.error.message}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              marginTop: 12,
              padding: '5px 10px',
              borderRadius: 5,
              border: '1px solid var(--border, rgba(255,255,255,0.18))',
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            Reload Dashboard
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

let syncingTheme = false
function safeSyncHostTheme(): void {
  if (syncingTheme) return
  syncingTheme = true
  try {
    syncHostTheme()
  } finally {
    syncingTheme = false
  }
}

safeSyncHostTheme()
let themeSyncQueued = false
const observer = new MutationObserver(() => {
  if (themeSyncQueued) return
  themeSyncQueued = true
  queueMicrotask(() => {
    themeSyncQueued = false
    safeSyncHostTheme()
  })
})
observer.observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['style', 'class'],
})
window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', safeSyncHostTheme)

window.__agyPulseMounted = true
const mount = document.getElementById('root')
if (mount) {
  createRoot(mount).render(
    <OpsErrorBoundary>
      <App />
    </OpsErrorBoundary>,
  )
}
