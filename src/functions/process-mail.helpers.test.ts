// Unit tests for the pure helpers that remain in process-mail.ts (attachment policy, queue-item
// parsing). Routing and the Helpdesk client moved to their own modules (see
// routing.test / helpdesk-client.test); the email/ticket copy moved to
// templates.ts (see templates.test). The inbound body now reaches the ticket UNMODIFIED — the full
// email thread is preserved, so there is no body-trimming/cleaning step to test. Importing
// process-mail registers a queue trigger at module load, so @azure/functions is mocked to a no-op
// registry.

jest.mock("@azure/functions", () => ({
  app: { http: jest.fn(), setup: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() },
  output: { storageQueue: jest.fn(() => ({})) },
}));

import {
  planAttachments,
  normalizeQueueItem,
} from "./process-mail";
import type { AttachmentInfo } from "./graph-mail";

function att(over: Partial<AttachmentInfo>): AttachmentInfo {
  return {
    id: "att-id",
    name: "file.pdf",
    size: 100,
    contentType: "application/pdf",
    isInline: false,
    ...over,
  };
}

describe("planAttachments (per-file limit)", () => {
  const maxBytesPerFile = 1000;

  it("returns empty lists when there are no attachments", () => {
    expect(planAttachments([], maxBytesPerFile)).toEqual({ uploadable: [], blocked: [] });
  });

  it("ignores inline, small (<20KB), and signature images entirely", () => {
    const res = planAttachments(
      [
        att({ name: "logo.png", contentType: "image/png", size: 100 }),
        att({ name: "my-signature.png", contentType: "image/png", size: 50_000 }),
        att({ name: "inline.png", contentType: "image/png", size: 50_000, isInline: true }),
        att({ name: "doc1.pdf", size: 300 }),
        att({ name: "doc2.pdf", size: 400 }),
      ],
      maxBytesPerFile
    );
    expect(res.uploadable.map((a) => a.name)).toEqual(["doc1.pdf", "doc2.pdf"]);
    expect(res.blocked).toEqual([]);
  });

  it("blocks only the files over the per-file limit; in-limit siblings still upload", () => {
    const res = planAttachments(
      [
        att({ name: "ok.pdf", size: 900 }),
        att({ name: "toobig.pdf", size: 1500 }),
        att({ name: "alsoOk.pdf", size: 1000 }), // exactly at the limit -> uploadable
      ],
      maxBytesPerFile
    );
    expect(res.uploadable.map((a) => a.name)).toEqual(["ok.pdf", "alsoOk.pdf"]);
    expect(res.blocked).toEqual([{ filename: "toobig.pdf", size: 1500 }]);
  });

  it("detects images by extension when content-type is absent", () => {
    const res = planAttachments([att({ name: "tiny.JPG", contentType: "", size: 100 })], maxBytesPerFile);
    expect(res.uploadable).toHaveLength(0);
  });

  it("keeps an image at the 20KB boundary", () => {
    const res = planAttachments(
      [att({ name: "photo.png", contentType: "image/png", size: 20 * 1024 })],
      50 * 1024
    );
    expect(res.uploadable.map((a) => a.name)).toEqual(["photo.png"]);
  });
});

describe("normalizeQueueItem", () => {
  it("accepts an object", () => {
    expect(normalizeQueueItem({ mailbox: "mb", messageId: "M1" })).toEqual({ mailbox: "mb", messageId: "M1" });
  });
  it("accepts a JSON string", () => {
    expect(normalizeQueueItem('{"mailbox":"mb","messageId":"M1"}')).toEqual({ mailbox: "mb", messageId: "M1" });
  });
  it("accepts a mailbox-only sweep item (no messageId)", () => {
    expect(normalizeQueueItem({ mailbox: "mb" })).toEqual({ mailbox: "mb" });
    expect(normalizeQueueItem('{"mailbox":"mb"}')).toEqual({ mailbox: "mb" });
  });
  it("returns null for malformed/missing items", () => {
    expect(normalizeQueueItem("not json")).toBeNull();
    expect(normalizeQueueItem({ messageId: "M1" })).toBeNull(); // mailbox is required
    expect(normalizeQueueItem({ mailbox: "mb", messageId: "" })).toBeNull(); // present-but-empty messageId
    expect(normalizeQueueItem(null)).toBeNull();
  });
});
