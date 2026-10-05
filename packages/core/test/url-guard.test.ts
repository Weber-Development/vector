import { describe, expect, it } from "vitest";
import { assertDeliverableUrl, isPrivateAddress, UrlNotAllowedError } from "../src/index";

const publicDns = async () => ["93.184.215.14"];

describe("url guard", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::a00:1",
    "not-an-ip",
  ])("treats %s as private", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "93.184.215.14", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
    "treats %s as public",
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );

  it("allows public https URLs", async () => {
    await expect(
      assertDeliverableUrl("https://hooks.example.com/in", { resolveHost: publicDns }),
    ).resolves.toBeInstanceOf(URL);
  });

  it.each([
    ["http://example.com/", "only https"],
    ["ftp://example.com/", "only https"],
    ["https://user:pw@example.com/", "credentials"],
    ["https://localhost/", "local host name"],
    ["https://api.localhost/", "local host name"],
    ["https://127.0.0.1/", "private"],
    ["https://2130706433/", "private"],
    ["https://0x7f.1/", "private"],
    ["https://[::1]/", "private"],
    ["https://169.254.169.254/latest/meta-data", "private"],
    ["not a url", "not a valid URL"],
  ])("refuses %s", async (url, reason) => {
    const error = await assertDeliverableUrl(url, { resolveHost: publicDns }).catch((e) => e);
    expect(error).toBeInstanceOf(UrlNotAllowedError);
    expect(error.message).toContain(reason);
  });

  it("refuses host names that resolve to private addresses", async () => {
    await expect(
      assertDeliverableUrl("https://evil.example.com/", {
        resolveHost: async () => ["93.184.215.14", "10.0.0.5"],
      }),
    ).rejects.toThrow("10.0.0.5");
    await expect(
      assertDeliverableUrl("https://nx.example.com/", {
        resolveHost: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
    ).rejects.toThrow("could not be resolved");
  });

  it("uses node:dns by default", async () => {
    await expect(assertDeliverableUrl("https://localhost.test.invalid./")).rejects.toThrow(
      UrlNotAllowedError,
    );
  });

  it("allows private networks and http when told to", async () => {
    await expect(
      assertDeliverableUrl("http://localhost:3000/hook", { allowPrivateNetworks: true }),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      assertDeliverableUrl("http://hooks.example.com/", {
        allowHttp: true,
        resolveHost: publicDns,
      }),
    ).resolves.toBeInstanceOf(URL);
  });
});
