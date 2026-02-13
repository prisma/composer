/**
 * Simple fetch handler demonstrating Wrangler artifact boundary.
 * Config + this code → bundled artifact → deploy.
 */

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const envName = env.ENVIRONMENT ?? "unknown";
    const apiHost = env.API_HOST ?? "unknown";

    if (url.pathname === "/") {
      return new Response(
        JSON.stringify({
          worker: "example-worker",
          environment: envName,
          apiHost,
          message: "Config + code → artifact → deploy",
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    return new Response("Not found", { status: 404 });
  },
};

interface Env {
  ENVIRONMENT: string;
  API_HOST: string;
}
/**
 * Simple fetch handler demonstrating Wrangler artifact boundary.
 * Config + this code → bundled artifact → deploy.
 */

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const envName = env.ENVIRONMENT ?? "unknown";
    const apiHost = env.API_HOST ?? "unknown";

    if (url.pathname === "/") {
      return new Response(
        JSON.stringify({
          worker: "example-worker",
          environment: envName,
          apiHost,
          message: "Config + code → artifact → deploy",
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    return new Response("Not found", { status: 404 });
  },
};

interface Env {
  ENVIRONMENT: string;
  API_HOST: string;
}
