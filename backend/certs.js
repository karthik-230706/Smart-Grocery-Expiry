// Auto-generates a self-signed HTTPS certificate every time the server
// starts, covering localhost, 127.0.0.1, and every LAN IP this computer
// currently has (WiFi IPs change between networks, so a stale cached
// certificate would stop matching — regenerating fresh each run keeps it
// correct with zero manual steps). This is what lets the app be opened
// securely (https://) from a phone on the same WiFi, which mobile browsers
// require before they'll allow camera access for the Admin barcode scanner.
const fs = require("fs");
const path = require("path");
const os = require("os");
const selfsigned = require("selfsigned");

function lanIPs() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
}

function ensureCert() {
  const ips = lanIPs();
  const altNames = [
    { type: 2, value: "localhost" }, // DNS
    { type: 7, ip: "127.0.0.1" }, // IP
    ...ips.map((ip) => ({ type: 7, ip })),
  ];

  const pems = selfsigned.generate([{ name: "commonName", value: "smartshelf.local" }], {
    days: 825,
    keySize: 2048,
    extensions: [{ name: "subjectAltName", altNames }],
  });

  const dir = path.join(__dirname, "certs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "key.pem"), pems.private);
  fs.writeFileSync(path.join(dir, "cert.pem"), pems.cert);

  return { key: pems.private, cert: pems.cert, lanIPs: ips };
}

module.exports = { ensureCert, lanIPs };
