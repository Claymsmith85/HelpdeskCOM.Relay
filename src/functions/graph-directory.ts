// src/functions/graph-directory.ts
// Microsoft Graph **directory** reads for the AAD-security-group -> Helpdesk-team sync. Kept
// separate from graph-mail.ts because it is a different concern AND a different Graph permission:
// reading group membership needs `GroupMember.Read.All`, not the `Mail.*` scopes. Takes an injected
// Graph axios client (no module-load side effects), so it stays unit-testable with axios-mock-adapter.
import { AxiosInstance } from "axios";

export type DirectoryUser = {
  // Primary SMTP (`mail`), falling back to `userPrincipalName`; always lowercased so it can be
  // compared directly against a Helpdesk agent's `email`.
  email: string;
  // displayName (falls back to the email when AAD has no display name).
  name: string;
  // false only when AAD explicitly reports the account disabled (a disabled user should not be a
  // provisioned/active Helpdesk agent). Missing -> treated as enabled.
  accountEnabled: boolean;
};

type GraphUser = {
  id: string;
  "@odata.type"?: string;          // present on transitiveMembers entries; used to keep only users
  displayName?: string | null;
  mail?: string | null;
  userPrincipalName?: string | null;
  accountEnabled?: boolean | null;
};

type GraphUserPage = {
  value?: GraphUser[];
  "@odata.nextLink"?: string;
};

// `$select` keeps the payload small + stable. `transitiveMembers` flattens nested groups, and the
// `/microsoft.graph.user` cast drops non-user members (service principals, devices, nested groups)
// server-side so we never have to filter object types ourselves.
const MEMBER_SELECT = "id,displayName,mail,userPrincipalName";
const PAGE_SIZE = 999;

/**
 * List the **user** members of an AAD group (transitive — nested groups flattened) as
 * DirectoryUsers. Members with no email address are dropped (they can't be matched to a Helpdesk
 * agent). Follows `@odata.nextLink` to read every page. Throws on a Graph error so the caller can
 * isolate the failure per group (and, per the sync's safety rule, suppress that team's removals).
 */
export async function listGroupMemberUsers(
  graph: AxiosInstance,
  groupId: string,
  log?: (...args: any[]) => void
): Promise<DirectoryUser[]> {
  const first =
    `/groups/${encodeURIComponent(groupId)}/transitiveMembers` +
    `?$select=${MEMBER_SELECT}&$top=${PAGE_SIZE}`;

  const out: DirectoryUser[] = [];
  let next: string | undefined = first;
  let pages = 0;
  let returned = 0;       // total member objects Graph returned (all types)
  let nonUser = 0;        // members skipped for not being users

  while (next) {
    const res = await graph.get<GraphUserPage>(next);
    const batch = res.data?.value ?? [];
    returned += batch.length;
    for (const u of batch) {
      if (u["@odata.type"] && u["@odata.type"] !== "#microsoft.graph.user") {
        nonUser++;
        continue; // service principal, device, or (shouldn't happen transitively) nested group
      }
      const email = (u.mail ?? u.userPrincipalName ?? "").trim().toLowerCase();
      if (!email) continue;
      out.push({
        email,
        name: (u.displayName ?? "").trim() || email,
        accountEnabled: u.accountEnabled !== false,
      });
    }
    pages++;
    next = res.data?.["@odata.nextLink"];
  }

  log?.("Group members listed", { groupId, users: out.length, returned, nonUser, pages, first });
  return out;
}