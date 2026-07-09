// End-to-end tests for the SharePoint / Microsoft Graph upload pipeline.
//
// These exercise the real sharepoint.ts logic with the network boundary mocked:
//   - @azure/identity credentials are mocked so getGraphToken resolves a token
//   - the Graph AxiosInstance is mocked with axios-mock-adapter (site/drive/folder/session)
//   - the upload-session PUT goes through the DEFAULT axios, mocked separately
//
// Covered: credential selection, token acquisition, site/drive resolution, folder
// create + 409-reuse, single-file upload (incl. filename sanitization and error cases),
// and the full multi-file uploadAttachmentsToSharePoint orchestration.

jest.mock("@azure/identity", () => ({
  ClientAssertionCredential: jest.fn(),
  ManagedIdentityCredential: jest.fn(),
  DefaultAzureCredential: jest.fn(),
}));

import axios, { AxiosInstance } from "axios";
import MockAdapter from "axios-mock-adapter";
import * as identity from "@azure/identity";
import {
  resolveSiteId,
  resolveDriveIdByName,
  ensureFolderInDriveRoot,
  uploadFileToDriveFolder,
  createGraphClient,
  getGraphToken,
  uploadAttachmentsToSharePoint,
} from "./sharepoint";
import type { SharePointUploadItem } from "./sharepoint";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const SITE_URL = "https://contoso.sharepoint.com/sites/Helpdesk";
const CHUNK_SIZE = 10 * 1024 * 1024; // mirrors UPLOAD_CHUNK_SIZE in sharepoint.ts

function withToken(token: any) {
  return { getToken: jest.fn().mockResolvedValue(token) };
}

function bytes(arr: number[]): Uint8Array {
  return new Uint8Array(arr);
}

/** An upload item whose bytes are produced lazily (matches process-mail's items). */
function uploadItem(name: string, data: Uint8Array): SharePointUploadItem {
  return { name, getBytes: async () => data };
}

beforeEach(() => {
  // Default: every credential type yields a valid token.
  (identity.ClientAssertionCredential as jest.Mock).mockImplementation(() =>
    withToken({ token: "fake-graph-token" })
  );
  (identity.ManagedIdentityCredential as jest.Mock).mockImplementation(() =>
    withToken({ token: "mi-exchange-token" })
  );
  (identity.DefaultAzureCredential as jest.Mock).mockImplementation(() =>
    withToken({ token: "fake-graph-token" })
  );
});

describe("getGraphToken / createGraphClient", () => {
  const baseConfig = {
    graphBaseUrl: GRAPH_BASE,
    siteUrl: SITE_URL,
    libraryName: "Documents",
  };

  it("falls back to managed identity (DefaultAzureCredential) when no MI client id is configured", async () => {
    await getGraphToken(baseConfig);
    expect(identity.DefaultAzureCredential).toHaveBeenCalledTimes(1);
  });

  it("selects the user-assigned managed identity when only a client id is provided (fallback)", async () => {
    await getGraphToken({ ...baseConfig, managedIdentityClientId: "mi-client-1" });
    expect(identity.DefaultAzureCredential).toHaveBeenCalledWith({
      managedIdentityClientId: "mi-client-1",
    });
  });

  it("uses app-registration federation (ClientAssertionCredential over the UAMI) when tenant+client+MI are set without a secret", async () => {
    const token = await getGraphToken({
      ...baseConfig,
      tenantId: "tenant-1",
      clientId: "appreg-1",
      managedIdentityClientId: "mi-1",
    });
    expect(token).toBe("fake-graph-token");
    // The app registration is the principal; the UAMI is the keyless assertion.
    expect(identity.ClientAssertionCredential).toHaveBeenCalledWith(
      "tenant-1",
      "appreg-1",
      expect.any(Function)
    );
    expect(identity.ManagedIdentityCredential).toHaveBeenCalledWith({ clientId: "mi-1" });
    expect(identity.DefaultAzureCredential).not.toHaveBeenCalled();
  });

  it("throws when no token is returned", async () => {
    (identity.DefaultAzureCredential as jest.Mock).mockImplementation(() =>
      withToken(null)
    );
    await expect(getGraphToken(baseConfig)).rejects.toThrow(
      /Failed to acquire Graph token/i
    );
  });

  it("creates a Graph client with the configured base URL", async () => {
    const client = await createGraphClient(baseConfig);
    expect(client.defaults.baseURL).toBe(GRAPH_BASE);
  });
});

describe("Graph primitives (graph instance mocked)", () => {
  let graph: AxiosInstance;
  let graphMock: MockAdapter;
  let defaultMock: MockAdapter;

  beforeEach(() => {
    graph = axios.create();
    graphMock = new MockAdapter(graph);
    defaultMock = new MockAdapter(axios); // for uploadFileToDriveFolder's PUT
  });

  afterEach(() => {
    graphMock.restore();
    defaultMock.restore();
  });

  describe("resolveSiteId", () => {
    it("resolves the site id from a full site URL", async () => {
      graphMock
        .onGet("/sites/contoso.sharepoint.com:/sites/Helpdesk")
        .reply(200, { id: "SITE1" });
      await expect(resolveSiteId(graph, SITE_URL)).resolves.toBe("SITE1");
    });

    it("throws when no id comes back", async () => {
      graphMock.onGet(/\/sites\//).reply(200, {});
      await expect(resolveSiteId(graph, SITE_URL)).rejects.toThrow(
        /could not resolve SharePoint site id/i
      );
    });
  });

  describe("resolveDriveIdByName", () => {
    beforeEach(() => {
      graphMock.onGet("/sites/SITE1/drives").reply(200, {
        value: [
          { id: "D1", name: "Documents" },
          { id: "D2", name: "Shared" },
        ],
      });
    });

    it("matches a drive by name, case-insensitively", async () => {
      await expect(resolveDriveIdByName(graph, "SITE1", "documents")).resolves.toBe(
        "D1"
      );
    });

    it("throws a helpful error when the drive is not found", async () => {
      await expect(
        resolveDriveIdByName(graph, "SITE1", "Missing")
      ).rejects.toThrow(/drive not found.*Documents, Shared/i);
    });
  });

  describe("ensureFolderInDriveRoot", () => {
    it("creates the folder (sanitizing the name) and returns it", async () => {
      graphMock
        .onPost("/drives/D1/root/children")
        .reply(201, { id: "F1", name: "Ticket- Folder-X", webUrl: "https://sp/F1" });

      const folder = await ensureFolderInDriveRoot(graph, "D1", "Ticket: Folder/X");
      expect(folder.id).toBe("F1");

      const body = JSON.parse(graphMock.history.post[0].data);
      expect(body.name).toBe("Ticket- Folder-X"); // illegal chars -> "-"
      expect(body.folder).toEqual({});
      expect(body["@microsoft.graph.conflictBehavior"]).toBe("fail");
    });

    it("reuses the existing folder on a 409 conflict", async () => {
      graphMock.onPost("/drives/D1/root/children").reply(409);
      graphMock
        .onGet(/\/drives\/D1\/root:\//)
        .reply(200, { id: "F1", name: "Existing", webUrl: "https://sp/F1" });

      const folder = await ensureFolderInDriveRoot(graph, "D1", "Existing");
      expect(folder.id).toBe("F1");
      expect(folder.webUrl).toBe("https://sp/F1");
    });

    it("rethrows non-409 errors", async () => {
      graphMock.onPost("/drives/D1/root/children").reply(500);
      await expect(
        ensureFolderInDriveRoot(graph, "D1", "Boom")
      ).rejects.toBeTruthy();
    });
  });

  describe("uploadFileToDriveFolder — small file (single content PUT)", () => {
    it("PUTs the bytes to the content endpoint and returns filename + webUrl", async () => {
      graphMock
        .onPut(/\/drives\/D1\/items\/F1:\/.*:\/content/)
        .reply(200, { webUrl: "https://sp/F1/doc.pdf" });

      const link = await uploadFileToDriveFolder({
        graph,
        driveId: "D1",
        parentFolderItemId: "F1",
        filename: "doc.pdf",
        bytes: bytes([1, 2, 3]),
      });

      expect(link).toEqual({ filename: "doc.pdf", webUrl: "https://sp/F1/doc.pdf" });
      // No upload session for a small file.
      expect(graphMock.history.post.filter((p) => /createUploadSession/.test(p.url!))).toHaveLength(0);
    });

    it("sanitizes the filename before uploading", async () => {
      graphMock.onPut(/:\/content/).reply(200, { webUrl: "https://sp/F1/clean" });

      const link = await uploadFileToDriveFolder({
        graph,
        driveId: "D1",
        parentFolderItemId: "F1",
        filename: "in:valid/name.pdf",
        bytes: bytes([1]),
      });

      expect(link.filename).toBe("in-valid-name.pdf");
      expect(graphMock.history.put[0].url).toContain("in-valid-name.pdf");
    });

    it("throws when the content upload returns no webUrl", async () => {
      graphMock.onPut(/:\/content/).reply(200, {});
      await expect(
        uploadFileToDriveFolder({
          graph,
          driveId: "D1",
          parentFolderItemId: "F1",
          filename: "doc.pdf",
          bytes: bytes([1]),
        })
      ).rejects.toThrow(/webUrl missing/i);
    });
  });

  describe("uploadFileToDriveFolder — large file (chunked upload session)", () => {
    // A file larger than one chunk forces the session path + multiple PUTs.
    const big = new Uint8Array(CHUNK_SIZE + 5);

    it("creates a session and PUTs the bytes in fragments", async () => {
      graphMock
        .onPost(/\/drives\/D1\/items\/F1:\/.*:\/createUploadSession/)
        .reply(200, { uploadUrl: "https://upload.example/session-1" });
      // Each fragment PUT resolves; the last carries the DriveItem webUrl.
      defaultMock
        .onPut("https://upload.example/session-1")
        .reply(202, {})
        .onPut("https://upload.example/session-1")
        .reply(201, { webUrl: "https://sp/F1/big.bin" });

      const link = await uploadFileToDriveFolder({
        graph,
        driveId: "D1",
        parentFolderItemId: "F1",
        filename: "big.bin",
        bytes: big,
      });

      expect(link.webUrl).toBe("https://sp/F1/big.bin");
      expect(defaultMock.history.put).toHaveLength(2); // 2 fragments
      // First fragment carries a Content-Range starting at byte 0.
      expect(defaultMock.history.put[0].headers?.["Content-Range"]).toMatch(/^bytes 0-/);
    });

    it("throws when the session has no uploadUrl", async () => {
      graphMock.onPost(/createUploadSession/).reply(200, {});
      await expect(
        uploadFileToDriveFolder({
          graph,
          driveId: "D1",
          parentFolderItemId: "F1",
          filename: "big.bin",
          bytes: big,
        })
      ).rejects.toThrow(/missing uploadUrl/i);
    });
  });
});

describe("uploadAttachmentsToSharePoint (full pipeline)", () => {
  let graph: AxiosInstance;
  let graphMock: MockAdapter;
  let defaultMock: MockAdapter;
  let createSpy: jest.SpyInstance;

  const config = {
    graphBaseUrl: GRAPH_BASE,
    siteUrl: SITE_URL,
    libraryName: "Documents",
    tenantId: "t",
    clientId: "c",
  };

  beforeEach(() => {
    graph = axios.create();
    graphMock = new MockAdapter(graph);
    defaultMock = new MockAdapter(axios);
    // createGraphClient() will receive this pre-wired instance.
    createSpy = jest.spyOn(axios, "create").mockReturnValue(graph);
  });

  afterEach(() => {
    graphMock.restore();
    defaultMock.restore();
    createSpy.mockRestore();
  });

  it("returns null without touching Graph when there are no attachments", async () => {
    const result = await uploadAttachmentsToSharePoint({
      config,
      attachments: [],
      folderName: "OLD1 - john@example.com",
    });
    expect(result).toBeNull();
    expect(graphMock.history.get).toHaveLength(0);
  });

  it("resolves site+drive, ensures the folder, and uploads every (small) attachment", async () => {
    graphMock
      .onGet("/sites/contoso.sharepoint.com:/sites/Helpdesk")
      .reply(200, { id: "SITE1" });
    graphMock
      .onGet("/sites/SITE1/drives")
      .reply(200, { value: [{ id: "D1", name: "Documents" }] });
    graphMock
      .onPost("/drives/D1/root/children")
      .reply(201, { id: "F1", name: "OLD1 - john@example.com", webUrl: "https://sp/OLD1" });
    // Small files go through the authorized content PUT (no upload session).
    graphMock
      .onPut(/\/drives\/D1\/items\/F1:\/.*:\/content/)
      .reply(200, { webUrl: "https://sp/OLD1/file" });

    const result = await uploadAttachmentsToSharePoint({
      config,
      attachments: [uploadItem("a.pdf", bytes([1, 2, 3])), uploadItem("b.pdf", bytes([4, 5]))],
      folderName: "OLD1 - john@example.com",
    });

    expect(result).not.toBeNull();
    expect(result!.folderWebUrl).toBe("https://sp/OLD1");
    expect(result!.uploaded.map((u) => u.filename)).toEqual(["a.pdf", "b.pdf"]);
    // Two content PUTs, no upload sessions.
    expect(graphMock.history.put.filter((p) => /:\/content/.test(p.url!))).toHaveLength(2);
    expect(graphMock.history.post.filter((p) => /createUploadSession/.test(p.url!))).toHaveLength(0);
  });

  it("rejects when the configured library/drive is not found", async () => {
    graphMock
      .onGet("/sites/contoso.sharepoint.com:/sites/Helpdesk")
      .reply(200, { id: "SITE1" });
    graphMock
      .onGet("/sites/SITE1/drives")
      .reply(200, { value: [{ id: "D9", name: "SomethingElse" }] });

    await expect(
      uploadAttachmentsToSharePoint({
        config,
        attachments: [uploadItem("a.pdf", bytes([1]))],
        folderName: "F",
      })
    ).rejects.toThrow(/drive not found/i);
  });

  it("skips an attachment whose fetch/upload fails but uploads the rest", async () => {
    graphMock
      .onGet("/sites/contoso.sharepoint.com:/sites/Helpdesk")
      .reply(200, { id: "SITE1" });
    graphMock
      .onGet("/sites/SITE1/drives")
      .reply(200, { value: [{ id: "D1", name: "Documents" }] });
    graphMock
      .onPost("/drives/D1/root/children")
      .reply(201, { id: "F1", name: "F", webUrl: "https://sp/F" });
    graphMock
      .onPut(/\/drives\/D1\/items\/F1:\/.*:\/content/)
      .reply(200, { webUrl: "https://sp/F/good" });

    const bad: SharePointUploadItem = {
      name: "bad.pdf",
      getBytes: async () => {
        throw new Error("attachment fetch 404");
      },
    };

    const result = await uploadAttachmentsToSharePoint({
      config,
      attachments: [bad, uploadItem("good.pdf", bytes([1, 2, 3]))],
      folderName: "F",
    });

    // The bad attachment is skipped; the good one still uploads.
    expect(result!.uploaded.map((u) => u.filename)).toEqual(["good.pdf"]);
  });
});
