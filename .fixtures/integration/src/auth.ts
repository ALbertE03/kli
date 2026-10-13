import { createHash, randomUUID } from "node:crypto";

/**
 * TypeScript source: user auth module
 */

export interface User {
  id: string;
  name: string;
  email: string;
  role: "admin" | "user" | "guest";
}

export interface AuthToken {
  userId: string;
  token: string;
  expiresAt: Date;
}

export class AuthService {
  private readonly users: Map<string, User> = new Map();
  private readonly tokens: Map<string, AuthToken> = new Map();

  async register(email: string, password: string): Promise<User> {
    const id = randomUUID();
    const user: User = { id, name: email, email, role: "user" };
    this.users.set(id, user);
    return user;
  }

  async authenticate(email: string, password: string): Promise<string | null> {
    for (const user of this.users.values()) {
      if (user.email === email) {
        const token = randomUUID();
        this.tokens.set(token, {
          userId: user.id,
          token,
          expiresAt: new Date(Date.now() + 3600_000),
        });
        return token;
      }
    }
    return null;
  }

  validate(token: string): User | null {
    const auth = this.tokens.get(token);
    if (!auth || auth.expiresAt < new Date()) return null;
    return this.users.get(auth.userId) ?? null;
  }
}

export function hashPassword(password: string): string {
  return createHash("sha256").update(password).digest("hex");
}
