import { describe, expect, it } from "vitest";
import * as sdk from "./index";

describe("package root exports", () => {
  it("preserves the compatibility helper exports", () => {
    expect(typeof sdk.validateAddress).toBe("function");
    expect(typeof sdk.validateAmount).toBe("function");
    expect(typeof sdk.xlmToStroops).toBe("function");
    expect(typeof sdk.stroopsToXlm).toBe("function");
    expect(typeof sdk.truncateAddress).toBe("function");
    expect(typeof sdk.describeSignerType).toBe("function");
    expect(typeof sdk.formatSignerForDisplay).toBe("function");
    expect(typeof sdk.formatContextType).toBe("function");
    expect(typeof sdk.createCreateContractExternalRefContext).toBe("function");
    expect(typeof sdk.getCredentialIdFromSigner).toBe("function");
    expect(typeof sdk.signersEqual).toBe("function");
    expect(typeof sdk.getSignerKey).toBe("function");
    expect(typeof sdk.collectUniqueSigners).toBe("function");
  });

  it("exports the authorization digest scheme surface", () => {
    expect(sdk.AUTH_DIGEST_SCHEMES).toEqual(["legacy-concat", "preimage-v1"]);
    expect(
      sdk.KNOWN_AUTH_DIGEST_SCHEMES[
        "1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a"
      ]
    ).toBe("legacy-concat");
    expect(new sdk.AuthDigestSchemeError("C1", "ab").code).toBe(
      sdk.SmartAccountErrorCode.AUTH_DIGEST_SCHEME_UNKNOWN
    );
  });
});
