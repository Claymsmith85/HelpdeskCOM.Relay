// Workflow tests for the queue worker (process-mail.ts).
//
// What these lock in:
//   - ignored senders are skipped (no ticket) and finalized by move or no-move claim
//   - the new-ticket happy path: create ticket (real requester + routed team) SILENTLY — no
//     "ticket created" notice is sent to the requester — then move to processed
//   - the existing-ticket path uploads attachments and appends folder + filenames
//   - oversize attachments: no upload, agent System note, reply ack still sent
//   - idempotency: a 404 on getMessage (message already moved) short-circuits
//
// Mocking strategy:
//   - @azure/functions: no-op registry (worker registers app.storageQueue at import)
//   - ./graph-client: createGraphClient -> dummy graph; graphConfigFromEnv -> {}
//   - ./graph-mail: real parseGraphMessage/buildOversizeCommentText (requireActual), the
//     I/O fns (getMessage / listMessageAttachments / sendMailViaGraph / move / resolve) mocked
//   - ./sharepoint: uploadAttachmentsToSharePoint mocked
//   - axios.create is spied to return one Helpdesk instance wired to axios-mock-adapter

jest.mock("@azure/functions", () => ({
  app: { http: jest.fn(), setup: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() },
  output: { storageQueue: jest.fn(() => ({})) },
}));
jest.mock("./graph-client", () => ({
  createGraphClientFromEnv: jest.fn().mockResolvedValue({ id: "graph" }),
  graphConfigFromEnv: jest.fn().mockReturnValue({}),
}));
jest.mock("./graph-mail", () => ({
  ...jest.requireActual("./graph-mail"),
  getMessage: jest.fn(),
  listInboxMessageIds: jest.fn(),
  listFolderMessageIds: jest.fn(),
  listMessageAttachments: jest.fn(),
  fetchAttachmentBytes: jest.fn(),
  resolveMailboxAddress: jest.fn(),
  sendMailViaGraph: jest.fn().mockResolvedValue(undefined),
  // Return distinct ids per folder so tests can prove the reprocess listing is keyed off the
  // Reprocess folder (not the inbox/processed folder).
  ensureMailFolder: jest
    .fn()
    .mockImplementation((_g: any, _mb: any, name: string) =>
      Promise.resolve(name === "Reprocess" ? "reprocess-folder-id" : "processed-folder-id")
    ),
  moveMessageToFolder: jest.fn().mockResolvedValue(undefined),
  sendDebugEmail: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("./sharepoint", () => ({
  uploadAttachmentsToSharePoint: jest.fn().mockResolvedValue(null),
}));
// Per-mailbox drain lock: default to a no-op acquired lock so the existing workflow tests drain as
// before. The lock's own behavior (acquire/contention/release/renew) is covered in
// drain-lock.test.ts; the contention/deferral path in process-mail is covered by its own test below.
jest.mock("./drain-lock", () => ({
  acquireDrainLock: jest
    .fn()
    .mockResolvedValue({ mailbox: "MB-GUID", lost: false, release: jest.fn().mockResolvedValue(undefined) }),
}));
// Per-message no-move claims: mocked at the module boundary so worker tests can exercise the
// claim-first control flow without talking to Azure Storage. mail-claims.test.ts owns the REST
// details; these tests own ordering and workflow effects.
jest.mock("./mail-claims", () => ({
  buildMailClaimsClient: jest.fn().mockResolvedValue({ id: "claims" }),
  messageClaimBlobName: jest.fn((mailbox: string, id: string) => `claim:${mailbox}:${id}`),
  isMessageClaimed: jest.fn().mockResolvedValue(false),
  claimMessage: jest.fn().mockResolvedValue(true),
  releaseMessageClaim: jest.fn().mockResolvedValue(undefined),
}));

import axios, { AxiosInstance } from "axios";
import MockAdapter from "axios-mock-adapter";
import { createGraphClientFromEnv } from "./graph-client";
import { processMail } from "./process-mail";
import {
  getMessage,
  listInboxMessageIds,
  listFolderMessageIds,
  listMessageAttachments,
  resolveMailboxAddress,
  sendMailViaGraph,
  sendDebugEmail,
  ensureMailFolder,
  moveMessageToFolder,
  type AttachmentInfo,
  type GraphMessage,
} from "./graph-mail";
import { uploadAttachmentsToSharePoint } from "./sharepoint";
import { acquireDrainLock } from "./drain-lock";
import {
  buildMailClaimsClient,
  claimMessage,
  isMessageClaimed,
  releaseMessageClaim,
} from "./mail-claims";

const TEAM_ESCAPE = "3db812da-2055-436f-9889-7073b5e976f4";
const MAILBOX = "MB-GUID";

let helpdeskInstance: AxiosInstance;
let hdMock: MockAdapter;
let createSpy: jest.SpyInstance;

function graphMsg(over: Partial<GraphMessage> = {}): GraphMessage {
  return {
    id: "M1",
    subject: "Need help",
    from: { emailAddress: { name: "John Doe", address: "john@example.com" } },
    toRecipients: [{ emailAddress: { address: "escape@corespecialty.com" } }],
    body: { contentType: "text", content: "Hello there\n> quoted reply line" },
    hasAttachments: false,
    ...over,
  };
}

function att(name: string, size: number): AttachmentInfo {
  return { id: `id-${name}`, name, size, contentType: "application/pdf", isInline: false };
}

function fakeContext() {
  return {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(), // stepError routes here -> lets a test assert error-severity logging
    functionName: "process-mail",
    invocationId: "test-inv",
    extraOutputs: { set: jest.fn() },
  } as any;
}

beforeEach(() => {
  process.env.HELPDESK_PAT = "pat-token";
  // Avoid pacing sleeps and keep the suite's real-backoff case on its legacy retry ladder.
  process.env.HELPDESK_RATE_LIMIT_RPS = "100000";
  process.env.HELPDESK_RETRY_MAX_RETRIES = "3";
  process.env.HELPDESK_RETRY_MAX_DELAY_MS = "20000";
  // Every new switch is default OFF. Most workflow tests exercise the fully-enabled inbound path;
  // the independent disabled combinations are covered in their own cases below.
  process.env.MAILBOX_DRAIN = "true";
  process.env.TICKET_CREATE = "true";
  process.env.SUBMITTER_REPLIES = "true";
  delete process.env.SEND_DEBUG_EMAIL;

  (getMessage as jest.Mock).mockResolvedValue(graphMsg());
  // Default: the inbox holds exactly the notified message, so each existing single-message
  // assertion holds unchanged after the drain refactor.
  (listInboxMessageIds as jest.Mock).mockResolvedValue(["M1"]);
  // Default: the Reprocess folder is empty, so existing assertions are unaffected by the drain
  // also scanning it.
  (listFolderMessageIds as jest.Mock).mockResolvedValue([]);
  (listMessageAttachments as jest.Mock).mockResolvedValue([]);
  (resolveMailboxAddress as jest.Mock).mockResolvedValue("escape@corespecialty.com");
  (ensureMailFolder as jest.Mock).mockImplementation((_g: any, _mb: any, name: string) =>
    Promise.resolve(name === "Reprocess" ? "reprocess-folder-id" : "processed-folder-id")
  );
  (uploadAttachmentsToSharePoint as jest.Mock).mockResolvedValue(null);
  (buildMailClaimsClient as jest.Mock).mockResolvedValue({ id: "claims" });
  (isMessageClaimed as jest.Mock).mockResolvedValue(false);
  (claimMessage as jest.Mock).mockResolvedValue(true);
  (releaseMessageClaim as jest.Mock).mockResolvedValue(undefined);

  helpdeskInstance = axios.create();
  hdMock = new MockAdapter(helpdeskInstance);
  createSpy = jest.spyOn(axios, "create").mockReturnValue(helpdeskInstance);
});

afterEach(() => {
  hdMock.restore();
  createSpy.mockRestore();
  delete process.env.HELPDESK_PAT;
  delete process.env.HELPDESK_RATE_LIMIT_RPS;
  delete process.env.HELPDESK_RETRY_MAX_RETRIES;
  delete process.env.HELPDESK_RETRY_MAX_DELAY_MS;
  delete process.env.MAILBOX_DRAIN;
  delete process.env.TICKET_CREATE;
  delete process.env.SUBMITTER_REPLIES;
  delete process.env.AGENT_NOTICES;
  delete process.env.FOLLOWERS_NOTICES;
});

describe("MAILBOX_DRAIN (processed-folder move switch)", () => {
  it("does nothing when drain and ticket creation are both off — no lock or listing", async () => {
    process.env.MAILBOX_DRAIN = "false";
    process.env.TICKET_CREATE = "false";

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(createGraphClientFromEnv).not.toHaveBeenCalled();
    expect(acquireDrainLock).not.toHaveBeenCalled();
    expect(listInboxMessageIds).not.toHaveBeenCalled();
    expect(listFolderMessageIds).not.toHaveBeenCalled();
    expect(getMessage).not.toHaveBeenCalled();
    expect(ensureMailFolder).not.toHaveBeenCalled();
    expect(hdMock.history.post).toHaveLength(0);
    expect(sendMailViaGraph).not.toHaveBeenCalled();
    expect(moveMessageToFolder).not.toHaveBeenCalled(); // mail left untouched -> caught up on re-enable
    expect(buildMailClaimsClient).not.toHaveBeenCalled();
  });

  it("does nothing when both toggles are unset (default OFF)", async () => {
    delete process.env.MAILBOX_DRAIN;
    delete process.env.TICKET_CREATE;

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(createGraphClientFromEnv).not.toHaveBeenCalled();
    expect(acquireDrainLock).not.toHaveBeenCalled();
    expect(listInboxMessageIds).not.toHaveBeenCalled();
    expect(listFolderMessageIds).not.toHaveBeenCalled();
    expect(moveMessageToFolder).not.toHaveBeenCalled();
    expect(buildMailClaimsClient).not.toHaveBeenCalled();
  });

  it("tickets and acks once with drain off, then skips the same claimed message on re-drain", async () => {
    process.env.MAILBOX_DRAIN = "false";
    (isMessageClaimed as jest.Mock)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const existing = { ID: "EXIST1", shortID: "OLD1", subject: "Need help" };
    hdMock.onGet("/tickets").reply(200, [existing]);
    hdMock.onPatch("/tickets/EXIST1").reply(200, {});

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(hdMock.history.patch).toHaveLength(1); // existing ticket appended
    expect(sendMailViaGraph).toHaveBeenCalledTimes(1); // submitter ack still works
    expect(moveMessageToFolder).not.toHaveBeenCalled();
    expect(claimMessage).toHaveBeenCalledTimes(1);
    expect(claimMessage).toHaveBeenCalledWith(
      { id: "claims" },
      "claim:escape@corespecialty.com:M1",
      expect.any(String)
    );
    expect(acquireDrainLock).toHaveBeenCalledTimes(1);
    expect((acquireDrainLock as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (isMessageClaimed as jest.Mock).mock.invocationCallOrder[0]
    );
    expect((isMessageClaimed as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (getMessage as jest.Mock).mock.invocationCallOrder[0]
    );
    expect((sendMailViaGraph as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (claimMessage as jest.Mock).mock.invocationCallOrder[0]
    ); // the no-move marker is written only after the non-idempotent side effects

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(getMessage).toHaveBeenCalledTimes(1);
    expect(hdMock.history.patch).toHaveLength(1);
    expect(sendMailViaGraph).toHaveBeenCalledTimes(1);
    expect(claimMessage).toHaveBeenCalledTimes(1);
  });

  it("creates a new ticket with drain off, keeps the normal silent-create rule, and claims it", async () => {
    process.env.MAILBOX_DRAIN = "false";
    hdMock.onGet("/tickets").reply(200, []);
    hdMock.onPost("/tickets").reply(200, { ID: "NEW1" });

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(hdMock.history.post).toHaveLength(1);
    expect(sendMailViaGraph).not.toHaveBeenCalled();
    expect(moveMessageToFolder).not.toHaveBeenCalled();
    expect(claimMessage).toHaveBeenCalledTimes(1);
  });

  it("skips all fetch/ticket/ack work when a drain-off message is already claimed", async () => {
    process.env.MAILBOX_DRAIN = "false";
    (isMessageClaimed as jest.Mock).mockResolvedValue(true);

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(getMessage).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    expect(hdMock.history.get).toHaveLength(0);
    expect(hdMock.history.post).toHaveLength(0);
    expect(hdMock.history.patch).toHaveLength(0);
    expect(sendMailViaGraph).not.toHaveBeenCalled();
    expect(moveMessageToFolder).not.toHaveBeenCalled();
    expect(claimMessage).not.toHaveBeenCalled();
  });

  it("catches up a claimed message when drain turns on without repeating ticket work", async () => {
    (isMessageClaimed as jest.Mock).mockResolvedValue(true);

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(getMessage).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    expect(sendMailViaGraph).not.toHaveBeenCalled();
    expect(moveMessageToFolder).toHaveBeenCalledTimes(1);
    expect(releaseMessageClaim).toHaveBeenCalledWith(
      { id: "claims" },
      "claim:escape@corespecialty.com:M1"
    );
    expect((moveMessageToFolder as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (releaseMessageClaim as jest.Mock).mock.invocationCallOrder[0]
    );
  });

  it("keeps a catch-up claim when the processed-folder move fails", async () => {
    (isMessageClaimed as jest.Mock).mockResolvedValue(true);
    (moveMessageToFolder as jest.Mock).mockRejectedValueOnce({ response: { status: 500 } });
    const ctx = fakeContext();
    const errorSink = ctx.error;

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, ctx);

    expect(getMessage).not.toHaveBeenCalled();
    expect(releaseMessageClaim).not.toHaveBeenCalled();
    expect(errorSink).toHaveBeenCalledWith(
      expect.stringContaining("Move to processed FAILED"),
      expect.anything()
    );
  });

  it("warns but completes when a catch-up move succeeds and claim release fails", async () => {
    (isMessageClaimed as jest.Mock).mockResolvedValue(true);
    (releaseMessageClaim as jest.Mock).mockRejectedValueOnce(new Error("claim DELETE down"));
    const ctx = fakeContext();
    const warnSink = ctx.warn;

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, ctx);

    expect(moveMessageToFolder).toHaveBeenCalledTimes(1);
    expect(releaseMessageClaim).toHaveBeenCalledTimes(1);
    expect(warnSink).toHaveBeenCalledWith(
      expect.stringContaining("Message claim release failed"),
      expect.anything()
    );
  });

  it("keeps a catch-up claim when processed-folder resolution returns 404", async () => {
    (isMessageClaimed as jest.Mock).mockResolvedValue(true);
    (ensureMailFolder as jest.Mock).mockImplementation(
      (_g: any, _mb: any, name: string) =>
        name === "Reprocess"
          ? Promise.resolve("reprocess-folder-id")
          : Promise.reject({ response: { status: 404 } })
    );

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(moveMessageToFolder).not.toHaveBeenCalled();
    expect(getMessage).not.toHaveBeenCalled();
    expect(releaseMessageClaim).not.toHaveBeenCalled();
  });

  it("keeps a catch-up claim when move returns 404 but the source message still exists", async () => {
    (isMessageClaimed as jest.Mock).mockResolvedValue(true);
    (moveMessageToFolder as jest.Mock).mockRejectedValueOnce({ response: { status: 404 } });

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(getMessage).toHaveBeenCalledTimes(1); // ambiguous move 404 is verified
    expect(releaseMessageClaim).not.toHaveBeenCalled();
  });

  it("releases a catch-up claim only when a move 404 is verified by a missing source", async () => {
    (isMessageClaimed as jest.Mock).mockResolvedValue(true);
    (moveMessageToFolder as jest.Mock).mockRejectedValueOnce({ response: { status: 404 } });
    (getMessage as jest.Mock).mockRejectedValueOnce({ response: { status: 404 } });

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(getMessage).toHaveBeenCalledTimes(1);
    expect(releaseMessageClaim).toHaveBeenCalledTimes(1);
  });

  it("logs a claim-write failure after ticket work without throwing or moving", async () => {
    process.env.MAILBOX_DRAIN = "false";
    (claimMessage as jest.Mock).mockRejectedValueOnce(new Error("claim PUT down"));
    hdMock.onGet("/tickets").reply(200, []);
    hdMock.onPost("/tickets").reply(200, { ID: "NEW1" });
    const ctx = fakeContext();
    const errorSink = ctx.error;

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, ctx);

    expect(hdMock.history.post).toHaveLength(1);
    expect(moveMessageToFolder).not.toHaveBeenCalled();
    expect(errorSink).toHaveBeenCalledWith(
      expect.stringContaining("Message claim FAILED"),
      expect.anything()
    );
  });

  it("claims an ignored sender while drain is off without moving or ticketing it", async () => {
    process.env.MAILBOX_DRAIN = "false";
    (getMessage as jest.Mock).mockResolvedValue(
      graphMsg({ from: { emailAddress: { address: "bounce@helpdesk.com" } } })
    );

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(hdMock.history.get).toHaveLength(0);
    expect(hdMock.history.post).toHaveLength(0);
    expect(hdMock.history.patch).toHaveLength(0);
    expect(listMessageAttachments).not.toHaveBeenCalled();
    expect(sendMailViaGraph).not.toHaveBeenCalled();
    expect(moveMessageToFolder).not.toHaveBeenCalled();
    expect(claimMessage).toHaveBeenCalledTimes(1);
  });
});

describe("TICKET_CREATE (ticket automation switch)", () => {
  it("moves drained mail without any Helpdesk lookup/write, attachment work, or ack when off", async () => {
    process.env.TICKET_CREATE = "false";
    process.env.FOLLOWERS_NOTICES = "true";
    (getMessage as jest.Mock).mockResolvedValue(
      graphMsg({
        subject: "Re: Need help [#OLD1]",
        from: { emailAddress: { address: "follower@example.com" } },
      })
    );

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(createSpy).not.toHaveBeenCalled();
    expect(hdMock.history.get).toHaveLength(0); // includes no by-ref lookup despite the tag
    expect(hdMock.history.post).toHaveLength(0);
    expect(hdMock.history.patch).toHaveLength(0);
    expect(listMessageAttachments).not.toHaveBeenCalled();
    expect(sendMailViaGraph).not.toHaveBeenCalled();
    expect(moveMessageToFolder).toHaveBeenCalledTimes(1);
  });
});

describe("guard rails", () => {
  it("skips an ignored (loop) sender but still moves the message to processed", async () => {
    (getMessage as jest.Mock).mockResolvedValue(
      graphMsg({ from: { emailAddress: { address: "bounce@helpdesk.com" } } })
    );

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(hdMock.history.post).toHaveLength(0);
    expect(sendMailViaGraph).not.toHaveBeenCalled();
    expect(moveMessageToFolder).toHaveBeenCalledTimes(1);
  });

  it("short-circuits (idempotent) when getMessage 404s", async () => {
    (getMessage as jest.Mock).mockRejectedValue({ response: { status: 404 } });

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(hdMock.history.post).toHaveLength(0);
    expect(moveMessageToFolder).not.toHaveBeenCalled();
  });
});

describe("per-mailbox drain lock", () => {
  it("defers (re-enqueues, no drain) when another instance holds the mailbox lock", async () => {
    (acquireDrainLock as jest.Mock).mockResolvedValueOnce(null);
    const ctx = fakeContext();

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, ctx);

    // No drain work ran: no message fetched, no ticket created, nothing moved.
    expect(getMessage).not.toHaveBeenCalled();
    expect(hdMock.history.post).toHaveLength(0);
    expect(moveMessageToFolder).not.toHaveBeenCalled();
    // A fresh drain item was re-enqueued so the mailbox is retried after the holder releases.
    expect(ctx.extraOutputs.set).toHaveBeenCalledTimes(1);
    const enqueued = (ctx.extraOutputs.set as jest.Mock).mock.calls[0][1];
    expect(JSON.parse(enqueued[0])).toEqual({ mailbox: MAILBOX, messageId: "M1" });
  });

  it("locks on the canonical mailbox address so notify (GUID) and sweep (email) share one lock", async () => {
    hdMock.onGet("/tickets").reply(200, []);
    hdMock.onPost("/tickets").reply(200, { ID: "NEW1" });
    hdMock.onGet("/tickets/NEW1").reply(200, { shortID: "S1" });
    // resolveMailboxAddress is mocked to return escape@corespecialty.com for any input, mirroring
    // how a GUID (from notify) and an email (from sweep) both resolve to the same primary SMTP.
    await processMail({ mailbox: "MB-GUID", messageId: "M1" }, fakeContext());

    expect(acquireDrainLock as jest.Mock).toHaveBeenCalledWith(
      "escape@corespecialty.com",
      expect.anything()
    );
  });

  it("normalizes an alias-domain mailbox (sweep email) to the UPN lock key even when Graph can't resolve the alias", async () => {
    hdMock.onGet("/tickets").reply(200, []);
    hdMock.onPost("/tickets").reply(200, { ID: "NEW1" });
    hdMock.onGet("/tickets/NEW1").reply(200, { shortID: "S1" });
    // Graph's /users/{alias} 404s for an alias-domain address, so resolveMailboxAddress returns null.
    // The OLD canonicalization aborted here ("could not resolve a canonical address"), stranding all
    // of that mailbox's mail; the email is now normalized deterministically to the UPN domain.
    (resolveMailboxAddress as jest.Mock).mockResolvedValue(null);

    await processMail({ mailbox: "ureferrals@corespecialtyins.com", messageId: "M1" }, fakeContext());

    expect(acquireDrainLock as jest.Mock).toHaveBeenCalledWith(
      "ureferrals@corespecialty.com",
      expect.anything()
    );
  });

  it("aborts the drain (no divergent raw-id lock) when canonicalization returns null", async () => {
    (resolveMailboxAddress as jest.Mock).mockResolvedValueOnce(null);

    await expect(
      processMail({ mailbox: "MB-GUID", messageId: "M1" }, fakeContext())
    ).rejects.toThrow(/canonical/);

    // Never locked or drained: failing safe beats locking on a key that diverges from sweep's.
    expect(acquireDrainLock).not.toHaveBeenCalled();
    expect(getMessage).not.toHaveBeenCalled();
  });

  it("aborts the drain when canonicalization throws (e.g. Graph down)", async () => {
    (resolveMailboxAddress as jest.Mock).mockRejectedValueOnce(new Error("graph down"));

    await expect(
      processMail({ mailbox: "MB-GUID", messageId: "M1" }, fakeContext())
    ).rejects.toThrow();

    expect(acquireDrainLock).not.toHaveBeenCalled();
  });

  it("aborts the drain when the lock reports it was lost mid-drain", async () => {
    const release = jest.fn().mockResolvedValue(undefined);
    (acquireDrainLock as jest.Mock).mockResolvedValueOnce({ mailbox: MAILBOX, lost: true, release });

    await expect(
      processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext())
    ).rejects.toThrow(/lock lost/);

    expect(getMessage).not.toHaveBeenCalled(); // aborted before processing any message
    expect(release).toHaveBeenCalledTimes(1); // finally still releases
  });

  it("releases the lock after a successful drain", async () => {
    const release = jest.fn().mockResolvedValue(undefined);
    (acquireDrainLock as jest.Mock).mockResolvedValueOnce({ mailbox: MAILBOX, release });
    hdMock.onGet("/tickets").reply(200, []);
    hdMock.onPost("/tickets").reply(200, { ID: "NEW1" });
    hdMock.onGet("/tickets/NEW1").reply(200, { shortID: "SHORT1" });

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases the lock even when the drain throws (a message failed)", async () => {
    const release = jest.fn().mockResolvedValue(undefined);
    (acquireDrainLock as jest.Mock).mockResolvedValueOnce({ mailbox: MAILBOX, release });
    // A non-404 getMessage failure makes the message fail, so the drain rethrows at the end.
    (getMessage as jest.Mock).mockRejectedValue({ response: { status: 500 }, message: "boom" });

    await expect(
      processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext())
    ).rejects.toThrow(/failed during inbox drain/);

    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("new ticket happy path", () => {
  beforeEach(() => {
    hdMock.onGet("/tickets").reply(200, []);
    hdMock.onPost("/tickets").reply(200, { ID: "NEW1" });
    hdMock.onGet("/tickets/NEW1").reply(200, { shortID: "SHORT1" });
    hdMock.onPatch(/\/tickets\/NEW1/).reply(200, {});
  });

  it("creates a routed ticket with the real requester and sends NO customer notice", async () => {
    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(hdMock.history.post).toHaveLength(1);
    const created = JSON.parse(hdMock.history.post[0].data);
    expect(created.subject).toBe("Need help");
    expect(created.requester.email).toBe("john@example.com");
    expect(created.requester.name).toBe("John Doe");
    expect(created.assignment.team.ID).toBe(TEAM_ESCAPE);
    expect(created.customFields.email).toBe("john@example.com");
    expect(created.customFields.inbox).toBe("escape@corespecialty.com");
    expect(created.message.text).toBe("Hello there\n> quoted reply line"); // full thread preserved (no cleaning)

    // A new ticket is opened silently: no "ticket has been created" auto-reply is sent.
    expect(sendMailViaGraph).not.toHaveBeenCalled();

    expect(moveMessageToFolder).toHaveBeenCalledTimes(1);
  });
});

describe("existing ticket with attachments", () => {
  const EXISTING = { ID: "EXIST1", shortID: "OLD1", subject: "Need help" };

  beforeEach(() => {
    hdMock.onGet("/tickets").reply(200, [EXISTING]);
    hdMock.onGet("/tickets/EXIST1").reply(200, { shortID: "OLD1" });
    hdMock.onPatch("/tickets/EXIST1").reply(200, {});
  });

  it("uploads attachments and appends the folder + filenames to a client message", async () => {
    (listMessageAttachments as jest.Mock).mockResolvedValue([
      att("doc1.pdf", 1024),
      att("doc2.pdf", 1024),
    ]);
    (uploadAttachmentsToSharePoint as jest.Mock).mockResolvedValue({
      folderWebUrl: "https://sp/Documents/OLD1",
      uploaded: [
        { filename: "doc1.pdf", webUrl: "https://sp/doc1" },
        { filename: "doc2.pdf", webUrl: "https://sp/doc2" },
      ],
    });

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(hdMock.history.post).toHaveLength(0); // no new ticket
    const spArgs = (uploadAttachmentsToSharePoint as jest.Mock).mock.calls[0][0];
    expect(spArgs.folderName).toBe("OLD1 - john@example.com");
    expect(spArgs.attachments).toHaveLength(2);
    // Upload items expose a name + lazy getBytes (bytes fetched one file at a time).
    expect(spArgs.attachments[0].name).toBe("doc1.pdf");
    expect(typeof spArgs.attachments[0].getBytes).toBe("function");

    expect(hdMock.history.patch).toHaveLength(1);
    const patch = JSON.parse(hdMock.history.patch[0].data);
    expect(patch.author.type).toBe("client");
    expect(patch.message.text).toContain("Hello there");
    expect(patch.message.text).toContain("Ticket folder:");
    expect(patch.message.text).toContain("- doc1.pdf");
    expect(patch.message.text).toContain("- doc2.pdf");

    const ack = (sendMailViaGraph as jest.Mock).mock.calls[0][0];
    expect(ack.subject).toBe("Re: Need help [#OLD1]");
    expect(moveMessageToFolder).toHaveBeenCalledTimes(1);
  });

  it("blocks a file over the per-file limit but still uploads in-limit siblings + adds a System note", async () => {
    const OVER = 120 * 1024 * 1024; // > 100 MiB per-file default
    (listMessageAttachments as jest.Mock).mockResolvedValue([
      att("huge.bin", OVER),
      att("ok.pdf", 2048),
    ]);
    (uploadAttachmentsToSharePoint as jest.Mock).mockResolvedValue({
      folderWebUrl: "https://sp/Documents/OLD1",
      uploaded: [{ filename: "ok.pdf", webUrl: "https://sp/ok" }],
    });

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    // Only the in-limit file is uploaded.
    const spArgs = (uploadAttachmentsToSharePoint as jest.Mock).mock.calls[0][0];
    expect(spArgs.attachments.map((a: any) => a.name)).toEqual(["ok.pdf"]);

    // Two patches: client message (with the uploaded file) then the agent oversize note.
    expect(hdMock.history.patch).toHaveLength(2);
    const clientPatch = JSON.parse(hdMock.history.patch[0].data);
    const agentPatch = JSON.parse(hdMock.history.patch[1].data);
    expect(clientPatch.author.type).toBe("client");
    expect(clientPatch.message.text).toContain("- ok.pdf");
    expect(agentPatch.author.type).toBe("agent");
    expect(agentPatch.message.text).toContain("System note:");
    expect(agentPatch.message.text).toContain("huge.bin");

    expect(sendMailViaGraph).toHaveBeenCalledTimes(1); // ack still sent
  });

  it("appends the reply but sends no ack when SUBMITTER_REPLIES is off", async () => {
    process.env.SUBMITTER_REPLIES = "false";

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(hdMock.history.patch).toHaveLength(1);
    expect(JSON.parse(hdMock.history.patch[0].data).author.type).toBe("client");
    expect(sendMailViaGraph).not.toHaveBeenCalled();
    expect(moveMessageToFolder).toHaveBeenCalledTimes(1);
  });
});

describe("new ticket follow-up resilience (no duplicate ticket on retry)", () => {
  it("does not rethrow or skip the move when the post-create attachment update fails", async () => {
    hdMock.onGet("/tickets").reply(200, []);
    hdMock.onPost("/tickets").reply(200, { ID: "NEW1" });
    hdMock.onGet("/tickets/NEW1").reply(200, { shortID: "SHORT1" });
    // The post-create follow-up patch (attachment links) fails.
    hdMock.onPatch(/\/tickets\/NEW1/).reply(500);
    (listMessageAttachments as jest.Mock).mockResolvedValue([att("doc.pdf", 1024)]);
    (uploadAttachmentsToSharePoint as jest.Mock).mockResolvedValue({
      folderWebUrl: "https://sp/F",
      uploaded: [{ filename: "doc.pdf", webUrl: "https://sp/doc" }],
    });

    // Must resolve (not rethrow) so the queue does NOT retry and re-create the ticket.
    await expect(
      processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext())
    ).resolves.toBeUndefined();

    expect(sendMailViaGraph).not.toHaveBeenCalled(); // new ticket -> no customer notice
    expect(moveMessageToFolder).toHaveBeenCalledTimes(1); // still moved -> handled, no reprocess
  });
});

describe("blank subject / empty body (recoverable — must not be dropped)", () => {
  beforeEach(() => {
    hdMock.onGet("/tickets").reply(200, []);
    hdMock.onPost("/tickets").reply(200, { ID: "NEW1" });
    hdMock.onGet("/tickets/NEW1").reply(200, { shortID: "SHORT1" });
    hdMock.onPatch(/\/tickets\/NEW1/).reply(200, {});
  });

  it("still creates a ticket when the subject and body are empty", async () => {
    (getMessage as jest.Mock).mockResolvedValue(
      graphMsg({ subject: "", body: { contentType: "text", content: "" } })
    );

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(hdMock.history.post).toHaveLength(1);
    const created = JSON.parse(hdMock.history.post[0].data);
    expect(created.subject).toBe("(no subject)");
    expect(created.message.text).toBe("(no message body)");
    expect(sendMailViaGraph).not.toHaveBeenCalled(); // new ticket -> no notice
    expect(moveMessageToFolder).toHaveBeenCalledTimes(1);
  });

  it("only drops (moves, no ticket) when the SENDER address is missing", async () => {
    (getMessage as jest.Mock).mockResolvedValue(graphMsg({ from: { emailAddress: { address: "" } } }));

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(hdMock.history.post).toHaveLength(0);
    expect(sendMailViaGraph).not.toHaveBeenCalled();
    expect(moveMessageToFolder).toHaveBeenCalledTimes(1);
  });
});

describe("move-to-processed failure handling (the idempotency linchpin)", () => {
  beforeEach(() => {
    hdMock.onGet("/tickets").reply(200, []);
    hdMock.onPost("/tickets").reply(200, { ID: "NEW1" });
    hdMock.onGet("/tickets/NEW1").reply(200, { shortID: "SHORT1" });
    hdMock.onPatch(/\/tickets\/NEW1/).reply(200, {});
  });

  it("treats a move 404 as idempotent only after verifying the source is gone", async () => {
    (moveMessageToFolder as jest.Mock).mockRejectedValueOnce({ response: { status: 404 } });
    (getMessage as jest.Mock)
      .mockResolvedValueOnce(graphMsg())
      .mockRejectedValueOnce({ response: { status: 404 } });
    const ctx = fakeContext();
    const errorLog = ctx.error as jest.Mock; // buffered logger forwards to this original fn

    await expect(processMail({ mailbox: MAILBOX, messageId: "M1" }, ctx)).resolves.toBeUndefined();

    expect(sendMailViaGraph).not.toHaveBeenCalled(); // new ticket -> no notice
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("logs a move 404 as a failure when source-message verification still finds the email", async () => {
    (moveMessageToFolder as jest.Mock).mockRejectedValueOnce({ response: { status: 404 } });
    const ctx = fakeContext();
    const errorLog = ctx.error as jest.Mock;

    await expect(processMail({ mailbox: MAILBOX, messageId: "M1" }, ctx)).resolves.toBeUndefined();

    expect(getMessage).toHaveBeenCalledTimes(2); // initial processing + post-move verification
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining("source message still exists"),
      expect.anything()
    );
  });

  it("surfaces a non-404 move failure loudly, without rethrowing", async () => {
    (moveMessageToFolder as jest.Mock).mockRejectedValueOnce({ response: { status: 500 } });
    const ctx = fakeContext();
    const errorLog = ctx.error as jest.Mock;

    await expect(processMail({ mailbox: MAILBOX, messageId: "M1" }, ctx)).resolves.toBeUndefined();

    expect(sendMailViaGraph).not.toHaveBeenCalled(); // new ticket -> no notice; and not rethrown
    const loud = errorLog.mock.calls.map((c) => String(c[0])).join("\n");
    expect(loud).toMatch(/Move to processed FAILED/);
  });
});

describe("outbound loop guard (never ack one of our own in-scope addresses)", () => {
  // The only customer-facing auto-reply is the existing-ticket reply ack (a new ticket is opened
  // silently), so the loop guard is exercised here via a reply that updates an existing ticket.
  const EXISTING = { ID: "EXIST1", shortID: "OLD1", subject: "Need help" };
  beforeEach(() => {
    process.env.MAILBOX_ADDRESSES = "escape@corespecialty.com,escapereferrals@corespecialty.com";
    hdMock.onGet("/tickets").reply(200, [EXISTING]);
    hdMock.onGet("/tickets/EXIST1").reply(200, { shortID: "OLD1" });
    hdMock.onPatch("/tickets/EXIST1").reply(200, {});
  });
  afterEach(() => delete process.env.MAILBOX_ADDRESSES);

  it("suppresses the reply ack when the requester is a monitored mailbox, but still updates + moves", async () => {
    (getMessage as jest.Mock).mockResolvedValue(
      graphMsg({ from: { emailAddress: { name: "Escape", address: "escape@corespecialty.com" } } })
    );

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(hdMock.history.patch).toHaveLength(1); // existing ticket still updated (inbound unchanged)
    expect(sendMailViaGraph).not.toHaveBeenCalled(); // ack suppressed -> loop broken
    expect(moveMessageToFolder).toHaveBeenCalledTimes(1); // moved out -> not reprocessed
  });

  it("suppresses the reply ack to an in-scope alias domain not listed in MAILBOX_ADDRESSES", async () => {
    // escape@corespecialtyins.com is the same mailbox via an alias domain — caught by domain, not list.
    (getMessage as jest.Mock).mockResolvedValue(
      graphMsg({ from: { emailAddress: { address: "escape@corespecialtyins.com" } } })
    );

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(sendMailViaGraph).not.toHaveBeenCalled();
    expect(moveMessageToFolder).toHaveBeenCalledTimes(1);
  });

  it("still acks a normal external requester when in-scope addresses are configured", async () => {
    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext()); // default from = john@example.com

    expect(sendMailViaGraph).toHaveBeenCalledTimes(1);
    expect((sendMailViaGraph as jest.Mock).mock.calls[0][0].to).toBe("john@example.com");
  });
});

describe("ignore-before cutoff (pre-go-live backlog)", () => {
  beforeEach(() => {
    hdMock.onGet("/tickets").reply(200, []);
    hdMock.onPost("/tickets").reply(200, { ID: "NEW1" });
    hdMock.onGet("/tickets/NEW1").reply(200, { shortID: "SHORT1" });
    hdMock.onPatch(/\/tickets\/NEW1/).reply(200, {});
  });

  it("never claims or moves a pre-cutoff triggering message across drain-off and drain-on runs", async () => {
    process.env.MAILBOX_DRAIN = "false";
    (getMessage as jest.Mock).mockResolvedValue(
      graphMsg({ receivedDateTime: "2026-06-19T21:59:59Z" }) // 1s before the 22:00Z cutoff
    );

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(hdMock.history.get).toHaveLength(0);
    expect(hdMock.history.post).toHaveLength(0);
    expect(hdMock.history.patch).toHaveLength(0);
    expect(listMessageAttachments).not.toHaveBeenCalled();
    expect(sendMailViaGraph).not.toHaveBeenCalled();
    expect(claimMessage).not.toHaveBeenCalled();
    expect(moveMessageToFolder).not.toHaveBeenCalled();

    // Enabling the move switch cannot catch this message up: the first pass deliberately left no
    // claim, so it is fetched and protected by the cutoff guard again.
    process.env.MAILBOX_DRAIN = "true";
    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(getMessage).toHaveBeenCalledTimes(2);
    expect(hdMock.history.post).toHaveLength(0);
    expect(claimMessage).not.toHaveBeenCalled();
    expect(moveMessageToFolder).not.toHaveBeenCalled();
    expect(releaseMessageClaim).not.toHaveBeenCalled();
  });

  it("protects pre-cutoff mail in drain-on swallow mode", async () => {
    process.env.MAILBOX_DRAIN = "true";
    process.env.TICKET_CREATE = "false";
    (getMessage as jest.Mock).mockResolvedValue(
      graphMsg({ receivedDateTime: "2026-06-19T21:59:59Z" })
    );

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(hdMock.history.get).toHaveLength(0);
    expect(hdMock.history.post).toHaveLength(0);
    expect(hdMock.history.patch).toHaveLength(0);
    expect(listMessageAttachments).not.toHaveBeenCalled();
    expect(sendMailViaGraph).not.toHaveBeenCalled();
    expect(claimMessage).not.toHaveBeenCalled();
    expect(moveMessageToFolder).not.toHaveBeenCalled();
  });

  it("processes a message received at/after the cutoff", async () => {
    (getMessage as jest.Mock).mockResolvedValue(
      graphMsg({ receivedDateTime: "2026-06-19T22:00:00Z" }) // exactly the cutoff -> kept (ge)
    );

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(hdMock.history.post).toHaveLength(1);
    expect(sendMailViaGraph).not.toHaveBeenCalled(); // new ticket -> no notice
    expect(moveMessageToFolder).toHaveBeenCalledTimes(1);
  });

  it("fails open: a message with no receivedDateTime is processed normally", async () => {
    (getMessage as jest.Mock).mockResolvedValue(graphMsg()); // no receivedDateTime

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(hdMock.history.post).toHaveLength(1);
    expect(moveMessageToFolder).toHaveBeenCalledTimes(1);
  });
});

describe("inbox drain (process all outstanding mail)", () => {
  // New-ticket path for whatever messages a drain processes.
  beforeEach(() => {
    hdMock.onGet("/tickets").reply(200, []);
    hdMock.onPost("/tickets").reply(200, { ID: "NEW1" });
    hdMock.onGet("/tickets/NEW1").reply(200, { shortID: "SHORT1" });
    hdMock.onPatch(/\/tickets\/NEW1/).reply(200, {});
  });

  it("processes every message in the inbox, not just the notified one", async () => {
    // Inbox has two outstanding messages; the notification only named M1.
    (listInboxMessageIds as jest.Mock).mockResolvedValue(["M1", "M2"]);
    (getMessage as jest.Mock).mockImplementation((_g: any, _mb: any, id: string) =>
      Promise.resolve(graphMsg({ id, subject: id === "M2" ? "Second issue" : "Need help" }))
    );

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    // Both messages ticketed (silently) and moved out of the inbox.
    expect(hdMock.history.post).toHaveLength(2);
    expect(sendMailViaGraph).not.toHaveBeenCalled(); // new tickets -> no notices
    expect(moveMessageToFolder).toHaveBeenCalledTimes(2);
  });

  it("isolates a per-message failure: siblings still process, then rethrows for a retry", async () => {
    (listInboxMessageIds as jest.Mock).mockResolvedValue(["M1", "M2"]);
    // M2 fails with a non-404 error; M1 succeeds.
    (getMessage as jest.Mock).mockImplementation((_g: any, _mb: any, id: string) =>
      id === "M2"
        ? Promise.reject({ response: { status: 500 } })
        : Promise.resolve(graphMsg({ id }))
    );

    await expect(
      processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext())
    ).rejects.toThrow(/failed during inbox drain/);

    // M1 was fully handled and moved out; only the M2 failure remains for the retry.
    expect(hdMock.history.post).toHaveLength(1);
    expect(sendMailViaGraph).not.toHaveBeenCalled(); // new ticket -> no notice
    expect(moveMessageToFolder).toHaveBeenCalledTimes(1);
  });

  it("isolates a claim-read failure, processes siblings, then rethrows without acting blind", async () => {
    (listInboxMessageIds as jest.Mock).mockResolvedValue(["M1", "M2"]);
    (isMessageClaimed as jest.Mock).mockImplementation((_client: any, name: string) =>
      name.endsWith(":M1")
        ? Promise.reject(new Error("claim HEAD down"))
        : Promise.resolve(false)
    );
    (getMessage as jest.Mock).mockImplementation((_g: any, _mb: any, id: string) =>
      Promise.resolve(graphMsg({ id, subject: "Second issue" }))
    );

    await expect(
      processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext())
    ).rejects.toThrow(/failed during inbox drain/);

    expect(getMessage).toHaveBeenCalledTimes(1);
    expect((getMessage as jest.Mock).mock.calls[0][2]).toBe("M2");
    expect(hdMock.history.post).toHaveLength(1); // sibling still ticketed
    expect(moveMessageToFolder).toHaveBeenCalledTimes(1);
  });

  it("sends the error-only debug email FROM the mailbox the message landed in", async () => {
    process.env.SEND_DEBUG_EMAIL = "true";
    (getMessage as jest.Mock).mockRejectedValue({ response: { status: 500 } });

    await expect(
      processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext())
    ).rejects.toThrow(/failed during inbox drain/);

    expect(sendDebugEmail).toHaveBeenCalledTimes(1);
    expect((sendDebugEmail as jest.Mock).mock.calls[0][0].fromMailbox).toBe(MAILBOX);
  });

  it("falls back to draining only the notified id when the inbox listing fails", async () => {
    (listInboxMessageIds as jest.Mock).mockRejectedValue(new Error("graph down"));

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    // Exactly today's single-message behavior — no regression on a transient list failure.
    expect(hdMock.history.post).toHaveLength(1);
    expect(sendMailViaGraph).not.toHaveBeenCalled(); // new ticket -> no notice
    expect(moveMessageToFolder).toHaveBeenCalledTimes(1);
  });

  it("passes the ignore-before cutoff to the inbox listing (server-side filter)", async () => {
    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    // Default cutoff is 2026-06-19 6pm ET == 22:00 UTC, normalized to canonical ISO.
    const call = (listInboxMessageIds as jest.Mock).mock.calls[0];
    expect(call[0]).toEqual({ id: "graph" });
    expect(call[1]).toBe(MAILBOX);
    expect(call[2]).toBe(10); // DRAIN_BATCH_SIZE default
    expect(call[3]).toBe("2026-06-19T22:00:00.000Z");
  });

  it("does not re-enqueue when a full listing contains only claimed drain-off messages", async () => {
    process.env.MAILBOX_DRAIN = "false";
    const ids = Array.from({ length: 10 }, (_, i) => `m${i}`);
    (listInboxMessageIds as jest.Mock).mockResolvedValue(ids);
    (isMessageClaimed as jest.Mock).mockResolvedValue(true);

    const ctx = fakeContext();
    await processMail({ mailbox: MAILBOX, messageId: "m0" }, ctx);

    expect(isMessageClaimed).toHaveBeenCalledTimes(10);
    expect(getMessage).not.toHaveBeenCalled();
    expect(moveMessageToFolder).not.toHaveBeenCalled();
    expect(ctx.extraOutputs.set).not.toHaveBeenCalled();
  });

  it("skips claimed drain-off ids without letting them consume the actionable cap", async () => {
    process.env.MAILBOX_DRAIN = "false";
    const ids = Array.from({ length: 11 }, (_, i) => `m${i}`);
    (listInboxMessageIds as jest.Mock).mockResolvedValue(ids);
    (isMessageClaimed as jest.Mock).mockImplementation((_client: any, name: string) =>
      Promise.resolve(!name.endsWith(":m10"))
    );
    (getMessage as jest.Mock).mockResolvedValue(
      graphMsg({ id: "m10", from: { emailAddress: { address: "bounce@helpdesk.com" } } })
    );

    const ctx = fakeContext();
    await processMail({ mailbox: MAILBOX, messageId: "m0" }, ctx);

    expect(isMessageClaimed).toHaveBeenCalledTimes(11);
    expect(getMessage).toHaveBeenCalledTimes(1);
    expect(claimMessage).toHaveBeenCalledTimes(1);
    expect(moveMessageToFolder).not.toHaveBeenCalled();
    expect(ctx.extraOutputs.set).not.toHaveBeenCalled();
  });

  it("counts claimed catch-up moves toward the cap and re-enqueues catch-up overflow", async () => {
    const ids = Array.from({ length: 11 }, (_, i) => `m${i}`);
    (listInboxMessageIds as jest.Mock).mockResolvedValue(ids);
    (isMessageClaimed as jest.Mock).mockResolvedValue(true);

    const ctx = fakeContext();
    await processMail({ mailbox: MAILBOX, messageId: "m0" }, ctx);

    expect(getMessage).not.toHaveBeenCalled();
    expect(moveMessageToFolder).toHaveBeenCalledTimes(10);
    expect(releaseMessageClaim).toHaveBeenCalledTimes(10);
    expect(ctx.extraOutputs.set).toHaveBeenCalledTimes(1);
  });

  it("shares one actionable cap across Inbox and Reprocess", async () => {
    const inboxIds = Array.from({ length: 6 }, (_, i) => `i${i}`);
    const reprocessIds = Array.from({ length: 6 }, (_, i) => `r${i}`);
    (listInboxMessageIds as jest.Mock).mockResolvedValue(inboxIds);
    (listFolderMessageIds as jest.Mock).mockResolvedValue(reprocessIds);
    (getMessage as jest.Mock).mockImplementation((_g: any, _mb: any, id: string) =>
      Promise.resolve(
        graphMsg({ id, from: { emailAddress: { address: "bounce@helpdesk.com" } } })
      )
    );

    const ctx = fakeContext();
    await processMail({ mailbox: MAILBOX, messageId: "i0" }, ctx);

    expect(getMessage).toHaveBeenCalledTimes(10);
    expect(moveMessageToFolder).toHaveBeenCalledTimes(10);
    expect(ctx.extraOutputs.set).toHaveBeenCalledTimes(1);
  });

  it("re-enqueues when fully paginated results contain unclaimed work beyond the operation cap", async () => {
    // Default operation cap is 10; the eleventh eligible id proves work remains.
    const ids = Array.from({ length: 11 }, (_, i) => `m${i}`);
    (listInboxMessageIds as jest.Mock).mockResolvedValue(ids);
    // Make them ignored-sender so they short-circuit (move only) — keeps the test focused on
    // the continuation trigger rather than 10 ticket round-trips.
    (getMessage as jest.Mock).mockImplementation((_g: any, _mb: any, id: string) =>
      Promise.resolve(graphMsg({ id, from: { emailAddress: { address: "bounce@helpdesk.com" } } }))
    );

    const ctx = fakeContext();
    await processMail({ mailbox: MAILBOX, messageId: "m0" }, ctx);

    expect(moveMessageToFolder).toHaveBeenCalledTimes(10);
    expect(getMessage).toHaveBeenCalledTimes(10); // overflow is detected by claim HEAD, not fetched
    expect(ctx.extraOutputs.set).toHaveBeenCalledTimes(1);
    const [, msgs] = (ctx.extraOutputs.set as jest.Mock).mock.calls[0];
    expect(JSON.parse(msgs[0])).toEqual({ mailbox: MAILBOX, messageId: "m0" });
  });
});

describe("reprocess folder (replay as new inbound; cutoff bypass; no customer ack)", () => {
  beforeEach(() => {
    hdMock.onGet("/tickets").reply(200, []);
    hdMock.onPost("/tickets").reply(200, { ID: "NEW1" });
    hdMock.onGet("/tickets/NEW1").reply(200, { shortID: "SHORT1" });
    hdMock.onPatch(/\/tickets\/NEW1/).reply(200, {});
  });

  it("claims a drain-off replay once, skips it later, then catch-up moves and releases it", async () => {
    process.env.MAILBOX_DRAIN = "false";
    (listInboxMessageIds as jest.Mock).mockResolvedValue([]);
    (listFolderMessageIds as jest.Mock).mockResolvedValue(["R1"]);
    (getMessage as jest.Mock).mockResolvedValue(graphMsg({ id: "R1" }));
    (isMessageClaimed as jest.Mock)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);

    await processMail({ mailbox: MAILBOX }, fakeContext());

    expect(hdMock.history.post).toHaveLength(1);
    expect(getMessage).toHaveBeenCalledTimes(1);
    expect(claimMessage).toHaveBeenCalledTimes(1);
    expect(moveMessageToFolder).not.toHaveBeenCalled();

    await processMail({ mailbox: MAILBOX }, fakeContext());

    expect(hdMock.history.post).toHaveLength(1);
    expect(getMessage).toHaveBeenCalledTimes(1);
    expect(claimMessage).toHaveBeenCalledTimes(1);

    process.env.MAILBOX_DRAIN = "true";
    await processMail({ mailbox: MAILBOX }, fakeContext());

    expect(hdMock.history.post).toHaveLength(1);
    expect(getMessage).toHaveBeenCalledTimes(1);
    expect(moveMessageToFolder).toHaveBeenCalledTimes(1);
    expect(releaseMessageClaim).toHaveBeenCalledTimes(1);
  });

  it("replays a Reprocess message that predates the ignore-before cutoff, but sends NO ack", async () => {
    // Inbox empty; one OLD message sits in the Reprocess folder (well before the go-live cutoff).
    (listInboxMessageIds as jest.Mock).mockResolvedValue([]);
    (listFolderMessageIds as jest.Mock).mockResolvedValue(["R1"]);
    (getMessage as jest.Mock).mockResolvedValue(
      graphMsg({ id: "R1", receivedDateTime: "2020-01-01T00:00:00Z" })
    );

    await processMail({ mailbox: MAILBOX }, fakeContext()); // sweep-style item (no messageId)

    expect(hdMock.history.post).toHaveLength(1); // ticketed despite the old date (cutoff bypassed)
    expect(sendMailViaGraph).not.toHaveBeenCalled(); // customer ack suppressed
    expect(moveMessageToFolder).toHaveBeenCalledTimes(1); // moved out of Reprocess (no re-loop)
  });

  it("appends to an existing ticket on reprocess but still suppresses the ack", async () => {
    hdMock.reset();
    const EXISTING = { ID: "EXIST1", shortID: "OLD1", subject: "Need help" };
    hdMock.onGet("/tickets").reply(200, [EXISTING]);
    hdMock.onGet("/tickets/EXIST1").reply(200, { shortID: "OLD1" });
    hdMock.onPatch("/tickets/EXIST1").reply(200, {});
    (listInboxMessageIds as jest.Mock).mockResolvedValue([]);
    (listFolderMessageIds as jest.Mock).mockResolvedValue(["R1"]);
    (getMessage as jest.Mock).mockResolvedValue(graphMsg({ id: "R1" }));

    await processMail({ mailbox: MAILBOX }, fakeContext());

    expect(hdMock.history.post).toHaveLength(0); // appended, not a new ticket (find-or-create)
    expect(hdMock.history.patch).toHaveLength(1); // client message added to the existing ticket
    expect(sendMailViaGraph).not.toHaveBeenCalled(); // ack suppressed
    expect(moveMessageToFolder).toHaveBeenCalledTimes(1);
  });

  it("acks a normal inbox reply in the same drain but never the reprocessed message", async () => {
    // The inbox message replies to an EXISTING ticket (so it gets the reply ack); the reprocessed
    // message opens a ticket silently. Proves reprocess ack-suppression is independent of the inbox.
    hdMock.reset();
    const EXISTING = { ID: "EXIST1", shortID: "OLD1", subject: "Need help" };
    hdMock.onGet("/tickets").reply(200, [EXISTING]);
    hdMock.onGet("/tickets/EXIST1").reply(200, { shortID: "OLD1" });
    hdMock.onPatch("/tickets/EXIST1").reply(200, {});
    hdMock.onPost("/tickets").reply(200, { ID: "NEW1" }); // R1 ("Replayed") -> new ticket
    (listInboxMessageIds as jest.Mock).mockResolvedValue(["M1"]);
    (listFolderMessageIds as jest.Mock).mockResolvedValue(["R1"]);
    (getMessage as jest.Mock).mockImplementation((_g: any, _mb: any, id: string) =>
      Promise.resolve(graphMsg({ id, subject: id === "R1" ? "Replayed" : "Need help" }))
    );

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(sendMailViaGraph).toHaveBeenCalledTimes(1); // only the inbox reply is acked
    expect((sendMailViaGraph as jest.Mock).mock.calls[0][0].subject).toContain("Need help");
    expect(moveMessageToFolder).toHaveBeenCalledTimes(2); // both moved to processed
  });

  it("isolates a Reprocess listing failure so the inbox still drains", async () => {
    (listInboxMessageIds as jest.Mock).mockResolvedValue(["M1"]);
    (listFolderMessageIds as jest.Mock).mockRejectedValue(new Error("folder list down"));
    (getMessage as jest.Mock).mockResolvedValue(graphMsg({ id: "M1" }));

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(hdMock.history.post).toHaveLength(1); // inbox message still ticketed (silently)
    expect(sendMailViaGraph).not.toHaveBeenCalled(); // new ticket -> no notice
    expect(moveMessageToFolder).toHaveBeenCalledTimes(1);
  });

  it("resolves and lists the Reprocess folder by id (not the inbox)", async () => {
    (listInboxMessageIds as jest.Mock).mockResolvedValue([]);
    (listFolderMessageIds as jest.Mock).mockResolvedValue([]);

    await processMail({ mailbox: MAILBOX }, fakeContext());

    // The drain resolves the Reprocess folder by display name, then lists by that resolved id —
    // proving the reprocess listing isn't accidentally pointed at the inbox/processed folder.
    expect(ensureMailFolder).toHaveBeenCalledWith({ id: "graph" }, MAILBOX, "Reprocess");
    expect(listFolderMessageIds).toHaveBeenCalledWith(
      { id: "graph" },
      MAILBOX,
      "reprocess-folder-id",
      10,
      expect.any(Function)
    );
  });

  it("skips a Reprocess message from an ignored loop sender (no ticket) but still moves it out", async () => {
    // The loop guard must NOT be bypassed by reprocess (only the ignore-before cutoff is).
    (listInboxMessageIds as jest.Mock).mockResolvedValue([]);
    (listFolderMessageIds as jest.Mock).mockResolvedValue(["R1"]);
    (getMessage as jest.Mock).mockResolvedValue(
      graphMsg({ id: "R1", from: { emailAddress: { address: "bounce@helpdesk.com" } } })
    );

    await processMail({ mailbox: MAILBOX }, fakeContext());

    expect(hdMock.history.post).toHaveLength(0); // no ticket for a loop sender
    expect(sendMailViaGraph).not.toHaveBeenCalled();
    expect(moveMessageToFolder).toHaveBeenCalledTimes(1); // moved out of Reprocess -> no re-loop
  });

  it("re-enqueues a continuation drain when Reprocess has eligible overflow", async () => {
    // Inbox empty; Reprocess has 11 eligible messages and the shared invocation cap is 10.
    (listInboxMessageIds as jest.Mock).mockResolvedValue([]);
    const ids = Array.from({ length: 11 }, (_, i) => `r${i}`);
    (listFolderMessageIds as jest.Mock).mockResolvedValue(ids);
    // Ignored senders short-circuit (move only) — keeps the test on the continuation trigger.
    (getMessage as jest.Mock).mockImplementation((_g: any, _mb: any, id: string) =>
      Promise.resolve(graphMsg({ id, from: { emailAddress: { address: "bounce@helpdesk.com" } } }))
    );

    const ctx = fakeContext();
    await processMail({ mailbox: MAILBOX }, ctx); // sweep-style item (no messageId)

    expect(moveMessageToFolder).toHaveBeenCalledTimes(10);
    expect(ctx.extraOutputs.set).toHaveBeenCalledTimes(1);
    const [, msgs] = (ctx.extraOutputs.set as jest.Mock).mock.calls[0];
    expect(JSON.parse(msgs[0])).toEqual({ mailbox: MAILBOX }); // messageId undefined -> key dropped
  });

  it("still uploads attachments and adds the oversize System note while suppressing the ack", async () => {
    // Attachment + oversize handling is orthogonal to the customer ack: replay must keep them.
    (listInboxMessageIds as jest.Mock).mockResolvedValue([]);
    (listFolderMessageIds as jest.Mock).mockResolvedValue(["R1"]);
    (getMessage as jest.Mock).mockResolvedValue(graphMsg({ id: "R1" }));
    const OVER = 120 * 1024 * 1024; // > 100 MiB per-file default
    (listMessageAttachments as jest.Mock).mockResolvedValue([att("huge.bin", OVER), att("ok.pdf", 2048)]);
    (uploadAttachmentsToSharePoint as jest.Mock).mockResolvedValue({
      folderWebUrl: "https://sp/Documents/SHORT1",
      uploaded: [{ filename: "ok.pdf", webUrl: "https://sp/ok" }],
    });

    await processMail({ mailbox: MAILBOX }, fakeContext());

    expect(hdMock.history.post).toHaveLength(1); // ticket created
    const spArgs = (uploadAttachmentsToSharePoint as jest.Mock).mock.calls[0][0];
    expect(spArgs.attachments.map((a: any) => a.name)).toEqual(["ok.pdf"]); // only the in-limit file
    // Two patches: client follow-up with the uploaded file, then the agent oversize System note.
    expect(hdMock.history.patch).toHaveLength(2);
    const clientPatch = JSON.parse(hdMock.history.patch[0].data);
    const agentPatch = JSON.parse(hdMock.history.patch[1].data);
    expect(clientPatch.author.type).toBe("client");
    expect(clientPatch.message.text).toContain("- ok.pdf");
    expect(agentPatch.author.type).toBe("agent");
    expect(agentPatch.message.text).toContain("System note:");
    expect(agentPatch.message.text).toContain("huge.bin");
    expect(sendMailViaGraph).not.toHaveBeenCalled(); // ack still suppressed on reprocess
    expect(moveMessageToFolder).toHaveBeenCalledTimes(1);
  });
});

describe("non-requester reply threading (FOLLOWERS_NOTICES)", () => {
  // A follower / person-in-the-loop replying to a notice: their subject carries the [#shortID]
  // tag, but the requester-scoped lookup can't see the ticket (they aren't its requester). The
  // ticket's cc/followers are the AUDIENCE the sender must belong to for the tag to thread.
  const TICKET = {
    ID: "EXIST1",
    shortID: "OLD1",
    subject: "Need help",
    requester: { email: "john@example.com" },
    cc: [{ email: "follower@corespecialty.com", name: null }],
    followers: [],
  };

  function taggedReplyFrom(address: string) {
    (getMessage as jest.Mock).mockResolvedValue(
      graphMsg({
        subject: "Re: Need help [#OLD1]",
        from: { emailAddress: { name: "Fol Lower", address } },
      })
    );
  }

  beforeEach(() => {
    process.env.FOLLOWERS_NOTICES = "true";
    // More-specific handler FIRST: the by-ref lookup (params carry shortID). The bare handler
    // catches the requester-scoped list, which never sees the ticket in these tests.
    hdMock.onGet("/tickets", { params: { shortID: "OLD1" } }).reply(200, [TICKET]);
    hdMock.onGet("/tickets").reply(200, []);
    hdMock.onGet("/tickets/EXIST1").reply(200, { shortID: "OLD1" });
    hdMock.onPatch("/tickets/EXIST1").reply(200, {});
    hdMock.onPost("/tickets").reply(200, { ID: "NEW-WRONG" });
  });

  it("threads a tagged audience (cc) reply with the relayed-from marker and NO ack (loop safety)", async () => {
    taggedReplyFrom("follower@corespecialty.com");

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(hdMock.history.post).toHaveLength(0); // no duplicate ticket
    expect(hdMock.history.patch).toHaveLength(1);
    const patch = JSON.parse(hdMock.history.patch[0].data);
    expect(patch.author.type).toBe("client");
    expect(patch.message.text.startsWith("[Relayed from follower@corespecialty.com]\n\n")).toBe(true);
    expect(patch.message.text).toContain("Hello there");

    // No ack to a relayed sender: an auto-responder on their side would reply to a tagged ack,
    // re-thread, and re-ack forever. Their reply still landed in the ticket above.
    expect(sendMailViaGraph).not.toHaveBeenCalled();
    expect(moveMessageToFolder).toHaveBeenCalledTimes(1);
  });

  it("threads a follower (resolved by agent ID) and outranks a substring match on the sender's OWN ticket", async () => {
    // Bob owns an unrelated ticket whose subject is a substring of the reply's subject — the
    // guarded fallback would misfile the reply there; the authoritative tag must win.
    hdMock.reset();
    hdMock
      .onGet("/tickets", { params: { shortID: "OLD1" } })
      .reply(200, [{ ...TICKET, cc: [], followers: ["ag-fol"] }]);
    hdMock.onGet("/tickets").reply(200, [{ ID: "BOB1", shortID: "XY99", subject: "Need help" }]);
    hdMock.onGet("/agents").reply(200, [{ ID: "ag-fol", email: "follower@corespecialty.com" }]);
    hdMock.onPatch("/tickets/EXIST1").reply(200, {});
    hdMock.onGet("/tickets/EXIST1").reply(200, { shortID: "OLD1" });
    taggedReplyFrom("follower@corespecialty.com");

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(hdMock.history.patch.map((p) => p.url)).toEqual(["/tickets/EXIST1"]); // not BOB1
    const patch = JSON.parse(hdMock.history.patch[0].data);
    expect(patch.message.text).toContain("[Relayed from follower@corespecialty.com]");
  });

  it("does NOT thread a tagged reply from a sender outside the ticket's audience (new ticket)", async () => {
    taggedReplyFrom("stranger@example.com"); // not requester, not cc, no followers on TICKET

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(hdMock.history.patch.filter((p) => p.url === "/tickets/EXIST1")).toHaveLength(0);
    expect(hdMock.history.post).toHaveLength(1); // pre-feature behavior: silent new ticket
  });

  it("threads WITHOUT the marker (and still acks) when the tagged ticket's requester IS the sender", async () => {
    taggedReplyFrom("john@example.com");

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(hdMock.history.post).toHaveLength(0);
    const patch = JSON.parse(hdMock.history.patch[0].data);
    expect(patch.message.text).not.toContain("[Relayed from");
    // The requester's own reply keeps its normal reply-received ack.
    expect((sendMailViaGraph as jest.Mock).mock.calls[0][0].to).toBe("john@example.com");
  });

  it("opens a new ticket (today's behavior) when the toggle is off", async () => {
    delete process.env.FOLLOWERS_NOTICES;
    taggedReplyFrom("follower@corespecialty.com");

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(hdMock.history.post).toHaveLength(1); // new ticket, no by-ref threading
    expect(hdMock.history.get.every((g) => !(g.params as any)?.shortID)).toBe(true);
  });

  it("skips the by-ref lookup entirely when the subject has no tag", async () => {
    (getMessage as jest.Mock).mockResolvedValue(
      graphMsg({ from: { emailAddress: { address: "follower@corespecialty.com" } } })
    );

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(hdMock.history.post).toHaveLength(1); // untagged -> ordinary new ticket
    expect(hdMock.history.get.every((g) => !(g.params as any)?.shortID)).toBe(true);
  });

  it("falls through to a new ticket when the by-ref lookup is rejected with a 4xx", async () => {
    hdMock.reset();
    hdMock.onGet("/tickets", { params: { shortID: "OLD1" } }).reply(400, { error: "bad filter" });
    hdMock.onGet("/tickets").reply(200, []);
    hdMock.onPost("/tickets").reply(200, { ID: "NEW1" });
    taggedReplyFrom("follower@corespecialty.com");

    await processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext());

    expect(hdMock.history.post).toHaveLength(1);
    expect(moveMessageToFolder).toHaveBeenCalledTimes(1);
  });

  it("rethrows on a 5xx by-ref lookup with NO side effects (retry, never mis-thread)", async () => {
    hdMock.reset();
    hdMock.onGet("/tickets", { params: { shortID: "OLD1" } }).reply(500);
    hdMock.onGet("/tickets").reply(200, []);
    hdMock.onPost("/tickets").reply(200, { ID: "NEW-WRONG" });
    taggedReplyFrom("follower@corespecialty.com");

    await expect(processMail({ mailbox: MAILBOX, messageId: "M1" }, fakeContext())).rejects.toThrow();

    expect(hdMock.history.post).toHaveLength(0); // no ticket was created
    expect(sendMailViaGraph).not.toHaveBeenCalled();
    expect(moveMessageToFolder).not.toHaveBeenCalled(); // message stays for the retry
  }, 15000); // the GET is retried by the real backoff interceptor (~4s) before failing
});
