import { faker } from "@faker-js/faker";
import { post } from "../client.ts";

export interface Entity {
  id: string;
  name: string;
}

const businessDetails = (name: string) => ({
  business_legal_name: name,
  business_dba: name,
  business_address_country: "US",
  business_street_address1: faker.location.streetAddress(),
  business_city: faker.location.city(),
  business_state: faker.location.state({ abbreviated: true }),
  business_postal_code: faker.location.zipCode(),
  business_legal_entity_identifier: faker.string.alphanumeric({ length: 20, casing: "upper" }),
});

export async function createTenant(): Promise<Entity> {
  const name = faker.company.name();
  const tenant = await post<{ data: { tenant: { id: string } } }>(
    "/v1/entities/tenants",
    businessDetails(name),
  );
  return { id: tenant.data.tenant.id, name };
}

export async function createBusinessCounterparty({ tenantId }: { tenantId?: string } = {}): Promise<Entity> {
  const name = faker.company.name();
  const counterparty = await post<{ data: { id: string } }>("/v1/entities/counterparties", {
    classification: "business",
    ...businessDetails(name),
    ...(tenantId && { tenant_id: tenantId }),
  });
  return { id: counterparty.data.id, name };
}

export async function createIndividualCounterparty({ tenantId }: { tenantId?: string } = {}): Promise<Entity> {
  const firstName = faker.person.firstName();
  const lastName = faker.person.lastName();
  const counterparty = await post<{ data: { id: string } }>("/v1/entities/counterparties", {
    classification: "individual",
    individual_first_name: firstName,
    individual_last_name: lastName,
    individual_address_country: "US",
    individual_street_address1: faker.location.streetAddress(),
    individual_city: faker.location.city(),
    individual_state: faker.location.state({ abbreviated: true }),
    individual_postal_code: faker.location.zipCode(),
    ...(tenantId && { tenant_id: tenantId }),
  });
  return { id: counterparty.data.id, name: `${firstName} ${lastName}` };
}
