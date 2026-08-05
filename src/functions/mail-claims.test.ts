// Storage REST tests for the no-move mail idempotency claims. A client is injected so no Azure
// credential or live storage account is used.
import axios, { AxiosInstance } from "axios";
import MockAdapter from "axios-mock-adapter";
import {
  claimMessage,
  isMessageClaimed,
  mailClaimContainer,
  messageClaimBlobName,
  releaseMessageClaim,
} from "./mail-claims";

const NAME = "mail-claim-escape@corespecialty.com-AAMkAbC-_=";
const ENCODED_NAME = encodeURIComponent(NAME);

let client: AxiosInstance;
let mock: MockAdapter;

const storageErrorHeaders = (code: string) => ({ "x-ms-error-code": code });

beforeEach(() => {
  delete process.env.MAIL_CLAIM_CONTAINER;
  client = axios.create();
  mock = new MockAdapter(client);
});

afterEach(() => {
  mock.restore();
  delete process.env.MAIL_CLAIM_CONTAINER;
});

describe("messageClaimBlobName", () => {
  it("normalizes the mailbox key but preserves the opaque message id's case", () => {
    expect(messageClaimBlobName("Escape+tag@CoreSpecialtyIns.com", "AAMkAbC-_=")).toBe(NAME);
    expect(messageClaimBlobName("escape@corespecialty.com", "aamkabc-_=")).not.toBe(NAME);
  });
});

describe("mail claim storage", () => {
  it("defaults to relay-state and honors MAIL_CLAIM_CONTAINER", () => {
    expect(mailClaimContainer()).toBe("relay-state");
    process.env.MAIL_CLAIM_CONTAINER = "mail-claim-state";
    expect(mailClaimContainer()).toBe("mail-claim-state");
  });

  it("HEADs the blob and maps only 404 to not claimed", async () => {
    mock
      .onHead(`/relay-state/${ENCODED_NAME}`)
      .replyOnce(200)
      .onHead()
      .replyOnce(404, undefined, storageErrorHeaders("BlobNotFound"));

    await expect(isMessageClaimed(client, NAME)).resolves.toBe(true);
    await expect(isMessageClaimed(client, NAME)).resolves.toBe(false);
  });

  it("propagates an unexpected claim-read error so processing cannot act blind", async () => {
    mock.onHead(`/relay-state/${ENCODED_NAME}`).reply(503);

    await expect(isMessageClaimed(client, NAME)).rejects.toBeTruthy();
  });

  it("creates the container on first use and atomically PUTs JSON", async () => {
    mock.onPut("/relay-state?restype=container").reply(201);
    mock.onPut(`/relay-state/${ENCODED_NAME}`).reply(201);

    await expect(claimMessage(client, NAME, '{"ticketId":"123"}')).resolves.toBe(true);

    expect(mock.history.put).toHaveLength(2);
    expect(mock.history.put[0].url).toBe("/relay-state?restype=container");
    expect(mock.history.put[1].url).toBe(`/relay-state/${ENCODED_NAME}`);
    expect(mock.history.put[1].data).toBe('{"ticketId":"123"}');
    expect(mock.history.put[1].headers?.["x-ms-blob-type"]).toBe("BlockBlob");
    expect(mock.history.put[1].headers?.["If-None-Match"]).toBe("*");
    expect(mock.history.put[1].headers?.["Content-Type"]).toBe("application/json");
  });

  it("tolerates an existing container and 409/412 create-once conflicts", async () => {
    mock
      .onPut("/relay-state?restype=container")
      .reply(409, undefined, storageErrorHeaders("ContainerAlreadyExists"));
    mock
      .onPut(`/relay-state/${ENCODED_NAME}`)
      .replyOnce(409, undefined, storageErrorHeaders("BlobAlreadyExists"))
      .onPut()
      .replyOnce(412, undefined, storageErrorHeaders("ConditionNotMet"));

    await expect(claimMessage(client, NAME, "{}")).resolves.toBe(false);
    await expect(claimMessage(client, NAME, "{}")).resolves.toBe(false);
    expect(
      mock.history.put.filter((request) => request.url === "/relay-state?restype=container")
    ).toHaveLength(1);
  });

  it("uses the configured container for claim operations", async () => {
    process.env.MAIL_CLAIM_CONTAINER = "mail-claim-state";
    mock.onPut("/mail-claim-state?restype=container").reply(201);
    mock.onPut(`/mail-claim-state/${ENCODED_NAME}`).reply(201);

    await expect(claimMessage(client, NAME, "{}")).resolves.toBe(true);
  });

  it("deletes a claim and tolerates an already-missing blob", async () => {
    mock
      .onDelete(`/relay-state/${ENCODED_NAME}`)
      .replyOnce(202)
      .onDelete()
      .replyOnce(404, undefined, storageErrorHeaders("BlobNotFound"));

    await expect(releaseMessageClaim(client, NAME)).resolves.toBeUndefined();
    await expect(releaseMessageClaim(client, NAME)).resolves.toBeUndefined();
  });

  it("propagates unexpected claim-write and delete errors", async () => {
    mock.onPut("/relay-state?restype=container").reply(201);
    mock.onPut(`/relay-state/${ENCODED_NAME}`).reply(403);
    mock.onDelete(`/relay-state/${ENCODED_NAME}`).reply(503);

    await expect(claimMessage(client, NAME, "{}")).rejects.toBeTruthy();
    await expect(releaseMessageClaim(client, NAME)).rejects.toBeTruthy();
  });

  it("fails closed for same-status storage errors that are not missing/existing claim states", async () => {
    mock
      .onHead(`/relay-state/${ENCODED_NAME}`)
      .reply(404, undefined, storageErrorHeaders("AuthorizationFailure"));
    mock
      .onPut("/relay-state?restype=container")
      .reply(409, undefined, storageErrorHeaders("ContainerBeingDeleted"));
    mock
      .onDelete(`/relay-state/${ENCODED_NAME}`)
      .reply(404, undefined, storageErrorHeaders("AuthorizationFailure"));

    await expect(isMessageClaimed(client, NAME)).rejects.toBeTruthy();
    await expect(claimMessage(client, NAME, "{}")).rejects.toBeTruthy();
    await expect(releaseMessageClaim(client, NAME)).rejects.toBeTruthy();
  });

  it("does not treat an unrelated 412 blob-write error as an existing claim", async () => {
    mock.onPut("/relay-state?restype=container").reply(201);
    mock
      .onPut(`/relay-state/${ENCODED_NAME}`)
      .reply(412, undefined, storageErrorHeaders("LeaseIdMissing"));

    await expect(claimMessage(client, NAME, "{}")).rejects.toBeTruthy();
  });

  it("evicts a failed container ensure so a later claim can retry it", async () => {
    mock
      .onPut("/relay-state?restype=container")
      .replyOnce(503)
      .onPut()
      .replyOnce(201);
    mock.onPut(`/relay-state/${ENCODED_NAME}`).reply(201);

    await expect(claimMessage(client, NAME, "{}")).rejects.toBeTruthy();
    await expect(claimMessage(client, NAME, "{}")).resolves.toBe(true);
    expect(
      mock.history.put.filter((request) => request.url === "/relay-state?restype=container")
    ).toHaveLength(2);
  });

  it("recognizes the Azure error code from an XML body when the header is absent", async () => {
    mock.onPut("/relay-state?restype=container").reply(201);
    mock
      .onPut(`/relay-state/${ENCODED_NAME}`)
      .reply(412, "<?xml version=\"1.0\"?><Error><Code>ConditionNotMet</Code></Error>");

    await expect(claimMessage(client, NAME, "{}")).resolves.toBe(false);
  });
});
