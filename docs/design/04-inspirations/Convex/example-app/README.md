# Convex Example App

A minimal Convex scaffold showing queries, mutations, actions, and real-time subscriptions.

## Core Loop

1. **Schema** (`convex/schema.ts`) — Define tables and indexes.
2. **Functions** (`convex/todos.ts`) — Implement `query`, `mutation`, `action`.
3. **Generation** — `npx convex dev` or `npx convex codegen` generates `convex/_generated/api` and `convex/_generated/server`.
4. **Frontend** — Import from `api` and use React hooks (`useQuery`, `useMutation`, `useAction`).

## Generated API Usage

The Convex CLI generates typed API objects from your function exports:

```ts
import { api } from "../convex/_generated/api";

// api.todos.list   → query
// api.todos.add    → mutation
// api.todos.toggle → mutation
// api.todos.remove → mutation
// api.todos.greet  → action
```

Hooks receive these references and return data or invoke functions:

- `useQuery(api.todos.list)` — Subscribes; returns `Doc[] | undefined`. Re-renders when DB changes.
- `useMutation(api.todos.add)` — Returns `(args) => Promise<Id>`. Call to run once.
- `useAction(api.todos.greet)` — Returns `(args) => Promise<string>`. For non-deterministic side effects.

## Function Types

| Type     | Read DB | Write DB | Deterministic | Subscription |
|----------|---------|----------|---------------|--------------|
| Query    | ✅      | ❌       | ✅            | ✅ Auto      |
| Mutation | ✅      | ✅       | ✅            | ❌           |
| Action   | ❌      | ❌       | ❌            | ❌           |

Queries drive reactivity: when mutations change data, all active `useQuery` subscriptions re-run and components re-render.

# Convex Example App

A minimal Convex scaffold showing queries, mutations, actions, and real-time subscriptions.

## Core Loop

1. **Schema** (`convex/schema.ts`) — Define tables and indexes.
2. **Functions** (`convex/todos.ts`) — Implement `query`, `mutation`, `action`.
3. **Generation** — `npx convex dev` or `npx convex codegen` generates `convex/_generated/api` and `convex/_generated/server`.
4. **Frontend** — Import from `api` and use React hooks (`useQuery`, `useMutation`, `useAction`).

## Generated API Usage

The Convex CLI generates typed API objects from your function exports:

```ts
import { api } from "../convex/_generated/api";

// api.todos.list   → query
// api.todos.add    → mutation
// api.todos.toggle → mutation
// api.todos.remove → mutation
// api.todos.greet  → action
```

Hooks receive these references and return data or invoke functions:

- `useQuery(api.todos.list)` — Subscribes; returns `Doc[] | undefined`. Re-renders when DB changes.
- `useMutation(api.todos.add)` — Returns `(args) => Promise<Id>`. Call to run once.
- `useAction(api.todos.greet)` — Returns `(args) => Promise<string>`. For non-deterministic side effects.

## Function Types

| Type     | Read DB | Write DB | Deterministic | Subscription |
|----------|---------|----------|---------------|--------------|
| Query    | ✅      | ❌       | ✅            | ✅ Auto      |
| Mutation | ✅      | ✅       | ✅            | ❌           |
| Action   | ❌      | ❌       | ❌            | ❌           |

Queries drive reactivity: when mutations change data, all active `useQuery` subscriptions re-run and components re-render.
