/**
 * TanStack DB: The Live Query Loop
 *
 * 1. COLLECTION holds the data (backed by TanStack Query fetch + optimistic store)
 * 2. useLiveQuery subscribes to a filtered/sorted view of the collection
 * 3. When collection.update/insert/delete runs:
 *    - UI updates IMMEDIATELY (optimistic)
 *    - Persistence handler (onUpdate) runs in the background
 *    - On failure: changes roll back automatically
 *
 * This component demonstrates that loop: a live query over incomplete todos,
 * plus an optimistic toggle that applies instantly and syncs later.
 */
import { eq, useLiveQuery } from '@tanstack/react-db'
import { todoCollection } from './collection'

export default function App() {
  // Live query: subscribes to the collection and re-runs when data changes.
  // .from() defines the source, .where() filters, .orderBy() sorts.
  // The result updates reactively—no manual refetch or setState.
  const { data: todos, isLoading } = useLiveQuery((q) =>
    q
      .from({ todo: todoCollection })
      .where(({ todo }) => eq(todo.completed, false))
      .orderBy(({ todo }) => todo.createdAt, 'desc')
  )

  // Optimistic update: apply change locally first, then sync to server.
  // collection.update() mutates the optimistic store → live query recomputes → component re-renders.
  const toggleTodo = (id: string, completed: boolean) => {
    todoCollection.update(id, (draft) => {
      draft.completed = !completed
    })
  }

  if (isLoading) return <div>Loading…</div>

  return (
    <div>
      <h1>Incomplete todos</h1>
      <ul>
        {(todos ?? []).map((todo) => (
          <li key={todo.id}>
            <label>
              <input
                type="checkbox"
                checked={todo.completed}
                onChange={() => toggleTodo(todo.id, todo.completed)}
              />
              {todo.text}
            </label>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * TanStack DB: The Live Query Loop
 *
 * 1. COLLECTION holds the data (backed by TanStack Query fetch + optimistic store)
 * 2. useLiveQuery subscribes to a filtered/sorted view of the collection
 * 3. When collection.update/insert/delete runs:
 *    - UI updates IMMEDIATELY (optimistic)
 *    - Persistence handler (onUpdate) runs in the background
 *    - On failure: changes roll back automatically
 *
 * This component demonstrates that loop: a live query over incomplete todos,
 * plus an optimistic toggle that applies instantly and syncs later.
 */
import { eq, useLiveQuery } from '@tanstack/react-db'
import { todoCollection } from './collection'

export default function App() {
  // Live query: subscribes to the collection and re-runs when data changes.
  // .from() defines the source, .where() filters, .orderBy() sorts.
  // The result updates reactively—no manual refetch or setState.
  const { data: todos, isLoading } = useLiveQuery((q) =>
    q
      .from({ todo: todoCollection })
      .where(({ todo }) => eq(todo.completed, false))
      .orderBy(({ todo }) => todo.createdAt, 'desc')
  )

  // Optimistic update: apply change locally first, then sync to server.
  // collection.update() mutates the optimistic store → live query recomputes → component re-renders.
  const toggleTodo = (id: string, completed: boolean) => {
    todoCollection.update(id, (draft) => {
      draft.completed = !completed
    })
  }

  if (isLoading) return <div>Loading…</div>

  return (
    <div>
      <h1>Incomplete todos</h1>
      <ul>
        {(todos ?? []).map((todo) => (
          <li key={todo.id}>
            <label>
              <input
                type="checkbox"
                checked={todo.completed}
                onChange={() => toggleTodo(todo.id, todo.completed)}
              />
              {todo.text}
            </label>
          </li>
        ))}
      </ul>
    </div>
  )
}
