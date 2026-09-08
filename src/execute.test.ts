import { describe, expect, it, vi } from "vitest";
import { SmartAccountKit } from "./kit";

describe("SmartAccountKit execute helpers", () => {
  it("delegates execute() to the connected wallet client", async () => {
    const transaction = { built: {} };
    const walletExecute = vi.fn().mockResolvedValue(transaction);
    const requireWallet = vi.fn().mockReturnValue({
      wallet: {
        execute: walletExecute,
      },
    });

    const result = await SmartAccountKit.prototype.execute.call(
      { requireWallet } as unknown as SmartAccountKit,
      "CTARGET",
      "set_config",
      [1, 2, 3]
    );

    expect(requireWallet).toHaveBeenCalledTimes(1);
    expect(walletExecute).toHaveBeenCalledWith({
      target: "CTARGET",
      target_fn: "set_config",
      target_args: [1, 2, 3],
    });
    expect(result).toBe(transaction);
  });

  it("executeAndSubmit() reuses execute() plus signAndSubmitAdmin()", async () => {
    const transaction = { built: {} };
    const execute = vi.fn().mockResolvedValue(transaction);
    const signAndSubmitAdmin = vi.fn().mockResolvedValue({
      success: true,
      hash: "abc123",
    });
    const options = {
      credentialId: "cred",
      forceMethod: "rpc" as const,
    };

    const result = await SmartAccountKit.prototype.executeAndSubmit.call(
      {
        execute,
        signAndSubmitAdmin,
      } as unknown as SmartAccountKit,
      "CTARGET",
      "set_config",
      ["owner"],
      options
    );

    expect(execute).toHaveBeenCalledWith("CTARGET", "set_config", ["owner"]);
    expect(signAndSubmitAdmin).toHaveBeenCalledWith(transaction, options);
    expect(result).toEqual({
      success: true,
      hash: "abc123",
    });
  });
});
