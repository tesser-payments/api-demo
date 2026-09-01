import type { Environment } from "./config.ts";
import { getTesserConfiguration } from "./config.ts";
import type { Interaction } from "./interaction.ts";
import type { Output } from "./output.ts";
import { TesserClient } from "./http.ts";

export type Runtime = {
  environment: Environment;
  interaction: Interaction;
  output: Output;
  client: TesserClient;
};

export function createRuntime(
  environment: Environment,
  interaction: Interaction,
  output: Output,
): Runtime {
  return {
    environment,
    interaction,
    output,
    client: new TesserClient(getTesserConfiguration(environment), output),
  };
}
