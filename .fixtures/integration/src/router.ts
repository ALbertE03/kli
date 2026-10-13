/**
 * TypeScript source: API router
 */
import { AuthService, User } from "./auth.js";

export interface Route {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  handler: (req: Request) => Promise<Response>;
}

export class Router {
  private readonly routes: Route[] = [];
  private readonly authService = new AuthService();

  register(route: Route): void {
    this.routes.push(route);
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method as Route["method"];

    for (const route of this.routes) {
      if (route.method === method && this.matchPath(route.path, url.pathname)) {
        return route.handler(request);
      }
    }
    return new Response("Not found", { status: 404 });
  }

  private matchPath(pattern: string, path: string): boolean {
    const patParts = pattern.split("/").filter(Boolean);
    const pathParts = path.split("/").filter(Boolean);
    if (patParts.length !== pathParts.length) return false;
    return patParts.every((p, i) => p === pathParts[i] || p.startsWith(":"));
  }

  buildRoutes(): Route[] {
    return [
      {
        method: "POST",
        path: "/api/auth/register",
        handler: async (req) => {
          const body = await req.json() as { email: string; password: string };
          const user = await this.authService.register(body.email, body.password);
          return Response.json({ id: user.id, email: user.email }, { status: 201 });
        },
      },
      {
        method: "POST",
        path: "/api/auth/login",
        handler: async (req) => {
          const body = await req.json() as { email: string; password: string };
          const token = await this.authService.authenticate(body.email, body.password);
          if (!token) return new Response("Unauthorized", { status: 401 });
          return Response.json({ token });
        },
      },
      {
        method: "GET",
        path: "/api/users/:id",
        handler: async (req) => {
          const authHeader = req.headers.get("authorization");
          const user = authHeader ? this.authService.validate(authHeader.slice(7)) : null;
          if (!user) return new Response("Unauthorized", { status: 401 });
          return Response.json(user);
        },
      },
    ];
  }
}

export function createApp(): Router {
  const router = new Router();
  for (const route of router.buildRoutes()) {
    router.register(route);
  }
  return router;
}
