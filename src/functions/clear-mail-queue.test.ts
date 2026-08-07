// Tests for the opt-in app-start purge. All HTTP and identity boundaries are local mocks.
jest.mock("@azure/functions", () => ({
  app: { hook: { appStart: jest.fn() } },
  output: { storageQueue: jest.fn(() => ({})) },
}));
jest.mock("@azure/identity", () => ({ DefaultAzureCredential: jest.fn() }));

import { app } from "@azure/functions";
import { DefaultAzureCredential } from "@azure/identity";
import axios, { AxiosInstance } from "axios";
import MockAdapter from "axios-mock-adapter";
import {
  clearMailQueue,
  clearMailQueueOnStartup,
  createQueueStorageClient,
} from "./clear-mail-queue";
import { attachRetryInterceptor } from "./http-retry";
import { STORAGE_API_VERSION, STORAGE_SCOPE } from "./storage-client";

const ENV_KEYS = [
  "MAIL_QUEUE_CLEAR_ON_STARTUP",
  "AzureWebJobsStorage__queueServiceUri",
  "AzureWebJobsStorage__accountName",
  "AzureWebJobsStorage__clientId",
  "MANAGED_IDENTITY_CLIENT_ID",
] as const;

function client(): { instance: AxiosInstance; mock: MockAdapter } {
  const instance = axios.create();
  return { instance, mock: new MockAdapter(instance) };
}

describe("startup registration", () => {
  it("registers one awaited app-start hook", async () => {
    delete process.env.MAIL_QUEUE_CLEAR_ON_STARTUP;
    (app.hook.appStart as jest.Mock).mockClear();
    jest.isolateModules(() => require("./clear-mail-queue"));

    expect(app.hook.appStart).toHaveBeenCalledTimes(1);
    expect(app.hook.appStart).toHaveBeenCalledWith(expect.any(Function));
    const handler = (app.hook.appStart as jest.Mock).mock.calls[0][0];
    const pending = handler();
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).resolves.toBeUndefined();
  });
});

describe("clearMailQueueOnStartup", () => {
  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it("does no authentication or I/O when the switch is unset", async () => {
    const createClient = jest.fn();
    const log = { info: jest.fn(), error: jest.fn() };

    await clearMailQueueOnStartup({ createClient, log });

    expect(createClient).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("clears the primary queue and logs success when enabled", async () => {
    process.env.MAIL_QUEUE_CLEAR_ON_STARTUP = "true";
    const { instance, mock } = client();
    const log = { info: jest.fn(), error: jest.fn() };
    mock.onDelete("/mail-notifications/messages").reply(204);

    await clearMailQueueOnStartup({ createClient: async () => instance, log });

    expect(mock.history.delete).toHaveLength(1);
    expect(mock.history.delete[0].url).toBe("/mail-notifications/messages");
    expect(mock.history.delete[0].url).not.toContain("poison");
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("clear complete"),
      { queue: "mail-notifications", result: "cleared" }
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it("logs and rethrows a clear failure so startup fails closed", async () => {
    process.env.MAIL_QUEUE_CLEAR_ON_STARTUP = "true";
    const { instance, mock } = client();
    attachRetryInterceptor(instance, {
      apiName: "Azure Queue Storage",
      maxRetries: 0,
    });
    const log = { info: jest.fn(), error: jest.fn() };
    mock.onDelete("/mail-notifications/messages").reply(403, { error: "forbidden" });

    await expect(
      clearMailQueueOnStartup({ createClient: async () => instance, log })
    ).rejects.toBeTruthy();

    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("Azure Queue Storage"),
      expect.objectContaining({
        queue: "mail-notifications",
        error: expect.objectContaining({ api: "Azure Queue Storage", status: 403 }),
      })
    );
  });
});

describe("clearMailQueue", () => {
  it("treats only QueueNotFound as already clear", async () => {
    const missing = client();
    missing.mock
      .onDelete("/mail-notifications/messages")
      .reply(404, "<Error><Code>QueueNotFound</Code></Error>");
    await expect(clearMailQueue(missing.instance)).resolves.toBe("not-found");

    const wrongEndpoint = client();
    wrongEndpoint.mock
      .onDelete("/mail-notifications/messages")
      .reply(404, "<Error><Code>ResourceNotFound</Code></Error>");
    await expect(clearMailQueue(wrongEndpoint.instance)).rejects.toBeTruthy();
  });

  it("leaves OperationTimedOut retry to the next bounded worker startup", async () => {
    const { instance, mock } = client();
    mock
      .onDelete("/mail-notifications/messages")
      .reply(500, "<Error><Code>OperationTimedOut</Code></Error>");

    await expect(clearMailQueue(instance)).rejects.toBeTruthy();
    expect(mock.history.delete).toHaveLength(1);
  });
});

describe("createQueueStorageClient", () => {
  const getToken = jest.fn();

  beforeEach(() => {
    process.env.AzureWebJobsStorage__queueServiceUri = "https://explicit.queue.example/";
    process.env.AzureWebJobsStorage__accountName = "fallbackaccount";
    process.env.AzureWebJobsStorage__clientId = "queue-uami";
    process.env.MANAGED_IDENTITY_CLIENT_ID = "fallback-uami";
    getToken.mockResolvedValue({ token: "queue-token" });
    (DefaultAzureCredential as unknown as jest.Mock).mockImplementation(() => ({ getToken }));
  });

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it("uses the explicit queue endpoint, storage identity, token, and required headers", async () => {
    const raw = axios.create();
    const mock = new MockAdapter(raw);
    const createSpy = jest.spyOn(axios, "create").mockReturnValue(raw);
    mock.onDelete("/mail-notifications/messages").reply(204);

    const instance = await createQueueStorageClient();
    await clearMailQueue(instance);

    expect(DefaultAzureCredential).toHaveBeenCalledWith({
      managedIdentityClientId: "queue-uami",
    });
    expect(getToken).toHaveBeenCalledWith(
      STORAGE_SCOPE,
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) })
    );
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://explicit.queue.example",
        headers: expect.objectContaining({
          Authorization: "Bearer queue-token",
          "x-ms-version": STORAGE_API_VERSION,
        }),
      })
    );
    const headers = mock.history.delete[0].headers;
    expect((headers as any)?.get("x-ms-date")).toBeTruthy();
  });

  it("does not extend the startup budget with HTTP retries", async () => {
    const raw = axios.create();
    const mock = new MockAdapter(raw);
    jest.spyOn(axios, "create").mockReturnValue(raw);
    mock.onDelete("/mail-notifications/messages").reply(503);

    const instance = await createQueueStorageClient();

    await expect(clearMailQueue(instance)).rejects.toBeTruthy();
    expect(mock.history.delete).toHaveLength(1);
  });

  it("falls back to the account-derived endpoint and app identity", async () => {
    delete process.env.AzureWebJobsStorage__queueServiceUri;
    delete process.env.AzureWebJobsStorage__clientId;
    const raw = axios.create();
    jest.spyOn(axios, "create").mockReturnValue(raw);

    await createQueueStorageClient();

    expect(DefaultAzureCredential).toHaveBeenCalledWith({
      managedIdentityClientId: "fallback-uami",
    });
    expect(axios.create).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://fallbackaccount.queue.core.windows.net",
      })
    );
  });

  it("falls back to the app identity when the storage client ID is empty", async () => {
    process.env.AzureWebJobsStorage__clientId = "  ";
    const raw = axios.create();
    jest.spyOn(axios, "create").mockReturnValue(raw);

    await createQueueStorageClient();

    expect(DefaultAzureCredential).toHaveBeenCalledWith({
      managedIdentityClientId: "fallback-uami",
    });
  });

  it("fails clearly when queue storage is not configured", async () => {
    delete process.env.AzureWebJobsStorage__queueServiceUri;
    delete process.env.AzureWebJobsStorage__accountName;

    await expect(createQueueStorageClient()).rejects.toThrow("queue storage not configured");
  });
});
