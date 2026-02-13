import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Convex schema definition.
 * Tables are defined with their field shapes. Indexes enable efficient queries.
 */
export default defineSchema({
  todos: defineTable({
    text: v.string(),
    completed: v.boolean(),
    createdAt: v.number(),
  }).index("by_createdAt", ["createdAt"]),
});

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Convex schema definition.
 * Tables are defined with their field shapes. Indexes enable efficient queries.
 */
export default defineSchema({
  todos: defineTable({
    text: v.string(),
    completed: v.boolean(),
    createdAt: v.number(),
  }).index("by_createdAt", ["createdAt"]),
});
