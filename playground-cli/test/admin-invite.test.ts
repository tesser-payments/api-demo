import { describe, expect, mock, spyOn, test } from "bun:test";
import { NonInteractiveInteraction } from "../src/interaction.ts";
import { Output } from "../src/output.ts";
import { runAdminInvite } from "../src/workflows/admin-invite.ts";

function runtime(environment: Record<string, string | undefined>) {
  return {
    environment,
    interaction: new NonInteractiveInteraction(),
    output: new Output("json", true),
  };
}

describe("admin invite", () => {
  test("creates an invitation with the configured admin secret", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImplementation = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        return Response.json(
          {
            message: "Invitation sent successfully",
            data: {
              auth0UserId: "auth0|user-123",
              email: "invited@example.com",
            },
          },
          { status: 201, statusText: "Created" },
        );
      },
    ) as unknown as typeof fetch;
    const standardOutput = spyOn(process.stdout, "write").mockImplementation(
      () => true,
    );
    const errorOutput = spyOn(process.stderr, "write").mockImplementation(
      () => true,
    );

    await runAdminInvite(
      runtime({
        TESSER_BASE_URL: "https://api.tesser.xyz",
        ADMIN_API_SECRET: "admin-secret",
      }),
      "invited@example.com",
      fetchImplementation,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://api.tesser.xyz/v1/admin/invitations",
    );
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get("x-admin-secret")).toBe("admin-secret");
    expect(headers.get("Authorization")).toBeNull();
    expect(calls[0]!.init?.body).toBe(
      JSON.stringify({ email: "invited@example.com" }),
    );
    expect(String(standardOutput.mock.calls.at(-1)?.[0])).toContain(
      "Invitation sent successfully",
    );
    expect(String(errorOutput.mock.calls[0]?.[0])).toContain(
      "Invitation email: invited@example.com",
    );
    const verboseOutput = String(errorOutput.mock.calls);
    expect(verboseOutput).toContain('"x-admin-secret": "<redacted>"');
    expect(verboseOutput).not.toContain('"x-admin-secret": "admin-secret"');
    standardOutput.mockRestore();
    errorOutput.mockRestore();
  });

  test("requires the admin secret in non-interactive mode", async () => {
    await expect(
      runAdminInvite(
        runtime({ TESSER_BASE_URL: "https://api.tesser.xyz" }),
        "invited@example.com",
      ),
    ).rejects.toThrow("Admin API secret must be provided");
  });

  test("rejects an invalid email before calling the API", async () => {
    const fetchImplementation = mock(async () => Response.json({}));

    await expect(
      runAdminInvite(
        runtime({
          TESSER_BASE_URL: "https://api.tesser.xyz",
          ADMIN_API_SECRET: "admin-secret",
        }),
        "not-an-email",
        fetchImplementation as unknown as typeof fetch,
      ),
    ).rejects.toThrow("Email address must be valid");
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
