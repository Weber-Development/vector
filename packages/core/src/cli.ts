import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { parseArgs } from "node:util";
import { createId } from "./encoding";
import { generateSecret, signHeaders, verify, WebhookVerificationError } from "./signature";
import { assertDeliverableUrl } from "./url-guard";

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readStdin: () => Promise<string>;
  fetch?: typeof fetch;
  /** Called with the server of `vector listen`, for tests. */
  onListen?: (server: Server) => void;
}

const HELP = `vector – self-hosted webhooks

Usage:
  vector secret                       Print a new signing secret (whsec_...)
  vector sign --secret <s> [--id <id>] [--timestamp <unix>] [--file <path>]
                                      Print the webhook-* headers for a body (stdin or --file)
  vector verify --secret <s> --id <id> --timestamp <unix> --signature <sig> [--file <path>]
                                      Check a signature (body from stdin or --file)
  vector send <url> --secret <s> [--type <event>] [--data <json>] [--allow-private]
                                      Send one signed test event to a URL
  vector listen [--port 4000] [--secret <s>]
                                      Receive webhooks locally and print them, verified if a secret is given

Options:
  -h, --help                          Show this help
`;

async function body(values: { file?: string | undefined }, io: CliIO): Promise<string> {
  return values.file ? readFile(values.file, "utf8") : io.readStdin();
}

/** Runs the CLI and returns the exit code. */
export async function runCli(argv: string[], io: CliIO): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help" || command === "help") {
    io.stdout(HELP);
    return command ? 0 : 1;
  }
  try {
    switch (command) {
      case "secret": {
        io.stdout(`${generateSecret()}\n`);
        return 0;
      }
      case "sign": {
        const { values } = parseArgs({
          args: rest,
          options: {
            secret: { type: "string" },
            id: { type: "string" },
            timestamp: { type: "string" },
            file: { type: "string" },
          },
        });
        if (!values.secret) throw new UsageError("--secret is required");
        const headers = await signHeaders({
          id: values.id ?? createId("msg"),
          timestamp: values.timestamp ? Number(values.timestamp) : new Date(),
          payload: await body(values, io),
          secret: values.secret,
        });
        for (const [name, value] of Object.entries(headers)) io.stdout(`${name}: ${value}\n`);
        return 0;
      }
      case "verify": {
        const { values } = parseArgs({
          args: rest,
          options: {
            secret: { type: "string" },
            id: { type: "string" },
            timestamp: { type: "string" },
            signature: { type: "string" },
            file: { type: "string" },
            tolerance: { type: "string" },
          },
        });
        if (!values.secret || !values.id || !values.timestamp || !values.signature) {
          throw new UsageError("--secret, --id, --timestamp and --signature are required");
        }
        await verify(
          await body(values, io),
          {
            "webhook-id": values.id,
            "webhook-timestamp": values.timestamp,
            "webhook-signature": values.signature,
          },
          values.secret,
          {
            toleranceSeconds: values.tolerance ? Number(values.tolerance) : Number.MAX_SAFE_INTEGER,
          },
        );
        io.stdout("Signature valid.\n");
        return 0;
      }
      case "send": {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            secret: { type: "string" },
            type: { type: "string", default: "webhook.test" },
            data: { type: "string" },
            "allow-private": { type: "boolean", default: false },
          },
        });
        const url = positionals[0];
        if (!url) throw new UsageError("a URL is required");
        if (!values.secret) throw new UsageError("--secret is required");
        await assertDeliverableUrl(url, { allowPrivateNetworks: values["allow-private"] });
        const data = values.data ? JSON.parse(values.data) : { message: "Test event from vector" };
        const payload = JSON.stringify({
          type: values.type,
          timestamp: new Date().toISOString(),
          data,
        });
        const id = createId("msg");
        const headers = await signHeaders({
          id,
          timestamp: new Date(),
          payload,
          secret: values.secret,
        });
        const response = await (io.fetch ?? fetch)(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: payload,
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
        });
        io.stdout(`${id} -> ${response.status} ${response.statusText}\n`);
        return response.ok ? 0 : 1;
      }
      case "listen": {
        const { values } = parseArgs({
          args: rest,
          options: {
            port: { type: "string", default: "4000" },
            secret: { type: "string" },
          },
        });
        const server = createServer((req, res) => {
          const chunks: Buffer[] = [];
          req.on("data", (chunk: Buffer) => chunks.push(chunk));
          req.on("end", async () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const headers = req.headers as Record<string, string | string[] | undefined>;
            let status = 204;
            let note = "";
            if (values.secret) {
              try {
                await verify(raw, headers, values.secret);
                note = "verified";
              } catch (error) {
                status = 401;
                note =
                  error instanceof WebhookVerificationError
                    ? `rejected: ${error.code}`
                    : "rejected";
              }
            }
            io.stdout(
              `${new Date().toISOString()} ${req.method} ${req.url} ${headers["webhook-id"] ?? ""} ${note}\n${raw}\n\n`,
            );
            res.writeHead(status).end();
          });
        });
        const port = Number(values.port);
        await new Promise<void>((resolve) => server.listen(port, resolve));
        const address = server.address();
        const actual = typeof address === "object" && address ? address.port : port;
        io.stdout(
          `Listening on http://localhost:${actual}${values.secret ? " (verifying)" : ""}\n`,
        );
        io.onListen?.(server);
        await new Promise<void>((resolve) => server.on("close", resolve));
        return 0;
      }
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`vector: ${error.message}\n\n${HELP}`);
      return 2;
    }
    io.stderr(`vector: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

class UsageError extends Error {}
