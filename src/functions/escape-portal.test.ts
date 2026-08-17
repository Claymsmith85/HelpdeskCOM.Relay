// Unit tests for the Escape Portal submission detector (escape-portal.ts).
//
// What these lock in:
//   - the full detection ladder: EVERY leg must pass (monitored from, from == to, original
//     subject, portal phrase, plausible Email ID) or the extractor returns null
//   - extraction details: the Email ID address, the template's "Contact Name::" double-colon
//     quirk, a missing/blank/garbled Email ID falling through, an empty field never swallowing
//     the next line's token
//   - alias-domain drain-mailbox spellings still detect (routing.ts's canonical-key match)

import { extractEscapePortalRequester } from "./escape-portal";

const MAILBOX = "escape@corespecialty.com";

// Condensed from docs/example.txt — the portal's referral-notification template.
const PORTAL_BODY = [
  "This is not a Quote.",
  "",
  "Dear Emily Koppang:",
  "",
  "Thank you for submitting this application via the StarStone Escape Portal. An underwriter will review your application.",
  "",
  "Account Information",
  "",
  "Account Name: CITY OF DALLAS SKATING RINK dba SOUTHERN SKATES ROLLER RINK",
  "Quote Number: ESC00595760Q-05",
  "",
  "Contact Information",
  "",
  "Brokerage Name: RSG Specialty, LLC - Chicago, IL- USRT100",
  "Broker Contact: Emily Koppang",
  "Broker Email Address: emily.koppang@rtspecialty.com",
  "",
  "Producer Information",
  "",
  "Contact Name:: Emily Koppang",
  "Phone Number: 312-292-9452",
  "Email ID: emily.koppang@rtspecialty.com",
  "",
  "This is not a Quote.",
].join("\n");

function portalMsg(over: Partial<{ subject: string; fromAddress: string; toAddress: string | null; text: string }> = {}) {
  return {
    subject: "Referral Notification - ESC00595760Q-05",
    fromAddress: MAILBOX,
    toAddress: MAILBOX,
    text: PORTAL_BODY,
    ...over,
  };
}

beforeEach(() => {
  process.env.MAILBOX_ADDRESSES = "escape@corespecialty.com,escapereferrals@corespecialty.com";
});
afterEach(() => {
  delete process.env.MAILBOX_ADDRESSES;
  delete process.env.RELAY_IN_SCOPE_DOMAINS;
});

describe("extractEscapePortalRequester — detection", () => {
  it("extracts the Email ID submitter and Contact Name from the example template", () => {
    expect(extractEscapePortalRequester(portalMsg())).toEqual({
      email: "emily.koppang@rtspecialty.com",
      name: "Emily Koppang",
    });
  });

  it("detects a drain mailbox addressed under an alias company domain (from == to on the alias)", () => {
    const alias = "escape@corespecialtyins.com"; // not listed verbatim in MAILBOX_ADDRESSES
    expect(
      extractEscapePortalRequester(portalMsg({ fromAddress: alias, toAddress: alias }))
    ).toEqual({ email: "emily.koppang@rtspecialty.com", name: "Emily Koppang" });
  });

  it("is case-insensitive on the from/to comparison", () => {
    expect(
      extractEscapePortalRequester(
        portalMsg({ fromAddress: "Escape@CoreSpecialty.com", toAddress: MAILBOX })
      )
    ).not.toBeNull();
  });

  it("returns null when the sender is not a monitored mailbox — even self-addressed", () => {
    expect(
      extractEscapePortalRequester(
        portalMsg({ fromAddress: "spoof@example.com", toAddress: "spoof@example.com" })
      )
    ).toBeNull();
  });

  it("returns null when from and to differ (a human forwarded the portal mail in)", () => {
    expect(
      extractEscapePortalRequester(portalMsg({ fromAddress: MAILBOX, toAddress: "other@corespecialty.com" }))
    ).toBeNull();
  });

  it("returns null when the to address is missing", () => {
    expect(extractEscapePortalRequester(portalMsg({ toAddress: null }))).toBeNull();
  });

  it.each(["RE: Referral Notification", "re: anything", "FW: Referral", "Fwd: Referral", "  RE : Referral"])(
    "returns null for reply/forward subject %p",
    (subject) => {
      expect(extractEscapePortalRequester(portalMsg({ subject }))).toBeNull();
    }
  );

  it("returns null when the subject carries a relay [#ref] tag (existing thread)", () => {
    expect(
      extractEscapePortalRequester(portalMsg({ subject: "Referral Notification [#AB12]" }))
    ).toBeNull();
  });

  it("returns null without the portal signature phrase", () => {
    expect(
      extractEscapePortalRequester(
        portalMsg({ text: PORTAL_BODY.replace(/StarStone Escape Portal/, "web form") })
      )
    ).toBeNull();
  });

  it("does not treat 'portal escape' word order or a lookalike subject-only phrase as a match", () => {
    expect(
      extractEscapePortalRequester(portalMsg({ text: "submitted via the portal escape hatch\nEmail ID: a@b.co" }))
    ).toBeNull();
  });
});

describe("extractEscapePortalRequester — Email ID extraction", () => {
  it("returns null when the Email ID line is absent entirely", () => {
    expect(
      extractEscapePortalRequester(
        portalMsg({ text: PORTAL_BODY.replace(/^Email ID:.*$/m, "") })
      )
    ).toBeNull();
  });

  it("returns null when the Email ID field is blank — never swallowing the next line", () => {
    expect(
      extractEscapePortalRequester(
        portalMsg({
          text: PORTAL_BODY.replace(
            /^Email ID:.*$/m,
            "Email ID:\nBackup Email: backup@rtspecialty.com"
          ),
        })
      )
    ).toBeNull();
  });

  it("returns null when the Email ID value is not a plausible address", () => {
    expect(
      extractEscapePortalRequester(
        portalMsg({ text: PORTAL_BODY.replace(/^Email ID:.*$/m, "Email ID: not-an-email") })
      )
    ).toBeNull();
  });

  it("tolerates a doubled colon on the Email ID label and strips a trailing period", () => {
    const detected = extractEscapePortalRequester(
      portalMsg({ text: PORTAL_BODY.replace(/^Email ID:.*$/m, "Email ID:: broker@example.com.") })
    );
    expect(detected?.email).toBe("broker@example.com");
  });

  it("still detects with a single-colon Contact Name, and without one at all", () => {
    const single = extractEscapePortalRequester(
      portalMsg({ text: PORTAL_BODY.replace("Contact Name::", "Contact Name:") })
    );
    expect(single).toEqual({ email: "emily.koppang@rtspecialty.com", name: "Emily Koppang" });

    const none = extractEscapePortalRequester(
      portalMsg({ text: PORTAL_BODY.replace(/^Contact Name::.*$/m, "") })
    );
    expect(none).toEqual({ email: "emily.koppang@rtspecialty.com", name: null });
  });

  it("a blank Contact Name never swallows the next line", () => {
    const detected = extractEscapePortalRequester(
      portalMsg({ text: PORTAL_BODY.replace(/^Contact Name::.*$/m, "Contact Name::") })
    );
    expect(detected).toEqual({ email: "emily.koppang@rtspecialty.com", name: null });
  });
});
