// Networks `POST /v1/payments/simulate-inbound` sends on.
const INBOUND_NETWORKS = ["POLYGON_AMOY", "BASE_SEPOLIA", "ETHEREUM_SEPOLIA", "TEMPO_MODERATO"] as const;

export type InboundNetwork = (typeof INBOUND_NETWORKS)[number];

/**
 * The network to simulate inbounds on, from `INBOUND_NETWORK` (default
 * `POLYGON_AMOY`, which finalizes within seconds). Throws before any API call
 * on an unsupported value.
 */
export function inboundNetwork(): InboundNetwork {
  const network = (process.env.INBOUND_NETWORK || "POLYGON_AMOY").toUpperCase();
  if (!INBOUND_NETWORKS.includes(network as InboundNetwork)) {
    throw new Error(`INBOUND_NETWORK=${network} isn't supported; use one of ${INBOUND_NETWORKS.join(", ")}`);
  }
  return network as InboundNetwork;
}
