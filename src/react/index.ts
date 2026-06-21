/**
 * Optional React entry point (`solana-resilience-kit/react`). Importing this
 * subpath pulls in `react`; the core package does not.
 */
export { useResilientSender } from "./use-resilient-sender.js";
export type {
  ResilientSendStatus,
  UseResilientSenderArgs,
  UseResilientSenderResult,
} from "./use-resilient-sender.js";
