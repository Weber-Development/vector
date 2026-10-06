import type { Server } from "node:http";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli";
import { signHeaders } from "../src/index";

function io(stdin = "") {
  const out: string[] = [];
  const err: string[] = [];
  let server: Server | undefined;
  return {
    out,
    err,
    get server() {
      return server;
    },
    io: {
      stdout: (t: string) => out.push(t),
      stderr: (t: string) => err.push(t),
      readStdin: async () => stdin,
      onListen: (s: Server) => {
        server = s;
      },
    },
  };
}

const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

describe("cli", () => {
  it("prints help and a new secret", async () => {
    const t = io();
    expect(await runCli(["--help"], t.io)).toBe(0);
    expect(t.out.join("")).toContain("vector secret");
    expect(await runCli(["secret"], t.io)).toBe(0);
    expect(t.out.at(-1)).toMatch(/^whsec_/);
    expect(await runCli(["nope"], t.io)).toBe(2);
  });

  it("signs and verifies a body", async () => {
    const t = io('{"a":1}');
    expect(
      await runCli(
        ["sign", "--secret", secret, "--id", "msg_1", "--timestamp", "1700000000"],
        t.io,
      ),
    ).toBe(0);
    const signature = t.out
      .find((l) => l.startsWith("webhook-signature"))
      ?.split(": ")[1]
      ?.trim();
    expect(signature).toMatch(/^v1,/);
    const v = io('{"a":1}');
    const args = ["verify", "--secret", secret, "--id", "msg_1", "--timestamp", "1700000000"];
    expect(await runCli([...args, "--signature", signature!], v.io)).toBe(0);
    expect(v.out.join("")).toContain("Signature valid");
    const bad = io('{"a":2}');
    expect(await runCli([...args, "--signature", signature!], bad.io)).toBe(1);
  });

  it("creates a key pair, signs with the secret key and verifies with the public key", async () => {
    const k = io();
    expect(await runCli(["keypair"], k.io)).toBe(0);
    const text = k.out.join("");
    const secretKey = text.match(/whsk_\S+/)?.[0] as string;
    const publicKey = text.match(/whpk_\S+/)?.[0] as string;
    expect(secretKey).toBeTruthy();
    expect(publicKey).toBeTruthy();

    const s = io('{"a":1}');
    const signArgs = ["sign", "--secret", secretKey, "--id", "msg_1", "--timestamp", "1700000000"];
    expect(await runCli(signArgs, s.io)).toBe(0);
    const signature = s.out
      .find((l) => l.startsWith("webhook-signature"))
      ?.split(": ")[1]
      ?.trim() as string;
    expect(signature).toMatch(/^v1a,/);
    const args = ["verify", "--secret", publicKey, "--id", "msg_1", "--timestamp", "1700000000"];
    const v = io('{"a":1}');
    expect(await runCli([...args, "--signature", signature], v.io)).toBe(0);
    const bad = io('{"a":2}');
    expect(await runCli([...args, "--signature", signature], bad.io)).toBe(1);
  });

  it("listens locally and verifies incoming webhooks", async () => {
    const t = io();
    const running = runCli(["listen", "--port", "0", "--secret", secret], t.io);
    await new Promise((r) => setTimeout(r, 50));
    const server = t.server!;
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const body = '{"type":"a.b","data":{}}';
    const headers = await signHeaders({
      id: "msg_x",
      timestamp: new Date(),
      payload: body,
      secret,
    });
    const ok = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body, headers });
    expect(ok.status).toBe(204);
    const bad = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: "{}", headers });
    expect(bad.status).toBe(401);
    server.close();
    expect(await running).toBe(0);
    expect(t.out.join("")).toContain("verified");
    expect(t.out.join("")).toContain("rejected: no_matching_signature");
  });

  it("refuses to send to private addresses unless allowed", async () => {
    const t = io();
    expect(await runCli(["send", "http://127.0.0.1:9/", "--secret", secret], t.io)).toBe(1);
    expect(t.err.join("")).toContain("not allowed");
  });
});
