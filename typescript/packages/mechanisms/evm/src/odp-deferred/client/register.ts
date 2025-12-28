import { x402Client, PaymentPolicy, SelectPaymentRequirements } from "@x402/core/client";
import { Network } from "@x402/core/types";
import { ClientEvmSigner } from "../../signer";
import { OdpDeferredEvmScheme } from "./scheme";

export interface OdpDeferredClientConfig {
  signer: ClientEvmSigner;
  paymentRequirementsSelector?: SelectPaymentRequirements;
  policies?: PaymentPolicy[];
  networks?: Network[];
}

export function registerOdpDeferredEvmScheme(
  client: x402Client,
  config: OdpDeferredClientConfig,
): x402Client {
  if (config.networks && config.networks.length > 0) {
    config.networks.forEach(network => {
      client.register(network, new OdpDeferredEvmScheme(config.signer));
    });
  } else {
    client.register("eip155:*", new OdpDeferredEvmScheme(config.signer));
  }

  if (config.policies) {
    config.policies.forEach(policy => {
      client.registerPolicy(policy);
    });
  }

  return client;
}
