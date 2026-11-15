import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import { App } from './app/App.tsx'
import { ErrorBoundary } from './app/ErrorBoundary.tsx'
import { FeedbackProvider } from './ui/index.tsx'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: (count, error: any) => error?.status !== 404 && error?.status !== 401 && error?.status !== 403 && count < 2, refetchOnWindowFocus: true, staleTime: 5_000 } },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <FeedbackProvider>
            <App />
          </FeedbackProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
)
