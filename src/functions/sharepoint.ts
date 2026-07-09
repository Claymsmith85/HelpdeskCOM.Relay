// src/sharepoint.ts
import axios, { AxiosError, AxiosInstance } from "axios";
import { createGraphClient, GRAPH_TRANSFER_TIMEOUT_MS, type GraphAuthConfig } from "./graph-client";

// Re-exported so existing importers (and tests) can keep sourcing the shared Graph
// client from sharepoint.ts after it was promoted to graph-client.ts.
export { createGraphClient, getGraphToken } from "./graph-client";

// #region Public Types

export type SharePointConfig = GraphAuthConfig & {
  siteUrl: string; // SPO site URL
  libraryName: string; // drive name
};

/** One file to upload; bytes are fetched lazily so only one file is in memory at a time. */
export type SharePointUploadItem = {
  name: string;
  getBytes: () => Promise<Uint8Array>;
};

export type UploadedAttachmentLink = {
  filename: string;
  webUrl: string;
};

export type UploadResult = {
  folderWebUrl: string;
  uploaded: UploadedAttachmentLink[];
};

// Upload-session fragment size: 10 MiB. A multiple of 320 KiB and well under Graph's 60 MiB
// per-fragment cap. Files at or under this size use a single simple PUT instead.
const UPLOAD_CHUNK_SIZE = 10 * 1024 * 1024;

// #endregion

// #region Upload Helpers

type GraphDriveItem = { id: string; name: string; webUrl?: string };

/**
 * Upload a single file's bytes into an existing folder item within a Drive.
 * - Files at or under UPLOAD_CHUNK_SIZE: one authorized content PUT (covers 0-byte files).
 * - Larger files: an upload session written in ≤ UPLOAD_CHUNK_SIZE fragments (Graph rejects
 *   fragments over 60 MiB, so a single PUT cannot carry big files).
 * Returns filename + resulting webUrl.
 */
export async function uploadFileToDriveFolder(opts: {
  graph: AxiosInstance;
  driveId: string;
  parentFolderItemId: string;
  filename: string;
  bytes: Uint8Array;
}): Promise<UploadedAttachmentLink> {
  const { graph, driveId, parentFolderItemId, filename, bytes } = opts;

  const safeFilename = sanitizeSharePointName(filename) || "attachment";
  const itemPath = `/drives/${driveId}/items/${parentFolderItemId}:/${encodeURIComponent(
    safeFilename
  )}`;
  const size = bytes.byteLength;

  // Small file: single authorized content PUT.
  if (size <= UPLOAD_CHUNK_SIZE) {
    const res = await graph.put<GraphDriveItem>(
      `${itemPath}:/content?@microsoft.graph.conflictBehavior=rename`,
      bytes,
      {
        headers: { "Content-Type": "application/octet-stream" },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: GRAPH_TRANSFER_TIMEOUT_MS,
      }
    );
    const webUrl = res.data?.webUrl;
    if (!webUrl) {
      throw new Error("Graph: simple upload completed but DriveItem webUrl missing");
    }
    return { filename: safeFilename, webUrl };
  }

  // Large file: chunked upload session.
  const sessionRes = await graph.post<{ uploadUrl: string }>(
    `${itemPath}:/createUploadSession`,
    { item: { "@microsoft.graph.conflictBehavior": "rename", name: safeFilename } }
  );
  const uploadUrl = sessionRes.data?.uploadUrl;
  if (!uploadUrl) {
    throw new Error("Graph: missing uploadUrl from createUploadSession");
  }

  let start = 0;
  let lastData: any;
  while (start < size) {
    const end = Math.min(start + UPLOAD_CHUNK_SIZE, size);
    const chunk = bytes.subarray(start, end);
    // Upload-session PUTs go to the pre-authorized session URL with NO auth header.
    const putRes = await axios.put(uploadUrl, chunk, {
      headers: {
        "Content-Length": String(chunk.byteLength),
        "Content-Range": `bytes ${start}-${end - 1}/${size}`,
        "Content-Type": "application/octet-stream",
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: GRAPH_TRANSFER_TIMEOUT_MS,
      // 202 between fragments, 200/201 on the final fragment.
      validateStatus: (s) => s >= 200 && s < 300,
    });
    lastData = putRes.data;
    start = end;
  }

  const webUrl = (lastData as any)?.webUrl as string | undefined;
  if (!webUrl) {
    throw new Error("Graph: chunked upload completed but DriveItem webUrl missing");
  }
  return { filename: safeFilename, webUrl };
}

/**
 * Upload a set of files into a folder created (or reused) at the drive root.
 * Returns folder webUrl and individual attachment webUrls.
 *
 * Behavior:
 * - If there are no attachments, returns null
 * - Creates a Graph client, resolves site + drive by name
 * - Ensures a folder exists in drive root (create or reuse)
 * - Fetches and uploads each file sequentially (one file's bytes in memory at a time)
 */
export async function uploadAttachmentsToSharePoint(opts: {
  config: SharePointConfig;
  attachments: SharePointUploadItem[];
  folderName: string;
  log?: (...args: any[]) => void;
}): Promise<UploadResult | null> {
  const { config, attachments, folderName, log } = opts;

  if (!attachments || attachments.length === 0) return null;

  log?.("SharePoint: createGraphClient begin");
  const graph = await createGraphClient(config, log);
  log?.("SharePoint: createGraphClient complete");

  log?.("SharePoint: resolveSiteId begin", { siteUrl: config.siteUrl });
  const siteId = await resolveSiteId(graph, config.siteUrl);
  log?.("SharePoint: resolveSiteId complete", { siteId });

  log?.("SharePoint: resolveDriveIdByName begin", { library: config.libraryName });
  const driveId = await resolveDriveIdByName(graph, siteId, config.libraryName);
  log?.("SharePoint: resolveDriveIdByName complete", { driveId });

  // ensureFolderInDriveRoot sanitizes the name itself (it owns that rule), so pass it raw.
  log?.("SharePoint: ensureFolderInDriveRoot begin", { folderName });
  const folder = await ensureFolderInDriveRoot(graph, driveId, folderName);
  log?.("SharePoint: ensureFolderInDriveRoot complete", {
    folderId: folder.id,
    folder: folder.name,
    folderWebUrl: folder.webUrl,
  });

  if (!folder.webUrl) {
    throw new Error("Graph: folder created/resolved but webUrl missing");
  }

  const uploaded: UploadedAttachmentLink[] = [];

  for (const item of attachments) {
    const filename = item.name || "attachment";

    // Per-file: one bad attachment (e.g. a fetch that 404s, or a non-file attachment that
    // slipped the metadata filter) is skipped and logged; its siblings still upload.
    try {
      log?.("SharePoint: uploadFileToDriveFolder begin", { filename });
      const bytes = await item.getBytes();
      const link = await uploadFileToDriveFolder({
        graph,
        driveId,
        parentFolderItemId: folder.id,
        filename,
        bytes,
      });
      uploaded.push(link);
      log?.("SharePoint: uploadFileToDriveFolder complete", {
        filename: link.filename,
        webUrl: link.webUrl,
      });
    } catch (e) {
      log?.("SharePoint: attachment upload failed (skipped)", {
        filename,
        error: (e as Error)?.message ?? String(e),
      });
    }
  }

  return { folderWebUrl: folder.webUrl, uploaded };
}

// #endregion

// #region Graph SharePoint Primitives

/**
 * Parse a SharePoint site URL into hostname + path components needed by Graph /sites lookup.
 */
function parseSharePointSiteUrl(siteUrl: string): {
  hostname: string;
  sitePath: string;
} {
  const u = new URL(siteUrl);
  return { hostname: u.hostname, sitePath: u.pathname };
}

/**
 * Resolve a SharePoint Site ID from the full site URL.
 */
export async function resolveSiteId(
  graph: AxiosInstance,
  siteUrl: string
): Promise<string> {
  const { hostname, sitePath } = parseSharePointSiteUrl(siteUrl);
  const res = await graph.get<{ id: string }>(`/sites/${hostname}:${sitePath}`);
  if (!res.data?.id) {
    throw new Error("Graph: could not resolve SharePoint site id");
  }
  return res.data.id;
}

type GraphDrive = { id: string; name: string };

/**
 * Resolve a Drive ID by matching drive display name (libraryName) on the site.
 */
export async function resolveDriveIdByName(
  graph: AxiosInstance,
  siteId: string,
  driveName: string
): Promise<string> {
  const res = await graph.get<{ value: GraphDrive[] }>(`/sites/${siteId}/drives`);
  const drives = res.data?.value ?? [];
  const match = drives.find(
    (d) => (d.name ?? "").toLowerCase() === driveName.toLowerCase()
  );
  if (!match?.id) {
    throw new Error(
      `Graph: drive not found on site. Wanted "${driveName}", saw: ${drives
        .map((d) => d.name)
        .join(", ")}`
    );
  }
  return match.id;
}

/**
 * Ensure a folder exists in the drive root.
 * - Attempts to create (conflictBehavior=fail)
 * - If already exists (409), looks it up and returns it
 */
export async function ensureFolderInDriveRoot(
  graph: AxiosInstance,
  driveId: string,
  folderName: string
): Promise<GraphDriveItem> {
  const safeName = sanitizeSharePointName(folderName);

  try {
    const res = await graph.post<GraphDriveItem>(
      `/drives/${driveId}/root/children`,
      {
        name: safeName,
        folder: {},
        "@microsoft.graph.conflictBehavior": "fail",
      }
    );
    return res.data;
  } catch (e) {
    const err = e as AxiosError;
    if (err.response?.status === 409) {
      const lookup = await graph.get<GraphDriveItem>(
        `/drives/${driveId}/root:/${encodeURIComponent(safeName)}`
      );
      return lookup.data;
    }
    throw e;
  }
}

// #endregion

// #region Small Helpers

/**
 * Sanitize names to be safe for SharePoint/OneDrive item names.
 */
export function sanitizeSharePointName(v: string): string {
  return String(v ?? "")
    .replace(/["*:<>?/\\|]/g, "-")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// #endregion
