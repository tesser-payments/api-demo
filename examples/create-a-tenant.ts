import pc from "picocolors";
import { faker } from "@faker-js/faker";
import { authenticate, post } from "../src/client.ts";

export const meta = {
  name: "Create a tenant",
  description:
    "Provisions a fresh business tenant with faker-generated US-based legal entity details. " +
    "Returned `tenantId` can be passed to other flow examples to scope their resources.",
  docUrl: "https://docs.tesser.xyz/how-tos/create-a-tenant",
} as const;

export interface CreateTenantInput {
  /** Override the generated business name. Defaults to a faker company. */
  businessName?: string;
}

export interface CreateTenantResult {
  tenantId: string;
  businessName: string;
  tenant: TenantResponse;
}

export interface TenantResponse {
  id: string;
  business_legal_name?: string;
  business_dba?: string;
}

export async function run(input: CreateTenantInput = {}): Promise<CreateTenantResult> {
  const businessName = input.businessName ?? faker.company.name();
  const created = await post<{ data: { tenant: TenantResponse } }>(
    "/v1/entities/tenants",
    {
      business_legal_name: businessName,
      business_dba: businessName,
      business_address_country: "US",
      business_street_address1: faker.location.streetAddress(),
      business_city: faker.location.city(),
      business_state: faker.location.state({ abbreviated: true }),
      business_postal_code: faker.location.zipCode(),
      business_legal_entity_identifier: faker.string.alphanumeric({
        length: 20,
        casing: "upper",
      }),
    },
  );
  const tenant = created.data.tenant;
  console.log(`  Tenant: ${businessName} ${pc.dim(`(${tenant.id})`)}`);
  return { tenantId: tenant.id, businessName, tenant };
}

if (import.meta.main) {
  await authenticate();
  const result = await run({});
  console.log(pc.green(`\nTenant ${result.tenantId} created.`));
}
