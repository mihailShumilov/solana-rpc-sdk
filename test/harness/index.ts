/**
 * Public surface of the simulation harness. Tests (and, after handoff, the
 * Claude Code implementation runs) import everything they need from here.
 */
export { MockCluster } from "./mock-cluster.js";
export type { MockClusterOptions, BlockhashRecord, Commitment } from "./mock-cluster.js";
export { MockEndpoint } from "./mock-endpoint.js";
export type { MockEndpointOptions } from "./mock-endpoint.js";
export { MockJitoEngine, bundleId } from "./mock-jito.js";
export type { MockJitoOptions, BundleState } from "./mock-jito.js";
export { MockSubscriptions } from "./mock-subscriptions.js";
export type { SignatureNotification } from "./mock-subscriptions.js";
export {
  type EndpointFaultProfile,
  HttpTransportError,
  TransportDroppedError,
} from "./faults.js";
export { makeRng, chance, randInt, type Rng } from "./rng.js";
export { base58Encode, firstSignatureFromWireBase64 } from "./base58.js";
