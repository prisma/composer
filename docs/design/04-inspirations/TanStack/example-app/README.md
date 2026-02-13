# TanStack DB Example

Minimal example illustrating TanStack DB's core loop: **collections**, **live queries**, and **optimistic updates**.

## Run

```bash
npm install
npm run dev
```

## What This Shows

1. **`createCollection` + `queryCollectionOptions`**  
   Defines how data is fetched (TanStack Query), keyed, and how mutations are persisted.

2. **`useLiveQuery`**  
   Subscribes to a reactive, filtered view. When the collection changes, the query recomputes and the component re-renders—no manual refetch.

3. **Optimistic update**  
   `todoCollection.update(id, draft => …)` applies changes locally first, then syncs via `onUpdate`. On server failure, changes roll back.

## Structure

```
src/
  collection.ts    # createCollection + queryCollectionOptions
  App.tsx          # useLiveQuery + optimistic toggle
  main.tsx         # QueryClientProvider (required for query collections)
```

Dependencies: `@tanstack/react-db`, `@tanstack/query-db-collection`, `@tanstack/react-query`.

# TanStack DB Example

Minimal example illustrating TanStack DB's core loop: **collections**, **live queries**, and **optimistic updates**.

## Run

```bash
npm install
npm run dev
```

## What This Shows

1. **`createCollection` + `queryCollectionOptions`**  
   Defines how data is fetched (TanStack Query), keyed, and how mutations are persisted.

2. **`useLiveQuery`**  
   Subscribes to a reactive, filtered view. When the collection changes, the query recomputes and the component re-renders—no manual refetch.

3. **Optimistic update**  
   `todoCollection.update(id, draft => …)` applies changes locally first, then syncs via `onUpdate`. On server failure, changes roll back.

## Structure

```
src/
  collection.ts    # createCollection + queryCollectionOptions
  App.tsx          # useLiveQuery + optimistic toggle
  main.tsx         # QueryClientProvider (required for query collections)
```

Dependencies: `@tanstack/react-db`, `@tanstack/query-db-collection`, `@tanstack/react-query`.
