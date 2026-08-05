// Unit tests for the Graph mail boundary (graph-mail.ts).
//   - parseGraphMessage: maps a Graph message into the normalized inbound shape
//   - listMessageAttachments: metadata only (inline flag, lower-cased type); fetchAttachmentBytes
//   - sendMailViaGraph: POSTs the expected sendMail body shape
//
// graph-mail.ts only depends on axios (no @azure/functions side effects), so the Graph
// AxiosInstance is mocked with axios-mock-adapter directly.

import axios, { AxiosInstance } from "axios";
import MockAdapter from "axios-mock-adapter";
import {
  parseGraphMessage,
  listInboxMessageIds,
  listFolderMessageIds,
  listMessageAttachments,
  fetchAttachmentBytes,
  MAIL_MESSAGE_LIST_PAGE_BUDGET,
  sendMailViaGraph,
  type GraphMessage,
} from "./graph-mail";

describe("parseGraphMessage", () => {
  it("maps from/to/replyTo/subject/body into the normalized shape", () => {
    const msg: GraphMessage = {
      id: "M1",
      subject: "  Need help  ",
      from: { emailAddress: { name: "John Doe", address: "john@example.com" } },
      toRecipients: [{ emailAddress: { address: "escape@corespecialty.com" } }],
      replyTo: [{ emailAddress: { address: "reply@example.com" } }],
      body: { contentType: "text", content: "Hello there" },
      hasAttachments: true,
    };
    const parsed = parseGraphMessage(msg);
    expect(parsed.subject).toBe("Need help");
    expect(parsed.fromName).toBe("John Doe");
    expect(parsed.fromAddress).toBe("john@example.com");
    expect(parsed.toAddress).toBe("escape@corespecialty.com");
    expect(parsed.replyTo).toBe("reply@example.com");
    expect(parsed.text).toBe("Hello there");
  });

  it("maps receivedDateTime (and null when absent)", () => {
    expect(
      parseGraphMessage({ id: "M1", receivedDateTime: "2026-06-20T12:00:00Z" }).receivedDateTime
    ).toBe("2026-06-20T12:00:00Z");
    expect(parseGraphMessage({ id: "M2" }).receivedDateTime).toBeNull();
  });

  it("falls back to sender + bodyPreview and a null display name", () => {
    const parsed = parseGraphMessage({
      id: "M2",
      subject: "Hi",
      sender: { emailAddress: { address: "jane@example.com" } },
      bodyPreview: "preview text",
    });
    expect(parsed.fromAddress).toBe("jane@example.com");
    expect(parsed.fromName).toBeNull();
    expect(parsed.replyTo).toBeNull();
    expect(parsed.text).toBe("preview text");
  });

  it("defaults missing fields safely", () => {
    const parsed = parseGraphMessage({ id: "M3" });
    expect(parsed.subject).toBe("");
    expect(parsed.fromAddress).toBe("");
    expect(parsed.toAddress).toBeNull();
    expect(parsed.text).toBe("");
  });
});

describe("listMessageAttachments", () => {
  let graph: AxiosInstance;
  let mock: MockAdapter;

  beforeEach(() => {
    graph = axios.create();
    mock = new MockAdapter(graph);
  });
  afterEach(() => mock.restore());

  it("returns metadata only (no bytes), lower-casing the content type", async () => {
    mock.onGet(/\/messages\/M1\/attachments/).reply(200, {
      value: [
        {
          "@odata.type": "#microsoft.graph.fileAttachment",
          id: "a1",
          name: "doc.PDF",
          contentType: "Application/PDF",
          size: 1234,
          isInline: false,
        },
        {
          "@odata.type": "#microsoft.graph.fileAttachment",
          id: "a2",
          name: "logo.png",
          contentType: "image/png",
          size: 50,
          isInline: true,
        },
      ],
    });

    const out = await listMessageAttachments(graph, "mb", "M1");
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ id: "a1", name: "doc.PDF", contentType: "application/pdf", isInline: false, size: 1234 });
    expect(out[1]).toMatchObject({ id: "a2", name: "logo.png", isInline: true });
    expect((out[0] as any).contentBytes).toBeUndefined();
  });

  it("requests $select to keep the response light (no contentBytes)", async () => {
    mock.onGet(/\/attachments/).reply(200, { value: [] });
    await listMessageAttachments(graph, "mb", "M1");
    expect(mock.history.get[0].url).toContain("$select=id,name,size,contentType,isInline");
  });

  it("skips non-file (item/reference) attachments", async () => {
    mock.onGet(/\/attachments/).reply(200, {
      value: [
        { "@odata.type": "#microsoft.graph.itemAttachment", id: "i1", name: "calendar.ics" },
        { "@odata.type": "#microsoft.graph.fileAttachment", id: "f1", name: "real.pdf", size: 10 },
      ],
    });
    const out = await listMessageAttachments(graph, "mb", "M2");
    expect(out.map((a) => a.name)).toEqual(["real.pdf"]);
  });
});

describe("listInboxMessageIds", () => {
  let graph: AxiosInstance;
  let mock: MockAdapter;

  beforeEach(() => {
    graph = axios.create();
    mock = new MockAdapter(graph);
  });
  afterEach(() => mock.restore());

  it("lists ids from the inbox folder, id-only + oldest-first", async () => {
    mock.onGet(/mailFolders\('inbox'\)\/messages/).reply(200, { value: [{ id: "a" }, { id: "b" }] });

    const ids = await listInboxMessageIds(graph, "mb", 50);

    expect(ids).toEqual(["a", "b"]);
    const url = mock.history.get[0].url ?? "";
    expect(url).toContain("mailFolders('inbox')/messages");
    expect(url).toContain("$select=id");
    expect(url).toContain("$orderby=receivedDateTime asc");
    expect(url).not.toContain("$filter"); // no cutoff passed -> no date filter
  });

  it("applies a receivedDateTime ge filter when a cutoff is passed", async () => {
    mock.onGet(/mailFolders\('inbox'\)\/messages/).reply(200, { value: [{ id: "a" }] });

    const ids = await listInboxMessageIds(graph, "mb", 50, "2026-06-19T22:00:00.000Z");

    expect(ids).toEqual(["a"]);
    expect(mock.history.get[0].url ?? "").toContain(
      "$filter=receivedDateTime ge 2026-06-19T22:00:00.000Z"
    );
  });

  it("follows @odata.nextLink unchanged and keeps ids oldest-first across pages", async () => {
    mock.onGet(/mailFolders\('inbox'\)/).reply(200, {
      value: [{ id: "a" }, { id: "b" }],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/page2",
    });
    mock.onGet(/page2/).reply(200, { value: [{ id: "c" }, { id: "d" }] });

    const ids = await listInboxMessageIds(graph, "mb", 2);

    expect(ids).toEqual(["a", "b", "c", "d"]);
    expect(mock.history.get).toHaveLength(2);
    expect(mock.history.get[0].url).toContain("$top=2");
    expect(mock.history.get[1].url).toBe("https://graph.microsoft.com/v1.0/page2");
  });

  it("preserves the received-after filter by following the server-provided nextLink", async () => {
    const cutoff = "2026-06-19T22:00:00.000Z";
    const nextLink =
      "https://graph.microsoft.com/v1.0/users/mb/mailFolders('inbox')/messages" +
      "?$select=id&$orderby=receivedDateTime%20asc" +
      `&$filter=receivedDateTime%20ge%20${cutoff}&$skiptoken=opaque`;
    mock.onGet(/mailFolders\('inbox'\).*\$top=/).reply(200, {
      value: [{ id: "a" }],
      "@odata.nextLink": nextLink,
    });
    mock.onGet(nextLink).reply(200, { value: [{ id: "b" }] });

    const ids = await listInboxMessageIds(graph, "mb", 2, cutoff);

    expect(ids).toEqual(["a", "b"]);
    expect(mock.history.get[0].url).toContain(`$filter=receivedDateTime ge ${cutoff}`);
    expect(mock.history.get[1].url).toBe(nextLink);
  });

  it("stops at the hard page budget and logs when another page remains", async () => {
    const log = jest.fn();
    mock.onGet(/mailFolders\('inbox'\)/).reply(200, {
      value: [{ id: "id-1" }],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/page?number=2",
    });
    mock.onGet(/\/page\?number=/).reply((config) => {
      const page = Number(new URL(config.url ?? "").searchParams.get("number"));
      return [
        200,
        {
          value: [{ id: `id-${page}` }],
          "@odata.nextLink": `https://graph.microsoft.com/v1.0/page?number=${page + 1}`,
        },
      ];
    });

    const ids = await listInboxMessageIds(graph, "mb", 1, undefined, log);

    expect(ids).toEqual(
      Array.from({ length: MAIL_MESSAGE_LIST_PAGE_BUDGET }, (_, i) => `id-${i + 1}`)
    );
    expect(mock.history.get).toHaveLength(MAIL_MESSAGE_LIST_PAGE_BUDGET);
    expect(mock.history.get.some((request) => request.url?.includes("number=11"))).toBe(false);
    expect(log).toHaveBeenCalledWith("Graph mail listing truncated at page budget", {
      mailbox: "mb",
      folderResource: "mailFolders('inbox')",
      pageBudget: MAIL_MESSAGE_LIST_PAGE_BUDGET,
      pageSize: 1,
      ids: MAIL_MESSAGE_LIST_PAGE_BUDGET,
    });
  });
});

describe("listFolderMessageIds", () => {
  let graph: AxiosInstance;
  let mock: MockAdapter;

  beforeEach(() => {
    graph = axios.create();
    mock = new MockAdapter(graph);
  });
  afterEach(() => mock.restore());

  it("lists ids from a folder by id, id-only + oldest-first, with NO date filter", async () => {
    mock.onGet(/mailFolders\/FID\/messages/).reply(200, { value: [{ id: "r1" }, { id: "r2" }] });

    const ids = await listFolderMessageIds(graph, "mb", "FID", 50);

    expect(ids).toEqual(["r1", "r2"]);
    const url = mock.history.get[0].url ?? "";
    expect(url).toContain("mailFolders/FID/messages");
    expect(url).toContain("$select=id");
    expect(url).toContain("$orderby=receivedDateTime asc");
    expect(url).not.toContain("$filter"); // reprocess intentionally bypasses the ignore-before cutoff
  });

  it("pages beyond the page-size hint so callers can filter the complete listing", async () => {
    mock.onGet(/mailFolders\/FID/).reply(200, {
      value: [{ id: "a" }, { id: "b" }],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/page2",
    });
    mock.onGet(/page2/).reply(200, { value: [{ id: "c" }, { id: "d" }] });

    const ids = await listFolderMessageIds(graph, "mb", "FID", 2);

    expect(ids).toEqual(["a", "b", "c", "d"]);
    expect(mock.history.get).toHaveLength(2);
  });
});

describe("fetchAttachmentBytes", () => {
  it("fetches raw bytes via $value as a Buffer", async () => {
    const graph = axios.create();
    const mock = new MockAdapter(graph);
    mock.onGet(/\/attachments\/a1\/\$value$/).reply(200, Buffer.from([7, 8, 9]));

    const bytes = await fetchAttachmentBytes(graph, "mb", "M1", "a1");
    expect(Buffer.from(bytes)).toEqual(Buffer.from([7, 8, 9]));
    mock.restore();
  });
});

describe("sendMailViaGraph", () => {
  it("POSTs the expected sendMail body shape", async () => {
    const graph = axios.create();
    const mock = new MockAdapter(graph);
    mock.onPost(/\/users\/.*\/sendMail$/).reply(202);

    await sendMailViaGraph({
      graph,
      mailbox: "escape@corespecialty.com",
      to: "john@example.com",
      subject: "Re: Need help [#ABC]",
      body: "We received your message.",
    });

    expect(mock.history.post).toHaveLength(1);
    const body = JSON.parse(mock.history.post[0].data);
    expect(body.message.subject).toBe("Re: Need help [#ABC]");
    expect(body.message.body).toEqual({ contentType: "Text", content: "We received your message." });
    expect(body.message.toRecipients[0].emailAddress.address).toBe("john@example.com");
    expect(body.saveToSentItems).toBe(true);
    mock.restore();
  });
});

