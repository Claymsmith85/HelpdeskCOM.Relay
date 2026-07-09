// Tests for graph-directory.ts — the AAD group transitive-member reader. Graph is mocked with
// axios-mock-adapter on a plain instance (the function takes an injected client). No
// @azure/functions side effects.
import axios from "axios";
import MockAdapter from "axios-mock-adapter";
import { listGroupMemberUsers } from "./graph-directory";

describe("listGroupMemberUsers", () => {
  let graph: ReturnType<typeof axios.create>;
  let mock: MockAdapter;

  beforeEach(() => {
    graph = axios.create({ baseURL: "https://graph.microsoft.com/v1.0" });
    mock = new MockAdapter(graph);
  });
  afterEach(() => mock.restore());

  it("maps members, prefers mail over UPN, lowercases, and follows @odata.nextLink", async () => {
    // First page: relative path against the cast endpoint, returns a nextLink (absolute URL).
    mock
      .onGet(/\/groups\/G1\/transitiveMembers\/microsoft\.graph\.user/)
      .reply(200, {
        value: [
          { id: "1", displayName: "Alice", mail: "Alice@Corp.com", accountEnabled: true },
          { id: "2", displayName: "Bob", mail: null, userPrincipalName: "BOB@corp.com" },
        ],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/page2",
      });
    mock.onGet("https://graph.microsoft.com/v1.0/page2").reply(200, {
      value: [{ id: "3", displayName: "Cara", mail: "cara@corp.com", accountEnabled: false }],
    });

    const users = await listGroupMemberUsers(graph, "G1");

    expect(users).toEqual([
      { email: "alice@corp.com", name: "Alice", accountEnabled: true },
      { email: "bob@corp.com", name: "Bob", accountEnabled: true }, // missing accountEnabled -> enabled
      { email: "cara@corp.com", name: "Cara", accountEnabled: false }, // disabled flag preserved
    ]);
  });

  it("drops members with no email address", async () => {
    mock.onGet(/transitiveMembers/).reply(200, {
      value: [
        { id: "1", displayName: "NoMail", mail: null, userPrincipalName: null },
        { id: "2", displayName: "Has", mail: "has@corp.com" },
      ],
    });
    const users = await listGroupMemberUsers(graph, "G1");
    expect(users.map((u) => u.email)).toEqual(["has@corp.com"]);
  });

  it("falls back to the email when displayName is missing", async () => {
    mock.onGet(/transitiveMembers/).reply(200, {
      value: [{ id: "1", displayName: "", mail: "x@corp.com" }],
    });
    const [u] = await listGroupMemberUsers(graph, "G1");
    expect(u.name).toBe("x@corp.com");
  });

  it("returns [] for an empty group", async () => {
    mock.onGet(/transitiveMembers/).reply(200, { value: [] });
    expect(await listGroupMemberUsers(graph, "G1")).toEqual([]);
  });
});
