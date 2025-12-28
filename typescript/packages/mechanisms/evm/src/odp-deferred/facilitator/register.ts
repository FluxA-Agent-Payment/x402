import { x402Facilitator } from "@x402/core/facilitator";
import { Network } from "@x402/core/types";
import { FacilitatorEvmSigner } from "../../signer";
import { OdpDeferredEvmScheme, OdpDeferredEvmSchemeConfig } from "./scheme";

export interface OdpDeferredFacilitatorConfig extends OdpDeferredEvmSchemeConfig {
  signer: FacilitatorEvmSigner;
  networks: Network | Network[];
}

export function registerOdpDeferredEvmScheme(
  facilitator: x402Facilitator,
  config: OdpDeferredFacilitatorConfig,
): x402Facilitator {
  facilitator.register(
    config.networks,
    new OdpDeferredEvmScheme(config.signer, {
      settlementContract: config.settlementContract,
      authorizedProcessors: config.authorizedProcessors,
      store: config.store,
    }),
  );

  return facilitator;
}
