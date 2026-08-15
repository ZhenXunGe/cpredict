import net from "node:net";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  process.stderr.write("port must be an integer within [1, 65535]\n");
  process.exit(64);
}

const host = "127.0.0.1";
const socket = net.createConnection({ host, port });
let settled = false;

socket.setTimeout(500);
socket.once("connect", () =>
  finish(73, `refusing occupied loopback port ${host}:${port}`),
);
socket.once("timeout", () =>
  finish(75, `could not prove loopback port ${host}:${port} is free`),
);
socket.once("error", (error) => {
  if (error.code === "ECONNREFUSED") finish(0);
  else
    finish(
      75,
      `could not inspect loopback port ${host}:${port}: ${error.code ?? error.message}`,
    );
});

function finish(code, message) {
  if (settled) return;
  settled = true;
  socket.destroy();
  if (message !== undefined) process.stderr.write(`${message}\n`);
  process.exitCode = code;
}
