import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import './styles.css'
import { TooltipProvider } from '@/components/ui/overlay'
import { AppShell } from '@/components/layout/AppShell'
import { Dashboard } from '@/pages/Dashboard'
import { Customers } from '@/pages/Customers'
import { CustomerDetail } from '@/pages/CustomerDetail'
import { DailyUsage, Expenses, MoneyPaid, MoneyReceived, Transactions } from '@/pages/TransactionPages'
import { Analytics } from '@/pages/Analytics'
import { CsvCenter } from '@/pages/CsvCenter'
import { Backup } from '@/pages/Backup'
import { Settings } from '@/pages/Settings'
import { ApiError } from '@/lib/api'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => !(error instanceof ApiError) && count < 1,
      refetchOnWindowFocus: false,
      staleTime: 5_000
    }
  }
})

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <HashRouter>
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<Dashboard />} />
              <Route path="customers" element={<Customers />} />
              <Route path="customers/:id" element={<CustomerDetail />} />
              <Route path="usage" element={<DailyUsage />} />
              <Route path="received" element={<MoneyReceived />} />
              <Route path="paid" element={<MoneyPaid />} />
              <Route path="expenses" element={<Expenses />} />
              <Route path="transactions" element={<Transactions />} />
              <Route path="analytics" element={<Analytics />} />
              <Route path="csv" element={<CsvCenter />} />
              <Route path="backup" element={<Backup />} />
              <Route path="settings" element={<Settings />} />
              <Route path="*" element={<Dashboard />} />
            </Route>
          </Routes>
        </HashRouter>
        <Toaster position="bottom-right" richColors closeButton toastOptions={{ duration: 5000 }} />
      </TooltipProvider>
    </QueryClientProvider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
