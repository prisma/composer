/**
 * TanStack DB Collection
 *
 * createCollection + queryCollectionOptions defines:
 * 1. How data is fetched (queryFn) and keyed (getKey)
 * 2. How mutations are persisted (onUpdate, etc.)
 *
 * The collection is the single source of truth. Mutations apply optimistically
 * to the local store immediately; onUpdate/onInsert/onDelete run async to sync
 * to the server. On failure, optimistic changes auto-rollback.
 */
import { createCollection } from '@tanstack/react-db'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient()

export type Todo = {
  id: string
  text: string
  completed: boolean
  createdAt: string
}

const MOCK_TODOS: Todo[] = [
  { id: '1', text: 'Learn TanStack DB', completed: false, createdAt: new Date().toISOString() },
  { id: '2', text: 'Try live queries', completed: false, createdAt: new Date().toISOString() },
  { id: '3', text: 'Use optimistic updates', completed: true, createdAt: new Date().toISOString() },
]

export const todoCollection = createCollection(
  queryCollectionOptions({
    queryKey: ['todos'],
    queryClient,
    queryFn: async () => {
      // In production: fetch('/api/todos').then(r => r.json())
      await new Promise((r) => setTimeout(r, 300))
      return MOCK_TODOS
    },
    getKey: (item) => item.id,
    onUpdate: async ({ transaction }) => {
      const { original, modified } = transaction.mutations[0]
      // In production: await fetch(`/api/todos/${original.id}`, { method: 'PUT', body: JSON.stringify(modified) })
      await new Promise((r) => setTimeout(r, 200))
      console.log('[sync] updated', original.id, '->', modified)
    },
  })
)

/**
 * TanStack DB Collection
 *
 * createCollection + queryCollectionOptions defines:
 * 1. How data is fetched (queryFn) and keyed (getKey)
 * 2. How mutations are persisted (onUpdate, etc.)
 *
 * The collection is the single source of truth. Mutations apply optimistically
 * to the local store immediately; onUpdate/onInsert/onDelete run async to sync
 * to the server. On failure, optimistic changes auto-rollback.
 */
import { createCollection } from '@tanstack/react-db'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient()

export type Todo = {
  id: string
  text: string
  completed: boolean
  createdAt: string
}

const MOCK_TODOS: Todo[] = [
  { id: '1', text: 'Learn TanStack DB', completed: false, createdAt: new Date().toISOString() },
  { id: '2', text: 'Try live queries', completed: false, createdAt: new Date().toISOString() },
  { id: '3', text: 'Use optimistic updates', completed: true, createdAt: new Date().toISOString() },
]

export const todoCollection = createCollection(
  queryCollectionOptions({
    queryKey: ['todos'],
    queryClient,
    queryFn: async () => {
      // In production: fetch('/api/todos').then(r => r.json())
      await new Promise((r) => setTimeout(r, 300))
      return MOCK_TODOS
    },
    getKey: (item) => item.id,
    onUpdate: async ({ transaction }) => {
      const { original, modified } = transaction.mutations[0]
      // In production: await fetch(`/api/todos/${original.id}`, { method: 'PUT', body: JSON.stringify(modified) })
      await new Promise((r) => setTimeout(r, 200))
      console.log('[sync] updated', original.id, '->', modified)
    },
  })
)
