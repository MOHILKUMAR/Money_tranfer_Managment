import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { ApiInput, ApiOutput } from '@shared/api'
import type { IpcChannel } from '@shared/channels'
import { DEFAULT_CURRENCY, formatMoney, type CurrencyConfig } from '@shared/money'
import { formatIsoDate } from '@shared/dates'
import { call, errorMessage } from './api'

type QueryOpts<C extends IpcChannel> = Omit<UseQueryOptions<ApiOutput<C>, Error>, 'queryKey' | 'queryFn'>

/** Read query for any channel; the payload is part of the cache key. */
export function useApi<C extends IpcChannel>(channel: C, payload?: ApiInput<C>, options?: QueryOpts<C>) {
  return useQuery<ApiOutput<C>, Error>({
    queryKey: [channel, payload ?? null],
    queryFn: () => (call as (c: C, p?: unknown) => Promise<ApiOutput<C>>)(channel, payload),
    ...options
  })
}

/**
 * Mutation that refreshes every cached query after the main process confirms
 * the database commit, so ledgers, balances and analytics never show stale data.
 */
export function useApiMutation<C extends IpcChannel>(channel: C, options: { successMessage?: (data: ApiOutput<C>) => string | null; silentError?: boolean } = {}) {
  const queryClient = useQueryClient()
  return useMutation<ApiOutput<C>, Error, ApiInput<C>>({
    mutationFn: (payload) => (call as (c: C, p?: unknown) => Promise<ApiOutput<C>>)(channel, payload),
    onSuccess: async (data) => {
      await queryClient.invalidateQueries()
      const message = options.successMessage?.(data)
      if (message) toast.success(message)
    },
    onError: (error) => {
      if (!options.silentError) toast.error(errorMessage(error))
    }
  })
}

export function useSettings() {
  return useApi('settings:get', undefined, { staleTime: 60_000 })
}

export function useLookups() {
  return useApi('lookups:list', undefined, { staleTime: 60_000 })
}

export function useAppInfo() {
  return useApi('app:info', undefined, { staleTime: 60_000 })
}

/** Formatting helpers bound to the configured currency and date format. */
export function useFormat() {
  const { data: settings } = useSettings()
  const currency: CurrencyConfig = settings?.currency ?? DEFAULT_CURRENCY
  const dateFormat = settings?.dateFormat ?? 'dd MMM yyyy'
  return {
    currency,
    dateFormat,
    money: (minor: number | null | undefined) => (minor === null || minor === undefined ? '—' : formatMoney(minor, currency)),
    date: (iso: string | null | undefined) => (iso ? formatIsoDate(iso, dateFormat) : '—')
  }
}

export function useToday(): string {
  const { data } = useAppInfo()
  if (data?.today) return data.today
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
