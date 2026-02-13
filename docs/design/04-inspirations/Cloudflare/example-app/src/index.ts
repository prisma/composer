export interface Env {
  EXAMPLE_KV: KVNamespace;
  EXAMPLE_R2: R2Bucket;
  DB: D1Database;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/kv":
        return handleKv(env);
      case "/r2":
        return handleR2(env);
      case "/d1":
        return handleD1(env);
      case "/":
        return new Response(
          JSON.stringify({
            message: "Env bindings example",
            endpoints: ["/kv", "/r2", "/d1"],
          }),
          { headers: { "Content-Type": "application/json" } }
        );
      default:
        return new Response("Not Found", { status: 404 });
    }
  },
};

async function handleKv(env: Env): Promise<Response> {
  const key = "demo-key";
  await env.EXAMPLE_KV.put(key, `value-${Date.now()}`);
  const value = await env.EXAMPLE_KV.get(key);
  return Response.json({ binding: "KV", key, value });
}

async function handleR2(env: Env): Promise<Response> {
  const key = `object-${Date.now()}.txt`;
  await env.EXAMPLE_R2.put(key, "Hello from R2", {
    httpMetadata: { contentType: "text/plain" },
  });
  const obj = await env.EXAMPLE_R2.get(key);
  const body = obj ? await obj.text() : null;
  return Response.json({ binding: "R2", key, body });
}

async function handleD1(env: Env): Promise<Response> {
  const result = await env.DB.prepare("SELECT 1 as ok").first();
  return Response.json({ binding: "D1", query: "SELECT 1", result });
}

export interface Env {
  EXAMPLE_KV: KVNamespace;
  EXAMPLE_R2: R2Bucket;
  DB: D1Database;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/kv":
        return handleKv(env);
      case "/r2":
        return handleR2(env);
      case "/d1":
        return handleD1(env);
      case "/":
        return new Response(
          JSON.stringify({
            message: "Env bindings example",
            endpoints: ["/kv", "/r2", "/d1"],
          }),
          { headers: { "Content-Type": "application/json" } }
        );
      default:
        return new Response("Not Found", { status: 404 });
    }
  },
};

async function handleKv(env: Env): Promise<Response> {
  const key = "demo-key";
  await env.EXAMPLE_KV.put(key, `value-${Date.now()}`);
  const value = await env.EXAMPLE_KV.get(key);
  return Response.json({ binding: "KV", key, value });
}

async function handleR2(env: Env): Promise<Response> {
  const key = `object-${Date.now()}.txt`;
  await env.EXAMPLE_R2.put(key, "Hello from R2", {
    httpMetadata: { contentType: "text/plain" },
  });
  const obj = await env.EXAMPLE_R2.get(key);
  const body = obj ? await obj.text() : null;
  return Response.json({ binding: "R2", key, body });
}

async function handleD1(env: Env): Promise<Response> {
  const result = await env.DB.prepare("SELECT 1 as ok").first();
  return Response.json({ binding: "D1", query: "SELECT 1", result });
}
