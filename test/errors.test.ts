/**
 * SPEC: the error taxonomy. Distinct SdkError subclasses so callers can branch
 * on failure mode; each carries the context a caller needs to react.
 */
import { describe, it, expect } from "vitest";
import {
  SdkError,
  NotImplementedError,
  TransactionExpiredError,
  AllEndpointsFailedError,
  BundleNotLandedError,
} from "../src/errors.js";

describe("error taxonomy", () => {
  it("NotImplementedError has a default message and the right name", () => {
    const e = new NotImplementedError();
    expect(e).toBeInstanceOf(SdkError);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("NotImplementedError");
    expect(e.message).toBe("not implemented");
  });

  it("NotImplementedError accepts a custom message", () => {
    expect(new NotImplementedError("Foo.bar").message).toBe("Foo.bar");
  });

  it("TransactionExpiredError carries the signature and lastValidBlockHeight", () => {
    const e = new TransactionExpiredError("Sig1", 1234n);
    expect(e).toBeInstanceOf(SdkError);
    expect(e.signature).toBe("Sig1");
    expect(e.lastValidBlockHeight).toBe(1234n);
    expect(e.name).toBe("TransactionExpiredError");
    expect(e.message).toContain("Sig1");
    expect(e.message).toContain("1234");
  });

  it("AllEndpointsFailedError reports the attempt count and keeps the attempts", () => {
    const attempts = [
      { endpoint: "a", error: new Error("x") },
      { endpoint: "b", error: new Error("y") },
    ];
    const e = new AllEndpointsFailedError(attempts);
    expect(e.attempts).toHaveLength(2);
    expect(e.name).toBe("AllEndpointsFailedError");
    expect(e.message).toContain("2");
  });

  it("BundleNotLandedError carries the bundle id", () => {
    const e = new BundleNotLandedError("bundle_abc");
    expect(e.bundleId).toBe("bundle_abc");
    expect(e.name).toBe("BundleNotLandedError");
    expect(e.message).toContain("bundle_abc");
  });
});
