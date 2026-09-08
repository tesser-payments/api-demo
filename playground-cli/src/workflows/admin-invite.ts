import { z } from "zod";
import { firstValue, positiveNumber } from "../config.ts";
import { ApiError, UsageError } from "../errors.ts";
import { parseResponseBody } from "../http.ts";
import type { Runtime } from "../runtime.ts";

type AdminInviteRuntime = Pick<Runtime, "environment" | "interaction" | "output">;

const emailSchema = z.string().trim().email();
const urlSchema = z.string().url();

export async function runAdminInvite(
  runtime: AdminInviteRuntime,
  emailInput: string | undefined,
  fetchImplementation: typeof fetch = fetch,
): Promise<void> {
  const emailValue = await runtime.interaction.text("Email address", emailInput);
  const emailResult = emailSchema.safeParse(emailValue);
  if (!emailResult.success) {
    throw new UsageError("Email address must be valid");
  }
  const baseUrlValue = firstValue(runtime.environment, "TESSER_BASE_URL");
  const baseUrlResult = urlSchema.safeParse(baseUrlValue);
  if (!baseUrlResult.success) {
    throw new UsageError("TESSER_BASE_URL must be a valid URL");
  }
  const adminSecret = await runtime.interaction.secret(
    "Admin API secret",
    firstValue(runtime.environment, "ADMIN_API_SECRET"),
  );
  const timeoutSeconds = positiveNumber(
    firstValue(runtime.environment, "TESSER_TIMEOUT_SECONDS"),
    "TESSER_TIMEOUT_SECONDS",
    30,
  );
  const email = emailResult.data;
  const url = new URL(
    "v1/admin/invitations",
    `${baseUrlResult.data.replace(/\/$/, "")}/`,
  );
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "x-admin-secret": adminSecret,
  };
  const body = { email };

  runtime.output.info(`Invitation email: ${email}`);
  await runtime.interaction.approve("Send this invitation?");

  let response: Response;
  try {
    response = await fetchImplementation(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
  } catch (cause) {
    throw new ApiError("Invite user request failed", undefined, undefined, {
      cause,
    });
  }

  const responseBody = await parseResponseBody(response);
  runtime.output.exchange(
    "Invite user",
    { method: "POST", url: String(url), headers, body },
    { status: response.status, body: responseBody },
  );
  if (!response.ok) {
    throw new ApiError(
      `Invite user failed with HTTP ${response.status}`,
      response.status,
      responseBody,
    );
  }
  runtime.output.result(responseBody);
}
