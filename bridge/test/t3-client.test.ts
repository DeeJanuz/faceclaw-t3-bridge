import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import { WebSocketServer } from "ws";
import { ApiError } from "../src/security.js";
import { HttpT3Client } from "../src/t3-client.js";
import type { BridgeConfig, T3Project } from "../src/types.js";

const T3_ACCESS_TOKEN = "t3-test-secret";
const servers: Server[] = [];

afterEach(async () => {
  const active = servers.splice(0);
  for (const server of active) server.closeAllConnections();
  await Promise.all(
    active.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function startUpstream(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  rpcHandler: ((request: Record<string, unknown>) => unknown | Promise<unknown>) | null =
    () => providerConfig(),
): Promise<URL> {
  const server = createServer((request, response) => {
    void handler(request, response).catch((error: unknown) => {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    });
  });
  const websocketServer = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/ws" || request.headers.authorization !== `Bearer ${T3_ACCESS_TOKEN}`) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      if (rpcHandler === null) return;
      websocket.once("message", (data) => {
        void Promise.resolve(
          rpcHandler(JSON.parse(data.toString("utf8")) as Record<string, unknown>),
        ).then((value) => {
          const rpcRequest = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
          websocket.send(
            JSON.stringify({
              _tag: "Exit",
              requestId: rpcRequest.id,
              exit: { _tag: "Success", value },
            }),
          );
        });
      });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return new URL(`http://127.0.0.1:${address.port}`);
}

function config(t3BaseUrl: URL, overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    bridgeToken: "abcdefghijklmnopqrstuvwxyzABCDEF",
    bridgePassphrase: null,
    allowedOrigins: new Set(["https://even-app.example"]),
    allowEvenLoopbackOrigin: false,
    allowNoOrigin: false,
    projectIds: null,
    runtimeMode: "approval-required",
    pollIntervalMs: 60_000,
    rateLimitPerMinute: 1000,
    maxBodyBytes: 16_384,
    maxTextChars: 8000,
    maxUpstreamBytes: 8 * 1024 * 1024,
    upstreamTimeoutMs: 10_000,
    t3BaseUrl,
    t3AccessToken: T3_ACCESS_TOKEN,
    whisperServerUrl: new URL("http://127.0.0.1:8178/inference"),
    whisperLanguage: "en",
    whisperPartialIntervalMs: 1000,
    transcriptionTimeoutMs: 60_000,
    maxVoiceBytes: 9_600_000,
    ...overrides,
  };
}

function providerConfig(): Record<string, unknown> {
  return {
    auth: { private: "must-not-escape" },
    providers: [
      {
        instanceId: "codex",
        driver: "codex",
        displayName: "Codex Personal",
        enabled: true,
        installed: true,
        availability: "available",
        status: "ready",
        auth: { status: "authenticated", email: "private@example.com" },
        message: "private provider detail",
        models: [
          {
            slug: "gpt-5.6-sol",
            name: "GPT-5.6 Sol",
            isDefault: true,
            isCustom: false,
            capabilities: {
              optionDescriptors: [
                {
                  id: "reasoningEffort",
                  label: "Reasoning",
                  type: "select",
                  currentValue: "medium",
                  options: [
                    { id: "low", label: "Low" },
                    { id: "medium", label: "Medium", isDefault: true },
                    { id: "high", label: "High" },
                  ],
                },
                {
                  id: "serviceTier",
                  label: "Service Tier",
                  type: "select",
                  currentValue: "fast",
                  options: [
                    { id: "default", label: "Standard" },
                    { id: "fast", label: "Fast", isDefault: true },
                  ],
                },
              ],
            },
          },
        ],
      },
      {
        instanceId: "disabled",
        driver: "codex",
        displayName: "Disabled account",
        enabled: false,
        installed: true,
        status: "disabled",
        models: [{ slug: "hidden", name: "Hidden", capabilities: null }],
      },
    ],
  };
}

function project(defaultModelSelection: T3Project["defaultModelSelection"] = {
  instanceId: "codex",
  model: "gpt-5.6-sol",
}): T3Project {
  return {
    id: "project-1",
    title: "Even Realities",
    workspaceRoot: "/private/repository/path",
    defaultModelSelection,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
  };
}

describe("HttpT3Client session creation", () => {
  it("uses full access on both new-session creation commands", async () => {
    const commands: Record<string, unknown>[] = [];
    const baseUrl = await startUpstream(async (request, response) => {
      assert.equal(request.headers.authorization, `Bearer ${T3_ACCESS_TOKEN}`);
      commands.push(await readBody(request));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ sequence: commands.length }));
    });
    const client = new HttpT3Client(config(baseUrl));
    await client.startSession({ project: project(), threadId: "assistant", text: "Explicit draft",
      runtimeMode: "full-access", selection: { instanceId: "codex", model: "gpt-5.6-sol", reasoningId: "medium" } });
    assert.deepEqual(commands.map((command) => [command.type, command.runtimeMode]),
      [["thread.create", "full-access"], ["thread.turn.start", "full-access"]]);
    assert.equal(commands.every((command) => command.interactionMode === "default"), true);
  });

  it("creates the thread before it starts the first turn", async () => {
    const commands: Record<string, unknown>[] = [];
    const baseUrl = await startUpstream(async (request, response) => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/api/orchestration/dispatch");
      assert.equal(request.headers.authorization, `Bearer ${T3_ACCESS_TOKEN}`);
      commands.push(await readBody(request));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ sequence: commands.length + 40 }));
    });

    const client = new HttpT3Client(config(baseUrl));
    const result = await client.startSession({
      project: project(),
      threadId: "thread-1",
      text: "First line\nmore context",
      runtimeMode: "approval-required",
    });

    assert.equal(result.sequence, 42);
    assert.equal(commands.length, 2);
    assert.deepEqual(
      commands.map((command) => command.type),
      ["thread.create", "thread.turn.start"],
    );
    assert.deepEqual(commands[0], {
      type: "thread.create",
      commandId: commands[0]!.commandId,
      threadId: "thread-1",
      projectId: "project-1",
      title: "First line",
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
        options: [
          { id: "reasoningEffort", value: "medium" },
          { id: "serviceTier", value: "default" },
        ],
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: commands[0]!.createdAt,
    });
    assert.deepEqual(commands[1], {
      type: "thread.turn.start",
      commandId: commands[1]!.commandId,
      threadId: "thread-1",
      message: {
        messageId: (commands[1]!.message as Record<string, unknown>).messageId,
        role: "user",
        text: "First line\nmore context",
        attachments: [],
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: commands[1]!.createdAt,
    });
    assert.equal(commands[0]!.createdAt, commands[1]!.createdAt);
    assert.equal("bootstrap" in commands[1]!, false);
  });

  it("does not start a turn when thread creation is rejected", async () => {
    let requestCount = 0;
    const baseUrl = await startUpstream(async (_request, response) => {
      requestCount += 1;
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ error: `internal failure using Bearer ${T3_ACCESS_TOKEN}` }),
      );
    });

    const client = new HttpT3Client(config(baseUrl));
    await assert.rejects(
      client.startSession({
        project: project(),
        threadId: "thread-1",
        text: "Do not dispatch this turn",
        runtimeMode: "approval-required",
      }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, "upstream_operation_failed");
        assert.equal(error.message, "T3 Code rejected the operation");
        assert.equal(error.message.includes(T3_ACCESS_TOKEN), false);
        return true;
      },
    );
    assert.equal(requestCount, 1);
  });

  it("returns a safe error when the first turn is rejected after creation", async () => {
    const commandTypes: unknown[] = [];
    const baseUrl = await startUpstream(async (request, response) => {
      const command = await readBody(request);
      commandTypes.push(command.type);
      if (command.type === "thread.create") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ sequence: 41 }));
        return;
      }
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ error: `internal failure using Bearer ${T3_ACCESS_TOKEN}` }),
      );
    });

    const client = new HttpT3Client(config(baseUrl));
    await assert.rejects(
      client.startSession({
        project: project(),
        threadId: "thread-1",
        text: "Start this turn",
        runtimeMode: "approval-required",
      }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, "upstream_operation_failed");
        assert.equal(error.message, "T3 Code rejected the operation");
        assert.equal(error.message.includes(T3_ACCESS_TOKEN), false);
        return true;
      },
    );
    assert.deepEqual(commandTypes, ["thread.create", "thread.turn.start"]);
  });

  it("rejects projects without a default model before any upstream write", async () => {
    let requestCount = 0;
    const baseUrl = await startUpstream(async (_request, response) => {
      requestCount += 1;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ sequence: 1 }));
    });

    const client = new HttpT3Client(config(baseUrl));
    await assert.rejects(
      client.startSession({
        project: project(null),
        threadId: "thread-1",
        text: "Cannot run",
        runtimeMode: "approval-required",
      }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, "project_model_required");
        return true;
      },
    );
    assert.equal(requestCount, 0);
  });
});

describe("HttpT3Client same-turn steering", () => {
  it("submits plan answers with the exact installed T3 command and no mode/permission fields", async () => {
    let command: Record<string, unknown> | undefined;
    const baseUrl = await startUpstream(async (request, response) => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/api/orchestration/dispatch");
      assert.equal(request.headers.authorization, `Bearer ${T3_ACCESS_TOKEN}`);
      command = await readBody(request);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ sequence: 74 }));
    });
    const answers = { "Which approach?": "Small", features: ["A", "B"] };
    assert.deepEqual(await new HttpT3Client(config(baseUrl)).respondToPlanInput({
      threadId: "thread-1", requestId: "request-1", commandId: "even-plan-fixture", answers,
    }), { sequence: 74 });
    assert.deepEqual(command, { type: "thread.user-input.respond", commandId: "even-plan-fixture",
      threadId: "thread-1", requestId: "request-1", answers, createdAt: command!.createdAt });
  });
  it("settles through the authenticated native command without changing runtime permissions", async () => {
    let command: Record<string, unknown> | undefined;
    const baseUrl = await startUpstream(async (request, response) => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/api/orchestration/dispatch");
      assert.equal(request.headers.authorization, `Bearer ${T3_ACCESS_TOKEN}`);
      command = await readBody(request);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ sequence: 75 }));
    });
    assert.deepEqual(await new HttpT3Client(config(baseUrl)).settleThread("thread-1"), { sequence: 75 });
    assert.match(String(command!.commandId), /^[0-9a-f-]{36}$/);
    assert.deepEqual(command, { type: "thread.settle", commandId: command!.commandId, threadId: "thread-1" });
  });

  it("keeps native settlement failures private and does not retry a rejected mutation", async () => {
    let calls = 0;
    const baseUrl = await startUpstream(async (_request, response) => {
      calls += 1;
      response.writeHead(409, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "private pending approval details" }));
    });
    await assert.rejects(new HttpT3Client(config(baseUrl)).settleThread("thread-1"),
      (error: unknown) => error instanceof ApiError && error.code === "upstream_operation_failed" &&
        !error.message.includes("private"));
    assert.equal(calls, 1);
  });

  it("dispatches a user message through T3's active-turn command", async () => {
    let command: Record<string, unknown> | undefined;
    const baseUrl = await startUpstream(async (request, response) => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/api/orchestration/dispatch");
      assert.equal(request.headers.authorization, `Bearer ${T3_ACCESS_TOKEN}`);
      command = await readBody(request);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ sequence: 73 }));
    });
    const activeThread = {
      id: "thread-1",
      projectId: "project-1",
      title: "Active thread",
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
      runtimeMode: "approval-required" as const,
      interactionMode: "default" as const,
      createdAt: "2026-09-04T10:00:00.000Z",
      updatedAt: "2026-09-04T10:01:00.000Z",
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      latestTurn: null,
      session: {
        status: "running",
        activeTurnId: "turn-1",
        updatedAt: "2026-09-04T10:01:00.000Z",
      },
    };

    const result = await new HttpT3Client(config(baseUrl)).steerMessage({
      thread: activeThread,
      text: "Use the smaller implementation",
    });

    assert.deepEqual(result, { sequence: 73 });
    assert.deepEqual(command, {
      type: "thread.turn.start",
      commandId: command!.commandId,
      threadId: "thread-1",
      message: {
        messageId: (command!.message as Record<string, unknown>).messageId,
        role: "user",
        text: "Use the smaller implementation",
        attachments: [],
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: command!.createdAt,
    });
  });
});

describe("HttpT3Client model catalog", () => {
  it("returns only usable providers and normalizes model-specific reasoning", async () => {
    let wireRequest: Record<string, unknown> | undefined;
    const upstream = providerConfig();
    const providers = upstream.providers as Record<string, unknown>[];
    providers.push({
      instanceId: "claude-work",
      driver: "claudeAgent",
      displayName: "Claude Work",
      enabled: true,
      installed: true,
      status: "warning",
      auth: { status: "unknown" },
      models: [
        {
          slug: "claude-sonnet-5",
          name: "Claude Sonnet 5",
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Reasoning",
                type: "select",
                options: [
                  { id: "low", label: "Low" },
                  { id: "high", label: "High", isDefault: true },
                ],
              },
              { id: "fastMode", label: "Fast Mode", type: "boolean" },
            ],
          },
        },
      ],
    });
    const baseUrl = await startUpstream(async (_request, response) => {
      response.writeHead(404).end();
    }, (request) => {
      wireRequest = request;
      return upstream;
    });

    const catalog = await new HttpT3Client(config(baseUrl)).modelCatalog();

    assert.deepEqual(wireRequest, {
      _tag: "Request",
      id: wireRequest!.id,
      tag: "server.getConfig",
      payload: {},
      headers: [],
    });
    assert.deepEqual(catalog, {
      providers: [
        {
          instanceId: "codex",
          label: "Codex Personal",
          models: [
            {
              slug: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              isDefault: true,
              reasoning: {
                id: "reasoning",
                t3OptionId: "reasoningEffort",
                defaultChoiceId: "medium",
                choices: [
                  { id: "low", label: "Low", isDefault: false },
                  { id: "medium", label: "Medium", isDefault: true },
                  { id: "high", label: "High", isDefault: false },
                ],
              },
            },
          ],
        },
        {
          instanceId: "claude-work",
          label: "Claude Work",
          models: [
            {
              slug: "claude-sonnet-5",
              name: "Claude Sonnet 5",
              isDefault: false,
              reasoning: {
                id: "reasoning",
                t3OptionId: "effort",
                defaultChoiceId: "high",
                choices: [
                  { id: "low", label: "Low", isDefault: false },
                  { id: "high", label: "High", isDefault: true },
                ],
              },
            },
          ],
        },
      ],
    });
    const serialized = JSON.stringify(catalog);
    assert.equal(serialized.includes("private@example.com"), false);
    assert.equal(serialized.includes("must-not-escape"), false);
    assert.equal(serialized.includes("private provider detail"), false);
    assert.equal(serialized.includes(T3_ACCESS_TOKEN), false);
  });

  it("rejects malformed config responses without exposing their contents", async () => {
    const secret = "upstream-private-malformed-value";
    const baseUrl = await startUpstream(async (_request, response) => {
      response.writeHead(404).end();
    }, () => ({
      providers: [
        {
          enabled: true,
          installed: true,
          status: "ready",
          auth: { status: "authenticated" },
          secret,
        },
      ],
    }));

    await assert.rejects(
      new HttpT3Client(config(baseUrl)).modelCatalog(),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, "upstream_invalid_response");
        assert.equal(error.message.includes(secret), false);
        assert.equal(error.message.includes(T3_ACCESS_TOKEN), false);
        return true;
      },
    );
  });

  it("times out a server that does not answer the RPC request", async () => {
    const baseUrl = await startUpstream(async (_request, response) => {
      response.writeHead(404).end();
    }, null);

    await assert.rejects(
      new HttpT3Client(config(baseUrl, { upstreamTimeoutMs: 30 })).modelCatalog(),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, "upstream_timeout");
        assert.equal(error.message.includes(T3_ACCESS_TOKEN), false);
        return true;
      },
    );
  });

  it("rejects an oversized RPC response", async () => {
    const baseUrl = await startUpstream(async (_request, response) => {
      response.writeHead(404).end();
    }, () => ({ providers: [], padding: "x".repeat(2048) }));

    await assert.rejects(
      new HttpT3Client(config(baseUrl, { maxUpstreamBytes: 512 })).modelCatalog(),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, "upstream_invalid_response");
        return true;
      },
    );
  });
});

describe("HttpT3Client selected model validation", () => {
  it("uses Claude's real option id and explicitly disables fast mode", async () => {
    const commands: Record<string, unknown>[] = [];
    const upstream = providerConfig();
    upstream.providers = [
      {
        instanceId: "claude-work",
        driver: "claudeAgent",
        displayName: "Claude Work",
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        models: [
          {
            slug: "claude-sonnet-5",
            name: "Claude Sonnet 5",
            capabilities: {
              optionDescriptors: [
                {
                  id: "effort",
                  type: "select",
                  options: [
                    { id: "low", label: "Low" },
                    { id: "high", label: "High", isDefault: true },
                  ],
                },
                { id: "fastMode", type: "boolean" },
              ],
            },
          },
        ],
      },
    ];
    const baseUrl = await startUpstream(async (request, response) => {
      commands.push(await readBody(request));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ sequence: commands.length }));
    }, () => upstream);

    await new HttpT3Client(config(baseUrl)).startSession({
      project: project(null),
      threadId: "thread-claude",
      text: "Use Claude",
      runtimeMode: "approval-required",
      selection: {
        instanceId: "claude-work",
        model: "claude-sonnet-5",
        reasoningId: "low",
      },
    });

    assert.deepEqual(commands[0]!.modelSelection, {
      instanceId: "claude-work",
      model: "claude-sonnet-5",
      options: [
        { id: "effort", value: "low" },
        { id: "fastMode", value: false },
      ],
    });
  });

  it("rejects unadvertised model and reasoning selections before any write", async () => {
    let dispatchCount = 0;
    const baseUrl = await startUpstream(async (_request, response) => {
      dispatchCount += 1;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ sequence: dispatchCount }));
    });
    const client = new HttpT3Client(config(baseUrl));

    for (const runtimeMode of ["approval-required", "full-access"] as const) {
      await assert.rejects(
        client.startSession({
          project: project(),
          threadId: "thread-bad-provider",
          text: "No write",
          runtimeMode,
          selection: { instanceId: "not-advertised", model: "gpt-5.6-sol" },
        }),
        (error: unknown) =>
          error instanceof ApiError && error.code === "provider_selection_unavailable",
      );
      await assert.rejects(
        client.startSession({
          project: project(),
          threadId: "thread-bad-model",
          text: "No write",
          runtimeMode,
          selection: { instanceId: "codex", model: "not-advertised" },
        }),
        (error: unknown) => error instanceof ApiError && error.code === "model_selection_unavailable",
      );
      await assert.rejects(
        client.startSession({
          project: project(),
          threadId: "thread-bad-reasoning",
          text: "No write",
          runtimeMode,
          selection: {
            instanceId: "codex",
            model: "gpt-5.6-sol",
            reasoningId: "ultra-secret-level",
          },
        }),
        (error: unknown) => error instanceof ApiError && error.code === "reasoning_selection_unavailable",
      );
    }
    assert.equal(dispatchCount, 0);
  });
});

describe("HttpT3Client archive pagination", () => {
  it("encodes opaque cursors as data and retains authenticated bounded requests", async () => {
    const baseUrl = await startUpstream(async (request, response) => {
      assert.equal(request.headers.authorization, `Bearer ${T3_ACCESS_TOKEN}`);
      const url = new URL(request.url!, "http://upstream.invalid");
      assert.equal(url.pathname, "/api/orchestration/threads/thread-1");
      assert.equal(url.searchParams.get("turnLimit"), "100");
      assert.equal(url.searchParams.get("beforeCursor"), "opaque&injected=value/?");
      assert.equal(url.searchParams.has("injected"), false);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ snapshotSequence: 5, thread: { id: "thread-1", projectId: "assistant", messages: [] }, page: { hasMore: false, beforeCursor: null, snapshotSequence: 5 } }));
    });
    const result = await new HttpT3Client(config(baseUrl)).threadPage("thread-1", "opaque&injected=value/?");
    assert.equal(result.page?.hasMore, false);
  });
  it("refuses unpaged snapshots rather than treating bounded output as full history", async () => {
    const baseUrl = await startUpstream(async (_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ snapshotSequence: 5, thread: { id: "thread-1", messages: [] } }));
    });
    await assert.rejects(() => new HttpT3Client(config(baseUrl)).threadPage("thread-1"), /pagination is unavailable/);
  });
});

describe("HttpT3Client session controls installed contract", () => {
  const thread = { id: "thread-1", projectId: "project-1", title: "Fixture", runtimeMode: "approval-required" as const,
    interactionMode: "default" as const, modelSelection: { instanceId: "codex", model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "medium" }, { id: "serviceTier", value: "fast" }, { id: "other", value: true }] },
    createdAt: "2026-09-04T10:00:00.000Z", updatedAt: "2026-09-04T10:00:00.000Z", archivedAt: null,
    settledOverride: null, settledAt: null, latestTurn: null, session: null };
  it("persists selected mode before starting the draft with unchanged runtime permissions", async () => {
    const commands: Record<string, unknown>[] = [];
    const base = await startUpstream(async (request, response) => {
      assert.equal(request.headers.authorization, `Bearer ${T3_ACCESS_TOKEN}`);
      commands.push(await readBody(request)); response.writeHead(200); response.end(JSON.stringify({ sequence: commands.length }));
    });
    await new HttpT3Client(config(base)).sendMessage({ thread, text: "Plan the change", interactionMode: "plan" });
    assert.deepEqual(commands.map(c => c.type), ["thread.interaction-mode.set", "thread.turn.start"]);
    assert.equal(commands[0]!.interactionMode, "plan");
    assert.equal(commands[1]!.runtimeMode, "approval-required");
    assert.equal(commands[1]!.interactionMode, "plan");
    assert.equal("runtimeMode" in commands[0]!, false);
  });
  it("stops after rejected mode changes and does not retry failed turn starts", async () => {
    for (const failureIndex of [1, 2]) {
      const commands: Record<string, unknown>[] = [];
      const base = await startUpstream(async (request, response) => {
        commands.push(await readBody(request)); response.writeHead(commands.length === failureIndex ? 500 : 200);
        response.end(JSON.stringify({ sequence: commands.length, error: "private failure" }));
      });
      await assert.rejects(new HttpT3Client(config(base)).sendMessage({ thread, text: "Reviewed draft", interactionMode: "plan" }), { code: "upstream_operation_failed" });
      assert.equal(commands.length, failureIndex);
    }
  });
  it("validates reasoning against fresh catalog and preserves every unrelated model option", async () => {
    const commands: Record<string, unknown>[] = []; let catalogs = 0;
    const base = await startUpstream(async (request, response) => {
      if (request.method === "GET") {
        response.writeHead(200); response.end(JSON.stringify({ snapshotSequence: 1, thread: { ...thread, messages: [] } })); return;
      }
      commands.push(await readBody(request)); response.writeHead(200); response.end(JSON.stringify({ sequence: 2 }));
    }, () => { catalogs++; return providerConfig(); });
    const client = new HttpT3Client(config(base));
    await client.setReasoning({ thread, reasoningId: "high" });
    assert.equal(commands[0]!.type, "thread.meta.update");
    assert.deepEqual(commands[0]!.modelSelection, { ...thread.modelSelection, options: [
      { id: "serviceTier", value: "fast" }, { id: "other", value: true }, { id: "reasoningEffort", value: "high" }] });
    assert.equal("runtimeMode" in commands[0]!, false);
    await assert.rejects(client.setReasoning({ thread, reasoningId: "invented" }), { code: "reasoning_selection_unavailable" });
    assert.equal(catalogs, 2); assert.equal(commands.length, 1);
  });
  it("refuses a model or active-turn change during reasoning catalog lookup", async () => {
    for (const changed of [{ ...thread, modelSelection: { ...thread.modelSelection, model: "changed" } },
      { ...thread, session: { status: "running", activeTurnId: "active", updatedAt: thread.updatedAt } }]) {
      let writes = 0;
      const base = await startUpstream(async (request, response) => {
        if (request.method === "POST") writes++;
        response.writeHead(200); response.end(JSON.stringify({ snapshotSequence: 1, thread: { ...changed, messages: [] } }));
      });
      await assert.rejects(new HttpT3Client(config(base)).setReasoning({ thread, reasoningId: "high" }));
      assert.equal(writes, 0);
    }
  });
  it("approves via the exact proposed-plan source reference and stable command IDs", async () => {
    const commands: Record<string, unknown>[] = [];
    const base = await startUpstream(async (request, response) => {
      commands.push(await readBody(request)); response.writeHead(200); response.end(JSON.stringify({ sequence: commands.length }));
    });
    await new HttpT3Client(config(base)).approvePlan({ thread: { ...thread, interactionMode: "plan" }, planId: "plan-1", planMarkdown: "Exact reviewed text", commandId: "even-implement-fixture" });
    assert.deepEqual(commands.map(c => c.type), ["thread.interaction-mode.set", "thread.turn.start"]);
    assert.equal(commands[0]!.commandId, "even-implement-fixture-mode");
    assert.equal(commands[1]!.commandId, "even-implement-fixture");
    assert.deepEqual(commands[1]!.sourceProposedPlan, { threadId: thread.id, planId: "plan-1" });
    assert.equal(commands[1]!.runtimeMode, "approval-required");
    assert.equal(commands[1]!.interactionMode, "default");
    assert.equal((commands[1]!.message as Record<string, unknown>).text, "Implement this plan:\n\nExact reviewed text");
  });
});
