import { AxiosInstance } from "axios";
import { envPositiveNumber } from "./env";
import { formatAxiosError, type StepErrorFn, type StepFn } from "./logging";
import type { OutboundMailAttachment } from "./graph-mail";

const DEFAULT_OUTBOUND_INLINE_ATTACHMENT_MAX_BYTES = 2_500_000;

type HelpdeskEventFile = {
  url?: string;
  name?: string;
  size?: number;
  type?: string;
};

export type PreparedOutboundAttachments = {
  attachments: OutboundMailAttachment[];
  totalFiles: number;
  attachedFiles: number;
  skippedFiles: number;
};

function outboundInlineAttachmentMaxBytes(): number {
  return envPositiveNumber(
    process.env.OUTBOUND_INLINE_ATTACHMENT_MAX_BYTES,
    DEFAULT_OUTBOUND_INLINE_ATTACHMENT_MAX_BYTES
  );
}

/**
 * Remove the boilerplate Helpdesk attachment block when direct file attachments are present.
 *
 * Expected shape in message text:
 *   ---
 *   Attachments:
 *   - foo.pdf
 *   - bar.docx
 */
export function stripHelpdeskAttachmentBlock(text: string): string {
  const lines = text.split(/\r?\n/);
  const attachHeaderIndex = lines.findIndex((line) => /^attachments:\s*$/i.test(line.trim()));
  if (attachHeaderIndex < 0) return text;

  const tail = lines.slice(attachHeaderIndex + 1);
  const nonEmptyTail = tail.filter((line) => line.trim().length > 0);
  if (!nonEmptyTail.length) return text;

  const tailLooksLikeAttachmentList = nonEmptyTail.every((line) => {
    const t = line.trim();
    return /^[-*•]\s+/.test(t) || /^https?:\/\//i.test(t);
  });
  if (!tailLooksLikeAttachmentList) return text;

  let cutFrom = attachHeaderIndex;
  while (cutFrom > 0 && /^[-_]{3,}\s*$/.test(lines[cutFrom - 1].trim())) {
    cutFrom -= 1;
  }

  const cleaned = lines.slice(0, cutFrom).join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
  return cleaned;
}

/**
 * Best-effort conversion of Helpdesk event files into Graph sendMail attachments.
 *
 * Stage 1 behavior: only files up to OUTBOUND_INLINE_ATTACHMENT_MAX_BYTES are attached directly.
 * Larger files (or failed fetches) are skipped so the email can still be sent with existing links.
 */
export async function prepareOutboundAttachments(opts: {
  helpdesk: AxiosInstance;
  files: HelpdeskEventFile[];
  step: StepFn;
  stepError: StepErrorFn;
  context: "submitter" | "notice";
}): Promise<PreparedOutboundAttachments> {
  const { helpdesk, step, stepError, context } = opts;
  const maxBytes = outboundInlineAttachmentMaxBytes();

  const files = (opts.files ?? []).filter((f) => !!f?.url && !!f?.name);
  const out: OutboundMailAttachment[] = [];
  let skipped = 0;

  for (const file of files) {
    const name = String(file.name ?? "attachment");
    const sourceSize = typeof file.size === "number" && file.size >= 0 ? file.size : null;
    if (sourceSize !== null && sourceSize > maxBytes) {
      skipped += 1;
      step("Outbound attachments: skipped (over stage-1 inline size cap)", {
        context,
        name,
        size: sourceSize,
        maxBytes,
      });
      continue;
    }

    try {
      const res = await helpdesk.get<ArrayBuffer>(String(file.url), {
        responseType: "arraybuffer",
      });
      const bytes = Buffer.from(res.data as ArrayBuffer);
      if (bytes.length > maxBytes) {
        skipped += 1;
        step("Outbound attachments: skipped after download (over stage-1 inline size cap)", {
          context,
          name,
          size: bytes.length,
          maxBytes,
        });
        continue;
      }
      out.push({
        name,
        contentType: String(file.type ?? "application/octet-stream"),
        contentBytes: bytes.toString("base64"),
      });
    } catch (e) {
      skipped += 1;
      stepError("Outbound attachments: download failed, keeping link fallback", e, {
        context,
        name,
        url: file.url,
        error: formatAxiosError(e),
      });
    }
  }

  return {
    attachments: out,
    totalFiles: files.length,
    attachedFiles: out.length,
    skippedFiles: skipped,
  };
}
