import { Component, type ErrorInfo, type ReactNode } from 'react'

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }
  static getDerivedStateFromError(error: Error): State {
    return { error }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ui]', error, info.componentStack)
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-base font-semibold">Something went wrong.</p>
        <p className="max-w-md text-sm text-fg-3">{this.state.error.message}</p>
        <button type="button" className="text-sm font-medium text-accent-fg underline" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    )
  }
}
