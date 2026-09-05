import { ApiError } from "./security.js";

export type BridgeServiceMethod = (params: Record<string, unknown>) => unknown | Promise<unknown>;

/** Trusted, in-process configuration. Never construct services from client input. */
export interface BridgeServiceDefinition {
  readonly namespace: string;
  readonly methods: Readonly<Record<string, BridgeServiceMethod>>;
}

const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const RESERVED_NAMESPACES = new Set([
  "sessions", "projects", "models", "transcript", "thread", "turn", "voice", "bridge",
]);

/** Exact allowlist for additional services reached after WebSocket authentication. */
export class BridgeServiceRegistry {
  private readonly methods = new Map<string, BridgeServiceMethod>();

  constructor(services: readonly BridgeServiceDefinition[]) {
    const namespaces = new Set<string>();
    for (const service of services) {
      if (!NAME.test(service.namespace) || RESERVED_NAMESPACES.has(service.namespace) ||
          namespaces.has(service.namespace)) {
        throw new Error("Invalid or duplicate bridge service namespace");
      }
      namespaces.add(service.namespace);
      for (const [name, handler] of Object.entries(service.methods)) {
        if (!NAME.test(name) || typeof handler !== "function") {
          throw new Error("Invalid bridge service method");
        }
        this.methods.set(`${service.namespace}.${name}`, handler);
      }
    }
  }

  async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    const handler = this.methods.get(method);
    if (handler === undefined) throw new ApiError(404, "method_not_found", "Method not found");
    if (params === null || typeof params !== "object" || Array.isArray(params)) {
      throw new ApiError(400, "invalid_request", "Invalid request parameters");
    }
    // Each service validates its own schema and enforces operation-specific
    // permissions and resource limits. The socket response boundary maps errors.
    return handler(params);
  }
}
