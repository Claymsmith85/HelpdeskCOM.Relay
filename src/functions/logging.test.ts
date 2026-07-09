// Guards the one property of formatAxiosError that matters in production: a server's error body
// must reach the log intact. The Functions host renders a logged object with util.inspect's default
// depth of 2, so a nested `response.data` used to print as `responseData: { error: [Object] }` --
// dropping the API's reason (e.g. Helpdesk's 422 on POST /agents) exactly when it was needed.
import { inspect } from "util";
import { formatAxiosError } from "./logging";

// Build an axios-shaped error without a live request.
function axiosErrorWith(data: unknown) {
  return Object.assign(new Error("Request failed with status code 422"), {
    name: "AxiosError",
    code: "ERR_BAD_REQUEST",
    isAxiosError: true,
    config: { url: "/agents", method: "post" },
    response: { status: 422, statusText: "Unprocessable Entity", data },
  });
}

describe("formatAxiosError", () => {
  it("keeps a nested response body readable at the host's default inspect depth", () => {
    const err = axiosErrorWith({
      error: { type: "validation", message: "agent with this email already exists" },
    });

    // Exactly how the host logs it: an object nested one level under the step payload.
    const rendered = inspect({ email: "a@b.com", error: formatAxiosError(err) });

    expect(rendered).not.toContain("[Object]");
    expect(rendered).toContain("agent with this email already exists");
  });

  it("projects the diagnostic fields off an axios error", () => {
    const out = formatAxiosError(axiosErrorWith({ error: "nope" }));

    expect(out).toMatchObject({
      message: "Request failed with status code 422",
      name: "AxiosError",
      code: "ERR_BAD_REQUEST",
      status: 422,
      statusText: "Unprocessable Entity",
      url: "/agents",
      method: "post",
      responseData: '{"error":"nope"}',
    });
  });

  it("truncates a huge error body instead of flooding the log stream", () => {
    const out = formatAxiosError(axiosErrorWith({ html: "x".repeat(50_000) }));

    expect(out.responseData.length).toBeLessThan(2_200);
    expect(out.responseData).toContain("[truncated");
  });

  it("omits responseData when there is no response body, and degrades to a plain Error", () => {
    expect(formatAxiosError(axiosErrorWith(undefined)).responseData).toBeUndefined();

    const plain = formatAxiosError(new Error("boom"));
    expect(plain).toMatchObject({ message: "boom", responseData: undefined });
  });

  it("survives a circular response body (safeJson falls back to String)", () => {
    const circular: any = { a: 1 };
    circular.self = circular;

    expect(() => formatAxiosError(axiosErrorWith(circular))).not.toThrow();
    expect(formatAxiosError(axiosErrorWith(circular)).responseData).toBeTruthy();
  });
});
