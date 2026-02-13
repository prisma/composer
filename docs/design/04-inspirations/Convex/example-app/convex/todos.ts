import { v } from "convex/values";
import { mutation, query, action } from "./_generated/server";

/**
 * List all todos.
 * Queries are read-only, cacheable, and automatically subscribed for real-time updates.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("todos").order("desc").collect();
  },
});

/**
 * Add a todo.
 * Mutations are write-only; they run once and update the database.
 */
export const add = mutation({
  args: { text: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db.insert("todos", {
      text: args.text,
      completed: false,
      createdAt: Date.now(),
    });
  },
});

/**
 * Toggle a todo's completed state.
 */
export const toggle = mutation({
  args: { id: v.id("todos") },
  handler: async (ctx, args) => {
    const todo = await ctx.db.get(args.id);
    if (!todo) throw new Error("Todo not found");
    await ctx.db.patch(args.id, { completed: !todo.completed });
    return args.id;
  },
});

/**
 * Delete a todo.
 */
export const remove = mutation({
  args: { id: v.id("todos") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
    return args.id;
  },
});

/**
 * Optional action: call external API or do async work.
 * Actions can run non-deterministic code; they cannot read/write the DB directly.
 */
export const greet = action({
  args: { name: v.string() },
  handler: async (_ctx, args) => {
    return `Hello, ${args.name}! (from Convex action)`;
  },
});

import { v } from "convex/values";
import { mutation, query, action } from "./_generated/server";

/**
 * List all todos.
 * Queries are read-only, cacheable, and automatically subscribed for real-time updates.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("todos").order("desc").collect();
  },
});

/**
 * Add a todo.
 * Mutations are write-only; they run once and update the database.
 */
export const add = mutation({
  args: { text: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db.insert("todos", {
      text: args.text,
      completed: false,
      createdAt: Date.now(),
    });
  },
});

/**
 * Toggle a todo's completed state.
 */
export const toggle = mutation({
  args: { id: v.id("todos") },
  handler: async (ctx, args) => {
    const todo = await ctx.db.get(args.id);
    if (!todo) throw new Error("Todo not found");
    await ctx.db.patch(args.id, { completed: !todo.completed });
    return args.id;
  },
});

/**
 * Delete a todo.
 */
export const remove = mutation({
  args: { id: v.id("todos") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
    return args.id;
  },
});

/**
 * Optional action: call external API or do async work.
 * Actions can run non-deterministic code; they cannot read/write the DB directly.
 */
export const greet = action({
  args: { name: v.string() },
  handler: async (_ctx, args) => {
    return `Hello, ${args.name}! (from Convex action)`;
  },
});
